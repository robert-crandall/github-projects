import { expect, setSystemTime, test } from 'bun:test';
import { LIMITS, type Request, type Thread as SourceThread } from '../../service/src/schema.ts';
import { mergeRefresh } from '../domain/live.ts';
import { migrateWorkspace } from '../domain/migration.ts';
import { legacyFixture } from '../domain/test-fixtures.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient, type ServiceTransport } from '../platform/service.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { getRow, getRows } from '../domain/engine.ts';
import { ServiceWorkspace, sourceThread } from './service-workspace.ts';

const evidence = (id = 'request-1', kind: 'review-request' | 'comment' | 'merge-queue' = 'review-request') => ({
  id, kind, at: '2026-09-11T17:00:00Z', actor: 'octocat', text: 'Please review these changes.',
  recipient: { kind: 'user' as const, login: 'viewer', isViewer: true },
  requestState: kind === 'review-request' ? 'current' as const : 'not-request' as const, textTruncated: false,
});
const thread = (events = [evidence()]): SourceThread => ({
  id: '123', reference: { repo: 'octo/project', number: 1, kind: 'pr' }, title: 'Review source',
  reason: 'review_requested', notification: 'unread', updatedAt: '2026-09-11T17:00:00Z', lastReadAt: null,
  state: 'open', size: { additions: 20, deletions: 2, changedFiles: 1 }, subscription: 'subscribed',
  sourceState: { state: 'open', observedAt: new Date().toISOString(), updatedAt: '2026-09-11T17:00:00Z', error: null },
  evidence: events, coverage: { timeline: 'complete', newestPage: 1, fetchedPages: [1], observedAt: '2026-09-11T17:00:00Z' },
});
const batch = (threads = [thread()]) => ({
  batchId: crypto.randomUUID(), fetchedAt: new Date().toISOString(), viewer: 'viewer',
  status: 'complete', threads, diagnostics: [],
  coverage: { notifications: 'complete', pages: 1, received: threads.length, returned: threads.length, missingMeansDone: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function harness(handler: ServiceTransport, snapshot: NativeWorkspace['snapshot'] = null) {
  let saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot, savedAt: null };
  let failSave = false;
  let blockedSave: ReturnType<typeof deferred<void>> | undefined;
  const requests: Request[] = [];
  const backups: NativeWorkspace[] = [];
  const platform = createNativePlatform(async (command, args) => {
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: new Date().toISOString(), timeZone: 'UTC', error: null };
    if (command === 'workspace_create_backup') {
      expect(args?.expectedRevision).toBe(saved.revision);
      backups.push(structuredClone(saved));
      return { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    }
    if (command === 'workspace_save') {
      if (blockedSave) await blockedSave.promise;
      if (failSave) throw { code: 'io', message: 'Test storage failure', retryable: true };
      expect(args?.expectedRevision).toBe(saved.revision);
      saved = { revision: crypto.randomUUID(), snapshot: snapshotSchema.parse(args?.snapshot), savedAt: new Date().toISOString() };
      return structuredClone(saved);
    }
    throw new Error(`Unexpected native request ${command}`);
  });
  const workspace = new DesktopWorkspace(platform);
  await workspace.load(); await workspace.flush();
  const client = new ServiceClient(async request => { requests.push(request); return handler(request); });
  const remote = new ServiceWorkspace(workspace, client);
  return { workspace, remote, client, requests, backups, saved: () => saved, failSave: () => { failSave = true; },
    blockSave: () => { blockedSave = deferred<void>(); return blockedSave; }, platform };
}
const reply = (request: Request, result: unknown) => ({ v: 1, id: request.id, ok: true, result });
function loadSource(workspace: DesktopWorkspace, source = thread()) {
  workspace.update(state => mergeRefresh(state, { threads: [sourceThread(source, [])], startedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), status: 'complete', diagnostics: [] }));
}

const placeholderId = 'capture:octo/project:1';
function legacyCapture() {
  const legacy = legacyFixture(true);
  const previousId = legacy.threads[0]!.id;
  legacy.threads[0] = { ...sourceThread(thread(), []), id: placeholderId, events: [] };
  legacy.actions = legacy.actions.map(action => action.threadId === previousId
    ? { ...action, threadId: placeholderId, eventIds: [], interpretation: 'supported' } : action);
  legacy.selectedKey = 'a:captured';
  return legacy;
}

test('migrated capture placeholders reject writes before intent and stay readable after promotion', async () => {
  const snapshot = snapshotSchema.parse({
    formatVersion: 1, workspace: { version: 1, state: legacyCapture(), scroll: {} }, reminders: [],
  });
  const mock = await harness(async request => {
    expect(request.op).toBe('github.refresh');
    return reply(request, batch());
  }, snapshot);
  expect(mock.backups[0]!.snapshot).toEqual(snapshot);
  const tasks = structuredClone(mock.workspace.state.tasks);
  const notes = structuredClone(mock.workspace.state.notes);
  mock.workspace.dispatch({ type: 'view', view: 'inbox' });
  mock.workspace.dispatch({ type: 'select', key: `t:${placeholderId}` });
  await mock.workspace.flush();
  const saved = structuredClone(mock.saved());
  const row = getRow(mock.workspace.state, `t:${placeholderId}`)!;
  for (const action of ['done', 'unsubscribe'] as const) {
    await expect(mock.remote.write({ row, kind: 'notification', action })).rejects.toThrow();
    expect(mock.workspace.state.operations).toEqual([]);
  }
  await mock.workspace.flush();
  expect(mock.saved()).toEqual(saved);
  expect(mock.requests).toEqual([]);
  await mock.remote.refresh();
  await mock.workspace.flush();
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(relaunched.getSnapshot().loadError).toBe('');
  await relaunched.flush();
  expect(relaunched.state.selectedKey).toBe('t:123');
  expect(relaunched.state.operations).toEqual([]);
  expect(relaunched.state.tasks).toEqual(tasks.map(task => task.threadId === placeholderId ? { ...task, threadId: '123' } : task));
  expect(relaunched.state.notes).toEqual(notes.map(note => note.threadId === placeholderId ? { ...note, threadId: '123' } : note));
  expect(getRow(relaunched.state, 'a:routine')!.task!.notes).toBe('Routine notes');
  expect(mock.requests.map(request => request.op)).toEqual(['github.refresh']);
});

test('promotion preserves existing failed operation context across save and relaunch without replay', async () => {
  const state = migrateWorkspace(legacyCapture());
  state.operations.push({
    id: 'previous-invalid-write', threadId: placeholderId, action: 'done', eventIds: [],
    startedAt: state.clock, status: 'failed', message: 'Invalid notification identity',
  });
  const mock = await harness(async request => {
    expect(request.op).toBe('github.refresh');
    return reply(request, batch());
  }, snapshotSchema.parse(JSON.parse(JSON.stringify({ formatVersion: 1, workspace: { version: 1, state, scroll: {} }, reminders: [] }))));
  const original = structuredClone(mock.workspace.state.operations[0]!);
  await expect(mock.remote.write({
    row: getRow(mock.workspace.state, `t:${placeholderId}`)!, kind: 'notification', action: 'done', retryId: original.id,
  })).rejects.toThrow();
  expect(mock.workspace.state.operations).toEqual([original]);
  await mock.remote.refresh();
  await mock.workspace.flush();
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(relaunched.getSnapshot().loadError).toBe('');
  await relaunched.flush();
  expect(relaunched.state.operations).toEqual([{ ...original, threadId: '123' }]);
  expect(relaunched.state.notes.map(note => note.text)).toEqual(state.notes.map(note => note.text));
  expect(relaunched.state.tasks.map(task => task.title)).toEqual(state.tasks.map(task => task.title));
  expect(mock.requests.map(request => request.op)).toEqual(['github.refresh']);
});

test('successive acknowledgements drain over 200 pending events without handling newer in-flight evidence', async () => {
  const events = Array.from({ length: LIMITS.events + 1 }, (_, index) => evidence(`comment-${String(index + 1).padStart(3, '0')}`, 'comment'));
  let source = thread(events.slice(0, LIMITS.events));
  const firstWrite = deferred<Extract<Request, { op: 'github.acknowledge' }>>();
  const confirmation = deferred<void>();
  let writes = 0;
  const mock = await harness(async request => {
    if (request.op === 'github.refresh') return reply(request, batch([source]));
    if (request.op !== 'github.acknowledge') throw new Error(`Unexpected service operation ${request.op}`);
    if (++writes === 1) {
      firstWrite.resolve(request);
      await confirmation.promise;
    }
    return reply(request, { ...request.input, action: 'acknowledge', confirmedAt: new Date().toISOString(), status: 'confirmed' });
  });
  await mock.remote.refresh();
  source = thread(events.slice(1));
  await mock.remote.refresh();
  const before = getRow(mock.workspace.state, 't:123')!;
  expect(before.events).toHaveLength(201);
  const writing = mock.remote.archive(before);
  const request = await firstWrite.promise;
  expect(request.input.displayedEvidenceIds).toEqual(events.slice(1).map(event => event.id));
  const newer = { ...evidence('newer-request'), at: '2026-09-11T17:01:00Z' };
  source = { ...thread([newer]), updatedAt: newer.at };
  await mock.remote.refresh();
  confirmation.resolve();
  await writing;
  expect(mock.workspace.state.handled).toHaveLength(200);
  expect(mock.workspace.state.handled).not.toContain(events[0]!.id);
  expect(mock.workspace.state.handled).not.toContain(newer.id);
  expect(mock.workspace.state.threads[0]!.archive).toBeNull();
  const remaining = getRow(mock.workspace.state, 't:123')!;
  expect(remaining.thread!.events).toHaveLength(202);
  expect(getRows(mock.workspace.state)).toHaveLength(1);
  await mock.remote.write({ row: remaining, kind: 'notification', action: 'done' });
  const acknowledged = mock.requests.filter(request => request.op === 'github.acknowledge');
  expect(acknowledged.map(request => request.input.displayedEvidenceIds)).toEqual([
    events.slice(1).map(event => event.id), [events[0]!.id, newer.id],
  ]);
  expect(remaining.events.map(event => event.id)).toEqual([events[0]!.id, newer.id]);
  expect(getRow(mock.workspace.state, 't:123')!.events).toEqual([]);
  expect(getRows(mock.workspace.state)).toHaveLength(1);
  expect(mock.workspace.state.handled).toHaveLength(202);
  expect(getRow(mock.workspace.state, 't:123')!.thread!.events).toHaveLength(202);
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(relaunched.state.threads[0]!.notification).toBe('done');
  expect(getRow(relaunched.state, 't:123')!.events).toEqual([]);
  expect(getRows(relaunched.state)).toHaveLength(1);
});

test('Archive saves placement and intent together before dispatch, and newer source activity survives the pending acknowledgement', async () => {
  const pending = deferred<void>();
  const sent = deferred<void>();
  let source = thread();
  const mock = await harness(async request => {
    if (request.op === 'github.refresh') return reply(request, batch([source]));
    expect(request.op).toBe('github.acknowledge');
    expect(mock.saved().snapshot!.workspace).toMatchObject({ state: {
      threads: [{ archive: { notificationUpdatedAt: thread().updatedAt } }], operations: [{ status: 'pending' }],
    } });
    sent.resolve();
    await pending.promise;
    return reply(request, { ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString() });
  });
  await mock.remote.refresh();
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'Private archive note' });
  const row = getRow(mock.workspace.state, 't:123')!;
  const saving = mock.blockSave();
  const archiving = mock.remote.archive(row);
  expect(getRows(mock.workspace.state)).toEqual([]);
  expect(mock.workspace.state.operations[0]!.status).toBe('pending');
  expect(mock.requests.map(request => request.op)).toEqual(['github.refresh']);
  saving.resolve();
  await sent.promise;
  const next = '2026-09-11T17:01:00Z';
  source = { ...thread(), updatedAt: next };
  await mock.remote.refresh();
  expect(getRows(mock.workspace.state)).toHaveLength(1);
  pending.resolve();
  await archiving;
  expect(mock.workspace.state.threads[0]!.notification).toBe('unread');
  expect(getRows(mock.workspace.state)).toHaveLength(1);
  expect(mock.workspace.state.handled).not.toContain(`github:notification:123:${next}`);
  await mock.workspace.flush();
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(getRows(relaunched.state)).toHaveLength(1);
  expect(relaunched.state.notes[0]!.text).toBe('Private archive note');
});

