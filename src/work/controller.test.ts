import { describe, expect, spyOn, test } from 'bun:test';
import { defaultWorkState, notificationWorkstream, workSettingsSchema, type WorkCandidate, type WorkCollection } from '../../service/src/work-schema.ts';
import { taskAgents, type TaskAgentJob } from '../../service/src/work-agents.ts';
import type { Request } from '../../service/src/schema.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { legacyFixture } from '../domain/test-fixtures.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient } from '../platform/service.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState } from '../types.ts';
import { WorkQueue } from './controller.ts';
import { rankedTasks, reconcileWork } from './engine.ts';
import { assessmentBatch } from '../../tests/assessment-fixture.ts';
import { rankInput } from './engine.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';
import { AssessmentStoreFixture } from '../../tests/assessment-store-fixture.ts';
import { workAssessOutputSchema } from '../../service/src/work-assessment.ts';

const before = '2026-09-15T10:00:00.000Z';
const previousCompleted = '2026-09-15T11:00:00.000Z';
const url = 'https://github.com/Owner/Repo/pull/42';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function candidate(id = 'github:event:1', source: WorkCandidate['evidence'][number]['source'] = 'github'): WorkCandidate {
  return {
    title: 'Review the change', url, action: 'review',
    evidence: [{ id, source, streamId: `${source}-stream`, at: before, url, summary: 'A source request.' }],
  };
}
function collection(candidates = [candidate()]): WorkCollection {
  return { candidates, observations: [{ url, state: 'open', observedAt: before, reason: 'Open source' }], warnings: [], collectedAt: before };
}
function initial(): AppState {
  return { ...emptyWorkspace(before, 'UTC'), work: { ...defaultWorkState(), settings: { ...defaultWorkState().settings, streams: [] } } };
}
function ranked(request: Extract<Request, { op: 'work.rank' }>) {
  const orderedIds = request.input.tasks.map(task => task.id).reverse();
  return { orderedIds, reasons: orderedIds.map(id => ({ id, reason: `Ranked ${id}` })) };
}
type Handler = (request: Request) => unknown | Promise<unknown>;
async function fixture(state: unknown = initial(), handler?: Handler) {
  let saved: NativeWorkspace = {
    revision: crypto.randomUUID(), savedAt: before,
    snapshot: snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state, scroll: {} }, reminders: [] }),
  };
  let failSave: (state: AppState) => boolean = () => false;
  let saveHook: ((state: AppState) => Promise<void>) | undefined;
  const log: string[] = [];
  const requests: Request[] = [];
  const history = new AssessmentStoreFixture();
  const backups = new Map<string, { saved: NativeWorkspace; entries: typeof history.entries }>();
  let recoveryToken = crypto.randomUUID();
  const platform = createNativePlatform(async (command, args) => {
    log.push(command);
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: before, timeZone: 'UTC', error: null };
    if (command === 'workspace_create_backup') {
      const id = crypto.randomUUID();
      backups.set(id, structuredClone({ saved, entries: history.entries }));
      return { id, createdAt: before };
    }
    if (command === 'assessment_append') {
      const result = history.append(String(args?.profileId),
        workAssessOutputSchema.parse({ assessments: args?.assessments }).assessments, saved.snapshot!.workspace.state as unknown as AppState);
      recoveryToken = crypto.randomUUID();
      return structuredClone(result);
    }
    if (command === 'assessment_read') return structuredClone(history.read(String(args?.profileId), String(args?.taskId),
      args?.before as number | null, saved.snapshot!.workspace.state as unknown as AppState));
    if (command === 'workspace_export_json') return JSON.stringify({ ...saved, assessments: history.entries });
    if (command === 'workspace_read_backup') return structuredClone(backups.get(String(args?.backupId))!.saved);
    if (command === 'workspace_storage_status') return { recoveryToken, revision: saved.revision, error: null };
    if (command === 'workspace_recover') {
      expect(args?.expectedRevision).toBe(saved.revision);
      expect(args?.expectedRecoveryToken).toBe(recoveryToken);
      const backup = structuredClone(backups.get(String(args?.backupId))!);
      saved = { ...backup.saved, revision: crypto.randomUUID() };
      history.entries = backup.entries;
      recoveryToken = crypto.randomUUID();
      return structuredClone(saved);
    }
    if (command === 'workspace_save') {
      const snapshot = snapshotSchema.parse(args?.snapshot);
      const next = snapshot.workspace.state as unknown as AppState;
      if (saveHook) await saveHook(next);
      if (failSave(next)) throw { code: 'storage-unavailable', retryable: true, message: 'Disk unavailable' };
      expect(args?.expectedRevision).toBe(saved.revision);
      saved = { revision: crypto.randomUUID(), savedAt: new Date().toISOString(), snapshot };
      recoveryToken = crypto.randomUUID();
      return structuredClone(saved);
    }
    throw new Error(`Unexpected native command ${command}`);
  });
  const workspace = new DesktopWorkspace(platform);
  await workspace.load();
  await workspace.flush();
  const service = new ServiceClient(async request => {
    requests.push(request);
    log.push(request.op);
    const supplied = await handler?.(request);
    let result: unknown = supplied;
    if (result === undefined) {
      switch (request.op) {
        case 'work.intake': result = { items: [], hasMore: false }; break;
        case 'work.collect': result = collection(); break;
        case 'work.assess': result = await assessmentBatch(request.input); break;
        case 'work.rank': result = ranked(request); break;
        case 'work.ackIntake': result = request.input; break;
        case 'work.connections': result = { servers: [{ name: 'slack', tools: ['search'], source: 'user' }], instructions: 'Owner configuration' }; break;
        default: throw new Error(`Unexpected service operation ${request.op}`);
      }
    }
    return { v: 1, id: request.id, ok: true, result };
  });
  const queue = new WorkQueue(workspace, service);
  return {
    queue, workspace, platform, service, requests, log, history,
    fail: (predicate: (state: AppState) => boolean) => { failSave = predicate; },
    onSave: (hook?: (state: AppState) => Promise<void>) => { saveHook = hook; },
    saved: () => saved.snapshot!.workspace.state as unknown as AppState,
  };
}

