import { expect, test } from 'bun:test';
import type { Activity, AppState, Thread } from '../types.ts';
import { getRow, getRows, transition } from './engine.ts';
import { applyCaptureProposal, applySuggestedOrder, beginOperation, captureFingerprint, emptyWorkspace, finishOperation, mergeRefresh, orderFingerprint, reminderSchedules, restoreDesktop } from './live.ts';

const now = '2026-09-11T17:00:00Z';
const event = (id = 'request', kind: Activity['kind'] = 'review-request'): Activity => ({
  id, threadId: '123', kind, rawKind: kind, at: now, actor: 'octocat', summary: 'Evidence',
  requestState: kind === 'review-request' ? 'current' : 'not-request',
});
const thread = (events = [event()]): Thread => ({
  id: '123', repo: 'octo/project', number: 1, kind: 'pr', source: 'github', title: 'Requested review',
  reason: 'review_requested', state: 'open', notification: 'unread', subscribed: true, events,
});
const refresh = (state: AppState, events = [event()]) => mergeRefresh(state, { threads: [thread(events)], fetchedAt: now, status: 'complete', diagnostics: [] });
const loaded = () => refresh(emptyWorkspace(now, 'UTC'));

test('desktop initialization is empty, real-clock driven and rejects demo commands and snapshots', () => {
  const state = emptyWorkspace(now, 'UTC');
  expect(state.clock).toBe(now);
  expect(state.threads).toEqual([]);
  expect(state.actions).toEqual([]);
  expect(state.activeId).toBeNull();
  expect(state.selectedKey).toBeNull();
  expect(() => transition(state, { type: 'refresh' })).toThrow('Simulation');
  expect(() => restoreDesktop({ ...state, runtime: undefined }, now)).toThrow('not a live');
});

test('refresh applies to current edits, Done and selection; new commits/queue/sticky reasons never reopen Done', () => {
  let state = loaded();
  state = transition(state, { type: 'edit', key: 't:123', notes: 'Typed while request was in flight' });
  const id = state.actions[0]!.id;
  state = transition(state, { type: 'select', key: `a:${id}` });
  state = transition(state, { type: 'done', key: `a:${id}` });
  for (const kind of ['commit', 'merge-queue', 'comment'] as const) {
    state = refresh(state, [event(), event(kind, kind)]);
    expect(getRow(state, 't:123')?.kind).toBe('update');
    expect(state.actions[0]!.status).toBe('done');
    expect(state.actions[0]!.notes).toBe('Typed while request was in flight');
    expect(state.selectedKey).toBe(`a:${id}`);
  }
  state = refresh(state, [event(), event('new-request')]);
  expect(getRow(state, 't:123')?.kind).toBe('review');
  state = transition(state, { type: 'start', key: 't:123' });
  expect(state.activeId).not.toBe(id);
  expect(state.actions[0]!.status).toBe('done');
});

test('history is preserved and only current confirmed team membership creates review candidates', () => {
  for (const requestState of ['historical', 'uncertain', 'not-request'] as const) {
    const state = refresh(emptyWorkspace(now, 'UTC'), [{ ...event(), requestState }]);
    expect(getRow(state, 't:123')?.kind).toBe('update');
  }
  for (const member of [true, false, undefined]) {
    const evidence: Activity = { ...event(), kind: 'team-request', recipient: { kind: 'team', name: 'real-org/actual-team', viewerIsMember: member } };
    const state = refresh(emptyWorkspace(now, 'UTC'), [evidence]);
    expect(getRow(state, 't:123')?.kind).toBe(member ? 'review' : 'update');
    if (member) expect(getRow(state, 't:123')?.reason).toContain('real-org/actual-team');
  }
  let state = transition(loaded(), { type: 'done', key: 't:123' });
  state = refresh(state, [{ ...event(), requestState: 'historical' }]);
  state = refresh(state, [event('commit', 'commit')]);
  expect(state.threads[0]!.events.find(event => event.id === 'request')?.kind).toBe('review-request');
  expect(state.actions[0]!.eventIds).toEqual(['request']);
});

test('missing and repeatedly fetched threads never erase work or regenerate handled candidates', () => {
  const state = transition(loaded(), { type: 'done', key: 't:123' });
  expect(getRows(refresh(refresh(state)))).toEqual([]);
  const missing = mergeRefresh(state, { threads: [], fetchedAt: now, status: 'partial', diagnostics: ['Timeline unavailable'] });
  expect(missing.actions).toEqual(state.actions);
  expect(missing.threads).toEqual(state.threads);
  expect(missing.refresh.status).toBe('partial');
  expect(missing.refresh.message).toContain('unavailable');
});

test('ack response handles only captured evidence, preserves concurrent request and survives stale refresh plus Undo', () => {
  let state = transition(loaded(), { type: 'start', key: 't:123' });
  const id = state.activeId!;
  state = beginOperation(state, { id: 'ack-1', threadId: '123', action: 'done', eventIds: ['request'] });
  state = refresh(state, [event(), event('later-request')]);
  state = finishOperation(state, 'ack-1', { confirmedAt: now });
  expect(state.handled).toContain('request');
  expect(state.handled).not.toContain('later-request');
  expect(state.threads[0]!.notification).toBe('unread');
  state = refresh(state);
  expect(state.handled).toContain('request');
  expect(state.threads[0]!.events.some(event => event.id === 'later-request')).toBe(true);
  expect(state.actions[0]!.status).toBe('available');
  expect(state.activeId).toBe(id);
  state = transition(state, { type: 'done', key: `a:${id}` });
  state = transition(state, { type: 'undo' });
  expect(state.handled).toContain('request');
});

