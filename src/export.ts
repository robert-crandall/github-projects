import { createDesktopState, mergeGitHubSnapshot } from './domain/live.ts';
import { applyCommand } from './domain/engine.ts';
import type { AppState } from './domain/types.ts';

export function prepareWorkspaceImport(current: AppState, backup: AppState): AppState {
  const hasLocalWork = current.draft || current.activeId || current.captures.length || current.projects.length || current.undo.length
    || current.items.some(item => item.status !== 'available' || item.notes || item.steps.length || item.startedAt
      || item.completedAt || item.projectId || item.availableAt || item.reason || item.routine
      || !item.sources.length || item.sources.some(source => source.kind !== 'github'));
  if (hasLocalWork) throw new Error('Import requires a workspace without local captures, edits, or progress. Existing work was not changed.');
  if (backup.items.some(item => item.sources.some(source => source.reference?.startsWith('demo://')))) {
    throw new Error('This backup contains synthetic work. Export captures only from the browser prototype first.');
  }
  const next = applyCommand({ ...backup, runtime: 'desktop', sync: createDesktopState().sync },
    { type: 'advance', to: new Date().toISOString() });
  if (current.items.length) {
    if (!current.sync.login) throw new Error('The existing GitHub snapshot has no account identity. Refresh GitHub before importing.');
    mergeGitHubSnapshot(next, {
      fetchedAt: current.sync.lastSuccessAt, login: current.sync.login,
      items: current.items.filter(item => item.signalCurrent !== false),
      warnings: current.sync.warnings ?? [],
    });
    next.sync = structuredClone(current.sync);
  }
  return next;
}

export function capturesBackup(state: AppState): AppState {
  const next = createDesktopState();
  const itemIds = new Map<string, string>();
  for (const capture of state.captures) {
    const original = state.items.find(item => item.id === capture.itemId);
    if (!original) throw new Error('A capture has no associated work item. Export was stopped.');
    let itemId = itemIds.get(original.id);
    if (!itemId) {
      itemId = `capture-${capture.id}`;
      itemIds.set(original.id, itemId);
      next.items.push({
        id: itemId, title: capture.original.trim(), kind: 'task', status: 'available',
        createdAt: capture.createdAt, updatedAt: next.clock,
        sources: [], notes: original.notes, steps: [], nextStep: 'Choose a concrete next step.',
      });
    }
    next.items.find(item => item.id === itemId)!.sources.push({ id: capture.id, kind: 'capture', label: 'Imported capture' });
    next.captures.push({ ...capture, itemId, interpretation: 'pending', explanation: undefined });
  }
  next.draft = state.draft;
  return next;
}

export function downloadCaptures(state: AppState): void {
  const content = JSON.stringify(capturesBackup(state), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'github-projects-captures.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
