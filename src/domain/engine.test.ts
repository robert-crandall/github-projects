import { describe, expect, test } from 'bun:test';
import type { AppState, Command, WorkAction } from '../types.ts';
import { stateSchema } from '../types.ts';
import { followingDay, nextDaily } from './clock.ts';
import { getRow, getRows, initialState, reminders, transition } from './engine.ts';

const PRIMARY = 'demo-relay-101';
const PRIMARY_KEY = `t:${PRIMARY}`;
const REQUEST = `${PRIMARY}:request-1`;
const ROUTINE = 'a:demo-daily-routine';
const TEAM_KEY = 't:demo-provider-202';
const advance = (minutes: number): Command => ({ type: 'advance', minutes });

test('Later preserves scratch notes when its optional note is blank or adds context', () => {
  let state = transition(initialState(), { type: 'edit', key: PRIMARY_KEY, notes: 'Keep the retry analysis.' });
  state = transition(state, { type: 'later', key: PRIMARY_KEY, note: '' });
  expect(getRow(state, PRIMARY_KEY)?.action?.notes).toBe('Keep the retry analysis.');
  state = transition(state, { type: 'restore', key: PRIMARY_KEY });
  state = transition(state, { type: 'later', key: PRIMARY_KEY, note: 'Waiting for a response' });
  expect(getRow(state, PRIMARY_KEY)?.action?.notes).toBe('Keep the retry analysis.\n\nWaiting for a response');
});

function run(state: AppState, ...commands: Command[]): AppState {
  for (const command of commands) {
    const saved = structuredClone(state);
    const next = transition(state, command);
    expect(state).toEqual(saved);
    expect(stateSchema.safeParse(next).success).toBe(true);
    state = next;
  }
  return state;
}

function item(state: AppState, key: string): WorkAction {
  const action = getRow(state, key)?.action;
  if (!action) throw new Error(`Expected local action at ${key}`);
  return action;
}

function capture(state: AppState, text: string): AppState {
  return run(state, { type: 'draft', text }, { type: 'capture' });
}

function refreshScenario(state: AppState, scenario: Extract<Command, { type: 'stage' }>['scenario']): AppState {
  return run(state, { type: 'stage', scenario }, { type: 'refresh' });
}

function completePrimary(): { state: AppState; actionId: string } {
  let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
  const actionId = state.activeId!;
  state = run(state,
    { type: 'edit', key: `a:${actionId}`, notes: 'Checked retries and backoff.', project: 'My freeform context' },
    { type: 'done', key: `a:${actionId}` });
  return { state, actionId };
}

describe('fixtures and projections', () => {
  test('valid deterministic fixtures select a source but never choose work', () => {
    const state = initialState();
    expect(stateSchema.safeParse(state).success).toBe(true);
    expect(state.clock).toBe('2026-09-11T09:40:00Z');
    expect(state.selectedKey).toBe(PRIMARY_KEY);
    expect(state.activeId).toBeNull();
    expect(state.refresh.lastSuccessAt).toBeNull();
    expect(state.refresh.status).toBe('saved');
    expect(getRows(state)[0]?.key).toBe(PRIMARY_KEY);
    expect(getRow(state, PRIMARY_KEY)?.thread?.lines).toBe(34);
    expect(getRow(state, TEAM_KEY)?.reason).toContain('integrations/terraform-provider-core-maintainers');
    expect(getRow(state, 't:demo-relay-99')?.kind).toBe('update');
    expect(getRows(state, 'later')[0]?.thread?.state).toBe('closed');
    expect(JSON.stringify(state)).not.toContain('https://');
    expect(state.threads.every(thread => thread.repo.startsWith('sample/'))).toBe(true);
  });

  test('selection records local seen state and does not write GitHub or choose work', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const activeId = state.activeId;
    const threads = structuredClone(state.threads);
    state = run(state, { type: 'select', key: TEAM_KEY }, { type: 'view', view: 'routines' });
    expect(state.activeId).toBe(activeId);
    expect(state.selectedKey).toBe(TEAM_KEY);
    expect(state.seen).toContain(TEAM_KEY);
    expect(state.threads).toEqual(threads);
    expect(getRows(state)).toEqual(getRows(state, 'routines'));
    state = run(state, { type: 'select', key: null });
    expect(state.activeId).toBe(activeId);
    expect(state.selectedKey).toBeNull();
  });

  test('editing a source creates durable work without choosing it; one grouped row remains', () => {
    const state = run(initialState(), { type: 'edit', key: PRIMARY_KEY, notes: 'Read error handling', nextStep: 'Check idempotency' });
    const action = item(state, PRIMARY_KEY);
    expect(action.eventIds).toEqual([REQUEST]);
    expect(action.notes).toBe('Read error handling');
    expect(state.activeId).toBeNull();
    expect(getRows(state).filter(row => row.thread?.id === PRIMARY)).toHaveLength(1);
    expect(getRows(state).some(row => row.key === `a:${action.id}`)).toBe(false);
    expect(getRow(state, 'missing')).toBeUndefined();
  });
});

