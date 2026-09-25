import { z } from 'zod';
import { codeReviewInputSchema, codeReviewResultSchema } from './code-review-schema.ts';

export const codeRunIntentSchema = z.strictObject({
  runId: z.uuid(), profileId: z.string().min(1).max(100),
  agentName: z.string().trim().min(1).max(100),
  startedAt: z.iso.datetime({ offset: true }), input: codeReviewInputSchema,
});
export type CodeRunIntent = z.infer<typeof codeRunIntentSchema>;
const failure = z.strictObject({ code: z.string().min(1).max(100), message: z.string().min(1).max(2000) });
export const codeRunOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('running') }),
  z.strictObject({ status: z.literal('cancelling') }),
  z.strictObject({ status: z.literal('partial'), finishedAt: z.iso.datetime({ offset: true }), result: codeReviewResultSchema }),
  z.strictObject({ status: z.literal('not-inspected'), finishedAt: z.iso.datetime({ offset: true }), result: codeReviewResultSchema }),
  z.strictObject({ status: z.enum(['failed', 'cancelled', 'interrupted']), finishedAt: z.iso.datetime({ offset: true }), error: failure }),
]);
export type CodeRunOutcome = z.infer<typeof codeRunOutcomeSchema>;
export const codeRunSchema = z.strictObject({
  generation: z.uuid(), sequence: z.number().int().positive().safe(), quarantined: z.boolean(),
  intent: codeRunIntentSchema, outcome: codeRunOutcomeSchema,
}).superRefine((run, ctx) => {
  if (!('result' in run.outcome)) return;
  const { input } = run.intent;
  const { result, status } = run.outcome;
  const notInspected = result.answer.job === 'pr-review' && result.answer.conclusion.status === 'not-inspected';
  if ((status === 'not-inspected') !== notInspected || result.taskId !== input.taskId
    || result.answer.job !== input.job || JSON.stringify(result.source.reference) !== JSON.stringify(input.source)
    || result.config.agentId !== input.agent.id || result.config.instructions !== input.agent.instructions
    || result.config.modelRequested !== input.agent.model) {
    ctx.addIssue({ code: 'custom', message: 'The code result does not match its saved run intent.' });
  }
});
export type CodeRun = z.infer<typeof codeRunSchema>;
export const codeRunPageSchema = z.strictObject({
  runs: z.array(codeRunSchema).max(10), before: z.number().int().positive().safe().nullable(),
});
export type CodeRunPage = z.infer<typeof codeRunPageSchema>;
export const codeRunContextSchema = z.strictObject({ generation: z.uuid() });
export function terminalCodeRun(outcome: CodeRunOutcome): boolean {
  return outcome.status !== 'running' && outcome.status !== 'cancelling';
}
