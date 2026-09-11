import { expect, test } from 'bun:test';
import type { Request, Thread as SourceThread } from '../../service/src/schema.ts';
import { applyScopedSuggestedOrder, mergeRefresh } from '../domain/live.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient, type ServiceTransport } from '../platform/service.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { getRow } from '../domain/engine.ts';
import { ServiceWorkspace, sourceThread, triagePayload } from './service-workspace.ts';

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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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

test('manual refresh applies to latest state and never starts network from load, clocks or local edits', async () => {
  const pending = deferred<unknown>();
  const mock = await harness(async request => reply(request, await pending.promise));
  expect(mock.requests).toEqual([]);
  loadSource(mock.workspace);
  mock.workspace.dispatch({ type: 'select', key: 't:123' });
  mock.workspace.dispatch({ type: 'edit', key: 't:123', notes: 'Before refresh' });
  const refresh = mock.remote.refresh();
  mock.workspace.dispatch({ type: 'edit', key: 't:123', notes: 'Typed during refresh' });
  const key = mock.workspace.state.selectedKey!;
  mock.workspace.dispatch({ type: 'done', key });
  pending.resolve(batch([thread([evidence(), evidence('queue', 'merge-queue')])]));
  await refresh;
  expect(mock.workspace.state.actions[0]!.notes).toBe('Typed during refresh');
  expect(mock.workspace.state.actions[0]!.status).toBe('done');
  expect(mock.workspace.state.selectedKey).toBe(key);
  expect(getRow(mock.workspace.state, 't:123')!.kind).toBe('update');
  expect(mock.requests.map(request => request.op)).toEqual(['github.refresh']);
});

test('write intent is persisted before dispatch and confirmation handles only captured evidence', async () => {
  const pending = deferred<unknown>();
  let writeRequest: Request | undefined;
  const mock = await harness(async request => {
    writeRequest = request;
    expect(JSON.stringify(mock.saved().snapshot)).toContain('"status":"pending"');
    return reply(request, await pending.promise);
  });
  loadSource(mock.workspace);
  mock.workspace.dispatch({ type: 'select', key: 't:123' });
  mock.workspace.dispatch({ type: 'start', key: 't:123' });
  const row = getRow(mock.workspace.state, 't:123')!;
  const writing = mock.remote.write({ row, kind: 'notification', action: 'done' });
  await Bun.sleep(0);
  expect(writeRequest?.op).toBe('github.acknowledge');
  loadSource(mock.workspace, thread([evidence(), evidence('new-request')]));
  mock.workspace.dispatch({ type: 'edit', key: mock.workspace.state.selectedKey!, notes: 'New concurrent note' });
  const input = mock.requests[0]!.input;
  pending.resolve({ ...input, action: 'acknowledge', confirmedAt: new Date().toISOString(), status: 'confirmed' });
  await writing;
  expect(mock.workspace.state.handled).toContain('request-1');
  expect(mock.workspace.state.handled).not.toContain('new-request');
  expect(mock.workspace.state.actions[0]!.notes).toBe('New concurrent note');
  expect(mock.workspace.state.actions[0]!.status).toBe('available');
  expect(mock.workspace.getSnapshot().persistence.pending).toBe(false);
});