describe('review completion is separate from source activity', () => {
  test('REGRESSION: done review followed by merge queue remains completed with no fresh review', () => {
    const completed = completePrimary();
    const state = refreshScenario(completed.state, 'merge-queue');
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
    expect(item(state, `a:${completed.actionId}`).notes).toBe('Checked retries and backoff.');
    expect(state.activeId).toBeNull();
    expect(state.actions.filter(action => action.threadId === PRIMARY)).toHaveLength(1);
    expect(getRows(state).filter(row => row.thread?.id === PRIMARY && row.kind === 'review')).toHaveLength(0);
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('update');
    expect(getRow(state, PRIMARY_KEY)?.thread?.state).toBe('queued');
    expect(getRow(state, PRIMARY_KEY)?.reason).toBe('Entered the merge queue · informational update');
    expect(state.handled).toContain(REQUEST);
    expect(state.selectedKey).toBe(PRIMARY_KEY);
  });

  test('a genuinely fresh request creates a distinct action and retains completed history', () => {
    const completed = completePrimary();
    let state = refreshScenario(completed.state, 're-request');
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('review');
    state = run(state, { type: 'start', key: PRIMARY_KEY });
    expect(state.activeId).not.toBe(completed.actionId);
    const current = item(state, `a:${state.activeId}`);
    expect(current.eventIds).not.toContain(REQUEST);
    expect(current.eventIds).toHaveLength(1);
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
    expect(getRows(state, 'history').some(row => row.action?.id === completed.actionId)).toBe(true);
    expect(getRows(state).filter(row => row.thread?.id === PRIMARY)).toHaveLength(1);
  });

  test.each(['comment', 'sticky-mention', 'closed'] as const)('%s cannot recreate a completed review', scenario => {
    const completed = completePrimary();
    const state = refreshScenario(completed.state, scenario);
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('update');
    expect(state.actions.filter(action => action.threadId === PRIMARY)).toHaveLength(1);
    if (scenario === 'sticky-mention') expect(getRow(state, PRIMARY_KEY)?.thread?.reason).toBe('mention');
  });

  test('an old mention reason plus a new ordinary update is not a fresh mention', () => {
    let state = run(initialState(), { type: 'select', key: 't:demo-docs-303' }, { type: 'done', key: 't:demo-docs-303' });
    state = refreshScenario(state, 'sticky-mention');
    const row = getRow(state, 't:demo-docs-303')!;
    expect(row.kind).toBe('update');
    expect(row.reason).toBe('Conversation update · no new obligation inferred');
    expect(row.events.some(event => event.kind === 'mention')).toBe(false);
  });

  test('Done handles only action-owned evidence, never later source events', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const actionId = state.activeId!;
    state = refreshScenario(state, 'comment');
    const comment = state.threads.find(thread => thread.id === PRIMARY)!.events.at(-1)!;
    state = run(state, { type: 'done', key: `a:${actionId}` });
    expect(state.handled).toContain(REQUEST);
    expect(state.handled).not.toContain(comment.id);
    expect(item(state, `a:${actionId}`).eventIds).toEqual([REQUEST]);
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('update');
    const thread = state.threads.find(entry => entry.id === PRIMARY)!;
    expect(thread.state).toBe('open');
    expect(thread.notification).toBe('unread');
    expect(thread.subscribed).toBe(true);
  });

  test('re-fetching the exact handled evidence does not duplicate it or regenerate a candidate', () => {
    const completed = completePrimary();
    const original = completed.state.threads.find(thread => thread.id === PRIMARY)!.events[0]!;
    const staged = { ...completed.state, staged: [structuredClone(original), structuredClone(original)] };
    const state = run(staged, { type: 'refresh' }, { type: 'refresh' });
    expect(state.threads.find(thread => thread.id === PRIMARY)?.events).toHaveLength(1);
    expect(getRows(state).some(row => row.thread?.id === PRIMARY)).toBe(false);
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
  });

  test('new commits represented as ordinary activity never manufacture review evidence', () => {
    const completed = completePrimary();
    const state = run({
      ...completed.state,
      staged: [{
        id: 'demo-commit-update', threadId: PRIMARY, kind: 'comment', at: completed.state.clock,
        actor: 'demo-author', summary: 'Pushed three new commits; generic source updated_at changed.',
      }],
    }, { type: 'refresh' });
    expect(getRows(state).find(row => row.thread?.id === PRIMARY)?.kind).toBe('update');
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
  });
});

