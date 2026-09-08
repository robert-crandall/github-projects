import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubPing, GitHubSnapshot } from '../desktop-contract.ts';
import { isAppState } from '../storage.ts';
import { applyCommand } from './engine.ts';
import { createDesktopState } from './live.ts';
import { rankedItems, recommendationReason } from './ranking.ts';
import { canonicalGitHubReference, githubReferences } from './sleep.ts';
import type { AppState, WorkItem } from './types.ts';

const NOW = '2026-09-08T18:00:00.000Z';
const LATER = '2026-09-08T19:00:00.000Z';
const URL = 'https://github.com/octo/repo/issues/42';
const issue = (changes: Partial<WorkItem> = {}): WorkItem => ({
  id: `github:${URL}:reply`, kind: 'mention', title: 'Clarify the issue', status: 'available',
  createdAt: NOW, updatedAt: NOW, notes: 'Keep my context.', steps: [{ id: 'read', title: 'Read the proposal', doneAt: NOW }],
  nextStep: 'Reply to the question.',
  sources: [{ id: 'mention', kind: 'github', label: 'Mentioned', reference: URL }], ...changes,
});
const id = issue().id;
const get = (state: AppState) => state.items.find(item => item.id === id)!;
const refresh = (state: AppState, pings: GitHubPing[] = [], items = [issue()], fetchedAt = LATER) =>
  applyCommand(state, { type: 'github-sync', snapshot: { fetchedAt, login: 'me', items, warnings: [], pings } });
const initial = () => refresh(createDesktopState(NOW), [], [issue()], NOW);
const sleep = (state = initial(), wakeOnPing = true, until?: string) =>
  applyCommand(state, { type: 'sleep', id, wakeOnPing, until });
const ping = (kind: GitHubPing['kind'] = 'mention', at = '2026-09-08T18:05:00.000Z'): GitHubPing =>
  ({ kind, at, reference: URL });

test('sleep hides work, clears active focus, and preserves local context across reload and refresh', () => {
  let state = applyCommand(initial(), { type: 'start', id });
  state = sleep(state);
  assert.equal(state.activeId, undefined);
  assert.equal(get(state).status, 'deferred');
  assert.deepEqual(get(state).sleep, { since: NOW, wakeOnPing: true });
  assert.equal(get(state).notes, 'Keep my context.');
  assert.equal(get(state).steps[0].doneAt, NOW);
  assert.equal(isAppState(state), true);
  state = refresh(JSON.parse(JSON.stringify(state)), [], [issue({ updatedAt: LATER })]);
  assert.deepEqual(rankedItems(state), []);
  assert.equal(get(state).status, 'deferred');
});

test('new direct mentions and review requests wake sleeping work even outside discovery windows', () => {
  for (const kind of ['mention', 'review-request'] as const) {
    let state = refresh(sleep(), [ping(kind)], []);
    assert.equal(get(state).status, 'available');
    assert.equal(get(state).sleep, undefined);
    assert.equal(get(state).availableAt, undefined);
    assert.deepEqual(get(state).wake, { reason: kind, at: ping(kind).at });
    assert.equal(get(state).signalCurrent, false);
    assert.deepEqual(rankedItems(state).map(item => item.id), [id]);
    assert.match(recommendationReason(get(state), state), /Awake:/);
    state = refresh(JSON.parse(JSON.stringify(state)), [], []);
    assert.deepEqual(rankedItems(state).map(item => item.id), [id]);
  }
});

test('old pings, unrelated sources, time-only sleep, and ordinary updates do not wake work', () => {
  const oldPings = [ping('mention', NOW), ping('review-request', '2026-09-07T18:00:00Z'),
    { ...ping(), reference: 'https://github.com/octo/repo/pull/42' }];
  assert.equal(get(refresh(sleep(), oldPings)).status, 'deferred');
  assert.equal(get(refresh(sleep(initial(), false, LATER), [ping()], [issue()], '2026-09-08T18:10:00Z')).status, 'deferred');
  assert.equal(get(refresh(sleep(initial(), false), [ping()])).status, 'deferred');
  assert.equal(get(refresh(sleep(), [], [issue({ updatedAt: LATER })])).status, 'deferred');
});