describe('durable local work', () => {
  test('assessment history persists before a failed order and retries never duplicate paid versions', async () => {
    const state = initial();
    state.tasks = [{ id: 'manual', title: 'Owner task', notes: 'Keep my notes', status: 'open', createdAt: before }];
    state.work.ranking = { orderedIds: ['manual'], reasons: [{ id: 'manual', reason: 'Prior order' }], rankedAt: before };
    let fail = true;
    const mock = await fixture(state, request => {
      if (request.op === 'work.rank') {
        expect(mock.history.values('manual')).toHaveLength(1);
        expect(request.input.assessmentIds).toEqual([mock.history.values('manual')[0]!.resultId]);
        if (fail) throw new Error('Ordering unavailable');
      }
    });
    await mock.queue.run();
    const version = mock.history.values('manual')[0]!;
    expect(version).toMatchObject({ id: 'manual', profileId: 'default', model: '', assessmentVersion: 'work-assessment-v3' });
    expect(mock.saved().work.ranking).toEqual(state.work.ranking);
    expect(mock.queue.getSnapshot().error).toContain('Ordering unavailable');
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect((await reloaded.platform.assessmentRead('default', 'manual')).assessments).toEqual([version]);
    fail = false;
    await new WorkQueue(reloaded, mock.service).run();
    expect(mock.history.values('manual')).toEqual([version]);
    expect(JSON.parse(await reloaded.fullPendingJson()).assessments).toEqual([version]);
    expect(mock.saved().tasks[0]).not.toHaveProperty('assessments');
  });

  test('each subset persists before the next assessment and survives a later batch failure', async () => {
    const state = initial();
    state.tasks = Array.from({ length: 21 }, (_, index) => ({
      id: `task-${index}`, title: `Task ${index}`, notes: '', status: 'open' as const, createdAt: before,
    }));
    let calls = 0;
    const mock = await fixture(state, request => {
      if (request.op === 'work.assess' && ++calls === 2) {
        expect(mock.history.entries).toHaveLength(20);
        throw new Error('Second batch failed');
      }
    });
    await mock.queue.run();
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
    const firstVersions = [...mock.history.entries];
    expect(firstVersions).toHaveLength(20);
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    await new WorkQueue(reloaded, mock.service).run();
    const versions = mock.history.entries;
    expect(versions).toHaveLength(21);
    for (const version of firstVersions) expect(versions).toContainEqual(version);
  });

  test('failed history append preserves pending results without blocking ordinary task saves', async () => {
    const mock = await fixture();
    mock.queue.capture('Assessment pending on disk');
    await mock.workspace.flush();
    mock.history.fail = true;
    await mock.queue.run();
    expect(mock.workspace.getSnapshot().persistence).toMatchObject({ pending: false, error: '' });
    expect(mock.workspace.getSnapshot().assessmentError).toContain('History storage unavailable');
    expect(mock.saved().tasks[0]).not.toHaveProperty('assessments');
    expect(mock.workspace.getSnapshot().assessmentPending).toHaveLength(1);
    const pendingExport = JSON.parse(await mock.workspace.fullPendingJson());
    expect(pendingExport.assessments).toEqual([]);
    expect(pendingExport.pendingAssessments.assessments).toHaveLength(1);
    expect(pendingExport.pendingAssessments.assessments[0]).not.toHaveProperty('sequence');
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
    const id = mock.workspace.state.tasks[0]!.id;
    mock.queue.edit(id, 'Edited despite failed history', 'New notes');
    mock.queue.complete(id);
    mock.queue.capture('New capture');
    await mock.workspace.flush();
    expect(mock.saved().tasks[0]).toMatchObject({ notes: 'New notes', status: 'done' });
    expect(mock.saved().tasks).toHaveLength(2);
    mock.history.fail = false;
    await mock.workspace.retryAssessments();
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect((await reloaded.platform.assessmentRead('default', id)).assessments).toHaveLength(1);
  });

  test('history above 8 MiB is paged and leaves snapshots and ordinary saves small', async () => {
    const state = initial();
    state.tasks = [{ id: 'full', title: 'Long-lived task', notes: '', status: 'open', createdAt: before }];
    const first = (await assessmentBatch(rankInput(state))).assessments[0]!;
    const large = { ...first, assessment: {
      ...first.assessment, importance: 'i'.repeat(400), urgency: 'u'.repeat(400),
      blockers: 'b'.repeat(400), uncertainty: 'n'.repeat(400),
      supportingEvidence: Array.from({ length: 8 }, () => ({ reference: '$title', summary: 'e'.repeat(240) })),
    } };
    const count = Math.ceil(8 * 1024 * 1024 / new TextEncoder().encode(JSON.stringify(large)).length) + 2;
    const history = Array.from({ length: count }, () => ({ ...large, resultId: crypto.randomUUID() }));
    const mock = await fixture(state);
    for (let offset = 0; offset < history.length; offset += 20) await mock.workspace.saveAssessments('default', history.slice(offset, offset + 20));
    mock.queue.edit('full', 'Still editable', 'Normal notes');
    mock.queue.complete('full');
    mock.queue.capture('Normal capture');
    await mock.workspace.flush();
    expect(mock.history.entries).toHaveLength(count);
    expect(mock.saved().tasks[0]).not.toHaveProperty('assessments');
    expect(new TextEncoder().encode(mock.workspace.pendingJson()).length).toBeLessThan(10000);
    expect((await mock.platform.assessmentRead('default', 'full')).assessments).toHaveLength(20);
    const pending = await mock.workspace.fullPendingJson();
    expect(new TextEncoder().encode(pending).length).toBeGreaterThan(8 * 1024 * 1024);
    expect(JSON.parse(pending).assessments).toHaveLength(count);
    expect(mock.requests).toEqual([]);
  });

  test('quarantined results arriving after database recovery remain exportable while a new run succeeds', async () => {
    const state = initial();
    state.tasks = [{ id: 'same-id', title: 'Original task', notes: '', status: 'open', createdAt: before }];
    const entered = deferred<Extract<Request, { op: 'work.assess' }>>();
    const released = deferred<unknown>();
    let calls = 0;
    const mock = await fixture(state, request => {
      if (request.op === 'work.assess' && calls++ === 0) { entered.resolve(request); return released.promise; }
    });
    mock.queue.edit('same-id', 'Different restored task', 'Different notes');
    await mock.workspace.flush();
    const backup = await mock.platform.createBackup((await mock.platform.workspaceRead()).revision);
    mock.queue.edit('same-id', 'Original task', '');
    await mock.workspace.flush();
    const running = mock.queue.run();
    const request = await entered.promise;
    await mock.workspace.recoverBackup(backup.id);
    const original = (await assessmentBatch(request.input)).assessments[0]!;
    released.resolve({ assessments: [original] });
    await running;
    expect(mock.history.entries).toEqual([]);
    expect(mock.saved().tasks[0]).toMatchObject({ title: 'Different restored task', notes: 'Different notes' });
    expect(mock.workspace.getSnapshot().assessmentPending).toEqual([]);
    expect(mock.workspace.getSnapshot().assessmentQuarantined).toEqual([{
      workspaceGeneration: 0, sourceRevision: expect.any(String), assessment: original,
    }]);
    expect(mock.workspace.getSnapshot().assessmentError).toBe('');
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
    await mock.queue.run();
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.history.entries).toHaveLength(1);
    expect(mock.history.entries[0]!.resultId).not.toBe(original.resultId);
    expect(mock.saved().work.ranking!.orderedIds).toEqual(['same-id']);
    const exported = JSON.parse(await mock.workspace.fullPendingJson());
    expect(exported.assessments).toEqual(mock.history.entries);
    expect(exported.quarantinedAssessments).toEqual(mock.workspace.getSnapshot().assessmentQuarantined);
    const pending = JSON.parse(mock.workspace.pendingAssessmentsJson());
    expect(pending.workspaceGeneration).toBe(1);
    expect(pending.assessments).toEqual([]);
    expect(pending.quarantinedAssessments[0].assessment).toEqual(original);
  });

  test('already pending paid results become export-only quarantine when the database is recovered', async () => {
    const mock = await fixture();
    mock.queue.capture('Preserve failed paid work');
    await mock.workspace.flush();
    const backup = await mock.platform.createBackup((await mock.platform.workspaceRead()).revision);
    mock.history.fail = true;
    await mock.queue.run();
    const pending = [...mock.workspace.getSnapshot().assessmentPending];
    expect(pending).toHaveLength(1);
    await mock.workspace.recoverBackup(backup.id);
    expect(mock.workspace.getSnapshot().assessmentPending).toEqual([]);
    expect(mock.workspace.getSnapshot().assessmentQuarantined.map(value => value.assessment)).toEqual(pending);
    mock.history.fail = false;
    await mock.queue.run();
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.history.entries).toHaveLength(1);
    expect(JSON.parse(await mock.workspace.fullPendingJson()).quarantinedAssessments).toHaveLength(1);
  });

  test('in-flight assessments preserve edits and Done as history without ordering an incomplete eligible list', async () => {
    const state = initial();
    state.tasks = ['edited', 'done', 'unchanged'].map(id => ({ id, title: id, notes: '', status: 'open', createdAt: before }));
    const entered = deferred<Extract<Request, { op: 'work.assess' }>>();
    const released = deferred<unknown>();
    const mock = await fixture(state, request => {
      if (request.op === 'work.assess') { entered.resolve(request); return released.promise; }
    });
    const running = mock.queue.run();
    const request = await entered.promise;
    mock.queue.edit('edited', 'New owner title', 'New owner notes');
    mock.queue.complete('done');
    mock.queue.capture('Concurrent capture');
    released.resolve(await assessmentBatch(request.input));
    await running;
    expect(mock.saved().tasks.find(task => task.id === 'edited')).toMatchObject({ title: 'New owner title', notes: 'New owner notes' });
    expect(mock.saved().tasks.find(task => task.id === 'done')!.status).toBe('done');
    expect(mock.history.entries).toHaveLength(3);
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
    expect(mock.saved().work.ranking).toBeNull();
    expect(mock.queue.getSnapshot().error).toContain('Run assessor first');
  });

  test('in-flight results return to their original profile after external profile replacement', async () => {
    let state = initial();
    state.tasks = [{ id: 'original', title: 'Original profile', notes: '', status: 'open', createdAt: before }];
    state = createWorkProfile(state, 'Other');
    const otherId = state.activeWorkProfile.id;
    state = switchWorkProfile(state, 'default');
    const entered = deferred<Extract<Request, { op: 'work.assess' }>>();
    const released = deferred<unknown>();
    const mock = await fixture(state, request => {
      if (request.op === 'work.assess') { entered.resolve(request); return released.promise; }
    });
    const running = mock.queue.run();
    const request = await entered.promise;
    mock.workspace.update(current => switchWorkProfile(current, otherId));
    const otherWork = structuredClone(mock.workspace.state.work);
    released.resolve(await assessmentBatch(request.input));
    await running;
    expect(mock.saved().tasks).toEqual([]);
    expect(mock.saved().work).toEqual(otherWork);
    expect(mock.history.values('original')).toHaveLength(1);
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
    expect(mock.queue.getSnapshot().error).toContain('profile changed');
  });

  for (const shape of ['profile', 'fingerprint', 'instructions', 'model', 'task', 'duplicate', 'empty'] as const) {
    test(`rejects ${shape} assessment mismatch without attaching or ordering`, async () => {
      const state = initial();
      state.tasks = [{ id: 'owner-task', title: 'My task', notes: '', status: 'open', createdAt: before }];
      const batch = await assessmentBatch(rankInput(state));
      switch (shape) {
        case 'profile': batch.assessments[0]!.profileId = 'another-profile'; break;
        case 'fingerprint': batch.assessments[0]!.fingerprint = '0'.repeat(64); break;
        case 'instructions': batch.assessments[0]!.instructionsFingerprint = '0'.repeat(64); break;
        case 'model': batch.assessments[0]!.model = 'unexpected-model'; break;
        case 'task': batch.assessments[0]!.id = 'invented'; break;
        case 'duplicate': batch.assessments.push(batch.assessments[0]!); break;
        case 'empty': batch.assessments = []; break;
      }
      const mock = await fixture(state, request => request.op === 'work.assess' ? batch : undefined);
      await mock.queue.run();
      expect(mock.saved().tasks[0]).not.toHaveProperty('assessments');
      expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
      expect(mock.queue.getSnapshot().error).not.toBe('');
    });
  }

  test('source filters persist without changing collection, ranking or coverage', async () => {
    const initialState = initial();
    initialState.work.settings = defaultWorkState().settings;
    initialState.work.collectionCursor = before;
    const mock = await fixture(initialState);
    mock.queue.capture('Hidden manual task');
    mock.queue.saveSourceFilter({ selectedSources: [], collapsedProviders: ['github'] });
    await mock.workspace.flush();
    expect(mock.saved().work.sourceFilter).toEqual({ selectedSources: [], collapsedProviders: ['github'] });
    expect(mock.saved().work.collectionCursor).toBe(before);
    expect(mock.requests).toEqual([]);
    await mock.queue.run();
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.stream.id))
      .toEqual(initialState.work.settings.streams.map(stream => stream.id));
    const ranking = mock.requests.find(request => request.op === 'work.rank');
    if (ranking?.op !== 'work.rank') throw new Error('Missing ranking request');
    expect(ranking.input.tasks.map(task => task.title)).toContain('Hidden manual task');
    expect(ranking.input.tasks.map(task => task.title)).toContain('Review the change');
    expect(mock.saved().work.sourceFilter?.selectedSources).toEqual([]);
    expect(mock.queue.getSnapshot().error).toBe('');
  });
  test('offline capture, edits, Done and restore persist through the native workspace', async () => {
    const mock = await fixture();
    mock.queue.capture(' Offline task ', 'Private task note');
    const id = mock.workspace.state.tasks[0]!.id;
    mock.queue.edit(id, 'Changed title', 'Changed notes');
    mock.queue.complete(id);
    await mock.workspace.flush();
    expect(mock.requests).toEqual([]);
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect(reloaded.state.tasks[0]).toMatchObject({ id, title: 'Changed title', notes: 'Changed notes', status: 'done' });
    new WorkQueue(reloaded, mock.service).restore(id);
    await reloaded.flush();
    expect(mock.saved().tasks[0]!.status).toBe('open');
    expect(mock.saved().tasks[0]!.completedAt).toBeDefined();
  });

  test('v3 storage migration preserves every task and note with scheduling opt-in', async () => {
    const saved = initial();
    saved.tasks.push({ id: 'legacy', title: 'Legacy capture', notes: 'Existing notes', status: 'open', createdAt: before });
    const { work: _work, ...old } = saved;
    const mock = await fixture(old);
    expect(mock.saved().tasks).toEqual(saved.tasks);
    expect(mock.saved().notes).toEqual(saved.notes);
    expect(mock.saved().work).toEqual(defaultWorkState());
    await mock.queue.tick();
    expect(mock.requests).toEqual([]);
  });

  test('v2 migration keeps legacy tasks and annotations when the queue is attached', async () => {
    const legacy = legacyFixture(true);
    const mock = await fixture(legacy);
    const tasks = structuredClone(mock.workspace.state.tasks);
    const notes = structuredClone(mock.workspace.state.notes);
    mock.queue.capture('New task');
    await mock.workspace.flush();
    expect(mock.saved().tasks.slice(0, tasks.length)).toEqual(tasks);
    expect(mock.saved().notes).toEqual(notes);
    expect(mock.saved().notes.map(note => note.text)).toEqual(['First distinct annotation', 'Second distinct annotation', 'Captured thread annotation']);
    expect(mock.saved().work.settings.schedule).toEqual({ enabled: false, everyMinutes: 30 });
  });

  test('connections are typed discovery and do not mutate saved instructions', async () => {
    const mock = await fixture();
    await mock.queue.connections();
    expect(mock.queue.getSnapshot().connections?.servers[0]?.name).toBe('slack');
    expect(mock.workspace.state.work.settings.instructions).toBe('');
  });
});