test('unsubscribe survives in-flight refresh; failed and pending writes remain explicit after restart', () => {
  let state = beginOperation(loaded(), { id: 'unsub', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  const restored = restoreDesktop(state, now);
  expect(restored.operations[0]!.status).toBe('uncertain');
  state = finishOperation(state, 'unsub', { error: 'Network failed' });
  expect(state.operations[0]!.status).toBe('failed');
  expect(state.threads[0]!.subscribed).toBe(true);
  state = beginOperation(state, { id: 'retry', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  state = finishOperation(state, 'retry', { confirmedAt: now });
  state = refresh(state, [event(), event('comment', 'comment')]);
  expect(state.threads[0]!.subscribed).toBe(false);
  expect(getRows(state)).toEqual([]);
  state = refresh(state, [event('new-request')]);
  expect(getRow(state, 't:123')?.kind).toBe('review');
  expect(state.threads[0]!.subscribed).toBe(false);
});

test('future routines are registered before due; snooze keeps original occurrence and current work is excluded', () => {
  let state = transition(emptyWorkspace(now, 'UTC'), { type: 'draft', text: 'Daily work' });
  state = transition(state, { type: 'capture' });
  const key = state.selectedKey!;
  state = transition(state, { type: 'routine', key, time: '18:00', timeZone: 'UTC', steps: ['Announce', 'Increase'] });
  const schedule = reminderSchedules(state)[0]!;
  expect(schedule.dueAt).toBe('2026-09-11T18:00:00Z');
  expect(schedule.daily).toEqual({ time: '18:00', timeZone: 'UTC' });
  state = transition(state, { type: 'clock', now: schedule.dueAt });
  state = transition(state, { type: 'reminder', key, action: 'snooze' });
  expect(reminderSchedules(state)[0]!.occurrenceId).toBe(schedule.occurrenceId);
  expect(reminderSchedules(state)[0]!.snoozedUntil).toBe('2026-09-11T18:30:00Z');
  state = transition(state, { type: 'start', key });
  expect(reminderSchedules(state)).toEqual([]);
});

test('suggested order rejects stale evidence, changed local intent, invented IDs and missing candidates', () => {
  const state = loaded();
  const fingerprint = orderFingerprint(state);
  expect(applySuggestedOrder(state, fingerprint, ['t:123']).actions).toEqual(state.actions);
  for (const ids of [[], ['invented'], ['t:123', 't:123']]) {
    expect(() => applySuggestedOrder(state, fingerprint, ids)).toThrow('every candidate');
  }
  const changed = transition(state, { type: 'edit', key: 't:123', notes: 'Private note' });
  expect(() => applySuggestedOrder(changed, fingerprint, ['t:123'])).toThrow('changed');
  expect(() => applySuggestedOrder(refresh(state, [event('new-request')]), fingerprint, ['t:123'])).toThrow('changed');
});

test('capture preview preserves originals and edits, matches only outstanding work and rejects changed targets', () => {
  let state = transition(loaded(), { type: 'start', key: 't:123' });
  const activeId = state.activeId;
  state = transition(state, { type: 'edit', key: `a:${activeId}`, notes: 'Existing note' });
  const capture = () => {
    state = transition(state, { type: 'draft', text: '  Review https://github.com/octo/project/pull/1  ' });
    state = transition(state, { type: 'capture' });
    return state.selectedKey!;
  };
  const proposal = { kind: 'action' as const, title: 'Review', steps: [], dailyAt: null, timeZone: 'UTC', uncertainty: '' };
  let key = capture();
  const stale = captureFingerprint(state, key);
  state = transition(state, { type: 'edit', key, notes: 'New note' });
  expect(() => applyCaptureProposal(state, key, stale, proposal)).toThrow('changed');
  state = applyCaptureProposal(state, key, captureFingerprint(state, key), proposal);
  expect(state.activeId).toBe(activeId);
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0]!.notes).toBe('Existing note\n\nNew note');
  expect(state.actions[0]!.captures).toEqual(['  Review https://github.com/octo/project/pull/1  ']);
  state = transition(state, { type: 'done', key: `a:${activeId}` });
  key = capture();
  state = applyCaptureProposal(state, key, captureFingerprint(state, key), proposal);
  expect(state.actions).toHaveLength(2);
  expect(state.actions[0]!.status).toBe('done');
  expect(state.actions[1]!.id).not.toBe(activeId);
});

test('local reminder snooze retains occurrence identity across relaunch', () => {
  let state = transition(loaded(), { type: 'later', key: 't:123', remindAt: '2026-09-11T17:10:00Z' });
  const schedule = reminderSchedules(state)[0]!;
  state = transition(state, { type: 'clock', now: schedule.dueAt });
  state = transition(state, { type: 'reminder', key: `a:${state.actions[0]!.id}`, action: 'snooze' });
  state = restoreDesktop(state, '2026-09-11T17:20:00Z');
  expect(reminderSchedules(state)[0]!.occurrenceId).toBe(schedule.occurrenceId);
  expect(reminderSchedules(state)[0]!.snoozedUntil).toBe('2026-09-11T17:40:00Z');
});
