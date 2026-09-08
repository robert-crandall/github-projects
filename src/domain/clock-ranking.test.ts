import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, dateAtTime, nextDailyDue, outstanding, reconcileClock, timestamp } from './clock.ts';
import { applyCommand } from './engine.ts';
import { createInitialState, INITIAL_CLOCK } from './fixtures.ts';
import { isActionable, rankedItems, recommendationReason } from './ranking.ts';
import type { AppState, WorkItem } from './types.ts';

const get = (state: AppState, id = 'daily-routine'): WorkItem => state.items.find(item => item.id === id)!;
const reload = (state: AppState): AppState => JSON.parse(JSON.stringify(state));
const due = (): AppState => applyCommand(createInitialState(), { type: 'scenario', scenario: 'due' });

test('fixtures are deterministic, independent, explicitly synthetic, and complete', () => {
  const state = createInitialState();
  assert.equal(state.clock, INITIAL_CLOCK);
  assert.equal(state.sync.lastSuccessAt, INITIAL_CLOCK);
  assert.equal(state.captures.length, 0);
  assert.deepEqual(state.items.map(item => item.id), [
    'direct-review', 'team-review', 'ci-fix', 'mention', 'manual-task',
    'daily-routine', 'deferred-task', 'waiting-task',
  ]);
  assert.equal(get(state, 'manual-task').sources[0].kind, 'capture');
  assert.equal(get(state, 'direct-review').title, 'Review the retry backoff fix');
  assert.deepEqual(get(state, 'direct-review').review, {
    identity: 'demo://github/harbor/pull/42', request: 'direct', lines: 18, files: 2,
  });
  assert.equal(get(state, 'team-review').review?.lines, 32);
  assert.equal(get(state, 'team-review').review?.team, 'integrations/terraform-provider-core-maintainers');
  assert.notEqual(get(state, 'team-review').review?.identity, get(state, 'direct-review').review?.identity);
  assert.match(get(state, 'mention').evidence!, /may need a reply/);
  for (const source of state.items.flatMap(item => item.sources)) {
    if (source.reference) assert.ok(source.reference.startsWith('demo://github/'));
  }
  get(state).steps[0].title = 'Not shared';
  assert.equal(get(createInitialState()).steps[0].title, 'Announce change');
});

test('initial recommendation is a small direct review, not an unsorted list', () => {
  const state = createInitialState();
  assert.deepEqual(rankedItems(state).map(item => item.id), [
    'direct-review', 'team-review', 'ci-fix', 'manual-task', 'mention',
  ]);
  assert.equal(recommendationReason(rankedItems(state)[0], state), 'Small review; directly requested.');
  assert.match(recommendationReason(get(state, 'team-review'), state), /your team/);
  assert.match(recommendationReason(get(state, 'mention'), state), /not a confirmed request/);
});

test('priority keeps an actionable active action through arrivals and due routines', () => {
  let state = applyCommand(createInitialState(), { type: 'start', id: 'manual-task' });
  state = applyCommand(state, { type: 'scenario', scenario: 'arrival' });
  state = applyCommand(state, { type: 'scenario', scenario: 'due' });
  assert.equal(state.activeId, 'manual-task');
  assert.deepEqual(rankedItems(state).slice(0, 2).map(item => item.id), ['manual-task', 'daily-routine']);
  assert.match(recommendationReason(get(state, 'manual-task'), state), /active action/);
  const sameArrival = applyCommand(state, { type: 'scenario', scenario: 'arrival' });
  assert.equal(sameArrival.items.filter(item => item.id === 'new-review').length, 1);
  state = applyCommand(state, { type: 'pause' });
  assert.equal(rankedItems(state)[0].id, 'daily-routine');
});

test('small-review evidence is required, inclusive at 50, with direct before team', () => {
  const state = createInitialState();
  const review = get(state, 'direct-review');
  state.items = [
    { ...review, id: 'large', review: { request: 'direct', lines: 51 } },
    { ...review, id: 'unknown', review: { request: 'direct' } },
    { ...review, id: 'negative', review: { request: 'direct', lines: -1 } },
    { ...review, id: 'nan', review: { request: 'direct', lines: Number.NaN } },
    { ...review, id: 'manual', review: { request: 'manual', lines: 1 } },
    { ...review, id: 'team', review: { request: 'team', lines: 1 }, updatedAt: '2020-01-01T00:00:00Z' },
    { ...review, id: 'direct', review: { request: 'direct', lines: 50 } },
    { ...review, id: 'zero', review: { request: 'direct', lines: 0 } },
  ];
  assert.deepEqual(rankedItems(state).map(item => item.id), [
    'direct', 'zero', 'team', 'manual', 'large', 'nan', 'negative', 'unknown',
  ]);
});