describe('manual refresh and stable ordering', () => {
  test('staging is invisible until refresh; batch application preserves work, draft, selection, notes and order', () => {
    let state = run(initialState(),
      { type: 'start', key: PRIMARY_KEY },
      { type: 'edit', key: PRIMARY_KEY, notes: 'Do not lose me.' },
      { type: 'select', key: TEAM_KEY },
      { type: 'draft', text: 'Unsent thought' });
    const active = state.activeId;
    const beforeRows = getRows(state).map(row => row.key);
    state = run(state, { type: 'stage', scenario: 'new-review' }, { type: 'stage', scenario: 'comment' }, advance(1));
    expect(getRows(state).map(row => row.key)).toEqual(beforeRows);
    expect(state.staged).toHaveLength(2);
    expect(getRow(state, TEAM_KEY)?.events).toHaveLength(1);
    state = run(state, { type: 'refresh' });
    const keys = getRows(state).map(row => row.key);
    expect(keys.slice(0, beforeRows.length)).toEqual(beforeRows);
    expect(keys).toHaveLength(beforeRows.length + 1);
    expect(state.newKeys).toEqual([keys.at(-1)!]);
    expect(state.activeId).toBe(active);
    expect(state.selectedKey).toBe(TEAM_KEY);
    expect(item(state, PRIMARY_KEY).notes).toBe('Do not lose me.');
    expect(state.draft).toBe('Unsent thought');
    expect(state.staged).toHaveLength(0);
    expect(state.refresh.lastSuccessAt).toBe(state.clock);
    const again = run(state, { type: 'refresh' });
    expect(getRows(again).map(row => row.key)).toEqual(keys);
  });

  test('Reconsider alone reranks due work ahead of direct small reviews, team, tasks, updates', () => {
    let state = run(initialState(), { type: 'start', key: TEAM_KEY }, { type: 'select', key: PRIMARY_KEY }, advance(20));
    const before = getRows(state).map(row => row.key);
    expect(before.at(-1)).toBe(ROUTINE);
    const activeId = state.activeId;
    state = run(state, { type: 'edit', key: 'a:demo-local-task', notes: 'No rerank' });
    expect(getRows(state).map(row => row.key)).toEqual(before);
    state = run(state, { type: 'reconsider' });
    const keys = getRows(state).map(row => row.key);
    expect(keys.slice(0, 3)).toEqual([ROUTINE, PRIMARY_KEY, TEAM_KEY]);
    expect(keys.indexOf('a:demo-local-task')).toBeLessThan(keys.indexOf('t:demo-docs-303'));
    expect(state.activeId).toBe(activeId);
    expect(state.selectedKey).toBe(PRIMARY_KEY);
    expect(state.newKeys).toEqual([]);
  });

  test('error and partial refresh keep last full success and retryable staged evidence', () => {
    let state = run(initialState(), { type: 'refresh' }, advance(1),
      { type: 'stage', scenario: 'new-review' }, { type: 'stage', scenario: 'comment' });
    const last = state.refresh.lastSuccessAt;
    const oldThreads = structuredClone(state.threads);
    state = run(state, { type: 'configure', refreshFailure: 'error' }, { type: 'refresh' });
    expect(state.refresh.status).toBe('error');
    expect(state.refresh.lastSuccessAt).toBe(last);
    expect(state.threads).toEqual(oldThreads);
    expect(state.staged).toHaveLength(2);
    state = run(state, { type: 'configure', refreshFailure: 'partial' }, { type: 'refresh' });
    expect(state.refresh.status).toBe('partial');
    expect(state.refresh.lastSuccessAt).toBe(last);
    expect(state.staged).toHaveLength(1);
    expect(state.refresh.message).toContain('1 remain unavailable');
    state = run(state, { type: 'configure', refreshFailure: 'none' }, { type: 'refresh' });
    expect(state.refresh.status).toBe('ok');
    expect(state.staged).toHaveLength(0);
    expect(state.refresh.lastSuccessAt).toBe(state.clock);
  });

  test('successful empty notifications are not errors and do not remove local commitments', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const active = state.activeId;
    const actions = structuredClone(state.actions);
    state = refreshScenario(state, 'empty');
    expect(state.refresh.status).toBe('ok');
    expect(state.refresh.message).toContain('no source notifications');
    expect(state.threads.every(thread => thread.notification === 'done')).toBe(true);
    expect(state.actions).toEqual(actions);
    expect(state.activeId).toBe(active);
    expect(getRows(state).some(row => row.thread?.id === PRIMARY)).toBe(true);
    expect(getRows(state).some(row => row.thread?.id === 'demo-provider-202')).toBe(false);
  });

  test('read and acknowledged scenarios change nothing until explicit refresh', () => {
    let state = run(initialState(), { type: 'stage', scenario: 'read' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('unread');
    state = run(state, { type: 'refresh' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('read');
    expect(state.handled).not.toContain(REQUEST);
    state = run(state, { type: 'stage', scenario: 'acknowledged' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('read');
    state = run(state, { type: 'refresh' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('done');
    expect(state.actions.filter(action => action.threadId === PRIMARY)).toEqual([]);
    expect(state.handled).toContain(REQUEST);
  });

  test('review-only scenarios fall back from an issue to the primary PR', () => {
    const state = run(initialState(), { type: 'select', key: 't:demo-docs-303' },
      { type: 'stage', scenario: 'merge-queue' });
    expect(state.staged[0]?.threadId).toBe(PRIMARY);
    expect(state.selectedKey).toBe('t:demo-docs-303');
  });
});

describe('capture transactions and safe interpretation', () => {
  test('capture preserves exact original before interpretation; metadata is unrestricted', () => {
    const raw = '  Review demo://github/sample/relay/pull/101\nAfter checking retries.  ';
    let state = capture(initialState(), raw);
    const key = state.selectedKey!;
    expect(item(state, key).captures).toEqual([raw]);
    expect(item(state, key).interpretation).toBe('pending');
    expect(item(state, key).threadId).toBeUndefined();
    expect(state.draft).toBe('');
    expect(state.activeId).toBeNull();
    state = run(state, { type: 'edit', key, project: 'anything / no routing required', notes: 'keep original', nextStep: 'Ask a human' });
    expect(item(state, key).project).toBe('anything / no routing required');
    state = run(state, { type: 'interpret', key });
    expect(item(state, key).captures).toEqual([raw]);
    expect(item(state, key).threadId).toBe(PRIMARY);
    expect(item(state, key).notes).toBe('keep original');
    expect(getRows(state).filter(row => row.thread?.id === PRIMARY)).toHaveLength(1);
    expect(getRows(state).some(row => row.key === key)).toBe(false);
  });

  test('linked captures merge only the same outstanding review, retaining both originals and existing edits', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY },
      { type: 'edit', key: PRIMARY_KEY, notes: 'Existing review note', project: 'Existing project' });
    const active = state.activeId!;
    const one = 'Review demo://github/sample/relay/pull/101';
    const two = 'https://github.com/sample/relay/pull/101';
    state = capture(state, one);
    state = run(state, { type: 'interpret', key: state.selectedKey! });
    state = capture(state, two);
    state = run(state, { type: 'interpret', key: state.selectedKey! });
    expect(state.activeId).toBe(active);
    expect(state.actions.filter(action => action.threadId === PRIMARY)).toHaveLength(1);
    expect(item(state, `a:${active}`).captures).toEqual([one, two]);
    expect(item(state, `a:${active}`).notes).toBe('Existing review note');
    expect(item(state, `a:${active}`).project).toBe('Existing project');
    expect(item(state, `a:${active}`).origin).toBe('capture');
  });

  test('a later request captured after completion never merges into the completed action', () => {
    const completed = completePrimary();
    let state = refreshScenario(completed.state, 're-request');
    state = capture(state, 'Review demo://github/sample/relay/pull/101');
    const key = state.selectedKey!;
    state = run(state, { type: 'interpret', key });
    expect(item(state, key).id).not.toBe(completed.actionId);
    expect(item(state, key).eventIds).not.toContain(REQUEST);
    expect(item(state, `a:${completed.actionId}`).captures).toEqual([]);
    expect(item(state, `a:${completed.actionId}`).status).toBe('done');
    expect(getRows(state).filter(row => row.thread?.id === PRIMARY)).toHaveLength(1);
  });

  test.each([
    'This is just a thought about lunch.',
    'Review http://github.com/sample/relay/pull/101',
    'Review https://github.com.evil.test/sample/relay/pull/101',
    'Review https://github.com@evil.test/sample/relay/pull/101',
    'Review https://user@github.com/sample/relay/pull/101',
    'Review https://github.com/sample/relay/pull/101?redirect=unsafe',
    'Review https://github.com/sample/relay/pull/0',
    'Review https://github.com/sample/relay/issues/101',
    'Review demo://github/other/relay/pull/101',
    'Review https://github.com/sample/relay/pull/9007199254740992',
    'Review https://github.com/unused/../sample/relay/pull/101',
    'Review https://github.com/sample/relay/pull/101 and https://github.com/sample/relay/pull/102',
    'Every day at 10, announce the change, then increase the feature flag.',
    'Every weekday at 10am, announce the change, then increase the feature flag.',
    'Every day at 13pm, announce the change, then increase the feature flag.',
    'Every day at 10:99, announce the change, then increase the feature flag.',
  ])('unsupported input remains a saved task: %s', raw => {
    let state = capture(initialState(), raw);
    const key = state.selectedKey!;
    state = run(state, { type: 'interpret', key });
    const action = item(state, key);
    expect(action.interpretation).toBe('unsupported');
    expect(action.captures).toEqual([raw]);
    expect(action.threadId).toBeUndefined();
    expect(action.routine).toBeUndefined();
  });

  test('interpretation failure retains raw text and retry works without recapture', () => {
    const raw = 'Review demo://github/sample/relay/pull/101';
    let state = capture(initialState(), raw);
    const key = state.selectedKey!;
    state = run(state, { type: 'configure', interpretationFailure: true }, { type: 'interpret', key });
    expect(item(state, key).interpretation).toBe('error');
    expect(item(state, key).captures).toEqual([raw]);
    state = run(state, { type: 'configure', interpretationFailure: false }, { type: 'interpret', key });
    expect(item(state, key).interpretation).toBe('supported');
    expect(item(state, key).threadId).toBe(PRIMARY);
  });
});

describe('notification writes and local undo', () => {
  test('read, notification Done and unsubscribe are explicit and do not finish local work', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY },
      { type: 'edit', key: PRIMARY_KEY, notes: 'Keep working' });
    const active = state.activeId!;
    state = run(state, { type: 'notification', threadId: PRIMARY, action: 'read' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('read');
    expect(state.handled).not.toContain(REQUEST);
    state = run(state, { type: 'notification', threadId: PRIMARY, action: 'done' });
    expect(state.handled).toContain(REQUEST);
    expect(item(state, `a:${active}`).status).toBe('available');
    expect(state.activeId).toBe(active);
    state = run(state, { type: 'notification', threadId: PRIMARY, action: 'unsubscribe' });
    expect(getRow(state, PRIMARY_KEY)?.thread?.subscribed).toBe(false);
    expect(item(state, `a:${active}`).notes).toBe('Keep working');
    expect(item(state, `a:${active}`).status).toBe('available');
  });

  test('unsubscribe suppresses ordinary activity but a new mention can notify again', () => {
    let state = run(initialState(), { type: 'notification', threadId: PRIMARY, action: 'unsubscribe' });
    state = refreshScenario(state, 'comment');
    expect(getRows(state).some(row => row.thread?.id === PRIMARY)).toBe(false);
    state = refreshScenario(state, 'mention');
    expect(getRow(state, PRIMARY_KEY)?.thread?.subscribed).toBe(true);
    expect(getRow(state, PRIMARY_KEY)?.thread?.notification).toBe('unread');
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('update');
    expect(getRows(state).find(row => row.thread?.id === PRIMARY)?.events).toHaveLength(1);
  });

  test('simulated external failures throw without success-shaped state changes', () => {
    const state = run(initialState(), { type: 'configure', externalFailure: true });
    const before = structuredClone(state);
    for (const action of ['read', 'done', 'unsubscribe'] as const) {
      expect(() => transition(state, { type: 'notification', threadId: PRIMARY, action })).toThrow('write failed');
      expect(state).toEqual(before);
    }
    const completed = run(state, { type: 'done', key: PRIMARY_KEY });
    expect(item(completed, PRIMARY_KEY).status).toBe('done');
  });

  test('undo after source refresh preserves source updates, external acknowledgement, subsequent notes and captures', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const active = state.activeId!;
    state = run(state, { type: 'done', key: `a:${active}` });
    state = refreshScenario(state, 'merge-queue');
    state = run(state,
      { type: 'notification', threadId: PRIMARY, action: 'done' },
      { type: 'notification', threadId: PRIMARY, action: 'unsubscribe' },
      { type: 'edit', key: `a:${active}`, notes: 'Added after completion', nextStep: 'Keep this new next step' });
    state = capture(state, 'A different captured task after completion');
    const captured = item(state, state.selectedKey!);
    const threads = structuredClone(state.threads);
    const refresh = structuredClone(state.refresh);
    state = run(state, { type: 'undo' });
    expect(item(state, `a:${active}`).status).toBe('available');
    expect(item(state, `a:${active}`).notes).toBe('Added after completion');
    expect(item(state, `a:${active}`).nextStep).toBe('Keep this new next step');
    expect(item(state, `a:${captured.id}`).captures).toEqual(captured.captures);
    expect(state.threads).toEqual(threads);
    expect(state.refresh).toEqual(refresh);
    expect(state.handled).toContain(REQUEST);
    expect(state.activeId).toBe(active);
  });

  test('undo local completion without an external acknowledgement removes only local handling', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const active = state.activeId!;
    state = run(state, { type: 'done', key: `a:${active}` });
    state = refreshScenario(state, 'comment');
    const source = structuredClone(state.threads);
    state = run(state, { type: 'undo' });
    expect(state.handled).not.toContain(REQUEST);
    expect(state.handled).toContain('demo-relay-99:request-1');
    expect(state.threads).toEqual(source);
    expect(item(state, `a:${active}`).status).toBe('available');
    expect(state.activeId).toBe(active);
  });

  test('an earlier acknowledgement at the same clock time does not protect a later request from local undo', () => {
    let state = run(initialState(), { type: 'notification', threadId: PRIMARY, action: 'done' });
    state = refreshScenario(state, 're-request');
    const event = state.threads.find(thread => thread.id === PRIMARY)!.events.at(-1)!;
    state = run(state, { type: 'done', key: PRIMARY_KEY });
    expect(state.handled).toContain(event.id);
    state = run(state, { type: 'undo' });
    expect(state.handled).not.toContain(event.id);
    expect(state.handled).toContain(REQUEST);
    expect(getRow(state, PRIMARY_KEY)?.kind).toBe('review');
  });

  test('undo direct candidate completion preserves later note edits as a retained available action', () => {
    let state = run(initialState(), { type: 'done', key: PRIMARY_KEY });
    const id = item(state, PRIMARY_KEY).id;
    state = run(state, { type: 'edit', key: `a:${id}`, notes: 'A note written after Done' }, { type: 'undo' });
    expect(item(state, `a:${id}`).notes).toBe('A note written after Done');
    expect(item(state, `a:${id}`).status).toBe('available');
    expect(item(state, `a:${id}`).completedAt).toBeUndefined();
    expect(state.activeId).toBeNull();
    expect(state.handled).not.toContain(REQUEST);
  });

  test('switch, Later and removal are recoverable without losing notes', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const first = state.activeId!;
    state = run(state, { type: 'start', key: TEAM_KEY });
    expect(state.activeId).not.toBe(first);
    state = run(state, { type: 'undo' });
    expect(state.activeId).toBe(first);
    state = run(state, { type: 'later', key: `a:${first}`, note: 'Waiting' },
      { type: 'edit', key: `a:${first}`, notes: 'New waiting details' }, { type: 'undo' });
    expect(item(state, `a:${first}`).status).toBe('available');
    expect(item(state, `a:${first}`).notes).toBe('New waiting details');
    expect(state.activeId).toBe(first);
    state = run(state, { type: 'remove', key: `a:${first}` });
    expect(getRows(state, 'history').some(row => row.action?.id === first)).toBe(true);
    state = run(state, { type: 'restore', key: `a:${first}` });
    expect(item(state, `a:${first}`).status).toBe('available');
    expect(state.activeId).toBeNull();
  });
});

