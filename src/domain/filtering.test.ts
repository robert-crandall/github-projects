import { expect, test } from 'bun:test';
import { getRow, getRows, transition } from './engine.ts';
import { emptyWorkspace, mergeRefresh, restoreDesktop } from './live.ts';
import { migrateWorkspace } from './migration.ts';
import { matchingRules, matchesRule, placement, validateFilters, viewLabel } from './filtering.ts';
import { ruleSchema, type AppState, type Rule, type Thread } from '../types.ts';

const at = (hour: number) => `2026-09-11T${String(hour).padStart(2, '0')}:00:00Z`;
const source = (state: NonNullable<Thread['sourceState']>['state'] = 'open', hour = 10, notificationHour = 9): Thread => ({
  id: '123', repo: 'octo/project', kind: 'pr', number: 1, title: 'Fix literal [retry] handling',
  source: 'github', reason: 'mention', notification: 'unread', notificationUpdatedAt: at(notificationHour), subscribed: true,
  state: 'open', events: [{ id: 'first', threadId: '123', kind: 'comment', at: at(9), actor: 'octocat', summary: 'Initial', requestState: 'not-request' }],
  sourceState: { state, observedAt: at(hour), updatedAt: at(hour - 1), error: state === 'unknown'
    ? { code: 'access', message: 'Current state denied.', retryable: false } : null },
});
const refresh = (state: AppState, incoming = source(), hour = 10) =>
  mergeRefresh(state, { threads: [incoming], startedAt: at(hour), fetchedAt: at(hour), status: 'complete', diagnostics: [] });
const route: Rule = { id: 'route', name: 'Project', enabled: true, criteria: { repo: 'OCTO/project' }, action: { type: 'inbox', inboxId: 'work' } };
const exclude: Rule = { id: 'exclude', name: 'Retry', enabled: true, criteria: { kind: 'pr', title: '[RETRY]' }, action: { type: 'exclude' } };
function workspace() {
  let state = refresh(emptyWorkspace(at(10), 'UTC'));
  state = transition(state, { type: 'save-inbox', inbox: { id: 'work', name: 'Work' } });
  state = transition(state, { type: 'note', threadId: '123', text: 'Private preserved annotation' });
  state = transition(state, { type: 'draft', text: 'Fix literal [retry] handling' });
  state = transition(state, { type: 'capture' });
  state = transition(state, { type: 'select', key: 't:123' });
  return state;
}

test('literal AND rules, preview and first-enabled order agree without moving Tasks, notes or selection', () => {
  let state = workspace();
  const original = structuredClone(state);
  expect(matchesRule(exclude, source())).toBe(true);
  expect(matchesRule({ ...exclude, criteria: { ...exclude.criteria, kind: 'issue' } }, source())).toBe(false);
  expect(matchesRule({ ...exclude, criteria: { title: '.*' } }, source())).toBe(false);
  const preview = { ...state, rules: [route, exclude] };
  expect(matchingRules(preview, source()).map(rule => rule.id)).toEqual(['route', 'exclude']);
  expect(placement(preview, source()).view).toBe('inbox:work');
  expect(state).toEqual(original);
  for (const rule of [route, exclude]) state = transition(state, { type: 'save-rule', rule });
  expect(getRows(state, 'inbox:work')).toHaveLength(1);
  expect(getRows(state, 'filtered')).toEqual([]);
  state = transition(state, { type: 'move-rule', id: 'exclude', direction: 'up' });
  expect(getRows(state, 'filtered')).toHaveLength(1);
  expect(getRows(state, 'inbox:work')).toEqual([]);
  state = transition(state, { type: 'enable-rule', id: 'exclude', enabled: false });
  expect(getRows(state, 'inbox:work')).toHaveLength(1);
  state = transition(state, { type: 'save-rule', rule: { ...route, criteria: { kind: 'issue' } } });
  expect(getRows(state, 'inbox')).toHaveLength(1);
  for (const id of ['route', 'exclude']) state = transition(state, { type: 'delete-rule', id });
  expect(state.tasks).toEqual(original.tasks);
  expect(state.notes).toEqual(original.notes);
  expect(state.selectedKey).toBe(original.selectedKey);
  expect(state.order).toEqual(original.order);
  expect(state.handled).toEqual(original.handled);
  expect(state.operations).toEqual([]);
});

