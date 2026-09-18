import { z } from 'zod';
import { transition } from '../domain/engine.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { stateSchema, type AppState, type Command } from '../types.ts';
import { nativePlatform, snapshotSchema } from '../platform/native.ts';
import { PersistenceQueue, type PersistenceStatus } from './persistence.ts';

export const desktopEnvelopeSchema = z.object({
  version: z.literal(1), state: stateSchema, scroll: z.record(z.string(), z.number().nonnegative()),
}).strict();
export type DesktopEnvelope = z.infer<typeof desktopEnvelopeSchema>;
export type Platform = typeof nativePlatform;
export type DesktopStatus = {
  workspace: DesktopEnvelope | null; loading: boolean; loadError: string; operationError: string;
  persistence: PersistenceStatus; feedback: string;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed without a recognized response.';

export class DesktopWorkspace {
  private listeners = new Set<() => void>();
  private queue?: PersistenceQueue<DesktopEnvelope>;
  private revision?: string;
  private loadPromise?: Promise<void>;
  private status: DesktopStatus = {
    workspace: null, loading: true, loadError: '', operationError: '', feedback: '',
    persistence: { saving: false, pending: false, error: '' },
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
      if (original && (!original.success || original.data.tasks.length !== state.tasks.length)) {
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
  async recoverBackup(id: string): Promise<void> {
    if (this.status.persistence.saving) throw new Error('Wait for the current save before recovering a backup.');
    const backup = await this.platform.readBackup(id);
    if (backup.snapshot) {
      const envelope = desktopEnvelopeSchema.extend({ state: z.unknown() }).parse(backup.snapshot.workspace);
      restoreDesktop(envelope.state, (await this.platform.clockNow()).now);
    }
    const status = await this.platform.storageStatus();
    await this.platform.recoverBackup(id, status.recoveryToken);
    this.queue = undefined;
    this.revision = undefined;
    this.publish({ workspace: null, persistence: { pending: false, saving: false, error: '' } });
    this.loadPromise = undefined;
    await this.load();
  }
}
