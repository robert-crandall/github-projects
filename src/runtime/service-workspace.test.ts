import { expect, test } from 'bun:test';
import type { Request, Thread as SourceThread } from '../../service/src/schema.ts';
import { mergeRefresh } from '../domain/live.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient, type ServiceTransport } from '../platform/service.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { getRow } from '../domain/engine.ts';
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
async function harness(handler: ServiceTransport) {
  let saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  let failSave = false;
  let blockedSave: ReturnType<typeof deferred<void>> | undefined;
  const requests: Request[] = [];
  const platform = createNativePlatform(async (command, args) => {
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: new Date().toISOString(), timeZone: 'UTC', error: null };
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
  return { workspace, remote, requests, saved: () => saved, failSave: () => { failSave = true; },
    blockSave: () => { blockedSave = deferred<void>(); return blockedSave; }, platform };
}
const reply = (request: Request, result: unknown) => ({ v: 1, id: request.id, ok: true, result });
function loadSource(workspace: DesktopWorkspace, source = thread()) {
  workspace.update(state => mergeRefresh(state, { threads: [sourceThread(source, [])], startedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), status: 'complete', diagnostics: [] }));
}

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
