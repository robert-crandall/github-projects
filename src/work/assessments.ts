import { ASSESSMENT_VERSION, type SavedAssessment, type TaskAssessment } from '../../service/src/work-assessment.ts';
import type { AppState, Task } from '../types.ts';

export function mergeAssessments(previous: TaskAssessment[], incoming: TaskAssessment[]): TaskAssessment[] {
  const versions = new Map(previous.map(value => [value.resultId, value]));
  for (const value of incoming) {
    const existing = versions.get(value.resultId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error('An assessment version changed unexpectedly. The saved history is retained.');
    }
    versions.set(value.resultId, value);
  }
  // Old unsequenced snapshots retain their recorded order; wall time never establishes recency.
  return [...versions.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function attachAssessments(state: AppState, profileId: string, values: SavedAssessment[]): AppState {
  if (values.some(value => value.profileId !== profileId)) throw new Error('The assessment belongs to a different work profile.');
  const attach = (tasks: Task[]) => {
    if (values.some(value => !tasks.some(task => task.id === value.id))) {
      throw new Error('An assessed task no longer exists. The previous order is retained.');
    }
    let sequence = tasks.reduce((max, task) =>
      (task.assessments ?? []).reduce((max, value) => Math.max(max, value.sequence ?? 0), max), 0);
    return tasks.map(task => {
      const incoming = values.filter(value => value.id === task.id).map(value => {
        const existing = task.assessments?.find(saved => saved.resultId === value.resultId);
        if (existing) return { ...value, ...(existing.sequence === undefined ? {} : { sequence: existing.sequence }) };
        if (sequence === Number.MAX_SAFE_INTEGER) throw new Error('The assessment sequence limit was reached. Export history before recovery.');
        return { ...value, sequence: ++sequence };
      });
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
