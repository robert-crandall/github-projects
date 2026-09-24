import { ASSESSMENT_VERSION, type SavedAssessment } from '../../service/src/work-assessment.ts';
import type { AppState, Task } from '../types.ts';

export function mergeAssessments(previous: SavedAssessment[], incoming: SavedAssessment[]): SavedAssessment[] {
  const versions = new Map(previous.map(value => [value.resultId, value]));
  for (const value of incoming) {
    const existing = versions.get(value.resultId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error('An assessment version changed unexpectedly. The saved history is retained.');
    }
    versions.set(value.resultId, value);
  }
  return [...versions.values()].sort((a, b) => Date.parse(a.evaluatedAt) - Date.parse(b.evaluatedAt)
    || a.resultId.localeCompare(b.resultId));
}

export function attachAssessments(state: AppState, profileId: string, values: SavedAssessment[]): AppState {
  if (values.some(value => value.profileId !== profileId)) throw new Error('The assessment belongs to a different work profile.');
  const attach = (tasks: Task[]) => {
    if (values.some(value => !tasks.some(task => task.id === value.id))) {
      throw new Error('An assessed task no longer exists. The previous order is retained.');
    }
    return tasks.map(task => {
      const incoming = values.filter(value => value.id === task.id);
      return incoming.length ? { ...task, assessments: mergeAssessments(task.assessments ?? [], incoming) } : task;
    });
  };
  if (state.activeWorkProfile.id === profileId) return { ...state, tasks: attach(state.tasks) };
  if (!state.inactiveWorkProfiles.some(profile => profile.id === profileId)) {
    throw new Error('The assessed work profile no longer exists. The previous order is retained.');
  }
  return {
    ...state, inactiveWorkProfiles: state.inactiveWorkProfiles.map(profile => profile.id === profileId
      ? { ...profile, tasks: attach(profile.tasks) } : profile),
  };
}

export function assessmentFreshness(value: SavedAssessment, current: {
  fingerprint: string; instructionsFingerprint: string; profileId: string; model: string;
}, now: number): string {
  if (value.profileId !== current.profileId || value.fingerprint !== current.fingerprint) return 'Outdated: task content changed';
  if (value.instructionsFingerprint !== current.instructionsFingerprint || value.model !== current.model
    || value.assessmentVersion !== ASSESSMENT_VERSION) return 'Outdated: assessment settings changed';
  if (Date.parse(value.evaluatedAt) > now) return 'Freshness unknown: clock moved backwards';
  if (Date.parse(value.assessment.reevaluateAt) <= now) return 'Expired: reassessment due';
  return 'Current for saved task content';
}