describe('work profiles', () => {
  test('existing v3 work migrates to Default without changing tasks, settings or history', async () => {
    const current = reconcileWork(initial(), collection(), before);
    current.work.settings.instructions = 'Keep these priorities';
    current.work.collectionCursor = before;
    current.work.lastCompletedAt = previousCompleted;
    const { activeWorkProfile: _active, inactiveWorkProfiles: _inactive, ...legacy } = current;
    const mock = await fixture(legacy);
    expect(mock.saved().activeWorkProfile).toEqual({ id: 'default', name: 'Default' });
    expect(mock.saved().inactiveWorkProfiles).toEqual([]);
    expect(mock.saved().tasks).toEqual(current.tasks);
    expect(mock.saved().work).toEqual({ ...current.work, settings: workSettingsSchema.parse(current.work.settings) });
  });

  test('switching restores independent tasks, completion, settings, ranking and cursors after relaunch', async () => {
    const saved = initial();
    saved.work.settings = { ...defaultWorkState().settings, instructions: 'Reviews first', model: 'model-a' };
    const mock = await fixture(saved);
    await mock.queue.run();
    const firstId = mock.workspace.state.tasks[0]!.id;
    mock.queue.edit(firstId, 'Regular review', 'Notes for regular work');
    mock.queue.complete(firstId);
    mock.queue.capture('Regular manual task');
    await mock.workspace.flush();
    const original = structuredClone(mock.saved());

    mock.queue.createProfile(' On call ', true);
    const profileId = mock.workspace.state.activeWorkProfile.id;
    expect(mock.workspace.state.tasks).toEqual([]);
    expect(mock.workspace.state.work.ranking).toBeNull();
    expect(mock.workspace.state.work.collectionCursor).toBeNull();
    expect(mock.workspace.state.work.lastCompletedAt).toBeNull();
    mock.queue.saveSettings({
      ...mock.workspace.state.work.settings, instructions: 'Incidents first', model: 'model-b',
      streams: [notificationWorkstream()],
    });
    await mock.queue.run();
    expect(mock.queue.getSnapshot().error).toBe('');
    const onCallId = mock.workspace.state.tasks[0]!.id;
    expect(onCallId).not.toBe(firstId);
    expect(mock.workspace.state.tasks[0]!.status).toBe('open');
    mock.queue.edit(onCallId, 'On-call review', 'Different notes');
    mock.queue.capture('On-call manual task');
    await mock.workspace.flush();
    const onCall = structuredClone(mock.saved());
    expect(onCall.inactiveWorkProfiles[0]!.tasks).toEqual(original.tasks);
    expect(onCall.inactiveWorkProfiles[0]!.work).toEqual(original.work);
    const rank = mock.requests.filter(request => request.op === 'work.rank').at(-1)!;
    expect(rank.input.instructions).toBe('Incidents first');
    expect(rank.input.tasks.map(task => task.id)).toEqual([onCallId]);
    const collect = mock.requests.filter(request => request.op === 'work.collect').at(-1)!;
    expect(collect.input).toMatchObject({ since: null, stream: { kind: 'github-notifications' } });

    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    const queue = new WorkQueue(reloaded, mock.service);
    expect(reloaded.state.activeWorkProfile).toEqual({ id: profileId, name: 'On call' });
    expect(reloaded.state.tasks).toEqual(onCall.tasks);
    queue.switchProfile('default');
    expect(reloaded.state.tasks).toEqual(original.tasks);
    expect(reloaded.state.work).toEqual(original.work);
    queue.switchProfile(profileId);
    expect(reloaded.state.tasks).toEqual(onCall.tasks);
    expect(reloaded.state.work).toEqual(onCall.work);
    await reloaded.flush();
    expect(mock.saved().activeWorkProfile.id).toBe(profileId);
  });

  test('empty and copied profiles have no tasks, and copies cannot mutate the original settings', async () => {
    const saved = initial();
    saved.work.settings = defaultWorkState().settings;
    saved.work.settings.instructions = 'Normal work';
    saved.work.settings.schedule.enabled = true;
    const mock = await fixture(saved);
    mock.queue.capture('Keep in Default');
    mock.queue.createProfile('Copied', true);
    expect(mock.workspace.state.work.settings.instructions).toBe('Normal work');
    expect(mock.workspace.state.work.settings.streams).toEqual(saved.work.settings.streams);
    expect(mock.workspace.state.work.settings.schedule.enabled).toBe(false);
    const changed = structuredClone(mock.workspace.state.work.settings);
    changed.streams[0]!.query = 'repo:owner/on-call is:pr';
    mock.queue.saveSettings(changed);
    expect(mock.workspace.state.inactiveWorkProfiles[0]!.work.settings).toEqual(workSettingsSchema.parse(saved.work.settings));
    mock.queue.createProfile('Empty');
    expect(mock.workspace.state.tasks).toEqual([]);
    expect(mock.workspace.state.work.settings).toMatchObject({ instructions: '', model: '', streams: [], schedule: { enabled: false } });
    await mock.workspace.flush();
  });

  test('profile names are trimmed, unique and validated atomically with settings', async () => {
    const mock = await fixture();
    mock.queue.createProfile('On call');
    const before = structuredClone(mock.workspace.state);
    for (const name of ['', ' ', 'DEFAULT', 'x'.repeat(81)]) {
      expect(() => mock.queue.createProfile(name)).toThrow();
      expect(() => mock.queue.saveSettings({ ...before.work.settings, instructions: 'Must not save' }, name)).toThrow();
      expect(mock.workspace.state.work).toEqual(before.work);
      expect(mock.workspace.state.activeWorkProfile).toEqual(before.activeWorkProfile);
    }
    expect(() => mock.queue.switchProfile('missing')).toThrow('no longer exists');
    mock.queue.saveSettings(before.work.settings, ' Release week ');
    expect(mock.workspace.state.activeWorkProfile).toEqual({ ...before.activeWorkProfile, name: 'Release week' });
    await mock.workspace.flush();
  });

  test('reference task undo stays with its profile and unfinished capture text is retained', async () => {
    const mock = await fixture();
    mock.queue.capture('Regular task');
    const id = mock.workspace.state.tasks[0]!.id;
    mock.workspace.dispatch({ type: 'done', key: `a:${id}` });
    mock.workspace.dispatch({ type: 'draft', text: 'Unfinished capture' });
    const undo = structuredClone(mock.workspace.state.undo);
    expect(undo).toHaveLength(1);
    mock.queue.createProfile('On call');
    expect(mock.workspace.state.undo).toEqual([]);
    expect(mock.workspace.state.draft).toBe('Unfinished capture');
    mock.workspace.dispatch({ type: 'undo' });
    expect(mock.workspace.state.tasks).toEqual([]);
    mock.queue.switchProfile('default');
    expect(mock.workspace.state.undo).toEqual(undo);
    mock.workspace.dispatch({ type: 'undo' });
    expect(mock.workspace.state.tasks[0]!.status).toBe('open');
    await mock.workspace.flush();
  });

  test('invalid inactive profiles block loading rather than dropping saved work', async () => {
    const mock = await fixture();
    mock.queue.capture('Preserve this');
    mock.queue.createProfile('On call');
    await mock.workspace.flush();
    for (const field of ['name', 'id', 'task'] as const) {
      const damaged = structuredClone(mock.saved());
      if (field === 'task') damaged.tasks = structuredClone(damaged.inactiveWorkProfiles[0]!.tasks);
      else damaged.inactiveWorkProfiles[0]![field] = damaged.activeWorkProfile[field];
      expect(() => restoreDesktop(damaged, before)).toThrow(field === 'task' ? 'inconsistent task references' : 'must be unique');
    }
  });

  test('inactive schedules do not run and intake belongs only to the active profile', async () => {
    const saved = initial();
    saved.work.settings.schedule.enabled = true;
    let pending = true;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.intake') return { items: pending ? [{ id: 'pushed', candidate: candidate() }] : [], hasMore: false };
      if (request.op === 'work.ackIntake') { pending = false; return request.input; }
    });
    mock.queue.createProfile('Focused');
    await mock.queue.tick();
    expect(mock.requests).toEqual([]);
    await mock.queue.run();
    expect(mock.saved().tasks).toHaveLength(1);
    expect(mock.saved().inactiveWorkProfiles[0]!.tasks).toEqual([]);
    const calls = mock.requests.length;
    mock.queue.switchProfile('default');
    expect(mock.requests).toHaveLength(calls);
    await mock.queue.tick();
    expect(mock.requests.length).toBeGreaterThan(calls);
    expect(mock.saved().tasks).toEqual([]);
    expect(mock.saved().inactiveWorkProfiles[0]!.tasks).toHaveLength(1);
  });

  test('profile creation and switching are blocked throughout an in-flight run', async () => {
    const entered = deferred<void>();
    const result = deferred<unknown>();
    const mock = await fixture(initial(), request => {
      if (request.op !== 'work.rank') return;
      entered.resolve();
      return result.promise;
    });
    mock.queue.createProfile('On call');
    const targetId = mock.workspace.state.activeWorkProfile.id;
    mock.queue.switchProfile('default');
    mock.queue.capture('Rank this task');
    const pending = mock.queue.run();
    await entered.promise;
    expect(() => mock.queue.switchProfile(targetId)).toThrow('Wait for the current run');
    expect(() => mock.queue.createProfile('Release')).toThrow('Wait for the current run');
    const request = mock.requests.find(request => request.op === 'work.rank')!;
    result.resolve(ranked(request));
    await pending;
    expect(mock.saved().work.ranking!.orderedIds).toEqual([mock.saved().tasks[0]!.id]);
    mock.queue.switchProfile(targetId);
    expect(mock.workspace.state.tasks).toEqual([]);
    expect(mock.workspace.state.work.ranking).toBeNull();
    expect(mock.queue.getSnapshot()).toMatchObject({ error: '', warnings: [], running: false });
    await mock.workspace.flush();
  });

  test('failed profile saves retain every task for retry and backups include inactive profiles', async () => {
    const mock = await fixture();
    mock.queue.capture('Default task');
    await mock.workspace.flush();
    mock.fail(() => true);
    mock.queue.createProfile('On call');
    mock.queue.capture('On-call task');
    await expect(mock.workspace.flush()).rejects.toThrow('Disk unavailable');
    expect(mock.saved().activeWorkProfile.id).toBe('default');
    const pending = JSON.parse(mock.workspace.pendingJson()).workspace.state;
    expect(pending.tasks[0].title).toBe('On-call task');
    expect(pending.inactiveWorkProfiles[0].tasks[0].title).toBe('Default task');
    mock.fail(() => false);
    await mock.workspace.retryStorage();
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect(reloaded.state.tasks[0]!.title).toBe('On-call task');
    expect(reloaded.state.inactiveWorkProfiles[0]!.tasks[0]!.title).toBe('Default task');
  });
});

