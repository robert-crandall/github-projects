import { expect, type Page } from '@playwright/test';
import { conversationPageSchema, referenceSchema, requestSchema, type ConversationCache, type Diagnostic, type Evidence, type Request, type Thread } from '../service/src/schema.ts';
import { GitHubService } from '../service/src/github.ts';
import { cacheKey, ConversationApi, mergeCachedPage } from './conversation-fixture.ts';
import { snapshotSchema, type NativeSnapshot, type NativeWorkspace } from '../src/platform/native.ts';
import { desktopEnvelopeSchema } from '../src/runtime/desktop-workspace.ts';
import { at, test as browserTest } from './workspace-fixtures.ts';
import type { WorkCollection } from '../service/src/work-schema.ts';
import { preferencesSchema, type Preferences } from '../src/themes/controller.ts';
import { assessmentBatch } from './assessment-fixture.ts';
import { AssessmentStoreFixture } from './assessment-store-fixture.ts';
import { workAssessOutputSchema } from '../service/src/work-assessment.ts';
import { codeResult, CodeRunStoreFixture } from './code-run-fixture.ts';

export function evidence(id = 'request-1', kind: Evidence['kind'] = 'review-request'): Evidence {
  return {
    id, kind, at, actor: 'octocat', text: id === 'request-1' ? 'Review the requested changes.' : `Source evidence: ${id}`,
    recipient: { kind: 'user', login: 'viewer', isViewer: true },
    requestState: kind === 'review-request' ? 'current' : 'not-request', textTruncated: false,
  };
}
export function thread(events = [evidence()], id = '123'): Thread {
  return {
    id, reference: { repo: 'octo/project', number: Number(id), kind: 'pr' }, title: `Requested review ${id}`,
    reason: 'review_requested', notification: 'unread', updatedAt: at, lastReadAt: null, state: 'open',
    sourceState: { state: 'open', observedAt: at, updatedAt: at, error: null },
    size: { additions: 20, deletions: 2, changedFiles: 1 }, subscription: 'subscribed', evidence: events,
    coverage: { timeline: 'complete', newestPage: 1, fetchedPages: [1], observedAt: at },
  };
}
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class ExpectedFailure extends Error {}

export class NativeMock {
  constructor(private readonly referenceWorkspace = false) {}
  appearance: Preferences | null = null;
  failAppearanceRead = false;
  failAppearanceSave = false;
  failAppearanceApply = false;
  appliedAppearance: { tone: string; background: string; mode: string }[] = [];
  workCollection: WorkCollection = {
    candidates: [{
      title: 'Review the relay rollout', action: 'review', url: 'https://github.com/octo/project/pull/123',
      evidence: [{
        id: 'github:request:123:1', source: 'github', streamId: 'github-reviews', at,
        url: 'https://github.com/octo/project/pull/123', summary: 'A direct review request.',
      }],
    }],
    observations: [{ url: 'https://github.com/octo/project/pull/123', state: 'open', observedAt: at, reason: '' }],
    warnings: [], collectedAt: at,
  };
  workCollections = new Map<string, { hold?: ReturnType<typeof gate>; result?: WorkCollection; error?: string }>();
  failRank = false;
  assessments = new AssessmentStoreFixture();
  codeRuns = new CodeRunStoreFixture();
  codeBackups = new Map<string, typeof this.codeRuns.entries>();
  holdCode?: ReturnType<typeof gate>;
  codeInspected = true;
  codeError = '';
  cancelCode = false;
  assessmentBackups = new Map<string, typeof this.assessments.entries>();
  holdRank?: ReturnType<typeof gate>;
  holdAssessment?: ReturnType<typeof gate>;
  conversationApi = new ConversationApi();
  conversations = new Map<string, ConversationCache>();
  corruptCache = false;
  fullCache = false;
  saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  calls: string[] = [];
  requests: Request[] = [];
  unexpected: string[] = [];
  writes: NativeSnapshot[] = [];
  launches: { command: string; args: Record<string, unknown> }[] = [];
  backups = new Map<string, NativeWorkspace>();
  rawExports: NativeWorkspace[] = [];
  recoveryToken = crypto.randomUUID();
  now = at;
  threads = [thread()];
  partial = false;
  notificationLimit = false;
  diagnostics?: Diagnostic[];
  corrupt = false;
  failSave = false;
  failBackup = false;
  failRefresh = false;
  failWrite = false;
  failLaunch = false;
  holdRead?: ReturnType<typeof gate>;
  holdRefresh?: ReturnType<typeof gate>;
  holdWrite?: ReturnType<typeof gate>;
  holdSave?: ReturnType<typeof gate>;
  holdConversationRead?: ReturnType<typeof gate>;
  holdConversationReset?: ReturnType<typeof gate>;
  activeSaves = 0;
  maxActiveSaves = 0;
  get state() { return desktopEnvelopeSchema.parse(this.saved.snapshot!.workspace).state; }

