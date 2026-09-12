import { expect, test } from 'bun:test';
import { getRow, getRows, transition } from './engine.ts';
import { beginOperation, emptyWorkspace, finishOperation, mergeRefresh, restoreDesktop } from './live.ts';
import { migrateWorkspace } from './migration.ts';
import type { Activity, AppState, Thread } from '../types.ts';

const old = '2026-09-11T17:00:00Z';
const archivedAt = '2026-09-11T18:00:00Z';
const newer = '2026-09-11T18:01:00Z';
const event = (id: string, at = old): Activity => ({
  id, threadId: '123', at, kind: 'comment', actor: 'octocat', summary: id, requestState: 'not-request',
});
const thread = (updatedAt = old, events = [event('original')]): Thread => ({
  id: '123', repo: 'octo/project', number: 1, kind: 'pr', source: 'github', title: 'Saved conversation',
  reason: 'mention', notification: 'unread', subscribed: true, subscription: 'subscribed',
  state: 'open', notificationUpdatedAt: updatedAt, events,
});
const merge = (state: AppState, incoming = thread(), startedAt = newer) =>
  mergeRefresh(state, { threads: [incoming], startedAt, fetchedAt: newer, status: 'complete', diagnostics: [] });
function archived() {
  let state = merge(emptyWorkspace(archivedAt, 'UTC'));
  state = transition(state, { type: 'note', threadId: '123', text: 'Keep my private context' });
  state = transition(state, { type: 'draft', text: 'Independent task' });
  state = transition(state, { type: 'capture' });
  state = transition(state, { type: 'done', key: state.selectedKey! });
  state = transition(state, { type: 'select', key: 't:123' });
  return transition(state, { type: 'archive', threadId: '123' });
}

test('archive is local, independent of read/unread, subscription, Tasks and notes, and restores without reversing remote done', () => {
  for (const notification of ['read', 'unread', 'done'] as const) {
    let state = merge(emptyWorkspace(archivedAt, 'UTC'), { ...thread(), notification });
    const before = structuredClone(state);
    state = transition(state, { type: 'archive', threadId: '123' });
    expect(getRows(state, 'inbox')).toHaveLength(0);
    expect(getRows(state, 'archive')).toHaveLength(1);
    expect(state.threads[0]!.notification).toBe(notification);
    expect(state.threads[0]!.subscribed).toBe(before.threads[0]!.subscribed);
    expect(state.operations).toEqual([]);
    expect(state.handled).toEqual([]);
    state = transition(restoreDesktop(state, newer), { type: 'restore-thread', threadId: '123' });
    expect(getRows(state, 'inbox')).toHaveLength(1);
    expect(state.threads[0]!.notification).toBe(notification);
  }
});

test('identical, missing, partial, stale and metadata-only refreshes cannot resurface archived evidence', () => {
  const original = archived();
  let state = original;
  for (const incoming of [
    thread(), { ...thread(), reason: 'review_requested' as const, notification: 'read' as const, title: 'Hydrated title' },
    thread('2026-09-10T17:00:00Z'),
    thread(old, [event('original'), event('old-hydrated', '2026-09-11T17:30:00Z')]),
    { ...thread(), subscription: 'unsubscribed' as const, subscribed: false },
  ]) {
    state = merge(state, incoming);
    expect(getRows(state, 'inbox')).toEqual([]);
    expect(getRows(state, 'archive')).toHaveLength(1);
    expect(state.notes).toEqual(original.notes);
    expect(state.tasks).toEqual(original.tasks);
    expect(state.threads[0]!.notificationUpdatedAt).toBe(old);
  }
  for (const status of ['complete', 'partial'] as const) {
    state = mergeRefresh(state, { threads: [], startedAt: newer, fetchedAt: newer, status, diagnostics: [] });
    expect(getRows(state, 'archive')).toHaveLength(1);
  }
  expect(restoreDesktop(state, newer).threads[0]!.archive).toEqual(original.threads[0]!.archive);
});

