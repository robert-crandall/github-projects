import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CopilotService } from './copilot.ts';
import { checkAbort, sanitized, ServiceError } from './errors.ts';
import { pageLink, parse, parseResponse, pullRequestStateQuery, requireStatus, type ApiResponse } from './github.ts';
import { executable, run, type Runner } from './process.ts';
import { LIMITS, loginSchema, referenceSchema, type Reference } from './schema.ts';
import { canonicalGithubUrl } from './work-mcp.ts';
import {
  githubWorkActionSchema, workCollectInputSchema, workCollectOutputSchema,
  type WorkCandidate, type WorkCollection, type WorkEvidence, type WorkObservation, type Workstream,
} from './work-schema.ts';

const time = z.iso.datetime();
const actor = z.object({ login: loginSchema });
const team = z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
const sourceSchema = z.object({
  id: z.number().int().positive().safe(), number: z.number().int().positive().safe(),
  title: z.string().min(1).max(1000), body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']), created_at: time,
  merged: z.boolean().optional(), draft: z.boolean().optional(),
  requested_reviewers: z.array(actor).max(100).optional(),
  requested_teams: z.array(team).max(100).optional(),
  assignees: z.array(actor).max(100).optional(),
  pull_request: z.object({}).optional(),
});
const eventSchema = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().min(1).max(200)]).optional(),
  node_id: z.string().min(1).max(200).optional(),
  event: z.string().max(100),
  created_at: time.nullable().optional(), submitted_at: time.nullable().optional(),
  requested_reviewer: actor.nullable().optional(), requested_team: team.nullable().optional(),
  assignee: actor.nullable().optional(), state: z.string().optional(),
  user: actor.nullable().optional(), actor: actor.nullable().optional(),
  body: z.string().nullable().optional(), html_url: z.url().optional(),
});
type Event = z.infer<typeof eventSchema>;
const checkSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'), id: z.string().min(1), name: z.string(),
    conclusion: z.string().nullable(), status: z.string(),
    completedAt: time.nullable(), startedAt: time.nullable(),
  }),
  z.object({
    __typename: z.literal('StatusContext'), id: z.string().min(1),
    context: z.string(), state: z.string(), createdAt: time,
  }),
]);
const graphSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object({
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    mergeQueueEntry: z.object({ id: z.string().min(1) }).nullable(),
    headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/),
    isDraft: z.boolean(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
    reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
    commits: z.object({ nodes: z.array(z.object({ commit: z.object({
      committedDate: time, statusCheckRollup: z.object({
        contexts: z.object({
          nodes: z.array(checkSchema).max(100), pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      }).nullable(),
    }) })).length(1) }),
  }).nullable() }).nullable() }),
});
type Graph = NonNullable<NonNullable<z.infer<typeof graphSchema>['data']['repository']>['pullRequest']>;
const graphQuery = `query WorkSource($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    state mergeQueueEntry { id } headRefOid isDraft mergeable reviewDecision
    commits(last:1) { nodes { commit { committedDate statusCheckRollup {
      contexts(first:100) { nodes {
        __typename ... on CheckRun { id name conclusion status completedAt startedAt }
        ... on StatusContext { id context state createdAt }
      } pageInfo { hasNextPage } }
    } } } }
  } }
}`;
const searchSchema = z.object({
  total_count: z.number().int().nonnegative(), incomplete_results: z.boolean(),
  items: z.array(z.object({ html_url: z.url(), number: z.number().int().positive().safe() })).max(50),
});
const observationGraphSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object({
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    mergeQueueEntry: z.object({ id: z.string().min(1) }).nullable(),
  }).nullable() }).nullable() }),
});
const hash = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function reference(raw: string): Reference {
  const canonical = canonicalGithubUrl(raw);
  if (!canonical) throw new ServiceError('invalid_input');
  const [, owner, repo, kind, number] = new URL(canonical).pathname.split('/');
  return parse(referenceSchema, { repo: `${owner}/${repo}`, kind: kind === 'pull' ? 'pr' : 'issue', number: Number(number) });
}
function identity(ref: Reference, kind: string, event: string | number) {
  return `github:${ref.repo.toLowerCase()}:${ref.number}:${kind}:${event}`;
}
function eventEvidence(event: Event, ref: Reference, stream: Workstream, url: string, summary: string): WorkEvidence | undefined {
  const eventId = event.id ?? event.node_id;
  const at = event.created_at ?? event.submitted_at;
  if (!eventId || !at) return undefined;
  return {
    id: identity(ref, event.event, eventId), source: 'github', streamId: stream.id, at, url,
    summary: summary.slice(0, 2000),
  };
}

