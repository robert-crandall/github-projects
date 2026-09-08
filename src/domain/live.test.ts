import assert from 'node:assert/strict';
import test from 'node:test';
import type { CaptureProposal, GitHubSnapshot, RankingProposal } from '../desktop-contract.ts';
import { isAppState } from '../storage.ts';
import { addDays, calendarDay, dateAtTime, nextDailyDue, outstanding, reconcileClock } from './clock.ts';
import { applyCommand } from './engine.ts';
import { canonicalReviewUrl, createDesktopState } from './live.ts';
import { rankedItems, recommendationReason } from './ranking.ts';
import type { AppState, Command, WorkItem } from './types.ts';

const CLOCK = '2026-03-07T17:00:00.000Z';
const ZONE = 'America/Los_Angeles';
const URL = 'https://github.com/octo/repo/pull/42';
const run = (state: AppState, ...commands: Command[]) => commands.reduce(applyCommand, state);
const get = (state: AppState, id: string) => state.items.find(item => item.id === id)!;
const proposal = (changes: Partial<CaptureProposal> = {}): CaptureProposal => ({
  kind: 'task', title: 'Send the notes', nextStep: 'Draft the summary.', explanation: 'A next action supported by your capture.', ...changes,
});
const reviewProposal = (): CaptureProposal => proposal({ kind: 'review', title: 'Review the PR', reviewUrl: URL, nextStep: 'Read the diff.' });
const github = (id = 'github-review', changes: Partial<WorkItem> = {}): WorkItem => ({
  id, title: 'Review the source title', kind: 'review', status: 'available', createdAt: CLOCK, updatedAt: CLOCK,
  notes: '', steps: [], nextStep: 'Read the diff.',
  sources: [{ id: `source-${id}`, kind: 'github', label: 'Direct request', reference: URL }],
  review: { identity: URL, request: 'direct', lines: 20 }, evidence: '20 changed lines; directly requested.', ...changes,
});
const snapshot = (items: WorkItem[], fetchedAt = CLOCK): GitHubSnapshot => ({ items, fetchedAt, login: 'octo', warnings: [] });
const sync = (state: AppState, items: WorkItem[], fetchedAt = state.clock) => applyCommand(state, { type: 'github-sync', snapshot: snapshot(items, fetchedAt) });
const save = (state: AppState, id: string, text = 'Send the notes') => applyCommand(state, { type: 'capture', id, text });
const interpret = (state: AppState, id: string, input = proposal()) => applyCommand(state, { type: 'ai-interpret', captureId: id, proposal: input });
function routine(clock = CLOCK, time = '10:00', zone = ZONE): AppState {
  return run(save(createDesktopState(clock), 'daily'), {
    type: 'edit', id: 'capture-daily', title: 'Daily summary', nextStep: 'Read notes',
    routineTime: time, routineTimeZone: zone, routineSteps: ['Read notes', 'Send summary'],
  });
}
const rank = (state: AppState, orderedIds: string[]) => applyCommand(state, {
  type: 'ai-rank', proposal: { orderedIds, reasons: orderedIds.map(id => ({ id, reason: `Consider ${id}.` })), summary: 'Suggested order.' },
});

test('desktop bootstrap contains no fixtures and cannot execute demo scenarios or interpretation', () => {
  const state = createDesktopState(CLOCK);
  assert.equal(state.runtime, 'desktop');
  assert.equal(state.clock, CLOCK);
  assert.equal(state.sync.status, 'disconnected');
  assert.equal(state.sync.lastSuccessAt, CLOCK);
  for (const key of ['items', 'captures', 'projects', 'undo'] as const) assert.deepEqual(state[key], []);
  assert.deepEqual(rankedItems(state), []);
  assert.equal(isAppState(state), true);
  assert.throws(() => applyCommand(state, { type: 'scenario', scenario: 'reset' }), /Demo scenarios/);
  assert.throws(() => applyCommand(save(state, 'one'), { type: 'interpret', captureId: 'one' }), /Copilot/);
});