test.each([['read', 'archived'], ['unread', 'archived'], ['read', 'restored'], ['unread', 'restored']] as const)(
  'a newer review request stays pending after confirmed Archive despite stale %s metadata (%s), including across relaunch and the next Archive', async (notification, placement) => {
  setSystemTime(new Date('2026-09-11T18:00:00Z'));
  try {
    let source = thread();
    const mock = await harness(async request => {
      if (request.op === 'github.refresh') return reply(request, batch([source]));
      expect(request.op).toBe('github.acknowledge');
      return reply(request, { ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString() });
    });
    await mock.remote.refresh();
    mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'Keep my archive note' });
    await mock.remote.archive(getRow(mock.workspace.state, 't:123')!);
    expect(mock.workspace.state.threads[0]).toMatchObject({
      notification: 'done', archive: { at: '2026-09-11T18:00:00Z', notificationUpdatedAt: thread().updatedAt },
    });
    if (placement === 'restored') mock.workspace.dispatch({ type: 'restore-thread', threadId: '123' });
    const newer = { ...evidence('new-review-request'), at: '2026-09-11T18:01:00Z' };
    source = { ...thread([evidence(), newer]), notification, updatedAt: '2026-09-11T16:59:00Z' };
    setSystemTime(new Date('2026-09-11T18:02:00Z'));
    await mock.remote.refresh();
    expect(getRows(mock.workspace.state, 'inbox')).toHaveLength(1);
    expect(getRow(mock.workspace.state, 't:123')!.events.map(event => event.id)).toEqual([newer.id]);
    expect(mock.workspace.state.threads[0]).toMatchObject({ notification, notificationUpdatedAt: thread().updatedAt });
    expect(mock.workspace.state.handled).toEqual(['request-1']);
    await mock.workspace.flush();
    const relaunched = new DesktopWorkspace(mock.platform);
    await relaunched.load(); await relaunched.flush();
    expect(getRows(relaunched.state, 'inbox')).toHaveLength(1);
    expect(getRow(relaunched.state, 't:123')!.events.map(event => event.id)).toEqual([newer.id]);
    expect(relaunched.state.notes[0]!.text).toBe('Keep my archive note');
    const remote = new ServiceWorkspace(relaunched, mock.client);
    await remote.refresh();
    await remote.archive(getRow(relaunched.state, 't:123')!);
    expect(mock.requests.filter(request => request.op === 'github.acknowledge').map(request => request.input)).toMatchObject([
      { displayedEvidenceIds: ['request-1'], notificationUpdatedAt: thread().updatedAt },
      { displayedEvidenceIds: [newer.id], notificationUpdatedAt: thread().updatedAt },
    ]);
    const archivedAgain = new DesktopWorkspace(mock.platform);
    await archivedAgain.load();
    expect(getRows(archivedAgain.state, 'archive')).toHaveLength(1);
    expect(getRow(archivedAgain.state, 't:123')!.events).toEqual([]);
    expect(archivedAgain.state.handled).toEqual(['request-1', newer.id]);
    expect(archivedAgain.state.notes[0]!.text).toBe('Keep my archive note');
  } finally { setSystemTime(); }
});