test('ties use older updatedAt, then deterministic item ID without mutating items', () => {
  const state = createInitialState();
  const task = get(state, 'manual-task');
  state.items = [
    { ...task, id: 'z' }, { ...task, id: 'a' },
    { ...task, id: 'older', updatedAt: '2026-09-01T00:00:00.000Z' },
  ];
  const original = JSON.stringify(state);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['older', 'a', 'z']);
  assert.equal(JSON.stringify(state), original);
});

test('unlinked and large reviews precede fixes, tasks, and uncertain mentions', () => {
  const state = createInitialState();
  get(state, 'direct-review').review = { request: 'manual' };
  get(state, 'team-review').review!.lines = 200;
  assert.deepEqual(rankedItems(state).map(item => item.id), [
    'team-review', 'direct-review', 'ci-fix', 'manual-task', 'mention',
  ]);
});

test('future, deferred, waiting, completed, removed, and dormant routines are not actionable', () => {
  const state = createInitialState();
  for (const status of ['deferred', 'waiting', 'completed', 'removed'] as const) {
    const item = { ...get(state, 'direct-review'), status };
    assert.equal(isActionable(item, state), false);
    state.activeId = item.id;
    assert.equal(rankedItems({ ...state, items: [item] }).length, 0);
  }
  assert.equal(isActionable({ ...get(state, 'manual-task'), availableAt: addDays(state.clock, 1) }, state), false);
  assert.equal(isActionable(get(state), state), false);
  assert.equal(isActionable({ ...get(state, 'manual-task'), availableAt: state.clock }, state), true);
});

test('UTC clock helpers are fixed-timezone, validate times, and roll days forward', () => {
  assert.equal(dateAtTime(INITIAL_CLOCK, '10:00'), '2026-09-08T10:00:00.000Z');
  assert.equal(nextDailyDue(INITIAL_CLOCK, '10:00'), '2026-09-08T10:00:00.000Z');
  assert.equal(nextDailyDue('2026-09-08T10:00:00Z', '10:00'), '2026-09-09T10:00:00.000Z');
  assert.equal(nextDailyDue('2026-12-31T23:59:00Z', '00:00'), '2027-01-01T00:00:00.000Z');
  assert.equal(timestamp('2026-09-08T10:00'), timestamp('2026-09-08T10:00:00Z'));
  assert.equal(dateAtTime('2026-09-08T23:00:00-07:00', '10:00'), '2026-09-09T10:00:00.000Z');
  assert.throws(() => dateAtTime(INITIAL_CLOCK, '24:00'), /HH:mm/);
  assert.throws(() => timestamp('not a date'), /valid date/);
  assert.throws(() => timestamp('2026-02-30T10:00:00Z'), /valid date/);
  assert.throws(() => timestamp('09/08/2026'), /ISO format/);
  assert.equal(timestamp('2026-09-08'), timestamp('2026-09-08T00:00:00Z'));
});

test('the threshold creates one occurrence and one reminder exactly once', () => {
  let state = reconcileClock(createInitialState(), '2026-09-08T09:59:59.999Z');
  assert.equal(outstanding(get(state)), undefined);
  state = reconcileClock(state, '2026-09-08T10:00:00Z');
  const occurrence = outstanding(get(state))!;
  assert.equal(occurrence.dueAt, '2026-09-08T10:00:00.000Z');
  assert.equal(occurrence.reminderAt, occurrence.dueAt);
  assert.equal(get(state).routine!.nextDueAt, '2026-09-09T10:00:00.000Z');
  assert.deepEqual(reconcileClock(reload(state), state.clock), state);
  assert.equal(rankedItems(state)[0].id, 'daily-routine');
});

test('missing three days retains one original outstanding occurrence and records missed days', () => {
  const initial = due();
  const state = applyCommand(initial, { type: 'scenario', scenario: 'missed' });
  const history = get(state).routine!.occurrences;
  assert.equal(state.clock, '2026-09-11T10:00:00.000Z');
  assert.equal(history.length, 4);
  assert.deepEqual(history.map(occurrence => occurrence.status), ['outstanding', 'missed', 'missed', 'missed']);
  assert.equal(history.filter(occurrence => occurrence.reminderAt).length, 1);
  assert.deepEqual(history[0], outstanding(get(initial)));
  assert.equal(get(state).routine!.nextDueAt, '2026-09-12T10:00:00.000Z');
  assert.equal(rankedItems(state).filter(item => item.kind === 'routine').length, 1);
});