describe('explicit task agents', () => {
  function configure(mock: Awaited<ReturnType<typeof fixture>>, job: TaskAgentJob, patch: { name?: string; instructions?: string; model?: string }) {
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, agents: taskAgents(mock.workspace.state.work.settings)
      .map(agent => agent.jobType === job ? { ...agent, ...patch } : agent) });
  }

  async function historyAcrossConfigurations() {
    const mock = await fixture();
    mock.queue.capture('Reuse the original judgment');
    configure(mock, 'task-assessment', { instructions: 'Configuration A' });
    await mock.queue.runAssessor();
    await mock.queue.runAssessor();
    await mock.queue.runPrioritizer();
    const originalA = mock.history.entries.at(-1)!;
    configure(mock, 'task-assessment', { instructions: 'Configuration B' });
    for (let index = 0; index < 21; index++) await mock.queue.runAssessor();
    return { mock, originalA };
  }

  test('prioritizer reuses newest current A after A-to-B-to-A across history pages without assessment', async () => {
    const { mock, originalA } = await historyAcrossConfigurations();
    configure(mock, 'task-assessment', { instructions: 'Configuration A' });
    const history = structuredClone(mock.history.entries);
    mock.requests.length = 0;
    const read = spyOn(mock.history, 'read');
    try {
      await mock.queue.runPrioritizer();
      expect(mock.requests.map(request => request.op)).toEqual(['work.rank']);
      const request = mock.requests[0]!;
      if (request.op !== 'work.rank') throw new Error('No prioritization request');
      expect(request.input.assessmentIds).toEqual([originalA.resultId]);
      expect(read.mock.calls.map(call => call[2])).toEqual([null, 4]);
      expect(mock.queue.getSnapshot().error).toBe('');
      expect(mock.history.entries).toEqual(history);
    } finally { read.mockRestore(); }
  });

  test('prioritizer exhausts incompatible history pages without assessment or replacing the prior order', async () => {
    const { mock } = await historyAcrossConfigurations();
    configure(mock, 'task-assessment', { instructions: 'Configuration C with no saved judgment' });
    const prior = structuredClone(mock.saved().work.ranking);
    const history = structuredClone(mock.history.entries);
    mock.requests.length = 0;
    const read = spyOn(mock.history, 'read');
    try {
      await mock.queue.runPrioritizer();
      expect(read.mock.calls.map(call => call[2])).toEqual([null, 4]);
      expect(mock.requests).toEqual([]);
      expect(mock.queue.getSnapshot().error).toContain('Run assessor first');
      expect(mock.saved().work.ranking).toEqual(prior);
      expect(mock.history.entries).toEqual(history);
    } finally { read.mockRestore(); }
  });

  for (const invalid of ['repeated-page', 'duplicate-result', 'empty-continuation', 'nonadvancing-cursor'] as const) {
    test(`prioritizer rejects ${invalid} while searching history and preserves old order`, async () => {
      const { mock } = await historyAcrossConfigurations();
      configure(mock, 'task-assessment', { instructions: 'Configuration A' });
      const prior = structuredClone(mock.saved().work.ranking);
      mock.requests.length = 0;
      const originalRead = mock.history.read.bind(mock.history);
      const read = spyOn(mock.history, 'read').mockImplementation((profileId, taskId, before, state) => {
        const page = originalRead(profileId, taskId, before, state);
        if (invalid === 'repeated-page' && before !== null) return originalRead(profileId, taskId, null, state);
        if (invalid === 'duplicate-result') return {
          ...page, assessments: page.assessments.map((entry, index) => index === 1
            ? { ...entry, resultId: page.assessments[0]!.resultId } : entry),
        };
        if (invalid === 'empty-continuation') return { assessments: [], before: 4 };
        if (invalid === 'nonadvancing-cursor') return { ...page, before: page.assessments[0]!.sequence };
        return page;
      });
      try {
        await mock.queue.runPrioritizer();
        expect(mock.requests).toEqual([]);
        expect(read.mock.calls.length).toBeLessThanOrEqual(2);
        expect(mock.queue.getSnapshot().error).toContain('Assessment history');
        expect(mock.saved().work.ranking).toEqual(prior);
      } finally { read.mockRestore(); }
    });
  }

  test('assessor-only forces versions without collecting, ordering or advancing schedule coverage', async () => {
    const state = initial();
    state.tasks = ['first', 'second'].map(id => ({ id, title: id, notes: '', status: 'open', createdAt: before }));
    state.work.settings.streams = defaultWorkState().settings.streams;
    state.work.settings.schedule.enabled = true;
    state.work.ranking = { orderedIds: ['first', 'second'], reasons: [{ id: 'first', reason: 'Original' }], rankedAt: before };
    state.work.collectionCursor = before;
    state.work.lastStartedAt = before;
    state.work.lastCompletedAt = previousCompleted;
    const mock = await fixture(state);
    await mock.queue.runAssessor();
    expect(mock.saved().work.ranking).toEqual(state.work.ranking);
    const firstIds = mock.history.entries.map(value => value.resultId);
    await mock.queue.runAssessor();
    expect(mock.saved().work.ranking).toEqual(state.work.ranking);
    expect(mock.requests.map(request => request.op)).toEqual(['work.assess', 'work.assess']);
    expect(mock.requests.every(request => request.op === 'work.assess' && request.input.force === true)).toBe(true);
    expect(mock.history.entries).toHaveLength(4);
    expect(new Set(mock.history.entries.map(value => value.resultId)).size).toBe(4);
    expect(mock.history.entries.slice(0, 2).map(value => value.resultId)).toEqual(firstIds);
    expect(mock.saved().work).toMatchObject({
      ranking: state.work.ranking, lastStartedAt: before, lastCompletedAt: previousCompleted, collectionCursor: before,
      settings: { schedule: { enabled: true } },
    });
    expect(mock.queue.getSnapshot()).toMatchObject({ running: false, error: '', progress: { kind: 'assess', sources: [] } });
  });

  test('prioritizer-only requires saved work, recomputes the whole list and never assesses or collects', async () => {
    const mock = await fixture();
    mock.queue.capture('First');
    mock.queue.capture('Second');
    const prior = { orderedIds: mock.workspace.state.tasks.map(task => task.id), reasons: [], rankedAt: before };
    mock.workspace.update(current => ({ ...current, work: { ...current.work, ranking: prior } }));
    await mock.queue.runPrioritizer();
    expect(mock.requests).toEqual([]);
    expect(mock.queue.getSnapshot().error).toContain('Run assessor first');
    expect(mock.saved().work.ranking).toEqual(prior);
    await mock.queue.runAssessor();
    const versions = structuredClone(mock.history.entries);
    mock.queue.saveSourceFilter({ selectedSources: [], collapsedProviders: [] });
    await mock.queue.runPrioritizer();
    await mock.queue.runPrioritizer();
    expect(mock.requests.map(request => request.op)).toEqual(['work.assess', 'work.rank', 'work.rank']);
    for (const request of mock.requests) if (request.op === 'work.rank') {
      expect(request.input.force).toBe(true);
      expect(request.input.tasks).toHaveLength(2);
      expect(new Set(request.input.assessmentIds)).toEqual(new Set(versions.map(value => value.resultId)));
    }
    expect(mock.history.entries).toEqual(versions);
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.saved().work.lastStartedAt).toBeNull();
    expect(mock.saved().work.lastCompletedAt).toBeNull();
  });

  test('prioritizer edits reuse assessor results; assessor edits require new assessment and keep old order', async () => {
    const mock = await fixture();
    mock.queue.capture('Independent roles');
    await mock.queue.runAssessor();
    const versions = structuredClone(mock.history.entries);
    configure(mock, 'task-prioritization', { instructions: 'New ordering rules', model: 'priority-model' });
    configure(mock, 'task-assessment', { name: 'Evidence specialist' });
    await mock.queue.runPrioritizer();
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.history.entries).toEqual(versions);
    expect(mock.requests.map(request => request.op)).toEqual(['work.assess', 'work.rank']);
    const prior = structuredClone(mock.saved().work.ranking);
    configure(mock, 'task-assessment', { instructions: 'Changed intrinsic meaning' });
    await mock.queue.runPrioritizer();
    expect(mock.queue.getSnapshot().error).toContain('Run assessor first');
    expect(mock.saved().work.ranking).toEqual(prior);
    expect(mock.history.entries).toEqual(versions);
    expect(mock.requests).toHaveLength(2);
  });

  test('agent definitions materialize for both legacy profiles and edits never leak across profiles or reload', async () => {
    let state = initial();
    delete state.work.settings.agents;
    delete state.work.settings.codeAgents;
    state.work.settings.instructions = 'Original owner rules';
    state.work.settings.model = 'original-model';
    state = createWorkProfile(state, 'Other', true);
    state.work.settings.instructions = 'Other owner rules';
    const otherId = state.activeWorkProfile.id;
    state = switchWorkProfile(state, 'default');
    const mock = await fixture(state);
    const original = structuredClone(taskAgents(mock.workspace.state.work.settings));
    expect(original.every(agent => agent.instructions === 'Original owner rules' && agent.model === 'original-model')).toBe(true);
    expect(mock.workspace.state.inactiveWorkProfiles[0]!.work.settings.agents?.every(agent => agent.instructions === 'Other owner rules')).toBe(true);
    mock.queue.switchProfile(otherId);
    configure(mock, 'task-assessment', { instructions: 'Other assessor', model: 'other-model', name: 'Other specialist' });
    configure(mock, 'task-prioritization', { instructions: 'Other priorities' });
    await mock.workspace.flush();
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    const queue = new WorkQueue(reloaded, mock.service);
    expect(taskAgents(reloaded.state.work.settings)[0]!.instructions).toBe('Other assessor');
    queue.switchProfile('default');
    expect(taskAgents(reloaded.state.work.settings)).toEqual(original);
    expect(reloaded.state.work.settings).toMatchObject({ instructions: 'Original owner rules', model: 'original-model' });
    await reloaded.flush();
  });

  test('independent runs share the overlap guard and preserve notes and Done during assessment', async () => {
    const entered = deferred<Extract<Request, { op: 'work.assess' }>>();
    const released = deferred<unknown>();
    const mock = await fixture(initial(), request => {
      if (request.op === 'work.assess') { entered.resolve(request); return released.promise; }
    });
    mock.queue.capture('Keep owner edits');
    const id = mock.workspace.state.tasks[0]!.id;
    const run = mock.queue.runAssessor();
    const request = await entered.promise;
    const duplicate = mock.queue.runAssessor();
    const prioritize = mock.queue.runPrioritizer();
    const pipeline = mock.queue.run();
    mock.queue.edit(id, 'Changed title', 'Changed notes');
    mock.queue.complete(id);
    released.resolve(await assessmentBatch(request.input));
    await Promise.all([run, duplicate, prioritize, pipeline]);
    expect(mock.requests.map(request => request.op)).toEqual(['work.assess']);
    expect(mock.history.entries).toHaveLength(1);
    expect(mock.saved().tasks[0]).toMatchObject({ title: 'Changed title', notes: 'Changed notes', status: 'done' });
    expect(mock.saved().work.ranking).toBeNull();
  });

  test('a failed independent order preserves paid versions and the prior successful order', async () => {
    let fail = false;
    const mock = await fixture(initial(), request => {
      if (fail && request.op === 'work.rank') throw new Error('Independent order unavailable');
    });
    mock.queue.capture('Paid assessment');
    await mock.queue.runAssessor();
    await mock.queue.runPrioritizer();
    const versions = structuredClone(mock.history.entries);
    const prior = structuredClone(mock.saved().work.ranking);
    fail = true;
    await mock.queue.runPrioritizer();
    expect(mock.history.entries).toEqual(versions);
    expect(mock.saved().work.ranking).toEqual(prior);
    expect(mock.requests.map(request => request.op)).toEqual(['work.assess', 'work.rank', 'work.rank']);
    expect(mock.queue.getSnapshot().error).toContain('Independent order unavailable');
  });
});

