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
  return workMetadataSchema.shape.identity.parse(`${action}:${canonicalSource(url)}`);
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

function observe(work: WorkMetadata, observation?: WorkObservation): WorkMetadata {
  if (!observation || (work.availabilityObservedAt
    && Date.parse(observation.observedAt) < Date.parse(work.availabilityObservedAt))) return work;
  return {
    ...work,
    availability: observation.state === 'open' ? 'actionable' : observation.state === 'unknown' ? 'unknown' : 'waiting',
    availabilityReason: observation.reason || (observation.state === 'open' ? 'The source is open.'
      : observation.state === 'unknown' ? 'The source state could not be confirmed.' : `The source is ${observation.state}.`),
    availabilityObservedAt: observation.observedAt,
  };
}

function notificationSource(notification: NonNullable<WorkMetadata['notification']>): string {
  return canonicalSource(`https://github.com/${notification.reference.repo}/issues/${notification.reference.number}`);
}

/** Completion belongs to the owner; collection can only reopen on unseen, newer actionable evidence. */
export function reconcileWork(state: AppState, collection: WorkCollection, now: string | Date): AppState {
  const batch = workCollectOutputSchema.parse(collection);
  const createdAt = timestamp(now);
  const observations = latestObservations(batch.observations);
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
    }, observations.get(canonicalSource(task.work.url))) } : task);
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
      ...(linked?.unsubscribe ? { unsubscribe: linked.unsubscribe } : {}),
    };
    const work = workMetadataSchema.parse(observe({
      ...base, identity, url, evidence: mergeEvidence(base.evidence, candidate.evidence),
      ...(notifications.has(url) ? { notification: notifications.get(url) } : {}),
    }, observation));
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

function rankingNotes(task: Task): string {
  const uncertainty = task.work?.availability === 'unknown'
    ? `Source availability: unknown. ${task.work.availabilityReason || 'The source state could not be confirmed.'}\n\nTask notes:\n` : '';
  return uncertainty + task.notes.slice(0, 16000 - uncertainty.length);
}

/** Include task notes, source uncertainty and evidence, never private thread notes. */
export function rankInput(state: AppState): WorkRankInput {
  const work = state.work ?? defaultWorkState();
  return workRankInputSchema.parse({
    instructions: work.settings.instructions, model: work.settings.model,
    tasks: rankedTasks(state).map(task => ({
      id: task.id, title: task.title.slice(0, 2000), notes: rankingNotes(task), action: task.work?.action ?? 'manual',
      url: task.work?.url ?? null, evidence: task.work?.evidence ?? [], createdAt: task.createdAt,
    })),
  });
}