describe('Later and independent reminders', () => {
  test('Later without a reminder stays retained through new activity and time', () => {
    let state = run(initialState(), { type: 'later', key: PRIMARY_KEY, note: 'Waiting for a response' });
    const retained = getRows(state, 'later').find(row => row.thread?.id === PRIMARY)!.action!;
    expect(state.handled).toContain(REQUEST);
    expect(getRows(state).some(row => row.thread?.id === PRIMARY)).toBe(false);
    state = refreshScenario(state, 'comment');
    expect(getRows(state).find(row => row.thread?.id === PRIMARY)?.kind).toBe('update');
    expect(getRows(state).find(row => row.thread?.id === PRIMARY)?.action).toBeUndefined();
    state = run(state, advance(3 * 1440));
    expect(item(state, `a:${retained.id}`).status).toBe('later');
    expect(item(state, `a:${retained.id}`).notes).toBe('Waiting for a response');
    expect(reminders(state).some(action => action.id === retained.id)).toBe(false);
  });

  test('a due local reminder appends its action row without moving existing work or selection', () => {
    let state = run(initialState(),
      { type: 'later', key: PRIMARY_KEY, remindAt: '2026-09-11T09:50:00Z', note: 'Check again' });
    const retained = getRows(state, 'later').find(row => row.thread?.id === PRIMARY)!.action!;
    state = run(state, { type: 'start', key: TEAM_KEY }, { type: 'select', key: TEAM_KEY });
    const active = state.activeId;
    const keys = getRows(state).map(row => row.key);
    state = run(state, advance(10));
    expect(getRows(state).map(row => row.key)).toEqual([...keys, `a:${retained.id}`]);
    expect(state.newKeys).toContain(`a:${retained.id}`);
    expect(state.activeId).toBe(active);
    expect(state.selectedKey).toBe(TEAM_KEY);
    expect(state.refresh.lastSuccessAt).toBeNull();
    expect(reminders(state).map(action => action.id)).toContain(retained.id);
    expect(item(state, `a:${retained.id}`).status).toBe('later');
    state = run(state, { type: 'reminder', key: `a:${retained.id}`, action: 'snooze' });
    expect(reminders(state).some(action => action.id === retained.id)).toBe(false);
    expect(item(state, `a:${retained.id}`).remindAt).toBe('2026-09-11T10:20:00Z');
    state = run(state, advance(30), { type: 'reminder', key: `a:${retained.id}`, action: 'dismiss' }, advance(60));
    expect(reminders(state).some(action => action.id === retained.id)).toBe(false);
    expect(item(state, `a:${retained.id}`).status).toBe('later');
  });

  test('restoring or starting retained work is explicit; incoming requests never move it', () => {
    let state = run(initialState(), { type: 'later', key: PRIMARY_KEY });
    const key = getRows(state, 'later').find(row => row.thread?.id === PRIMARY)!.key;
    state = refreshScenario(state, 're-request');
    expect(item(state, key).status).toBe('later');
    expect(getRows(state).find(row => row.thread?.id === PRIMARY)?.kind).toBe('update');
    state = run(state, { type: 'restore', key });
    expect(item(state, key).status).toBe('available');
    expect(state.activeId).toBeNull();
    state = run(state, { type: 'start', key });
    expect(state.activeId).toBe(item(state, key).id);
  });

  test('Later validates future timestamps and normalizes explicit offsets to UTC', () => {
    const state = initialState();
    for (const remindAt of ['garbage', '2026-09-11T09:00:00Z', state.clock]) {
      expect(() => transition(state, { type: 'later', key: PRIMARY_KEY, remindAt })).toThrow();
    }
    const next = run(state, { type: 'later', key: PRIMARY_KEY, remindAt: '2026-09-11T11:00:00+01:00' });
    expect(getRows(next, 'later').find(row => row.thread?.id === PRIMARY)?.action?.remindAt).toBe('2026-09-11T10:00:00Z');
  });
});