describe('runs and persistence barriers', () => {
  test('intake, assigned work and notification follow-ups save and rank one GitHub task with shared Done', async () => {
    const saved = initial();
    saved.work.settings.streams = [defaultWorkState().settings.streams[1]!, notificationWorkstream()];
    let pending = true;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.intake') return {
        items: pending ? [{ id: 'intake:1', candidate: { ...candidate('copilot:1', 'copilot'), action: 'review-result' } }] : [],
        hasMore: false,
      };
      if (request.op === 'work.ackIntake') { pending = false; return request.input; }
      if (request.op === 'work.collect') {
        const notification = request.input.stream.kind === 'github-notifications';
        return collection([{
          ...candidate(notification ? 'overdue-comment' : 'assigned'),
          action: notification ? 'follow-up' : 'implement',
          ...(notification ? {
            notification: { threadId: '123', reference: { repo: 'Owner/Repo', number: 42, kind: 'pr' as const }, updatedAt: before },
          } : {}),
        }]);
      }
    });
    await mock.queue.run();
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.saved().tasks).toHaveLength(1);
    const task = mock.saved().tasks[0]!;
    expect(task.work!.evidence.map(item => item.id)).toEqual(['copilot:1', 'assigned', 'overdue-comment']);
    expect(mock.saved().work.ranking!.orderedIds).toEqual([task.id]);
    expect(mock.requests.find(request => request.op === 'work.rank')!.input).toMatchObject({ tasks: [{ id: task.id }] });
    mock.queue.complete(task.id);
    await mock.workspace.flush();
    await mock.queue.run();
    expect(mock.saved().tasks).toHaveLength(1);
    expect(mock.saved().tasks[0]!.status).toBe('done');
    expect(mock.saved().work.ranking!.orderedIds).toEqual([]);
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load(); await reloaded.flush();
    expect(reloaded.state.tasks).toEqual(mock.saved().tasks);
  });

  test('manual-only runs use SDK ranking with owner settings; zero tasks skip the model', async () => {
    const mock = await fixture();
    await mock.queue.run();
    expect(mock.requests.map(request => request.op)).toEqual(['work.intake']);
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, instructions: 'My ordering policy', model: 'selected-model' });
    mock.queue.capture('First task', 'Relevant task notes');
    mock.queue.capture('Second task');
    await mock.queue.run();
    const request = mock.requests.find(request => request.op === 'work.rank')!;
    expect(request.input).toMatchObject({ instructions: 'My ordering policy', model: 'selected-model' });
    expect(rankedTasks(mock.saved()).map(task => task.title)).toEqual(['Second task', 'First task']);
    expect(mock.saved().work.ranking?.reasons).toHaveLength(2);
    expect(mock.saved().work.lastStartedAt).not.toBeNull();
    expect(mock.saved().work.lastCompletedAt).not.toBeNull();
    expect(mock.queue.getSnapshot()).toMatchObject({ running: false, error: '', warnings: [] });
    const firstDispatch = mock.log.indexOf('work.intake');
    expect(mock.log.slice(0, firstDispatch)).toContain('workspace_save');
  });

  test('a failed durable start dispatches nothing and preserves completion and ranking timestamps', async () => {
    const saved = initial();
    saved.work.lastCompletedAt = previousCompleted;
    saved.work.ranking = { orderedIds: [], reasons: [], rankedAt: previousCompleted };
    const mock = await fixture(saved);
    mock.fail(() => true);
    await mock.queue.run();
    expect(mock.requests).toEqual([]);
    expect(mock.queue.getSnapshot().error).toContain('Disk unavailable');
    expect(mock.queue.getSnapshot()).toMatchObject({ phase: 'error', progress: { sources: [] } });
    expect(mock.queue.getSnapshot().progress?.finishedAt).toBeNumber();
    expect(mock.saved().work.lastStartedAt).toBeNull();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.saved().work.ranking?.rankedAt).toBe(previousCompleted);
  });

  test('discoveries persist when ranking fails and previous complete order survives relaunch', async () => {
    const saved = initial();
    saved.tasks.push({ id: 'manual', title: 'Existing task', notes: '', status: 'open', createdAt: before });
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    saved.work.ranking = { orderedIds: ['manual'], reasons: [{ id: 'manual', reason: 'Previous reason' }], rankedAt: before };
    saved.work.lastCompletedAt = previousCompleted;
    saved.work.collectionCursor = before;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.rank') throw new Error('SDK unavailable');
    });
    await mock.queue.run();
    expect(mock.saved().tasks).toHaveLength(2);
    expect(mock.saved().work.ranking).toEqual(saved.work.ranking);
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.saved().work.collectionCursor).toBe(before);
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done']);
    expect(mock.queue.getSnapshot().phase).toBe('error');
    expect(mock.saved().work.lastError).toContain('SDK unavailable');
    expect(rankedTasks(mock.saved())[0]!.id).toBe('manual');
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect(reloaded.state.tasks).toHaveLength(2);
    expect(reloaded.state.work.ranking).toEqual(saved.work.ranking);
  });

  test('failed streams and partial warnings remain explicit while other discoveries are saved and ranked', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams;
    saved.work.lastCompletedAt = previousCompleted;
    saved.work.collectionCursor = before;
    const mock = await fixture(saved, request => {
      if (request.op !== 'work.collect') return;
      if (request.input.stream.id === 'github-reviews') throw new Error('GitHub authentication expired');
      return { ...collection(), warnings: ['One page was unavailable'] };
    });
    await mock.queue.run();
    expect(mock.saved().tasks).toHaveLength(1);
    expect(mock.requests.filter(request => request.op === 'work.rank')).toHaveLength(1);
    expect(mock.queue.getSnapshot().error).toContain('authentication expired');
    expect(mock.queue.getSnapshot().warnings.join()).toContain('One page was unavailable');
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.saved().work.collectionCursor).toBe(before);
    for (const request of mock.requests) {
      if (request.op === 'work.collect') expect(request.input.since).toBe(before);
    }
  });

  test('saved source URLs are rechecked when search no longer matches, including merge queue exit', async () => {
    const saved = reconcileWork(initial(), collection(), before);
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    let sourceState: WorkCollection['observations'][number]['state'] = 'queued';
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') {
        expect(request.input.knownUrls).toEqual(['https://github.com/owner/repo/issues/42']);
        return {
          candidates: [], observations: [{ url, state: sourceState, observedAt: new Date().toISOString(), reason: sourceState }],
          warnings: [], collectedAt: new Date().toISOString(),
        };
      }
    });
    await mock.queue.run();
    expect(mock.saved().tasks[0]!.status).toBe('open');
    expect(mock.saved().tasks[0]!.work!.availability).toBe('waiting');
    expect(rankedTasks(mock.saved())).toEqual([]);
    sourceState = 'open';
    await mock.queue.run();
    expect(rankedTasks(mock.saved())).toHaveLength(1);
  });

  test('unknown source tasks stay visible and SDK ranking receives explicit uncertainty', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') return {
        ...collection(), observations: [{ url, state: 'unknown', observedAt: before, reason: 'State check was unavailable.' }],
      };
      if (request.op === 'work.rank') {
        expect(request.input.tasks).toHaveLength(1);
        expect(request.input.tasks[0]).toMatchObject({ availability: 'unknown', availabilityReason: 'State check was unavailable.' });
      }
    });
    await mock.queue.run();
    expect(rankedTasks(mock.saved())).toHaveLength(1);
    expect(mock.saved().tasks[0]!.work!.availability).toBe('unknown');
    expect(mock.saved().tasks[0]!.notes).toBe('');
    expect(mock.saved().work.ranking?.orderedIds).toHaveLength(1);
    expect(mock.requests.filter(request => request.op === 'work.rank')).toHaveLength(1);
  });

  test('Slack-only streams recheck tracked GitHub targets even when the message disappears from search', async () => {
    const saved = reconcileWork(initial(), collection([candidate('slack:message', 'slack')]), before);
    saved.work.settings.streams = [{
      id: 'slack-stream', name: 'Slack asks', enabled: true, kind: 'slack', query: 'mentions:me', action: 'review', server: 'slack', tools: [],
    }];
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') {
        expect(request.input.stream.kind).toBe('slack');
        expect(request.input.knownUrls).toEqual(['https://github.com/owner/repo/issues/42']);
        return {
          candidates: [], observations: [{ url, state: 'queued', observedAt: before, reason: 'In merge queue' }],
          warnings: [], collectedAt: before,
        };
      }
    });
    await mock.queue.run();
    expect(mock.saved().tasks[0]!.status).toBe('open');
    expect(mock.saved().tasks[0]!.work!.availability).toBe('waiting');
    expect(rankedTasks(mock.saved())).toEqual([]);
    expect(mock.queue.getSnapshot().error).toBe('');
  });

  test('known sources exceeding one request are checked without silently dropping saved tasks', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      ...candidate(`github:${index}`), url: `https://github.com/owner/repo/pull/${index + 1}`,
    }));
    const saved = reconcileWork(initial(), {
      candidates, observations: candidates.map(item => ({ url: item.url, state: 'open', observedAt: before, reason: 'Open' })),
      collectedAt: before, warnings: [],
    }, before);
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    const checked: string[][] = [];
    const mock = await fixture(saved, request => {
      if (request.op !== 'work.collect') return;
      expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['collecting']);
      checked.push(request.input.knownUrls);
      return {
        candidates: [], warnings: [], collectedAt: new Date().toISOString(),
        observations: request.input.knownUrls.map(url => ({ url, state: 'queued', observedAt: new Date().toISOString(), reason: 'Queued' })),
      };
    });
    await mock.queue.run();
    expect(checked.map(page => page.length)).toEqual([100, 1]);
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.observeOnly)).toEqual([false, true]);
    expect(new Set(checked.flat()).size).toBe(101);
    expect(mock.saved().tasks).toHaveLength(101);
    expect(rankedTasks(mock.saved())).toEqual([]);
    expect(mock.queue.getSnapshot().error).toBe('');
  });

  test('tracked sources are checked once per run across streams, including canonical aliases and unknown results', async () => {
    const saved = reconcileWork(initial(), collection(), before);
    saved.work.settings.streams = defaultWorkState().settings.streams;
    const mock = await fixture(saved, request => {
      if (request.op !== 'work.collect') return;
      return {
        ...collection(), observations: [{ url, state: 'unknown', observedAt: before, reason: 'Access denied' }],
      };
    });
    await mock.queue.run();
    const expected = saved.work.settings.streams.map((_, index) => index === 0 ? ['https://github.com/owner/repo/issues/42'] : []);
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.knownUrls)).toEqual(expected);
    await mock.queue.run();
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.knownUrls)).toEqual([...expected, ...expected]);
    expect(mock.queue.getSnapshot().error).toBe('');
    expect(mock.saved().tasks[0]!.work!.availability).toBe('unknown');
  });

  test('failed collections leave tracked sources eligible for observation by the next stream', async () => {
    const saved = reconcileWork(initial(), collection(), before);
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 2);
    let calls = 0;
    const mock = await fixture(saved, request => {
      if (request.op !== 'work.collect') return;
      if (calls++ === 0) throw new Error('Temporary source failure');
      return collection();
    });
    await mock.queue.run();
    expect(calls).toBe(2);
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.knownUrls))
      .toEqual([['https://github.com/owner/repo/issues/42'], ['https://github.com/owner/repo/issues/42']]);
    expect(mock.queue.getSnapshot().error).toContain('Temporary source failure');
  });

  test('a search observation outside its tracked page avoids a redundant observe-only request', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      ...candidate(`github:${index}`), url: `https://github.com/owner/repo/pull/${index + 1}`,
    }));
    const batch = {
      candidates, observations: candidates.map(item => ({ url: item.url, state: 'open' as const, observedAt: before, reason: 'Open' })),
      collectedAt: before, warnings: [],
    };
    const saved = reconcileWork(initial(), batch, before);
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    const mock = await fixture(saved, request => request.op === 'work.collect' ? batch : undefined);
    await mock.queue.run();
    expect(mock.requests.filter(request => request.op === 'work.collect')).toHaveLength(1);
    expect(mock.saved().tasks).toHaveLength(101);
  });

  test('the completion watermark rolls back when its final durable save fails', async () => {
    const saved = initial();
    saved.work.lastCompletedAt = previousCompleted;
    saved.work.collectionCursor = before;
    const mock = await fixture(saved);
    mock.fail(state => state.work.lastCompletedAt !== previousCompleted);
    await mock.queue.run();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.workspace.state.work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.workspace.state.work.collectionCursor).toBe(before);
    expect(mock.queue.getSnapshot().error).toContain('Disk unavailable');
    mock.fail(() => false);
    await mock.workspace.retryStorage();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.saved().work.collectionCursor).toBe(before);
    expect(mock.saved().work.lastError).toContain('Disk unavailable');
  });
});