test('sleeping again establishes a new cutoff and does not replay the previous ping', () => {
  let state = refresh(sleep(), [ping()]);
  state = applyCommand(state, { type: 'advance', to: '2026-09-08T18:10:00Z' });
  state = sleep(state);
  assert.equal(get(state).wake, undefined);
  assert.equal(get(refresh(state, [ping()])).status, 'deferred');
  state = refresh(state, [ping('mention', '2026-09-08T18:20:00Z')]);
  assert.equal(get(state).status, 'available');
});

test('a late refresh cannot wake a newer sleep decision or alter completed and waiting work', () => {
  let state = applyCommand(sleep(), { type: 'advance', to: LATER });
  state = sleep(state);
  state = refresh(state, [ping()]);
  assert.equal(get(state).status, 'deferred');
  assert.equal(get(state).sleep?.since, LATER);
  for (const decision of ['wait', 'remove'] as const) {
    let changed = applyCommand(sleep(), decision === 'wait'
      ? { type: 'wait', id, reason: 'Waiting for approval.' } : { type: 'remove', id });
    assert.equal(get(changed).sleep, undefined);
    changed = refresh(changed, [ping()]);
    assert.equal(get(changed).status, decision === 'wait' ? 'waiting' : 'removed');
  }
});

test('the first ping or scheduled time wakes work without replacing another active action', () => {
  let state = sleep(initial(), true, LATER);
  state = applyCommand(state, { type: 'capture', id: 'other', text: 'Keep writing' });
  state = applyCommand(state, { type: 'start', id: 'capture-other' });
  state = refresh(state, [ping()]);
  assert.equal(get(state).wake?.reason, 'mention');
  assert.equal(state.activeId, 'capture-other');
  assert.equal(rankedItems(state)[0].id, 'capture-other');
  assert.equal(get(state).availableAt, undefined);
  const timed = refresh(sleep(initial(), true, '2026-09-08T18:01:00Z'), [ping()]);
  assert.equal(get(timed).wake?.reason, 'time');
});

test('scheduled wake-up remains actionable when a GitHub search no longer returns the issue', () => {
  let state = refresh(sleep(initial(), false, LATER), [], [], NOW);
  state = applyCommand(state, { type: 'advance', to: LATER });
  assert.equal(get(state).status, 'available');
  assert.equal(get(state).sleep, undefined);
  assert.equal(get(state).wake?.reason, 'time');
  assert.deepEqual(rankedItems(state).map(item => item.id), [id]);
  state = refresh(state, [], []);
  assert.deepEqual(rankedItems(state).map(item => item.id), [id]);
  state = applyCommand(state, { type: 'advance', to: NOW });
  assert.equal(get(state).status, 'available');
});

test('a changed GitHub discovery bucket cannot bypass sleep or create competing work after waking', () => {
  const assigned = issue({ id: `github:${URL}:task`, kind: 'task' });
  let state = refresh(sleep(), [], [assigned]);
  assert.equal(state.items.length, 1);
  assert.equal(get(state).status, 'deferred');
  assert.deepEqual(rankedItems(state), []);
  state = refresh(state, [ping()], [assigned]);
  state = refresh(state, [], [assigned]);
  assert.equal(state.items.length, 1);
  assert.equal(get(state).kind, 'mention');
  assert.equal(get(state).status, 'available');
  state = applyCommand(state, { type: 'start', id });
  state = applyCommand(state, { type: 'complete', id });
  state = refresh(state, [ping()], [assigned]);
  assert.equal(get(state).status, 'completed');
  assert.deepEqual(rankedItems(state), []);
});

test('sleep and manual wake are undoable without losing notes or later wake events', () => {
  let state = applyCommand(sleep(), { type: 'notes', id, text: 'Written while sleeping.' });
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state).status, 'available');
  assert.equal(get(state).sleep, undefined);
  assert.equal(get(state).notes, 'Written while sleeping.');
  state = sleep(state);
  state = applyCommand(state, { type: 'restore', id });
  assert.equal(get(state).wake?.reason, 'manual');
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state).status, 'deferred');
  assert.ok(get(state).sleep);
  assert.equal(isAppState(state), true);
  state = refresh(state, [ping()]);
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state).status, 'available');
  assert.equal(get(state).sleep, undefined);
  assert.equal(get(state).wake?.reason, 'mention');
});