test('daily recurrence follows local calendar days across spring and fall DST', () => {
  assert.equal(dateAtTime('2026-03-07', '10:00', ZONE), '2026-03-07T18:00:00.000Z');
  assert.equal(dateAtTime('2026-03-08', '10:00', ZONE), '2026-03-08T17:00:00.000Z');
  assert.equal(nextDailyDue('2026-03-07T18:00:00Z', '10:00', ZONE), '2026-03-08T17:00:00.000Z');
  assert.equal(addDays('2026-03-07T18:00:00Z', 1, ZONE), '2026-03-08T17:00:00.000Z');
  assert.equal(nextDailyDue('2026-10-31T17:00:00Z', '10:00', ZONE), '2026-11-01T18:00:00.000Z');
  assert.equal(addDays('2026-10-31T17:00:00Z', 1, ZONE), '2026-11-01T18:00:00.000Z');
  assert.equal(dateAtTime('2026-03-08T01:00:00Z', '10:00', ZONE), '2026-03-07T18:00:00.000Z');
  assert.equal(nextDailyDue('2028-02-28T18:00:00Z', '10:00', ZONE), '2028-02-29T18:00:00.000Z');
  assert.equal(nextDailyDue('2026-12-31T18:00:00Z', '10:00', ZONE), '2027-01-01T18:00:00.000Z');
});

test('spring gaps shift forward only that day and repeated fall times occur only once', () => {
  let state = routine('2026-03-07T11:00:00Z', '02:30');
  state = reconcileClock(state, '2026-03-09T10:00:00Z');
  const history = get(state, 'capture-daily').routine!.occurrences;
  assert.deepEqual(history.map(entry => entry.dueAt), ['2026-03-08T10:30:00.000Z', '2026-03-09T09:30:00.000Z']);
  assert.deepEqual(history.map(entry => entry.status), ['outstanding', 'missed']);
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2026-03-10T09:30:00.000Z');
  state = routine('2026-11-01T07:00:00Z', '01:30');
  state = reconcileClock(state, '2026-11-01T08:30:00Z');
  assert.equal(outstanding(get(state, 'capture-daily'))!.dueAt, '2026-11-01T08:30:00.000Z');
  state = reconcileClock(state, '2026-11-01T09:30:00Z');
  assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 1);
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2026-11-02T09:30:00.000Z');
});

test('desktop clock corrections preserve active progress and never repeat processed dates', () => {
  let state = reconcileClock(routine(), '2026-03-07T18:00:00Z');
  state = run(state, { type: 'start', id: 'capture-daily' }, { type: 'step', id: 'capture-daily', stepId: 'step-1', done: true });
  const future = get(state, 'capture-daily').routine!.nextDueAt;
  const original = structuredClone(outstanding(get(state, 'capture-daily')));
  state = reconcileClock(state, CLOCK);
  assert.equal(state.clock, CLOCK);
  assert.equal(state.activeId, 'capture-daily');
  assert.equal(rankedItems(state)[0].id, 'capture-daily');
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, future);
  state = reconcileClock(JSON.parse(JSON.stringify(state)), '2026-03-10T17:00:00Z');
  assert.deepEqual(outstanding(get(state, 'capture-daily')), original);
  assert.deepEqual(get(state, 'capture-daily').routine!.occurrences.map(entry => calendarDay(entry.dueAt, ZONE)), [
    '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
  ]);
  state = run(state, { type: 'step', id: 'capture-daily', stepId: 'step-2', done: true }, { type: 'complete', id: 'capture-daily' });
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2026-03-11T17:00:00.000Z');
});

test('inactive desktop routines stop accumulating hidden missed history and safely resume', () => {
  for (const status of ['removed', 'completed', 'deferred', 'waiting'] as const) {
    let state = routine();
    get(state, 'capture-daily').status = status;
    state = reconcileClock(state, '2030-03-07T17:00:00Z');
    assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 0, status);
    state = applyCommand(state, { type: 'restore', id: 'capture-daily' });
    state = reconcileClock(state, state.clock);
    assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 0, status);
    assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2030-03-07T18:00:00.000Z');
  }
  let state = reconcileClock(routine(), '2026-03-07T18:00:00Z');
  state = run(state, { type: 'step', id: 'capture-daily', stepId: 'step-1', done: true },
    { type: 'wait', id: 'capture-daily', reason: 'Owner approval' });
  const original = structuredClone(outstanding(get(state, 'capture-daily')));
  state = reconcileClock(state, '2030-03-07T17:00:00Z');
  assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 1);
  assert.deepEqual(outstanding(get(state, 'capture-daily')), original);
});