test('offline Archive persists locally, never replays on relaunch and retries only its original source boundary', async () => {
  let fail = true;
  const mock = await harness(async request => {
    if (request.op === 'github.refresh') return reply(request, batch());
    if (fail) throw new Error('Acknowledgement timed out; GitHub may have received it.');
    return reply(request, { ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString() });
  });
  await mock.remote.refresh();
  const row = getRow(mock.workspace.state, 't:123')!;
  await expect(mock.remote.archive(row)).rejects.toThrow('timed out');
  expect(getRows(mock.workspace.state, 'archive')).toHaveLength(1);
  const operation = structuredClone(mock.workspace.state.operations[0]!);
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load(); await relaunched.flush();
  expect(mock.requests).toHaveLength(2);
  expect(getRows(relaunched.state, 'archive')).toHaveLength(1);
  fail = false;
  await new ServiceWorkspace(relaunched, mock.client).write({ row, kind: 'notification', action: 'done', retryId: operation.id });
  expect(relaunched.state.operations[0]).toMatchObject({ id: operation.id, eventIds: operation.eventIds,
    notificationUpdatedAt: operation.notificationUpdatedAt, status: 'confirmed' });
});

test('Archive on a placeholder stays local, and failed local persistence cannot dispatch its remote intent', async () => {
  const mock = await harness(async () => { throw new Error('Must not call the network'); });
  loadSource(mock.workspace);
  mock.workspace.update(state => ({ ...state, threads: state.threads.map(thread => ({ ...thread, id: placeholderId, events: [] })) }));
  await mock.remote.archive(getRow(mock.workspace.state, `t:${placeholderId}`)!);
  expect(mock.workspace.state.operations).toEqual([]);
  expect(mock.workspace.getSnapshot().feedback).toContain('no GitHub notification ID');
  mock.workspace.update(state => ({ ...state, threads: state.threads.map(thread => ({ ...thread, id: '123' })) }));
  await mock.workspace.flush();
  mock.failSave();
  await expect(mock.remote.archive(getRow(mock.workspace.state, 't:123')!)).rejects.toThrow('storage failure');
  expect(mock.workspace.state.threads[0]!.archive).not.toBeNull();
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(true);
  expect(mock.requests).toEqual([]);
});

