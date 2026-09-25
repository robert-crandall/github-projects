import type { z } from 'zod';
import {
  defaultWorkState, workRankOutputSchema, workSettingsSchema, workStateSchema,
  type workConnectionsSchema, type WorkCollection, type WorkMetadata, type WorkRankInput, type WorkSettings,
} from '../../service/src/work-schema.ts';
import { ServiceClient } from '../platform/service.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState } from '../types.ts';
import { canonicalSource, completeWorkTask, rankInput, reconcileWork, restoreWorkTask } from './engine.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import { createWorkProfile, renameWorkProfile, switchWorkProfile } from './profiles.ts';

export type WorkConnections = z.infer<typeof workConnectionsSchema>;
export type CollectionProgress = {
  id: string; name: string; state: 'waiting' | 'collecting' | 'done' | 'failed' | 'not-run'; diagnostics: string[];
};
export type RunProgress = { startedAt: number; finishedAt: number | null; sources: CollectionProgress[] };
export type WorkQueueSnapshot = {
  running: boolean; phase: 'idle' | 'preparing' | 'intake' | 'collecting' | 'ranking' | 'saving' | 'error';
  progress: RunProgress | null; error: string; warnings: string[]; connections?: WorkConnections;
  unsubscribing: string[];
};

const message = (error: unknown) => error instanceof Error ? error.message : 'The work run failed without usable results.';
function exactIds(expected: string[], actual: string[]): boolean {
  const ids = new Set(actual);
  return ids.size === actual.length && expected.length === actual.length && expected.every(id => ids.has(id));
}
function sourceSettings(settings: WorkSettings): string {
  return JSON.stringify({ streams: settings.streams, model: settings.model });
}

export class WorkQueue {
  private listeners = new Set<() => void>();
  private active?: Promise<void>;
  private status: WorkQueueSnapshot;