test('desktop timed deferrals return automatically at their deadline without reversing after clock correction', () => {
  let state = save(save(save(createDesktopState(CLOCK), 'timed'), 'indefinite'), 'waiting');
  state = run(state,
    { type: 'defer', id: 'capture-timed', reason: 'After lunch', until: '2026-03-07T18:00:00Z' },
    { type: 'defer', id: 'capture-indefinite', reason: 'Someday' },
    { type: 'wait', id: 'capture-waiting', reason: 'Owner approval' });
  state = applyCommand(state, { type: 'advance', to: '2026-03-07T17:59:59Z' });
  assert.equal(get(state, 'capture-timed').status, 'deferred');
  assert.deepEqual(rankedItems(state), []);
  state = applyCommand(state, { type: 'advance', to: '2026-03-07T18:00:00Z' });
  assert.equal(get(state, 'capture-timed').status, 'available');
  assert.equal(get(state, 'capture-timed').availableAt, undefined);
  assert.equal(get(state, 'capture-timed').reason, undefined);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['capture-timed']);
  assert.equal(get(state, 'capture-indefinite').status, 'deferred');
  assert.equal(get(state, 'capture-waiting').status, 'waiting');
  state = reconcileClock(state, CLOCK);
  assert.equal(get(state, 'capture-timed').status, 'available');
  const demo = save(createDesktopState(CLOCK), 'demo');
  delete demo.runtime;
  const deferred = applyCommand(demo, { type: 'defer', id: 'capture-demo', reason: 'Demo decision', until: '2026-03-07T18:00:00Z' });
  assert.equal(get(reconcileClock(deferred, '2026-03-08T18:00:00Z'), 'capture-demo').status, 'deferred');
});

test('timed routine deferral excludes suspended days and includes a due time exactly at the deadline', () => {
  let state = applyCommand(routine(), {
    type: 'defer', id: 'capture-daily', reason: 'After vacation', until: '2026-03-10T17:00:00Z',
  });
  state = reconcileClock(state, '2026-03-10T16:59:59Z');
  assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 0);
  state = reconcileClock(state, '2026-03-10T17:00:00Z');
  assert.equal(get(state, 'capture-daily').status, 'available');
  assert.equal(outstanding(get(state, 'capture-daily'))!.dueAt, '2026-03-10T17:00:00.000Z');
  assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 1);
  let reopened = applyCommand(routine(), {
    type: 'defer', id: 'capture-daily', reason: 'Vacation', until: '2026-03-10T17:00:00Z',
  });
  reopened = reconcileClock(reopened, '2026-03-12T17:00:00Z');
  assert.deepEqual(get(reopened, 'capture-daily').routine!.occurrences.map(entry => entry.dueAt), [
    '2026-03-10T17:00:00.000Z', '2026-03-11T17:00:00.000Z', '2026-03-12T17:00:00.000Z',
  ]);
  assert.deepEqual(get(reopened, 'capture-daily').routine!.occurrences.map(entry => entry.status), ['outstanding', 'missed', 'missed']);
});

test('editing timezone and steps affects future occurrences, remains undoable, and preserves legacy UTC', () => {
  let state = reconcileClock(routine(), '2026-03-07T18:00:00Z');
  const original = structuredClone(outstanding(get(state, 'capture-daily')));
  state = applyCommand(state, { type: 'edit', id: 'capture-daily', title: 'Changed', nextStep: 'Read',
    routineTimeZone: 'America/New_York', routineSteps: ['Read', 'Send', 'Archive'] });
  assert.deepEqual(outstanding(get(state, 'capture-daily')), original);
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2026-03-08T14:00:00.000Z');
  assert.equal(get(state, 'capture-daily').steps.length, 3);
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, 'capture-daily').routine!.timeZone, ZONE);
  assert.deepEqual(get(state, 'capture-daily').steps.map(step => step.title), ['Read notes', 'Send summary']);
  assert.equal(get(state, 'capture-daily').routine!.nextDueAt, '2026-03-08T17:00:00.000Z');
  const legacy = routine();
  delete get(legacy, 'capture-daily').routine!.timeZone;
  const edited = applyCommand(legacy, { type: 'edit', id: 'capture-daily', title: 'Legacy', nextStep: 'Read', routineTime: '11:00' });
  assert.equal(get(edited, 'capture-daily').routine!.timeZone, 'UTC');
  assert.match(get(edited, 'capture-daily').routine!.nextDueAt, /T11:00:00/);
  assert.throws(() => applyCommand(state, { type: 'edit', id: 'capture-daily', title: 'Bad', nextStep: 'Read', routineTimeZone: 'Mars/Olympus' }), /IANA/);
});