test('acknowledgement intent keeps the displayed timestamp even when refresh preceded modal confirmation', async () => {
  const mock = await harness(async request => reply(request, {
    ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString(),
  }));
  loadSource(mock.workspace);
  const displayed = getRow(mock.workspace.state, 't:123')!;
  loadSource(mock.workspace, { ...thread(), updatedAt: '2026-09-11T17:01:00Z' });
  await mock.remote.write({ row: displayed, kind: 'notification', action: 'done' });
  expect(mock.workspace.state.operations[0]!.notificationUpdatedAt).toBe(thread().updatedAt);
  expect(mock.workspace.state.threads[0]!.notification).toBe('unread');
  expect(mock.requests[0]!.input).toMatchObject({ notificationUpdatedAt: thread().updatedAt });
});

test('archiving again during a pending request is local; its eventual confirmation cannot reverse local Restore', async () => {
  const wait = deferred<void>();
  const sent = deferred<void>();
  const mock = await harness(async request => {
    sent.resolve();
    await wait.promise;
    return reply(request, { ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString() });
  });
  loadSource(mock.workspace);
  const original = getRow(mock.workspace.state, 't:123')!;
  const archiving = mock.remote.archive(original);
  await sent.promise;
  loadSource(mock.workspace, { ...thread(), updatedAt: '2026-09-11T17:01:00Z' });
  await mock.remote.archive(getRow(mock.workspace.state, 't:123')!);
  expect(mock.workspace.state.operations).toHaveLength(2);
  expect(mock.workspace.state.operations[1]).toMatchObject({ status: 'failed', notificationUpdatedAt: '2026-09-11T17:01:00Z' });
  expect(mock.requests).toHaveLength(1);
  expect(getRows(mock.workspace.state, 'archive')).toHaveLength(1);
  mock.workspace.dispatch({ type: 'restore-thread', threadId: '123' });
  wait.resolve();
  await archiving;
  expect(getRows(mock.workspace.state, 'inbox')).toHaveLength(1);
  expect(mock.workspace.state.threads[0]!.notification).toBe('unread');
  expect(mock.workspace.state.handled).toEqual(['request-1']);
});

