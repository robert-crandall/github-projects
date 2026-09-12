import { expect, test } from 'bun:test';
import { GitHubService } from '../../service/src/github.ts';
import { createHandler } from '../../service/src/main.ts';
import { conversationPageSchema, referenceSchema, type ConversationCache, type Request } from '../../service/src/schema.ts';
import { ServiceError } from '../../service/src/errors.ts';
import { cacheKey, ConversationApi, longBody, mergeCachedPage, rawMessage } from '../../tests/conversation-fixture.ts';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { ServiceClient } from '../platform/service.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { ServiceWorkspace, sourceThread } from './service-workspace.ts';
import { beginOperation, finishOperation, mergeRefresh } from '../domain/live.ts';
import { getRow, getRows } from '../domain/engine.ts';
import { groupMessages } from './ConversationReader.tsx';

const reference = { repo: 'octo/project', number: 12, kind: 'pr' as const };
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}
async function harness() {
  const api = new ConversationApi();
  api.seed(reference);
  let saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  const caches = new Map<string, ConversationCache>();
  const requests: Request[] = [];
  const writes: string[] = [];
  let cacheFailure = false;
  const platform = createNativePlatform(async (command, args) => {
    switch (command) {
      case 'workspace_read': return saved;
      case 'clock_now': return { now: new Date().toISOString(), timeZone: 'UTC', error: null };
      case 'workspace_save':
        expect(args?.expectedRevision).toBe(saved.revision);
        saved = { revision: crypto.randomUUID(), snapshot: snapshotSchema.parse(args?.snapshot), savedAt: new Date().toISOString() };
        writes.push(JSON.stringify(saved.snapshot));
        return saved;
      case 'conversation_read': return caches.get(cacheKey(referenceSchema.parse(args?.reference))) ?? null;
      case 'conversation_merge': {
        if (cacheFailure) throw { code: 'cache-limit', message: 'The 4 MiB source cache is full.', retryable: false };
        const page = conversationPageSchema.parse(args?.page);
        const key = cacheKey(page.reference);
        const cache = mergeCachedPage(caches.get(key), page);
        caches.set(key, cache);
        return cache;
      }
      case 'conversation_reset': caches.clear(); cacheFailure = false; return null;
      default: throw new Error(`Unexpected native operation ${command}`);
    }
  });
  const handler = createHandler(new GitHubService(api));
  let refreshGate: Promise<void> | undefined;
  const workspace = new DesktopWorkspace(platform);
  await workspace.load(); await workspace.flush();
  const client = new ServiceClient(async request => {
    requests.push(request);
    if (request.op === 'cancel') throw new Error('Unexpected cancellation');
    const result = request.op === 'github.refresh'
      ? await (async () => { await refreshGate; return { batchId: 'refresh', fetchedAt: new Date().toISOString(), viewer: 'viewer', status: 'complete',
        threads: [], diagnostics: [], coverage: { notifications: 'complete', pages: 1, received: 0, returned: 0, missingMeansDone: false } }; })()
      : await handler(request, new AbortController().signal);
    return { v: 1, id: request.id, ok: true, result };
  });
  const remote = new ServiceWorkspace(workspace, client);
  return { workspace, remote, platform, api, caches, requests, writes, saved: () => saved,
    failCache: () => { cacheFailure = true; }, holdRefresh: (promise: Promise<void>) => { refreshGate = promise; } };
}

test('service -> client -> native cache -> runtime keeps complete content separate from notes and pending evidence', async () => {
  const mock = await harness();
  const source = sourceThread({
    id: '123', reference, title: 'Source', reason: 'subscribed', notification: 'unread', updatedAt: new Date().toISOString(), lastReadAt: null,
    state: 'open', size: null, subscription: 'subscribed', evidence: [],
    coverage: { timeline: 'complete', newestPage: 1, fetchedPages: [1], observedAt: new Date().toISOString() },
  }, []);
  mock.workspace.update(state => mergeRefresh(state, { threads: [source], status: 'complete', startedAt: state.clock, fetchedAt: state.clock, diagnostics: [] }));
  mock.workspace.dispatch({ type: 'note', threadId: '123', text: 'PRIVATE THREAD NOTES' });
  mock.workspace.dispatch({ type: 'draft', text: 'PRIVATE TASK' });
  mock.workspace.dispatch({ type: 'capture' });
  await mock.workspace.flush();
  const before = structuredClone(mock.workspace.state);
  const revision = mock.saved().revision;
  await mock.remote.conversation.select(reference);
  expect(mock.api.calls).toEqual([]);
  await mock.remote.conversation.load();
  expect(mock.remote.conversation.getSnapshot().cache?.messages[0]?.body).toBe(longBody);
  expect(mock.saved().revision).toBe(revision);
  expect(mock.workspace.state).toEqual(before);
  expect(JSON.stringify(mock.requests)).not.toContain('PRIVATE');
  expect(mock.writes.every(write => !write.includes('END OF LONG MESSAGE'))).toBe(true);
  expect(getRow(mock.workspace.state, 't:123')!.events).toEqual(source.events);
  mock.workspace.update(state => finishOperation(beginOperation(state, {
    id: 'confirmed-test', threadId: '123', action: 'done', eventIds: source.events.map(event => event.id),
  }), 'confirmed-test', { confirmedAt: new Date().toISOString() }));
  const inboxBefore = getRows(mock.workspace.state, 'inbox');
  expect(inboxBefore).toEqual([]);
  await mock.remote.conversation.load('inline', 1);
  await mock.remote.conversation.load('comments', 1);
  expect(getRows(mock.workspace.state, 'inbox')).toEqual(inboxBefore);
  const groups = groupMessages(mock.remote.conversation.getSnapshot().cache!.messages).filter(group => group.messages[0]?.kind === 'inline');
  expect(groups).toHaveLength(2);
  expect(groups.map(group => group.messages.map(item => item.body))).toEqual([
    ['Opening discussion A', 'Reply in A', 'Second reply in A'], ['Opening discussion B', 'Reply in B'],
  ]);
  expect(groups.every(group => !group.missingRoot)).toBe(true);
});