test('undoing a routine conversion stops the schedule even after time created an occurrence', () => {
  let state = reconcileClock(routine(), '2026-03-08T18:00:00Z');
  assert.equal(get(state, 'capture-daily').routine!.occurrences.length, 2);
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, 'capture-daily').kind, 'task');
  assert.equal(get(state, 'capture-daily').routine, undefined);
  assert.deepEqual(get(state, 'capture-daily').steps, []);
  assert.equal(state.captures.length, 1);
  state = reconcileClock(state, '2026-03-11T18:00:00Z');
  assert.equal(get(state, 'capture-daily').routine, undefined);
});

test('GitHub refresh preserves user edits, project, notes, progress, active state, and undo', () => {
  let state = sync(createDesktopState(CLOCK), [github('github-review', { steps: [{ id: 'inspect', title: 'Inspect' }] })]);
  state = run(state, { type: 'project', id: 'project', name: 'My project', notes: '' },
    { type: 'edit', id: 'github-review', title: 'My title', nextStep: 'My step', projectId: 'project' },
    { type: 'notes', id: 'github-review', text: 'Keep my notes.' },
    { type: 'start', id: 'github-review' }, { type: 'step', id: 'github-review', stepId: 'inspect', done: true });
  const previous = structuredClone(state);
  state = sync(state, [github('github-review', { title: 'New remote title', notes: 'Remote notes', steps: [],
    evidence: 'New evidence', review: { identity: URL, request: 'team', lines: 60 } })], '2026-03-07T17:05:00Z');
  for (const key of ['title', 'notes', 'projectId', 'status', 'steps', 'nextStep', 'startedAt', 'updatedAt'] as const) {
    assert.deepEqual(get(state, 'github-review')[key], get(previous, 'github-review')[key], key);
  }
  assert.equal(state.activeId, previous.activeId);
  assert.deepEqual(state.undo, previous.undo);
  assert.equal(get(state, 'github-review').evidence, 'New evidence');
  assert.equal(get(state, 'github-review').review!.request, 'team');
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, 'github-review').steps[0].doneAt, undefined);
  assert.equal(get(state, 'github-review').evidence, 'New evidence');
});

test('issue mentions become actionable work and keep local decisions across refresh and reload', () => {
  const url = 'https://github.com/octo/repo/issues/42';
  const id = `github:${url}:reply`;
  const mention = github(id, {
    title: 'Please clarify this issue', kind: 'mention', review: undefined,
    nextStep: 'Check whether this mention needs your reply.',
    sources: [{ id: `github:${url}:IssueMention`, kind: 'github', label: 'Mentioned - may owe a reply', reference: url }],
    evidence: 'A recent mention is a signal, not proof that you owe a response.',
  });
  let state = sync(createDesktopState(CLOCK), [mention]);
  assert.equal(isAppState(state), true);
  assert.deepEqual(rankedItems(state).map(item => item.id), [id]);
  assert.equal(get(state, id).sources[0].reference, url);
  assert.match(recommendationReason(get(state, id), state), /May need a reply/);
  state = run(state, { type: 'notes', id, text: 'Ask about the deadline.' },
    { type: 'defer', id, reason: 'After lunch' });
  state = sync(JSON.parse(JSON.stringify(state)), [mention]);
  assert.equal(state.items.length, 1);
  assert.equal(get(state, id).notes, 'Ask about the deadline.');
  assert.equal(get(state, id).status, 'deferred');
  assert.deepEqual(rankedItems(state), []);
  state = run(state, { type: 'restore', id }, { type: 'start', id }, { type: 'complete', id });
  state = sync(state, [mention]);
  assert.equal(get(state, id).status, 'completed');
  assert.deepEqual(rankedItems(state), []);
});

test('sync deduplicates manual reviews by identity, maps capture IDs, and keeps deferred decisions undoable', () => {
  let state = interpret(save(createDesktopState(CLOCK), 'manual', `Please review ${URL}`), 'manual', reviewProposal());
  const id = state.captures[0].itemId;
  state = run(state, { type: 'notes', id, text: 'My context' }, { type: 'defer', id, reason: 'After lunch' });
  state = sync(state, [github()]);
  assert.equal(state.items.length, 1);
  assert.equal(state.captures[0].itemId, id);
  assert.equal(get(state, id).status, 'deferred');
  assert.equal(get(state, id).reason, 'After lunch');
  assert.equal(get(state, id).sources.length, 2);
  assert.equal(get(state, id).notes, 'My context');
  state = sync(state, [github()]);
  assert.equal(state.items.length, 1);
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, id).status, 'available');
  assert.equal(get(state, id).sources.length, 2);
});

