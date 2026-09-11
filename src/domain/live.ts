import { stateSchema, threadSchema, type AppState, type ExternalOperation, type Thread } from '../types.ts';
import { capturedReference, getRow, getRows, isRequest, priorityRank, transition } from './engine.ts';
import { instant } from './clock.ts';

export function emptyWorkspace(now: string, timeZone: string): AppState {
  new Intl.DateTimeFormat('en-US', { timeZone });
  return {
    version: 2, runtime: 'desktop', clock: instant(now), timeZone,
    threads: [], actions: [], staged: [], handled: [], seen: [], order: [], newKeys: [],
    selectedKey: null, activeId: null, view: 'attention', draft: '', operations: [],
    refresh: { lastSuccessAt: null, status: 'saved', message: 'Refresh loads GitHub activity. Local work is available without a connection.' },
    failures: { refresh: 'none', storage: false, interpretation: false, external: false },
    undo: [], sequence: 0,
  };
}

export function restoreDesktop(value: unknown, now: string): AppState {
  const state = stateSchema.parse(value);
  if (state.runtime !== 'desktop' || state.actions.some(action => action.origin === 'fixture')
    || state.threads.some(thread => thread.source !== 'github')) {
    throw new Error('This is not a live desktop workspace. The saved copy has not been changed.');
  }
  const actions = new Set(state.actions.map(action => action.id));
  const threads = new Set(state.threads.map(thread => thread.id));
  if (actions.size !== state.actions.length || threads.size !== state.threads.length
    || (state.activeId !== null && !actions.has(state.activeId))
    || state.actions.some(action => {
      const thread = state.threads.find(thread => thread.id === action.threadId);
      return action.threadId ? !thread || action.eventIds.some(id => !thread.events.some(event => event.id === id))
        : action.eventIds.length > 0;
    })
    || state.operations.some(operation => !threads.has(operation.threadId))
    || (state.selectedKey !== null && !getRow(state, state.selectedKey))) {
    throw new Error('Saved work has inconsistent references. Export it before explicit recovery.');
  }
  for (const zone of [state.timeZone, ...state.actions.flatMap(action => action.routine ? [action.routine.timeZone] : [])]) {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  }
  for (const operation of state.operations) {
    if (operation.status === 'pending') {
      operation.status = 'uncertain';
      operation.message = 'The app closed before confirmation was saved. Check GitHub or retry explicitly; nothing was replayed.';
    }
  }
  return transition(state, { type: 'clock', now });
}

export type RefreshBatch = { threads: Thread[]; startedAt: string; fetchedAt: string; status: 'complete' | 'partial'; diagnostics: string[] };

