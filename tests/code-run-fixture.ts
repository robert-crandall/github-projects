import { createHash } from 'node:crypto';
import { codeReviewResultSchema, type CodeReviewInput } from '../service/src/code-review-schema.ts';

export function codeResult(input: CodeReviewInput, inspected = true) {
  const at = '2026-09-25T01:00:00Z';
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
  const text = 'const value = input;';
  const citation = { kind: 'code', readId: 'read-1', side: 'head', path: 'src/value.ts', startLine: 1, endLine: 1, quote: text };
  return codeReviewResultSchema.parse({
    format: 'code-review-v1', taskId: input.taskId,
    answer: input.job === 'pr-review' ? {
      job: input.job, findings: [], conclusion: inspected
        ? { status: 'partial-no-approval', summary: 'Partial code inspection only. This is not an approval to merge.' }
        : { status: 'not-inspected', summary: 'No source-code lines were inspected. No code review or approval was completed.' },
    } : {
      job: input.job, summary: 'The value reaches assignment.', uncertainty: 'Only selected code was inspected.', findings: [],
      nextStep: { text: 'Check input validation.', evidence: [citation] },
    },
    source: {
      reference: input.source, url: `https://github.com/${input.source.repo}/${input.source.kind === 'pr' ? 'pull' : 'issues'}/${input.source.number}`,
      title: 'Validate input', body: 'Inspect the input value.', updatedAt: at, state: 'open', fingerprint: 'c'.repeat(64), observedAt: at,
      head: { repo: input.source.repo, sha, tree }, base: null, baseTip: null, defaultBranch: 'main', draft: null, merged: null,
    },
    verifiedAt: at,
    config: {
      agentId: input.agent.id, instructions: input.agent.instructions, modelRequested: input.agent.model,
      modelSelection: input.agent.model ? 'explicit' : 'sdk-default',
      fingerprint: createHash('sha256').update(JSON.stringify({ format: 'code-review-v1', job: input.job, ...input.agent })).digest('hex'),
    },
    coverage: {
      status: 'partial', changes: input.job === 'pr-review' ? 'partial' : 'not-applicable',
      knownChangedLines: 1, reviewedChangedLines: inspected ? 1 : 0,
      files: { expected: 1, compared: 1, retained: 1, omitted: 0, incompletePatches: 0 },
      warnings: ['Selective inspection only.'], requests: 5, readBytes: 100, contextBytes: 200, toolCalls: inspected ? 1 : 0,
    },
    evidence: inspected ? [{ id: 'read-1', side: 'head', repo: input.source.repo, revision: sha, blob: tree,
      path: 'src/value.ts', startLine: 1, endLine: 1, totalLines: 1, text }] : [],
    changes: [],
  });
}