test('late review proposals retain pending local edits, notes, and deferral when merging into a live review', () => {
  let state = save(sync(createDesktopState(CLOCK), [github()]), 'late', `Review ${URL}`);
  const id = state.captures[0].itemId;
  state = run(state, { type: 'edit', id, title: 'My edited title', nextStep: 'Look at retries' },
    { type: 'notes', id, text: 'Local note' }, { type: 'defer', id, reason: 'Tomorrow' });
  state = interpret(state, 'late', reviewProposal());
  assert.equal(state.items.length, 1);
  assert.equal(state.captures[0].itemId, id);
  assert.equal(get(state, id).title, 'My edited title');
  assert.equal(get(state, id).nextStep, 'Look at retries');
  assert.equal(get(state, id).notes, 'Local note');
  assert.equal(get(state, id).status, 'deferred');
  state = applyCommand(state, { type: 'undo' });
  assert.equal(get(state, id).status, 'available');
  assert.equal(get(state, id).review!.identity, URL);
  assert.equal(get(state, id).sources.length, 2);
});

test('completed and removed reviews stay decided across refreshes and new captures', () => {
  for (const command of ['complete', 'remove'] as const) {
    let state = sync(createDesktopState(CLOCK), [github()]);
    state = applyCommand(state, { type: command, id: 'github-review' });
    state = sync(state, [github('github-review', { evidence: 'A new observation is not proof of a new request.' })]);
    state = interpret(save(state, 'again', `Review ${URL}`), 'again', reviewProposal());
    assert.equal(state.items.length, 1);
    assert.equal(state.captures[0].itemId, 'github-review');
    assert.equal(get(state, 'github-review').status, command === 'complete' ? 'completed' : 'removed');
    assert.equal(rankedItems(state).length, 0);
  }
});

test('freshness removes stale GitHub-only signals from recommendations, not captured or active commitments', () => {
  let state = sync(createDesktopState(CLOCK), [github()]);
  state = sync(state, []);
  assert.equal(state.items.length, 1);
  assert.equal(get(state, 'github-review').status, 'available');
  assert.equal(get(state, 'github-review').signalCurrent, false);
  assert.equal(rankedItems(state).length, 0);
  assert.match(recommendationReason(get(state, 'github-review'), state), /Not seen/);
  state = sync(state, [github()]);
  assert.equal(rankedItems(state).length, 1);
  state = run(state, { type: 'start', id: 'github-review' });
  state = sync(state, []);
  assert.equal(state.activeId, 'github-review');
  assert.equal(rankedItems(state)[0].id, 'github-review');
  state = applyCommand(state, { type: 'pause' });
  assert.equal(rankedItems(state).length, 0);
  state = interpret(save(state, 'commitment', `Review ${URL}`), 'commitment', reviewProposal());
  assert.equal(rankedItems(state).length, 1);
  assert.match(recommendationReason(state.items[0], state), /saved commitment/);
});

test('GitHub failures and out-of-order snapshots retain last successful data and freshness', () => {
  let state = sync(createDesktopState(CLOCK), [github()], '2026-03-07T17:05:00Z');
  const items = structuredClone(state.items);
  state = applyCommand(state, { type: 'sync-error', error: 'gh is offline' });
  assert.equal(state.sync.status, 'error');
  assert.equal(state.sync.error, 'gh is offline');
  assert.equal(state.sync.login, 'octo');
  assert.equal(state.sync.lastSuccessAt, '2026-03-07T17:05:00.000Z');
  assert.deepEqual(state.items, items);
  assert.deepEqual(sync(state, [], CLOCK), state);
  state = applyCommand(state, { type: 'github-sync', snapshot: { ...snapshot(items, '2026-03-07T17:06:00Z'), warnings: ['Team query incomplete'] } });
  assert.equal(state.sync.error, undefined);
  assert.deepEqual(state.sync.warnings, ['Team query incomplete']);
});