describe('daily routines and calendar arithmetic', () => {
  test('10am is explicit in the chosen timezone and becomes due independently of Refresh', () => {
    let state = initialState('America/Los_Angeles');
    expect(state.clock).toBe('2026-09-11T16:40:00Z');
    expect(item(state, ROUTINE).routine?.nextDueAt).toBe('2026-09-11T17:00:00Z');
    expect(reminders(state)).toEqual([]);
    state = run(state, advance(20));
    expect(item(state, ROUTINE).routine?.dueAt).toBe('2026-09-11T17:00:00Z');
    expect(item(state, ROUTINE).routine?.nextDueAt).toBe('2026-09-12T17:00:00Z');
    expect(reminders(state).map(action => action.id)).toEqual(['demo-daily-routine']);
    expect(state.activeId).toBeNull();
    expect(state.selectedKey).toBe(PRIMARY_KEY);
    expect(state.refresh.lastSuccessAt).toBeNull();
  });

  test('ordered steps retain timestamps; completion requires every step and keeps recurrence available', () => {
    let state = run(initialState(), advance(20), { type: 'start', key: ROUTINE });
    expect(reminders(state).some(action => action.id === 'demo-daily-routine')).toBe(false);
    expect(() => transition(state, { type: 'done', key: ROUTINE })).toThrow('every routine step');
    expect(() => transition(state, { type: 'step', key: ROUTINE, stepId: 'increase' })).toThrow('earlier steps');
    state = run(state, { type: 'step', key: ROUTINE, stepId: 'announce' }, advance(5));
    expect(item(state, ROUTINE).steps[0]?.doneAt).toBe('2026-09-11T10:00:00Z');
    expect(item(state, ROUTINE).routine?.history).toEqual([]);
    expect(() => transition(state, { type: 'done', key: ROUTINE })).toThrow('every routine step');
    state = run(state, { type: 'step', key: ROUTINE, stepId: 'increase' });
    expect(item(state, ROUTINE).routine?.history).toEqual([]);
    state = run(state, { type: 'done', key: ROUTINE });
    const completed = item(state, ROUTINE);
    expect(completed.status).toBe('available');
    expect(completed.routine?.dueAt).toBeUndefined();
    expect(completed.routine?.history).toEqual([{
      dueAt: '2026-09-11T10:00:00Z', status: 'done',
      steps: [
        { id: 'announce', title: 'Announce the change', doneAt: '2026-09-11T10:00:00Z' },
        { id: 'increase', title: 'Increase the feature flag', doneAt: '2026-09-11T10:05:00Z' },
      ],
    }]);
    expect(completed.steps.every(step => !step.doneAt)).toBe(true);
    expect(state.activeId).toBeNull();
    state = run(state, advance(1435));
    expect(item(state, ROUTINE).routine?.dueAt).toBe('2026-09-12T10:00:00Z');
    expect(item(state, ROUTINE).steps.every(step => !step.doneAt)).toBe(true);
    expect(reminders(state).some(action => action.id === 'demo-daily-routine')).toBe(true);
  });

  test('missed days coalesce into one outstanding occurrence without borrowing old step progress', () => {
    let state = run(initialState(), advance(20), { type: 'step', key: ROUTINE, stepId: 'announce' }, advance(3 * 1440));
    const routine = item(state, ROUTINE).routine!;
    expect(routine.dueAt).toBe('2026-09-11T10:00:00Z');
    expect(routine.nextDueAt).toBe('2026-09-15T10:00:00Z');
    expect(routine.history.map(occurrence => [occurrence.dueAt, occurrence.status])).toEqual([
      ['2026-09-12T10:00:00Z', 'missed'],
      ['2026-09-13T10:00:00Z', 'missed'],
      ['2026-09-14T10:00:00Z', 'missed'],
    ]);
    expect(routine.history.every(occurrence => occurrence.steps.every(step => !step.doneAt))).toBe(true);
    expect(item(state, ROUTINE).steps[0]?.doneAt).toBe('2026-09-11T10:00:00Z');
    expect(getRow(state, ROUTINE)?.reason).toContain('Stale progress');
    expect(reminders(state).filter(action => action.id === 'demo-daily-routine')).toHaveLength(1);
    state = run(state, advance(0));
    expect(item(state, ROUTINE).routine?.history).toHaveLength(3);
  });

  test('snooze, dismiss and skip do not complete an unfinished routine', () => {
    let state = run(initialState(), advance(20),
      { type: 'step', key: ROUTINE, stepId: 'announce' },
      { type: 'reminder', key: ROUTINE, action: 'snooze' });
    expect(item(state, ROUTINE).routine?.snoozedUntil).toBe('2026-09-11T10:30:00Z');
    expect(reminders(state)).toEqual([]);
    expect(item(state, ROUTINE).routine?.history).toEqual([]);
    state = run(state, advance(30));
    expect(reminders(state).some(action => action.id === 'demo-daily-routine')).toBe(true);
    state = run(state, { type: 'reminder', key: ROUTINE, action: 'dismiss' }, advance(1440));
    expect(reminders(state).some(action => action.id === 'demo-daily-routine')).toBe(false);
    expect(item(state, ROUTINE).routine?.dueAt).toBe('2026-09-11T10:00:00Z');
    expect(item(state, ROUTINE).steps[0]?.doneAt).toBe('2026-09-11T10:00:00Z');
    state = run(state, { type: 'reminder', key: ROUTINE, action: 'skip' });
    expect(item(state, ROUTINE).routine?.history.at(-1)?.status).toBe('skipped');
    expect(item(state, ROUTINE).routine?.history.some(occurrence => occurrence.status === 'done')).toBe(false);
    expect(item(state, ROUTINE).routine?.dueAt).toBeUndefined();
    expect(item(state, ROUTINE).status).toBe('available');
    state = run(state, advance(1440));
    expect(reminders(state).some(action => action.id === 'demo-daily-routine')).toBe(true);
  });

  test('an explicitly captured daily routine records the timezone and ordered steps', () => {
    const raw = 'Every day at 10am, announce the change, then increase the feature flag.';
    let state = capture(initialState('Asia/Kolkata'), raw);
    const key = state.selectedKey!;
    state = run(state, { type: 'interpret', key });
    expect(item(state, key).routine?.time).toBe('10:00');
    expect(item(state, key).routine?.timeZone).toBe('Asia/Kolkata');
    expect(item(state, key).routine?.nextDueAt).toBe('2026-09-11T04:30:00Z');
    expect(item(state, key).steps.map(step => step.title)).toEqual(['announce the change', 'increase the feature flag']);
    expect(item(state, key).captures).toEqual([raw]);
    state = run(state, advance(20));
    const stepId = item(state, key).steps[0]!.id;
    state = run(state, { type: 'step', key, stepId }, { type: 'interpret', key });
    expect(item(state, key).steps[0]?.doneAt).toBe('2026-09-11T04:30:00Z');
  });

  test('daily schedules use timezone calendars across 23-hour and 25-hour days', () => {
    expect(followingDay('2026-10-31T14:00:00Z', '10:00', 'America/New_York')).toBe('2026-11-01T15:00:00Z');
    expect(followingDay('2027-03-13T15:00:00Z', '10:00', 'America/New_York')).toBe('2027-03-14T14:00:00Z');
    expect(followingDay('2026-09-11T10:00:00Z', '10:00', 'UTC')).toBe('2026-09-12T10:00:00Z');
    expect(nextDaily('2027-03-14T06:00:00Z', '02:30', 'America/New_York')).toBe('2027-03-14T07:30:00Z');
    expect(followingDay('2027-03-14T07:30:00Z', '02:30', 'America/New_York')).toBe('2027-03-15T06:30:00Z');
  });

  test('clock reconciliation across DST preserves historical occurrence instants', () => {
    let state = initialState('America/New_York');
    const target = '2026-11-01T15:00:00Z';
    const minutes = (Date.parse(target) - Date.parse(state.clock)) / 60_000;
    state = run(state, advance(minutes));
    const routine = item(state, ROUTINE).routine!;
    expect(routine.history.some(occurrence => occurrence.dueAt === '2026-10-31T14:00:00Z')).toBe(true);
    expect(routine.history.some(occurrence => occurrence.dueAt === target)).toBe(true);
    expect(routine.nextDueAt).toBe('2026-11-02T15:00:00Z');
    expect(routine.dueAt).toBe('2026-09-11T14:00:00Z');
  });

  test('undo completion after another day revives the old occurrence instead of transplanting its steps', () => {
    let state = run(initialState(), advance(20),
      { type: 'step', key: ROUTINE, stepId: 'announce' },
      { type: 'step', key: ROUTINE, stepId: 'increase' },
      { type: 'done', key: ROUTINE }, advance(2 * 1440),
      { type: 'edit', key: ROUTINE, notes: 'Later note, independent of completion' },
      { type: 'undo' });
    const action = item(state, ROUTINE);
    expect(action.routine?.dueAt).toBe('2026-09-11T10:00:00Z');
    expect(action.routine?.nextDueAt).toBe('2026-09-14T10:00:00Z');
    expect(action.routine?.history.every(occurrence => occurrence.status === 'missed')).toBe(true);
    expect(action.routine?.history.map(occurrence => occurrence.dueAt).sort()).toEqual([
      '2026-09-12T10:00:00Z', '2026-09-13T10:00:00Z',
    ]);
    expect(action.routine?.history.every(occurrence => occurrence.steps.every(step => !step.doneAt))).toBe(true);
    expect(action.steps.every(step => step.doneAt === '2026-09-11T10:00:00Z')).toBe(true);
    expect(action.notes).toBe('Later note, independent of completion');
    state = run(state, advance(0));
    expect(item(state, ROUTINE).routine?.history).toHaveLength(2);
  });

  test('undo snooze preserves missed-day reconciliation while removing the snooze', () => {
    const state = run(initialState(), advance(20),
      { type: 'reminder', key: ROUTINE, action: 'snooze' }, advance(1440), { type: 'undo' });
    expect(item(state, ROUTINE).routine?.snoozedUntil).toBeUndefined();
    expect(item(state, ROUTINE).routine?.history).toHaveLength(1);
    expect(item(state, ROUTINE).routine?.nextDueAt).toBe('2026-09-13T10:00:00Z');
  });
});

