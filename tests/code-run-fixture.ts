import { createHash } from 'node:crypto';
import { codeReviewResultSchema, type CodeReviewInput } from '../service/src/code-review-schema.ts';
import { codeRunIntentSchema, codeRunOutcomeSchema, codeRunSchema, terminalCodeRun, type CodeRun } from '../service/src/code-runs.ts';

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

export class CodeRunStoreFixture {
  generation = crypto.randomUUID();
  entries: CodeRun[] = [];
  failStart = false;
  failUpdate = false;
  initialized = false;
  handle(command: string, args: Record<string, unknown>) {
    if (!this.initialized) {
      this.initialized = true;
      this.entries = this.entries.map(run => terminalCodeRun(run.outcome) ? run : { ...run,
        outcome: { status: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'interrupted', message: 'Run abandoned; not replayed.' } } });
    }
    if (command === 'code_run_context') return { generation: this.generation };
    if (command === 'code_run_read') {
      const filtered = this.entries.filter(run => (args.quarantined ? run.quarantined : !run.quarantined
        && run.intent.profileId === args.profileId && run.intent.input.taskId === args.taskId)
        && (args.before === null || run.sequence < Number(args.before))).sort((a, b) => b.sequence - a.sequence);
      const runs = filtered.slice(0, 10);
      return { runs, before: filtered.length > 10 ? runs.at(-1)!.sequence : null };
    }
    const intent = codeRunIntentSchema.parse(args.intent);
    const generation = String(args.generation);
    const quarantined = generation !== this.generation;
    if (command === 'code_run_start' && (this.failStart || quarantined)) throw { code: 'start-save', message: 'Start not saved.', retryable: true };
    if (command === 'code_run_update' && this.failUpdate) throw { code: 'result-save', message: 'Result disk unavailable.', retryable: true };
    const outcome = command === 'code_run_start' ? { status: 'running' as const } : codeRunOutcomeSchema.parse(args.outcome);
    const old = this.entries.find(run => run.intent.runId === intent.runId && run.generation === generation && run.quarantined === quarantined);
    if (old && terminalCodeRun(old.outcome) && JSON.stringify(old.outcome) !== JSON.stringify(outcome)) throw new Error('Immutable result');
    const run = codeRunSchema.parse({ generation, intent, outcome, quarantined, sequence: old?.sequence ?? this.entries.length + 1 });
    this.entries = [...this.entries.filter(value => value !== old), run];
    return structuredClone(run);
  }
  replace(entries: CodeRun[] = []) {
    this.generation = crypto.randomUUID(); this.entries = structuredClone(entries); this.initialized = false;
  }
}
