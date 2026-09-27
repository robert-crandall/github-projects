import { z } from 'zod';
import { agentIdentity, taskAgent, type TaskAgent } from './work-agents.ts';

export const workStyleSchema = z.strictObject({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(1000),
});
export const workStylesSchema = z.array(workStyleSchema).max(20).refine(styles =>
  new Set(styles.map(style => style.id)).size === styles.length
    && new Set(styles.map(style => style.name.toLowerCase())).size === styles.length,
'Work styles must have unique names and identities.');
export const workStyleIdsSchema = z.array(workStyleSchema.shape.id).max(20)
  .refine(ids => new Set(ids).size === ids.length, 'Choose each work style only once.');
export type WorkStyle = z.infer<typeof workStyleSchema>;

export function assessmentIdentity(settings: {
  instructions: string; model: string; agents?: TaskAgent[]; workStyles?: WorkStyle[];
}) {
  const identity = agentIdentity(taskAgent(settings, 'task-assessment'));
  return settings.workStyles?.length ? { ...identity, workStyles: settings.workStyles } : identity;
}
