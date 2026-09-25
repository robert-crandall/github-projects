import { expect, test } from 'bun:test';
import { taskAgents, taskAgentJobs } from '../src/work-agents.ts';
import { defaultWorkState, workSettingsSchema } from '../src/work-schema.ts';
import { requestSchema } from '../src/schema.ts';

test('legacy owner rules and model materialize in both roles without replacing source or schedule settings', () => {
  const settings = { ...defaultWorkState().settings, instructions: 'My exact owner rules', model: 'my-model' };
  delete settings.agents;
  delete settings.codeAgents;
  settings.schedule.enabled = true;
  const parsed = workSettingsSchema.parse(settings);
  expect(parsed).toMatchObject(settings);
  expect(parsed.agents).toEqual([
    { id: 'task-assessment', jobType: 'task-assessment', name: 'Task assessor', instructions: settings.instructions, model: settings.model },
    { id: 'task-prioritization', jobType: 'task-prioritization', name: 'Task prioritizer', instructions: settings.instructions, model: settings.model },
  ]);
  expect(workSettingsSchema.parse(parsed)).toEqual(parsed);
  const defaults = taskAgents(defaultWorkState().settings);
  expect(defaults[0]!.instructions).toBe(taskAgentJobs['task-assessment'].instructions);
  expect(defaults[1]!.instructions).toBe(taskAgentJobs['task-prioritization'].instructions);
});

test('agent definitions cannot add capabilities, tools, arbitrary roles or ambiguous duplicate roles', () => {
  const settings = defaultWorkState().settings;
  const agents = taskAgents(settings);
  for (const invalid of [
    [{ ...agents[0], tools: ['bash'] }, agents[1]],
    [{ ...agents[0], jobType: 'arbitrary-prompt' }, agents[1]],
    [agents[0], { ...agents[1], jobType: 'task-assessment' }],
    [agents[0], { ...agents[1], id: agents[0]!.id }],
    [agents[0]],
    [...agents, { ...agents[0], id: 'third' }],
  ]) {
    expect(workSettingsSchema.safeParse({ ...settings, agents: invalid }).success).toBe(false);
    expect(requestSchema.safeParse({
      v: 1, id: 'invalid-role', op: 'work.assess',
      input: { profileId: 'default', instructions: '', model: '', tasks: [], agents: invalid },
    }).success).toBe(false);
  }
});
