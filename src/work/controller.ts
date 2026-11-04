import type { z } from 'zod';
import {
  defaultWorkState, isDirectStream, workRankOutputSchema, workSettingsSchema, workStateSchema,
  type workConnectionsSchema, type WorkCollection, type WorkMetadata, type WorkRankInput, type WorkSettings,
} from '../../service/src/work-schema.ts';
import { ServiceCallError, ServiceClient } from '../platform/service.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState } from '../types.ts';
import { canonicalSource, completeWorkTask, rankInput, reconcileWork, restoreWorkTask } from './engine.ts';
import { orderingRankTask, semanticRankTask } from '../../service/src/work-rank-input.ts';
import { createWorkProfile, renameWorkProfile, switchWorkProfile } from './profiles.ts';
import { importWorkProfile, type ProfileFile } from './profile-files.ts';
import { ASSESSMENT_VERSION, identityDigest, workAssessOutputSchema, type SavedAssessment } from '../../service/src/work-assessment.ts';
import { agentIdentity, taskAgent } from '../../service/src/work-agents.ts';
import { assessmentIdentity, workStyleIdsSchema } from '../../service/src/work-styles.ts';
import { CodeSessions } from './code-sessions.ts';
import { githubReference } from '../../service/src/references.ts';
import type { CopilotProjectItem } from '../../service/src/copilot-projects.ts';

export type WorkConnections = z.infer<typeof workConnectionsSchema>;
export type CollectionProgress = {
  id: string; name: string; state: 'waiting' | 'collecting' | 'done' | 'failed' | 'not-run'; diagnostics: string[];
};
export type RunKind = 'pipeline' | 'collect' | 'assess' | 'prioritize';
export type RunProgress = {
  startedAt: number; finishedAt: number | null; sources: CollectionProgress[]; kind?: RunKind;
  assessment?: { total: number; saved: number; batches: number };
};
export type WorkQueueSnapshot = {
  running: boolean; cancelRequested: boolean;
  phase: 'idle' | 'preparing' | 'intake' | 'collecting' | 'refreshing-state' | 'checking-assessments' | 'assessing' | 'cancelling' | 'cancelled' | 'ranking' | 'saving' | 'error';
  progress: RunProgress | null; error: string; warnings: string[]; connections?: WorkConnections;
  unsubscribing: string[];
  activeActions?: number;
  copilotProjects?: CopilotProjectItem[];
};

class AssessmentCancelled extends Error {}

const message = (error: unknown) => error instanceof Error ? error.message : 'The work run failed without usable results.';
function exactIds(expected: string[], actual: string[]): boolean {
  const ids = new Set(actual);
  return ids.size === actual.length && expected.length === actual.length && expected.every(id => ids.has(id));
}
function sourceSettings(settings: WorkSettings): string {
  return JSON.stringify({ streams: settings.streams, model: settings.model });
}

export class WorkQueue {
  readonly code: CodeSessions;
  private listeners = new Set<() => void>();
  private active?: Promise<void>;
  private assessmentRequestId?: string;
  private cancellation?: Promise<void>;
  private cancellationError?: unknown;
  private targetCancelled = false;
  private activeActions = 0;
  private status: WorkQueueSnapshot;