  private async invoke(command: string, args: Record<string, unknown>) {
    this.calls.push(command);
    if (command.startsWith('code_run_')) {
      if (command === 'code_run_start' && this.codeRuns.failStart) throw new ExpectedFailure('Start not saved.');
      if (command === 'code_run_update' && this.codeRuns.failUpdate) throw new ExpectedFailure('Result disk unavailable.');
      return this.codeRuns.handle(command, args);
    }
    if (command === 'appearance_read') {
      if (this.failAppearanceRead) throw new ExpectedFailure('Appearance settings are unreadable.');
      return structuredClone(this.appearance);
    }
    if (command === 'appearance_save') {
      if (this.failAppearanceSave) throw new ExpectedFailure('Appearance disk unavailable.');
      this.appearance = preferencesSchema.parse(args.preferences);
      return null;
    }
    if (command === 'appearance_apply') {
      if (this.failAppearanceApply) throw new ExpectedFailure('Window appearance unavailable.');
      this.appliedAppearance.push({ tone: String(args.tone), background: String(args.background), mode: String(args.mode) });
      return null;
    }
    if (command === 'conversation_reset') {
      if (this.holdConversationReset) await this.holdConversationReset.promise;
      this.conversations.clear(); this.corruptCache = false; this.fullCache = false; return null;
    }
    if (command === 'conversation_read') {
      if (this.corruptCache) throw new ExpectedFailure('Conversation cache is corrupt. Discard the cache explicitly; notes are safe.');
      const cached = structuredClone(this.conversations.get(cacheKey(referenceSchema.parse(args.reference))) ?? null);
      if (this.holdConversationRead) await this.holdConversationRead.promise;
      return cached;
    }
    if (command === 'conversation_merge') {
      if (this.corruptCache || this.fullCache) throw new ExpectedFailure('Conversation cache exceeds 4 MiB per source or 64 MiB total, or is corrupt. Discard the cache explicitly; notes are safe.');
      const page = conversationPageSchema.parse(args.page);
      const key = cacheKey(page.reference);
      const cache = mergeCachedPage(this.conversations.get(key), page);
      this.conversations.set(key, cache);
      return cache;
    }
    if (command === 'workspace_read') {
      if (this.holdRead) await this.holdRead.promise;
      if (this.corrupt) throw new ExpectedFailure('Saved workspace is damaged. Recover explicitly.');
      return structuredClone(this.saved);
    }
    if (command === 'assessment_append') {
      if (this.assessments.fail) throw new ExpectedFailure('History storage unavailable');
      return structuredClone(this.assessments.append(String(args.profileId),
        workAssessOutputSchema.parse({ assessments: args.assessments }).assessments, this.state));
    }
    if (command === 'assessment_read') return structuredClone(this.assessments.read(String(args.profileId), String(args.taskId),
      args.before as number | null, this.state));
    if (command === 'clock_now') return { now: this.now, timeZone: 'UTC', error: null };
    if (command === 'workspace_save') {
      const snapshot = snapshotSchema.parse(args.snapshot);
      this.writes.push(snapshot);
      this.activeSaves += 1;
      this.maxActiveSaves = Math.max(this.maxActiveSaves, this.activeSaves);
      try {
        if (this.holdSave) await this.holdSave.promise;
        if (this.corrupt || this.failSave) throw new ExpectedFailure('Disk unavailable. Pending edits are not saved.');
        if (args.expectedRevision !== this.saved.revision) throw new ExpectedFailure('Another writer changed this workspace revision.');
        this.saved = { revision: crypto.randomUUID(), snapshot, savedAt: this.now };
        return structuredClone(this.saved);
      } finally { this.activeSaves -= 1; }
    }
    if (command === 'workspace_create_backup') {
      expect(args.expectedRevision).toBe(this.saved.revision);
      if (this.failBackup) throw new ExpectedFailure('Original backup could not be preserved.');
      const id = crypto.randomUUID();
      this.backups.set(id, structuredClone(this.saved));
      this.assessmentBackups.set(id, structuredClone(this.assessments.entries));
      this.codeBackups.set(id, structuredClone(this.codeRuns.entries));
      return { id, createdAt: this.now };
    }
    if (command === 'workspace_list_backups') return [...this.backups.keys()].map(id => ({ id, createdAt: this.now }));
    if (command === 'workspace_read_backup') {
      expect(this.backups.has(String(args.backupId))).toBe(true);
      return structuredClone(this.backups.get(String(args.backupId)));
    }
    if (command === 'workspace_storage_status') return {
      recoveryToken: this.recoveryToken, revision: this.corrupt ? null : this.saved.revision,
      error: this.corrupt ? { code: 'corrupt', message: 'Saved workspace is damaged.', retryable: false } : null,
    };
    if (command === 'workspace_recover') {
      expect(args.expectedRecoveryToken).toBe(this.recoveryToken);
      expect(args.expectedRevision).toBe(this.corrupt ? null : this.saved.revision);
      const backup = this.backups.get(String(args.backupId));
      expect(backup).toBeDefined();
      this.saved = { ...structuredClone(backup!), revision: crypto.randomUUID() };
      this.assessments.entries = structuredClone(this.assessmentBackups.get(String(args.backupId)) ?? []);
      this.codeRuns.replace(this.codeBackups.get(String(args.backupId)) ?? []);
      this.corrupt = false;
      return structuredClone(this.saved);
    }
    if (command === 'workspace_export_raw') {
      this.rawExports.push(structuredClone(this.saved));
      return { id: crypto.randomUUID(), directory: 'isolated-test-export' };
    }
    if (command === 'workspace_export_json') {
      expect(args.expectedRevision).toBe(this.saved.revision);
      return JSON.stringify({ ...this.saved, assessments: this.assessments.entries, codeRuns: this.codeRuns.entries });
    }
    if (command === 'launch_github' || command === 'launch_copilot' || command === 'launch_web_url') {
      this.launches.push({ command, args: structuredClone(args) });
      if (this.failLaunch) throw new ExpectedFailure('The destination app is unavailable.');
      return { status: 'dispatch-requested', url: 'https://github.com/octo/project/pull/123' };
    }
    if (command !== 'service_request') throw new Error(`Unexpected native command ${command}`);
    const request = requestSchema.parse(args.request);
    this.requests.push(request);
    let result: unknown;
    switch (request.op) {
      case 'work.reviewCode':
        expect(this.codeRuns.entries.some(run => run.intent.runId === request.id && run.outcome.status === 'running')).toBe(true);
        if (this.holdCode) await this.holdCode.promise;
        if (this.codeError || this.cancelCode) return {
          v: 1, id: request.id, ok: false, error: { code: this.cancelCode ? 'cancelled' : this.codeError, message: this.cancelCode ? 'Read-only job cancelled.' : `Code job: ${this.codeError}`, retryable: true },
        };
        result = codeResult(request.input, this.codeInspected);
        break;
      case 'cancel':
        result = { requestId: request.input.requestId, cancelled: true };
        break;
      case 'work.connections':
        result = { servers: [], instructions: 'No shared Slack connection. Configure a selected read-only MCP server.' };
        break;
      case 'work.collect': {
        const source = this.workCollections.get(request.input.stream.id);
        if (source?.hold) await source.hold.promise;
        if (source?.error) throw new ExpectedFailure(source.error);
        result = structuredClone(source?.result ?? this.workCollection);
        break;
      }
      case 'work.assess':
        if (this.holdAssessment) await this.holdAssessment.promise;
        result = await assessmentBatch(request.input, this.now);
        break;
      case 'work.rank':
        if (this.holdRank) await this.holdRank.promise;
        if (this.failRank) throw new ExpectedFailure('Copilot ranking failed. Your tasks and previous order are retained.');
        result = {
          orderedIds: request.input.tasks.map(task => task.id).reverse(),
          reasons: request.input.tasks.map(task => ({ id: task.id, reason: `Priority for ${task.title}` })),
        };
        break;
      case 'work.intake':
        result = { items: [], hasMore: false };
        break;
      case 'work.ackIntake':
        result = request.input;
        break;
      case 'github.conversation':
        result = await new GitHubService(this.conversationApi).conversation(request.input, new AbortController().signal);
        break;
      case 'connection.check':
        result = { github: { available: true, viewer: 'viewer', scopes: ['repo'] }, copilot: { available: true } };
        break;
      case 'github.refresh':
        if (this.holdRefresh) await this.holdRefresh.promise;
        if (this.failRefresh) throw new ExpectedFailure('GitHub is offline; saved work is retained.');
        result = {
          batchId: crypto.randomUUID(), fetchedAt: this.now, viewer: 'viewer',
          status: this.partial ? 'partial' : 'complete', threads: this.threads,
          diagnostics: this.diagnostics ?? (this.partial ? [{ scope: 'timeline', code: 'access', threadId: '123', message: 'Some timeline evidence is unavailable.' }] : []),
          coverage: { notifications: this.partial || this.notificationLimit ? 'partial' : 'complete', pages: 1,
            received: this.threads.length, returned: this.threads.length, missingMeansDone: false },
        };
        break;
      case 'github.acknowledge':
      case 'github.unsubscribe': {
        const intent = this.state.operations.find(operation => operation.id === request.input.operationId);
        const taskIntent = this.state.tasks.find(task => task.work?.unsubscribe?.operationId === request.input.operationId)?.work?.unsubscribe;
        expect(intent?.status ?? taskIntent?.status, 'Persist the operation before dispatch').toBe('pending');
        expect(intent?.eventIds ?? []).toEqual(request.input.displayedEvidenceIds);
        if (taskIntent) {
          expect(request.op).toBe('github.unsubscribe');
          expect(taskIntent.notification.threadId).toBe(request.input.threadId);
          expect(taskIntent.notification.reference).toEqual(request.input.reference);
          expect(taskIntent.notification.updatedAt).toBe(request.input.notificationUpdatedAt);
        }
        if (this.holdWrite) await this.holdWrite.promise;
        if (this.failWrite) throw new ExpectedFailure('GitHub write unavailable; no success was confirmed.');
        result = { ...request.input, action: request.op === 'github.acknowledge' ? 'acknowledge' : 'unsubscribe',
          status: 'confirmed', confirmedAt: this.now };
        break;
      }
      default:
        throw new Error(`Unexpected service/model request ${request.op}`);
    }
    return { v: 1, id: request.id, ok: true, result };
  }