/** Apply to the current workspace, not the snapshot used to initiate the request. */
export function mergeRefresh(state: AppState, batch: RefreshBatch): AppState {
  const next = structuredClone(state);
  const startedAt = instant(batch.startedAt);
  if (Date.parse(startedAt) > Date.parse(instant(batch.fetchedAt))) throw new Error('Refresh timestamps are inconsistent. Saved work is unchanged.');
  const fetchedThreadIds = new Set(batch.threads.map(thread => thread.id));
  for (const thread of next.threads) {
    if (!fetchedThreadIds.has(thread.id)) {
      thread.events = thread.events.map(event => event.requestState === 'current' ? { ...event, requestState: 'uncertain' } : event);
    }
  }
  for (const incoming of batch.threads) {
    const fetched = threadSchema.parse(incoming);
    if (fetched.source !== 'github' || fetched.events.some(event => !event.requestState || event.threadId !== fetched.id)) {
      throw new Error('GitHub returned incomplete evidence identities. Saved work is unchanged.');
    }
    let previous = next.threads.find(thread => thread.id === fetched.id);
    if (!previous) {
      previous = next.threads.find(thread => thread.id.startsWith('capture:')
        && thread.repo.toLowerCase() === fetched.repo.toLowerCase() && thread.number === fetched.number && thread.kind === fetched.kind);
      if (previous) {
        const previousId = previous.id;
        for (const action of next.actions) if (action.threadId === previousId) action.threadId = fetched.id;
        if (next.selectedKey === `t:${previousId}`) next.selectedKey = `t:${fetched.id}`;
        next.order = next.order.map(key => key === `t:${previousId}` ? `t:${fetched.id}` : key);
        previous.id = fetched.id;
      }
    }
    if (previous && (previous.repo !== fetched.repo || previous.number !== fetched.number || previous.kind !== fetched.kind)) {
      throw new Error('GitHub returned a changed thread identity. Saved work is unchanged.');
    }
    const merged = new Map(previous?.events.map(event => [event.id, event]));
    const fetchedEventIds = new Set(fetched.events.map(event => event.id));
    for (const [id, event] of merged) {
      if (!fetchedEventIds.has(id) && event.requestState === 'current') merged.set(id, { ...event, requestState: 'uncertain' });
    }
    for (const event of fetched.events) {
      const old = merged.get(event.id);
      if (old && (old.kind !== event.kind || old.rawKind !== event.rawKind || old.at !== event.at)) {
        throw new Error('GitHub returned inconsistent event history. Saved work is unchanged.');
      }
      merged.set(event.id, event);
    }
    fetched.events = [...merged.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    const confirmed = next.operations.filter(operation => operation.threadId === fetched.id && operation.status === 'confirmed');
    const authoritativeSubscription = fetched.subscription === 'subscribed' || fetched.subscription === 'unsubscribed';
    if (authoritativeSubscription
      && (!previous?.subscriptionObservedAt || Date.parse(startedAt) > Date.parse(previous.subscriptionObservedAt))) {
      fetched.subscribed = fetched.subscription === 'subscribed';
      fetched.subscriptionObservedAt = startedAt;
    } else if (previous) {
      fetched.subscribed = previous.subscribed;
      fetched.subscription = previous.subscription;
      fetched.subscriptionObservedAt = previous.subscriptionObservedAt;
    }
    if (confirmed.some(operation => operation.action === 'done')
      && !fetched.events.some(event => !next.handled.includes(event.id) && event.kind !== 'read' && event.kind !== 'acknowledged')) {
      fetched.notification = 'done';
    }
    if (previous) Object.assign(previous, fetched);
    else next.threads.push(fetched);
  }
  next.refresh = {
    lastSuccessAt: batch.status === 'complete' ? instant(batch.fetchedAt) : next.refresh.lastSuccessAt,
    status: batch.status === 'complete' ? 'ok' : 'partial',
    message: batch.diagnostics.join(' ') || (batch.status === 'complete'
      ? `Refresh complete. Received ${batch.threads.length} GitHub threads. Retained work is unchanged.`
      : 'Some GitHub activity could not be loaded. Saved work is retained.'),
  };
  return transition(next, { type: 'clock', now: next.clock });
}

export function beginOperation(state: AppState, operation: Pick<ExternalOperation, 'id' | 'threadId' | 'action' | 'eventIds'>): AppState {
  const next = structuredClone(state);
  const thread = next.threads.find(thread => thread.id === operation.threadId);
  if (!thread || thread.source !== 'github' || operation.eventIds.some(id => !thread.events.some(event => event.id === id))) {
    throw new Error('The displayed GitHub evidence changed. Open the notification again.');
  }
  if (next.operations.some(existing => existing.id === operation.id || (existing.threadId === operation.threadId && existing.status === 'pending'))) {
    throw new Error('A GitHub operation for this notification is already pending.');
  }
  next.operations.push({ ...operation, eventIds: [...new Set(operation.eventIds)], startedAt: state.clock, status: 'pending',
    message: 'Intent awaits local persistence. GitHub has not confirmed success.' });
  return next;
}

export function finishOperation(state: AppState, id: string, result: { confirmedAt: string } | { error: string }): AppState {
  const next = structuredClone(state);
  const operation = next.operations.find(operation => operation.id === id);
  if (!operation || operation.status !== 'pending') throw new Error('There is no matching pending GitHub operation.');
  if ('error' in result) {
    operation.status = 'failed';
    operation.message = result.error;
    return next;
  }
  operation.status = 'confirmed';
  operation.finishedAt = instant(result.confirmedAt);
  operation.message = 'GitHub confirmed this operation. Your local action is unchanged.';
  next.handled = [...new Set([...next.handled, ...operation.eventIds])];
  const thread = next.threads.find(thread => thread.id === operation.threadId)!;
  if (operation.action === 'unsubscribe'
    && (!thread.subscriptionObservedAt || Date.parse(operation.finishedAt) >= Date.parse(thread.subscriptionObservedAt))) {
    thread.subscribed = false;
    thread.subscription = 'unsubscribed';
    thread.subscriptionObservedAt = operation.finishedAt;
  } else if (operation.action === 'done' && !thread.events.some(event => !next.handled.includes(event.id) && event.kind !== 'read' && event.kind !== 'acknowledged')) {
    thread.notification = 'done';
  }
  return next;
}

export type DerivedReminder = {
  id: string; occurrenceId: string; dueAt: string; timeZone: string; snoozedUntil?: string;
  daily?: { time: string; timeZone: string };
};

export function reminderSchedules(state: AppState): DerivedReminder[] {
  return state.actions.flatMap(action => {
    if (action.id === state.activeId || action.status === 'done' || action.status === 'removed' || action.reminderDismissed) return [];
    const routine = action.routine;
    const dueAt = routine?.dueAt ?? routine?.nextDueAt
      ?? (action.status === 'later' ? action.reminderDueAt ?? action.remindAt : undefined);
    if (!dueAt) return [];
    const original = instant(dueAt);
    return [{
      id: action.id, occurrenceId: `${action.id}:${original}`, dueAt: original,
      timeZone: routine?.timeZone ?? state.timeZone,
      ...(routine ? { daily: { time: routine.time, timeZone: routine.timeZone }, snoozedUntil: routine.snoozedUntil }
        : { snoozedUntil: action.remindAt && instant(action.remindAt) !== original ? action.remindAt : undefined }),
    }];
  });
}

// Keep the private fingerprint local. Only bounded evidence is sent to the SDK.
export function orderFingerprint(state: AppState): string {
  return JSON.stringify({
    rows: getRows(state, 'attention').map(row => ({
      key: row.key, title: row.title, kind: row.kind, events: row.events,
      action: row.action, thread: row.thread,
    })),
    activeId: state.activeId, order: state.order, handled: state.handled,
  });
}

export function applySuggestedOrder(state: AppState, fingerprint: string, orderedKeys: string[]): AppState {
  if (orderFingerprint(state) !== fingerprint) throw new Error('Work or evidence changed. Request a fresh preview before applying.');
  const candidates = getRows(state, 'attention').map(row => row.key);
  if (new Set(orderedKeys).size !== orderedKeys.length || orderedKeys.length !== candidates.length
    || orderedKeys.some(key => !candidates.includes(key))) {
    throw new Error('Copilot did not return every candidate exactly once. No order was applied.');
  }

  return { ...state, order: [...orderedKeys, ...state.order.filter(key => !candidates.includes(key))], newKeys: [] };
}

export function applyScopedSuggestedOrder(state: AppState, fingerprint: string, selectedKeys: string[], orderedKeys: string[]): AppState {
  if (orderFingerprint(state) !== fingerprint) throw new Error('Work or evidence changed. Request a fresh preview before applying.');
  const rows = getRows(state, 'attention');
  if (!selectedKeys.length || new Set(selectedKeys).size !== selectedKeys.length
    || selectedKeys.some(key => !rows.some(row => row.key === key))
    || new Set(orderedKeys).size !== orderedKeys.length || orderedKeys.length !== selectedKeys.length
    || orderedKeys.some(key => !selectedKeys.includes(key))) {
    throw new Error('Copilot must return each selected candidate exactly once. No order was applied.');
  }
  const ranks = [...new Set(rows.map(priorityRank))].sort((a, b) => a - b);
  const fullOrder = ranks.flatMap(rank => {
    const tier = rows.filter(row => priorityRank(row) === rank);
    const suggestions = orderedKeys.filter(key => tier.some(row => row.key === key));
    let index = 0;
    return tier.map(row => selectedKeys.includes(row.key) ? suggestions[index++]! : row.key);
  });
  return applySuggestedOrder(state, fingerprint, fullOrder);
}

export function captureFingerprint(state: AppState, key: string): string {
  const action = getRow(state, key)?.action;
  if (!action || !action.captures.length) throw new Error('Select a saved capture first.');
  return JSON.stringify({ action, threads: state.threads, actions: state.actions, handled: state.handled, activeId: state.activeId });
}

export type CaptureProposal = {
  kind: 'action' | 'routine' | 'unsupported'; title: string; steps: string[];
  dailyAt: string | null; timeZone: string; uncertainty: string;
};

export function applyCaptureProposal(state: AppState, key: string, fingerprint: string, proposal: CaptureProposal): AppState {
  if (captureFingerprint(state, key) !== fingerprint) throw new Error('The capture or related work changed. Request a fresh interpretation.');
  let next = structuredClone(state);
  const item = getRow(next, key)!.action!;
  if (item.status === 'done' || item.status === 'removed') throw new Error('Restore the capture before applying an interpretation.');
  if (!proposal.title.trim()) throw new Error('Give the proposed action a title.');
  if (proposal.kind === 'routine') {
    if (!proposal.dailyAt) throw new Error('Choose a daily time before applying the routine.');
    next = transition(next, { type: 'routine', key, time: proposal.dailyAt, timeZone: proposal.timeZone, steps: proposal.steps });
    getRow(next, key)!.action!.title = proposal.title;
    return next;
  }
  if (item.routine || item.steps.some(step => step.doneAt)) throw new Error('An interpretation cannot replace recorded progress.');
  item.title = proposal.title;
  item.steps = proposal.steps.map((title, index) => ({ id: `${item.id}-step-${index + 1}`, title }));
  item.interpretation = proposal.kind === 'unsupported' ? 'unsupported' : 'supported';
  item.interpretationMessage = proposal.uncertainty || 'Interpretation applied. Original words are retained.';
  const original = item.captures.at(-1)!;
  const reference = original.includes('demo://') ? undefined : capturedReference(original);
  if (proposal.kind === 'action' && reference) {
    let thread = next.threads.find(thread => thread.repo.toLowerCase() === reference.repo.toLowerCase()
      && thread.number === reference.number && thread.kind === 'pr');
    if (!thread) {
      thread = {
        id: `capture:${reference.repo}:${reference.number}`, ...reference, kind: 'pr', source: 'github',
        title: item.title, reason: 'subscribed', notification: 'done', subscribed: false, state: 'open', events: [],
        diagnostics: ['Linked from your original capture. Source state has not been fetched.'],
      };
      next.threads.push(thread);
    }
    const existing = next.actions.find(action => action.id !== item.id && action.threadId === thread.id
      && (action.status === 'available' || action.status === 'later') && !action.routine
      && (action.interpretation === 'supported' || action.eventIds.some(id => thread.events.some(event => event.id === id && ['review-request', 'team-request'].includes(event.kind)))));
    if (existing) {
      existing.captures.push(...item.captures);
      if (item.notes && item.notes !== existing.notes) existing.notes = [existing.notes, item.notes].filter(Boolean).join('\n\n');
      existing.project ||= item.project;
      existing.nextStep ||= item.nextStep;
      existing.origin = 'capture';
      next.actions = next.actions.filter(action => action.id !== item.id);
      if (next.selectedKey === key) next.selectedKey = `a:${existing.id}`;
      if (next.activeId === item.id) next.activeId = existing.id;
    } else {
      item.threadId = thread.id;
      item.eventIds = thread.events.filter(event => isRequest(event) && !next.handled.includes(event.id)).map(event => event.id);
    }
  }
  return transition(next, { type: 'clock', now: next.clock });
}
