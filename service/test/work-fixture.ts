import type { CopilotService } from '../src/copilot.ts';
import type { WorkRankInput } from '../src/work-schema.ts';

/** Exercise the same explicit assess-before-order contract as the workspace. */
export async function rankWithAssessments(sdk: CopilotService, input: WorkRankInput, signal: AbortSignal) {
  let pending = input.tasks;
  const assessmentIds: string[] = [];
  const assessments: NonNullable<WorkRankInput['assessments']> = [];
  while (pending.length) {
    const batch = await sdk.assessWork({ ...input, tasks: pending }, signal);
    assessmentIds.push(...batch.assessments.map(value => value.resultId));
    assessments.push(...batch.assessments.map(result => ({ taskId: result.id, result })));
    const ids = new Set(batch.assessments.map(value => value.id));
    pending = pending.filter(task => !ids.has(task.id));
  }
  return sdk.rankWork({ ...input, assessmentIds, assessments }, signal);
}
