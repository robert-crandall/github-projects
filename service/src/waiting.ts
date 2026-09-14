import { z } from 'zod';
import { checkAbort, sanitized, ServiceError } from './errors.ts';
import { GhApi, parse, requireStatus } from './github.ts';
import { executable, run, type Runner } from './process.ts';
import {
  LIMITS, loginSchema, repoSchema, waitingSchema,
  type WaitingBucket, type WaitingDigest, type WaitingItem,
} from './schema.ts';

const searchFields = 'number,title,repository,author,updatedAt';
const searchItemSchema = z.object({
  number: z.number().int().positive().safe(), title: z.string().max(500),
  repository: z.object({ nameWithOwner: repoSchema }),
  author: z.object({ login: z.union([loginSchema, z.literal('')]) }).nullable(),
  updatedAt: z.iso.datetime(),
});
const reviewItemSchema = searchItemSchema.extend({ isDraft: z.boolean() });
const authoredItemSchema = searchItemSchema.omit({ author: true }).extend({ isDraft: z.boolean() });
const checkValueSchema = z.enum([
  '', 'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR',
  'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED',
  'SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE',
]);
const checkSchema = z.object({
  __typename: z.enum(['CheckRun', 'StatusContext']).optional(),
  conclusion: checkValueSchema.nullable().optional(),
  state: checkValueSchema.nullable().optional(),
  status: z.enum(['COMPLETED', 'IN_PROGRESS', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING']).optional(),
}).refine(check => (check.conclusion !== undefined || check.state !== undefined)
  && (check.__typename !== 'CheckRun' || check.conclusion !== undefined)
  && (check.__typename !== 'StatusContext' || check.state !== undefined),
'A status check must contain a conclusion or state.');
const enrichmentSchema = z.object({
  number: z.number().int().positive().safe(),
  reviewDecision: z.enum(['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  isDraft: z.boolean(),
  statusCheckRollup: z.array(checkSchema).max(1_000).nullable(),
});
type Enrichment = z.infer<typeof enrichmentSchema>;
const failing = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR']);
const pending = new Set(['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED']);
function ciState(checks: Enrichment['statusCheckRollup']): 'FAILING' | 'PENDING' | 'PASSING' | 'NO_CHECKS' {
  if (!checks?.length) return 'NO_CHECKS';
  // gh CheckRun.status is lifecycle metadata, not a conclusion. An empty conclusion
  // without a state stays pending, including status: IN_PROGRESS or COMPLETED.
  const states = checks.map(check => check.conclusion || check.state || '');
  if (states.some(state => failing.has(state))) return 'FAILING';
  return states.some(state => pending.has(state)) ? 'PENDING' : 'PASSING';
}
const identity = (item: WaitingItem) => `${item.reference.repo.toLowerCase()}#${item.reference.number}`;
function item(source: z.infer<typeof searchItemSchema>, kind: 'pr' | 'issue' = 'pr'): WaitingItem {
  return {
    reference: { repo: source.repository.nameWithOwner, kind, number: source.number },
    title: source.title, author: source.author?.login || null, updatedAt: source.updatedAt, reasons: [],
  };
}
function recent(value: WaitingItem, now: number, days: number): boolean {
  const updated = Date.parse(value.updatedAt);
  return updated >= now - days * 86_400_000 && updated <= now;
}

export class WaitingService {
  private readonly runner: Runner;
  private readonly resolve: typeof executable;
  private readonly now: () => Date;
  private readonly deadlineMs: number;
  constructor(options: {
    runner?: Runner; resolve?: typeof executable; now?: () => Date; deadlineMs?: number;
  } = {}) {
    this.runner = options.runner ?? run;
    this.resolve = options.resolve ?? executable;
    this.now = options.now ?? (() => new Date());
    this.deadlineMs = z.number().int().positive().max(LIMITS.deadlineMs).parse(options.deadlineMs ?? LIMITS.deadlineMs);
  }
  async fetch(signal: AbortSignal): Promise<WaitingDigest> {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    const timer = setTimeout(() => stop.abort(new ServiceError('deadline', true, 'read')), this.deadlineMs);
    try {
      checkAbort(combined);
      return await this.collect(combined, stop);
    } catch (error) {
      if (combined.aborted) {
        try { checkAbort(combined); } catch (reason) { error = reason; }
      }
      const failure = sanitized(error);
      throw new ServiceError(failure.code, failure.retryable, 'read');
    } finally { clearTimeout(timer); }
  }
  private async json<T>(program: string, args: string[], schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    checkAbort(signal);
    const result = await this.runner(program, args, signal);
    checkAbort(signal);
    if (result.code !== 0) throw new ServiceError(result.code === 4 ? 'authentication' : 'unavailable', true);
    if (Buffer.byteLength(result.stdout) > LIMITS.processBytes) throw new ServiceError('limit');
    let raw: unknown;
    try { raw = JSON.parse(result.stdout); } catch { throw new ServiceError('invalid_output'); }
    if (Array.isArray(raw) && raw.length > 50) throw new ServiceError('limit');
    return parse(schema, raw);
  }
  private async collect(signal: AbortSignal, stop: AbortController): Promise<WaitingDigest> {
    const now = this.now();
    const fetchedAt = now.toISOString();
    const program = await this.resolve('gh');
    checkAbort(signal);
    const auth = await new GhApi(this.runner, async () => program).request('GET', '/user', signal);
    checkAbort(signal);
    requireStatus(auth);
    const viewer = parse(z.object({ login: loginSchema }), auth.body).login;
    const limitedQueries: WaitingDigest['limitedQueries'] = [];
    const search = async <T>(id: WaitingDigest['limitedQueries'][number], args: string[], fields: string, schema: z.ZodType<T>) => {
      const results = await this.json(program,
        ['search', ...args, '--archived=false', '--state=open', '--limit', '50', '--json', fields],
        z.array(schema).max(50), signal);
      if (results.length === 50) limitedQueries.push(id);
      return results;
    };
    const direct = await search('direct-review', ['prs', 'user-review-requested:@me'], `${searchFields},isDraft`, reviewItemSchema);
    const team = await search('team-review',
      ['prs', 'team-review-requested:integrations/terraform-provider-core-maintainers'], `${searchFields},isDraft`, reviewItemSchema);
    const authored = await search('authored', ['prs', '--author=@me'], 'number,title,repository,isDraft,updatedAt', authoredItemSchema);
    const mentioned = await search('mentioned', ['prs', '--mentions=@me'], searchFields, searchItemSchema);
    const reviewed = await search('reviewed', ['prs', '--reviewed-by=@me'], searchFields, searchItemSchema);
    const assigned = await search('assigned', ['issues', '--assignee=@me'], searchFields, searchItemSchema);

    const own = authored.filter(value => !value.isDraft);
    const details: Enrichment[] = new Array(own.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(LIMITS.enrichmentConcurrency, own.length) }, async () => {
      try {
        while (cursor < own.length) {
          checkAbort(signal);
          const index = cursor++;
          const source = own[index]!;
          const detail = await this.json(program, [
            'pr', 'view', String(source.number), '--repo', source.repository.nameWithOwner,
            '--json', 'number,reviewDecision,mergeable,isDraft,statusCheckRollup',
          ], enrichmentSchema, signal);
          if (detail.number !== source.number) throw new ServiceError('invalid_output');
          details[index] = detail;
        }
      } catch (error) { stop.abort(error instanceof ServiceError ? error : new ServiceError('internal')); }
    });
    await Promise.all(workers);
    checkAbort(signal);

    const buckets: WaitingBucket[] = [];
    const counted = new Set<string>();
    const add = (id: WaitingBucket['id'], candidates: WaitingItem[]) => {
      const items = candidates.filter(value => {
        const key = identity(value);
        if (counted.has(key)) return false;
        counted.add(key);
        return true;
      });
      items.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
        || (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0));
      if (items.length) buckets.push({ id, items });
    };
    add('direct-review', direct.filter(value => !value.isDraft).map(value => item(value)));
    add('team-review', team.filter(value => !value.isDraft).map(value => item(value)));
    const ready: WaitingItem[] = [];
    const fixes: WaitingItem[] = [];
    own.forEach((source, index) => {
      const detail = details[index]!;
      if (detail.isDraft) return;
      const value = item({ ...source, author: { login: viewer } });
      const ci = ciState(detail.statusCheckRollup);
      if (detail.reviewDecision === 'APPROVED' && detail.mergeable === 'MERGEABLE' && (ci === 'PASSING' || ci === 'NO_CHECKS')) {
        ready.push(value);
      }
      if (detail.reviewDecision === 'CHANGES_REQUESTED') value.reasons.push('changes-requested');
      if (detail.mergeable === 'CONFLICTING') value.reasons.push('conflicts');
      if (ci === 'FAILING') value.reasons.push('ci');
      if (value.reasons.length) fixes.push(value);
    });
    add('ready-to-merge', ready);
    add('needs-fix', fixes);
    // Unknown/deleted authors cannot establish "not authored by me"; omit weak signals.
    const other = (value: WaitingItem) => value.author !== null && value.author.toLowerCase() !== viewer.toLowerCase();
    add('mentioned', mentioned.map(value => item(value)).filter(value => other(value) && recent(value, now.getTime(), 3)));
    add('reviewed', reviewed.map(value => item(value)).filter(value => other(value) && recent(value, now.getTime(), 2)));
    add('assigned', assigned.map(value => item(value, 'issue')).filter(value => recent(value, now.getTime(), 30)));
    return parse(waitingSchema, { fetchedAt, viewer, buckets, limitedQueries });
  }
}
