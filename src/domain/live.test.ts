import { expect, test } from 'bun:test';
import type { Activity, AppState, Thread } from '../types.ts';
import { getRows, transition } from './engine.ts';
import { beginOperation, emptyWorkspace, finishOperation, mergeRefresh, restoreDesktop } from './live.ts';

const now = '2026-09-11T17:00:00Z';
const event = (id = 'request', kind: Activity['kind'] = 'review-request'): Activity => ({
  id, threadId: '123', kind, rawKind: kind, at: now, actor: 'octocat', summary: 'Evidence',
  requestState: kind === 'review-request' ? 'current' : 'not-request',
});
const thread = (events = [event()]): Thread => ({
  id: '123', repo: 'octo/project', number: 1, kind: 'pr', source: 'github', title: 'Requested review',
  reason: 'review_requested', state: 'open', notification: 'unread', subscribed: true, subscription: 'subscribed', events,
});
const refresh = (state: AppState, events = [event()]) => mergeRefresh(state, { threads: [thread(events)], startedAt: now, fetchedAt: now, status: 'complete', diagnostics: [] });
const loaded = () => refresh(emptyWorkspace(now, 'UTC'));

test('desktop initialization is empty, real-clock driven and rejects demo commands and snapshots', () => {
  const state = emptyWorkspace(now, 'UTC');
  expect(state.clock).toBe(now);
  expect(state.threads).toEqual([]);
  expect(state.tasks).toEqual([]);
  expect(state.notes).toEqual([]);
  expect(state.selectedKey).toBeNull();
  expect(() => transition(state, { type: 'refresh' })).toThrow('Simulation');
  expect(() => restoreDesktop({ ...state, runtime: undefined }, now)).toThrow('not a live');
});

test('refresh preserves current thread notes, completed Tasks and selection through subsequent source activity', () => {
  let state = loaded();
  state = transition(state, { type: 'note', threadId: '123', text: 'Typed while request was in flight' });
  state = transition(state, { type: 'draft', text: 'My captured task' });
  state = transition(state, { type: 'capture' });
  state = transition(state, { type: 'done', key: state.selectedKey! });
  const before = structuredClone(state);
  for (const kind of ['commit', 'merge-queue', 'comment', 'review-request'] as const) {
    state = refresh(state, [event(), event(`new-${kind}`, kind)]);
    expect(state.tasks).toEqual(before.tasks);
    expect(state.notes).toEqual(before.notes);
    expect(state.selectedKey).toBe(before.selectedKey);
    expect(state.threads).toHaveLength(1);
  }
  expect(restoreDesktop(state, now).notes).toEqual(before.notes);
});

test('missing and repeatedly fetched threads never erase notes or regenerate acknowledged evidence', () => {
  let state = transition(loaded(), { type: 'note', threadId: '123', text: 'Preserve' });
  state = beginOperation(state, { id: 'ack', threadId: '123', action: 'done', eventIds: ['request'] });
  state = finishOperation(state, 'ack', { confirmedAt: now });
  expect(getRows(refresh(refresh(state)))[0]!.events).toEqual([]);
  expect(getRows(refresh(refresh(state)))).toHaveLength(1);
  const missing = mergeRefresh(state, { threads: [], startedAt: now, fetchedAt: now, status: 'partial', diagnostics: ['Timeline unavailable'] });
  expect(missing.notes).toEqual(state.notes);
  expect(missing.threads[0]!.events[0]!.requestState).toBe('uncertain');
  expect(missing.refresh.diagnostics).toContain('Timeline unavailable');
});

test('partial refresh summarizes results and persists each distinct diagnostic once', () => {
  const before = transition(loaded(), { type: 'note', threadId: '123', text: 'Keep my note' });
  const diagnostics = Array.from({ length: 50 }, (_, index) => index % 2 ? 'Timeline unavailable' : 'Notification limit reached');
  const next = mergeRefresh(before, { threads: [thread()], startedAt: now, fetchedAt: now, status: 'partial', diagnostics });
  expect(next.refresh.status).toBe('partial');
  expect(next.refresh.lastSuccessAt).toBe(before.refresh.lastSuccessAt);
  expect(next.refresh.message).toBe('Received 1 GitHub thread. Saved work is retained. Refresh to retry missing activity.');
  expect(next.refresh.diagnostics).toEqual(['Notification limit reached', 'Timeline unavailable']);
  expect(next.notes).toEqual(before.notes);
  expect(restoreDesktop(next, now).refresh).toEqual(next.refresh);
  expect(refresh(next).refresh.diagnostics).toEqual([]);
  expect(refresh(next).refresh.status).toBe('ok');
});