test('strict criteria reject blank, malformed and unknown input; inboxes reject duplicates and broken references', () => {
  for (const criteria of [{}, { title: '   ' }, { repo: 'octo' }, { repo: '*' }, { kind: 'task' }, { regex: '.+' }]) {
    expect(ruleSchema.safeParse({ ...route, criteria }).success).toBe(false);
  }
  const state = workspace();
  for (const name of ['', ' ', ' inbox ', 'Tasks', 'ARCHIVE', 'Filtered', 'work']) {
    expect(() => transition(state, { type: 'save-inbox', inbox: { id: 'another', name } })).toThrow();
  }
  expect(() => transition(state, { type: 'save-rule', rule: { ...route, action: { type: 'inbox', inboxId: 'missing' } } })).toThrow('existing destination');
  expect(() => migrateWorkspace({ ...state, rules: [{ ...route, criteria: {} }] })).toThrow();
  expect(() => validateFilters({ ...state, view: 'inbox:missing' })).toThrow();
});

test('rules and inbox identity persist; deletion is blocked even for disabled rules and never erases content', () => {
  let state = transition(workspace(), { type: 'save-rule', rule: { ...route, enabled: false } });
  state = transition(state, { type: 'view', view: 'inbox:work' });
  state = transition(state, { type: 'save-inbox', inbox: { id: 'work', name: 'Renamed work' } });
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at(11));
  expect(viewLabel(state, 'inbox:work')).toBe('Renamed work');
  expect(state.rules[0]!.action).toEqual({ type: 'inbox', inboxId: 'work' });
  expect(() => transition(state, { type: 'delete-inbox', id: 'work' })).toThrow('disabled rules');
  state = transition(state, { type: 'delete-rule', id: 'route' });
  state = transition(state, { type: 'delete-inbox', id: 'work' });
  expect(state.view).toBe('inbox');
  expect(state.notes).toHaveLength(1);
  expect(state.tasks).toHaveLength(1);
  const legacy = { ...state, inboxes: undefined, rules: undefined };
  expect(migrateWorkspace(legacy).rules).toEqual([]);
});

test('Archive and terminal preview take precedence; changing or deleting rules cannot restore manual Archive', () => {
  let state = transition(workspace(), { type: 'save-rule', rule: route });
  state = transition(state, { type: 'archive', threadId: '123' });
  expect(placement(state, state.threads[0]!).view).toBe('archive');
  state = transition(state, { type: 'delete-rule', id: route.id });
  expect(getRows(state, 'archive')).toHaveLength(1);
  state = transition(state, { type: 'save-rule', rule: route });
  state = refresh(state, source('queued', 11), 11);
  expect(placement(state, state.threads[0]!).view).toBe('archive');
  state = transition(state, { type: 'restore-thread', threadId: '123' });
  expect(placement(state, state.threads[0]!)).toMatchObject({ view: 'filtered', matches: [route] });
  expect(state.operations).toEqual([]);
  state = refresh(state, source('open', 12), 12);
  state = transition(state, { type: 'archive', threadId: '123' });
  state = transition(state, { type: 'restore-thread', threadId: '123' });
  expect(getRows(state, 'inbox:work')).toHaveLength(1);
});

