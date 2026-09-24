import { ASSESSMENT_VERSION, identityDigest, type SavedAssessment } from '../service/src/work-assessment.ts';
import { semanticRankTask } from '../service/src/work-rank-input.ts';
import type { WorkRankInput } from '../service/src/work-schema.ts';

export async function assessmentBatch(input: WorkRankInput, evaluatedAt = '2026-09-24T12:00:00.000Z') {
  const assessments: SavedAssessment[] = await Promise.all(input.tasks.slice(0, 20).map(async task => {
    const fingerprint = await identityDigest(semanticRankTask(task));
    const instructionsFingerprint = await identityDigest(input.instructions);
    const key = await identityDigest([fingerprint, instructionsFingerprint, input.profileId, input.model, evaluatedAt]);
    return {
      resultId: `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`,
      id: task.id, profileId: input.profileId ?? 'default', fingerprint, instructionsFingerprint,
      assessmentVersion: ASSESSMENT_VERSION, model: input.model, evaluatedAt,
      assessment: {
        importance: `Assessment of ${task.title}`, urgency: 'No deadline established', blockers: 'None established',
        supportingEvidence: [{ reference: '$title', summary: 'The supplied task title' }],
        uncertainty: 'No additional evidence', reevaluateAt: new Date(Date.parse(evaluatedAt) + 86400000).toISOString(),
      },
    };
  }));
  return { assessments };
}