test('GitHub validates incoming shapes, safe sources, stable action IDs, and distinct action kinds', () => {
  const state = sync(createDesktopState(CLOCK), [github()]);
  for (const bad of [
    github('github-review', { kind: 'fix' }),
    github('github-review', { review: { identity: 'https://github.com/octo/repo/pull/99', request: 'direct' } }),
    github('bad', { sources: [{ id: 'x', kind: 'github', label: 'Bad', reference: 'https://github.com.evil.test/octo/repo/pull/42' }] }),
    github('bad', { status: 'completed' }),
  ]) {
    assert.throws(() => sync(state, [bad]));
  }
  assert.throws(() => sync(state, [github(), github()]), /Invalid GitHub/);
  const distinct = sync(state, [github(), github('github-fix', { kind: 'fix' })]);
  assert.equal(distinct.items.length, 2);
  const duplicates = sync(createDesktopState(CLOCK), [github('team', { review: { identity: URL, request: 'team' } }), github('direct')]);
  assert.equal(duplicates.items.length, 1);
  assert.equal(duplicates.items[0].review!.request, 'direct');
  assert.equal(duplicates.items[0].sources.length, 2);
});

test('safe review proposals normalize only references grounded in the original capture', () => {
  const state = save(createDesktopState(CLOCK), 'review', 'Review https://github.com/Octo/Repo/pull/42/files?diff=split#r1.');
  const interpreted = interpret(state, 'review', reviewProposal());
  assert.equal(interpreted.items[0].review!.identity, URL);
  assert.equal(interpreted.items[0].sources[0].reference, URL);
  for (const unsafe of ['http://github.com/octo/repo/pull/42', 'https://github.com.evil.test/octo/repo/pull/42',
    'https://evil@github.com/octo/repo/pull/42', 'https://github.com/octo/repo/pull/420', 'javascript:alert(1)',
    'https://github.com/octo/repo/pull/42/other', 'https://github.com/octo/repo/pull/042']) {
    assert.throws(() => interpret(state, 'review', { ...reviewProposal(), reviewUrl: unsafe }), /original capture/);
  }
  assert.equal(canonicalReviewUrl('https://github.com/octo/repo/pull/42#discussion'), URL);
  const missing = interpret(save(createDesktopState(CLOCK), 'missing', 'Review the PR'), 'missing', { ...reviewProposal(), reviewUrl: undefined });
  assert.equal(missing.items[0].kind, 'task');
  assert.match(missing.captures[0].explanation!, /reference/);
});

test('AI capture validation rejects malformed or fabricated proposals without changing the saved raw task', () => {
  const state = save(createDesktopState(CLOCK), 'raw');
  const original = JSON.stringify(state);
  const invalid = [
    proposal({ title: ' ' }), proposal({ nextStep: '' }), proposal({ explanation: '' }),
    proposal({ kind: 'fix' as CaptureProposal['kind'] }), proposal({ title: 'x'.repeat(501) }),
    proposal({ steps: [] }), proposal({ steps: Array(21).fill('step') }),
    proposal({ nextStep: 'Open https://github.com/other/repo/pull/99' }),
    proposal({ reviewUrl: URL }),
  ];
  for (const input of invalid) assert.throws(() => interpret(state, 'raw', input));
  assert.equal(JSON.stringify(state), original);
  const failed = applyCommand(state, { type: 'interpret-error', captureId: 'raw', error: 'SDK unavailable' });
  assert.equal(failed.captures[0].interpretation, 'error');
  assert.deepEqual(failed.items, state.items);
  const retried = interpret(failed, 'raw');
  assert.equal(retried.captures[0].interpretation, 'task');
  assert.deepEqual(interpret(retried, 'raw', proposal({ title: 'Late duplicate' })), retried);
  assert.deepEqual(applyCommand(retried, { type: 'interpret-error', captureId: 'raw', error: 'Late error' }), retried);
});

test('generic SDK routines support ordered steps and retain the capture-time IANA timezone', () => {
  let state = save(createDesktopState(CLOCK), 'daily', 'Every day at 10am, read notes, then send a summary');
  state.captures[0].timeZone = ZONE;
  state = interpret(state, 'daily', proposal({ kind: 'routine', dailyTime: '10:00', steps: ['Read notes', 'Send summary'] }));
  const item = state.items[0];
  assert.equal(item.kind, 'routine');
  assert.equal(item.routine!.timeZone, ZONE);
  assert.equal(item.routine!.nextDueAt, '2026-03-07T18:00:00.000Z');
  assert.deepEqual(item.steps.map(step => step.title), ['Read notes', 'Send summary']);
  state = reconcileClock(state, item.routine!.nextDueAt);
  assert.throws(() => applyCommand(state, { type: 'step', id: item.id, stepId: 'step-2', done: true }), /earlier/);
  assert.match(recommendationReason(state.items[0], state), /America\/Los_Angeles/);
});

