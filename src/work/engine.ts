import {
  defaultWorkState, workCollectOutputSchema, workMetadataSchema, workRankInputSchema,
  type WorkAction, type WorkCollection, type WorkEvidence, type WorkMetadata, type WorkObservation, type WorkRankInput,
} from '../../service/src/work-schema.ts';
import type { AppState, Task } from '../types.ts';

/** Issues and pull requests share GitHub's repository-local number space. */
export function canonicalSource(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS source link without credentials.');
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const reference = /^\/([^/]+)\/([^/]+)\/(?:issues|pull|pulls)\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (reference) {
      url.hostname = 'github.com';
      url.pathname = `/${reference[1]!.toLowerCase()}/${reference[2]!.toLowerCase()}/issues/${BigInt(reference[3]!)}`;
      url.search = '';
      url.hash = '';
    }
  } else if (url.hostname.endsWith('.slack.com')) {
    const message = /^\/archives\/([^/]+)\/p(\d{10})\.?(\d{6})(?:\/|$)/.exec(url.pathname);
    if (message) {
      url.pathname = `/archives/${message[1]}/p${message[2]}${message[3]}`;
      url.search = '';
      url.hash = '';
    }
  }
  return url.toString();
}

export function taskIdentity(url: string, action: WorkAction): string {
  const source = canonicalSource(url);
  const github = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(source);
  return workMetadataSchema.shape.identity.parse(github ? source : `${action}:${source}`);
}

function timestamp(now: string | Date): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Use a valid task timestamp.');
  return date.toISOString();
}

function mergeEvidence(previous: WorkEvidence[], incoming: WorkEvidence[]): WorkEvidence[] {
  const evidence = [...previous];
  const provenance = new Set(previous.map(item => JSON.stringify([item.id, item.source, item.streamId])));
  for (const item of incoming) {
    const key = JSON.stringify([item.id, item.source, item.streamId]);
    if (!provenance.has(key)) {
      evidence.push(item);
      provenance.add(key);
    }
  }
  return evidence;
}

const observationPriority = { open: 0, unknown: 1, queued: 2, closed: 3, merged: 4 };
function latestObservations(observations: WorkObservation[]): Map<string, WorkObservation> {
  const latest = new Map<string, WorkObservation>();
  for (const observation of observations) {
    const key = canonicalSource(observation.url);
    const previous = latest.get(key);
    if (!previous || Date.parse(observation.observedAt) > Date.parse(previous.observedAt)
      || (Date.parse(observation.observedAt) === Date.parse(previous.observedAt)
        && observationPriority[observation.state] > observationPriority[previous.state])) latest.set(key, observation);
  }
  return latest;
}

function observe(work: WorkMetadata, observation?: WorkObservation, contextObservation = observation): WorkMetadata {
  let next = work;
  if (observation && (!work.availabilityObservedAt
    || Date.parse(observation.observedAt) >= Date.parse(work.availabilityObservedAt))) {
    next = {
      ...work,
      availability: observation.state === 'open' ? 'actionable' : observation.state === 'unknown' ? 'unknown' : 'waiting',
      availabilityReason: observation.reason || (observation.state === 'open' ? 'The source is open.'
        : observation.state === 'unknown' ? 'The source state could not be confirmed.' : `The source is ${observation.state}.`),
      availabilityObservedAt: observation.observedAt,
    };
  }
  if (contextObservation?.context && (!work.contextObservedAt
    || Date.parse(contextObservation.observedAt) >= Date.parse(work.contextObservedAt))) {
    next = { ...next, context: contextObservation.context, contextObservedAt: contextObservation.observedAt };
  }
  return next;
}

function notificationSource(notification: NonNullable<WorkMetadata['notification']>): string {
  return canonicalSource(`https://github.com/${notification.reference.repo}/issues/${notification.reference.number}`);
}