test('reload older pages updates edits by identity; rate-limited failures and offline relaunch retain saved bodies', async () => {
  const mock = await harness();
  await mock.remote.conversation.select(reference);
  await mock.remote.conversation.load();
  await mock.remote.conversation.load('comments', 1);
  const route = '/repos/octo/project/issues/12/comments?per_page=5&page=1';
  mock.api.routes.set(route, { status: 200, headers: {}, body: [{ ...rawMessage(reference, 10, 'Edited older comment'), updated_at: '2026-09-12T17:00:00Z' }] });
  await mock.remote.conversation.load('comments', 1);
  const cache = mock.remote.conversation.getSnapshot().cache!;
  expect(cache.messages.filter(item => item.id.endsWith('comments:10'))).toHaveLength(1);
  expect(cache.messages.find(item => item.id.endsWith('comments:10'))?.body).toBe('Edited older comment');
  mock.api.failure = new ServiceError('rate_limit', true);
  await mock.remote.conversation.load('comments', 1);
  expect(mock.remote.conversation.getSnapshot().cache!.pages.find(page => page.stream === 'comments' && page.page === 1)?.error?.code).toBe('rate_limit');
  expect(mock.remote.conversation.getSnapshot().cache!.messages).toEqual(cache.messages);
  const reloaded = new ServiceWorkspace(mock.workspace, new ServiceClient(async () => { throw new Error('Must not contact service'); }));
  await reloaded.conversation.select(reference);
  expect(reloaded.conversation.getSnapshot().cache?.messages).toEqual(cache.messages);
});

test('stale network responses never replace a different selected source, including navigation away and back', async () => {
  const mock = await harness();
  await mock.remote.conversation.select(reference);
  const gate = deferred();
  mock.api.hold = gate.promise;
  const loading = mock.remote.conversation.load();
  const other = { ...reference, number: 13 };
  await mock.remote.conversation.select(other);
  await mock.remote.conversation.select(reference);
  gate.resolve();
  await loading;
  expect(mock.remote.conversation.getSnapshot().reference).toEqual(reference);
  expect(mock.remote.conversation.getSnapshot().cache).toBeNull();
  expect(mock.caches.get(cacheKey(reference))?.messages.length).toBeGreaterThan(0);
});

test('Refresh waits for conversation and notification results together, preserving edits and explicit partial reader errors', async () => {
  const mock = await harness();
  await mock.remote.conversation.select(reference);
  await mock.remote.conversation.load();
  const gate = deferred();
  mock.api.hold = gate.promise;
  const previous = mock.workspace.state.refresh;
  const refreshing = mock.remote.refresh();
  await Bun.sleep(0);
  expect(mock.workspace.state.refresh).toEqual(previous);
  mock.workspace.dispatch({ type: 'draft', text: 'Concurrent task' });
  mock.workspace.dispatch({ type: 'capture' });
  const selected = mock.workspace.state.selectedKey;
  mock.api.failure = new ServiceError('access');
  gate.resolve();
  await refreshing;
  expect(mock.workspace.state.refresh.status).toBe('ok');
  expect(mock.workspace.state.selectedKey).toBe(selected);
  expect(mock.workspace.state.tasks[0]?.title).toBe('Concurrent task');
  expect(mock.remote.conversation.getSnapshot().error).toContain('comments');
  expect(mock.remote.conversation.getSnapshot().cache?.messages[0]?.body).toBe(longBody);
});

test('cache limits fail explicitly and cache-only recovery never changes workspace content or triggers GitHub', async () => {
  const mock = await harness();
  await mock.remote.conversation.select(reference);
  await mock.remote.conversation.load();
  mock.failCache();
  await mock.remote.conversation.load('description');
  expect(mock.remote.conversation.getSnapshot().error).toContain('4 MiB');
  expect(mock.remote.conversation.getSnapshot().cache?.messages[0]?.body).toBe(longBody);
  const before = JSON.stringify(mock.saved());
  const calls = mock.api.calls.length;
  await mock.remote.conversation.reset();
  expect(mock.remote.conversation.getSnapshot().cache).toBeNull();
  expect(JSON.stringify(mock.saved())).toBe(before);
  expect(mock.api.calls).toHaveLength(calls);
});