  constructor(private readonly controller: DesktopWorkspace, private readonly service = new ServiceClient()) {
    this.status = {
      running: false, cancelRequested: false, phase: 'idle', error: controller.getSnapshot().workspace?.state.work?.lastError ?? '', warnings: [],
      unsubscribing: [], progress: null,
    };
    this.code = new CodeSessions(controller, service, () => this.status.running);
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  private publish(patch: Partial<WorkQueueSnapshot>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  private sourceProgress(id: string, patch: Partial<CollectionProgress>): void {
    const progress = this.status.progress;
    if (progress) this.publish({ progress: {
      ...progress, sources: progress.sources.map(source => source.id === id ? { ...source, ...patch } : source),
    } });
  }
  private assessmentProgress(assessment: NonNullable<RunProgress['assessment']>): void {
    const progress = this.status.progress;
    if (progress) this.publish({ progress: { ...progress, assessment } });
  }
  private assertAssessmentNotCancelled(): void {
    if (this.status.cancelRequested) throw new AssessmentCancelled();
  }
  private update(transform: (state: AppState) => AppState): void {
    this.controller.update(current => transform({ ...current, work: current.work ?? defaultWorkState() }));
  }

  saveSettings(settings: WorkSettings, profileName = this.controller.state.activeWorkProfile.name): void {
    const saved = workSettingsSchema.parse(settings);
    this.update(current => {
      const retained = current.work.styleFilter?.filter(id => saved.workStyles?.some(style => style.id === id));
      return {
        ...renameWorkProfile(current, profileName), work: {
          ...current.work, settings: saved,
          styleFilter: retained?.length ? retained : null,
          ...(sourceSettings(current.work.settings) !== sourceSettings(saved) ? { collectionCursor: null, directCollectionCursor: null } : {}),
        },
      };
    });
  }
  saveSourceFilter(filter: NonNullable<AppState['work']['sourceFilter']>): void {
    const sourceFilter = workStateSchema.shape.sourceFilter.parse(filter);
    this.update(current => ({ ...current, work: { ...current.work, sourceFilter } }));
  }
  saveStyleFilter(filter: AppState['work']['styleFilter']): void {
    const styleFilter = workStateSchema.shape.styleFilter.parse(filter);
    this.update(current => ({ ...current, work: { ...current.work, styleFilter } }));
  }
  setWorkStyles(id: string, styles: string[] | null): void {
    const override = styles === null ? undefined : workStyleIdsSchema.parse(styles);
    this.update(current => {
      if (!current.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
      if (override?.some(id => !current.work.settings.workStyles?.some(style => style.id === id))) {
        throw new Error('This work style no longer exists. Choose a saved style.');
      }
      return { ...current, tasks: current.tasks.map(task => task.id === id ? { ...task, workStyleOverride: override } : task) };
    });
  }
  private assertProfileIdle(): void {
    if (this.status.running || this.status.unsubscribing.length || this.activeActions > 0) {
      throw new Error('Wait for the current run or unsubscribe to finish before changing work profiles.');
    }
  }
  private async withAction<T>(fn: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.status.running) throw new Error('Wait for the current run to finish before running a quick action.');
    const { id: profileId } = this.controller.state.activeWorkProfile, generation = this.controller.assessmentGeneration;
    this.publish({ activeActions: ++this.activeActions });
    try { return await fn(() => { this.assertWorkspace(generation); this.assertProfile(this.controller.state, profileId); }); }
    finally { this.publish({ activeActions: (this.activeActions = Math.max(0, this.activeActions - 1)) }); }
  }
  switchProfile(id: string): void {
    this.assertProfileIdle();
    this.update(current => switchWorkProfile(current, id));
    this.publish({ error: '', warnings: [], phase: 'idle', progress: null });
  }
  createProfile(name: string, copySettings = false): void {
    this.assertProfileIdle();
    this.update(current => createWorkProfile(current, name, copySettings));
    this.publish({ error: '', warnings: [], phase: 'idle', progress: null });
  }
  importProfile(file: ProfileFile, name: string): void {
    this.assertProfileIdle();
    this.update(current => importWorkProfile(current, file, name));
    this.publish({ error: '', warnings: [], phase: 'idle', progress: null });
  }
  capture(title: string, notes = ''): void {
    this.validateText(title, notes);
    this.update(current => ({
      ...current,
      tasks: [...current.tasks, { id: crypto.randomUUID(), title: title.trim(), notes, status: 'open', createdAt: current.clock }],
    }));
  }
  complete(id: string): void {
    this.update(current => completeWorkTask(current, id, current.clock));
  }
  restore(id: string): void {
    this.update(current => restoreWorkTask(current, id));
  }
  async unsubscribe(id: string): Promise<void> {
    const task = this.controller.state.tasks.find(task => task.id === id);
    if (!task?.work?.notification) throw new Error('Collect this task from notifications before unsubscribing.');
    const source = canonicalSource(task.work.url);
    if (this.status.unsubscribing.includes(source)) throw new Error('Unsubscribe is already in progress for this conversation.');
    if (task.work.unsubscribe?.status === 'confirmed') return;
    const previous = task.work.unsubscribe;
    const intent: NonNullable<WorkMetadata['unsubscribe']> = {
      operationId: previous?.operationId ?? crypto.randomUUID(),
      notification: previous?.notification ?? task.work.notification, status: 'pending', error: '',
    };
    const updateIntent = (next: NonNullable<WorkMetadata['unsubscribe']>) => this.update(current => ({
      ...current, tasks: current.tasks.map(task => task.work && canonicalSource(task.work.url) === source
        && (!task.work.unsubscribe || task.work.unsubscribe.operationId === intent.operationId)
        ? { ...task, work: { ...task.work, unsubscribe: next } } : task),
    }));
    this.publish({ unsubscribing: [...this.status.unsubscribing, source] });
    let dispatched = false;
    try {
      updateIntent(intent);
      await this.controller.flush();
      const input = {
        operationId: intent.operationId, threadId: intent.notification.threadId,
        reference: intent.notification.reference, notificationUpdatedAt: intent.notification.updatedAt,
        displayedEvidenceIds: [],
      };
      dispatched = true;
      const result = await this.service.call('github.unsubscribe', input);
      if (result.action !== 'unsubscribe' || result.operationId !== input.operationId
        || result.threadId !== input.threadId || result.reference.repo !== input.reference.repo
        || result.reference.kind !== input.reference.kind || result.reference.number !== input.reference.number
        || result.notificationUpdatedAt !== input.notificationUpdatedAt || result.displayedEvidenceIds.length) {
        throw new Error('GitHub returned a mismatched unsubscribe confirmation.');
      }
      updateIntent({ ...intent, status: 'confirmed', confirmedAt: result.confirmedAt });
      await this.controller.flush();
    } catch (error) {
      const detail = `${dispatched ? 'Unsubscribe is not confirmed.' : 'Unsubscribe was not sent.'} ${message(error)}`;
      updateIntent({ ...intent, status: 'unconfirmed', error: detail.slice(0, 1000) });
      try { await this.controller.flush(); }
      catch (saveError) { this.controller.report(saveError); }
      throw new Error(detail);
    } finally {
      this.publish({ unsubscribing: this.status.unsubscribing.filter(url => url !== source) });
    }
  }
  edit(id: string, title: string, notes: string): void {
    this.validateText(title, notes);
    this.update(current => {
      if (!current.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
      return { ...current, tasks: current.tasks.map(task => task.id === id ? { ...task, title: title.trim(), notes } : task) };
    });
  }
  private validateText(title: string, notes: string): void {
    if (!title.trim()) throw new Error('Write a task title first.');
    if (title.length > 2000 || notes.length > 16000) throw new Error('Use at most 2,000 characters for a title and 16,000 for task notes.');
  }

  async connections(): Promise<void> {
    try { this.publish({ connections: await this.service.call('work.connections', {}) }); }
    catch (error) { this.publish({ error: message(error) }); }
  }

  async listCopilotProjects(): Promise<CopilotProjectItem[]> {
    try {
      const result = await this.service.call('copilotProjects.list', {});
      this.publish({ copilotProjects: result.projects });
      return result.projects;
    } catch {
      return this.status.copilotProjects ?? [];
    }
  }

  async dismiss(id: string): Promise<void> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      const task = this.controller.state.tasks.find(item => item.id === id);
      if (!task) throw new Error('This task no longer exists.');
      const { notification, acknowledge: previousAck, email } = task.work ?? {};
      this.complete(id);
      await this.controller.flush();
      assertCurrent();
      if (notification && previousAck?.status !== 'confirmed') {
        const source = canonicalSource(task.work!.url);
        const intent: NonNullable<WorkMetadata['acknowledge']> = {
          operationId: previousAck?.operationId ?? crypto.randomUUID(),
          notification: previousAck?.notification ?? notification, status: 'pending', error: '',
        };
        const updateAck = (next: NonNullable<WorkMetadata['acknowledge']>) => this.update(current => ({
          ...current, tasks: current.tasks.map(item => item.work && canonicalSource(item.work.url) === source
            && (!item.work.acknowledge || item.work.acknowledge.operationId === intent.operationId)
            ? { ...item, work: { ...item.work, acknowledge: next } } : item),
        }));
        try {
          updateAck(intent);
          await this.controller.flush();
          assertCurrent();
          const result = await this.service.call('github.acknowledge', {
            operationId: intent.operationId, threadId: intent.notification.threadId,
            reference: intent.notification.reference, notificationUpdatedAt: intent.notification.updatedAt, displayedEvidenceIds: [],
          });
          assertCurrent();
          updateAck({ ...intent, status: 'confirmed', confirmedAt: result.confirmedAt });
          await this.controller.flush();
        } catch (error) {
          const detail = `Marked Done locally; GitHub notification acknowledge failed: ${message(error)}`.slice(0, 1000);
          updateAck({ ...intent, status: 'unconfirmed', error: detail });
          try { await this.controller.flush(); } catch (saveError) { this.controller.report(saveError); }
          this.publish({ warnings: [...this.status.warnings, detail] });
          throw new Error(detail);
        }
      }
      if (email) {
        try {
          await this.service.call('gmail.archive', {
            operationId: crypto.randomUUID(), threadId: email.threadId, messageId: email.messageId, markRead: true,
          });
        } catch (error) {
          const detail = `Marked Done locally; Gmail archive failed: ${message(error)}`.slice(0, 1000);
          this.publish({ warnings: [...this.status.warnings, detail] });
          throw new Error(detail);
        }
      }
    });
  }