test('ack response handles only displayed evidence, preserves concurrent request and Undo cannot reverse it', () => {
  let state = transition(loaded(), { type: 'draft', text: 'Independent task' });
  state = transition(state, { type: 'capture' });
  state = beginOperation(state, { id: 'ack-1', threadId: '123', action: 'done', eventIds: ['request'] });
  state = refresh(state, [event(), event('later-request')]);
  state = finishOperation(state, 'ack-1', { confirmedAt: now });
  expect(state.handled).toContain('request');
  expect(state.handled).not.toContain('later-request');
  expect(state.threads[0]!.notification).toBe('unread');
  state = refresh(state);
  expect(state.threads[0]!.events.some(event => event.id === 'later-request')).toBe(true);
  state = transition(state, { type: 'done', key: state.selectedKey! });
  state = transition(state, { type: 'undo' });
  expect(state.handled).toContain('request');
  expect(state.tasks[0]!.status).toBe('open');
});

test('unsubscribe survives in-flight refresh; failed and pending writes stay explicit after restart', () => {
  let state = beginOperation(loaded(), { id: 'unsub', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  expect(restoreDesktop(state, now).operations[0]!.status).toBe('uncertain');
  state = finishOperation(state, 'unsub', { error: 'Network failed' });
  expect(state.operations[0]!.status).toBe('failed');
  expect(state.threads[0]!.subscribed).toBe(true);
  state = beginOperation(state, { id: 'retry', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  state = finishOperation(state, 'retry', { confirmedAt: now });
  state = refresh(state, [event(), event('comment', 'comment')]);
  expect(state.threads[0]!.subscribed).toBe(false);
  expect(getRows(state)).toHaveLength(1);
  state = refresh(state, [event('new-request')]);
  expect(getRows(state)).toHaveLength(1);
  expect(state.tasks).toEqual([]);
});

test('a newer authoritative resubscription supersedes unsubscribe, not an older in-flight response or retry', () => {
  let state = beginOperation(loaded(), { id: 'unsub', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  state = finishOperation(state, 'unsub', { confirmedAt: '2026-09-11T17:01:00Z' });
  const delayed = { threads: [thread([event(), event('ordinary', 'comment')])],
    startedAt: now, fetchedAt: '2026-09-11T17:02:00Z', status: 'complete' as const, diagnostics: [] };
  state = mergeRefresh(state, delayed);
  expect(state.threads[0]!.subscription).toBe('unsubscribed');
  expect(getRows(state)).toHaveLength(1);
  state = beginOperation(state, { id: 'retry', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  state = mergeRefresh(state, { ...delayed, startedAt: '2026-09-11T17:03:00Z', fetchedAt: '2026-09-11T17:04:00Z' });
  state = finishOperation(state, 'retry', { confirmedAt: '2026-09-11T17:01:00Z' });
  expect(state.threads[0]!.subscription).toBe('subscribed');
  expect(state.handled).not.toContain('ordinary');
  expect(getRows(state)).toHaveLength(1);
});

test('timeline rollover keeps raw history and marks omitted current requests uncertain', () => {
  const state = refresh(loaded(), [event('ordinary', 'comment')]);
  expect(state.threads[0]!.events.find(event => event.id === 'request')).toMatchObject({
    id: 'request', kind: 'review-request', rawKind: 'review-request', requestState: 'uncertain',
  });
});

test('legacy capture-source association remaps thread notes rather than linking or merging Tasks', () => {
  let state = loaded();
  state.threads[0]!.id = 'capture:octo/project:1';
  state.threads[0]!.events = [];
  state = transition(state, { type: 'note', threadId: state.threads[0]!.id, text: 'Linked before refresh' });
  state = transition(state, { type: 'select', key: `t:${state.threads[0]!.id}` });
  const next = refresh(state);
  expect(next.threads).toHaveLength(1);
  expect(next.notes[0]).toMatchObject({ threadId: '123', text: 'Linked before refresh' });
  expect(next.selectedKey).toBe('t:123');
  expect(next.tasks).toEqual([]);
  expect(() => mergeRefresh(next, { threads: [{ ...thread(), number: 2 }], startedAt: now, fetchedAt: now, status: 'complete', diagnostics: [] })).toThrow('changed thread identity');
});