test('local tasks can sleep until a time or manual wake, but cannot enable GitHub pings', () => {
  let state = applyCommand(createDesktopState(NOW), { type: 'capture', id: 'local', text: 'Write notes' });
  assert.throws(() => applyCommand(state, { type: 'sleep', id: 'capture-local', wakeOnPing: true }), /linked GitHub/);
  state = applyCommand(state, { type: 'sleep', id: 'capture-local', wakeOnPing: false, until: LATER });
  assert.deepEqual(rankedItems(state), []);
  state = applyCommand(state, { type: 'advance', to: LATER });
  assert.deepEqual(rankedItems(state).map(item => item.id), ['capture-local']);
  assert.throws(() => sleep(initial(), false, NOW), /future/);
  assert.throws(() => sleep(initial(), false, 'not-a-date'), /valid date/);
});

test('sleeping routines keep partial steps without accumulating catch-up work', () => {
  let state = applyCommand(createDesktopState(NOW), { type: 'capture', id: 'daily', text: 'Daily check' });
  state = applyCommand(state, {
    type: 'edit', id: 'capture-daily', title: 'Daily check', nextStep: 'Inspect',
    routineTime: '19:00', routineTimeZone: 'UTC', routineSteps: ['Inspect', 'Report'],
  });
  state = applyCommand(state, { type: 'advance', to: LATER });
  state = applyCommand(state, { type: 'step', id: 'capture-daily', stepId: 'step-1', done: true });
  state = applyCommand(state, { type: 'sleep', id: 'capture-daily', wakeOnPing: false, until: '2026-09-11T18:00:00Z' });
  state = applyCommand(state, { type: 'advance', to: '2026-09-11T18:00:00Z' });
  const routine = state.items[0].routine!;
  assert.equal(state.items[0].status, 'available');
  assert.equal(routine.occurrences.length, 1);
  assert.equal(routine.occurrences[0].steps[0].doneAt, LATER);
  assert.equal(routine.nextDueAt, '2026-09-11T19:00:00.000Z');
});

test('sleep links and stored metadata reject malformed values and unsafe references', () => {
  assert.equal(canonicalGitHubReference('https://github.com/Octo/Repo/issues/42'), URL);
  assert.equal(canonicalGitHubReference(`${URL}?redirect=elsewhere`), undefined);
  assert.equal(canonicalGitHubReference('https://evil.test/octo/repo/issues/42'), undefined);
  assert.deepEqual(githubReferences(issue()), [URL]);
  for (const invalid of [{ since: 'broken', wakeOnPing: true }, { since: NOW, wakeOnPing: 'true' }, null]) {
    const state = JSON.parse(JSON.stringify(sleep()));
    state.items[0].sleep = invalid;
    assert.equal(isAppState(state), false);
  }
  const invalidState = sleep();
  get(invalidState).status = 'available';
  assert.equal(isAppState(invalidState), false);
  const badWake = JSON.parse(JSON.stringify(initial()));
  badWake.items[0].wake = { at: NOW, reason: 'any-update' };
  assert.equal(isAppState(badWake), false);
});

test('GitHub cannot supply local sleep decisions or malformed or future pings', () => {
  for (const item of [issue({ sleep: { since: NOW, wakeOnPing: true } }), issue({ wake: { at: NOW, reason: 'manual' } })]) {
    assert.throws(() => refresh(initial(), [], [item]), /GitHub/);
  }
  for (const invalid of [{ ...ping(), at: 'bad' }, { ...ping(), at: '2027-01-01T00:00:00Z' },
    { ...ping(), reference: 'https://evil.test/42' }, { ...ping(), kind: 'updated' }, null]) {
    const snapshot = JSON.parse(JSON.stringify({ fetchedAt: LATER, login: 'me', items: [], warnings: [], pings: [invalid] })) as GitHubSnapshot;
    assert.throws(() => applyCommand(sleep(), { type: 'github-sync', snapshot }));
  }
});