  async install(page: Page) {
    await page.clock.install({ time: new Date(this.now) });
    await page.clock.setFixedTime(new Date(this.now));
    await page.exposeFunction('nativeInvoke', async (command: string, args: Record<string, unknown>) => {
      try { return { value: await this.invoke(command, args) }; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof ExpectedFailure)) this.unexpected.push(message);
        return { failure: { code: 'io', message, retryable: true } };
      }
    });
    await page.addInitScript(({ referenceWorkspace }) => {
      if (referenceWorkspace) window.history.replaceState(null, '', '#reference');
      let sequence = 0;
      const callbacks = new Map<number, (event: unknown) => void>();
      const listeners = new Map<number, number>();
      const target = window as unknown as {
        isTauri: boolean; __TAURI_INTERNALS__: object;
        __TAURI_EVENT_PLUGIN_INTERNALS__: object;
        nativeInvoke(command: string, args: Record<string, unknown>): Promise<{ value?: unknown; failure?: unknown }>;
      };
      target.isTauri = true;
      window.addEventListener('native-work-tick', () => {
        for (const [id, callback] of listeners) callbacks.get(callback)?.({ event: 'work-tick', id, payload: null });
      });
      target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
      target.__TAURI_INTERNALS__ = {
        transformCallback(callback: (event: unknown) => void) { callbacks.set(++sequence, callback); return sequence; },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          if (command === 'plugin:event|listen') { listeners.set(++sequence, Number(args.handler)); return sequence; }
          if (command === 'plugin:event|unlisten') { listeners.delete(Number(args.eventId)); return; }
          const reply = await target.nativeInvoke(command, args);
          if (reply.failure) throw reply.failure;
          return reply.value;
        },
      };
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Desktop must never access browser localStorage'); } });
    }, { referenceWorkspace: this.referenceWorkspace });
  }
}

export const test = browserTest.extend<{ native: NativeMock; referenceWorkspace: boolean }>({
  referenceWorkspace: [false, { option: true }],
  native: async ({ page, referenceWorkspace }, use) => {
    const native = new NativeMock(referenceWorkspace);
    await native.install(page);
    await use(native);
    expect(native.unexpected, 'All native/model commands must be explicitly expected').toEqual([]);
    expect(native.calls.filter(command => command.startsWith('reminders_'))).toEqual([]);
    expect(native.maxActiveSaves).toBeLessThanOrEqual(1);
  },
});

export async function persisted(page: Page) {
  await expect(page.locator('.workspace-footer')).toContainText('Saved on this Mac');
}
export async function refresh(page: Page) {
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await persisted(page);
}