test('advancing notification identity resurfaces with unchanged timeline; stale responses cannot roll back the next archive boundary', () => {
  const original = archived();
  let state = merge(original, thread(newer));
  expect(getRows(state, 'inbox')).toHaveLength(1);
  expect(state.threads).toHaveLength(1);
  expect(state.selectedKey).toBe('t:123');
  expect(state.notes).toEqual(original.notes);
  expect(state.tasks).toEqual(original.tasks);
  state = merge(state, thread(old), old);
  expect(state.threads[0]!.notificationUpdatedAt).toBe(newer);
  state = transition(state, { type: 'archive', threadId: '123' });
  expect(state.threads[0]!.archive!.notificationUpdatedAt).toBe(newer);
  state = merge(state, thread(newer));
  expect(getRows(state, 'inbox')).toEqual([]);
  expect(restoreDesktop(state, newer).notes).toEqual(original.notes);
});

test('new source evidence must be newer than archive and not an old ID or a changed request label', () => {
  const original = archived();
  const sameIdentity = { ...thread(), events: [{ ...event('original'), requestState: 'current' as const, summary: 'Changed hydration' }] };
  expect(getRows(merge(original, sameIdentity), 'inbox')).toEqual([]);
  expect(getRows(merge(original, thread(old, [event('newly-hydrated', '2026-09-11T17:59:00Z')])), 'inbox')).toEqual([]);
  expect(getRows(merge(original, thread(old, [event('new', newer)])), 'inbox')).toHaveLength(1);
  const retained = archived();
  retained.threads[0]!.events.push(event('known-future', newer));
  expect(getRows(merge(retained, thread(old, [event('known-future', newer)])), 'inbox')).toEqual([]);
});

test('an in-flight snapshot with activity newer than the captured source boundary survives archive before response', () => {
  const state = archived();
  const response = thread('2026-09-11T17:59:59Z', [event('in-flight', '2026-09-11T17:59:59Z')]);
  expect(getRows(merge(state, response, '2026-09-11T17:59:00Z'), 'inbox')).toHaveLength(1);
});

test('new activity survives acknowledgement confirmation, relaunch and explicit local restore', () => {
  let state = archived();
  state = beginOperation(state, { id: 'ack', threadId: '123', action: 'done', eventIds: ['original'], notificationUpdatedAt: old });
  state = merge(state, thread(newer, [event('new', newer)]));
  state = finishOperation(state, 'ack', { confirmedAt: newer });
  expect(getRows(state, 'inbox')).toHaveLength(1);
  expect(getRow(state, 't:123')!.events.map(event => event.id)).toEqual(['new']);
  expect(state.handled).toEqual(['original']);
  expect(state.threads[0]!.notification).toBe('unread');
  state = restoreDesktop(state, newer);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  expect(state.notes[0]!.text).toBe('Keep my private context');
  expect(state.tasks[0]!.status).toBe('done');
});

test('unloaded capture placeholders stay local through old hydration/promotion and can later receive new activity', () => {
  let state = emptyWorkspace(archivedAt, 'UTC');
  state.threads = [{ ...thread(), id: 'capture:octo/project:1', notificationUpdatedAt: undefined, events: [], archive: null }];
  state = transition(state, { type: 'note', threadId: state.threads[0]!.id, text: 'Placeholder note' });
  state = transition(state, { type: 'archive', threadId: state.threads[0]!.id });
  expect(() => beginOperation(state, { id: 'invalid', threadId: state.threads[0]!.id, action: 'done', eventIds: [] })).toThrow();
  state = merge(state);
  expect(state.threads).toHaveLength(1);
  expect(getRows(state, 'archive')).toHaveLength(1);
  expect(state.notes[0]).toMatchObject({ threadId: '123', text: 'Placeholder note' });
  state = merge(restoreDesktop(state, newer), thread(newer));
  expect(getRows(state, 'inbox')).toHaveLength(1);
});

test('pre-archive v3 retained threads migrate once, using source time and preserving explicit restore across reload', () => {
  const state = emptyWorkspace(archivedAt, 'UTC');
  state.threads = [{ ...thread(), notification: 'done', notificationUpdatedAt: undefined, sourceMetadata: { updatedAt: old } }];
  const migrated = migrateWorkspace(state);
  expect(getRows(migrated, 'archive')).toHaveLength(1);
  expect(migrated.threads[0]!.archive!.notificationUpdatedAt).toBe(old);
  const restored = transition(migrated, { type: 'restore-thread', threadId: '123' });
  expect(getRows(restoreDesktop(restored, newer), 'inbox')).toHaveLength(1);
});
