import { z } from 'zod';

export const taskAgentJobs = {
  'task-assessment': {
    name: 'Task assessor',
    capability: 'Assess supplied task evidence. No tools or source collection.',
    resultFormat: 'work-assessment-v3',
    instructions: 'Assess each task independently. Explain impact, visibility and effort from evidence; use unknown when evidence is missing. Preserve uncertainty.',
  },
  'task-prioritization': {
    name: 'Task prioritizer',
    capability: 'Order the whole eligible list from saved assessments. No tools or reassessment.',
    resultFormat: 'work-order-v1',
    instructions: 'Order all eligible tasks by their saved assessments. Prefer concrete urgent requests and due commitments. Explain uncertainty instead of inventing facts.',
  },
} as const;

export type TaskAgentJob = keyof typeof taskAgentJobs;
const jobTypes = Object.keys(taskAgentJobs) as [TaskAgentJob, ...TaskAgentJob[]];
export const taskAgentSchema = z.strictObject({
  id: z.string().min(1).max(100),
  jobType: z.enum(jobTypes),
  name: z.string().trim().min(1).max(100),
  instructions: z.string().max(16000),
  model: z.string().max(100),
});
export type TaskAgent = z.infer<typeof taskAgentSchema>;
export const taskAgentsSchema = z.array(taskAgentSchema).length(jobTypes.length).refine(agents =>
  new Set(agents.map(agent => agent.id)).size === agents.length
    && new Set(agents.map(agent => agent.jobType)).size === agents.length,
'Keep exactly one assessor and one prioritizer with distinct identities.');

type AgentSettings = { instructions: string; model: string; agents?: TaskAgent[] };

/** Old profiles retain their owner rules in both roles until explicitly edited. */
export function taskAgents(settings: AgentSettings): TaskAgent[] {
  return settings.agents ?? (Object.entries(taskAgentJobs) as [TaskAgentJob, typeof taskAgentJobs[TaskAgentJob]][])
    .map(([jobType, job]) => ({
      id: jobType, jobType, name: job.name, model: settings.model,
      instructions: settings.instructions || job.instructions,
    }));
}

export function taskAgent(settings: AgentSettings, jobType: TaskAgentJob): TaskAgent {
  const agent = taskAgents(settings).find(agent => agent.jobType === jobType);
  if (!agent) throw new Error(`No agent configured for ${jobType}.`);
  return agent;
}

export function agentIdentity(agent: TaskAgent) {
  return { id: agent.id, jobType: agent.jobType, instructions: agent.instructions, model: agent.model };
}