for (const terminal of ['queued', 'closed', 'merged'] as const) {
  test(`${terminal} suppresses newer activity without writes; exit/reopen requires fresh evidence, not old history`, () => {
    let state = transition(workspace(), { type: 'save-rule', rule: route });
    state = refresh(state, source(terminal, 11), 11);
    const original = structuredClone(state);
    expect(getRows(state, 'filtered')).toHaveLength(1);
    expect(getRows(state, 'inbox:work')).toEqual([]);
    const incoming = source(terminal, 13, 12);
    incoming.events.push({ ...incoming.events[0]!, id: 'terminal-comment', at: at(12) });
    state = refresh(state, incoming, 13);
    expect(getRows(state, 'filtered')).toHaveLength(1);
    expect(state.threads[0]!.terminal!.boundary.notificationUpdatedAt).toBe(at(12));
    state = restoreDesktop(JSON.parse(JSON.stringify(state)), at(14));
    expect(getRows(state, 'filtered')).toHaveLength(1);
    const open = source('open', 15, 12);
    open.events.push({ ...open.events[0]!, id: 'newly-loaded-old-history', at: at(11) });
    state = refresh(state, open, 15);
    expect(getRows(state, 'filtered')).toHaveLength(1);
    expect(placement(state, state.threads[0]!).reason).toContain('No new activity');
    const fresh = source('open', 17, 12);
    fresh.events.push({ ...fresh.events[0]!, id: 'reopened-or-dequeued', at: at(16) });
    state = refresh(state, fresh, 17);
    expect(getRows(state, 'inbox:work')).toHaveLength(1);
    expect(state.notes).toEqual(original.notes);
    expect(state.tasks).toEqual(original.tasks);
    expect(state.selectedKey).toBe(original.selectedKey);
    expect(state.operations).toEqual([]);
    expect(state.handled).toEqual([]);
    expect(getRow(state, 't:123')!.events.map(event => event.id)).toContain('terminal-comment');
  });
}

test('notification advancement alone after queue exit resumes routing and stays monotonic with stale listings', () => {
  let state = refresh(workspace(), source('queued', 11), 11);
  state = refresh(state, source('open', 13, 12), 13);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  state = refresh(state, source('queued', 15, 8), 15);
  expect(state.threads[0]!.notificationUpdatedAt).toBe(at(12));
  expect(getRows(state, 'filtered')).toHaveLength(1);
  expect(state.threads[0]!.sourceState?.state).toBe('queued');
  state = refresh(state, source('open', 16, 8), 16);
  expect(state.threads[0]!.sourceState?.state).toBe('open');
  expect(getRows(state, 'filtered')).toHaveLength(1);
});

test('unknown, denied and omitted state fail open but keep checkpoint provenance through relaunch', () => {
  const queued = refresh(workspace(), source('queued', 11), 11);
  for (const missing of [false, true]) {
    let state = missing ? mergeRefresh(queued, { threads: [], status: 'partial', diagnostics: ['Limited batch'],
      startedAt: at(12), fetchedAt: at(12) }) : refresh(queued, source('unknown', 12), 12);
    expect(getRows(state, 'inbox')).toHaveLength(1);
    expect(state.threads[0]!.sourceState?.error).not.toBeNull();
    expect(state.threads[0]!.terminal).toEqual(queued.threads[0]!.terminal);
    state = restoreDesktop(state, at(13));
    expect(getRows(state, 'inbox')).toHaveLength(1);
    const old = source('open', 14);
    old.events.push({ ...old.events[0]!, id: 'hydrated-while-unknown', at: at(10) });
    state = refresh(state, old, 14);
    expect(getRows(state, 'filtered')).toHaveLength(1);
    const fresh = source('unknown', 16, 15);
    state = refresh(state, fresh, 16);
    expect(getRows(state, 'inbox')).toHaveLength(1);
    state = refresh(state, source('open', 17, 15), 17);
    expect(state.threads[0]!.terminal).toBeNull();
    expect(getRows(state, 'inbox')).toHaveLength(1);
  }
});

test.each([false, true])('retained post-terminal evidence survives unknown recovery and relaunch (named inbox: %s)', named => {
  let state = workspace();
  if (named) state = transition(state, { type: 'save-rule', rule: route });
  state = refresh(state, source('queued', 11), 11);
  const original = structuredClone(state);
  const comment = { ...source().events[0]!, id: 'post-exit-comment', at: at(12) };
  const unknown = source('unknown', 13);
  unknown.events.push(comment);
  state = refresh(state, unknown, 13);
  expect(state.threads[0]!.terminal).toEqual(original.threads[0]!.terminal);
  expect(state.threads[0]!.sourceState?.state).toBe('unknown');
  expect(getRows(state, named ? 'inbox:work' : 'inbox')).toHaveLength(1);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at(14));
  expect(state.threads[0]!.events).toContainEqual(comment);
  const open = source('open', 15);
  open.events.push(comment);
  state = refresh(state, open, 15);
  expect(state.threads[0]!.sourceState?.state).toBe('open');
  expect(state.threads[0]!.notificationUpdatedAt).toBe(at(9));
  expect(state.threads[0]!.terminal).toBeNull();
  expect(getRows(state, named ? 'inbox:work' : 'inbox')).toHaveLength(1);
  expect(state.notes).toEqual(original.notes);
  expect(state.tasks).toEqual(original.tasks);
  expect(state.selectedKey).toBe(original.selectedKey);
  expect(state.threads[0]!.archive).toEqual(original.threads[0]!.archive);
  expect(state.operations).toEqual([]);
  expect(state.handled).toEqual([]);
});