  constructor(private readonly controller: DesktopWorkspace, private readonly service = new ServiceClient()) {
    this.status = {
      running: false, phase: 'idle', error: controller.getSnapshot().workspace?.state.work?.lastError ?? '', warnings: [],
      unsubscribing: [], progress: null,
    };
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
  private update(transform: (state: AppState) => AppState): void {
    this.controller.update(current => transform({ ...current, work: current.work ?? defaultWorkState() }));
  }

  saveSettings(settings: WorkSettings, profileName = this.controller.state.activeWorkProfile.name): void {
    const saved = workSettingsSchema.parse(settings);
    this.update(current => ({
      ...renameWorkProfile(current, profileName), work: {
        ...current.work, settings: saved,
        ...(sourceSettings(current.work.settings) !== sourceSettings(saved) ? { collectionCursor: null } : {}),
      },
    }));
  }
  saveSourceFilter(filter: NonNullable<AppState['work']['sourceFilter']>): void {
    const sourceFilter = workStateSchema.shape.sourceFilter.parse(filter);
    this.update(current => ({ ...current, work: { ...current.work, sourceFilter } }));
  }
  private assertProfileIdle(): void {
    if (this.status.running || this.status.unsubscribing.length) {
      throw new Error('Wait for the current run or unsubscribe to finish before changing work profiles.');
    }
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

  run(): Promise<void> { return this.start(new Date()); }
  async tick(now = new Date()): Promise<void> {
    if (this.status.running) return;
    const work = this.controller.state.work ?? defaultWorkState();
    if (!work.settings.schedule.enabled) return;
    const boundary = Math.max(
      work.lastStartedAt ? Date.parse(work.lastStartedAt) : 0,
      work.lastCompletedAt ? Date.parse(work.lastCompletedAt) : 0,
    );
    if (now.getTime() - boundary < work.settings.schedule.everyMinutes * 60_000) return;
    await this.start(now);
  }

  private start(now: Date): Promise<void> {
    if (this.status.running) return this.active ?? Promise.resolve();
    const settings = structuredClone(this.controller.state.work.settings);
    this.publish({ running: true, phase: 'preparing', error: '', warnings: [], progress: {
      startedAt: Date.now(), finishedAt: null,
      sources: settings.streams.filter(stream => stream.enabled)
        .map(({ id, name }) => ({ id, name, state: 'waiting', diagnostics: [] })),
    } });
    const running = this.execute(now, settings);
    this.active = running;
    return running;
  }

  private async persist(batch: WorkCollection): Promise<void> {
    this.update(current => reconcileWork(current, batch, new Date()));
    await this.controller.flush();
  }

  private async intake(): Promise<void> {
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
        });
        const ack = await this.service.call('work.ackIntake', { ids });
        if (!exactIds(ids, ack.ids)) throw new Error('Task intake acknowledgement did not match the saved items.');
        for (const id of ids) seen.add(id);
      }
      if (!intake.hasMore) return;
    }
    throw new Error('More task intake remains. Saved tasks are retained; run again to continue.');
  }

  private async rank(): Promise<string[]> {
    const input = rankInput(this.controller.state);
    const submitted = new Map(input.tasks.map(task => [task.id, JSON.stringify(semanticRankTask(task))]));
    // The backend reuses durable assessments and ordering when their inputs remain valid.
    const result = input.tasks.length
      ? workRankOutputSchema.parse(await this.service.call('work.rank', input))
      : { orderedIds: [], reasons: [] };
    const ids = input.tasks.map(task => task.id);
    if (!exactIds(ids, result.orderedIds) || !exactIds(ids, result.reasons.map(reason => reason.id))
      || result.reasons.some(reason => !reason.reason.trim())) {
      throw new Error('Ranking must contain every submitted task ID and exactly one reason per task, without duplicates or invented IDs.');
    }
    const warnings: string[] = [];
    this.update(current => {
      if (current.work.settings.instructions !== input.instructions || current.work.settings.model !== input.model) {
        throw new Error('Ranking settings changed during the run. The previous order is retained; run again with the saved settings.');
      }
      const latest: WorkRankInput = rankInput(current);
      const matching = new Set(latest.tasks.filter(task =>
        submitted.get(task.id) === JSON.stringify(semanticRankTask(task))).map(task => task.id));
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

  private async execute(now: Date, settings: WorkSettings): Promise<void> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let previousCompletedAt: string | null | undefined;
    let previousCursor: string | null = null;
    let coveredThrough = now.toISOString();
    let scannedSettings = '';
    let completionWritten = false;
    try {
      this.update(current => {
        previousCompletedAt = current.work.lastCompletedAt;
        return { ...current, work: { ...current.work, lastStartedAt: now.toISOString() } };
      });
      await this.controller.flush();
      const { collectionCursor } = this.controller.state.work;
      scannedSettings = sourceSettings(settings);
      const streams = settings.streams.filter(stream => stream.enabled);
      this.publish({ phase: 'intake' });
      try { await this.intake(); }
      catch (error) {
        if (this.controller.getSnapshot().persistence.error) throw error;
        errors.push(`Task intake: ${message(error)}`);
        this.publish({ error: errors.join('\n') });
      }
      const observed = new Set<string>();
      for (const stream of streams) {
        this.publish({ phase: 'collecting' });
        this.sourceProgress(stream.id, { state: 'collecting' });
        const diagnostics: string[] = [];
        let failed = false;
        const knownUrls = [...new Set(this.controller.state.tasks
          .filter(task => task.status === 'open' && task.work && new URL(task.work.url).hostname === 'github.com')
          .map(task => task.work!.url))].filter(url => !observed.has(canonicalSource(url)));
        for (let offset = 0; offset < Math.max(knownUrls.length, 1); offset += 100) {
          const pendingUrls = knownUrls.slice(offset, offset + 100).filter(url => !observed.has(canonicalSource(url)));
          if (offset > 0 && !pendingUrls.length) continue;
          try {
            const result = await this.service.call('work.collect', {
              stream, model: settings.model, since: collectionCursor, knownUrls: pendingUrls,
              observeOnly: offset > 0,
            });
            if (result.coveredThrough) {
              const boundary = Date.parse(result.coveredThrough);
              if (boundary > Math.min(now.getTime(), Date.parse(result.collectedAt))
                || (collectionCursor && boundary <= Date.parse(collectionCursor))) {
                throw new Error('The source returned an invalid scan boundary. Previous coverage is retained.');
              }
              if (boundary < Date.parse(coveredThrough)) coveredThrough = result.coveredThrough;
            }
            await this.persist(result);
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
      this.publish({ phase: 'ranking', warnings: [...warnings] });
      try { warnings.push(...await this.rank()); }
      catch (error) { errors.push(`Ranking: ${message(error)}`); }
      this.publish({ phase: 'saving', error: errors.join('\n'), warnings: [...warnings] });
      this.update(current => {
        if (sourceSettings(current.work.settings) !== scannedSettings) {
          errors.push('Source settings changed during the run. Run again to collect the saved sources.');
        }
        previousCursor = current.work.collectionCursor;
        completionWritten = errors.length === 0;
        return {
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? { lastCompletedAt: new Date().toISOString(), collectionCursor: coveredThrough } : {}),
          },
        };
      });
      await this.controller.flush();
    } catch (error) {
      const source = this.status.progress?.sources.find(source => source.state === 'collecting');
      errors.push(source ? `${source.name}: ${message(error)}` : message(error));
      try {
        this.update(current => ({
          ...current, work: {
            ...current.work, lastError: errors.join('\n').slice(0, 4000),
            ...(completionWritten ? { lastCompletedAt: previousCompletedAt ?? null } : {}),
            ...(completionWritten && sourceSettings(current.work.settings) === scannedSettings
              && current.work.collectionCursor === coveredThrough ? { collectionCursor: previousCursor } : {}),
          },
        }));
        await this.controller.flush();
      } catch { /* The native persistence queue retains the latest state for explicit recovery. */ }
    } finally {
      this.active = undefined;
      const progress = this.status.progress;
      this.publish({ running: false, phase: errors.length ? 'error' : 'idle', error: errors.join('\n'), warnings,
        progress: progress && { ...progress, finishedAt: Date.now(), sources: progress.sources.map(source => ({
          ...source, state: source.state === 'collecting' ? 'failed' : source.state === 'waiting' ? 'not-run' : source.state,
        })) },
      });
    }
  }
}
