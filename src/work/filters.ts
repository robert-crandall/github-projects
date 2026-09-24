import type { WorkEvidence, WorkSettings } from '../../service/src/work-schema.ts';
import type { Task } from '../types.ts';

export const sourceProviders = ['github', 'slack', 'mcp'] as const;
export type SourceProvider = typeof sourceProviders[number];
export const providerNames = { github: 'GitHub', slack: 'Slack', mcp: 'MCP' };
export type TaskSource = { id: string; name: string; provider?: SourceProvider; detail?: string };

const streamKey = (provider: SourceProvider, id: string) => JSON.stringify([provider, id]);
function evidenceKey(evidence: WorkEvidence): string {
  if (evidence.source === 'manual') return 'manual';
  if (evidence.source === 'copilot' || (evidence.source === 'mcp' && evidence.streamId === 'push:mcp')) return 'intake';
  return streamKey(evidence.source, evidence.streamId);
}

export function taskSourceIds(task: Task): string[] {
  if (!task.work) return ['manual'];
  const ids = [...new Set(task.work.evidence.map(evidenceKey))];
  return ids.length ? ids : ['unattributed'];
}

export function taskSources(settings: WorkSettings, tasks: Task[]): TaskSource[] {
  const sources = new Map<string, TaskSource>();
  for (const stream of settings.streams) {
    const provider = stream.kind === 'github-notifications' ? 'github' : stream.kind;
    const id = streamKey(provider, stream.id);
    sources.set(id, { id, provider, name: stream.name, ...(!stream.enabled ? { detail: 'Collection disabled' } : {}) });
  }
  for (const task of tasks) {
    for (const evidence of task.work?.evidence ?? []) {
      const id = evidenceKey(evidence);
      if (sources.has(id) || evidence.source === 'manual' || evidence.source === 'copilot' || id === 'intake') continue;
      sources.set(id, { id, provider: evidence.source, name: evidence.streamId, detail: 'Source no longer configured' });
    }
  }
  sources.set('manual', { id: 'manual', name: 'Manual tasks' });
  sources.set('intake', { id: 'intake', name: 'External-agent intake' });
  if (tasks.some(task => task.work && !task.work.evidence.length)) {
    sources.set('unattributed', { id: 'unattributed', name: 'Other saved tasks', detail: 'No source evidence saved' });
  }
  return [...sources.values()];
}

export function matchesSources(task: Task, selected: readonly string[] | null): boolean {
  return selected === null || taskSourceIds(task).some(id => selected.includes(id));
}

export function sourceCounts(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const id of taskSourceIds(task)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
