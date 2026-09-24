import { z } from 'zod';
import { transition } from '../domain/engine.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { stateSchema, type AppState, type Command } from '../types.ts';
import { nativePlatform, snapshotSchema } from '../platform/native.ts';
import { PersistenceQueue, type PersistenceStatus } from './persistence.ts';
import { savedAssessmentSchema, type SavedAssessment, type TaskAssessment } from '../../service/src/work-assessment.ts';

export const desktopEnvelopeSchema = z.object({
  version: z.literal(1), state: stateSchema, scroll: z.record(z.string(), z.number().nonnegative()),
}).strict();
export type DesktopEnvelope = z.infer<typeof desktopEnvelopeSchema>;
export type Platform = typeof nativePlatform;
export type DesktopStatus = {
  workspace: DesktopEnvelope | null; loading: boolean; loadError: string; operationError: string;
  persistence: PersistenceStatus; feedback: string;
  assessmentPending: SavedAssessment[]; assessmentError: string; assessmentSaving: boolean; assessmentRevision: number;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed without a recognized response.';
const assessmentResult = ({ sequence: _, ...value }: TaskAssessment) => savedAssessmentSchema.parse(value);

export class DesktopWorkspace {
  private listeners = new Set<() => void>();
  private queue?: PersistenceQueue<DesktopEnvelope>;
  private revision?: string;
  private loadPromise?: Promise<void>;
  private workspaceGeneration = 0;
  private pendingAssessmentGeneration = 0;
  get assessmentGeneration(): number { return this.workspaceGeneration; }
  private status: DesktopStatus = {
    workspace: null, loading: true, loadError: '', operationError: '', feedback: '',
    persistence: { saving: false, pending: false, error: '' },
    assessmentPending: [], assessmentError: '', assessmentSaving: false, assessmentRevision: 0,
  };

  constructor(readonly platform: Platform = nativePlatform) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  get state(): AppState {
    if (!this.status.workspace) throw new Error('Wait for the saved desktop workspace to load.');
    return this.status.workspace.state;
  }
  private publish(patch: Partial<DesktopStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  report(error: unknown): void { this.publish({ operationError: message(error) }); }
  feedback(text: string): void { this.publish({ feedback: text }); }
  clearFeedback = () => this.feedback('');

  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.initialize();
    return this.loadPromise;
  }
  async reload(): Promise<void> {
    if (this.status.workspace) throw new Error('Export pending work before replacing the loaded workspace.');
    this.loadPromise = undefined;
    return this.load();
  }
  private async initialize(): Promise<void> {
    this.publish({ loading: true, loadError: '' });
    try {
      const [saved, clock] = await Promise.all([this.platform.workspaceRead(), this.platform.clockNow()]);
      const envelope = saved.snapshot ? desktopEnvelopeSchema.extend({ state: z.unknown() }).parse(saved.snapshot.workspace) : null;
      if (!envelope && !clock.timeZone) throw new Error(clock.error?.message ?? 'The local timezone is unavailable. Retry after fixing macOS timezone settings.');
      const state = envelope ? restoreDesktop(envelope.state, clock.now) : emptyWorkspace(clock.now, clock.timeZone!);
      const original = envelope ? stateSchema.safeParse(envelope.state) : null;
      const retiredFilters = envelope && typeof envelope.state === 'object' && envelope.state !== null
        && (('rules' in envelope.state && Array.isArray(envelope.state.rules) && envelope.state.rules.length > 0)
          || ('inboxes' in envelope.state && Array.isArray(envelope.state.inboxes) && envelope.state.inboxes.length > 0));
      if (original && (!original.success || original.data.tasks.length !== state.tasks.length || retiredFilters)) {
        await this.platform.createBackup(saved.revision);
      }
      const workspace: DesktopEnvelope = { version: 1, state, scroll: envelope?.scroll ?? {} };
      this.revision = saved.revision;
      this.queue = new PersistenceQueue(saved.revision, async (revision, value) => {
        const snapshot = snapshotSchema.parse(JSON.parse(JSON.stringify({
          formatVersion: 1, workspace: value, reminders: [],
        })));
        const result = await this.platform.workspaceSave(revision, snapshot);
        this.revision = result.revision;
        return result;
      }, persistence => this.publish({ persistence }));
      this.publish({ workspace, loading: false, loadError: '', operationError: clock.error?.message ?? '' });
      if (!envelope || JSON.stringify(envelope.state) !== JSON.stringify(state)) this.queue.enqueue(workspace);
    } catch (error) {
      this.publish({ workspace: null, loading: false, loadError: message(error) });
    }
  }

  update(transform: (current: AppState) => AppState): void {
    const workspace = this.status.workspace;
    if (!workspace || !this.queue) throw new Error('The desktop workspace is not ready for edits.');
    const current = transition(workspace.state, { type: 'clock', now: new Date().toISOString() });
    const next = { ...workspace, state: transform(current) };
    this.publish({ workspace: next, operationError: '', feedback: '' });
    this.queue.enqueue(next);
  }
  dispatch = (command: Command, feedback = ''): boolean => {
    try {
      this.update(current => transition(current, command));
      if (feedback) this.feedback(feedback.replace(/\bsaved\b/gi, 'kept locally'));
      return true;
    } catch (error) { this.report(error); return false; }
  };
  async flush(): Promise<void> {
    if (!this.queue) throw new Error('The desktop workspace has not loaded.');
    await this.queue.flush();
  }
  async saveAssessments(profileId: string, values: SavedAssessment[], generation = this.workspaceGeneration): Promise<void> {
    if (values.some(value => value.profileId !== profileId)) throw new Error('Assessment profile does not match its result.');
    const pending = new Map(this.status.assessmentPending.map(value => [value.resultId, value]));
    if (!pending.size) this.pendingAssessmentGeneration = generation;
    for (const value of values) {
      const existing = pending.get(value.resultId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('An immutable pending assessment changed.');
      pending.set(value.resultId, value);
    }
    this.publish({ assessmentPending: [...pending.values()], assessmentRevision: this.status.assessmentRevision + 1 });
    await this.retryAssessments();
  }
  async retryAssessments(): Promise<void> {
    if (this.status.assessmentSaving) throw new Error('An assessment save is already in progress.');
    if (!this.status.assessmentPending.length) return;
    this.publish({ assessmentSaving: true, assessmentError: '' });
    try {
      if (this.pendingAssessmentGeneration !== this.workspaceGeneration) {
        throw new Error('These results belong to the workspace before recovery. Export pending assessments separately; they cannot be attached to this workspace.');
      }
      await this.flush();
      while (this.status.assessmentPending.length) {
        const profileId = this.status.assessmentPending[0]!.profileId;
        const batch = this.status.assessmentPending.filter(value => value.profileId === profileId).slice(0, 20);
        const result = await this.platform.assessmentAppend(profileId, batch);
        if (result.length !== batch.length || new Set(result.map(value => value.resultId)).size !== batch.length
          || result.some(value => !batch.some(submitted => JSON.stringify(submitted) === JSON.stringify(assessmentResult(value))))) {
          throw new Error('Saved assessment confirmation did not match the pending results.');
        }
        const saved = new Set(result.map(value => value.resultId));
        this.publish({
          assessmentPending: this.status.assessmentPending.filter(value => !saved.has(value.resultId)),
          assessmentRevision: this.status.assessmentRevision + 1,
        });
      }
    } catch (error) {
      this.publish({ assessmentError: `Assessment history is not saved. ${message(error)} Retry or export pending results; task edits can still save.` });
      throw error;
    } finally { this.publish({ assessmentSaving: false }); }
  }
  saveScroll = (view: string, offset: number): void => {
    const current = this.status.workspace;
    if (!current || !this.queue || !Number.isFinite(offset) || offset < 0 || current.scroll[view] === offset) return;
    const workspace = { ...current, scroll: { ...current.scroll, [view]: offset } };
    this.publish({ workspace });
    this.queue.enqueue(workspace);
  };
  async retryStorage(replace = false): Promise<void> {
    if (!this.queue) throw new Error('No pending workspace is loaded. Use recovery to inspect saved copies.');
    if (replace) {
      const saved = await this.platform.workspaceRead();
      await this.platform.createBackup(saved.revision);
      await this.queue.recover(saved.revision);
    } else await this.queue.retry();
    this.feedback('Your latest changes are saved on this Mac.');
  }
  pendingJson(): string {
    if (!this.status.workspace) throw new Error('No pending workspace is loaded.');
    return JSON.stringify({ formatVersion: 1, workspace: this.status.workspace, reminders: [] }, null, 2);
  }
  async savedJson(): Promise<string> {
    const saved = await this.platform.workspaceRead();
    return this.platform.exportJson(saved.revision);
  }
  async fullPendingJson(): Promise<string> {
    if (this.status.assessmentPending.length && this.pendingAssessmentGeneration !== this.workspaceGeneration) {
      throw new Error('Pending assessments belong to the workspace before recovery. Export them separately to avoid mixing workspaces.');
    }
    const pendingAtStart = this.status.assessmentPending;
    const saved: { assessments?: TaskAssessment[] } = JSON.parse(await this.savedJson());
    const values = new Map((saved.assessments ?? []).map(value => [value.resultId, value]));
    let sequence = [...values.values()].reduce((max, value) => Math.max(max, value.sequence ?? 0), 0);
    for (const value of [...pendingAtStart, ...this.status.assessmentPending]) {
      const existing = values.get(value.resultId);
      if (existing && JSON.stringify(assessmentResult(existing)) !== JSON.stringify(value)) {
        throw new Error('A pending assessment conflicts with saved history. Preserve database files before recovery.');
      }
      if (!existing) values.set(value.resultId, { ...value, sequence: ++sequence });
    }
    const result = JSON.stringify({
      ...saved, snapshot: JSON.parse(this.pendingJson()), assessments: [...values.values()],
    });
    if (new TextEncoder().encode(result).length > 64 * 1024 * 1024) throw new Error('Combined JSON export exceeds 64 MiB. Preserve database files and export pending results separately.');
    return result;
  }
  pendingAssessmentsJson(): string {
    return JSON.stringify({ assessments: this.status.assessmentPending }, null, 2);
  }
  async importJson(json: string): Promise<void> {
    if (this.status.persistence.saving || this.status.assessmentSaving) throw new Error('Wait for current saves before importing.');
    const parsed: unknown = JSON.parse(json);
    const document = z.object({ snapshot: snapshotSchema }).parse(parsed);
    const envelope = desktopEnvelopeSchema.extend({ state: z.unknown() }).parse(document.snapshot.workspace);
    restoreDesktop(envelope.state, (await this.platform.clockNow()).now);
    const saved = await this.platform.workspaceRead();
    await this.platform.importJson(saved.revision, json);
    await this.replaceLoadedWorkspace();
  }
  private async replaceLoadedWorkspace(): Promise<void> {
    this.workspaceGeneration += 1;
    this.queue = undefined;
    this.revision = undefined;
    this.publish({
      workspace: null, persistence: { pending: false, saving: false, error: '' },
      assessmentPending: [], assessmentError: '', assessmentRevision: this.status.assessmentRevision + 1,
    });
    this.loadPromise = undefined;
    await this.load();
  }
  async recoverBackup(id: string): Promise<void> {
    if (this.status.persistence.saving || this.status.assessmentSaving) throw new Error('Wait for the current save before recovering a backup.');
    const backup = await this.platform.readBackup(id);
    if (backup.snapshot) {
      const envelope = desktopEnvelopeSchema.extend({ state: z.unknown() }).parse(backup.snapshot.workspace);
      restoreDesktop(envelope.state, (await this.platform.clockNow()).now);
    }
    const status = await this.platform.storageStatus();
    await this.platform.recoverBackup(id, status.recoveryToken);
    await this.replaceLoadedWorkspace();
  }
}