function mergeTasks(first: Task & { work: WorkMetadata }, second: Task & { work: WorkMetadata }): Task {
  const availabilityPriority = { actionable: 0, unknown: 1, waiting: 2 };
  const firstObserved = first.work.availabilityObservedAt ? Date.parse(first.work.availabilityObservedAt) : 0;
  const secondObserved = second.work.availabilityObservedAt ? Date.parse(second.work.availabilityObservedAt) : 0;
  const observation = secondObserved > firstObserved || (secondObserved === firstObserved
    && availabilityPriority[second.work.availability] > availabilityPriority[first.work.availability])
    ? second.work : first.work;
  const context = [first.work, second.work].filter(work => work.context).sort((a, b) =>
    Date.parse(b.contextObservedAt ?? b.availabilityObservedAt ?? '1970-01-01T00:00:00Z')
    - Date.parse(a.contextObservedAt ?? a.availabilityObservedAt ?? '1970-01-01T00:00:00Z'))[0];
  const notification = !first.work.notification || (second.work.notification
    && Date.parse(second.work.notification.updatedAt) > Date.parse(first.work.notification.updatedAt))
    ? second.work.notification : first.work.notification;
  const unsubscribe = [first.work.unsubscribe, second.work.unsubscribe].find(intent => intent && intent.status !== 'confirmed')
    ?? first.work.unsubscribe ?? second.work.unsubscribe;
  const status = first.status === 'open' || second.status === 'open' ? 'open' : 'done';
  const completedAt = status === 'done' && (!first.completedAt || !second.completedAt) ? undefined
    : [first.completedAt, second.completedAt].filter((at): at is string => !!at)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const additionalNotes = second.title === first.title ? second.notes : [second.title, second.notes].filter(Boolean).join('\n');
  return {
    ...first, status, completedAt,
    createdAt: Date.parse(first.createdAt) <= Date.parse(second.createdAt) ? first.createdAt : second.createdAt,
    notes: [...new Set([first.notes, additionalNotes].filter(Boolean))].join('\n\n'),
    work: workMetadataSchema.parse({
      ...first.work,
      evidence: mergeEvidence(first.work.evidence, second.work.evidence),
      handledEvidenceIds: [...new Set([...first.work.handledEvidenceIds, ...second.work.handledEvidenceIds])],
      availability: observation.availability, availabilityReason: observation.availabilityReason,
      availabilityObservedAt: observation.availabilityObservedAt, notification, unsubscribe,
      context: context?.context, contextObservedAt: context?.contextObservedAt ?? context?.availabilityObservedAt,
    }),
  };
}

/** Collapse saved source/action rows before collection, retaining one shared completion boundary. */
export function consolidateWorkTasks(state: AppState): AppState {
  const tasks: Task[] = [];
  const positions = new Map<string, number>();
  const replacements = new Map<string, string>();
  const mergedIds = new Set<string>();
  let changed = false;
  for (const task of state.tasks) {
    if (!task.work) { tasks.push(task); continue; }
    const source = canonicalSource(task.work.url);
    if (task.work.notification && notificationSource(task.work.notification) !== source) {
      throw new Error('The notification does not match its task source.');
    }
    const identity = taskIdentity(source, task.work.action);
    const index = positions.get(identity);
    const normalized = { ...task, work: { ...task.work, identity, url: source } };
    changed ||= task.work.identity !== identity || task.work.url !== source;
    if (index === undefined) {
      positions.set(identity, tasks.length);
      tasks.push(normalized);
    } else {
      const previous = tasks[index]!;
      tasks[index] = mergeTasks({ ...previous, work: previous.work! }, normalized);
      replacements.set(task.id, previous.id);
      mergedIds.add(task.id);
      mergedIds.add(previous.id);
      changed = true;
    }
  }
  if (!changed) return state;
  const replaceId = (id: string) => replacements.get(id) ?? id;
  const replaceKey = (key: string) => key.startsWith('a:') ? `a:${replaceId(key.slice(2))}` : key;
  const ranking = state.work.ranking;
  const reasons = new Map<string, string>();
  for (const reason of ranking?.reasons ?? []) {
    const id = replaceId(reason.id);
    if (!reasons.has(id)) reasons.set(id, reason.reason);
  }
  return {
    ...state, tasks,
    selectedKey: state.selectedKey === null ? null : replaceKey(state.selectedKey),
    order: [...new Set(state.order.map(replaceKey))],
    newKeys: [...new Set(state.newKeys.map(replaceKey))],
    // An old per-action undo must not complete other unfinished requests after consolidation.
    undo: state.undo.filter(entry => !mergedIds.has(entry.before.id) && !mergedIds.has(entry.after.id)),
    work: {
      ...state.work, ranking: ranking ? {
        ...ranking, orderedIds: [...new Set(ranking.orderedIds.map(replaceId))],
        reasons: [...reasons].map(([id, reason]) => ({ id, reason })),
      } : null,
    },
  };
}