  private readonly pendingDispatchIds = new Map<string, string>();

  async dispatchToCopilotProjects(
    id: string,
    options: { title?: string; prompt: string; projectId?: string; projectName?: string; markDone?: boolean },
  ): Promise<{ projectId: string; projectName: string; requestId: string }> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      const task = this.controller.state.tasks.find(item => item.id === id);
      if (!task) throw new Error('This task no longer exists.');
      const resolvedTitle = options.title?.trim() || task.title;
      const defaultProject = this.controller.state.work.settings.copilotProjects?.defaultProject.trim() || undefined;
      const resolvedProjectName = options.projectName || (!options.projectId ? defaultProject : undefined);
      const intentKey = JSON.stringify([
        this.controller.state.activeWorkProfile.id, id, resolvedTitle, options.prompt, options.projectId ?? '', resolvedProjectName ?? '',
      ]);
      const operationId = this.pendingDispatchIds.get(intentKey) ?? crypto.randomUUID();
      this.pendingDispatchIds.set(intentKey, operationId);
      const result = await this.service.call('copilotProjects.dispatch', {
        operationId, title: resolvedTitle, prompt: options.prompt,
        ...(task.work?.reference?.repo ? { repo: task.work.reference.repo } : {}),
        ...(task.work?.action ? { action: task.work.action } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(resolvedProjectName ? { projectName: resolvedProjectName } : {}),
      });
      assertCurrent();
      if (options.markDone ?? (this.controller.state.work.settings.copilotProjects?.autoCompleteOnDispatch ?? true)) {
        await this.dismiss(id);
      }
      this.pendingDispatchIds.delete(intentKey);
      return result;
    });
  }

  async assignToMe(id: string, markDone = true): Promise<{ assignee: string; repo: string; number: number }> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      const task = this.controller.state.tasks.find(item => item.id === id);
      if (!task?.work?.reference) throw new Error('This task does not have a GitHub issue or PR reference.');
      const result = await this.service.call('github.assign', { operationId: crypto.randomUUID(), reference: task.work.reference });
      assertCurrent();
      if (markDone) await this.dismiss(id);
      return { assignee: result.assignee, repo: result.reference.repo, number: result.reference.number };
    });
  }

  async unsubscribeAndDismiss(id: string): Promise<void> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      await this.unsubscribe(id);
      assertCurrent();
      this.complete(id);
      await this.controller.flush();
    });
  }

  async archiveEmail(id: string): Promise<void> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      const task = this.controller.state.tasks.find(item => item.id === id);
      if (!task?.work?.email) throw new Error('This task does not have Gmail message metadata.');
      await this.service.call('gmail.archive', {
        operationId: crypto.randomUUID(), threadId: task.work.email.threadId, messageId: task.work.email.messageId, markRead: true,
      });
      assertCurrent();
      this.complete(id);
      await this.controller.flush();
    });
  }

  async createGmailctlFilter(
    id: string,
    options: {
      from?: string; list?: string; subject?: string; archive?: boolean;
      markRead?: boolean; deleteIt?: boolean; note?: string; apply?: boolean;
    },
  ): Promise<{ configPath: string; ruleSnippet: string; applied: boolean }> {
    return this.withAction(async assertCurrent => {
      assertCurrent();
      const task = this.controller.state.tasks.find(item => item.id === id);
      const shouldArchive = options.archive ?? true, shouldMarkRead = options.markRead ?? true;
      const result = await this.service.call('gmailctl.addFilter', {
        operationId: crypto.randomUUID(),
        ...(options.from ? { from: options.from } : {}),
        ...(options.list ? { list: options.list } : {}),
        ...(options.subject ? { subject: options.subject } : {}),
        archive: shouldArchive, markRead: shouldMarkRead, deleteIt: options.deleteIt ?? false, apply: options.apply ?? false,
      });
      assertCurrent();
      if (task?.work?.email && (shouldArchive || shouldMarkRead)) {
        try {
          await this.service.call('gmail.archive', {
            operationId: crypto.randomUUID(), threadId: task.work.email.threadId,
            messageId: task.work.email.messageId, archive: shouldArchive, markRead: shouldMarkRead,
          });
        } catch (error) {
          this.publish({ warnings: [...this.status.warnings, `Filter created; Gmail archive failed: ${message(error)}`] });
        }
      }
      assertCurrent();
      if (this.controller.state.tasks.some(item => item.id === id) && (shouldArchive || shouldMarkRead)) {
        this.complete(id);
        await this.controller.flush();
      }
      return result;
    });
  }

  run(): Promise<void> { return this.start(new Date()); }
  collectSources(): Promise<void> { return this.start(new Date(), 'collect'); }
  runAssessor(taskIds?: readonly string[]): Promise<void> { return this.start(new Date(), 'assess', taskIds); }
  runPrioritizer(): Promise<void> { return this.start(new Date(), 'prioritize'); }
  cancelAssessor(): Promise<void> {
    if (this.status.cancelRequested) return this.cancellation ?? Promise.resolve();
    if (!this.status.running || !(this.status.phase === 'assessing' || this.status.phase === 'checking-assessments'
      || this.status.phase === 'preparing' && this.status.progress?.kind === 'assess')) return Promise.resolve();
    const requestId = this.assessmentRequestId;
    this.publish({ cancelRequested: true, phase: 'cancelling' });
    this.cancellation = requestId ? this.service.call('cancel', { requestId }).then(ack => {
      if (ack.requestId !== requestId) throw new Error('Cancellation did not acknowledge the matching assessment request.');
    }).catch(error => {
      this.cancellationError = error;
      this.publish({ warnings: [...this.status.warnings, `Cancellation is not confirmed. ${message(error)} Waiting for the assessment request to stop.`] });
    }) : Promise.resolve();
    return this.cancellation;
  }
  async tick(now = new Date()): Promise<void> {
    if (this.status.running || this.code.busy) return;
    const work = this.controller.state.work ?? defaultWorkState();
    if (!work.settings.schedule.enabled) return;
    const boundary = Math.max(
      work.lastStartedAt ? Date.parse(work.lastStartedAt) : 0,
      work.lastCompletedAt ? Date.parse(work.lastCompletedAt) : 0,
    );
    if (now.getTime() - boundary < work.settings.schedule.everyMinutes * 60_000) return;
    await this.start(now);
  }

  private start(now: Date, kind: RunKind = 'pipeline', taskIds?: readonly string[]): Promise<void> {
    if (this.status.running) return this.active ?? Promise.resolve();
    if (this.activeActions > 0) return Promise.reject(new Error('Wait for the current action before starting a Copilot run.'));
    if (this.code.busy) return Promise.reject(new Error('Wait for the code job before starting another Copilot run.'));
    const selectedIds = taskIds && new Set(taskIds);
    if (selectedIds && !rankInput(this.controller.state).tasks.some(task => selectedIds.has(task.id))) {
      return Promise.reject(new Error('Select at least one eligible To do task to assess.'));
    }
    const settings = structuredClone(this.controller.state.work.settings);
    this.cancellation = undefined;
    this.cancellationError = undefined;
    this.targetCancelled = false;
    this.publish({ running: true, cancelRequested: false, phase: 'preparing', error: '', warnings: [], progress: {
      startedAt: Date.now(), finishedAt: null, kind,
      sources: settings.streams.filter(stream => stream.enabled && (kind === 'pipeline' || (kind === 'collect' && isDirectStream(stream))))
        .map(({ id, name }) => ({ id, name, state: 'waiting', diagnostics: [] })),
    } });
    const running = this.execute(now, settings, kind, selectedIds);
    this.active = running;
    return running;
  }

  private assertProfile(current: AppState, profileId: string): void {
    if (current.activeWorkProfile.id !== profileId) throw new Error('The work profile changed during the run. The previous order is retained.');
  }
  private assertWorkspace(generation: number): void {
    if (generation !== this.controller.assessmentGeneration) throw new Error('The workspace was replaced during this run. Its previous results cannot change the restored workspace.');
  }
  private async persist(batch: WorkCollection, profileId: string, generation: number, reopenDone = true): Promise<void> {
    this.assertWorkspace(generation);
    this.update(current => {
      this.assertProfile(current, profileId);
      // This run's reads are serialized and generation-fenced; a clock correction cannot make a fresh reply older.
      return reconcileWork(current, batch, new Date(), true, { reopenDone });
    });
    await this.controller.flush();
  }

  private async refreshState(profileId: string, generation: number, observed: ReadonlySet<string> = new Set(), reopenDone = true): Promise<string[]> {
    const urls = [...new Set(this.controller.state.tasks.filter(task =>
      task.status === 'open' && task.work && githubReference(task.work.url),
    ).map(task => canonicalSource(task.work!.url)))].filter(url => !observed.has(url));
    const warnings: string[] = [];
    for (let offset = 0; offset < urls.length; offset += 100) {
      this.assertWorkspace(generation);
      this.assertProfile(this.controller.state, profileId);
      this.publish({ phase: 'refreshing-state' });
      const requested = urls.slice(offset, offset + 100);
      const result = await this.service.call('work.collect', {
        // The existing observe-only path ignores the stream and model; it never executes this query.
        stream: this.controller.state.work.settings.streams[0] ?? defaultWorkState().settings.streams[0]!,
        model: '', since: null, knownUrls: requested, observeOnly: true, stateOnly: true,
      });
      if (result.candidates.length || !exactIds(requested.map(canonicalSource), result.observations.map(value => canonicalSource(value.url)))) {
        throw new Error('Source refresh did not return exactly the requested sources. The previous order is retained.');
      }
      await this.persist(result, profileId, generation, reopenDone);
      warnings.push(...result.warnings);
    }
    return warnings;
  }

  private async unassessed(input: WorkRankInput, profileId: string, generation: number) {
    const tasks: WorkRankInput['tasks'] = [];
    this.publish({ phase: 'checking-assessments' });
    for (const task of input.tasks) {
      this.assertAssessmentNotCancelled();
      this.assertWorkspace(generation);
      this.assertProfile(this.controller.state, profileId);
      const page = await this.controller.platform.assessmentRead(profileId, task.id);
      if (!page.assessments.length) {
        if (page.before !== null) throw new Error('Assessment history returned an empty continuation. No assessment request was sent; retry history.');
        tasks.push(task);
      }
    }
    return tasks;
  }

  private async intake(profileId: string, generation: number, reopenDone = true): Promise<void> {
    const seen = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const intake = await this.service.call('work.intake', {});
      const ids = [...new Set(intake.items.map(item => item.id))];
      if (intake.hasMore && (!ids.length || ids.every(id => seen.has(id)))) {
        throw new Error('Task intake did not advance. Saved tasks are retained; retry the remaining intake.');
      }
      if (intake.items.length) {
        await this.persist({
          candidates: intake.items.map(item => item.candidate), observations: [], warnings: [], collectedAt: new Date().toISOString(),
        }, profileId, generation, reopenDone);
        this.assertWorkspace(generation);
        const ack = await this.service.call('work.ackIntake', { ids });
        if (!exactIds(ids, ack.ids)) throw new Error('Task intake acknowledgement did not match the saved items.');
        for (const id of ids) seen.add(id);
      }
      if (!intake.hasMore) return;
    }
    throw new Error('More task intake remains. Saved tasks are retained; run again to continue.');
  }

  private async assess(input: WorkRankInput & { profileId: string }, assessmentGeneration: number, force = false, selected = false) {
    this.assertAssessmentNotCancelled();
    this.assertWorkspace(assessmentGeneration);
    this.assertProfile(this.controller.state, input.profileId);
    let progress = { total: input.tasks.length, saved: 0, batches: 0 };
    this.assessmentProgress(progress);
    const agent = taskAgent(input, 'task-assessment');
    const fingerprints = new Map(await Promise.all(input.tasks.map(async task =>
      [task.id, await identityDigest(semanticRankTask(task))] as const)));
    const instructionsFingerprint = await identityDigest(agent.instructions);
    const configurationFingerprint = await identityDigest(assessmentIdentity(input));
    const assessments = new Map<string, SavedAssessment>();
    let pending = input.tasks;
    while (pending.length) {
      this.assertAssessmentNotCancelled();
      this.publish({ phase: 'assessing' });
      this.assertWorkspace(assessmentGeneration);
      this.assertProfile(this.controller.state, input.profileId);
      if (selected) {
        if (JSON.stringify(assessmentIdentity(this.controller.state.work.settings))
          !== JSON.stringify(assessmentIdentity(input))) {
          throw new Error('Remaining selected assessments stopped after the assessor settings or work styles changed. Saved results are retained.');
        }
        const current = new Map(rankInput(this.controller.state).tasks.map(task => [task.id, JSON.stringify(semanticRankTask(task))]));
        pending = pending.filter(task => current.get(task.id) === JSON.stringify(semanticRankTask(task)));
        if (!pending.length) break;
      }
      this.assertAssessmentNotCancelled();
      const requestId = crypto.randomUUID();
      this.assessmentRequestId = requestId;
      let batch: z.infer<typeof workAssessOutputSchema>;
      try {
        batch = workAssessOutputSchema.parse(await this.service.call('work.assess', { ...input, tasks: pending, force }, requestId));
      } catch (error) {
        if (this.status.cancelRequested && error instanceof ServiceCallError
          && ['cancelled', 'service-interrupted'].includes(error.code)) {
          this.targetCancelled = error.code === 'cancelled';
          throw new AssessmentCancelled();
        }
        throw error;
      } finally {
        this.assessmentRequestId = undefined;
      }
      this.assertAssessmentNotCancelled();
      const pendingIds = new Set(pending.map(task => task.id));
      if (new Set(batch.assessments.map(value => value.id)).size !== batch.assessments.length
        || new Set(batch.assessments.map(value => value.resultId)).size !== batch.assessments.length
        || batch.assessments.some(value => !pendingIds.has(value.id) || value.profileId !== input.profileId
          || value.fingerprint !== fingerprints.get(value.id) || value.instructionsFingerprint !== instructionsFingerprint
          || value.model !== agent.model || value.assessmentVersion !== ASSESSMENT_VERSION
          || value.agent.id !== agent.id || value.agent.configurationFingerprint !== configurationFingerprint
          || JSON.stringify(value.workStyles) !== JSON.stringify(input.workStyles ?? []))) {
        throw new Error('Assessment results did not match the submitted tasks and settings. The previous order is retained.');
      }
      await this.controller.saveAssessments(input.profileId, batch.assessments, assessmentGeneration);
      for (const value of batch.assessments) assessments.set(value.id, value);
      progress = { ...progress, saved: assessments.size, batches: progress.batches + 1 };
      this.assessmentProgress(progress);
      pending = pending.filter(task => !assessments.has(task.id));
      this.assertAssessmentNotCancelled();
      this.assertWorkspace(assessmentGeneration);
      this.assertProfile(this.controller.state, input.profileId);
    }
    return assessments;
  }

  private async prioritize(input: WorkRankInput & { profileId: string }, assessmentGeneration: number,
    assessments?: Map<string, SavedAssessment>, force = false): Promise<string[]> {
    this.assertAssessmentNotCancelled();
    const profileId = input.profileId;
    const prioritizer = taskAgent(input, 'task-prioritization');
    const assertSettings = (current: AppState) => {
      this.assertWorkspace(assessmentGeneration);
      if (current.activeWorkProfile.id !== profileId
        || JSON.stringify(assessmentIdentity(current.work.settings)) !== JSON.stringify(assessmentIdentity(input))
        || JSON.stringify(agentIdentity(taskAgent(current.work.settings, 'task-prioritization'))) !== JSON.stringify(agentIdentity(prioritizer))) {
        throw new Error('Ranking settings changed during the run. The previous order is retained; run again with the saved settings.');
      }
    };
    assertSettings(this.controller.state);
    const latestInput = rankInput(this.controller.state);
    const submitted = new Map(latestInput.tasks.map(task => [task.id, JSON.stringify(orderingRankTask(task))]));
    const configurationFingerprint = await identityDigest(assessmentIdentity(input));
    const assessmentIds: string[] = [];
    const selected: NonNullable<WorkRankInput['assessments']> = [];
    const warnings: string[] = [];
    const compactTasks: WorkRankInput['tasks'] = [];
    for (const task of latestInput.tasks) {
      const matchesAgent = (value: SavedAssessment) => value.assessmentVersion !== 'work-assessment-v2'
        && value.agent.configurationFingerprint === configurationFingerprint;
      let value = assessments?.get(task.id);
      if (!value) {
        let latest: SavedAssessment | undefined;
        const seen = new Set<string>();
        for (let before: number | null = null; ;) {
          assertSettings(this.controller.state);
          const page = await this.controller.platform.assessmentRead(profileId, task.id, before);
          assertSettings(this.controller.state);
          let previous: number = before ?? Infinity;
          for (const entry of page.assessments) {
            if (entry.profileId !== profileId || entry.sequence >= previous || seen.has(entry.resultId)) {
              throw new Error('Assessment history returned repeated or unordered results. The previous order is retained; retry history.');
            }
            previous = entry.sequence;
            seen.add(entry.resultId);
          }
          if (page.before !== null && (!page.assessments.length || page.before !== previous)) {
            throw new Error('Assessment history did not advance. The previous order is retained; retry history.');
          }
          const results = page.assessments.map(({ sequence: _, ...result }) => result);
          latest ??= results[0];
          value = results.find(matchesAgent);
          if (value || page.before === null) {
            value ??= latest;
            break;
          }
          before = page.before;
        }
      }
      if (!value || value.profileId !== profileId) {
        throw new Error('Saved assessments are required for every eligible task. Use Run assessor for unassessed tasks. The previous order is retained.');
      }
      assessmentIds.push(value.resultId);
      selected.push({ taskId: task.id, result: value });
      if (!matchesAgent(value)) warnings.push(`"${task.title}": reusing a saved judgment from earlier assessor settings or format. Use Assess selected to update it.`);
      const { context: _, ...compact } = task;
      compactTasks.push({
        ...compact, notes: '', evidence: [],
        assessmentInputFingerprint: await identityDigest(semanticRankTask(task)),
      });
    }
    assertSettings(this.controller.state);
    const currentTasks = rankInput(this.controller.state).tasks;
    if (!exactIds(latestInput.tasks.map(task => task.id), currentTasks.map(task => task.id))
      || currentTasks.some(task => submitted.get(task.id) !== JSON.stringify(orderingRankTask(task)))) {
      throw new Error('Tasks changed while preparing prioritization. Use Run assessor for unassessed tasks or Assess selected to refresh saved assessments. The previous order is retained.');
    }
    const orderInput = {
      ...latestInput, tasks: compactTasks, profileId, assessmentIds, assessments: selected, force,
    };
    this.assertAssessmentNotCancelled();
    this.publish({ phase: 'ranking' });
    const result = orderInput.tasks.length
      ? workRankOutputSchema.parse(await this.service.call('work.rank', orderInput))
      : { orderedIds: [], reasons: [] };
    const ids = orderInput.tasks.map(task => task.id);
    if (!exactIds(ids, result.orderedIds) || !exactIds(ids, result.reasons.map(reason => reason.id))
      || result.reasons.some(reason => !reason.reason.trim())) {
      throw new Error('Ranking must contain every submitted task ID and exactly one reason per task, without duplicates or invented IDs.');
    }
    this.update(current => {
      assertSettings(current);
      const latest: WorkRankInput = rankInput(current);
      const matching = new Set(latest.tasks.filter(task =>
        ids.includes(task.id) && submitted.get(task.id) === JSON.stringify(orderingRankTask(task))).map(task => task.id));
      const unranked = latest.tasks.length - matching.size;
      if (unranked) warnings.push(`${unranked} new or edited task${unranked === 1 ? ' is' : 's are'} unranked. Run again to include ${unranked === 1 ? 'it' : 'them'}.`);
      return {
        ...current, work: {
          ...current.work, ranking: {
            orderedIds: result.orderedIds.filter(id => matching.has(id)),
            reasons: result.reasons.filter(reason => matching.has(reason.id)),
            rankedAt: result.evaluatedAt ?? new Date().toISOString(),
            ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
          },
        },
      };
    });
    this.publish({ phase: 'saving' });
    await this.controller.flush();
    return warnings;
  }

  private async execute(now: Date, settings: WorkSettings, kind: RunKind, selectedIds?: Set<string>): Promise<void> {
    const profileId = this.controller.state.activeWorkProfile.id;
    const generation = this.controller.assessmentGeneration;
    const errors: string[] = [];
    const warnings: string[] = [];
    let previousCompletedAt: string | null | undefined;
    let previousCursor: string | null = null;
    let previousDirectCursor: string | null | undefined;
    let coveredThrough = now.toISOString();
    let scannedSettings = '';
    let completionWritten = false;
    try {
      const reopenDone = kind !== 'collect';
      this.update(current => {
        previousCompletedAt = current.work.lastCompletedAt;
        return (kind === 'pipeline' || kind === 'collect') ? { ...current, work: { ...current.work, lastStartedAt: now.toISOString() } } : current;
      });
      await this.controller.flush();
      await this.controller.retryAssessments();
      if (kind === 'assess' || kind === 'prioritize') {
        const input = { ...rankInput(this.controller.state), profileId };
        if (kind === 'assess') {
          if (selectedIds) input.tasks = input.tasks.filter(task => selectedIds.has(task.id));
          else input.tasks = await this.unassessed(input, profileId, generation);
          const assessed = await this.assess(input, generation, true, !!selectedIds);
          if (selectedIds && assessed.size < selectedIds.size) {
            warnings.push(`${selectedIds.size - assessed.size} selected tasks were not assessed because they changed or are no longer eligible.`);
          }
          if (JSON.stringify(assessmentIdentity(input))
            !== JSON.stringify(assessmentIdentity(this.controller.state.work.settings))) {
            warnings.push(selectedIds
              ? 'Assessor settings or work styles changed while selected assessments were in flight. Their results are saved as history; assess again with the saved settings.'
              : 'Assessor settings changed during the run. Results are saved as history; use Assess selected to refresh them with the saved settings.');
          }
        } else {
          warnings.push(...await this.refreshState(profileId, generation));
          warnings.push(...await this.prioritize(input, generation, undefined, true));
        }
        this.assertWorkspace(generation);
        this.update(current => { this.assertProfile(current, profileId); return { ...current, work: { ...current.work, lastError: '' } }; });
        this.publish({ phase: 'saving' });
        await this.controller.flush();
        return;
      }
      const { collectionCursor, directCollectionCursor } = this.controller.state.work;
      const sinceCursor = kind === 'collect' ? (directCollectionCursor ?? collectionCursor) : collectionCursor;
      scannedSettings = sourceSettings(settings);
      const streams = settings.streams.filter(stream => stream.enabled && (kind !== 'collect' || isDirectStream(stream)));
      if (kind !== 'collect') {
        this.publish({ phase: 'intake' });
        try { await this.intake(profileId, generation, true); }
        catch (error) {
          if (this.controller.getSnapshot().persistence.error) throw error;
          errors.push(`Task intake: ${message(error)}`);
          this.publish({ error: errors.join('\n') });
        }
      }
      const observed = new Set<string>();
      for (const stream of streams) {
        this.assertWorkspace(generation);
        this.assertProfile(this.controller.state, profileId);
        this.publish({ phase: 'collecting' });
        this.sourceProgress(stream.id, { state: 'collecting' });
        const diagnostics: string[] = [];
        let failed = false;
        const knownUrls = stream.kind === 'gmail'
          ? []
          : [...new Set(this.controller.state.tasks
            .filter(task => task.status === 'open' && task.work && githubReference(task.work.url))
            .map(task => task.work!.url))].filter(url => !observed.has(canonicalSource(url)));
        for (let offset = 0; offset < Math.max(knownUrls.length, 1); offset += 100) {
          this.assertProfile(this.controller.state, profileId);
          const pendingUrls = knownUrls.slice(offset, offset + 100).filter(url => !observed.has(canonicalSource(url)));
          if (offset > 0 && !pendingUrls.length) continue;
          try {
            const result = await this.service.call('work.collect', {
              stream, model: settings.model, since: sinceCursor, knownUrls: pendingUrls,
              observeOnly: offset > 0,
              ...(kind === 'collect' ? { skipModelExtraction: true } : {}),
            });
            if (result.coveredThrough) {
              const boundary = Date.parse(result.coveredThrough);
              if (boundary > Math.min(now.getTime(), Date.parse(result.collectedAt))
                || (sinceCursor && boundary <= Date.parse(sinceCursor))) {
                throw new Error('The source returned an invalid scan boundary. Previous coverage is retained.');
              }
              if (boundary < Date.parse(coveredThrough)) coveredThrough = result.coveredThrough;
            }
            await this.persist(result, profileId, generation, reopenDone);
            for (const observation of result.observations) observed.add(canonicalSource(observation.url));
            const coverage = (result.coverageInfo ?? []).map(info => `${stream.name}: ${info}`);
            warnings.push(...coverage);
            diagnostics.push(...coverage);
            for (const warning of result.warnings) {
              warnings.push(`${stream.name}: ${warning}`);
              errors.push(`${stream.name}: ${warning}`);
              diagnostics.push(`${stream.name}: ${warning}`);
              failed = true;
            }
          } catch (error) {
            failed = true;
            diagnostics.push(`${stream.name}: ${message(error)}`);
            this.sourceProgress(stream.id, { diagnostics: [...new Set(diagnostics)] });
            if (this.controller.getSnapshot().persistence.error) throw error;
            errors.push(`${stream.name}: ${message(error)}`);
          }
          this.sourceProgress(stream.id, { diagnostics: [...new Set(diagnostics)] });
        }
        this.sourceProgress(stream.id, { state: failed ? 'failed' : 'done' });
      }
      this.publish({ warnings: [...warnings] });
      try {
        warnings.push(...await this.refreshState(profileId, generation, observed, reopenDone));
        if (kind === 'pipeline') {
          const input = { ...rankInput(this.controller.state), profileId };
          const tasks = await this.unassessed(input, profileId, generation);
          const assessments = await this.assess({ ...input, tasks }, generation);
          warnings.push(...await this.prioritize(input, generation, assessments));
        }
      }
      catch (error) {
        if (error instanceof AssessmentCancelled) throw error;
        errors.push(`Ranking: ${message(error)}`);
      }
      this.publish({ phase: 'saving', error: errors.join('\n'), warnings: [...warnings] });
      this.update(current => {
        this.assertWorkspace(generation);
        this.assertProfile(current, profileId);
        if (sourceSettings(current.work.settings) !== scannedSettings) {
          errors.push('Source settings changed during the run. Run again to collect the saved sources.');
        }
        previousCursor = current.work.collectionCursor;
        previousDirectCursor = current.work.directCollectionCursor;
        completionWritten = errors.length === 0;
        return {
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? {
              lastCompletedAt: new Date().toISOString(),
              ...(kind === 'pipeline'
                ? { collectionCursor: coveredThrough, directCollectionCursor: coveredThrough }
                : { directCollectionCursor: coveredThrough }),
            } : {}),
          },
        };
      });
      await this.controller.flush();
    } catch (error) {
      const source = this.status.progress?.sources.find(source => source.state === 'collecting');
      if (!(error instanceof AssessmentCancelled)) errors.push(source ? `${source.name}: ${message(error)}` : message(error));
      try {
        this.update(current => generation !== this.controller.assessmentGeneration ? current : current.activeWorkProfile.id !== profileId ? {
          ...current, inactiveWorkProfiles: current.inactiveWorkProfiles.map(profile => profile.id === profileId
            ? { ...profile, work: { ...profile.work, lastError: errors.join('\n').slice(0, 4000) } } : profile),
        } : ({
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? { lastCompletedAt: previousCompletedAt ?? null } : {}),
            ...(completionWritten && sourceSettings(current.work.settings) === scannedSettings
              && current.work.collectionCursor === coveredThrough ? { collectionCursor: previousCursor } : {}),
            ...(completionWritten && sourceSettings(current.work.settings) === scannedSettings
              && current.work.directCollectionCursor === coveredThrough ? { directCollectionCursor: previousDirectCursor } : {}),
          },
        }));
        await this.controller.flush();
      } catch { /* The native persistence queue retains the latest state for explicit recovery. */ }
    } finally {
      await this.cancellation;
      if (this.cancellationError && !(this.targetCancelled && this.cancellationError instanceof ServiceCallError
        && this.cancellationError.code === 'service-interrupted')) {
        warnings.push(`Cancellation is not confirmed. ${message(this.cancellationError)} No further batches were started.`);
      }
      this.active = undefined;
      const progress = this.status.progress;
      this.publish({ running: false, phase: errors.length ? 'error' : this.status.cancelRequested ? 'cancelled' : 'idle', error: errors.join('\n'), warnings,
        progress: progress && { ...progress, finishedAt: Date.now(), sources: progress.sources.map(source => ({
          ...source, state: source.state === 'collecting' ? 'failed' : source.state === 'waiting' ? 'not-run' : source.state,
        })) },
      });
    }
  }
}
