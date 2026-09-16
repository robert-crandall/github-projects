import { describe, expect, test } from 'bun:test';
import { defaultWorkState, type WorkCandidate, type WorkCollection } from '../../service/src/work-schema.ts';
import type { Request } from '../../service/src/schema.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { legacyFixture } from '../domain/test-fixtures.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient } from '../platform/service.ts';
import { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { AppState } from '../types.ts';
import { WorkQueue } from './controller.ts';
import { rankedTasks, reconcileWork } from './engine.ts';

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
  const platform = createNativePlatform(async (command, args) => {
    log.push(command);
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: before, timeZone: 'UTC', error: null };
    if (command === 'workspace_create_backup') return { id: crypto.randomUUID(), createdAt: before };
    if (command === 'workspace_save') {
      const snapshot = snapshotSchema.parse(args?.snapshot);
      const next = snapshot.workspace.state as unknown as AppState;
      if (saveHook) await saveHook(next);
      if (failSave(next)) throw { code: 'storage-unavailable', retryable: true, message: 'Disk unavailable' };
      expect(args?.expectedRevision).toBe(saved.revision);
      saved = { revision: crypto.randomUUID(), savedAt: new Date().toISOString(), snapshot };
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
    queue, workspace, platform, service, requests, log,
    fail: (predicate: (state: AppState) => boolean) => { failSave = predicate; },
    onSave: (hook?: (state: AppState) => Promise<void>) => { saveHook = hook; },
    saved: () => saved.snapshot!.workspace.state as unknown as AppState,
  };
}

describe('durable local work', () => {
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

describe('runs and persistence barriers', () => {
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
        expect(request.input.tasks[0]!.notes).toContain('Source availability: unknown. State check was unavailable.');
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
      checked.push(request.input.knownUrls);
      return {
        candidates: [], warnings: [], collectedAt: new Date().toISOString(),
        observations: request.input.knownUrls.map(url => ({ url, state: 'queued', observedAt: new Date().toISOString(), reason: 'Queued' })),
      };
    });
    await mock.queue.run();
    expect(checked.map(page => page.length)).toEqual([100, 1]);
    expect(new Set(checked.flat()).size).toBe(101);
    expect(mock.saved().tasks).toHaveLength(101);
    expect(rankedTasks(mock.saved())).toEqual([]);
    expect(mock.queue.getSnapshot().error).toBe('');
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
  test('an event arriving during ranking is collected after reload using the successful run start cursor', async () => {
    const saved = initial();
    saved.tasks.push({ id: 'manual', title: 'Rank this task', notes: '', status: 'open', createdAt: before });
    saved.work.settings.schedule.enabled = true;
    saved.work.settings.streams = [{
      ...defaultWorkState().settings.streams[0]!, kind: 'slack', server: 'slack', query: 'mentions:me',
    }];
    const entered = deferred<Extract<Request, { op: 'work.rank' }>>();
    const result = deferred<unknown>();
    const eventAt = '2026-09-15T10:01:00.000Z';
    let published = false;
    let rankingCalls = 0;
    const cursors: Array<string | null> = [];
    const mock = await fixture(saved, request => {
      if (request.op === 'work.collect') {
        cursors.push(request.input.since);
        const newEvent = candidate('slack:during-ranking', 'slack');
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
    expect(mock.saved().tasks.some(task => task.work?.evidence.some(item => item.id === 'slack:during-ranking'))).toBe(true);
    expect(cursors).toEqual([null, before]);
    expect(firstCursor).toBe(before);
    expect(firstCursor).not.toBe(completedAt);
  });

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
    mock.queue.saveSettings({ ...mock.workspace.state.work.settings, instructions: 'New priorities', model: 'new-model' });
    result.resolve(ranked(request));
    await run;
    expect(mock.saved().work.settings.instructions).toBe('New priorities');
    expect(mock.saved().work.settings.model).toBe('new-model');
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
