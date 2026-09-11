import type { Activity, AppState, Command, Row, Scenario, Thread, View, WorkAction } from '../types.ts';
import { addMinutes, compare, followingDay, initialClock, instant, nextDaily } from './clock.ts';

const PRIMARY = 'demo-relay-101';
const TEAM = 'demo-provider-202';
const MENTION = 'demo-docs-303';
const PREVIOUS = 'demo-relay-99';
const CLOSED = 'demo-relay-88';
const REQUESTS: Activity['kind'][] = ['review-request', 'team-request'];
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const isRequest = (event: Activity): boolean => REQUESTS.includes(event.kind)
  && (event.requestState === undefined || event.requestState === 'current')
  && (event.requestState === undefined || event.kind !== 'team-request'
    || (event.recipient?.kind === 'team' && event.recipient.viewerIsMember === true));
const visibleEvent = (event: Activity): boolean => event.kind !== 'read' && event.kind !== 'acknowledged';
const unique = <T>(values: T[]): T[] => [...new Set(values)];

function id(state: AppState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

function action(state: AppState, title: string, origin: WorkAction['origin'] = state.runtime === 'desktop' ? 'github' : 'fixture'): WorkAction {
  return {
    id: id(state, 'local'), title, eventIds: [], status: 'available', notes: '', project: '',
    nextStep: '', captures: [], steps: [], origin, createdAt: state.clock, interpretation: 'none',
  };
}

function pending(state: AppState, thread: Thread): Activity[] {
  if (thread.notification === 'done') return [];
  return thread.events.filter(event => visibleEvent(event) && !state.handled.includes(event.id)
    && (state.runtime !== 'desktop' || thread.subscription !== 'unsubscribed' || isRequest(event) || event.kind === 'mention'));
}

function actionEvents(state: AppState, item: WorkAction): Activity[] {
  return state.threads.find(thread => thread.id === item.threadId)?.events
    .filter(event => item.eventIds.includes(event.id)) ?? [];
}

function reviewAction(state: AppState, item: WorkAction): boolean {
  return actionEvents(state, item).some(event => REQUESTS.includes(event.kind))
    || (item.interpretation === 'supported' && !item.routine && !!item.threadId);
}

function reason(events: Activity[], kind: Row['kind']): string {
  if (kind === 'review') {
    if (events.some(event => event.kind === 'review-request')) return 'Direct review request · explicit request evidence';
    const team = events.find(event => event.kind === 'team-request');
    if (team) {
      return `Team review request · ${team.recipient?.name ?? 'team context unavailable'}`;
    }
    return 'Captured review · your saved intent';
  }
  const last = events.at(-1);
  if (events.some(event => event.requestState === 'uncertain')) return 'Incomplete request evidence · inspect before deciding';
  if (last?.requestState === 'historical') return 'Earlier request · no current obligation confirmed';
  if (last?.kind === 'mention') return 'New mention · inspect the message; no review request inferred';
  if (last?.kind === 'merge-queue') return 'Entered the merge queue · informational update';
  if (last?.kind === 'merged') return 'Source closed · informational update';
  return 'Conversation update · no new obligation inferred';
}

function threadRow(state: AppState, thread: Thread, fallback = false): Row | undefined {
  const events = pending(state, thread);
  const retained = state.actions.filter(item => item.threadId === thread.id);
  const local = retained.find(item => item.status === 'available' && !item.routine);
  if (!events.length && !local && !fallback) return undefined;
  const historical = fallback && !events.length && !local ? retained.at(-1) : undefined;
  const item = local ?? historical;
  const evidence = unique([...events, ...(item ? actionEvents(state, item) : [])].map(event => event.id))
    .map(eventId => thread.events.find(event => event.id === eventId)!)
    .filter(Boolean);
  // Request identity comes from unhandled request events, never the thread's sticky reason or state.
  const freshRequest = events.some(isRequest) && !retained.some(entry => entry.status === 'later');
  const kind: Row['kind'] = (item && reviewAction(state, item)) || freshRequest ? 'review' : 'update';
  return {
    key: `t:${thread.id}`, title: item?.title ?? thread.title, reason: reason(freshRequest ? events.filter(isRequest) : evidence, kind), kind,
    thread, action: item, events: evidence, fresh: state.newKeys.includes(`t:${thread.id}`),
    available: !!local || events.length > 0,
  };
}

function localRow(state: AppState, item: WorkAction): Row {
  const thread = state.threads.find(entry => entry.id === item.threadId);
  const events = actionEvents(state, item);
  const kind: Row['kind'] = item.routine ? 'routine' : reviewAction(state, item) ? 'review'
    : thread ? 'update' : 'task';
  let why = thread ? reason(events, kind) : 'Saved local task';
  if (item.routine) {
    why = `Daily at ${item.routine.time} · ${item.routine.timeZone}`;
    if (item.routine.dueAt) {
      why = `Due since ${item.routine.dueAt} · ${why}`;
      if (item.steps.some(step => step.doneAt)
        && compare(followingDay(item.routine.dueAt, item.routine.time, item.routine.timeZone), state.clock) <= 0) {
        why += ' · Stale progress: earlier step timestamps are retained';
      }
    }
  } else if (item.status === 'later') {
    why = item.remindAt && compare(item.remindAt, state.clock) <= 0 ? 'Local reminder due · still in Later' : 'Retained in Later';
  }
  return {
    key: `a:${item.id}`, title: item.title, reason: why, kind, thread, action: item, events,
    fresh: state.newKeys.includes(`a:${item.id}`), available: item.status === 'available' || item.status === 'later',
  };
}

export function getRow(state: AppState, key: string): Row | undefined {
  if (key.startsWith('t:')) {
    const thread = state.threads.find(item => item.id === key.slice(2));
    return thread ? threadRow(state, thread, true) : undefined;
  }
  if (key.startsWith('a:')) {
    const item = state.actions.find(entry => entry.id === key.slice(2));
    return item ? localRow(state, item) : undefined;
  }
  return undefined;
}

function dueReminder(state: AppState, item: WorkAction): boolean {
  if (item.status === 'done' || item.status === 'removed' || item.reminderDismissed) return false;
  if (item.routine) {
    return !!item.routine.dueAt && compare(item.routine.dueAt, state.clock) <= 0
      && (!item.routine.snoozedUntil || compare(item.routine.snoozedUntil, state.clock) <= 0);
  }
  return item.status === 'later' && !!item.remindAt && compare(item.remindAt, state.clock) <= 0;
}

export function reminders(state: AppState): WorkAction[] {
  return state.actions.filter(item => item.id !== state.activeId && dueReminder(state, item));
}

function unsortedRows(state: AppState, view: View): Row[] {
  if (view === 'attention') {
    return [
      ...state.threads.map(thread => threadRow(state, thread)).filter((row): row is Row => !!row),
      ...state.actions.filter(item => {
        if (item.status === 'done' || item.status === 'removed') return false;
        if (item.routine) return dueReminder(state, item) || item.id === state.activeId;
        if (item.status === 'later') return dueReminder(state, item);
        return !item.threadId;
      }).map(item => localRow(state, item)),
    ];
  }
  return state.actions.filter(item => {
    if (view === 'later') return item.status === 'later';
    if (view === 'history') return item.status === 'done' || item.status === 'removed';
    if (view === 'routines') return !!item.routine && item.status !== 'removed';
    return !!item.project.trim() && item.status !== 'removed';
  }).map(item => localRow(state, item));
}

export function getRows(state: AppState, view: View = state.view): Row[] {
  const positions = new Map(state.order.map((key, index) => [key, index]));
  return unsortedRows(state, view).sort((a, b) =>
    (positions.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

export function priorityRank(row: Row): number {
  if (row.kind === 'routine' || row.reason.startsWith('Local reminder due')) return 0;
  if (row.kind === 'review' && row.events.some(event => event.kind === 'review-request')) {
    return row.thread?.lines !== undefined && row.thread.lines <= 100 ? 1 : 2;
  }
  if (row.kind === 'review' && row.events.some(event => event.kind === 'team-request')) return 3;
  if (row.action || row.kind === 'review' || row.kind === 'task') return 4;
  return 5;
}

function appendOrder(state: AppState): void {
  const keys = unsortedRows(state, 'attention').map(row => row.key);
  const added = keys.filter(key => !state.order.includes(key));
  state.order.push(...added);
  state.newKeys = unique([...state.newKeys, ...added]);
}

function settleRoutines(state: AppState): void {
  for (const item of state.actions) {
    const routine = item.routine;
    if (!routine || item.status === 'done' || item.status === 'removed') continue;
    while (compare(routine.nextDueAt, state.clock) <= 0) {
      if (!routine.dueAt) {
        routine.dueAt = routine.nextDueAt;
        item.reminderDismissed = false;
        delete routine.snoozedUntil;
      } else {
        routine.history.push({
          dueAt: routine.nextDueAt, status: 'missed',
          steps: item.steps.map(step => ({ id: step.id, title: step.title })),
        });
      }
      routine.nextDueAt = followingDay(routine.nextDueAt, routine.time, routine.timeZone);
    }
  }
}

export function initialState(timeZone = 'UTC'): AppState {
  const clock = initialClock(timeZone);
  const state: AppState = {
    version: 2, clock, timeZone, threads: [], actions: [], staged: [], handled: [], seen: [], order: [],
    newKeys: [], selectedKey: `t:${PRIMARY}`, activeId: null, view: 'attention', draft: '',
    refresh: { lastSuccessAt: null, status: 'saved', message: 'Saved synthetic fixtures. Refresh applies staged demo activity only.' },
    failures: { refresh: 'none', storage: false, interpretation: false, external: false }, undo: [], sequence: 100, operations: [],
  };
  const event = (threadId: string, suffix: string, kind: Activity['kind'], summary: string, minutes = -40): Activity => ({
    id: `${threadId}:${suffix}`, threadId, kind, at: addMinutes(clock, minutes), actor: 'demo-teammate', summary,
  });
  state.threads = [
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
      events: [{ ...event(TEAM, 'request-1', 'team-request', 'Review requested from integrations/terraform-provider-core-maintainers, not assigned personally.'),
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
      events: [
        event(PREVIOUS, 'request-1', 'review-request', 'Earlier direct review request.', -1500),
        event(PREVIOUS, 'queue-1', 'merge-queue', 'The PR entered the merge queue after your completed review.', -10),
      ],
    },
    {
      id: CLOSED, repo: 'sample/relay', number: 88, kind: 'issue', title: 'Follow up on delivery incident notes',
      reason: 'subscribed', state: 'closed', notification: 'done', subscribed: false,
      events: [event(CLOSED, 'closed-1', 'merged', 'The demo issue is closed; your local follow-up remains.', -1440)],
    },
  ];
  state.actions = [
    {
      ...action(state, 'Review delivery attempt diagnostics'), id: 'demo-completed-review', threadId: PREVIOUS,
      eventIds: [`${PREVIOUS}:request-1`], status: 'done', completedAt: addMinutes(clock, -1450),
      notes: 'Review finished. No need to wait for merge.',
    },
    {
      ...action(state, 'Write a short rollout checklist'), id: 'demo-local-task',
      notes: 'Synthetic local capture. No GitHub reference required.', project: 'Delivery reliability',
    },
    {
      ...action(state, 'Check the incident follow-up'), id: 'demo-later-followup', threadId: CLOSED,
      eventIds: [`${CLOSED}:closed-1`], status: 'later', notes: 'Waiting for a response. Keep the operational follow-up.',
      remindAt: addMinutes(clock, 80), project: 'Delivery reliability',
    },
    {
      ...action(state, 'Announce the change, then increase the feature flag'), id: 'demo-daily-routine',
      interpretation: 'supported', nextStep: 'Announce the change',
      steps: [{ id: 'announce', title: 'Announce the change' }, { id: 'increase', title: 'Increase the feature flag' }],
      routine: { time: '10:00', timeZone, nextDueAt: nextDaily(clock, '10:00', timeZone), history: [] },
    },
  ];
  state.handled = [`${PREVIOUS}:request-1`, `${CLOSED}:closed-1`];
  state.order = unsortedRows(state, 'attention').sort((a, b) => priorityRank(a) - priorityRank(b)).map(row => row.key);
  return state;
}

function requireRow(state: AppState, key: string): Row {
  const row = getRow(state, key);
  if (!row) throw new Error(`This item no longer exists: ${key}`);
  return row;
}

function ensureAction(state: AppState, key: string): WorkAction {
  const row = requireRow(state, key);
  if (row.action && (!key.startsWith('t:') || row.action.status === 'available' || !row.available)) return row.action;
  if (!row.thread) throw new Error('Select an available item first.');
  if (!row.available) throw new Error('There is no unhandled activity on this thread.');
  const item = action(state, row.title);
  item.threadId = row.thread.id;
  item.eventIds = row.events.filter(event => !state.handled.includes(event.id)).map(event => event.id);
  state.actions.push(item);
  return item;
}

function handle(state: AppState, eventIds: string[]): void {
  state.handled = unique([...state.handled, ...eventIds]);
}

function unfinished(item: WorkAction): void {
  if (item.status === 'done' || item.status === 'removed') {
    throw new Error('Restore this action before changing its progress.');
  }
}

function finishOccurrence(state: AppState, item: WorkAction, status: 'done' | 'skipped'): void {
  const routine = item.routine!;
  if (!routine.dueAt) throw new Error('This routine has no outstanding occurrence.');
  if (status === 'done' && (!item.steps.length || item.steps.some(step => !step.doneAt))) {
    throw new Error('Record every routine step in order before completing this occurrence.');
  }
  routine.history.push({ dueAt: routine.dueAt, status, steps: copy(item.steps) });
  delete routine.dueAt;
  delete routine.snoozedUntil;
  item.steps = item.steps.map(step => ({ id: step.id, title: step.title }));
  item.status = 'available';
  item.reminderDismissed = false;
  item.nextStep = item.steps[0]?.title ?? '';
  delete item.completedAt;
  delete item.remindAt;
  if (state.activeId === item.id) state.activeId = null;
}

type Reference = { repo: string; number: number };

export function capturedReference(text: string): Reference | undefined {
  const links = text.match(/(?:https|demo):\/\/[^\s<>"']+/g) ?? [];
  const references: Reference[] = [];
  for (const candidate of links) {
    try {
      const literal = candidate.replace(/[.,;)]+$/, '');
      if (!/^(?:https:\/\/github\.com|demo:\/\/github)\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/pull\/[1-9]\d*\/?$/.test(literal)) continue;
      const url = new URL(literal);
      if (url.username || url.password || url.port || url.search || url.hash) continue;
      const real = url.protocol === 'https:' && url.hostname === 'github.com';
      const demo = url.protocol === 'demo:' && url.hostname === 'github';
      if (!real && !demo) continue;
      const match = /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][A-Za-z0-9_.-]*)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
      if (!match || (demo && match[1] !== 'sample')) continue;
      const number = Number(match[3]);
      if (!Number.isSafeInteger(number)) continue;
      const reference = { repo: `${match[1]}/${match[2]}`, number };
      if (!references.some(entry => entry.repo.toLowerCase() === reference.repo.toLowerCase() && entry.number === number)) {
        references.push(reference);
      }
    } catch {
      // Unsupported references stay verbatim in the capture.
    }
  }
  return references.length === 1 ? references[0] : undefined;
}

function capturedRoutine(text: string): { time: string; steps: string[] } | undefined {
  const match = /^(?:every day|daily) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*,\s*(.+)$/i.exec(text.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59) return undefined;
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  } else if (!match[2] || hour > 23) {
    return undefined;
  }
  const steps = match[4]!.replace(/[.!]$/, '').split(/,\s*then\s+/i).map(value => value.trim());
  if (steps.length < 2 || steps.some(value => !value || /\b(?:every day|daily|tomorrow|sometimes)\b/i.test(value))) return undefined;
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, steps };
}

function interpret(state: AppState, key: string): void {
  const item = ensureAction(state, key);
  if (!item.captures.length) throw new Error('This action has no original capture to interpret.');
  if (state.failures.interpretation) {
    item.interpretation = 'error';
    item.interpretationMessage = 'Simulated interpretation failed. Your original capture and edits are saved; retry is available.';
    return;
  }
  if (item.interpretation === 'supported') return;
  const text = item.captures.at(-1)!;
  const routine = capturedRoutine(text);
  if (routine) {
    item.steps = routine.steps.map((title, index) => ({ id: `${item.id}-step-${index + 1}`, title }));
    item.routine = {
      time: routine.time, timeZone: state.timeZone, nextDueAt: nextDaily(state.clock, routine.time, state.timeZone), history: [],
    };
    item.title = routine.steps.join(', then ');
    item.nextStep ||= routine.steps[0]!;
    item.interpretation = 'supported';
    item.interpretationMessage = `Simulated daily interpretation · ${routine.time} in ${state.timeZone}. Steps are recorded, not executed.`;
    settleRoutines(state);
    return;
  }
  const reference = capturedReference(text);
  if (!reference) {
    item.interpretation = 'unsupported';
    item.interpretationMessage = 'Saved as a task. No unambiguous supported review reference or daily routine was found.';
    return;
  }
  let thread = state.threads.find(entry => entry.repo.toLowerCase() === reference.repo.toLowerCase()
    && entry.number === reference.number && entry.kind === 'pr');
  if (!thread) {
    thread = {
      id: id(state, 'capture-source'), repo: reference.repo, number: reference.number, kind: 'pr',
      title: `Review ${reference.repo} #${reference.number}`, reason: 'subscribed',
      state: 'open', notification: 'done', subscribed: false, events: [],
    };
    state.threads.push(thread);
  }
  const existing = state.actions.find(entry => entry.id !== item.id && entry.threadId === thread.id
    && (entry.status === 'available' || entry.status === 'later') && reviewAction(state, entry));
  if (existing) {
    existing.captures = [...existing.captures, ...item.captures];
    existing.origin = 'capture';
    existing.interpretation = 'supported';
    existing.interpretationMessage = 'Simulated review interpretation merged into the same outstanding review; original captures retained.';
    if (item.notes && item.notes !== existing.notes) existing.notes = [existing.notes, item.notes].filter(Boolean).join('\n\n');
    existing.project ||= item.project;
    existing.nextStep ||= item.nextStep;
    state.actions = state.actions.filter(entry => entry.id !== item.id);
    if (state.activeId === item.id) state.activeId = existing.id;
    if (state.selectedKey === `a:${item.id}`) state.selectedKey = `a:${existing.id}`;
    return;
  }
  item.threadId = thread.id;
  item.eventIds = pending(state, thread).filter(isRequest).map(event => event.id);
  item.title = thread.title;
  item.interpretation = 'supported';
  item.interpretationMessage = 'Simulated linked review interpretation. Original text retained; no network request was made.';
}

function targetThread(state: AppState): Thread {
  return (state.selectedKey ? getRow(state, state.selectedKey)?.thread : undefined)
    ?? state.threads.find(thread => thread.id === PRIMARY)!;
}

function stage(state: AppState, scenario: Scenario): void {
  if (scenario === 'empty') {
    for (const thread of state.threads) {
      state.staged.push({
        id: id(state, 'empty'), threadId: thread.id, kind: 'acknowledged', at: state.clock,
        actor: 'demo-github', summary: 'Synthetic empty snapshot: no outstanding source notification.',
      });
    }
    return;
  }
  let thread = targetThread(state);
  if ((scenario === 're-request' || scenario === 'merge-queue') && thread.kind !== 'pr') {
    thread = state.threads.find(entry => entry.id === PRIMARY)!;
  }
  if (scenario === 'new-review') {
    const threadId = id(state, 'demo-new-review');
    thread = {
      id: threadId, repo: 'sample/relay', number: state.sequence + 300, kind: 'pr',
      title: 'Add delivery timeout diagnostics', reason: 'review_requested', state: 'open',
      notification: 'done', subscribed: true, lines: 48, events: [],
    };
    state.threads.push(thread);
  }
  const kinds: Record<Exclude<Scenario, 'empty'>, Activity['kind']> = {
    'new-review': 'review-request', 'comment': 'comment', 'merge-queue': 'merge-queue',
    're-request': 'review-request', 'sticky-mention': 'comment', 'closed': 'merged',
    'read': 'read', 'acknowledged': 'acknowledged', 'mention': 'mention',
  };
  const summaries: Record<Exclude<Scenario, 'empty'>, string> = {
    'new-review': 'Demo teammate directly requested a review on this new synthetic PR.',
    comment: 'Demo teammate added an ordinary progress comment. This is not a new request.',
    'merge-queue': 'This synthetic PR entered the merge queue. No review request was made.',
    're-request': 'Demo teammate explicitly requested a fresh review.',
    'sticky-mention': 'An ordinary update arrived with an old mention reason. No new mention or review request.',
    closed: 'The synthetic source was closed. Retained local work is unchanged.',
    read: 'The synthetic notification was read on GitHub.',
    acknowledged: 'The synthetic notification was marked done on GitHub.',
    mention: 'Demo teammate mentioned you again. Inspect the message before deciding to act.',
  };
  state.staged.push({
    id: id(state, scenario), threadId: thread.id, kind: kinds[scenario], at: state.clock,
    actor: 'demo-teammate', summary: summaries[scenario],
  });
}

function applyEvent(state: AppState, event: Activity): void {
  const thread = state.threads.find(entry => entry.id === event.threadId);
  if (!thread) throw new Error(`Staged activity refers to an unknown thread: ${event.threadId}`);
  if (thread.events.some(entry => entry.id === event.id)) return;
  thread.events.push(copy(event));
  if (event.kind === 'read') {
    thread.notification = 'read';
    return;
  }
  if (event.kind === 'acknowledged') {
    thread.notification = 'done';
    handle(state, thread.events.map(entry => entry.id));
    return;
  }
  if (event.kind === 'merge-queue') thread.state = 'queued';
  if (event.kind === 'merged') thread.state = 'closed';
  if (event.id.startsWith('sticky-mention-')) thread.reason = 'mention';
  if (isRequest(event) || event.kind === 'mention') {
    thread.subscribed = true;
    thread.reason = isRequest(event) ? 'review_requested' : 'mention';
    thread.notification = 'unread';
  } else if (thread.subscribed) {
    thread.notification = 'unread';
  } else {
    handle(state, [event.id]);
  }
}

function refresh(state: AppState): void {
  if (state.failures.refresh === 'error') {
    state.refresh.status = 'error';
    state.refresh.message = 'Simulated offline refresh failed. Last good data is unchanged; staged events remain available to retry.';
    return;
  }
  const count = state.failures.refresh === 'partial' ? Math.floor(state.staged.length / 2) : state.staged.length;
  const applied = state.staged.splice(0, count);
  for (const event of applied) applyEvent(state, event);
  if (state.failures.refresh === 'partial') {
    state.refresh.status = 'partial';
    state.refresh.message = `Partial synthetic refresh: applied ${count} events; ${state.staged.length} remain unavailable and staged. Last full success is unchanged.`;
  } else {
    state.refresh.status = 'ok';
    state.refresh.lastSuccessAt = state.clock;
    state.refresh.message = state.threads.every(thread => thread.notification === 'done')
      ? 'Successful synthetic refresh: no source notifications. Retained local work is unchanged.'
      : `Synthetic refresh complete. Applied ${count} staged events; no network request was made.`;
  }
}

function notification(state: AppState, command: Extract<Command, { type: 'notification' }>): void {
  const thread = state.threads.find(entry => entry.id === command.threadId);
  if (!thread) throw new Error('This GitHub thread no longer exists.');
  if (state.failures.external) throw new Error('Simulated GitHub write failed. Notification, subscription, and local work are unchanged; retry when available.');
  const event: Activity = {
    id: id(state, `notification-${command.action}`), threadId: thread.id,
    kind: command.action === 'read' ? 'read' : 'acknowledged', at: state.clock,
    actor: 'demo-you', summary: `Explicit simulated GitHub ${command.action}. Local action completion is separate.`,
  };
  thread.events.push(event);
  if (command.action === 'read') thread.notification = 'read';
  else {
    handle(state, thread.events.map(entry => entry.id));
    if (command.action === 'done') thread.notification = 'done';
    else thread.subscribed = false;
  }
}

function remember(before: AppState, after: AppState, label: string): void {
  const changed = unique([...before.actions, ...after.actions].map(item => item.id)).filter(actionId =>
    !same(before.actions.find(item => item.id === actionId), after.actions.find(item => item.id === actionId)));
  const added = after.handled.filter(eventId => !before.handled.includes(eventId));
  if (!changed.length && before.activeId === after.activeId && !added.length) return;
  after.undo.push({
    label, before: copy(before.actions.filter(item => changed.includes(item.id))),
    after: copy(after.actions.filter(item => changed.includes(item.id))),
    activeBefore: before.activeId, activeAfter: after.activeId, handledAdded: added,
  });
}

function inverseRoutine(current: WorkAction, before: WorkAction, after: WorkAction): boolean {
  const live = current.routine;
  const old = before.routine;
  const changed = after.routine;
  if (!live || !old || !changed) return false;
  const completedOccurrence = old.dueAt && !changed.dueAt;
  if (completedOccurrence && live.dueAt && live.dueAt !== old.dueAt) {
    // Undo revives the old occurrence, not yesterday's steps on today's occurrence.
    if (!live.history.some(entry => entry.dueAt === live.dueAt)) {
      live.history.push({ dueAt: live.dueAt, status: 'missed', steps: copy(current.steps) });
    }
    live.dueAt = old.dueAt;
  }
  const added = changed.history.filter(entry => !old.history.some(previous => same(previous, entry)));
  live.history = live.history.filter(entry => !added.some(addition => same(addition, entry)));
  for (const occurrence of old.history) {
    if (!changed.history.some(entry => same(entry, occurrence))
      && !live.history.some(entry => entry.dueAt === occurrence.dueAt)) {
      live.history.push(copy(occurrence));
    }
  }
  for (const field of ['time', 'timeZone', 'nextDueAt', 'dueAt', 'snoozedUntil'] as const) {
    if (same(old[field], changed[field]) || !same(live[field], changed[field])) continue;
    if (field in old) Object.assign(live, { [field]: old[field] });
    else delete (live as unknown as Record<string, unknown>)[field];
  }
  return true;
}

function undo(state: AppState): void {
  const entry = state.undo.pop();
  if (!entry) throw new Error('There is no local change to undo.');
  for (const after of entry.after) {
    const current = state.actions.find(item => item.id === after.id);
    if (!current) continue;
    const before = entry.before.find(item => item.id === after.id);
    if (!before) {
      if (same(current, after)) state.actions = state.actions.filter(item => item.id !== after.id);
      else {
        // Keep edits made after creating/finishing a candidate; inverse only the lifecycle fields.
        if (current.status === after.status) current.status = 'available';
        if (current.completedAt === after.completedAt) delete current.completedAt;
        if (current.remindAt === after.remindAt) delete current.remindAt;
        if (current.reminderDismissed === after.reminderDismissed) delete current.reminderDismissed;
      }
      continue;
    }
    const routineInverted = inverseRoutine(current, before, after);
    for (const field of unique([...Object.keys(before), ...Object.keys(after)]) as (keyof WorkAction)[]) {
      if (field === 'routine' && routineInverted) continue;
      if (same(before[field], after[field]) || !same(current[field], after[field])) continue;
      if (field in before) Object.assign(current, { [field]: copy(before[field]) });
      else delete (current as unknown as Record<string, unknown>)[field];
    }
  }
  for (const before of entry.before) {
    if (!entry.after.some(item => item.id === before.id) && !state.actions.some(item => item.id === before.id)) {
      state.actions.push(copy(before));
    }
  }
  if (state.activeId === entry.activeAfter) {
    state.activeId = entry.activeBefore && state.actions.some(item => item.id === entry.activeBefore) ? entry.activeBefore : null;
  }
  state.handled = state.handled.filter(eventId => {
    if (!entry.handledAdded.includes(eventId)) return true;
    const thread = state.threads.find(item => item.events.some(event => event.id === eventId));
    const position = thread?.events.findIndex(item => item.id === eventId) ?? -1;
    const acknowledged = state.operations.some(operation => operation.status === 'confirmed' && operation.eventIds.includes(eventId))
      || thread?.notification === 'done'
      || (position >= 0 && thread?.events.slice(position + 1).some(item => item.kind === 'acknowledged'));
    const retainedHandling = state.actions.some(item => (item.status === 'done' || item.status === 'later' || item.status === 'removed')
      && item.eventIds.includes(eventId));
    return !!acknowledged || retainedHandling;
  });
}

function reset(state: AppState): AppState {
  const retained = copy(state.actions.filter(item => item.origin === 'capture'));
  const next = initialState(state.timeZone);
  next.clock = state.clock;
  next.sequence = Math.max(next.sequence, state.sequence);
  next.draft = state.draft;
  next.actions = [...next.actions.filter(item => !retained.some(keep => keep.id === item.id)), ...retained];
  for (const item of retained) {
    if (item.threadId && !next.threads.some(thread => thread.id === item.threadId)) {
      const thread = state.threads.find(entry => entry.id === item.threadId);
      if (thread) next.threads.push(copy(thread));
    } else if (item.threadId) {
      const thread = next.threads.find(entry => entry.id === item.threadId)!;
      const old = state.threads.find(entry => entry.id === item.threadId);
      thread.events.push(...copy(old?.events.filter(event => item.eventIds.includes(event.id)
        && !thread.events.some(entry => entry.id === event.id)) ?? []));
    }
    if (item.status === 'done' || item.status === 'later' || item.status === 'removed') handle(next, item.eventIds);
  }
  next.activeId = retained.some(item => item.id === state.activeId) ? state.activeId : null;
  if (state.selectedKey && retained.some(item => `a:${item.id}` === state.selectedKey || `t:${item.threadId}` === state.selectedKey)) {
    next.selectedKey = state.selectedKey;
  }
  settleRoutines(next);
  appendOrder(next);
  next.newKeys = [];
  next.refresh.message = 'Synthetic fixtures reset. Original user captures, their notes and progress, and the local clock are retained.';
  return next;
}

export function transition(state: AppState, command: Command): AppState {
  if (state.runtime === 'desktop' && ['stage', 'reset', 'advance', 'configure', 'notification', 'refresh', 'interpret'].includes(command.type)) {
    throw new Error('Simulation commands are not available in a desktop workspace.');
  }
  const next = copy(state);
  let undoable = false;
  switch (command.type) {
    case 'select':
      if (command.key !== null) {
        requireRow(next, command.key);
        next.seen = unique([...next.seen, command.key]);
      }
      next.selectedKey = command.key;
      break;
    case 'view':
      next.view = command.view;
      break;
    case 'draft':
      next.draft = command.text;
      break;
    case 'capture': {
      if (!next.draft.trim()) throw new Error('Write something to capture first.');
      const item = action(next, next.draft.trim().split('\n')[0]!, 'capture');
      item.captures = [next.draft];
      item.interpretation = 'pending';
      item.interpretationMessage = next.runtime === 'desktop'
        ? 'Original capture kept locally. Interpretation waits for a successful save.'
        : 'Original capture saved. Interpretation is a separate, optional action.';
      next.actions.push(item);
      next.draft = '';
      next.selectedKey = `a:${item.id}`;
      break;
    }
    case 'interpret':
      interpret(next, command.key);
      break;
    case 'edit': {
      const item = ensureAction(next, command.key);
      if (command.title !== undefined) {
        if (!command.title.trim()) throw new Error('An action title cannot be empty.');
        item.title = command.title;
      }
      for (const field of ['notes', 'project', 'nextStep'] as const) {
        if (command[field] !== undefined) item[field] = command[field];
      }
      break;
    }
    case 'start': {
      const item = ensureAction(next, command.key);
      unfinished(item);
      if (item.routine && !item.routine.dueAt) throw new Error('This routine is not due yet.');
      item.status = 'available';
      delete item.remindAt;
      delete item.reminderDueAt;
      if (item.routine) delete item.routine.snoozedUntil;
      item.reminderDismissed = true;
      next.activeId = item.id;
      undoable = true;
      break;
    }
    case 'done': {
      const item = ensureAction(next, command.key);
      unfinished(item);
      if (item.routine) finishOccurrence(next, item, 'done');
      else {
        item.status = 'done';
        item.completedAt = next.clock;
        delete item.remindAt;
        item.reminderDismissed = true;
        if (next.activeId === item.id) next.activeId = null;
      }
      handle(next, item.eventIds);
      undoable = true;
      break;
    }
    case 'later': {
      const remindAt = command.remindAt === undefined ? undefined : instant(command.remindAt);
      if (remindAt && compare(remindAt, next.clock) <= 0) throw new Error('Choose a reminder time in the future.');
      const item = ensureAction(next, command.key);
      unfinished(item);
      item.status = 'later';
      item.reminderDismissed = false;
      if (remindAt) {
        item.remindAt = remindAt;
        item.reminderDueAt = remindAt;
      } else {
        delete item.remindAt;
        delete item.reminderDueAt;
      }
      if (command.note?.trim() && !item.notes.split('\n\n').includes(command.note.trim())) {
        item.notes = [item.notes, command.note.trim()].filter(Boolean).join('\n\n');
      }
      handle(next, item.eventIds);
      if (next.activeId === item.id) next.activeId = null;
      undoable = true;
      break;
    }
    case 'restore': {
      const item = ensureAction(next, command.key);
      if (item.status === 'available') throw new Error('This action is already available.');
      item.status = 'available';
      delete item.completedAt;
      delete item.remindAt;
      item.reminderDismissed = false;
      settleRoutines(next);
      undoable = true;
      break;
    }
    case 'remove': {
      const item = ensureAction(next, command.key);
      if (item.status === 'removed') throw new Error('This action is already removed.');
      item.status = 'removed';
      handle(next, item.eventIds);
      if (next.activeId === item.id) next.activeId = null;
      undoable = true;
      break;
    }
    case 'step': {
      const item = ensureAction(next, command.key);
      unfinished(item);
      if (item.routine && !item.routine.dueAt) throw new Error('This routine has no due occurrence to record.');
      const position = item.steps.findIndex(step => step.id === command.stepId);
      if (position < 0) throw new Error('This checklist step no longer exists.');
      const step = item.steps[position]!;
      if (step.doneAt) throw new Error('This step is already recorded. Undo can restore the previous progress.');
      if (item.steps.slice(0, position).some(entry => !entry.doneAt)) throw new Error('Record the earlier steps first.');
      step.doneAt = next.clock;
      item.nextStep = item.steps[position + 1]?.title ?? '';
      undoable = true;
      break;
    }
    case 'reminder': {
      const item = ensureAction(next, command.key);
      unfinished(item);
      if (item.routine ? !item.routine.dueAt : !item.remindAt || compare(item.remindAt, next.clock) > 0) {
        throw new Error('This action has no due reminder.');
      }
      if (command.action === 'skip') {
        if (!item.routine) throw new Error('Only routine occurrences can be skipped. Dismiss this local reminder instead.');
        finishOccurrence(next, item, 'skipped');
      } else if (command.action === 'dismiss') {
        item.reminderDismissed = true;
      } else {
        const until = addMinutes(next.clock, 30);
        if (item.routine) item.routine.snoozedUntil = until;
        else item.remindAt = until;
        item.reminderDismissed = false;
      }
      undoable = true;
      break;
    }
    case 'undo':
      undo(next);
      break;
    case 'stage':
      stage(next, command.scenario);
      break;
    case 'refresh':
      refresh(next);
      break;
    case 'reconsider': {
      const ranked = getRows(next, 'attention').sort((a, b) => priorityRank(a) - priorityRank(b)).map(row => row.key);
      next.order = [...ranked, ...next.order.filter(key => !ranked.includes(key))];
      next.newKeys = [];
      break;
    }
    case 'advance':
      if (!Number.isFinite(command.minutes) || command.minutes < 0 || !Number.isSafeInteger(command.minutes * 60_000)) {
        throw new Error('Advance the local clock by a finite, non-negative number of minutes.');
      }
      next.clock = addMinutes(next.clock, command.minutes);
      settleRoutines(next);
      break;
    case 'clock':
      next.clock = instant(command.now);
      settleRoutines(next);
      break;
    case 'routine': {
      const item = ensureAction(next, command.key);
      unfinished(item);
      if (item.routine || item.steps.some(step => step.doneAt)) throw new Error('Existing routine progress cannot be replaced. Capture a separate routine.');
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(command.time)
        || !command.steps.length || command.steps.some(step => !step.trim())) throw new Error('Choose a daily time and at least one named step.');
      const nextDueAt = nextDaily(next.clock, command.time, command.timeZone);
      item.routine = { time: command.time, timeZone: command.timeZone, nextDueAt, history: [] };
      item.steps = command.steps.map((title, index) => ({ id: `${item.id}-step-${index + 1}`, title: title.trim() }));
      item.nextStep ||= item.steps[0]!.title;
      item.interpretation = 'supported';
      item.interpretationMessage = 'Daily routine saved. Record steps here after doing them in your tools.';
      settleRoutines(next);
      break;
    }
    case 'notification':
      notification(next, command);
      break;
    case 'configure':
      if (command.refreshFailure !== undefined) next.failures.refresh = command.refreshFailure;
      if (command.storageFailure !== undefined) next.failures.storage = command.storageFailure;
      if (command.interpretationFailure !== undefined) next.failures.interpretation = command.interpretationFailure;
      if (command.externalFailure !== undefined) next.failures.external = command.externalFailure;
      break;
    case 'reset':
      return reset(next);
    default:
      throw new Error(`Unknown command: ${(command as { type: string }).type}`);
  }
  if (undoable) remember(state, next, command.type);
  appendOrder(next);
  return next;
}
