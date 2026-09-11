import { expect, test } from 'bun:test';
import type { Activity, AppState, Thread } from '../types.ts';
import { getRow, getRows, transition } from './engine.ts';
import { applyCaptureProposal, applyScopedSuggestedOrder, applySuggestedOrder, beginOperation, captureFingerprint, emptyWorkspace, finishOperation, mergeRefresh, orderFingerprint, reminderSchedules, restoreDesktop } from './live.ts';

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
  const missing = mergeRefresh(state, { threads: [], startedAt: now, fetchedAt: now, status: 'partial', diagnostics: ['Timeline unavailable'] });
  expect(missing.actions).toEqual(state.actions);
  expect(missing.threads[0]!.events[0]!.requestState).toBe('uncertain');
  expect(missing.threads[0]!.events[0]!.id).toBe(state.threads[0]!.events[0]!.id);
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

test('timeline rollover and failed enrichment retain raw history without claiming an omitted request is current', () => {
  for (const coverage of ['partial', 'unavailable', 'complete'] as const) {
    let state = loaded();
    const fetched = { ...thread([event('ordinary', 'comment')]),
      coverage: { timeline: coverage, newestPage: coverage !== 'unavailable', fetchedPages: coverage === 'unavailable' ? 0 : 1, observedAt: now } };
    state = mergeRefresh(state, { threads: [fetched], startedAt: now, fetchedAt: now, status: coverage === 'complete' ? 'complete' : 'partial', diagnostics: [] });
    expect(getRow(state, 't:123')?.kind).toBe('update');
    expect(getRow(state, 't:123')?.reason).toContain('Incomplete');
    expect(state.threads[0]!.events.find(event => event.id === 'request')).toMatchObject({
      id: 'request', kind: 'review-request', rawKind: 'review-request', requestState: 'uncertain',
    });
  }
  let retained = transition(loaded(), { type: 'start', key: 't:123' });
  retained = transition(retained, { type: 'edit', key: `a:${retained.activeId}`, notes: 'Chosen work survives' });
  const actions = structuredClone(retained.actions);
  retained = refresh(retained, [event('ordinary', 'comment')]);
  expect(retained.actions).toEqual(actions);
  expect(retained.activeId).toBe(actions[0]!.id);
  expect(getRow(retained, `a:${actions[0]!.id}`)?.kind).toBe('review');
});

test('a fresh authoritative resubscription supersedes unsubscribe but an older in-flight response cannot', () => {
  let state = beginOperation(loaded(), { id: 'unsub', threadId: '123', action: 'unsubscribe', eventIds: ['request'] });
  state = finishOperation(state, 'unsub', { confirmedAt: '2026-09-11T17:01:00Z' });
  const delayed = { threads: [thread([event(), event('ordinary', 'comment')])],
    startedAt: now, fetchedAt: '2026-09-11T17:02:00Z', status: 'complete' as const, diagnostics: [] };
  state = mergeRefresh(state, delayed);
  expect(state.threads[0]!.subscription).toBe('unsubscribed');
  expect(getRows(state)).toEqual([]);
  expect(state.handled).not.toContain('ordinary');
  state = mergeRefresh(state, { ...delayed, startedAt: '2026-09-11T17:03:00Z', fetchedAt: '2026-09-11T17:04:00Z' });
  expect(state.threads[0]!.subscription).toBe('subscribed');
  expect(getRows(state)[0]!.events.map(event => event.id)).toContain('ordinary');
  expect(state.handled).not.toContain('ordinary');
  state = mergeRefresh(state, { ...delayed, threads: [{ ...thread(), subscription: 'unsubscribed' }] });
  expect(state.threads[0]!.subscription).toBe('subscribed');
});

test('restore rejects evidence references belonging to another thread', () => {
  const state = transition(loaded(), { type: 'start', key: 't:123' });
  state.threads.push({ ...thread(), id: '456', events: [{ ...event('foreign'), threadId: '456' }] });
  state.actions[0]!.eventIds = ['foreign'];
  expect(() => restoreDesktop(state, now)).toThrow('inconsistent references');
});

test('bounded suggestions compose a full permutation, preserve omitted slots within tiers and prioritize excluded due work', () => {
  let state = emptyWorkspace(now, 'UTC');
  const threads = Array.from({ length: 35 }, (_, index) => {
    const id = String(index + 100);
    return { ...thread(), id, number: index + 1, events: [{ ...event(`e:${id}`, index % 2 ? 'comment' : 'review-request'), threadId: id }] };
  });
  state = mergeRefresh(state, { threads, startedAt: now, fetchedAt: now, status: 'complete', diagnostics: [] });
  state = transition(state, { type: 'draft', text: 'Local routine never sent as notification evidence' });
  state = transition(state, { type: 'capture' });
  const routineKey = state.selectedKey!;
  state = transition(state, { type: 'routine', key: routineKey, time: '17:00', timeZone: 'UTC', steps: ['Act'] });
  state = transition(state, { type: 'draft', text: 'Local capture omitted from notification triage' });
  state = transition(state, { type: 'capture' });
  const captureKey = state.selectedKey!;
  state = transition(state, { type: 'start', key: captureKey });
  const before = getRows(state).map(row => row.key);
  const selected = before.filter(key => key.startsWith('t:')).slice(0, 10);
  const ordered = [...selected].reverse();
  const next = applyScopedSuggestedOrder(state, orderFingerprint(state), selected, ordered);
  const after = getRows(next).map(row => row.key);
  expect(new Set(after)).toEqual(new Set(before));
  expect(after[0]).toBe(routineKey);
  expect(next.activeId).toBe(state.activeId);
  expect(next.selectedKey).toBe(captureKey);
  expect(next.actions).toEqual(state.actions);
  const reviewKeys = threads.filter((_, index) => index % 2 === 0).map(thread => `t:${thread.id}`);
  const infoKeys = threads.filter((_, index) => index % 2 === 1).map(thread => `t:${thread.id}`);
  expect(Math.max(...reviewKeys.map(key => after.indexOf(key)))).toBeLessThan(Math.min(...infoKeys.map(key => after.indexOf(key))));
  for (const tier of [reviewKeys, infoKeys]) {
    const omitted = tier.filter(key => !selected.includes(key));
    expect(after.filter(key => omitted.includes(key))).toEqual(before.filter(key => omitted.includes(key)));
    expect(after.filter(key => tier.includes(key) && selected.includes(key))).toEqual(ordered.filter(key => tier.includes(key)));
  }
  for (const malformed of [selected.slice(1), [...selected, 'invented'], selected.map(() => selected[0]!)]) {
    expect(() => applyScopedSuggestedOrder(state, orderFingerprint(state), selected, malformed)).toThrow('exactly once');
  }
});