export class WorkGitHub {
  private readonly runner: Runner;
  private readonly resolve: typeof executable;
  private readonly now: () => Date;
  private readonly copilot: Pick<CopilotService, 'extractReplies'>;
  constructor(options: {
    runner?: Runner; resolve?: typeof executable; now?: () => Date; copilot?: Pick<CopilotService, 'extractReplies'>;
  } = {}) {
    this.runner = options.runner ?? run;
    this.resolve = options.resolve ?? executable;
    this.now = options.now ?? (() => new Date());
    this.copilot = options.copilot ?? new CopilotService();
  }
  private async api(path: string, signal: AbortSignal, body?: unknown): Promise<ApiResponse> {
    checkAbort(signal);
    const args = [
      'api', '--hostname', 'github.com', '--include', '--method', body ? 'POST' : 'GET',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path,
    ];
    if (body) args.push('--input', '-');
    const result = await this.runner(await this.resolve('gh'), args, signal, body ? JSON.stringify(body) : undefined);
    checkAbort(signal);
    if (Buffer.byteLength(result.stdout) > LIMITS.processBytes) throw new ServiceError('limit');
    const response = parseResponse(result.stdout);
    if (!response) throw new ServiceError(result.code === 4 ? 'authentication' : result.code ? 'unavailable' : 'invalid_output');
    requireStatus(response);
    if (result.code) throw new ServiceError('unavailable', true);
    return response;
  }
  async collect(raw: z.input<typeof workCollectInputSchema>, signal: AbortSignal): Promise<WorkCollection> {
    const input = workCollectInputSchema.safeParse(raw);
    if (!input.success || input.data.stream.kind !== 'github') throw new ServiceError('invalid_input');
    if (!githubWorkActionSchema.safeParse(input.data.stream.action).success) throw new ServiceError('unsupported');
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new ServiceError('deadline', true, 'read')), LIMITS.refreshMs);
    try { return await this.read(input.data, combined); }
    finally { clearTimeout(timer); }
  }
  private async sourceRoot(ref: Reference, signal: AbortSignal) {
    let source = parse(sourceSchema, (await this.api(`/repos/${ref.repo}/${ref.kind === 'pr' ? 'pulls' : 'issues'}/${ref.number}`, signal)).body);
    if (source.number !== ref.number) throw new ServiceError('invalid_output');
    if (ref.kind === 'issue' && source.pull_request) {
      ref = { ...ref, kind: 'pr' };
      source = parse(sourceSchema, (await this.api(`/repos/${ref.repo}/pulls/${ref.number}`, signal)).body);
      if (source.number !== ref.number) throw new ServiceError('invalid_output');
    }
    return { source, ref };
  }
  async observe(rawUrls: string[], signal: AbortSignal): Promise<WorkObservation[]> {
    if (rawUrls.length > 300) throw new ServiceError('limit');
    const sources = new Map<string, string>();
    for (const raw of rawUrls) {
      const url = canonicalGithubUrl(raw);
      if (!url) continue;
      const key = url.replace('/pull/', '/issues/');
      if (!sources.has(key)) sources.set(key, url);
    }
    const urls = [...sources.values()];
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new ServiceError('deadline', true, 'read')), LIMITS.refreshMs);
    const observations: WorkObservation[] = [];
    let cursor = 0;
    try {
      const workers = await Promise.allSettled(Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (cursor < urls.length) {
          checkAbort(combined);
          const url = urls[cursor++]!;
          const observedAt = this.now().toISOString();
          try {
            const { source, ref } = await this.sourceRoot(reference(url), combined);
            let state: WorkObservation['state'] = source.merged ? 'merged' : source.state;
            if (ref.kind === 'pr' && state === 'open') {
              const response = await this.api('/graphql', combined, { query: pullRequestStateQuery(ref) });
              if (response.body && typeof response.body === 'object' && 'errors' in response.body) throw new ServiceError('access');
              const current = parse(observationGraphSchema, response.body).data.repository?.pullRequest;
              if (!current) throw new ServiceError('invalid_output');
              state = current.state === 'MERGED' ? 'merged' : current.state === 'CLOSED' ? 'closed'
                : current.mergeQueueEntry ? 'queued' : 'open';
            }
            observations.push({ url, state, observedAt, reason: state === 'queued' ? 'GitHub confirms current merge queue membership.' : '' });
          } catch (error) {
            checkAbort(combined);
            observations.push({ url, state: 'unknown', observedAt, reason: sanitized(error).message });
          }
        }
      }));
      const failed = workers.find(worker => worker.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return observations;
    } finally { clearTimeout(timer); }
  }
  private async timeline(ref: Reference, signal: AbortSignal, warnings: string[]): Promise<Event[]> {
    const path = `/repos/${ref.repo}/issues/${ref.number}/timeline`;
    const first = await this.api(`${path}?per_page=100&page=1`, signal);
    const last = pageLink(first, 'last', path) ?? 1;
    const pages = [first];
    if (last > 1) pages.push(await this.api(`${path}?per_page=100&page=${last}`, signal));
    if (last > 2) warnings.push(`${ref.repo}#${ref.number}: timeline is capped to first and latest pages; missing evidence is not completion.`);
    const events: Event[] = [];
    let malformed = false;
    for (const response of pages) {
      for (const item of parse(z.array(z.unknown()).max(100), response.body)) {
        const parsed = eventSchema.safeParse(item);
        if (parsed.success) events.push(parsed.data);
        else malformed = true;
      }
    }
    if (malformed) warnings.push(`${ref.repo}#${ref.number}: some source events could not be validated.`);
    return events.sort((a, b) => (a.created_at ?? a.submitted_at ?? '').localeCompare(b.created_at ?? b.submitted_at ?? ''));
  }
  private async read(input: z.infer<typeof workCollectInputSchema>, signal: AbortSignal): Promise<WorkCollection> {
    const stop = new AbortController();
    signal = AbortSignal.any([signal, stop.signal]);
    const { stream } = input;
    const collectedAt = this.now().toISOString();
    const viewer = parse(z.object({ login: loginSchema }), (await this.api('/user', signal)).body).login;
    // The saved expression is data in a single URL-encoded query value; never a command or shell fragment.
    const query = `${stream.query.replace(/@me\b/g, viewer)} is:open archived:false`;
    const search = parse(searchSchema, (await this.api(`/search/issues?q=${encodeURIComponent(query)}&per_page=50&page=1`, signal)).body);
    const warnings: string[] = [];
    if (search.total_count > search.items.length || search.incomplete_results || search.items.length === 50) {
      warnings.push('GitHub search is capped at 50 matches or incomplete. Missing matches are not completion.');
    }
    const urls = new Map<string, { ref: Reference; matched: boolean }>();
    for (const item of search.items) {
      const url = canonicalGithubUrl(item.html_url);
      if (!url) throw new ServiceError('invalid_output');
      const ref = reference(url);
      if (ref.number !== item.number) throw new ServiceError('invalid_output');
      urls.set(url, { ref, matched: true });
    }
    for (const raw of input.knownUrls) {
      const url = canonicalGithubUrl(raw);
      if (!url) continue;
      if (!urls.has(url)) urls.set(url, { ref: reference(url), matched: false });
    }
    const candidates: WorkCandidate[] = [];
    const observations: WorkCollection['observations'] = [];
    const replyInputs: { source: z.infer<typeof sourceSchema>; events: Event[]; url: string; ref: Reference }[] = [];
    const entries = [...urls.entries()];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [url, { ref, matched }] = entries[cursor++]!;
        checkAbort(signal);
        const observedAt = this.now().toISOString();
        let observed = false;
        try {
          const { source, ref: sourceRef } = await this.sourceRoot(ref, signal);
          let graph: Graph | undefined;
          if (sourceRef.kind === 'pr' && source.state === 'open' && !source.merged) {
            const [owner, name] = ref.repo.split('/');
            const response = await this.api('/graphql', signal, { query: graphQuery, variables: { owner, name, number: ref.number } });
            if (response.body && typeof response.body === 'object' && 'errors' in response.body) throw new ServiceError('access');
            graph = parse(graphSchema, response.body).data.repository?.pullRequest ?? undefined;
            if (!graph) throw new ServiceError('invalid_output');
          }
          const state = source.merged || graph?.state === 'MERGED' ? 'merged'
            : source.state === 'closed' || graph?.state === 'CLOSED' ? 'closed'
            : graph?.mergeQueueEntry ? 'queued' : 'open';
          observations.push({ url, state, observedAt, reason: state === 'queued' ? 'GitHub confirms current merge queue membership.' : '' });
          observed = true;
          if (!matched || state !== 'open') continue;
          const events = await this.timeline(ref, signal, warnings);
          const evidence = this.evidence(source, graph, events, ref, stream, viewer, url, warnings);
          if (evidence.length) candidates.push({
            title: source.title, action: stream.action, url, evidence: evidence.slice(-200),
          });
          if (stream.action === 'reply') {
            // Model extraction is serialized after parallel source reads below.
            replyInputs.push({ source, events, url, ref });
          }
        } catch (error) {
          checkAbort(signal);
          const failure = sanitized(error);
          if (failure.code === 'authentication' || failure.code === 'rate_limit') { stop.abort(error); throw error; }
          if (!observed) observations.push({ url, state: 'unknown', observedAt, reason: failure.message });
          warnings.push(`${ref.repo}#${ref.number}: ${failure.message}`);
        }
      }
    });
    const results = await Promise.allSettled(workers);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    for (const { source, events, url, ref } of replyInputs) {
      const comments = events.filter(event => event.event === 'commented' && event.body && (event.id ?? event.node_id) && event.created_at);
      if (comments.length > 15 || comments.some(comment => comment.body!.length > 2000)) {
        warnings.push(`${ref.repo}#${ref.number}: reply extraction is limited to 15 comments and 2,000 characters per comment; context may be incomplete.`);
      }
      const messages = comments
        .slice(-15).map(event => ({
          eventId: identity(ref, event.event, event.id ?? event.node_id!),
          sourceTimestamp: event.created_at!, sourceUrl: event.html_url ?? url, body: event.body!.slice(0, 2000),
        }));
      if (!messages.length) {
        warnings.push(`${ref.repo}#${ref.number}: no immutable comment evidence for reply extraction.`);
        continue;
      }
      const result = await this.copilot.extractReplies({ viewer, query: stream.query, messages }, input.model, signal);
      warnings.push(...result.warnings);
      for (const request of result.requests) {
        if (request.action !== 'reply') continue;
        candidates.push({
          title: request.title || source.title, action: 'reply', url,
          evidence: [{ id: request.eventId, source: 'github', streamId: stream.id,
            at: request.sourceTimestamp, url: request.sourceUrl, summary: request.summary }],
        });
      }
    }
    const merged = new Map<string, WorkCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.url}:${candidate.action}`;
      const existing = merged.get(key);
      if (!existing) merged.set(key, candidate);
      else existing.evidence = [...new Map([...existing.evidence, ...candidate.evidence].map(event => [event.id, event])).values()].slice(-200);
    }
    const uniqueWarnings = [...new Set(warnings)];
    return parse(workCollectOutputSchema, {
      candidates: [...merged.values()].slice(0, 200), observations,
      warnings: uniqueWarnings.length > 30
        ? [...uniqueWarnings.slice(0, 29), `${uniqueWarnings.length - 29} additional source warnings omitted; coverage remains incomplete.`]
        : uniqueWarnings,
      collectedAt,
    });
  }
  private evidence(
    source: z.infer<typeof sourceSchema>, graph: Graph | undefined, events: Event[],
    ref: Reference, stream: Workstream, viewer: string, url: string, warnings: string[],
  ): WorkEvidence[] {
    const fallback = (condition: string, summary: string, at = source.created_at): WorkEvidence => ({
      id: identity(ref, 'condition', hash(condition)), source: 'github', streamId: stream.id, at, url, summary,
    });
    if (stream.action === 'reply') return [];
    if (stream.action === 'review') {
      if (!graph || graph.isDraft || source.draft) return [];
      const selectedTeams = [...stream.query.matchAll(/\bteam-review-requested:([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/g)]
        .map(match => match[1]!.toLowerCase());
      const recipients = [
        ...(source.requested_reviewers ?? []).filter(user => same(user.login, viewer)).map(user => `user:${user.login.toLowerCase()}`),
        ...(source.requested_teams ?? []).filter(team => selectedTeams.includes(`${ref.repo.split('/')[0]}/${team.slug}`.toLowerCase()))
          .map(team => `team:${ref.repo.split('/')[0]}/${team.slug}`.toLowerCase()),
      ];
      return recipients.map(recipient => {
        const matching = events.filter(event => {
          const target = event.requested_reviewer ? `user:${event.requested_reviewer.login.toLowerCase()}`
            : event.requested_team ? `team:${ref.repo.split('/')[0]}/${event.requested_team.slug}`.toLowerCase() : '';
          return target === recipient && ['review_requested', 'review_request_removed'].includes(event.event);
        });
        const latest = matching.at(-1);
        const actual = latest?.event === 'review_requested'
          ? eventEvidence(latest, ref, stream, url, `Current review request for ${recipient}.`) : undefined;
        if (actual) return actual;
        warnings.push(`${ref.repo}#${ref.number}: current review request confirmed, but original request event is outside available history; age is unknown.`);
        // Source creation is stable evidence time, not a claim about request freshness.
        return fallback(`review:${recipient}`, `Current review request for ${recipient}; original request time unavailable. Source created ${source.created_at}.`);
      });
    }
    if (stream.action === 'fix' || stream.action === 'merge') {
      if (!graph || graph.isDraft) return [];
      const commit = graph.commits.nodes[0]!.commit;
      const contexts = commit.statusCheckRollup?.contexts;
      if (contexts?.pageInfo.hasNextPage) {
        warnings.push(`${ref.repo}#${ref.number}: checks are capped; readiness cannot be established.`);
        if (stream.action === 'merge') return [];
      }
      const checks = contexts?.nodes ?? [];
      const failing = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
      const passing = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
      const evidence: WorkEvidence[] = [];
      const state = (check: z.infer<typeof checkSchema>) => check.__typename === 'CheckRun' ? check.conclusion ?? '' : check.state;
      if (stream.action === 'fix') {
        for (const check of checks.filter(check => failing.has(state(check)))) {
          const at = check.__typename === 'CheckRun' ? check.completedAt ?? check.startedAt : check.createdAt;
          if (!at) { warnings.push(`${ref.repo}#${ref.number}: failing check has no occurrence time.`); continue; }
          evidence.push(fallback(`fix:check:${graph.headRefOid}:${check.id}:${state(check)}:${at}`,
            `Failing check ${check.__typename === 'CheckRun' ? check.name : check.context}: ${state(check)} on ${graph.headRefOid}.`, at));
        }
        if (graph.mergeable === 'CONFLICTING') evidence.push(fallback(`fix:conflict:${graph.headRefOid}`, `Head ${graph.headRefOid} has merge conflicts.`, commit.committedDate));
        if (graph.reviewDecision === 'CHANGES_REQUESTED') {
          const reviews = events.filter(event => event.event === 'reviewed' && event.state?.toLowerCase() === 'changes_requested');
          const event = reviews.at(-1);
          const review = event && eventEvidence(event, ref, stream, url, `Changes requested: ${(event.body ?? '').slice(0, 1700)}`);
          if (review) evidence.push(review);
          else evidence.push(fallback(`fix:changes-requested:${graph.headRefOid}`, `Changes requested on ${graph.headRefOid}; exact review event unavailable.`, commit.committedDate));
        }
      } else if (graph.reviewDecision === 'APPROVED' && graph.mergeable === 'MERGEABLE'
        && checks.every(check => passing.has(state(check)) && (check.__typename !== 'CheckRun' || check.status === 'COMPLETED'))) {
        const approvals = events.filter(event => event.event === 'reviewed' && event.state?.toLowerCase() === 'approved');
        const last = approvals.at(-1);
        evidence.push(fallback(`merge:${graph.headRefOid}:${last?.id ?? last?.node_id ?? 'approved'}`,
          `Approved head ${graph.headRefOid} is mergeable; ${checks.length} checks passing or no checks configured.`,
          last?.submitted_at ?? last?.created_at ?? commit.committedDate));
      }
      return evidence;
    }
    const assigned = source.assignees?.some(user => same(user.login, viewer))
      ? events.filter(event => event.event === 'assigned' && event.assignee && same(event.assignee.login, viewer)).at(-1) : undefined;
    const assignment = assigned && eventEvidence(assigned, ref, stream, url, `Assigned to ${viewer}.`);
    return [assignment ?? fallback(`${stream.action}:source:${source.id}`,
      `Open source selected for ${stream.action}. Source created ${source.created_at}; no distinct request event available.`)];
  }
}