test('terminal cutoff rejects delayed listing catch-up without changing manual Archive activity semantics', () => {
  const queued = source('queued', 11);
  queued.events.push({ ...queued.events[0]!, id: 'terminal-comment', at: at(10) });
  let state = refresh(workspace(), queued, 11);
  const checkpoint = structuredClone(state.threads[0]!.terminal);
  expect(checkpoint?.boundary).toEqual({ at: at(11), evidenceAt: at(10), notificationUpdatedAt: at(9) });
  const archived = transition(transition(state, { type: 'clock', now: at(11) }), { type: 'archive', threadId: '123' });
  const original = structuredClone(archived);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at(12));
  const open = source('open', 13, 10);
  open.events = queued.events;
  state = refresh(state, open, 13);
  expect(state.threads[0]!.sourceState?.state).toBe('open');
  expect(state.threads[0]!.terminal).toEqual(checkpoint);
  expect(getRows(state, 'filtered')).toHaveLength(1);
  const archiveCatchup = refresh(archived, open, 13);
  expect(archiveCatchup.threads[0]!.archive).toBeNull();
  expect(archiveCatchup.threads[0]!.terminal).toEqual(checkpoint);
  expect(archiveCatchup.notes).toEqual(original.notes);
  expect(archiveCatchup.tasks).toEqual(original.tasks);
  expect(archiveCatchup.operations).toEqual([]);
  open.events.push({ ...open.events[0]!, id: 'late-hydration', at: at(11) });
  state = refresh(state, open, 13);
  expect(state.threads[0]!.terminal).toEqual(checkpoint);
  state = refresh(state, source('open', 14, 12), 14);
  expect(state.threads[0]!.terminal).toBeNull();
  expect(getRows(state, 'inbox')).toHaveLength(1);
});

test('retained old history and bookkeeping learned while unknown do not clear a terminal checkpoint', () => {
  let state = refresh(workspace(), source('queued', 11), 11);
  const checkpoint = structuredClone(state.threads[0]!.terminal);
  const unknown = source('unknown', 13);
  unknown.events.push(
    { ...unknown.events[0]!, id: 'old-history', at: at(10) },
    { ...unknown.events[0]!, id: 'read', kind: 'read', at: at(12) },
    { ...unknown.events[0]!, id: 'done', kind: 'acknowledged', at: at(12) },
    { ...unknown.events[0]!, id: 'notification-metadata', rawKind: 'notification-update', at: at(12) },
  );
  state = refresh(state, unknown, 13);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at(14));
  state = refresh(state, source('open', 15), 15);
  expect(state.threads[0]!.events).toHaveLength(unknown.events.length);
  expect(state.threads[0]!.events).toEqual(expect.arrayContaining(unknown.events));
  expect(state.threads[0]!.terminal).toEqual(checkpoint);
  expect(getRows(state, 'filtered')).toHaveLength(1);
});

test('old state responses cannot suppress a newer open source; newer activity than a state check fails open', () => {
  let state = refresh(workspace(), source('open', 14, 13), 14);
  state = refresh(state, source('queued', 11), 11);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  expect(state.threads[0]!.sourceState?.state).toBe('open');
  const stale = source('queued', 15, 13);
  stale.sourceState!.updatedAt = at(10);
  state = refresh(state, stale, 15);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  const race = source('queued', 16, 17);
  state = refresh(state, race, 18);
  expect(getRows(state, 'inbox')).toHaveLength(1);
  expect(state.threads[0]!.sourceState?.error?.code).toBe('source_changed');
});