test('Archive during pending unsubscribe retains a separate acknowledgement intent for explicit retry', async () => {
  const wait = deferred<void>();
  const sent = deferred<void>();
  const mock = await harness(async request => {
    if (request.op === 'github.unsubscribe') { sent.resolve(); await wait.promise; }
    return reply(request, { ...request.input, action: request.op === 'github.unsubscribe' ? 'unsubscribe' : 'acknowledge',
      status: 'confirmed', confirmedAt: new Date().toISOString() });
  });
  loadSource(mock.workspace);
  const row = getRow(mock.workspace.state, 't:123')!;
  const unsubscribing = mock.remote.write({ row, kind: 'notification', action: 'unsubscribe' });
  await sent.promise;
  await mock.remote.archive(row);
  expect(mock.workspace.state.operations).toHaveLength(2);
  const acknowledgement = mock.workspace.state.operations[1]!;
  expect(acknowledgement).toMatchObject({ action: 'done', status: 'failed', notificationUpdatedAt: thread().updatedAt });
  expect(acknowledgement.message).toContain('Not sent');
  expect(mock.saved().snapshot?.workspace).toMatchObject({ state: { operations: mock.workspace.state.operations } });
  expect(mock.requests.map(request => request.op)).toEqual(['github.unsubscribe']);
  wait.resolve();
  await unsubscribing;
  expect(mock.workspace.state.operations[1]!.status).toBe('failed');
  await mock.remote.write({ row, kind: 'notification', action: 'done', retryId: acknowledgement.id });
  expect(mock.workspace.state.threads[0]).toMatchObject({ notification: 'done', subscription: 'unsubscribed' });
  expect(getRows(mock.workspace.state, 'archive')).toHaveLength(1);
});