test('partial steps retain original timestamps across days and JSON reload', () => {
  let state = due();
  state = applyCommand(state, { type: 'start', id: 'daily-routine' });
  state = applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  const original = outstanding(get(state))!;
  const updatedAt = get(state).updatedAt;
  state = reload(applyCommand(state, { type: 'scenario', scenario: 'missed' }));
  assert.deepEqual(outstanding(get(state)), original);
  assert.equal(outstanding(get(state))!.steps[0].doneAt, '2026-09-08T10:00:00.000Z');
  assert.equal(get(state).updatedAt, updatedAt);
  assert.equal(state.activeId, 'daily-routine');
  assert.deepEqual(reconcileClock(state, state.clock), state);
});

test('snooze hides the reminder without regenerating it, then restores discoverability', () => {
  let state = due();
  const reminderAt = outstanding(get(state))!.reminderAt;
  state = applyCommand(state, { type: 'snooze', id: 'daily-routine', minutes: 30 });
  assert.equal(isActionable(get(state), state), false);
  assert.equal(outstanding(get(state))!.reminderDismissed, true);
  state = reconcileClock(reload(state), '2026-09-08T10:29:59Z');
  assert.equal(rankedItems(state).some(item => item.id === 'daily-routine'), false);
  state = reconcileClock(state, '2026-09-08T10:30:00Z');
  assert.equal(rankedItems(state)[0].id, 'daily-routine');
  assert.equal(outstanding(get(state))!.snoozedUntil, undefined);
  assert.equal(outstanding(get(state))!.reminderAt, reminderAt);
  assert.equal(outstanding(get(state))!.reminderDismissed, true);
  state = applyCommand(state, { type: 'snooze', id: 'daily-routine', minutes: 15 });
  state = reconcileClock(reload(state), '2026-09-08T10:45:00Z');
  assert.equal(outstanding(get(state))!.reminderAt, reminderAt);
  assert.equal(get(state).routine!.occurrences.length, 1);
});

test('start, pause, and explicit dismissal never create a second reminder', () => {
  let state = due();
  const original = outstanding(get(state))!.reminderAt;
  state = applyCommand(state, { type: 'start', id: 'daily-routine' });
  state = applyCommand(state, { type: 'pause' });
  assert.equal(outstanding(get(state))!.reminderDismissed, true);
  state = applyCommand(state, { type: 'dismiss-reminder', id: 'daily-routine' });
  state = applyCommand(reload(state), { type: 'scenario', scenario: 'missed' });
  assert.equal(outstanding(get(state))!.reminderAt, original);
  assert.equal(get(state).routine!.occurrences.filter(occurrence => occurrence.reminderAt).length, 1);
});

test('clock reconciliation rejects rewinds and never mutates the previous state', () => {
  const state = due();
  const before = JSON.stringify(state);
  assert.throws(() => reconcileClock(state, INITIAL_CLOCK), /backwards/);
  assert.throws(() => applyCommand(state, { type: 'advance', to: INITIAL_CLOCK }), /backwards/);
  assert.equal(JSON.stringify(state), before);
  reconcileClock(state, addDays(state.clock, 3));
  assert.equal(JSON.stringify(state), before);
});

test('scenario controls move forward without erasing partial work', () => {
  let state = due();
  state = applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  const original = structuredClone(outstanding(get(state)));
  state = applyCommand(state, { type: 'scenario', scenario: 'before' });
  assert.equal(state.clock, '2026-09-09T09:40:00.000Z');
  assert.deepEqual(outstanding(get(state)), original);
  state = applyCommand(state, { type: 'scenario', scenario: 'before' });
  assert.equal(state.clock, '2026-09-09T09:40:00.000Z');
  state = applyCommand(state, { type: 'scenario', scenario: 'due' });
  assert.equal(state.clock, '2026-09-09T10:00:00.000Z');
  state = applyCommand(state, { type: 'scenario', scenario: 'due' });
  assert.equal(state.clock, '2026-09-10T10:00:00.000Z');
  assert.deepEqual(outstanding(get(state)), original);
});