describe('conservative source coverage', () => {
  test('successful notification batches persist progress and neutral exclusions do not block the next batch', async () => {
    const saved = initial();
    saved.work.collectionCursor = before;
    saved.work.settings.streams = [notificationWorkstream(), defaultWorkState().settings.streams[1]!];
    let batches = 0;
    const cursors: Array<string | null> = [];
    const mock = await fixture(saved, request => {
      if (request.op !== 'work.collect' || request.input.stream.kind !== 'github-notifications') return;
      cursors.push(request.input.since);
      return {
        ...collection(), collectedAt: new Date().toISOString(),
        ...(batches++ === 0 ? { coveredThrough: previousCompleted } : {}),
        coverageInfo: ['Commit notifications are outside issue/PR discovery.'],
      };
    });
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(previousCompleted);
    expect(mock.saved().work.lastError).toBe('');
    expect(mock.queue.getSnapshot().warnings.join()).toContain('outside issue/PR');
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    await new WorkQueue(reloaded, mock.service).run();
    expect(cursors).toEqual([before, previousCompleted]);
    expect(mock.saved().work.collectionCursor).toBe(mock.saved().work.lastStartedAt);
    expect(mock.saved().tasks).toHaveLength(1);
  });

  test('multiple notification sources advance only through their earliest covered boundary', async () => {
    const saved = initial();
    saved.work.collectionCursor = before;
    saved.work.settings.streams = [notificationWorkstream(), notificationWorkstream()];
    const earlier = '2026-09-15T10:30:00.000Z';
    const mock = await fixture(saved, request => request.op === 'work.collect' ? {
      ...collection(), collectedAt: new Date().toISOString(),
      coveredThrough: request.input.stream.id === saved.work.settings.streams[0]!.id ? previousCompleted : earlier,
    } : undefined);
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(earlier);
  });

  test.each(['ranking', 'coverage', 'storage'] as const)('%s failures never advance a partial notification scan', async failure => {
    const saved = initial();
    saved.work.collectionCursor = before;
    saved.work.settings.streams = [notificationWorkstream()];
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') return {
        ...collection(), collectedAt: new Date().toISOString(), coveredThrough: previousCompleted,
        warnings: failure === 'coverage' ? ['One notification could not be inspected.'] : [],
      };
      if (request.op === 'work.rank' && failure === 'ranking') throw new Error('Ranking unavailable');
    });
    if (failure === 'storage') mock.fail(state => state.work.collectionCursor === previousCompleted);
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(before);
    expect(mock.workspace.state.work.collectionCursor).toBe(before);
    expect(mock.queue.getSnapshot().error).not.toBe('');
  });

  test.each([before, '2026-09-14T10:00:00.000Z', '2099-01-01T00:00:00.000Z'])('rejects nonprogressing or future scan boundary %s', async coveredThrough => {
    const saved = initial();
    saved.work.collectionCursor = before;
    saved.work.settings.streams = [notificationWorkstream()];
    const mock = await fixture(saved, request => request.op === 'work.collect'
      ? { ...collection(), collectedAt: new Date().toISOString(), coveredThrough } : undefined);
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(before);
    expect(mock.queue.getSnapshot().error).toContain('invalid scan boundary');
  });

  test.each(['slack', 'github-notifications'] as const)('%s activity during ranking survives reload using the successful run start cursor', async kind => {
    const saved = initial();
    saved.tasks.push({ id: 'manual', title: 'Rank this task', notes: '', status: 'open', createdAt: before });
    saved.work.settings.schedule.enabled = true;
    saved.work.settings.streams = [{
      ...defaultWorkState().settings.streams[0]!, kind, server: kind === 'slack' ? 'slack' : '', query: 'mentions:me',
    }];
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    const eventAt = '2026-09-15T10:01:00.000Z';
    const eventId = `${kind}:during-ranking`;
    let published = false;
    let rankingCalls = 0;
    const cursors: Array<string | null> = [];
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') {
        cursors.push(request.input.since);
        const newEvent = candidate(eventId, kind === 'slack' ? 'slack' : 'github');
        newEvent.evidence[0]!.at = eventAt;
        return collection(published && (!request.input.since || eventAt > request.input.since) ? [newEvent] : []);
      }
      if (request.op === 'work.rank' && rankingCalls++ === 0) {
        entered.resolve(request);
        return result.promise;
      }
    });

    const run = mock.queue.tick(new Date(before));
    const request = await entered.promise;
    published = true;
    result.resolve(ranked(request));
    await run;
    const firstCursor = mock.saved().work.collectionCursor;
    const completedAt = mock.saved().work.lastCompletedAt!;
    expect(Date.parse(completedAt)).toBeGreaterThan(Date.parse(eventAt));
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    await new WorkQueue(reloaded, mock.service).run();
    expect(mock.saved().tasks.some(task => task.work?.evidence.some(item => item.id === eventId))).toBe(true);
    expect(cursors).toEqual([null, before]);
    expect(firstCursor).toBe(before);
    expect(firstCursor).not.toBe(completedAt);
  });
});

describe('notification task controls', () => {
  const notification = { threadId: '123', reference: { repo: 'Owner/Repo', number: 42, kind: 'pr' as const }, updatedAt: before };
  function taskState() {
    const incoming = collection();
    incoming.candidates[0]!.notification = notification;
    const state = reconcileWork(initial(), incoming, before);
    state.tasks[0]!.notes = 'Private task notes';
    return state;
  }
  const confirmation = (request: Extract<Request, { op: 'github.unsubscribe' }>) => ({
    ...request.input, action: 'unsubscribe', status: 'confirmed', confirmedAt: previousCompleted,
  });

  test('enabling notifications preserves saved backlog searches and resets the successful scan boundary', async () => {
    const saved = initial();
    saved.work.settings.streams = [{
      ...defaultWorkState().settings.streams[1]!, name: 'Relay backlog', query: 'repo:sample/relay is:issue',
    }];
    saved.work.collectionCursor = before;
    const mock = await fixture(saved);
    mock.queue.saveSettings({
      ...mock.workspace.state.work.settings, streams: [...saved.work.settings.streams, notificationWorkstream()],
    });
    await mock.workspace.flush();
    expect(mock.saved().work.settings.streams[0]).toEqual(saved.work.settings.streams[0]);
    expect(mock.saved().work.settings.streams[1]!.kind).toBe('github-notifications');
    expect(mock.saved().work.collectionCursor).toBeNull();
    expect(mock.requests).toEqual([]);
    await mock.queue.run();
    expect(mock.requests.filter(request => request.op === 'work.collect').map(request => request.input.stream.kind))
      .toEqual(['github', 'github-notifications']);
  });

  test('unsubscribe persists intent before dispatch and never changes Done, notes, or evidence', async () => {
    const saved = taskState();
    const id = saved.tasks[0]!.id;
    const mock = await fixture(saved, request => {
      if (request.op !== 'github.unsubscribe') return;
      const task = mock.saved().tasks[0]!;
      expect(task.work!.unsubscribe).toMatchObject({ status: 'pending', operationId: request.input.operationId, notification });
      expect(request.input).toEqual({
        operationId: task.work!.unsubscribe!.operationId, threadId: '123', reference: notification.reference,
        notificationUpdatedAt: before, displayedEvidenceIds: [],
      });
      return confirmation(request);
    });
    mock.queue.complete(id);
    await mock.workspace.flush();
    const beforeWrite = structuredClone(mock.saved().tasks[0]!);
    await mock.queue.unsubscribe(id);
    const { unsubscribe, ...metadata } = mock.saved().tasks[0]!.work!;
    expect(metadata).toEqual(beforeWrite.work!);
    expect(unsubscribe).toMatchObject({ status: 'confirmed', confirmedAt: previousCompleted });
    expect(mock.saved().tasks[0]).toMatchObject({ status: 'done', completedAt: beforeWrite.completedAt, notes: 'Private task notes' });
    expect(mock.requests.map(request => request.op)).toEqual(['github.unsubscribe']);
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    expect(reloaded.state.tasks[0]!.work!.unsubscribe!.status).toBe('confirmed');
  });

  test('failed local intent storage prevents unsubscribe dispatch', async () => {
    const mock = await fixture(taskState());
    mock.fail(() => true);
    await expect(mock.queue.unsubscribe(mock.workspace.state.tasks[0]!.id)).rejects.toThrow('was not sent');
    expect(mock.requests).toEqual([]);
    expect(mock.workspace.state.tasks[0]!.work!.unsubscribe!.status).toBe('unconfirmed');
    expect(mock.queue.getSnapshot().unsubscribing).toEqual([]);
  });

  test('unconfirmed writes survive relaunch without replay and retry the original context', async () => {
    let fail = true;
    const mock = await fixture(taskState(), request => {
      if (request.op !== 'github.unsubscribe') return;
      if (fail) throw new Error('Connection lost after sending');
      return confirmation(request);
    });
    const id = mock.workspace.state.tasks[0]!.id;
    await expect(mock.queue.unsubscribe(id)).rejects.toThrow('not confirmed');
    const original = mock.requests[0]!;
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    const queue = new WorkQueue(reloaded, mock.service);
    await queue.tick();
    expect(mock.requests).toHaveLength(1);
    expect(reloaded.state.tasks[0]!.work!.unsubscribe!.status).toBe('unconfirmed');
    fail = false;
    await queue.unsubscribe(id);
    expect(mock.requests[1]!.input).toEqual(original.input);
    expect(mock.saved().tasks[0]!.work!.unsubscribe!.status).toBe('confirmed');
  });

  test('an interrupted pending intent is inspectable after relaunch without automatic replay', async () => {
    const saved = taskState();
    saved.tasks[0]!.work!.unsubscribe = { operationId: 'interrupted:1', notification, status: 'pending', error: '' };
    const mock = await fixture(saved, request => request.op === 'github.unsubscribe' ? confirmation(request) : undefined);
    await mock.queue.tick();
    expect(mock.requests).toEqual([]);
    expect(mock.queue.getSnapshot().unsubscribing).toEqual([]);
    expect(mock.saved().tasks[0]!.work!.unsubscribe!.status).toBe('pending');
    await mock.queue.unsubscribe(saved.tasks[0]!.id);
    const request = mock.requests[0]!;
    expect(request.op).toBe('github.unsubscribe');
    expect(request.input).toMatchObject({ operationId: 'interrupted:1', notificationUpdatedAt: before });
  });

  test('a failed confirmation save retains an explicit retry instead of reporting durable success', async () => {
    const mock = await fixture(taskState(), request => request.op === 'github.unsubscribe' ? confirmation(request) : undefined);
    mock.fail(state => state.tasks[0]!.work!.unsubscribe?.status === 'confirmed');
    await expect(mock.queue.unsubscribe(mock.workspace.state.tasks[0]!.id)).rejects.toThrow('not confirmed');
    expect(mock.saved().tasks[0]!.work!.unsubscribe!.status).toBe('pending');
    expect(mock.workspace.state.tasks[0]!.work!.unsubscribe!.status).toBe('unconfirmed');
    expect(mock.workspace.getSnapshot().persistence.error).toContain('Disk unavailable');
    mock.fail(() => false);
    await mock.workspace.retryStorage();
    expect(mock.saved().tasks[0]!.work!.unsubscribe!.status).toBe('unconfirmed');
    expect(mock.saved().tasks[0]!.work!.unsubscribe!.error).toContain('Disk unavailable');
    expect(mock.requests).toHaveLength(1);
  });

  test.each(['threadId', 'operationId', 'notificationUpdatedAt', 'reference', 'displayedEvidenceIds', 'action'] as const)(
    'mismatched %s never confirms an unsubscribe', async field => {
      const mock = await fixture(taskState(), request => {
        if (request.op !== 'github.unsubscribe') return;
        return {
          ...confirmation(request),
          [field]: field === 'reference' ? { ...notification.reference, number: 99 }
            : field === 'displayedEvidenceIds' ? ['unexpected']
            : field === 'notificationUpdatedAt' ? previousCompleted : field === 'action' ? 'acknowledge' : '999',
        };
      });
      await expect(mock.queue.unsubscribe(mock.workspace.state.tasks[0]!.id)).rejects.toThrow('mismatched');
      expect(mock.saved().tasks[0]!.work!.unsubscribe!.status).toBe('unconfirmed');
    },
  );

  test('one in-flight unsubscribe covers consolidated actions and preserves concurrent Done', async () => {
    const saved = taskState();
    saved.tasks.push({
      ...structuredClone(saved.tasks[0]!), id: 'reply-task',
      work: { ...saved.tasks[0]!.work!, action: 'reply', identity: `reply:${saved.tasks[0]!.work!.url}` },
    });
    const entered = deferred<Extract<Request, { op: 'github.unsubscribe' }>>();
    const result = deferred<unknown>();
    const mock = await fixture(saved, request => {
      if (request.op !== 'github.unsubscribe') return;
      entered.resolve(request);
      return result.promise;
    });
    expect(mock.workspace.state.tasks).toHaveLength(1);
    const id = mock.workspace.state.tasks[0]!.id;
    const pending = mock.queue.unsubscribe(id);
    const request = await entered.promise;
    await expect(mock.queue.unsubscribe(id)).rejects.toThrow('already in progress');
    expect(() => mock.queue.createProfile('On call')).toThrow('unsubscribe');
    expect(() => mock.queue.switchProfile('default')).toThrow('unsubscribe');
    mock.queue.complete(id);
    mock.queue.edit(id, 'Edited during unsubscribe', 'Keep this note');
    result.resolve(confirmation(request));
    await pending;
    expect(mock.saved().tasks.every(task => task.work!.unsubscribe!.status === 'confirmed')).toBe(true);
    expect(mock.saved().tasks[0]).toMatchObject({ status: 'done', title: 'Edited during unsubscribe', notes: 'Keep this note' });
    expect(mock.requests).toHaveLength(1);
  });
});