test('legacy retry without a notification timestamp is retained and rejected before network; fresh context is explicit', async () => {
  const mock = await harness(async request => reply(request, {
    ...request.input, action: 'acknowledge', status: 'confirmed', confirmedAt: new Date().toISOString(),
  }));
  loadSource(mock.workspace);
  mock.workspace.update(state => ({ ...state, operations: [{
    id: 'legacy-intent', threadId: '123', action: 'done', status: 'uncertain', eventIds: ['request-1'], startedAt: state.clock, message: 'Interrupted legacy write',
  }] }));
  const row = getRow(mock.workspace.state, 't:123')!;
  await expect(mock.remote.write({ row, kind: 'notification', action: 'done', retryId: 'legacy-intent' })).rejects.toThrow('no saved notification-update boundary');
  expect(mock.requests).toEqual([]);
  expect(mock.workspace.state.operations[0]!.id).toBe('legacy-intent');
  expect(mock.workspace.state.handled).toEqual([]);
  await mock.remote.archive(row);
  expect(mock.workspace.state.operations).toHaveLength(2);
  expect(mock.workspace.state.operations[1]!.notificationUpdatedAt).toBe(thread().updatedAt);
  expect(mock.workspace.state.operations[1]!.status).toBe('confirmed');
});

test('manual refresh uses latest notes and Done; capture, edits, load and clocks never call model or network', async () => {
  const pending = deferred<unknown>();
  const mock = await harness(async request => reply(request, await pending.promise));
  expect(mock.requests).toEqual([]);
  loadSource(mock.workspace);
  mock.workspace.dispatch({ type: 'select', key: 't:123' });
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'Before refresh' });
  const refresh = mock.remote.refresh();
  mock.workspace.dispatch({ type: 'note', threadId: '123', noteId: mock.workspace.state.notes[0]!.id, text: 'Typed during refresh' });
  mock.workspace.dispatch({ type: 'draft', text: 'Every day at 10am, review https://github.com/octo/project/pull/1' });
  mock.workspace.dispatch({ type: 'capture' });
  const key = mock.workspace.state.selectedKey!;
  mock.workspace.dispatch({ type: 'done', key });
  pending.resolve(batch([thread([evidence(), evidence('queue', 'merge-queue')])]));
  await refresh;
  expect(mock.workspace.state.notes[0]!.text).toBe('Typed during refresh');
  expect(mock.workspace.state.tasks[0]!.status).toBe('done');
  expect(mock.workspace.state.selectedKey).toBe(key);
  expect(mock.requests.map(request => request.op)).toEqual(['github.refresh']);
  expect(JSON.stringify(mock.requests)).not.toContain('Typed during refresh');
});

