import { z } from 'zod';
import { agentFields } from './work-agents.ts';

export const codeAgentJobs = {
  'implementation-assessment': {
    name: 'Implementation assessor',
    resultFormat: 'code-review-v1',
    capability: 'Inspect an issue and pinned code with list_code/read_code. Recommend a grounded next step; never edit code or mark Done.',
    instructions: 'Inspect relevant code before recommending the next implementation step. Cite exact code evidence. Keep uncertainty and missing context explicit.',
  },
  'pr-review': {
    name: 'PR reviewer',
    resultFormat: 'code-review-v1',
    capability: 'Inspect a PR and pinned code with list_code/read_code. Return grounded findings; never approve or submit a review.',
    instructions: 'Review the changed code and relevant surrounding implementation for meaningful correctness problems. Cite exact changed lines. Selective inspection is not approval.',
  },
} as const;
export type CodeAgentJob = keyof typeof codeAgentJobs;
export const codeAgentSchema = z.strictObject({
  ...agentFields,
  jobType: z.enum(['implementation-assessment', 'pr-review']),
});
export type CodeAgent = z.infer<typeof codeAgentSchema>;
export const codeAgentsSchema = z.array(codeAgentSchema).length(2).refine(agents =>
  new Set(agents.map(agent => agent.id)).size === 2 && new Set(agents.map(agent => agent.jobType)).size === 2,
'Keep exactly one implementation assessor and one PR reviewer with distinct identities.');
export function codeAgents(settings: { codeAgents?: CodeAgent[] }): CodeAgent[] {
  return settings.codeAgents ?? (Object.keys(codeAgentJobs) as CodeAgentJob[]).map(jobType => ({
    id: jobType, jobType, name: codeAgentJobs[jobType].name, instructions: codeAgentJobs[jobType].instructions, model: '',
  }));
}