test('missing, ambiguous, and unsupported schedules become ordinary saved tasks rather than invented recurrences', () => {
  const originals = [
    'Read notes every day', 'Daily at 10, read notes', 'Maybe daily at 10am, read notes',
    'Daily at 10am or 11am, read notes', 'Daily at 10am on weekdays, read notes',
    'Daily at 10am PST, read notes', 'Daily at 10am until Friday, read notes', 'Never daily at 10am, read notes',
  ];
  for (const [index, text] of originals.entries()) {
    const id = String(index);
    const state = interpret(save(createDesktopState(CLOCK), id, text), id, proposal({ kind: 'routine', dailyTime: '10:00', steps: ['Read notes'] }));
    assert.equal(state.items[0].kind, 'task', text);
    assert.equal(state.items[0].routine, undefined);
    assert.match(state.captures[0].explanation!, /explicit daily time/);
    assert.equal(state.captures[0].original, text);
  }
  const mismatched = interpret(save(createDesktopState(CLOCK), 'mismatch', 'Daily at 11am, read notes'), 'mismatch', proposal({ kind: 'routine', dailyTime: '10:00' }));
  assert.equal(mismatched.items[0].routine, undefined);
});

test('explicit UTC, 12am, 12pm, and evening schedules have unambiguous meanings', () => {
  for (const [token, time] of [['12am', '00:00'], ['12pm', '12:00'], ['10pm', '22:00'], ['14:30', '14:30']]) {
    let state = save(createDesktopState(CLOCK), 'daily', `Daily at ${token} UTC, read notes`);
    state = interpret(state, 'daily', proposal({ kind: 'routine', dailyTime: time }));
    assert.equal(state.items[0].routine!.time, time);
    assert.equal(state.items[0].routine!.timeZone, 'UTC');
  }
});

test('pending interpretations preserve manual task-to-routine conversion and do not overwrite user schedules', () => {
  let state = save(createDesktopState(CLOCK), 'pending', 'Daily at 10am, read notes');
  state = applyCommand(state, { type: 'edit', id: 'capture-pending', title: 'My routine', nextStep: 'First',
    routineTime: '11:00', routineTimeZone: ZONE, routineSteps: ['First', 'Second', 'Third'] });
  const edited = structuredClone(state.items);
  state = interpret(state, 'pending', proposal({ kind: 'routine', dailyTime: '10:00', steps: ['Read notes'] }));
  assert.deepEqual(state.items, edited);
  assert.match(state.captures[0].explanation!, /edited action/);
});

test('pending action edits survive generic AI proposals even when the user explicitly kept the original title', () => {
  for (const title of ['My edited action', 'Send the notes']) {
    let state = save(createDesktopState(CLOCK), 'pending', 'Send the notes');
    state = applyCommand(state, { type: 'edit', id: 'capture-pending', title, nextStep: 'Choose a concrete next step.' });
    state = interpret(JSON.parse(JSON.stringify(state)), 'pending', proposal({ title: 'AI title', nextStep: 'AI next step' }));
    assert.equal(get(state, 'capture-pending').title, title);
    assert.equal(get(state, 'capture-pending').nextStep, 'Choose a concrete next step.');
    assert.equal(state.captures[0].interpretation, 'task');
    assert.equal(state.captures[0].actionEdited, true);
    assert.equal(isAppState(state), true);
  }
});

test('delayed proposals never erase active work or conflicting local decisions', () => {
  let state = save(createDesktopState(CLOCK), 'active', 'Daily at 10am, read notes');
  state = applyCommand(state, { type: 'start', id: 'capture-active' });
  state = interpret(state, 'active', proposal({ kind: 'routine', dailyTime: '10:00' }));
  assert.equal(state.activeId, 'capture-active');
  assert.equal(get(state, 'capture-active').kind, 'task');
  assert.equal(get(state, 'capture-active').routine, undefined);
  for (const active of ['github-review', 'capture-conflict']) {
    let conflict = save(sync(createDesktopState(CLOCK), [github()]), 'conflict', `Review ${URL}`);
    const deferred = active === 'github-review' ? 'capture-conflict' : 'github-review';
    conflict = run(conflict, { type: 'start', id: active }, { type: 'defer', id: deferred, reason: 'Later' });
    conflict = interpret(conflict, 'conflict', reviewProposal());
    assert.equal(conflict.activeId, active);
    assert.equal(get(conflict, deferred).status, 'deferred');
    assert.equal(conflict.items.length, 2);
    assert.equal(get(conflict, 'capture-conflict').kind, 'task');
    assert.match(conflict.captures[0].explanation!, /conflicting local decision/);
  }
});