test('rules edited during Refresh apply to its one batch; automatic terminal and rule suppression never dispatch writes', async () => {
  const held = deferred<ReturnType<typeof batch>>();
  let incoming = batch();
  let pause = false;
  const mock = await harness(async request => {
    expect(request.op).toBe('github.refresh');
    const result = pause ? await held.promise : incoming;
    return reply(request, { ...result, fetchedAt: new Date().toISOString() });
  });
  await mock.remote.refresh();
  mock.workspace.dispatch({ type: 'select', key: 't:123' });
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'Saved reader context' });
  mock.workspace.saveScroll('reader:octo/project:pr:1', 417);
  pause = true;
  const refreshing = mock.remote.refresh();
  mock.workspace.dispatch({ type: 'save-inbox', inbox: { id: 'work', name: 'Work' } });
  mock.workspace.dispatch({ type: 'save-rule', rule: {
    id: 'first', name: 'PRs', enabled: true, criteria: { kind: 'pr' }, action: { type: 'inbox', inboxId: 'work' },
  } });
  held.resolve(incoming);
  await refreshing;
  expect(getRows(mock.workspace.state, 'inbox:work')).toHaveLength(1);
  const queued = thread([evidence(), evidence('historical-queue', 'merge-queue'), evidence('later-comment', 'comment')]);
  queued.sourceState = { state: 'queued', observedAt: new Date().toISOString(), updatedAt: queued.updatedAt, error: null };
  incoming = batch([queued]); pause = false;
  await mock.remote.refresh(); await mock.workspace.flush();
  expect(getRows(mock.workspace.state, 'filtered')).toHaveLength(1);
  expect(mock.workspace.state.operations).toEqual([]);
  expect(mock.workspace.state.handled).toEqual([]);
  expect(mock.requests.every(request => request.op === 'github.refresh')).toBe(true);
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load(); await relaunched.flush();
  expect(getRows(relaunched.state, 'filtered')).toHaveLength(1);
  expect(relaunched.state.selectedKey).toBe('t:123');
  expect(relaunched.state.notes[0]!.text).toBe('Saved reader context');
  expect(relaunched.getSnapshot().workspace!.scroll['reader:octo/project:pr:1']).toBe(417);
  expect(relaunched.state.rules).toEqual(mock.workspace.state.rules);
});

test('source mapping never guesses queue membership from timeline order, reason or REST mergeability', () => {
  const source = thread([evidence('old-queue', 'merge-queue')]);
  expect(sourceThread(source, []).state).toBe('open');
  source.sourceState = { ...source.sourceState, state: 'unknown', error: { code: 'access', message: 'Denied', retryable: false } };
  expect(sourceThread(source, []).state).toBe('open');
  expect(sourceThread(source, []).sourceState?.state).toBe('unknown');
});

test('write intent persists before dispatch and confirmation handles only captured evidence, never private notes', async () => {
  const pending = deferred<unknown>();
  let writeRequest: Request | undefined;
  const mock = await harness(async request => {
    writeRequest = request;
    expect(JSON.stringify(mock.saved().snapshot)).toContain('"status":"pending"');
    return reply(request, await pending.promise);
  });
  loadSource(mock.workspace);
  mock.workspace.dispatch({ type: 'select', key: 't:123' });
  const row = getRow(mock.workspace.state, 't:123')!;
  const writing = mock.remote.write({ row, kind: 'notification', action: 'done' });
  await Bun.sleep(0);
  expect(writeRequest?.op).toBe('github.acknowledge');
  loadSource(mock.workspace, thread([evidence(), evidence('new-request')]));
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'New concurrent PRIVATE note' });
  pending.resolve({ ...mock.requests[0]!.input, action: 'acknowledge', confirmedAt: new Date().toISOString(), status: 'confirmed' });
  await writing;
  expect(mock.workspace.state.handled).toContain('request-1');
  expect(mock.workspace.state.handled).not.toContain('new-request');
  expect(mock.workspace.state.notes[0]!.text).toBe('New concurrent PRIVATE note');
  expect(mock.workspace.state.tasks).toEqual([]);
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(false);
  expect(JSON.stringify(mock.requests)).not.toContain('PRIVATE');
});