describe('reset and validation', () => {
  test('reset retains user captures with notes, progress, lifecycle and selected active work', () => {
    let state = capture(initialState(), 'Every day at 10am, announce the change, then increase the feature flag.');
    const routineKey = state.selectedKey!;
    state = run(state, { type: 'interpret', key: routineKey }, advance(20),
      { type: 'start', key: routineKey },
      { type: 'edit', key: routineKey, notes: 'My user note', project: 'Personal daily context' });
    state = run(state, { type: 'step', key: routineKey, stepId: item(state, routineKey).steps[0]!.id });
    const saved = structuredClone(item(state, routineKey));
    state = run(state, { type: 'draft', text: 'Keep this unfinished draft' }, { type: 'stage', scenario: 'new-review' }, { type: 'reset' });
    expect(item(state, routineKey)).toEqual(saved);
    expect(state.activeId).toBe(saved.id);
    expect(state.selectedKey).toBe(routineKey);
    expect(state.draft).toBe('Keep this unfinished draft');
    expect(state.staged).toEqual([]);
    expect(state.undo).toEqual([]);
    expect(state.clock).toBe('2026-09-11T10:00:00Z');
  });

  test('reset retains captures merged into fixture actions, including completed review identity', () => {
    let state = run(initialState(), { type: 'start', key: PRIMARY_KEY });
    const id = state.activeId!;
    state = capture(state, 'Review demo://github/sample/relay/pull/101');
    state = run(state, { type: 'interpret', key: state.selectedKey! },
      { type: 'edit', key: `a:${id}`, notes: 'User context survives reset' },
      { type: 'done', key: `a:${id}` }, { type: 'reset' });
    expect(item(state, `a:${id}`).captures).toEqual(['Review demo://github/sample/relay/pull/101']);
    expect(item(state, `a:${id}`).notes).toBe('User context survives reset');
    expect(item(state, `a:${id}`).status).toBe('done');
    expect(state.handled).toContain(REQUEST);
    expect(getRows(state).some(row => row.thread?.id === PRIMARY && row.kind === 'review')).toBe(false);
  });

  test('storage failure is a visible flag, not a reason to discard pending in-memory edits', () => {
    const state = run(initialState(), { type: 'configure', storageFailure: true },
      { type: 'edit', key: PRIMARY_KEY, notes: 'Pending save, still recoverable' });
    expect(state.failures.storage).toBe(true);
    expect(item(state, PRIMARY_KEY).notes).toBe('Pending save, still recoverable');
  });

  test('invalid commands throw useful errors without altering their input', () => {
    const state = initialState();
    const commands: [Command, string][] = [
      [{ type: 'select', key: 'a:no-such-action' }, 'no longer exists'],
      [{ type: 'capture' }, 'Write something'],
      [{ type: 'undo' }, 'no local change'],
      [{ type: 'start', key: ROUTINE }, 'not due'],
      [{ type: 'step', key: ROUTINE, stepId: 'announce' }, 'no due occurrence'],
      [{ type: 'edit', key: PRIMARY_KEY, title: '  ' }, 'cannot be empty'],
      [advance(-1), 'non-negative'],
      [advance(Number.NaN), 'non-negative'],
      [{ type: 'reminder', key: ROUTINE, action: 'skip' }, 'no due reminder'],
    ];
    for (const [command, message] of commands) {
      const saved = structuredClone(state);
      expect(() => transition(state, command)).toThrow(message);
      expect(state).toEqual(saved);
    }
    expect(() => initialState('Not/A_Timezone')).toThrow('Unknown timezone');
  });
});