/** Completion belongs to the owner; collection can only reopen on unseen, newer actionable evidence. */
export function reconcileWork(state: AppState, collection: WorkCollection, now: string | Date): AppState {
  const batch = workCollectOutputSchema.parse(collection);
  state = consolidateWorkTasks(state);
  const createdAt = timestamp(now);
  const observations = latestObservations(batch.observations);
  const contexts = latestObservations(batch.observations.filter(observation => observation.context));
  const notifications = new Map<string, NonNullable<WorkMetadata['notification']>>();
  for (const item of [...state.tasks.flatMap(task => task.work ? [task.work] : []), ...batch.candidates]) {
    if (!item.notification) continue;
    const source = canonicalSource(item.url);
    if (notificationSource(item.notification) !== source) throw new Error('The notification does not match its task source.');
    const previous = notifications.get(source);
    if (!previous || Date.parse(item.notification.updatedAt) > Date.parse(previous.updatedAt)) {
      notifications.set(source, item.notification);
    }
  }
  const tasks = state.tasks.map(task => task.work
    ? { ...task, work: observe({
      ...task.work, ...(notifications.has(canonicalSource(task.work.url))
        ? { notification: notifications.get(canonicalSource(task.work.url)) } : {}),
    }, observations.get(canonicalSource(task.work.url)), contexts.get(canonicalSource(task.work.url))) } : task);
  for (const candidate of batch.candidates) {
    const identity = taskIdentity(candidate.url, candidate.action);
    const url = canonicalSource(candidate.url);
    const index = tasks.findIndex(task => task.work && taskIdentity(task.work.url, task.work.action) === identity);
    const previous = index < 0 ? undefined : tasks[index];
    const observation = observations.get(url);
    const affirmative = new URL(url).hostname !== 'github.com' && candidate.evidence.some(evidence => evidence.source !== 'github');
    const linked = tasks.find(task => task.work && canonicalSource(task.work.url) === url)?.work;
    const base: WorkMetadata = previous?.work ?? {
      identity, action: candidate.action, url, evidence: [], handledEvidenceIds: [],
      availability: linked?.availability ?? (affirmative ? 'actionable' : 'unknown'),
      availabilityReason: linked?.availabilityReason ?? (affirmative ? 'The source supplied an action.' : 'The source state has not been confirmed.'),
      availabilityObservedAt: linked?.availabilityObservedAt,
      ...(linked?.context ? { context: linked.context } : {}),
      ...(linked?.contextObservedAt ? { contextObservedAt: linked.contextObservedAt } : {}),
      ...(linked?.unsubscribe ? { unsubscribe: linked.unsubscribe } : {}),
    };
    const work = workMetadataSchema.parse(observe({
      ...base, identity, url, evidence: mergeEvidence(base.evidence, candidate.evidence),
      ...(notifications.has(url) ? { notification: notifications.get(url) } : {}),
    }, observation, contexts.get(url)));
    const known = new Set([...base.evidence.map(evidence => evidence.id), ...base.handledEvidenceIds]);
    const reopen = previous?.status === 'done' && previous.completedAt !== undefined
      && work.availability === 'actionable'
      && candidate.evidence.some(evidence => !known.has(evidence.id)
        && Date.parse(evidence.at) > Date.parse(previous.completedAt!));
    const task: Task = previous ? {
      ...previous, work,
      ...(reopen ? { status: 'open' as const } : {}),
    } : {
      id: crypto.randomUUID(), title: candidate.title, notes: '', status: 'open', createdAt, work,
    };
    if (index < 0) tasks.push(task);
    else tasks[index] = task;
  }
  return { ...state, tasks, work: state.work ?? defaultWorkState() };
}

export function completeWorkTask(state: AppState, id: string, now: string | Date): AppState {
  const completedAt = timestamp(now);
  const task = state.tasks.find(task => task.id === id);
  if (!task) throw new Error('This task no longer exists.');
  if (task.status === 'done') return state;
  return {
    ...state,
    tasks: state.tasks.map(task => task.id !== id ? task : {
      ...task, status: 'done', completedAt,
      ...(task.work ? { work: workMetadataSchema.parse({
        ...task.work, handledEvidenceIds: [...new Set([...task.work.handledEvidenceIds, ...task.work.evidence.map(evidence => evidence.id)])],
      }) } : {}),
    }),
  };
}

export function restoreWorkTask(state: AppState, id: string): AppState {
  if (!state.tasks.some(task => task.id === id)) throw new Error('This task no longer exists.');
  return { ...state, tasks: state.tasks.map(task => task.id === id ? { ...task, status: 'open' } : task) };
}

export function rankedTasks(state: AppState): Task[] {
  const positions = new Map((state.work?.ranking?.orderedIds ?? []).map((id, index) => [id, index]));
  return state.tasks.filter(task => task.status === 'open' && task.work?.availability !== 'waiting')
    .sort((left, right) => {
      const a = positions.get(left.id);
      const b = positions.get(right.id);
      if (a !== undefined || b !== undefined) return a === undefined ? 1 : b === undefined ? -1 : a - b;
      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
}

/** Include task notes, source uncertainty and evidence, never private thread notes. */
export function rankInput(state: AppState): WorkRankInput {
  const work = state.work ?? defaultWorkState();
  return workRankInputSchema.parse({
    instructions: work.settings.instructions, model: work.settings.model,
    tasks: rankedTasks(state).map(task => ({
      id: task.id, title: task.title.slice(0, 2000), notes: task.notes.slice(0, 16000), action: task.work?.action ?? 'manual',
      url: task.work?.url ?? null, evidence: task.work?.evidence ?? [], createdAt: task.createdAt,
      availability: task.work?.availability === 'unknown' ? 'unknown' : 'actionable',
      availabilityReason: task.work?.availabilityReason ?? '',
      ...(task.work?.context ? { context: task.work.context } : {}),
    })),
  });
}
