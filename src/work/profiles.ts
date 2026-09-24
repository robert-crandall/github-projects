import { defaultWorkState } from '../../service/src/work-schema.ts';
import { workProfileIdentitySchema, type AppState } from '../types.ts';

export function workProfiles(state: AppState) {
  return [state.activeWorkProfile, ...state.inactiveWorkProfiles.map(({ id, name }) => ({ id, name }))]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function validateWorkProfiles(state: AppState): void {
  const profiles = workProfiles(state);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length
    || new Set(profiles.map(profile => profile.name.toLowerCase())).size !== profiles.length) {
    throw new Error('Work profile names and identities must be unique.');
  }
  const threads = new Set(state.threads.map(thread => thread.id));
  const tasks = [...state.tasks, ...state.inactiveWorkProfiles.flatMap(profile => profile.tasks)];
  if (new Set(tasks.map(task => task.id)).size !== tasks.length
    || tasks.some(task => task.threadId && !threads.has(task.threadId))) {
    throw new Error('Saved work profiles have inconsistent task references. Export them before explicit recovery.');
  }
  for (const profile of [{ ...state.activeWorkProfile, tasks: state.tasks }, ...state.inactiveWorkProfiles]) {
    if (profile.tasks.some(task => task.assessments?.some(value => value.profileId !== profile.id)
      || new Set(task.assessments?.map(value => value.resultId)).size !== (task.assessments?.length ?? 0))) {
      throw new Error('Saved assessments have inconsistent profile or version identities. Export them before explicit recovery.');
    }
  }
}

export function renameWorkProfile(state: AppState, name: string): AppState {
  const identity = workProfileIdentitySchema.parse({ ...state.activeWorkProfile, name });
  const next = { ...state, activeWorkProfile: identity };
  validateWorkProfiles(next);
  return next;
}

export function switchWorkProfile(state: AppState, id: string): AppState {
  if (id === state.activeWorkProfile.id) return state;
  const target = state.inactiveWorkProfiles.find(profile => profile.id === id);
  if (!target) throw new Error('This work profile no longer exists.');
  // Keep the active queue in its existing storage slots; only parked profiles hold snapshots.
  const next: AppState = {
    ...state,
    activeWorkProfile: { id: target.id, name: target.name },
    tasks: target.tasks, work: target.work, undo: target.undo,
    inactiveWorkProfiles: [
      ...state.inactiveWorkProfiles.filter(profile => profile.id !== id),
      { ...state.activeWorkProfile, tasks: state.tasks, work: state.work, undo: state.undo },
    ],
    selectedKey: state.selectedKey?.startsWith('a:') ? null : state.selectedKey,
    order: state.order.filter(key => !key.startsWith('a:')),
    newKeys: state.newKeys.filter(key => !key.startsWith('a:')),
  };
  validateWorkProfiles(next);
  return next;
}

export function createWorkProfile(state: AppState, name: string, copySettings = false): AppState {
  const identity = workProfileIdentitySchema.parse({ id: crypto.randomUUID(), name });
  const work = defaultWorkState();
  work.settings = copySettings
    ? structuredClone(state.work.settings)
    : { ...work.settings, streams: [] };
  work.settings.schedule.enabled = false;
  const next = {
    ...state,
    inactiveWorkProfiles: [...state.inactiveWorkProfiles, { ...identity, tasks: [], work, undo: [] }],
  };
  validateWorkProfiles(next);
  return switchWorkProfile(next, identity.id);
}
