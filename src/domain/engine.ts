import { inboxSchema, ruleSchema, type Activity, type AppState, type Command, type Row, type Scenario, type Thread, type View } from '../types.ts';
import { addMinutes, initialClock, instant } from './clock.ts';
import { archiveBoundary } from './archive.ts';
import { LIMITS } from '../../service/src/schema.ts';
import { placement, validateFilters } from './filtering.ts';
import { reconcileTerminal } from './terminal.ts';

const PRIMARY = 'demo-relay-101';
const TEAM = 'demo-provider-202';
const MENTION = 'demo-docs-303';
const PREVIOUS = 'demo-relay-99';
const CLOSED = 'demo-relay-88';
const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const isRequest = (event: Activity): boolean => ['review-request', 'team-request'].includes(event.kind)
  && (event.requestState === undefined || event.requestState === 'current')
  && (event.requestState === undefined || event.kind !== 'team-request'
    || (event.recipient?.kind === 'team' && event.recipient.viewerIsMember === true));

function id(state: AppState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

function addTask(state: AppState, title: string, notes = '') {
  if (!title.trim()) throw new Error('Write something to capture first.');
  const task = { id: id(state, 'local'), title, notes, status: 'open' as const, createdAt: state.clock };
  state.tasks.push(task);
  return task;
}

export function pendingEvidence(state: AppState, thread: Thread): Activity[] {
  if (thread.notification === 'done') return [];
  return thread.events.filter(event => event.kind !== 'read' && event.kind !== 'acknowledged' && !state.handled.includes(event.id)
    && (state.runtime !== 'desktop' || thread.subscription !== 'unsubscribed' || isRequest(event) || event.kind === 'mention'));
}

function threadRow(state: AppState, thread: Thread): Row {
  const events = pendingEvidence(state, thread);
  const latest = thread.events.at(-1);
  const location = placement(state, thread);
  const available = location.view !== 'archive' && location.view !== 'filtered';
  return {
    key: `t:${thread.id}`, title: thread.title, kind: thread.kind === 'pr' ? 'review' : 'update',
    reason: available ? latest?.summary ?? 'No source activity saved yet.' : location.reason, thread, events,
    fresh: available && state.newKeys.includes(`t:${thread.id}`), available,
  };
}

export function getRow(state: AppState, key: string): Row | undefined {
  if (key.startsWith('t:')) {
    const thread = state.threads.find(item => item.id === key.slice(2));
    return thread ? threadRow(state, thread) : undefined;
  }
  if (key.startsWith('a:')) {
    const task = state.tasks.find(item => item.id === key.slice(2));
    if (task) return { key, title: task.title, reason: task.notes || (task.status === 'done' ? 'Done' : 'Saved task'),
      kind: 'task', task, events: [], fresh: false, available: task.status === 'open' };
  }
  return undefined;
}

export function getRows(state: AppState, view: View = state.view): Row[] {
  const rows = view === 'tasks' ? state.tasks.map(task => getRow(state, `a:${task.id}`)!)
    : state.threads.filter(thread => placement(state, thread).view === view).map(thread => threadRow(state, thread));
  const positions = new Map(state.order.map((key, index) => [key, index]));
  return rows.sort((a, b) => (positions.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

function appendOrder(state: AppState): void {
  const keys = [...state.threads.map(thread => `t:${thread.id}`), ...state.tasks.map(task => `a:${task.id}`)];
  const added = keys.filter(key => !state.order.includes(key));
  state.order.push(...added);
  state.newKeys = unique([...state.newKeys, ...added.filter(key => key.startsWith('t:'))]);
}

export function initialState(timeZone = 'UTC'): AppState {
  const clock = initialClock(timeZone);
  const event = (threadId: string, suffix: string, kind: Activity['kind'], summary: string, minutes = -40): Activity => ({
    id: `${threadId}:${suffix}`, threadId, kind, at: addMinutes(clock, minutes), actor: 'demo-teammate', summary,
  });
  const threads: Thread[] = [
    {
      id: PRIMARY, repo: 'sample/relay', number: 101, kind: 'pr',
      title: 'Retry webhook deliveries on transient failures', reason: 'review_requested',
      state: 'open', notification: 'unread', subscribed: true, lines: 34,
      events: [event(PRIMARY, 'request-1', 'review-request', 'Demo teammate directly requested your review. 34 changed lines.')],
    },
    {
      id: TEAM, repo: 'sample/terraform-provider', number: 202, kind: 'pr',
      title: 'Support import of integration settings', reason: 'review_requested',
      state: 'open', notification: 'unread', subscribed: true, lines: 180,
      events: [{ ...event(TEAM, 'request-1', 'team-request', 'Review requested from integrations/terraform-provider-core-maintainers.'),
        recipient: { kind: 'team', name: 'integrations/terraform-provider-core-maintainers', viewerIsMember: true } }],
    },
    {
      id: MENTION, repo: 'sample/docs', number: 303, kind: 'issue',
      title: 'Clarify webhook retry guidance', reason: 'mention', state: 'open', notification: 'read', subscribed: true,
      events: [event(MENTION, 'mention-1', 'mention', 'Demo teammate mentioned you in a documentation discussion.')],
    },
    {
      id: PREVIOUS, repo: 'sample/relay', number: 99, kind: 'pr', title: 'Record delivery attempt diagnostics',
      reason: 'review_requested', state: 'queued', notification: 'unread', subscribed: true, lines: 22,
      events: [event(PREVIOUS, 'queue-1', 'merge-queue', 'The PR entered the merge queue after your completed review.', -10)],
    },
    {
      id: CLOSED, repo: 'sample/relay', number: 88, kind: 'issue', title: 'Follow up on delivery incident notes',
      reason: 'subscribed', state: 'closed', notification: 'done', subscribed: false,
      events: [event(CLOSED, 'closed-1', 'merged', 'The demo issue is closed; your notes remain.', -1440)],
    },
  ];
  return {
    version: 3, runtime: 'demo', clock, timeZone,
    threads: threads.map(thread => {
      thread.archive = thread.id === CLOSED ? archiveBoundary(thread, clock) : null;
      thread.sourceState = { state: thread.state, observedAt: clock, updatedAt: null, error: null };
      reconcileTerminal(undefined, thread);
      return thread;
    }),
    inboxes: [], rules: [],
    tasks: [{ id: 'demo-local-task', title: 'Write a short rollout checklist', notes: 'Synthetic local task. No GitHub reference required.',
      status: 'open', createdAt: clock }],
    notes: [{ id: 'demo-review-note', threadId: PREVIOUS, text: 'Review finished. No need to wait for merge.' },
      { id: 'demo-followup-note', threadId: CLOSED, text: 'Keep the operational follow-up for reference.' }],
    staged: [], handled: [`${CLOSED}:closed-1`], seen: [], order: threads.map(thread => `t:${thread.id}`),
    newKeys: [], selectedKey: `t:${PRIMARY}`, view: 'inbox', draft: '',
    refresh: { lastSuccessAt: null, status: 'saved', message: 'Saved synthetic fixtures. Refresh applies staged demo activity only.' },
    failures: { refresh: 'none', storage: false, external: false }, undo: [], sequence: 100, operations: [],
  };
}

function stage(state: AppState, scenario: Scenario): void {
  if (scenario === 'empty') {
    for (const thread of state.threads) state.staged.push({
      id: id(state, 'empty'), threadId: thread.id, kind: 'acknowledged', at: state.clock,
      actor: 'demo-github', summary: 'Synthetic empty snapshot: no outstanding source notification.',
    });
    return;
  }
  let thread = (state.selectedKey ? getRow(state, state.selectedKey)?.thread : undefined) ?? state.threads.find(thread => thread.id === PRIMARY)!;
  if ((scenario === 're-request' || scenario === 'merge-queue') && thread.kind !== 'pr') thread = state.threads.find(entry => entry.id === PRIMARY)!;
  if (scenario === 'new-review') {
    const threadId = id(state, 'demo-new-review');
    thread = { id: threadId, repo: 'sample/relay', number: state.sequence + 300, kind: 'pr',
      title: 'Add delivery timeout diagnostics', reason: 'review_requested', state: 'open', notification: 'done', subscribed: true, events: [],
      archive: { at: state.clock } };
    state.threads.push(thread);
  }
  const kinds: Record<Exclude<Scenario, 'empty'>, Activity['kind']> = {
    'new-review': 'review-request', comment: 'comment', 'merge-queue': 'merge-queue', 're-request': 'review-request',
    'sticky-mention': 'comment', closed: 'merged', read: 'read', acknowledged: 'acknowledged', mention: 'mention',
  };
  const summaries: Record<Exclude<Scenario, 'empty'>, string> = {
    'new-review': 'Demo teammate requested a review on this new synthetic PR.',
    comment: 'Demo teammate added an ordinary progress comment.',
    'merge-queue': 'This synthetic PR entered the merge queue.',
    're-request': 'Demo teammate explicitly requested a fresh review.',
    'sticky-mention': 'An ordinary update arrived with an old mention reason.',
    closed: 'The synthetic source was closed. Saved notes and tasks are unchanged.',
    read: 'The synthetic notification was read on GitHub.',
    acknowledged: 'The synthetic notification was marked done on GitHub.',
    mention: 'Demo teammate mentioned you again.',
  };
  state.staged.push({ id: id(state, scenario), threadId: thread.id, kind: kinds[scenario], at: state.clock, actor: 'demo-teammate', summary: summaries[scenario] });
}

function applyEvent(state: AppState, event: Activity): void {
  const thread = state.threads.find(entry => entry.id === event.threadId);
  if (!thread) throw new Error(`Staged activity refers to an unknown thread: ${event.threadId}`);
  if (thread.events.some(entry => entry.id === event.id)) return;
  const previous = structuredClone(thread);
  thread.events.push(structuredClone(event));
  if (event.kind === 'read') { thread.notification = 'read'; return; }
  if (event.kind === 'acknowledged') {
    thread.notification = 'done';
    state.handled = unique([...state.handled, ...thread.events.map(entry => entry.id)]);
    return;
  }
  // Staged demo events are explicitly new; unlike a fetched page, their identity is authoritative.
  if (thread.archive) {
    thread.archive = null;
    state.newKeys = unique([...state.newKeys, `t:${thread.id}`]);
  }
  if (event.kind === 'merge-queue') thread.state = 'queued';
  if (event.kind === 'merged') thread.state = 'closed';
  thread.sourceState = { state: thread.state, observedAt: state.clock, updatedAt: null, error: null };
  reconcileTerminal(previous, thread);
  if (event.id.startsWith('sticky-mention-')) thread.reason = 'mention';
  if (isRequest(event) || event.kind === 'mention') {
    thread.subscribed = true;
    thread.reason = isRequest(event) ? 'review_requested' : 'mention';
    thread.notification = 'unread';
  } else if (thread.subscribed) thread.notification = 'unread';
  else state.handled = unique([...state.handled, event.id]);
}

function refresh(state: AppState): void {
  if (state.failures.refresh === 'error') {
    state.refresh.status = 'error';
    state.refresh.message = 'Simulated offline refresh failed. Last good data is unchanged; staged events remain available to retry.';
    return;
  }
  const count = state.failures.refresh === 'partial' ? Math.floor(state.staged.length / 2) : state.staged.length;
  for (const event of state.staged.splice(0, count)) applyEvent(state, event);
  if (state.failures.refresh === 'partial') {
    state.refresh.status = 'partial';
    state.refresh.message = `Partial synthetic refresh: applied ${count} events; ${state.staged.length} remain staged. Last full success is unchanged.`;
  } else {
    state.refresh = { status: 'ok', lastSuccessAt: state.clock,
      message: `Synthetic refresh complete. Applied ${count} staged events; no network request was made.` };
  }
}

export function transition(state: AppState, command: Command): AppState {
  if (state.runtime === 'desktop' && ['stage', 'reset', 'advance', 'configure', 'notification', 'refresh'].includes(command.type)) {
    throw new Error('Simulation commands are not available in a desktop workspace.');
  }
  const next = structuredClone(state);
  switch (command.type) {
    case 'select':
      if (command.key !== null) {
        if (!getRow(next, command.key)) throw new Error('This item no longer exists.');
        next.seen = unique([...next.seen, command.key]);
      }
      next.selectedKey = command.key;
      break;
    case 'view':
      validateFilters({ ...next, view: command.view });
      next.view = command.view; next.selectedKey = null; break;
    case 'save-inbox': {
      const inbox = inboxSchema.parse(command.inbox);
      const index = next.inboxes.findIndex(value => value.id === inbox.id);
      if (index < 0) next.inboxes.push(inbox); else next.inboxes[index] = inbox;
      validateFilters(next);
      break;
    }
    case 'delete-inbox': {
      if (!next.inboxes.some(inbox => inbox.id === command.id)) throw new Error('This inbox no longer exists.');
      if (next.rules.some(rule => rule.action.type === 'inbox' && rule.action.inboxId === command.id)) {
        throw new Error('Edit or delete rules targeting this inbox before deleting it, including disabled rules.');
      }
      next.inboxes = next.inboxes.filter(inbox => inbox.id !== command.id);
      if (next.view === `inbox:${command.id}`) next.view = 'inbox';
      break;
    }
    case 'save-rule': {
      const rule = ruleSchema.parse(command.rule);
      const index = next.rules.findIndex(value => value.id === rule.id);
      if (index < 0) next.rules.push(rule); else next.rules[index] = rule;
      validateFilters(next);
      break;
    }
    case 'enable-rule':
    case 'move-rule':
    case 'delete-rule': {
      const index = next.rules.findIndex(rule => rule.id === command.id);
      if (index < 0) throw new Error('This rule no longer exists.');
      if (command.type === 'enable-rule') next.rules[index]!.enabled = command.enabled;
      else if (command.type === 'delete-rule') next.rules.splice(index, 1);
      else {
        const target = index + (command.direction === 'up' ? -1 : 1);
        if (target < 0 || target >= next.rules.length) throw new Error('This rule is already at the end of the list.');
        [next.rules[index], next.rules[target]] = [next.rules[target]!, next.rules[index]!];
      }
      break;
    }
    case 'draft': next.draft = command.text; break;
    case 'capture': {
      const task = addTask(next, next.draft);
      next.draft = '';
      next.view = 'tasks';
      next.selectedKey = `a:${task.id}`;
      break;
    }
    case 'capture-tasks': {
      if (!command.tasks.length || command.tasks.length > 300) throw new Error('Select between 1 and 300 items to add to Tasks.');
      for (const task of command.tasks) addTask(next, task.title, task.notes);
      break;
    }
    case 'note': {
      if (!next.threads.some(thread => thread.id === command.threadId)) throw new Error('This thread no longer exists.');
      const existing = command.noteId ? next.notes.find(note => note.id === command.noteId && note.threadId === command.threadId) : undefined;
      if (command.noteId && !existing) throw new Error('This note no longer exists on this thread.');
      if (existing) existing.text = command.text;
      else next.notes.push({ id: id(next, 'note'), threadId: command.threadId, text: command.text });
      break;
    }
    case 'archive':
    case 'restore-thread': {
      const thread = next.threads.find(thread => thread.id === command.threadId);
      if (!thread) throw new Error('This thread no longer exists.');
      thread.archive = command.type === 'archive' ? archiveBoundary(thread, next.clock) : null;
      if (command.type === 'restore-thread' && thread.sourceState?.state === 'open') thread.terminal = null;
      if (command.type === 'archive' && next.runtime !== 'desktop') {
        const eventIds = pendingEvidence(next, thread).slice(-LIMITS.events).map(event => event.id);
        const failed = next.failures.external;
        next.operations.push({
          id: id(next, 'demo-archive'), threadId: thread.id, action: 'done', eventIds, startedAt: next.clock,
          status: failed ? 'failed' : 'confirmed',
          message: failed ? 'Simulated GitHub acknowledgement failed. Archive and notes remain here; retry explicitly.' : 'Simulated GitHub Done confirmed.',
        });
        if (!failed) {
          next.handled = unique([...next.handled, ...eventIds]);
          if (!pendingEvidence(next, thread).length) thread.notification = 'done';
        }
      }
      break;
    }
    case 'edit':
    case 'done':
    case 'restore': {
      const task = getRow(next, command.key)?.task;
      if (!task) throw new Error('Select a task before changing it. Thread selection does not create tasks.');
      const before = structuredClone(task);
      if (command.type === 'edit') {
        if (command.title !== undefined) {
          if (!command.title.trim()) throw new Error('Task text cannot be empty.');
          task.title = command.title;
        }
        if (command.notes !== undefined) task.notes = command.notes;
      } else {
        task.status = command.type === 'done' ? 'done' : 'open';
        if (command.type === 'done') task.completedAt = next.clock;
        else delete task.completedAt;
        next.undo.push({ before, after: structuredClone(task) });
      }
      break;
    }
    case 'undo': {
      const entry = next.undo.pop();
      if (!entry) throw new Error('There is no task change to undo.');
      const task = next.tasks.find(task => task.id === entry.after.id);
      if (!task) throw new Error('The changed task no longer exists.');
      if (task.status === entry.after.status && task.completedAt === entry.after.completedAt) {
        task.status = entry.before.status;
        task.completedAt = entry.before.completedAt;
      }
      break;
    }
    case 'notification': {
      const thread = next.threads.find(entry => entry.id === command.threadId);
      if (!thread) throw new Error('This GitHub thread no longer exists.');
      const retry = command.retryId ? next.operations.find(operation => operation.id === command.retryId) : undefined;
      if (command.retryId && (!retry || retry.threadId !== thread.id || retry.action !== command.action || !['failed', 'uncertain'].includes(retry.status))) {
        throw new Error('This operation cannot be retried with a different context.');
      }
      if (next.failures.external) throw new Error('Simulated GitHub write failed. Notification, subscription, notes and tasks are unchanged.');
      if (command.action === 'read') thread.notification = 'read';
      else {
        next.handled = unique([...next.handled, ...(retry?.eventIds ?? pendingEvidence(next, thread).slice(-LIMITS.events).map(event => event.id))]);
        if (command.action === 'done') {
          if (!pendingEvidence(next, thread).length) thread.notification = 'done';
        } else thread.subscribed = false;
        if (retry) { retry.status = 'confirmed'; retry.message = 'Simulated GitHub Done confirmed.'; }
      }
      break;
    }
    case 'stage': stage(next, command.scenario); break;
    case 'refresh': refresh(next); break;
    case 'clock': next.clock = instant(command.now); break;
    case 'advance': next.clock = addMinutes(next.clock, command.minutes); break;
    case 'configure':
      if (command.refreshFailure !== undefined) next.failures.refresh = command.refreshFailure;
      if (command.storageFailure !== undefined) next.failures.storage = command.storageFailure;
      if (command.externalFailure !== undefined) next.failures.external = command.externalFailure;
      break;
    case 'reset': {
      // Reset synthetic source activity only. Every local note, task and history remains.
      const fixtures = initialState(next.timeZone);
      next.threads = [...fixtures.threads.map(thread => {
        const previous = next.threads.find(previous => previous.id === thread.id);
        return { ...thread, archive: previous ? previous.archive : thread.archive };
      }), ...next.threads.filter(thread => !fixtures.threads.some(fixture => fixture.id === thread.id))];
      next.staged = [];
      next.handled = fixtures.handled;
      next.refresh = fixtures.refresh;
      break;
    }
  }
  appendOrder(next);
  return next;
}