test('failure/relaunch/retry preserves operation identity and never automatically dispatches', async () => {
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

test('storage failure prevents GitHub writes and capture interpretation from dispatching', async () => {
  const mock = await harness(async () => { throw new Error('Must not call service'); });
  loadSource(mock.workspace); await mock.workspace.flush();
  mock.failSave();
  await expect(mock.remote.write({ row: getRow(mock.workspace.state, 't:123')!, kind: 'notification', action: 'done' })).rejects.toThrow('storage failure');
  expect(mock.requests).toEqual([]);
  mock.workspace.dispatch({ type: 'draft', text: 'Original text' });
  mock.workspace.dispatch({ type: 'capture' });
  await expect(mock.remote.interpret(getRow(mock.workspace.state, mock.workspace.state.selectedKey!)!)).rejects.toThrow('storage failure');
  expect(mock.requests).toEqual([]);
});

test('bounded triage excludes notes/local routines and stale previews cannot apply', async () => {
  const mock = await harness(async request => {
    if (request.op !== 'copilot.triage') throw new Error('Unexpected operation');
    return reply(request, { previewOnly: true, suggestedOrder: request.input.items.map(item => item.itemId),
      suggestions: request.input.items.map(item => ({ itemId: item.itemId, evidenceIds: [item.evidence[0]!.id],
        summary: 'Review evidence', uncertainty: '', nextAction: 'review' })) });
  });
  const threads = Array.from({ length: 35 }, (_, index) => ({ ...thread(), id: String(index + 100), reference: { ...thread().reference, number: index + 1 } }));
  mock.workspace.update(state => mergeRefresh(state, { threads: threads.map(source => sourceThread(source, [])), startedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), status: 'complete', diagnostics: [] }));
  mock.workspace.dispatch({ type: 'draft', text: 'Local capture not part of notifications' });
  mock.workspace.dispatch({ type: 'capture' });
  const key = mock.workspace.state.selectedKey!;
  mock.workspace.dispatch({ type: 'edit', key, notes: 'SECRET PRIVATE SCRATCH' });
  mock.workspace.dispatch({ type: 'routine', key, time: '10:00', timeZone: 'UTC', steps: ['Local-only step'] });
  const payload = triagePayload(mock.workspace.state);
  expect(payload.input.items).toHaveLength(10);
  expect(JSON.stringify(payload)).not.toContain('SECRET PRIVATE');
  expect(JSON.stringify(payload)).not.toContain('Local-only');
  const preview = await mock.remote.triage('triage');
  expect(preview.keys).toHaveLength(10);
  expect(preview.scope).toContain('10 notifications');
  mock.workspace.dispatch({ type: 'done', key: 't:100' });
  expect(() => applyScopedSuggestedOrder(mock.workspace.state, preview.fingerprint, preview.keys, preview.order)).toThrow('changed');
  expect(JSON.stringify(mock.requests)).not.toContain('SECRET PRIVATE');
});

test('capture SDK payload includes only saved original and structured errors have no sample fallback', async () => {
  const mock = await harness(async request => {
    expect(JSON.stringify(mock.saved().snapshot)).toContain('Original specific capture');
    if (request.op !== 'copilot.interpretCapture') throw new Error('Unexpected operation');
    expect(request.input.text).toBe('Original specific capture');
    return reply(request, { previewOnly: true, captureId: request.input.captureId,
      proposal: { kind: 'action', title: 'Suggested action', steps: [], dailyAt: null, timeZone: 'UTC', uncertainty: 'Confirm the scope.' } });
  });
  mock.workspace.dispatch({ type: 'draft', text: 'Original specific capture' });
  mock.workspace.dispatch({ type: 'capture' });
  const key = mock.workspace.state.selectedKey!;
  mock.workspace.dispatch({ type: 'edit', key, notes: 'DO NOT SEND MY NOTE' });
  const preview = await mock.remote.interpret(getRow(mock.workspace.state, key)!);
  expect(preview.proposal.title).toBe('Suggested action');
  expect(mock.workspace.state.actions[0]!.title).toBe('Original specific capture');
  expect(JSON.stringify(mock.requests)).not.toContain('DO NOT SEND');
  await mock.remote.cancelPreview();
  expect(mock.requests.map(request => request.op)).toEqual(['copilot.interpretCapture']);
  const bad = new ServiceWorkspace(mock.workspace, new ServiceClient(async request => reply(request, { previewOnly: true, suggestions: [] })));
  await expect(bad.interpret(getRow(mock.workspace.state, key)!)).rejects.toThrow('invalid result');
});

test('closing capture interpretation during a blocked save never dispatches an SDK request', async () => {
  const mock = await harness(async () => { throw new Error('Cancelled preview must not reach SDK'); });
  const save = mock.blockSave();
  mock.workspace.dispatch({ type: 'draft', text: 'Capture with a pending disk write' });
  mock.workspace.dispatch({ type: 'capture' });
  const row = getRow(mock.workspace.state, mock.workspace.state.selectedKey!)!;
  const preview = mock.remote.interpret(row);
  await Bun.sleep(0);
  expect(mock.requests).toEqual([]);
  await mock.remote.cancelPreview();
  save.resolve();
  await expect(preview).rejects.toThrow('cancelled');
  expect(mock.requests).toEqual([]);
  await mock.workspace.flush();
  expect(JSON.stringify(mock.saved().snapshot)).toContain('Capture with a pending disk write');
});

test('GitHub confirmation followed by save failure remains pending locally, never falsely Saved or auto-retried', async () => {
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
