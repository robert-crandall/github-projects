import assert from 'node:assert/strict';
import test from 'node:test';
import { outstanding, reconcileClock } from './clock.ts';
import { applyCommand } from './engine.ts';
import { createInitialState, INITIAL_CLOCK } from './fixtures.ts';
import { isActionable, rankedItems } from './ranking.ts';
import type { AppState, Command, WorkItem } from './types.ts';

const get = (state: AppState, id = 'daily-routine'): WorkItem => state.items.find(item => item.id === id)!;
const due = (): AppState => applyCommand(createInitialState(), { type: 'scenario', scenario: 'due' });
const reload = (state: AppState): AppState => JSON.parse(JSON.stringify(state));

function run(state: AppState, ...commands: Command[]): AppState {
  return commands.reduce(applyCommand, state);
}

function finishSteps(state: AppState): AppState {
  return run(state,
    { type: 'step', id: 'daily-routine', stepId: 'announce', done: true },
    { type: 'step', id: 'daily-routine', stepId: 'increase', done: true },
  );
}

test('routine progress enforces order in both directions and requires all steps to complete', () => {
  let state = due();
  assert.throws(() => applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'increase', done: true }), /earlier/);
  assert.throws(() => applyCommand(state, { type: 'complete', id: 'daily-routine' }), /every routine step/);
  state = applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  assert.throws(() => applyCommand(state, { type: 'complete', id: 'daily-routine' }), /every routine step/);
  state = applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'increase', done: true });
  assert.throws(() => applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'announce', done: false }), /later/);
  state = run(state,
    { type: 'step', id: 'daily-routine', stepId: 'increase', done: false },
    { type: 'step', id: 'daily-routine', stepId: 'announce', done: false },
  );
  assert.ok(outstanding(get(state))!.steps.every(step => !step.doneAt));
});

