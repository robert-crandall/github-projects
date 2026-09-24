import { ASSESSMENT_VERSION, type SavedAssessment, type TaskAssessment } from '../../service/src/work-assessment.ts';

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
