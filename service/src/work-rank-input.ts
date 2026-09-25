import type { WorkRankInput } from './work-schema.ts';

/** Only semantic inputs belong in assessment keys or in-flight comparison. */
export function semanticRankTask(task: WorkRankInput['tasks'][number]) {
  const evidence = task.evidence.map(({ streamId: _, ...event }) => ({
    ...event, at: new Date(event.at).toISOString(),
  }));
  const canonical = new Map(evidence.map(event => [JSON.stringify([
    event.id, event.source, event.at, event.url, event.summary,
  ]), event]));
  return {
    id: task.id, title: task.title, notes: task.notes, action: task.action,
    url: task.url, createdAt: new Date(task.createdAt).toISOString(),
    availability: task.availability ?? (task.url ? 'unknown' : 'actionable'),
    availabilityReason: task.availabilityReason ?? '',
    context: task.context ? {
      revision: task.context.revision,
      title: task.context.title, body: task.context.body, labels: [...new Set(task.context.labels)].sort(),
    } : null,
    evidence: [...canonical].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, event]) => ({
      id: event.id, source: event.source, at: event.at, url: event.url, summary: event.summary,
    })),
  };
}

export type SemanticRankTask = ReturnType<typeof semanticRankTask>;

export function orderingRankTask(task: WorkRankInput['tasks'][number]) {
  const { observedAt: _, ...pullRequest } = task.pullRequest ?? {};
  return {
    ...semanticRankTask(task), pullRequest: task.pullRequest ? pullRequest : null,
    assessmentInputFingerprint: task.assessmentInputFingerprint ?? null,
  };
}