test('AI order applies only after active work and due routines, with per-item reasons', () => {
  let state = routine();
  state = sync(state, [github()]);
  state = save(save(state, 'first'), 'second');
  state = reconcileClock(state, '2026-03-07T18:00:00Z');
  state = applyCommand(state, { type: 'start', id: 'capture-first' });
  state = rank(state, ['capture-second', 'github-review', 'capture-daily', 'capture-first']);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['capture-first', 'capture-daily', 'capture-second', 'github-review']);
  assert.match(recommendationReason(get(state, 'capture-first'), state), /active action/);
  assert.match(recommendationReason(get(state, 'capture-daily'), state), /routine is due/);
  assert.equal(recommendationReason(get(state, 'capture-second'), state), 'Consider capture-second.');
  state = applyCommand(state, { type: 'pause' });
  assert.equal(rankedItems(state)[0].id, 'capture-daily');
  assert.equal(isAppState(JSON.parse(JSON.stringify(state))), true);
});

test('AI ranking rejects unknown, duplicate, unavailable, unbounded, and unexplained candidates', () => {
  let state = save(save(createDesktopState(CLOCK), 'first'), 'waiting');
  state = applyCommand(state, { type: 'wait', id: 'capture-waiting', reason: 'An answer' });
  const valid: RankingProposal = { orderedIds: ['capture-first'], reasons: [{ id: 'capture-first', reason: 'Available.' }], summary: 'Summary.' };
  const invalid: RankingProposal[] = [
    { ...valid, orderedIds: ['unknown'] }, { ...valid, orderedIds: ['capture-waiting'] },
    { ...valid, orderedIds: ['capture-first', 'capture-first'] },
    { ...valid, reasons: [] }, { ...valid, reasons: [{ id: 'unknown', reason: 'Not grounded' }] },
    { ...valid, reasons: [{ id: 'capture-first', reason: '' }] },
    { ...valid, reasons: [valid.reasons[0], valid.reasons[0]] },
    { ...valid, summary: '' }, { ...valid, orderedIds: Array(41).fill('capture-first') },
    { orderedIds: [], reasons: [], summary: 'Nothing' },
  ];
  const original = JSON.stringify(state);
  for (const input of invalid) assert.throws(() => applyCommand(state, { type: 'ai-rank', proposal: input }));
  assert.equal(JSON.stringify(state), original);
});

test('ranking invalidates on relevant decisions, retains notes, and falls back deterministically', () => {
  let state = sync(createDesktopState(CLOCK), [github()]);
  state = save(state, 'task');
  const deterministic = rankedItems(state).map(item => item.id);
  state = rank(state, ['capture-task', 'github-review']);
  state = applyCommand(state, { type: 'notes', id: 'capture-task', text: 'More context' });
  assert.equal(rankedItems(state)[0].id, 'capture-task');
  const cleared = applyCommand(state, { type: 'clear-ai-rank' });
  assert.deepEqual(rankedItems(cleared).map(item => item.id), deterministic);
  state = applyCommand(state, { type: 'wait', id: 'capture-task', reason: 'Waiting' });
  assert.equal(state.aiRanking, undefined);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['github-review']);
  state = applyCommand(state, { type: 'restore', id: 'capture-task' });
  state = rank(state, ['capture-task', 'github-review']);
  state = sync(state, []);
  assert.equal(state.aiRanking, undefined);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['capture-task']);
});

test('partial AI rankings leave omitted eligible candidates in deterministic order', () => {
  let state = sync(createDesktopState(CLOCK), [github()]);
  state = save(save(state, 'first'), 'second');
  const fallback = rankedItems(state).map(item => item.id).filter(id => id !== 'capture-second');
  state = rank(state, ['capture-second']);
  assert.deepEqual(rankedItems(state).map(item => item.id), ['capture-second', ...fallback]);
});
