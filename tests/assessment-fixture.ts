import { ASSESSMENT_VERSION, currentSavedAssessmentSchema, identityDigest, type CurrentAssessment } from '../service/src/work-assessment.ts';
import { semanticRankTask } from '../service/src/work-rank-input.ts';
import type { WorkRankInput } from '../service/src/work-schema.ts';
import { agentIdentity, taskAgent } from '../service/src/work-agents.ts';

const fixtureTime = new Date().toISOString();
export const unknownRatings = {
  impact: { rating: 'unknown', rationale: 'Impact is not established by supplied evidence.' },
  visibility: { rating: 'unknown', rationale: 'No audience is established.' },
  effort: { rating: 'unknown', rationale: 'No implementation evidence is supplied.' },
} as const;

export async function assessmentBatch(input: WorkRankInput, evaluatedAt = fixtureTime) {
  const agent = taskAgent(input, 'task-assessment');
  const configurationFingerprint = await identityDigest(agentIdentity(agent));
  const assessments: CurrentAssessment[] = await Promise.all(input.tasks.slice(0, 20).map(async task => {
    const fingerprint = await identityDigest(semanticRankTask(task));
    const instructionsFingerprint = await identityDigest(agent.instructions);
    const key = await identityDigest([fingerprint, configurationFingerprint, input.profileId, evaluatedAt]);
    return currentSavedAssessmentSchema.parse({
      resultId: input.force ? crypto.randomUUID() : `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`,
      id: task.id, profileId: input.profileId ?? 'default', fingerprint, instructionsFingerprint,
      assessmentVersion: ASSESSMENT_VERSION, model: agent.model, evaluatedAt,
      agent: { id: agent.id, name: agent.name, jobType: 'task-assessment', configurationFingerprint },
      assessment: {
        ...unknownRatings,
        importance: `Assessment of ${task.title}`, urgency: 'No deadline established', blockers: 'None established',
        supportingEvidence: [{ reference: '$title', summary: 'The supplied task title' }],
        uncertainty: 'No additional evidence', reevaluateAt: new Date(Date.parse(evaluatedAt) + 86400000).toISOString(),
      },
    });
  }));
  return { assessments };
}
