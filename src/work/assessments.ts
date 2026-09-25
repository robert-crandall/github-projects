import { ASSESSMENT_VERSION, type SavedAssessment } from '../../service/src/work-assessment.ts';

export function assessmentFreshness(value: SavedAssessment, current: {
  fingerprint: string; instructionsFingerprint: string; profileId: string; model: string;
  configurationFingerprint: string;
}, now: number): string {
  if (value.profileId !== current.profileId || value.fingerprint !== current.fingerprint) return 'Outdated: task content changed';
  if (value.instructionsFingerprint !== current.instructionsFingerprint || value.model !== current.model
    || value.assessmentVersion !== ASSESSMENT_VERSION
    || value.agent.configurationFingerprint !== current.configurationFingerprint) return 'Outdated: assessment settings changed';
  if (Date.parse(value.evaluatedAt) > now) return 'Freshness unknown: clock moved backwards';
  if (Date.parse(value.assessment.reevaluateAt) <= now) return 'Expired: reassessment due';
  return 'Current for saved task content';
}
