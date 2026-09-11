import { z } from 'zod';
import { stateSchema, type AppState } from './types.ts';

export const STORAGE_KEY = 'github-projects:greenfield-prototype:v1';
export const savedSchema = z.object({
  state: stateSchema,
  scroll: z.record(z.string(), z.number().nonnegative()),
});
export type SavedWorkspace = z.infer<typeof savedSchema>;
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function decodeWorkspace(text: string): SavedWorkspace {
  const parsed = savedSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('The saved prototype has an unsupported or damaged format. Export it before starting a fresh copy.');
  const { state } = parsed.data;
  const actionIds = new Set(state.actions.map(action => action.id));
  const threadIds = new Set(state.threads.map(thread => thread.id));
  if (actionIds.size !== state.actions.length || threadIds.size !== state.threads.length
    || (state.activeId !== null && !actionIds.has(state.activeId))
    || state.actions.some(action => action.threadId && !threadIds.has(action.threadId))) {
    throw new Error('The saved prototype contains inconsistent work references. Your saved copy has not been replaced.');
  }
  for (const zone of [state.timeZone, ...state.actions.flatMap(action => action.routine ? [action.routine.timeZone] : [])]) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
    catch { throw new Error(`The saved prototype has an invalid timezone: ${zone}. Your saved copy has not been replaced.`); }
  }
  return parsed.data;
}

export function saveWorkspace(storage: WorkspaceStorage, saved: SavedWorkspace, expected: string | null): string {
  if (storage.getItem(STORAGE_KEY) !== expected) {
    throw new Error('Another tab changed this workspace. Export your pending copy or back up the other copy before replacing it.');
  }
  if (saved.state.failures.storage) throw new Error('Simulated storage failure. Your changes are in memory, not saved. Retry to save them.');
  const serialized = JSON.stringify(saved);
  storage.setItem(STORAGE_KEY, serialized);
  return serialized;
}

export function replaceWithBackup(storage: WorkspaceStorage, saved: SavedWorkspace): string {
  const previous = storage.getItem(STORAGE_KEY);
  if (previous !== null) storage.setItem(`${STORAGE_KEY}:recovery:${Date.now()}`, previous);
  return saveWorkspace(storage, saved, previous);
}

export function downloadBackup(value: string, name = 'github-projects-prototype.json'): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withStorageEnabled(state: AppState): AppState {
  return { ...state, failures: { ...state.failures, storage: false } };
}
