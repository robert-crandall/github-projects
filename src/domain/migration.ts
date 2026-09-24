import { defaultWorkProfile, legacyStateSchema, stateSchema, threadSchema, type AppState } from '../types.ts';
import { archiveBoundary } from './archive.ts';
import { pendingEvidence } from './engine.ts';
import { defaultWorkState } from '../../service/src/work-schema.ts';
import { validateWorkProfiles } from '../work/profiles.ts';

export function migrateWorkspace(value: unknown): AppState {
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 3) {
    return validateWorkspace(stateSchema.parse(value));
  }
  const legacy = legacyStateSchema.parse(value);
  const { actions, activeId: _activeId, view, undo: _undo, failures, ...common } = legacy;
  const ids = new Set(actions.map(action => action.id));
  if (ids.size !== actions.length || (legacy.activeId !== null && !ids.has(legacy.activeId))
    || actions.some(action => {
      const thread = legacy.threads.find(thread => thread.id === action.threadId);
      return action.threadId ? !thread || (legacy.runtime === 'desktop' && action.eventIds.some(id => !thread.events.some(event => event.id === id)))
        : legacy.runtime === 'desktop' && action.eventIds.length > 0;
    })) {
    throw new Error('Saved work has inconsistent references. Export it before explicit recovery.');
  }
  const tasks: AppState['tasks'] = [];
  const notes: AppState['notes'] = [];
  for (const action of actions) {
    const { title, notes: text, ...history } = action;
    const capturedTask = action.origin === 'capture' || action.captures.length > 0;
    if (action.threadId) {
      notes.push({
        id: action.id, threadId: action.threadId, text, sourceTitle: title,
        ...(!capturedTask ? { history } : {}),
      });
    }
    if (!action.threadId || capturedTask) {
      tasks.push({
        id: action.id, title, notes: action.threadId ? '' : text,
        status: action.status === 'done' || action.status === 'removed' ? 'done' : 'open',
        createdAt: action.createdAt, completedAt: action.completedAt, history, threadId: action.threadId,
      });
    }
  }
  const selectedTask = legacy.selectedKey?.startsWith('a:')
    ? tasks.find(task => task.id === legacy.selectedKey!.slice(2)) : undefined;
  const selectedAction = legacy.selectedKey?.startsWith('a:')
    ? actions.find(action => action.id === legacy.selectedKey!.slice(2)) : undefined;
  const selectedKey = selectedTask ? `a:${selectedTask.id}` : selectedAction?.threadId
    ? `t:${selectedAction.threadId}` : legacy.selectedKey;
  return validateWorkspace({
    ...common, version: 3, tasks, notes, selectedKey, work: defaultWorkState(),
    activeWorkProfile: defaultWorkProfile(), inactiveWorkProfiles: [],
    view: selectedKey ? selectedTask ? 'tasks' : 'inbox' : view === 'attention' ? 'inbox' : 'tasks',
    failures: { refresh: failures.refresh, storage: failures.storage, external: failures.external },
    undo: [],
  });
}

export function validateWorkspace(state: AppState): AppState {
  validateWorkProfiles(state);
  const threads = new Set(state.threads.map(thread => thread.id));
  const tasks = new Set(state.tasks.map(task => task.id));
  const notes = new Set(state.notes.map(note => note.id));
  if (threads.size !== state.threads.length || tasks.size !== state.tasks.length || notes.size !== state.notes.length
    || state.notes.some(note => !threads.has(note.threadId))
    || state.tasks.some(task => task.threadId && !threads.has(task.threadId))
    || state.threads.some(thread => thread.events.some(event => event.threadId !== thread.id))
    || state.operations.some(operation => !threads.has(operation.threadId))
    || (state.selectedKey !== null && !(state.selectedKey.startsWith('t:') ? threads.has(state.selectedKey.slice(2))
      : state.selectedKey.startsWith('a:') && tasks.has(state.selectedKey.slice(2))))) {
    throw new Error('Saved work has inconsistent references. Export it before explicit recovery.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone }); }
  catch { throw new Error(`The saved workspace has an invalid timezone: ${state.timeZone}. Your saved copy has not been replaced.`); }
  for (const thread of state.threads) {
    if (thread.archive !== undefined) continue;
    const updatedAt = threadSchema.shape.notificationUpdatedAt.safeParse(thread.sourceMetadata?.updatedAt);
    if (!thread.notificationUpdatedAt && updatedAt.success && updatedAt.data) {
      thread.notificationUpdatedAt = updatedAt.data;
    }
    thread.archive = pendingEvidence(state, thread).length ? null : archiveBoundary(thread, state.clock);
  }
  return state;
}
