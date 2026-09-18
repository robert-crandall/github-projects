import { threadSchema, type AppState, type ExternalOperation, type Thread } from '../types.ts';
import { transition } from './engine.ts';
import { instant } from './clock.ts';
import { migrateWorkspace } from './migration.ts';
import { archiveBoundary, hasNewActivity, latestTime } from './archive.ts';
import { threadIdSchema } from '../../service/src/schema.ts';
import { reconcileTerminal, unknownSourceState } from './terminal.ts';
import { defaultWorkState } from '../../service/src/work-schema.ts';
import { consolidateWorkTasks } from '../work/engine.ts';

export function emptyWorkspace(now: string, timeZone: string): AppState {
  new Intl.DateTimeFormat('en-US', { timeZone });
  return {
    version: 3, runtime: 'desktop', clock: instant(now), timeZone, work: defaultWorkState(),
    threads: [], tasks: [], notes: [], staged: [], handled: [], seen: [], order: [], newKeys: [],
    selectedKey: null, view: 'inbox', draft: '', operations: [], rules: [], inboxes: [],
    refresh: { lastSuccessAt: null, status: 'saved', message: 'Refresh loads GitHub activity. Notes and tasks are available without a connection.' },
    failures: { refresh: 'none', storage: false, external: false }, undo: [], sequence: 0,
  };
}

export function restoreDesktop(value: unknown, now: string): AppState {
  const state = migrateWorkspace(value);
  if (state.runtime !== 'desktop' || state.tasks.some(task => task.history?.origin === 'fixture')
    || state.notes.some(note => note.history?.origin === 'fixture') || state.threads.some(thread => thread.source !== 'github')) {
    throw new Error('This is not a live desktop workspace. The saved copy has not been changed.');
  }
  for (const operation of state.operations) {
    if (operation.status === 'pending') {
      operation.status = 'uncertain';
      operation.message = 'The app closed before confirmation was saved. Check GitHub or retry explicitly; nothing was replayed.';
    }
  }
  return transition(consolidateWorkTasks(state), { type: 'clock', now });
}

export type RefreshBatch = {
  threads: Thread[]; startedAt: string; fetchedAt: string; status: 'complete' | 'partial';
  diagnostics: string[]; coverageMessage?: string;
};