describe('conservative source coverage', () => {
  test('pre-cursor saves rescan safely rather than treating a past completion as source coverage', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    saved.work.lastCompletedAt = previousCompleted;
    const { collectionCursor: _cursor, ...oldWork } = saved.work;
    const mock = await fixture({ ...saved, work: oldWork }, request => {
      if (request.op === 'work.collect') expect(request.input.since).toBeNull();
    });
    expect(mock.saved().work.collectionCursor).toBeNull();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(mock.saved().work.lastStartedAt);
  });

  test.each(['query', 'new-stream', 'model'] as const)('%s changes reset source coverage but ranking and cadence changes do not', async change => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    saved.work.collectionCursor = before;
    saved.work.lastCompletedAt = previousCompleted;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') expect(request.input.since).toBeNull();
    });
    mock.queue.saveSettings({
      ...mock.workspace.state.work.settings, instructions: 'Different ranking priorities',
      schedule: { enabled: true, everyMinutes: 60 },
    });
    expect(mock.workspace.state.work.collectionCursor).toBe(before);
    const settings = structuredClone(mock.workspace.state.work.settings);
    if (change === 'query') settings.streams[0]!.query = 'is:pr author:@me';
    if (change === 'new-stream') settings.streams.push(defaultWorkState().settings.streams[1]!);
    if (change === 'model') settings.model = 'new-collector-model';
    mock.queue.saveSettings(settings);
    await mock.workspace.flush();
    expect(mock.saved().work.collectionCursor).toBeNull();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    await mock.queue.run();
    expect(mock.saved().work.collectionCursor).toBe(mock.saved().work.lastStartedAt);
    expect(mock.queue.getSnapshot().error).toBe('');
  });

  test('an in-flight run cannot advance coverage for newly enabled sources', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    saved.work.collectionCursor = before;
    saved.work.lastCompletedAt = previousCompleted;
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    let rankingCalls = 0;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.rank' && rankingCalls++ === 0) {
        entered.resolve(request);
        return result.promise;
      }
    });
    const run = mock.queue.run();
    const request = await entered.promise;
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, streams: defaultWorkState().settings.streams });
    result.resolve(ranked(request));
    await run;
    expect(mock.saved().work.collectionCursor).toBeNull();
    expect(mock.saved().work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.queue.getSnapshot().error).toContain('Source settings changed');
    const boundary = mock.requests.length;
    await mock.queue.run();
    const collections = mock.requests.slice(boundary).filter(request => request.op === 'work.collect');
    expect(collections).toHaveLength(2);
    expect(collections.every(request => request.input.since === null)).toBe(true);
    expect(mock.saved().work.collectionCursor).toBe(mock.saved().work.lastStartedAt);
  });

  test('failed completion persistence cannot restore old coverage over a concurrent source change', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    saved.work.collectionCursor = before;
    saved.work.lastCompletedAt = previousCompleted;
    const mock = await fixture(saved);
    const saving = deferred<void>();
    const release = deferred<void>();
    mock.onSave(async state => {
      if (!state.work.collectionCursor || state.work.collectionCursor === before) return;
      saving.resolve();
      await release.promise;
      throw { code: 'storage-unavailable', retryable: true, message: 'Disk unavailable' };
    });
    const run = mock.queue.run();
    await saving.promise;
    const settings = structuredClone(mock.workspace.state.work.settings);
    settings.streams[0]!.query = 'is:issue author:@me';
    mock.queue.saveSettings(settings);
    release.resolve();
    await run;
    expect(mock.workspace.state.work.collectionCursor).toBeNull();
    expect(mock.workspace.state.work.lastCompletedAt).toBe(previousCompleted);
    expect(mock.queue.getSnapshot().error).toContain('Disk unavailable');
    mock.onSave();
    await mock.workspace.retryStorage();
    expect(mock.saved().work.collectionCursor).toBeNull();
    expect(mock.saved().work.settings.streams[0]!.query).toBe('is:issue author:@me');
  });
});

describe('intake acknowledgement', () => {
  test('duplicate intake is stable across lost ACK, completion and relaunch; ACK follows durable save', async () => {
    let failedAck = false;
    let mock!: Awaited<ReturnType<typeof fixture>>;
    mock = await fixture(initial(), request => {
      if (request.op === 'work.intake') {
        const item = { id: 'intake:1', candidate: candidate('copilot:result:1', 'copilot') };
        return { items: [item, item], hasMore: false };
      }
      if (request.op === 'work.ackIntake') {
        expect(mock.saved().tasks).toHaveLength(1);
        expect(request.input.ids).toEqual(['intake:1']);
        if (!failedAck) { failedAck = true; throw new Error('ACK response lost'); }
      }
    });
    await mock.queue.run();
    expect(mock.queue.getSnapshot().error).toContain('ACK response lost');
    expect(mock.saved().work.lastCompletedAt).toBeNull();
    mock.queue.complete(mock.workspace.state.tasks[0]!.id);
    await mock.workspace.flush();
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    const queue = new WorkQueue(reloaded, mock.service);
    await queue.run();
    expect(mock.saved().tasks).toHaveLength(1);
    expect(mock.saved().tasks[0]!.status).toBe('done');
    expect(mock.saved().tasks[0]!.work!.handledEvidenceIds).toEqual(['copilot:result:1']);
    expect(queue.getSnapshot().error).toBe('');
  });

  test('discovery storage failure never acknowledges intake or dispatches further collection', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams;
    const mock = await fixture(saved, request => {
      if (request.op === 'work.intake') return { items: [{ id: 'pending', candidate: candidate('copilot:1', 'copilot') }], hasMore: false };
    });
    mock.fail(state => state.tasks.length > 0);
    await mock.queue.run();
    expect(mock.requests.map(request => request.op)).toEqual(['work.intake']);
    expect(mock.saved().tasks).toEqual([]);
    expect(mock.workspace.state.tasks).toHaveLength(1);
    expect(mock.queue.getSnapshot().error).toContain('Disk unavailable');
  });

  test('intake drains acknowledged pages and does not spin when the reader stops advancing', async () => {
    let reads = 0;
    const mock = await fixture(initial(), request => {
      if (request.op === 'work.intake') {
        reads += 1;
        const item = { id: 'stuck', candidate: candidate('copilot:1', 'copilot') };
        return { items: [item], hasMore: true };
      }
    });
    await mock.queue.run();
    expect(reads).toBe(2);
    expect(mock.requests.filter(request => request.op === 'work.ackIntake')).toHaveLength(1);
    expect(mock.saved().tasks).toHaveLength(1);
    expect(mock.saved().work.lastCompletedAt).toBeNull();
    expect(mock.queue.getSnapshot().error).toContain('did not advance');
  });

  test('intake persists and acknowledges each page before consuming the next', async () => {
    let reads = 0;
    let acknowledged = 0;
    let mock!: Awaited<ReturnType<typeof fixture>>;
    mock = await fixture(initial(), request => {
      if (request.op === 'work.intake') {
        expect(acknowledged).toBe(reads);
        reads += 1;
        return {
          items: [{ id: `intake:${reads}`, candidate: { ...candidate(`copilot:${reads}`, 'copilot'), url: `https://github.com/owner/repo/pull/${reads}` } }],
          hasMore: reads === 1,
        };
      }
      if (request.op === 'work.ackIntake') {
        acknowledged += 1;
        expect(mock.saved().tasks).toHaveLength(acknowledged);
      }
    });
    await mock.queue.run();
    expect(reads).toBe(2);
    expect(acknowledged).toBe(2);
    expect(mock.saved().work.ranking?.orderedIds).toHaveLength(2);
    expect(mock.queue.getSnapshot().error).toBe('');
  });
});

describe('concurrency and exact ranking', () => {
  test.each([false, true])('source context changes invalidate in-flight reasons while timestamps alone do not: %s', async changed => {
    const incoming = collection();
    const context = { revision: 'a'.repeat(64), title: 'Source title', body: 'Body', labels: [] };
    incoming.observations[0]!.context = context;
    const saved = reconcileWork(initial(), incoming, before);
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    const mock = await fixture(saved, request => {
      if (request.op === 'work.rank') { entered.resolve(request); return result.promise; }
    });
    const run = mock.queue.run();
    const request = await entered.promise;
    mock.workspace.update(current => reconcileWork(current, {
      candidates: [], observations: [{
        url, state: 'open', observedAt: previousCompleted, reason: 'Open source',
        context: changed ? { ...context, body: 'Changed source body', revision: 'b'.repeat(64) } : context,
      }], warnings: [], collectedAt: previousCompleted,
    }, previousCompleted));
    result.resolve({ ...ranked(request), evaluatedAt: before, expiresAt: previousCompleted });
    await run;
    expect(mock.saved().work.ranking!.orderedIds).toEqual(changed ? [] : [saved.tasks[0]!.id]);
    expect(mock.saved().work.ranking!.rankedAt).toBe(before);
    expect(mock.saved().work.ranking!.expiresAt).toBe(previousCompleted);
    expect(mock.queue.getSnapshot().warnings.length).toBe(changed ? 1 : 0);
  });

  test('collection merges into latest Done, capture and settings without reopening old evidence', async () => {
    const saved = reconcileWork(initial(), collection(), before);
    saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
    const entered = deferred<void>();
    const result = deferred<WorkCollection>();
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') { entered.resolve(); return result.promise; }
    });
    const run = mock.queue.run();
    await entered.promise;
    mock.queue.complete(mock.workspace.state.tasks[0]!.id);
    mock.queue.capture('Captured during scan');
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, schedule: { enabled: true, everyMinutes: 60 } });
    result.resolve(collection());
    await run;
    expect(mock.saved().tasks[0]!.status).toBe('done');
    expect(mock.saved().tasks[1]!.title).toBe('Captured during scan');
    expect(mock.saved().work.settings.schedule).toEqual({ enabled: true, everyMinutes: 60 });
    expect(mock.saved().work.ranking?.orderedIds).toEqual([mock.saved().tasks[1]!.id]);
  });

  test('rank results rebase around concurrent Done, edits and captures without stale reasons', async () => {
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    const mock = await fixture(initial(), request => {
      if (request.op === 'work.rank') { entered.resolve(request); return result.promise; }
    });
    mock.queue.capture('Done while ranking');
    mock.queue.capture('Edited while ranking');
    mock.queue.capture('Unchanged');
    const [done, edited, unchanged] = mock.workspace.state.tasks;
    const run = mock.queue.run();
    const request = await entered.promise;
    mock.queue.complete(done!.id);
    mock.queue.edit(edited!.id, 'Changed during ranking', 'New task note');
    mock.queue.capture('Brand-new capture');
    result.resolve(ranked(request));
    await run;
    expect(mock.saved().work.ranking?.orderedIds).toEqual([unchanged!.id]);
    expect(mock.saved().work.ranking?.reasons.map(reason => reason.id)).toEqual([unchanged!.id]);
    expect(mock.queue.getSnapshot().warnings.join()).toContain('2 new or edited tasks are unranked');
    expect(rankedTasks(mock.saved()).map(task => task.title)).toEqual(['Unchanged', 'Changed during ranking', 'Brand-new capture']);
  });

  test.each(['missing', 'duplicate', 'invented', 'missing-reason', 'duplicate-reason', 'invented-reason', 'blank-reason'] as const)(
    '%s ranking is rejected without replacing the previous complete order', async kind => {
      const saved = initial();
      saved.tasks = ['a', 'b'].map(id => ({ id, title: id, notes: '', status: 'open' as const, createdAt: before }));
      saved.work.ranking = { orderedIds: ['a', 'b'], reasons: [{ id: 'a', reason: 'Prior A' }, { id: 'b', reason: 'Prior B' }], rankedAt: before };
      const mock = await fixture(saved, request => {
        if (request.op !== 'work.rank') return;
        const value = ranked(request);
        if (kind === 'missing') value.orderedIds.pop();
        if (kind === 'duplicate') value.orderedIds = ['a', 'a'];
        if (kind === 'invented') value.orderedIds = ['a', 'fabricated'];
        if (kind === 'missing-reason') value.reasons.pop();
        if (kind === 'duplicate-reason') value.reasons = [value.reasons[0]!, value.reasons[0]!];
        if (kind === 'invented-reason') value.reasons[0]!.id = 'fabricated';
        if (kind === 'blank-reason') value.reasons[0]!.reason = '   ';
        return value;
      });
      await mock.queue.run();
      expect(mock.saved().work.ranking).toEqual(saved.work.ranking);
      expect(mock.saved().work.lastCompletedAt).toBeNull();
      expect(mock.queue.getSnapshot().error).toContain(kind === 'blank-reason' ? 'invalid result' : 'every submitted task ID');
    },
  );

  test('owner ranking settings changed during SDK work are retained and invalidate the result', async () => {
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    const mock = await fixture(initial(), request => {
      if (request.op === 'work.rank') { entered.resolve(request); return result.promise; }
    });
    mock.queue.capture('Task');
    const run = mock.queue.run();
    const request = await entered.promise;
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings,
      agents: taskAgents(mock.workspace.state.work.settings).map(agent => agent.jobType === 'task-prioritization'
        ? { ...agent, instructions: 'New priorities', model: 'new-model' } : agent),
    });
    result.resolve(ranked(request));
    await run;
    expect(mock.saved().work.settings.agents?.find(agent => agent.jobType === 'task-prioritization'))
      .toMatchObject({ instructions: 'New priorities', model: 'new-model' });
    expect(mock.saved().work.ranking).toBeNull();
    expect(mock.queue.getSnapshot().error).toContain('settings changed');
    expect(mock.saved().work.lastCompletedAt).toBeNull();
  });

  test('manual and scheduled runs never overlap, even during reentrant subscriber updates', async () => {
    const entered = deferred<void>();
    const result = deferred<unknown>();
    const mock = await fixture(initial(), request => {
      if (request.op === 'work.intake') { entered.resolve(); return result.promise; }
    });
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, schedule: { enabled: true, everyMinutes: 30 } });
    let reentered = false;
    const unsubscribe = mock.queue.subscribe(() => {
      if (mock.queue.getSnapshot().running && !reentered) { reentered = true; void mock.queue.run(); }
    });
    const run = mock.queue.run();
    await entered.promise;
    const duplicate = mock.queue.run();
    await mock.queue.tick(new Date(Date.now() + 60 * 60_000));
    expect(mock.requests.filter(request => request.op === 'work.intake')).toHaveLength(1);
    result.resolve({ items: [], hasMore: false });
    await Promise.all([run, duplicate]);
    unsubscribe();
    expect(mock.queue.getSnapshot().running).toBe(false);
  });

  test('scheduling is opt-in, uses one catchup and durable starts throttle failed scans after relaunch', async () => {
    const saved = initial();
    const mock = await fixture(saved, request => {
      if (request.op === 'work.intake') throw new Error('Offline');
    });
    const now = new Date();
    await mock.queue.tick(now);
    expect(mock.requests).toEqual([]);
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, schedule: { enabled: true, everyMinutes: 30 } });
    await mock.queue.tick(now);
    expect(mock.requests).toHaveLength(1);
    expect(mock.saved().work.lastStartedAt).toBe(now.toISOString());
    expect(mock.saved().work.lastCompletedAt).toBeNull();
    const reloaded = new DesktopWorkspace(mock.platform);
    await reloaded.load();
    const queue = new WorkQueue(reloaded, mock.service);
    await queue.tick(new Date(now.getTime() + 29 * 60_000));
    expect(mock.requests).toHaveLength(1);
    await queue.tick(new Date(now.getTime() + 5 * 24 * 60 * 60_000));
    expect(mock.requests).toHaveLength(2);
    await queue.tick(new Date(now.getTime() + 5 * 24 * 60 * 60_000));
    expect(mock.requests).toHaveLength(2);
  });
});