test('rechecking a step preserves its original completion timestamp', () => {
  let state = applyCommand(due(), { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  state = reconcileClock(state, '2026-09-08T10:20:00Z');
  state = applyCommand(state, { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  assert.equal(outstanding(get(state))!.steps[0].doneAt, '2026-09-08T10:00:00.000Z');
});

test('ordinary checklists allow independent checkboxes and local completion', () => {
  let state = applyCommand(createInitialState(), { type: 'step', id: 'ci-fix', stepId: 'fix', done: true });
  assert.equal(get(state, 'ci-fix').steps[0].doneAt, undefined);
  assert.equal(get(state, 'ci-fix').steps[1].doneAt, INITIAL_CLOCK);
  state = applyCommand(state, { type: 'complete', id: 'ci-fix' });
  assert.equal(get(state, 'ci-fix').status, 'completed');
  assert.equal(get(state, 'ci-fix').completedAt, INITIAL_CLOCK);
});

test('completing a routine finishes its local occurrence, not the recurrence definition', () => {
  let state = run(due(), { type: 'start', id: 'daily-routine' });
  state = finishSteps(state);
  state = applyCommand(state, { type: 'complete', id: 'daily-routine' });
  const routine = get(state);
  assert.equal(routine.status, 'available');
  assert.equal(routine.completedAt, undefined);
  assert.equal(state.activeId, undefined);
  assert.equal(routine.routine!.occurrences[0].status, 'completed');
  assert.equal(routine.routine!.occurrences[0].finishedAt, state.clock);
  assert.equal(routine.routine!.nextDueAt, '2026-09-09T10:00:00.000Z');
  assert.equal(outstanding(routine), undefined);
  assert.equal(isActionable(routine, state), false);
  state = reconcileClock(reload(state), '2026-09-08T23:59:59Z');
  assert.equal(outstanding(get(state)), undefined);
  state = reconcileClock(state, '2026-09-09T10:00:00Z');
  assert.equal(get(state).routine!.occurrences.length, 2);
  assert.ok(outstanding(get(state))!.steps.every(step => !step.doneAt));
  assert.equal(outstanding(get(state))!.reminderAt, state.clock);
});

test('skip retains partial progress and resumes only on the following day', () => {
  let state = applyCommand(due(), { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  state = applyCommand(state, { type: 'skip', id: 'daily-routine' });
  assert.equal(outstanding(get(state)), undefined);
  assert.equal(get(state).routine!.occurrences[0].status, 'skipped');
  assert.equal(get(state).routine!.occurrences[0].steps[0].doneAt, state.clock);
  assert.equal(get(state).routine!.nextDueAt, '2026-09-09T10:00:00.000Z');
  assert.equal(isActionable(get(state), state), false);
});

test('finishing an old occurrence before today’s scheduled time still schedules tomorrow', () => {
  for (const command of ['complete', 'skip'] as const) {
    let state = finishSteps(due());
    state = reconcileClock(state, '2026-09-11T09:00:00Z');
    state = applyCommand(state, { type: command, id: 'daily-routine' });
    assert.equal(get(state).routine!.nextDueAt, '2026-09-12T10:00:00.000Z');
    state = reconcileClock(state, '2026-09-11T11:00:00Z');
    assert.equal(outstanding(get(state)), undefined);
  }
});

test('edit changes future recurrence, not the outstanding occurrence or fixed labels', () => {
  let state = applyCommand(due(), { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  const occurrence = structuredClone(outstanding(get(state)));
  state = applyCommand(state, {
    type: 'edit', id: 'daily-routine', title: 'Careful rollout', nextStep: 'Check the announcement',
    routineTime: '11:30', projectId: 'rollout',
  });
  assert.equal(get(state).title, 'Careful rollout');
  assert.equal(get(state).nextStep, 'Check the announcement');
  assert.equal(get(state).routine!.time, '11:30');
  assert.equal(get(state).routine!.nextDueAt, '2026-09-09T11:30:00.000Z');
  assert.deepEqual(outstanding(get(state)), occurrence);
  assert.deepEqual(get(state).steps.map(step => step.title), ['Announce change', 'Increase flag']);
  state = reconcileClock(state, '2026-09-08T12:00:00Z');
  assert.equal(get(state).routine!.occurrences.length, 1, 'no second due time on an already processed day');
});

test('unchanged schedule edits cannot accidentally postpone the next occurrence', () => {
  const state = due();
  const next = applyCommand(state, {
    type: 'edit', id: 'daily-routine', title: 'Renamed', nextStep: 'Announce change', routineTime: '10:00',
  });
  assert.equal(get(next).routine!.nextDueAt, get(state).routine!.nextDueAt);
});

test('defer, wait, and restore keep explicit reasons and remove actions from immediate ranking', () => {
  let state = applyCommand(createInitialState(), { type: 'start', id: 'direct-review' });
  state = applyCommand(state, {
    type: 'defer', id: 'direct-review', reason: 'After the incident', until: '2026-09-09T12:00:00Z',
  });
  assert.equal(get(state, 'direct-review').reason, 'After the incident');
  assert.equal(get(state, 'direct-review').availableAt, '2026-09-09T12:00:00.000Z');
  assert.equal(state.activeId, undefined);
  assert.equal(isActionable(get(state, 'direct-review'), state), false);
  state = applyCommand(state, { type: 'wait', id: 'direct-review', reason: 'Author is revising the tests' });
  assert.equal(get(state, 'direct-review').status, 'waiting');
  assert.equal(get(state, 'direct-review').availableAt, undefined);
  state = applyCommand(state, { type: 'restore', id: 'direct-review' });
  assert.equal(get(state, 'direct-review').reason, undefined);
  assert.equal(isActionable(get(state, 'direct-review'), state), true);
});

test('undo completion retains newer captures, deduplicated sources, notes, and clock', () => {
  let state = run(createInitialState(),
    { type: 'start', id: 'direct-review' },
    { type: 'complete', id: 'direct-review' },
    { type: 'advance', to: '2026-09-09T12:00:00Z' },
    { type: 'notes', id: 'direct-review', text: 'New evidence after completion' },
    { type: 'capture', id: 'duplicate', text: 'Review harbor#42' },
    { type: 'interpret', captureId: 'duplicate' },
    { type: 'capture', id: 'newer', text: 'Also send the notes' },
    { type: 'draft', text: 'An unfinished thought' },
  );
  const clock = state.clock;
  const captures = structuredClone(state.captures);
  const history = structuredClone(get(state).routine!.occurrences);
  const sources = structuredClone(get(state, 'direct-review').sources);
  state = applyCommand(reload(state), { type: 'undo' });
  assert.equal(get(state, 'direct-review').status, 'available');
  assert.equal(get(state, 'direct-review').completedAt, undefined);
  assert.equal(state.activeId, 'direct-review');
  assert.equal(state.clock, clock);
  assert.equal(get(state, 'direct-review').updatedAt, clock);
  assert.equal(get(state, 'direct-review').notes, 'New evidence after completion');
  assert.deepEqual(get(state, 'direct-review').sources, sources);
  assert.deepEqual(get(state).routine!.occurrences, history);
  assert.deepEqual(state.captures, captures);
  assert.ok(state.items.some(item => item.id === 'capture-newer'));
  assert.equal(state.draft, 'An unfinished thought');
});

test('undo reverses each decision without deleting captures', () => {
  const base = due();
  const cases: [Command, (state: AppState) => void][] = [
    [{ type: 'start', id: 'manual-task' }, state => assert.equal(state.activeId, undefined)],
    [{ type: 'complete', id: 'direct-review' }, state => assert.equal(get(state, 'direct-review').status, 'available')],
    [{ type: 'defer', id: 'direct-review', reason: 'Later' }, state => assert.equal(get(state, 'direct-review').status, 'available')],
    [{ type: 'wait', id: 'direct-review', reason: 'Waiting' }, state => assert.equal(get(state, 'direct-review').status, 'available')],
    [{ type: 'restore', id: 'waiting-task' }, state => assert.equal(get(state, 'waiting-task').status, 'waiting')],
    [{ type: 'remove', id: 'direct-review' }, state => assert.equal(get(state, 'direct-review').status, 'available')],
    [{ type: 'skip', id: 'daily-routine' }, state => assert.equal(outstanding(get(state))!.status, 'outstanding')],
    [{ type: 'snooze', id: 'daily-routine', minutes: 15 }, state => assert.equal(outstanding(get(state))!.snoozedUntil, undefined)],
    [{ type: 'step', id: 'daily-routine', stepId: 'announce', done: true }, state => assert.equal(outstanding(get(state))!.steps[0].doneAt, undefined)],
    [{ type: 'edit', id: 'manual-task', title: 'A different title', nextStep: 'Different step' }, state => assert.equal(get(state, 'manual-task').title, get(base, 'manual-task').title)],
    [{ type: 'dismiss-reminder', id: 'daily-routine' }, state => assert.equal(outstanding(get(state))!.reminderDismissed, undefined)],
  ];
  for (const [decision, verify] of cases) {
    let state = run(base, decision, { type: 'capture', id: decision.type, text: 'Saved after the decision' });
    assert.equal(state.undo.length, 1);
    state = applyCommand(reload(state), { type: 'undo' });
    verify(state);
    assert.equal(state.captures.length, 1);
    assert.equal(state.items.length, base.items.length + 1);
    assert.equal(state.undo.length, 0);
  }
});

test('undo pause and explicit switch restore the previous active action', () => {
  let state = run(createInitialState(),
    { type: 'start', id: 'direct-review' },
    { type: 'start', id: 'manual-task' },
    { type: 'undo' },
  );
  assert.equal(state.activeId, 'direct-review');
  state = run(state, { type: 'pause' }, { type: 'undo' });
  assert.equal(state.activeId, 'direct-review');
});

test('undo never restores an active action that has become ineligible', () => {
  let state = run(createInitialState(), { type: 'start', id: 'direct-review' }, { type: 'pause' });
  // Represents independent persisted state arriving after the recorded decision.
  state = structuredClone(state);
  get(state, 'direct-review').status = 'waiting';
  state = applyCommand(state, { type: 'undo' });
  assert.equal(state.activeId, undefined);
});

test('undo partial progress across time preserves new missed history and original due times', () => {
  let state = applyCommand(due(), { type: 'step', id: 'daily-routine', stepId: 'announce', done: true });
  state = applyCommand(state, { type: 'scenario', scenario: 'missed' });
  const history = structuredClone(get(state).routine!.occurrences.slice(1));
  const nextDueAt = get(state).routine!.nextDueAt;
  state = applyCommand(reload(state), { type: 'undo' });
  assert.equal(outstanding(get(state))!.steps[0].doneAt, undefined);
  assert.equal(outstanding(get(state))!.dueAt, '2026-09-08T10:00:00.000Z');
  assert.deepEqual(get(state).routine!.occurrences.slice(1), history);
  assert.equal(get(state).routine!.nextDueAt, nextDueAt);
  assert.equal(state.clock, '2026-09-11T10:00:00.000Z');
});

test('undo completion across advancing dates coalesces outstanding work without losing history', () => {
  let state = run(finishSteps(due()),
    { type: 'start', id: 'daily-routine' },
    { type: 'complete', id: 'daily-routine' },
    { type: 'scenario', scenario: 'missed' },
  );
  const nextDueAt = get(state).routine!.nextDueAt;
  const historyIds = get(state).routine!.occurrences.map(occurrence => occurrence.id);
  state = applyCommand(reload(state), { type: 'undo' });
  const history = get(state).routine!.occurrences;
  assert.deepEqual(history.map(occurrence => occurrence.id), historyIds);
  assert.deepEqual(history.map(occurrence => occurrence.status), ['outstanding', 'missed', 'missed', 'missed']);
  assert.ok(outstanding(get(state))!.steps.every(step => step.doneAt === '2026-09-08T10:00:00.000Z'));
  assert.equal(outstanding(get(state))!.finishedAt, undefined);
  assert.equal(get(state).routine!.nextDueAt, nextDueAt);
  assert.equal(state.activeId, 'daily-routine');
  assert.deepEqual(reconcileClock(state, state.clock), state);
});

test('undo skip across advancing dates keeps one outstanding occurrence', () => {
  let state = run(due(),
    { type: 'skip', id: 'daily-routine' },
    { type: 'scenario', scenario: 'missed' },
    { type: 'undo' },
  );
  assert.equal(get(state).routine!.occurrences.length, 4);
  assert.equal(get(state).routine!.occurrences.filter(occurrence => occurrence.status === 'outstanding').length, 1);
  state = reconcileClock(reload(state), state.clock);
  assert.equal(outstanding(get(state))!.dueAt, '2026-09-08T10:00:00.000Z');
});

test('undo schedule edits applies the old time only to future dates and keeps intervening history', () => {
  let state = run(due(),
    { type: 'edit', id: 'daily-routine', title: 'Edited', nextStep: 'Announce', routineTime: '11:00' },
    { type: 'advance', to: '2026-09-11T11:00:00Z' },
  );
  const history = structuredClone(get(state).routine!.occurrences);
  state = applyCommand(reload(state), { type: 'undo' });
  assert.equal(get(state).routine!.time, '10:00');
  assert.equal(get(state).routine!.nextDueAt, '2026-09-12T10:00:00.000Z');
  assert.deepEqual(get(state).routine!.occurrences, history);
});

test('notes, drafts, and project autosaves do not create decision entries', () => {
  const state = run(createInitialState(),
    { type: 'notes', id: 'manual-task', text: 'A useful thought' },
    { type: 'draft', text: 'Not submitted yet' },
    { type: 'project', id: 'custom', name: 'Useful context', notes: 'No required taxonomy' },
    { type: 'project', id: 'custom', name: 'Updated context', notes: 'Autosaved' },
  );
  assert.equal(state.undo.length, 0);
  assert.equal(state.projects.filter(project => project.id === 'custom').length, 1);
  assert.equal(state.projects.find(project => project.id === 'custom')!.name, 'Updated context');
  assert.equal(state.draft, 'Not submitted yet');
});

test('project association is optional, editable, and undoable without losing project notes', () => {
  let state = run(createInitialState(),
    { type: 'project', id: 'custom', name: 'Context', notes: 'Original' },
    { type: 'edit', id: 'manual-task', title: 'Task', nextStep: 'Do it', projectId: 'custom' },
    { type: 'project', id: 'custom', name: 'Context', notes: 'Newer notes' },
    { type: 'undo' },
  );
  assert.equal(get(state, 'manual-task').projectId, undefined);
  assert.equal(state.projects.find(project => project.id === 'custom')!.notes, 'Newer notes');
  state = applyCommand(state, { type: 'capture', id: 'without-project', text: 'Just a task' });
  assert.equal(get(state, 'capture-without-project').projectId, undefined);
});

test('empty scenario defers every actionable item including user work and reverses as one decision', () => {
  let state = run(due(),
    { type: 'capture', id: 'personal', text: 'Do my own work' },
    { type: 'start', id: 'capture-personal' },
  );
  const actionable = rankedItems(state).map(item => item.id);
  const beforeWaiting = structuredClone(get(state, 'waiting-task'));
  const beforeDeferred = structuredClone(get(state, 'deferred-task'));
  state = applyCommand(state, { type: 'scenario', scenario: 'empty' });
  assert.equal(rankedItems(state).length, 0);
  assert.equal(state.activeId, undefined);
  for (const id of actionable) {
    assert.equal(get(state, id).status, 'deferred');
    assert.equal(get(state, id).reason, 'Demo: no actionable work');
  }
  assert.deepEqual(get(state, 'waiting-task'), beforeWaiting);
  assert.deepEqual(get(state, 'deferred-task'), beforeDeferred);
  state = run(state,
    { type: 'notes', id: 'capture-personal', text: 'Wrote this while deferred' },
    { type: 'undo' },
  );
  assert.deepEqual(rankedItems(state).map(item => item.id), actionable);
  assert.equal(state.activeId, 'capture-personal');
  assert.equal(get(state, 'capture-personal').notes, 'Wrote this while deferred');
  assert.equal(state.captures.length, 1);
});

test('sync errors retain last successful data and interpretation errors toggle independently', () => {
  let state = run(createInitialState(),
    { type: 'advance', to: '2026-09-08T11:00:00Z' },
    { type: 'notes', id: 'manual-task', text: 'Retain local context' },
  );
  const items = structuredClone(state.items);
  state = run(state,
    { type: 'scenario', scenario: 'sync-error' },
    { type: 'scenario', scenario: 'interpretation-error' },
  );
  assert.equal(state.sync.status, 'error');
  assert.equal(state.sync.lastSuccessAt, INITIAL_CLOCK);
  assert.equal(state.interpretationError, true);
  assert.deepEqual(state.items, items);
  state = applyCommand(state, { type: 'scenario', scenario: 'interpretation-error' });
  assert.equal(state.interpretationError, false);
  assert.equal(state.sync.status, 'error');
  state = applyCommand(state, { type: 'scenario', scenario: 'recover' });
  assert.equal(state.sync.status, 'ok');
  assert.equal(state.sync.lastSuccessAt, state.clock);
  assert.deepEqual(state.items, items);
});

test('reset preserves captures including modified deduplicated fixtures, project context, draft, and safe undo', () => {
  let state = run(createInitialState(),
    { type: 'capture', id: 'captured-fixture', text: 'Review harbor#42' },
    { type: 'interpret', captureId: 'captured-fixture' },
    { type: 'project', id: 'personal-context', name: 'My project', notes: 'Keep these notes' },
    { type: 'edit', id: 'direct-review', title: 'My review title', nextStep: 'My next step', projectId: 'personal-context' },
    { type: 'notes', id: 'direct-review', text: 'My real notes on the sample obligation' },
    { type: 'complete', id: 'direct-review' },
    { type: 'remove', id: 'manual-task' },
    { type: 'capture', id: 'uninterpreted', text: 'Still pending' },
    { type: 'draft', text: 'Keep this unfinished capture' },
    { type: 'advance', to: '2026-10-08T12:00:00Z' },
  );
  const retainedReview = structuredClone(get(state, 'direct-review'));
  const captures = structuredClone(state.captures);
  state = applyCommand(reload(state), { type: 'scenario', scenario: 'reset' });
  assert.deepEqual(get(state, 'direct-review'), retainedReview);
  assert.deepEqual(state.captures, captures);
  assert.ok(get(state, 'capture-uninterpreted'));
  assert.equal(get(state, 'manual-task').status, 'available');
  assert.equal(state.draft, 'Keep this unfinished capture');
  assert.equal(state.clock, '2026-10-08T12:00:00.000Z');
  assert.equal(state.projects.find(project => project.id === 'personal-context')!.notes, 'Keep these notes');
  assert.equal(get(state).routine!.occurrences.length, 1, 'reset samples do not replay a month of fake missed days');
  assert.equal(outstanding(get(state))!.dueAt, '2026-10-08T10:00:00.000Z');
  assert.ok(state.undo.every(entry => entry.itemsBefore.every(item => item.id !== 'manual-task')));
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, 'direct-review').status, 'available');
  assert.equal(get(state, 'direct-review').notes, retainedReview.notes);
  assert.deepEqual(state.captures, captures);
});

test('reset retains user routines, original occurrence timestamps, and active user work', () => {
  let state = run(createInitialState(),
    { type: 'capture', id: 'user-routine', text: 'Daily at 10am, alert Slack channels, then increase the flag' },
    { type: 'interpret', captureId: 'user-routine' },
    { type: 'scenario', scenario: 'due' },
    { type: 'start', id: 'capture-user-routine' },
    { type: 'step', id: 'capture-user-routine', stepId: 'announce', done: true },
    { type: 'scenario', scenario: 'missed' },
  );
  const routine = structuredClone(get(state, 'capture-user-routine'));
  state = applyCommand(state, { type: 'scenario', scenario: 'reset' });
  assert.deepEqual(get(state, 'capture-user-routine'), routine);
  assert.equal(state.activeId, 'capture-user-routine');
  assert.equal(state.captures[0].original, 'Daily at 10am, alert Slack channels, then increase the flag');
});

test('invalid actions throw and leave state unchanged', () => {
  const state = createInitialState();
  const before = JSON.stringify(state);
  const invalid: Command[] = [
    { type: 'start', id: 'missing' },
    { type: 'start', id: 'waiting-task' },
    { type: 'start', id: 'daily-routine' },
    { type: 'complete', id: 'daily-routine' },
    { type: 'skip', id: 'daily-routine' },
    { type: 'skip', id: 'manual-task' },
    { type: 'pause' },
    { type: 'undo' },
    { type: 'restore', id: 'direct-review' },
    { type: 'defer', id: 'direct-review', reason: '   ' },
    { type: 'defer', id: 'direct-review', reason: 'Later', until: INITIAL_CLOCK },
    { type: 'defer', id: 'direct-review', reason: 'Later', until: 'bad-date' },
    { type: 'wait', id: 'direct-review', reason: '' },
    { type: 'step', id: 'ci-fix', stepId: 'missing', done: true },
    { type: 'edit', id: 'manual-task', title: '', nextStep: '' },
    { type: 'edit', id: 'manual-task', title: 'Task', nextStep: '', routineTime: '10:00' },
    { type: 'edit', id: 'daily-routine', title: 'Routine', nextStep: '', routineTime: '25:00' },
    { type: 'edit', id: 'manual-task', title: 'Task', nextStep: '', projectId: 'missing' },
    { type: 'project', id: 'project', name: '', notes: '' },
  ];
  for (const command of invalid) {
    assert.throws(() => applyCommand(state, command), Error, command.type);
    assert.equal(JSON.stringify(state), before);
  }
  for (const minutes of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
    assert.throws(() => applyCommand(due(), { type: 'snooze', id: 'daily-routine', minutes }), Error);
  }
});

test('commands are immutable, including successful nested progress and autosaves', () => {
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  }
  let state = due();
  const commands: Command[] = [
    { type: 'start', id: 'daily-routine' },
    { type: 'step', id: 'daily-routine', stepId: 'announce', done: true },
    { type: 'notes', id: 'daily-routine', text: 'Saved note' },
    { type: 'capture', id: 'raw', text: 'Review harbor#42' },
    { type: 'interpret', captureId: 'raw' },
    { type: 'scenario', scenario: 'missed' },
    { type: 'undo' },
    { type: 'scenario', scenario: 'reset' },
  ];
  for (const command of commands) {
    freeze(state);
    const original = JSON.stringify(state);
    const next = applyCommand(state, command);
    assert.equal(JSON.stringify(state), original, command.type);
    state = next;
  }
});
