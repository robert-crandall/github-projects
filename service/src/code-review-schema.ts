import { z } from 'zod';
import { idSchema, referenceSchema, repoSchema } from './references.ts';

export const CODE_LIMITS = {
  requests: 40, toolCalls: 24, responseBytes: 2_097_152, readBytes: 8_388_608,
  contextBytes: 180_000, fileBytes: 131_072, lines: 200, treeEntries: 4000,
  changedFiles: 100, patchBytes: 60_000, sourceBytes: 32_000, milliseconds: 180_000,
} as const;
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const codePathSchema = z.string().min(1).max(1024).refine(path =>
  !/[\x00-\x1f\x7f\\%?#:]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
'Use a literal repository-relative path.');

export const codeReviewInputSchema = z.strictObject({
  taskId: idSchema, source: referenceSchema,
  job: z.enum(['implementation-assessment', 'pr-review']),
  agent: z.strictObject({
    id: z.string().min(1).max(100), instructions: z.string().max(16000), model: z.string().max(100),
  }),
}).refine(input => input.source.kind === (input.job === 'pr-review' ? 'pr' : 'issue'));
export type CodeReviewInput = z.infer<typeof codeReviewInputSchema>;
const prose = z.string().trim().min(1).max(2000);
const codeCitationSchema = z.strictObject({
  kind: z.literal('code'), readId: z.string().regex(/^read-[1-9]\d?$/),
  side: z.enum(['head', 'base']), path: codePathSchema,
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  quote: z.string().min(1).max(4000),
});
const sourceCitationSchema = z.strictObject({ kind: z.literal('source'), quote: z.string().min(1).max(4000) });
const citationSchema = z.discriminatedUnion('kind', [sourceCitationSchema, codeCitationSchema]);
const citations = z.array(citationSchema).min(1).max(8);
const finding = {
  title: z.string().trim().min(1).max(240), severity: z.enum(['low', 'medium', 'high', 'critical']), rationale: prose,
};
export const codeAnswerSchema = z.discriminatedUnion('job', [
  z.strictObject({
    job: z.literal('implementation-assessment'), summary: prose, uncertainty: prose,
    findings: z.array(z.strictObject({ ...finding, evidence: citations })).max(20),
    nextStep: z.strictObject({ text: prose, evidence: citations }),
  }),
  z.strictObject({
    job: z.literal('pr-review'), summary: prose, uncertainty: prose,
    findings: z.array(z.strictObject({ ...finding, location: codeCitationSchema, evidence: citations })).max(20),
  }),
]);
export type CodeAnswer = z.infer<typeof codeAnswerSchema>;
export const prScopeNotices = {
  'not-inspected': 'No source-code lines were inspected. No code review or approval was completed.',
  'partial-no-approval': 'Partial code inspection only. This is not an approval to merge.',
} as const;
const prConclusionSchema = z.strictObject({
  status: z.enum(['not-inspected', 'partial-no-approval']),
  summary: z.enum([prScopeNotices['not-inspected'], prScopeNotices['partial-no-approval']]),
}).refine(conclusion => conclusion.summary === prScopeNotices[conclusion.status]);
const resultAnswerSchema = z.discriminatedUnion('job', [
  codeAnswerSchema.options[0],
  z.strictObject({
    job: z.literal('pr-review'), conclusion: prConclusionSchema,
    findings: codeAnswerSchema.options[1].shape.findings,
  }),
]);
const revisionSchema = z.strictObject({ repo: repoSchema, sha: shaSchema, tree: shaSchema });
const evidenceSchema = z.strictObject({
  id: z.string(), side: z.enum(['head', 'base']), repo: repoSchema, revision: shaSchema, blob: shaSchema,
  path: codePathSchema, startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(), text: z.string(),
});
export const codeReviewResultSchema = z.strictObject({
  format: z.literal('code-review-v1'), taskId: idSchema, answer: resultAnswerSchema,
  source: z.strictObject({
    reference: referenceSchema, url: z.string(), title: z.string(), body: z.string(),
    updatedAt: z.iso.datetime(), state: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.iso.datetime(), head: revisionSchema, base: revisionSchema.nullable(), baseTip: shaSchema.nullable(),
    defaultBranch: z.string().nullable(), draft: z.boolean().nullable(), merged: z.boolean().nullable(),
  }),
  verifiedAt: z.iso.datetime(),
  config: z.strictObject({
    agentId: z.string(), instructions: z.string(), modelRequested: z.string(),
    modelSelection: z.enum(['explicit', 'sdk-default']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  coverage: z.strictObject({
    status: z.literal('partial'), changes: z.enum(['complete', 'partial', 'not-applicable']),
    knownChangedLines: z.number().int().nonnegative(), reviewedChangedLines: z.number().int().nonnegative(),
    files: z.strictObject({
      expected: z.number().int().nonnegative().nullable(), compared: z.number().int().min(0).max(300),
      retained: z.number().int().min(0).max(CODE_LIMITS.changedFiles),
      omitted: z.number().int().nonnegative(), incompletePatches: z.number().int().nonnegative(),
    }),
    warnings: z.array(z.string()), requests: z.number().int().max(CODE_LIMITS.requests),
    readBytes: z.number().int().max(CODE_LIMITS.readBytes), contextBytes: z.number().int().max(CODE_LIMITS.contextBytes),
    toolCalls: z.number().int().max(CODE_LIMITS.toolCalls),
  }),
  evidence: z.array(evidenceSchema).max(CODE_LIMITS.toolCalls),
  changes: z.array(z.strictObject({
    filename: z.string(), previous_filename: z.string().optional(), status: z.string(),
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
    patch: z.string().optional(), patchComplete: z.boolean(),
  })).max(CODE_LIMITS.changedFiles),
}).refine(result => result.answer.job === (result.source.reference.kind === 'pr' ? 'pr-review' : 'implementation-assessment'))
  .refine(result => result.answer.job !== 'pr-review'
    || result.answer.conclusion.status === (result.evidence.length ? 'partial-no-approval' : 'not-inspected'));
export type CodeReviewResult = z.infer<typeof codeReviewResultSchema>;
export type CodeCitation = z.infer<typeof citationSchema>;