describe('collection progress', () => {
  test.each(['collected', 'manual', 'empty'] as const)('publishes monotonic assessment/order phases for a %s queue', async kind => {
    const saved = initial();
    if (kind === 'collected') saved.work.settings.streams = [defaultWorkState().settings.streams[0]!];
    if (kind === 'manual') saved.tasks = [{ id: 'manual', title: 'Local task', notes: '', status: 'open', createdAt: before }];
    const mock = await fixture(saved, request => request.op === 'work.collect'
      ? { ...collection(), coverageInfo: ['Older history remains'] } : undefined);
    const phases: string[] = [];
    const unsubscribe = mock.queue.subscribe(() => {
      const phase = mock.queue.getSnapshot().phase;
      if (phases.at(-1) !== phase) phases.push(phase);
    });
    await mock.queue.run();
    unsubscribe();
    expect(phases).toEqual([
      'preparing', 'intake',
      ...(kind === 'collected' ? ['collecting'] : []),
      ...(kind !== 'empty' ? ['assessing'] : []),
      'ranking', 'saving', 'idle',
    ]);
    expect(mock.requests.filter(request => request.op === 'work.assess' || request.op === 'work.rank')
      .map(request => request.op)).toEqual(kind === 'empty' ? [] : ['work.assess', 'work.rank']);
    if (kind === 'collected') expect(mock.queue.getSnapshot().warnings).toEqual([
      `${saved.work.settings.streams[0]!.name}: Older history remains`,
    ]);
  });

  test('tracks a frozen enabled-source checklist through intake, failures, ranking and saving', async () => {
    const saved = initial();
    const template = defaultWorkState().settings.streams[0]!;
    saved.work.settings.streams = ['First', 'Limited', 'Failed', 'Last', 'Disabled']
      .map((name, index) => ({ ...template, id: `source-${index}`, name, enabled: name !== 'Disabled' }));
    const intake = deferred<void>();
    const intakeEntered = deferred<void>();
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const entered = Array.from({ length: 4 }, () => deferred<void>());
    const ranking = deferred<void>();
    const rankingEntered = deferred<void>();
    let retry = false;
    const mock = await fixture(saved, async request => {
      if (retry) return;
      if (request.op === 'work.intake') { intakeEntered.resolve(); await intake.promise; }
      if (request.op === 'work.collect') {
        const index = Number(request.input.stream.id.split('-')[1]);
        entered[index]!.resolve();
        await gates[index]!.promise;
        if (index === 2) throw new Error('Authentication expired');
        if (index === 1) return { ...collection(), warnings: ['A page failed', 'A page failed'] };
        return { ...collection(), coverageInfo: ['Older history remains'] };
      }
      if (request.op === 'work.rank') { rankingEntered.resolve(); await ranking.promise; }
    });
    const run = mock.queue.run();
    const start = mock.queue.getSnapshot();
    expect(start).toMatchObject({ running: true, phase: 'preparing', progress: { finishedAt: null } });
    expect(start.progress?.sources.map(source => source.state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    await intakeEntered.promise;
    expect(mock.queue.getSnapshot().phase).toBe('intake');
    intake.resolve();
    await entered[0]!.promise;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['collecting', 'waiting', 'waiting', 'waiting']);
    gates[0]!.resolve();
    await entered[1]!.promise;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done', 'collecting', 'waiting', 'waiting']);
    gates[1]!.resolve();
    await entered[2]!.promise;
    expect(mock.queue.getSnapshot().progress?.sources[1]).toMatchObject({ state: 'failed', diagnostics: ['Limited: A page failed'] });
    gates[2]!.resolve();
    await entered[3]!.promise;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done', 'failed', 'failed', 'collecting']);
    gates[3]!.resolve();
    await rankingEntered.promise;
    expect(mock.queue.getSnapshot()).toMatchObject({ running: true, phase: 'ranking', progress: { finishedAt: null } });
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done', 'failed', 'failed', 'done']);
    expect(start.progress?.sources.every(source => source.state === 'waiting')).toBe(true);
    const saving = deferred<void>();
    const savingEntered = deferred<void>();
    mock.onSave(async () => { savingEntered.resolve(); await saving.promise; });
    ranking.resolve();
    await savingEntered.promise;
    expect(mock.queue.getSnapshot()).toMatchObject({ running: true, phase: 'saving', progress: { finishedAt: null } });
    saving.resolve();
    await run;
    expect(mock.queue.getSnapshot()).toMatchObject({ running: false, phase: 'error' });
    expect(mock.queue.getSnapshot().progress?.finishedAt).toBeNumber();
    expect(mock.queue.getSnapshot().progress?.sources[2]?.diagnostics).toEqual(['Failed: Authentication expired']);
    mock.onSave();
    retry = true;
    const rerun = mock.queue.run();
    expect(mock.queue.getSnapshot().progress?.sources.every(source => source.state === 'waiting' && !source.diagnostics.length)).toBe(true);
    expect(mock.queue.getSnapshot().error).toBe('');
    await rerun;
    expect(mock.queue.getSnapshot().phase).toBe('idle');
    mock.queue.createProfile('Separate');
    expect(mock.queue.getSnapshot().progress).toBeNull();
    mock.queue.switchProfile('default');
    expect(mock.queue.getSnapshot().progress).toBeNull();
    await mock.workspace.flush();
  });

  test('collection storage failure leaves the active source failed and untouched sources not run', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams;
    const mock = await fixture(saved);
    const saving = deferred<void>();
    const entered = deferred<void>();
    mock.onSave(async state => {
      if (state.tasks.length) { entered.resolve(); await saving.promise; }
    });
    mock.fail(state => state.tasks.length > 0);
    const run = mock.queue.run();
    await entered.promise;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['collecting', 'waiting']);
    saving.resolve();
    await run;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['failed', 'not-run']);
    expect(mock.queue.getSnapshot().progress?.sources[0]?.diagnostics.join()).toContain('Disk unavailable');
    expect(mock.queue.getSnapshot().progress?.sources[0]?.diagnostics).toEqual([mock.queue.getSnapshot().error]);
    expect(mock.requests.filter(request => request.op === 'work.collect')).toHaveLength(1);
    expect(mock.requests.some(request => request.op === 'work.rank')).toBe(false);
  });

  test('scheduled runs snapshot sources before the initial save and keep the denominator fixed', async () => {
    const saved = initial();
    saved.work.settings.streams = defaultWorkState().settings.streams;
    saved.work.settings.schedule.enabled = true;
    const mock = await fixture(saved);
    const saving = deferred<void>();
    const entered = deferred<void>();
    mock.onSave(async () => { entered.resolve(); await saving.promise; });
    const run = mock.queue.tick(new Date());
    await entered.promise;
    expect(mock.queue.getSnapshot().progress?.sources).toHaveLength(2);
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, streams: [] });
    saving.resolve();
    await run;
    expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done', 'done']);
    expect(mock.requests.filter(request => request.op === 'work.collect')).toHaveLength(2);
    expect(mock.queue.getSnapshot().error).toContain('Source settings changed');
    expect(mock.saved().work.collectionCursor).toBeNull();
  });
});


test('start and final save failures never imply a completed run', async () => {
  const saved = initial();
  saved.work.settings.streams = defaultWorkState().settings.streams.slice(0, 1);
  const mock = await fixture(saved);
  mock.fail(() => true);
  await mock.queue.run();
  expect(mock.queue.getSnapshot()).toMatchObject({ running: false, phase: 'error' });
  expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['not-run']);
  expect(mock.requests).toEqual([]);
  mock.fail(() => false);
  await mock.workspace.retryStorage();
  mock.fail(state => state.work.lastCompletedAt !== null);
  await mock.queue.run();
  expect(mock.queue.getSnapshot()).toMatchObject({ running: false, phase: 'error' });
  expect(mock.queue.getSnapshot().progress?.sources.map(source => source.state)).toEqual(['done']);
  expect(mock.saved().work.lastCompletedAt).toBeNull();
  expect(mock.queue.getSnapshot().error).toContain('Disk unavailable');
});