test('failure/relaunch/retry preserves original operation identity without automatic replay', async () => {
  let fail = true;
  const handler: ServiceTransport = async request => {
    if (fail) throw new Error('GitHub unavailable');
    return reply(request, { ...request.input, action: 'unsubscribe', confirmedAt: new Date().toISOString(), status: 'confirmed' });
  };
  const mock = await harness(handler);
  loadSource(mock.workspace);
  const row = getRow(mock.workspace.state, 't:123')!;
  await expect(mock.remote.write({ row, kind: 'notification', action: 'unsubscribe' })).rejects.toThrow('unavailable');
  const id = mock.workspace.state.operations[0]!.id;
  expect(mock.workspace.state.operations[0]!.status).toBe('failed');
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load(); await relaunched.flush();
  expect(mock.requests).toHaveLength(1);
  fail = false;
  const remote = new ServiceWorkspace(relaunched, new ServiceClient(handler));
  await remote.write({ row: getRow(relaunched.state, 't:123')!, kind: 'notification', action: 'unsubscribe', retryId: id });
  expect(relaunched.state.operations[0]!.id).toBe(id);
  expect(relaunched.state.operations[0]!.status).toBe('confirmed');
  expect(relaunched.state.threads[0]!.subscription).toBe('unsubscribed');
});

test('storage failure prevents GitHub writes but capture needs no service call', async () => {
  const mock = await harness(async () => { throw new Error('Must not call service'); });
  loadSource(mock.workspace); await mock.workspace.flush();
  mock.failSave();
  await expect(mock.remote.write({ row: getRow(mock.workspace.state, 't:123')!, kind: 'notification', action: 'done' })).rejects.toThrow('storage failure');
  mock.workspace.dispatch({ type: 'draft', text: 'Original text' });
  mock.workspace.dispatch({ type: 'capture' });
  expect(mock.workspace.state.tasks[0]!.title).toBe('Original text');
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(true);
  expect(mock.requests).toEqual([]);
});

test('concurrent saves retain the newest note and task capture before Saved', async () => {
  const mock = await harness(async () => { throw new Error('Local edits must not reach service'); });
  loadSource(mock.workspace); await mock.workspace.flush();
  const save = mock.blockSave();
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'First pending note' });
  const noteId = mock.workspace.state.notes[0]!.id;
  mock.workspace.dispatch({ type: 'note', threadId: '123', noteId, text: 'Newest pending note' });
  mock.workspace.dispatch({ type: 'draft', text: 'Capture during save' });
  mock.workspace.dispatch({ type: 'capture' });
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(true);
  save.resolve();
  await mock.workspace.flush();
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load(); await relaunched.flush();
  expect(relaunched.state.notes[0]!.text).toBe('Newest pending note');
  expect(relaunched.state.tasks[0]!.title).toBe('Capture during save');
  expect(mock.requests).toEqual([]);
});

test('GitHub confirmation followed by save failure remains pending locally, not falsely Saved or auto-retried', async () => {
  const mock = await harness(async request => {
    mock.failSave();
    return reply(request, { ...request.input, action: 'acknowledge', confirmedAt: new Date().toISOString(), status: 'confirmed' });
  });
  loadSource(mock.workspace);
  await expect(mock.remote.write({ row: getRow(mock.workspace.state, 't:123')!, kind: 'notification', action: 'done' })).rejects.toThrow('storage failure');
  expect(mock.workspace.state.operations[0]!.status).toBe('confirmed');
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(true);
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(relaunched.state.operations[0]!.status).toBe('uncertain');
  expect(mock.requests).toHaveLength(1);
});