/** Apply to the current workspace, not the snapshot used to initiate the request. */
export function mergeRefresh(state: AppState, batch: RefreshBatch): AppState {
  const next = structuredClone(state);
  const startedAt = instant(batch.startedAt);
  if (Date.parse(startedAt) > Date.parse(instant(batch.fetchedAt))) throw new Error('Refresh timestamps are inconsistent. Saved work is unchanged.');
  const fetchedThreadIds = new Set(batch.threads.map(thread => thread.id));
  for (const thread of next.threads) {
    if (!fetchedThreadIds.has(thread.id)) {
      thread.events = thread.events.map(event => event.requestState === 'current' ? { ...event, requestState: 'uncertain' } : event);
      if (!thread.sourceState || Date.parse(startedAt) >= Date.parse(thread.sourceState.observedAt)) {
        thread.sourceState = unknownSourceState(startedAt);
      }
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
        for (const note of next.notes) if (note.threadId === previousId) note.threadId = fetched.id;
        for (const task of next.tasks) if (task.threadId === previousId) task.threadId = fetched.id;
        for (const operation of next.operations) if (operation.threadId === previousId) operation.threadId = fetched.id;
        if (next.selectedKey === `t:${previousId}`) next.selectedKey = `t:${fetched.id}`;
        next.order = next.order.map(key => key === `t:${previousId}` ? `t:${fetched.id}` : key);
        previous.events = previous.events.map(event => ({ ...event, threadId: fetched.id }));
        previous.id = fetched.id;
      }
    }
    if (previous && (previous.repo.toLowerCase() !== fetched.repo.toLowerCase() || previous.number !== fetched.number || previous.kind !== fetched.kind)) {
      throw new Error('GitHub returned a changed thread identity. Saved work is unchanged.');
    }
    const confirmed = next.operations.filter(operation => operation.threadId === fetched.id && operation.status === 'confirmed');
    const acknowledgedAt = latestTime(confirmed.filter(operation => operation.action === 'done').map(operation => operation.startedAt));
    const boundary = previous?.archive ?? (previous?.notification === 'done' && acknowledgedAt ? archiveBoundary(previous, acknowledgedAt) : null);
    fetched.archive = previous?.archive ?? null;
    const newActivity = previous && hasNewActivity({ ...previous, archive: boundary }, fetched);
    if (newActivity) {
      fetched.archive = null;
      next.newKeys = [...new Set([...next.newKeys, `t:${fetched.id}`])];
    }
    const stale = previous?.notificationUpdatedAt && fetched.notificationUpdatedAt
      && Date.parse(fetched.notificationUpdatedAt) < Date.parse(previous.notificationUpdatedAt);
    fetched.notificationUpdatedAt = latestTime([previous?.notificationUpdatedAt, fetched.notificationUpdatedAt]);
    if (stale && previous) {
      fetched.reason = previous.reason;
      fetched.rawReason = previous.rawReason;
      fetched.sourceMetadata = previous.sourceMetadata;
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
    const observed = fetched.sourceState;
    const oldObservation = previous?.sourceState;
    const olderObservation = observed && oldObservation && (Date.parse(observed.observedAt) < Date.parse(oldObservation.observedAt)
      || (observed.updatedAt && oldObservation.updatedAt && Date.parse(observed.updatedAt) < Date.parse(oldObservation.updatedAt)));
    if (olderObservation && previous) fetched.title = previous.title;
    fetched.sourceState = olderObservation ? oldObservation : observed ?? unknownSourceState(startedAt);
    const evidenceAt = latestTime([fetched.notificationUpdatedAt, ...fetched.events
      .filter(event => event.kind !== 'read' && event.kind !== 'acknowledged').map(event => event.at)]);
    if (evidenceAt && fetched.sourceState.state !== 'unknown' && Date.parse(evidenceAt) > Date.parse(fetched.sourceState.observedAt)) {
      fetched.sourceState = { ...unknownSourceState(fetched.sourceState.observedAt),
        error: { code: 'source_changed', retryable: true, message: 'Activity is newer than the source-state check. Terminal suppression is off until an explicit Refresh confirms current state.' } };
    }
    fetched.state = fetched.sourceState.state === 'queued' ? 'queued'
      : fetched.sourceState.state === 'closed' || fetched.sourceState.state === 'merged' ? 'closed' : 'open';
    reconcileTerminal(previous, fetched);
    // Timeline enrichment can be newer than the notification listing that accompanied it.
    if (stale && previous && (previous.notification !== 'done' || !newActivity)) fetched.notification = previous.notification;
    const authoritativeSubscription = fetched.subscription === 'subscribed' || fetched.subscription === 'unsubscribed';
    if (authoritativeSubscription && (!previous?.subscriptionObservedAt || Date.parse(startedAt) > Date.parse(previous.subscriptionObservedAt))) {
      fetched.subscribed = fetched.subscription === 'subscribed';
      fetched.subscriptionObservedAt = startedAt;
    } else if (previous) {
      fetched.subscribed = previous.subscribed;
      fetched.subscription = previous.subscription;
      fetched.subscriptionObservedAt = previous.subscriptionObservedAt;
    }
    if (confirmed.some(operation => operation.action === 'done'
      && (!fetched.notificationUpdatedAt || (operation.notificationUpdatedAt && Date.parse(operation.notificationUpdatedAt) >= Date.parse(fetched.notificationUpdatedAt))))
      && !fetched.events.some(event => !next.handled.includes(event.id) && event.kind !== 'read' && event.kind !== 'acknowledged')) {
      fetched.notification = 'done';
    }
    if (previous) Object.assign(previous, fetched);
    else next.threads.push(fetched);
  }
  next.refresh = {
    lastSuccessAt: batch.status === 'complete' ? instant(batch.fetchedAt) : next.refresh.lastSuccessAt,
    status: batch.status === 'complete' ? 'ok' : 'partial',
    diagnostics: [...new Set(batch.diagnostics)],
    coverageMessage: batch.coverageMessage ?? '',
    message: batch.status === 'complete'
      ? `Refresh complete. Received ${batch.threads.length} GitHub threads. Notes and tasks are unchanged.`
      : `Received ${batch.threads.length} GitHub thread${batch.threads.length === 1 ? '' : 's'}. Saved work is retained. Refresh to retry missing activity.`,
  };
  return transition(next, { type: 'clock', now: next.clock });
}

export function beginOperation(state: AppState, operation: Pick<ExternalOperation, 'id' | 'threadId' | 'action' | 'eventIds' | 'notificationUpdatedAt'>, deferIfPending = false): AppState {
  const next = structuredClone(state);
  const thread = next.threads.find(thread => thread.id === operation.threadId);
  if (!thread || thread.source !== 'github' || !threadIdSchema.safeParse(thread.id).success
    || operation.eventIds.some(id => !thread.events.some(event => event.id === id))) {
    throw new Error('The displayed GitHub evidence changed. Open the notification again.');
  }
  const pending = next.operations.some(existing => existing.threadId === operation.threadId && existing.status === 'pending');
  if (next.operations.some(existing => existing.id === operation.id) || (pending && !deferIfPending)) {
    throw new Error('A GitHub operation for this notification is already pending.');
  }
  next.operations.push({ ...operation, eventIds: [...new Set(operation.eventIds)], startedAt: state.clock, status: pending ? 'failed' : 'pending',
    message: pending ? 'Not sent because another GitHub write is pending. Archive stays here; retry this acknowledgement explicitly when it finishes.'
      : 'Intent awaits local persistence. GitHub has not confirmed success.' });
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
  operation.message = 'GitHub confirmed this operation. Your notes and tasks are unchanged.';
  next.handled = [...new Set([...next.handled, ...operation.eventIds])];
  const thread = next.threads.find(thread => thread.id === operation.threadId)!;
  if (operation.action === 'unsubscribe'
    && (!thread.subscriptionObservedAt || Date.parse(operation.finishedAt) >= Date.parse(thread.subscriptionObservedAt))) {
    thread.subscribed = false;
    thread.subscription = 'unsubscribed';
    thread.subscriptionObservedAt = operation.finishedAt;
  } else if (operation.action === 'done'
    && (!thread.notificationUpdatedAt || (operation.notificationUpdatedAt && Date.parse(operation.notificationUpdatedAt) >= Date.parse(thread.notificationUpdatedAt)))
    && !thread.events.some(event => !next.handled.includes(event.id) && event.kind !== 'read' && event.kind !== 'acknowledged')) {
    thread.notification = 'done';
  }
  return next;
}
