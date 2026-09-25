import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CopilotService, type GitHubRequestContext } from './copilot.ts';
import { checkAbort, sanitized, ServiceError } from './errors.ts';
import { pageLink, parse, parseResponse, requireStatus, sourceReference, type ApiResponse } from './github.ts';
import { executable, run, type Runner } from './process.ts';
import { LIMITS, loginSchema, referenceSchema, repoSchema, threadIdSchema, type Reference } from './schema.ts';
import { canonicalGithubUrl } from './work-mcp.ts';
import {
  cacheHash, incrementalSearchSafe, SEARCH_OVERLAP_MS, SEARCH_RECONCILE_MS, WorkGitHubCache,
  type CachedTimeline,
} from './work-github-cache.ts';
import {
  githubWorkActionSchema, isGitHubStream, workCollectInputSchema, workCollectOutputSchema,
  workSourceContextSchema, type WorkSourceContext,
  type WorkCandidate, type WorkCollection, type WorkEvidence, type WorkObservation, type Workstream,
} from './work-schema.ts';

const time = z.iso.datetime();
const actor = z.object({ login: loginSchema });
const team = z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
const sourceSchema = z.object({
  id: z.number().int().positive().safe(), number: z.number().int().positive().safe(),
  title: z.string().min(1).max(1000), body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']), created_at: time,
  updated_at: time.optional(),
  labels: z.array(z.union([z.string().max(200), z.object({ name: z.string().max(200) })])).max(100).optional(),
  user: actor.nullable().optional(),
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
type Source = z.infer<typeof sourceSchema>;
type Notification = NonNullable<WorkCandidate['notification']>;
type Target = { ref: Reference; matched: boolean; notification?: Notification };
const notificationSourceLimit = Math.floor(200 / githubWorkActionSchema.options.length);
const notificationWindowProbes = 32;
const notificationSchema = z.object({
  id: threadIdSchema, repository: z.object({ full_name: repoSchema, archived: z.boolean() }),
  subject: z.object({ type: z.string().max(100), url: z.string().nullable(), title: z.string() }),
  reason: z.string().max(100), unread: z.boolean(), updated_at: time, last_read_at: time.nullable(),
});
const discussionSchema = z.object({
  id: z.number().int().positive().safe(), user: actor.nullable(), body: z.string().nullable(),
  created_at: time.optional(), submitted_at: time.nullable().optional(), state: z.string().optional(),
  html_url: z.url().optional(),
});
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
  items: z.array(z.object({ html_url: z.url(), number: z.number().int().positive().safe() })).max(100),
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

function sourceContext(source: Source, ref: Reference, graph?: Graph): WorkSourceContext {
  let body = source.body ?? '';
  if (ref.kind === 'pr') {
    const checks = graph?.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    const current = {
      state: source.merged ? 'MERGED' : graph?.state ?? source.state.toUpperCase(),
      head: graph?.headRefOid ?? null, draft: graph?.isDraft ?? source.draft ?? false,
      queued: Boolean(graph?.mergeQueueEntry), mergeable: graph?.mergeable ?? null,
      reviewDecision: graph?.reviewDecision ?? null,
      checksIncomplete: checks?.pageInfo.hasNextPage ?? false,
      checks: (checks?.nodes ?? []).map(check => check.__typename === 'CheckRun'
        ? { name: check.name, status: check.status, conclusion: check.conclusion }
        : { name: check.context, status: check.state, conclusion: null })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
    body += `\n\n--- Current GitHub pull request state (not source-authored text) ---\n${JSON.stringify(current)}`;
  }
  const content = {
    title: source.title, body,
    labels: [...new Set((source.labels ?? []).map(label => typeof label === 'string' ? label : label.name))].sort(),
  };
  const parsed = workSourceContextSchema.safeParse({ ...content, revision: hash(content) });
  if (!parsed.success) throw new ServiceError('limit');
  return parsed.data;
}

export class WorkGitHub {
  private readonly runner: Runner;
  private readonly resolve: typeof executable;
  private readonly now: () => Date;
  private readonly copilot: Pick<CopilotService, 'extractReplies'> & Partial<Pick<CopilotService, 'extractGitHubRequests'>>;
  private readonly cache: WorkGitHubCache | null;
  private collecting = false;
  constructor(options: {
    runner?: Runner; resolve?: typeof executable; now?: () => Date;
    copilot?: Pick<CopilotService, 'extractReplies'> & Partial<Pick<CopilotService, 'extractGitHubRequests'>>;
    cache?: WorkGitHubCache | null;
  } = {}) {
    this.runner = options.runner ?? run;
    this.resolve = options.resolve ?? executable;
    this.now = options.now ?? (() => new Date());
    this.copilot = options.copilot ?? new CopilotService();
    this.cache = options.cache === undefined ? new WorkGitHubCache() : options.cache;
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
    if (!input.success || !isGitHubStream(input.data.stream)) throw new ServiceError('invalid_input');
    if (!githubWorkActionSchema.safeParse(input.data.stream.action).success) throw new ServiceError('unsupported');
    if (this.collecting) throw new ServiceError('busy', true);
    this.collecting = true;
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new ServiceError('deadline', true, 'read')), LIMITS.refreshMs + LIMITS.workModelMs);
    try { return await this.read(input.data, combined); }
    finally { clearTimeout(timer); this.collecting = false; }
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
  private async sourceGraph(ref: Reference, source: Source, signal: AbortSignal): Promise<Graph | undefined> {
    if (ref.kind !== 'pr' || source.state !== 'open' || source.merged) return undefined;
    const [owner, name] = ref.repo.split('/');
    const response = await this.api('/graphql', signal, { query: graphQuery, variables: { owner, name, number: ref.number } });
    if (response.body && typeof response.body === 'object' && 'errors' in response.body) throw new ServiceError('access');
    const graph = parse(graphSchema, response.body).data.repository?.pullRequest;
    if (!graph) throw new ServiceError('invalid_output');
    return graph;
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
    const stop = new AbortController();
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal, stop.signal]);
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
            const graph = await this.sourceGraph(ref, source, combined);
            let state: WorkObservation['state'] = source.merged ? 'merged' : source.state;
            if (graph) {
              state = graph.state === 'MERGED' ? 'merged' : graph.state === 'CLOSED' ? 'closed'
                : graph.mergeQueueEntry ? 'queued' : 'open';
            }
            observations.push({
              url, state, observedAt, reason: state === 'queued' ? 'GitHub confirms current merge queue membership.' : '',
              reference: ref,
              context: sourceContext(source, ref, graph),
            });
          } catch (error) {
            checkAbort(combined);
            const failure = sanitized(error);
            if (failure.code === 'authentication' || failure.code === 'rate_limit') { stop.abort(error); throw error; }
            observations.push({ url, state: 'unknown', observedAt, reason: failure.message });
          }
        }
      }));
      const failed = workers.find(worker => worker.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return observations;
    } finally { clearTimeout(timer); }
  }
  private async timeline(ref: Reference, signal: AbortSignal, warnings: string[], coverageInfo = warnings): Promise<Event[]> {
    const path = `/repos/${ref.repo}/issues/${ref.number}/timeline`;
    const first = await this.api(`${path}?per_page=100&page=1`, signal);
    const last = pageLink(first, 'last', path) ?? 1;
    const pages = [first];
    if (last > 1) pages.push(await this.api(`${path}?per_page=100&page=${last}`, signal));
    if (last > 2) coverageInfo.push(`${ref.repo}#${ref.number}: timeline is capped to first and latest pages; missing evidence is not completion.`);
    if (last === 1 && pageLink(first, 'next', path)) {
      coverageInfo.push(`${ref.repo}#${ref.number}: timeline is capped because GitHub omitted its last page link; context may be incomplete.`);
    }
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
  private async notifications(since: string | null, collectedAt: string, signal: AbortSignal): Promise<{
    urls: Map<string, Target>; warnings: string[]; coverageInfo: string[]; coveredThrough?: string;
  }> {
    const scanStart = Date.parse(collectedAt);
    const lower = since ? Date.parse(since) : scanStart - 30 * 86_400_000;
    if (lower >= scanStart) throw new ServiceError('invalid_input');
    const lowerSecond = Math.floor(lower / 1000);
    const boundary = new Date((lowerSecond - 1) * 1000).toISOString();
    const fullUpperSecond = Math.floor(scanStart / 1000) + 1;
    let upperSecond = fullUpperSecond;
    for (let probe = 0; probe < notificationWindowProbes; probe++) {
      const before = new Date(upperSecond * 1000).toISOString();
      // Only accept a complete first page. Offset pagination can skip unchanged rows
      // when other notifications are deleted or updated between requests.
      const response = await this.api(`/notifications?all=true&per_page=50&page=1&since=${encodeURIComponent(boundary)}&before=${encodeURIComponent(before)}`, signal);
      const rows = parse(z.array(z.unknown()).max(50), response.body);
      const urls = new Map<string, Target>();
      const warnings: string[] = [];
      const coverageInfo: string[] = [];
      for (const raw of rows) {
        const parsed = notificationSchema.safeParse(raw);
        if (!parsed.success) { warnings.push('A GitHub notification could not be validated; notification coverage is incomplete.'); continue; }
        const notification = parsed.data;
        const updated = Date.parse(notification.updated_at);
        if (updated <= (lowerSecond - 1) * 1000 || updated >= upperSecond * 1000) continue;
        if (notification.repository.archived) {
          coverageInfo.push('Archived repositories are excluded from notification discovery.');
          continue;
        }
        if (!['PullRequest', 'Issue'].includes(notification.subject.type)) {
          coverageInfo.push(`Unsupported GitHub notification subject type ${notification.subject.type} is excluded; no work was inferred.`);
          continue;
        }
        try {
          const source = sourceReference(notification);
          const url = `https://github.com/${source.repo.toLowerCase()}/${source.kind === 'pr' ? 'pull' : 'issues'}/${source.number}`;
          const ref = reference(url);
          const existing = urls.get(url);
          if (!existing?.notification || Date.parse(notification.updated_at) > Date.parse(existing.notification.updatedAt)) {
            urls.set(url, { ref, matched: true, notification: {
              threadId: notification.id, reference: ref, updatedAt: notification.updated_at,
            } });
          }
        } catch {
          warnings.push(`Notification ${notification.id}: invalid GitHub subject identity; no source URL was followed.`);
        }
      }
      const next = pageLink(response, 'next', '/notifications');
      if (next && next !== 2) throw new ServiceError('invalid_output');
      if (!next && urls.size <= notificationSourceLimit) {
        const coveredThrough = upperSecond < fullUpperSecond ? before : undefined;
        if (coveredThrough) coverageInfo.unshift(
          `Processed notification history before ${coveredThrough}; more history remains through ${collectedAt}. The next run resumes from this boundary.`,
        );
        return { urls, warnings, coverageInfo, ...(coveredThrough ? { coveredThrough } : {}) };
      }
      const midpoint = Math.floor((lowerSecond + upperSecond) / 2);
      if (midpoint * 1000 <= lower || midpoint * 1000 > scanStart) {
        return {
          urls: new Map(), coverageInfo: [], warnings: [
            `Notification history cannot safely split this timestamp bucket: more than ${notificationSourceLimit} sources or 50 notifications. No sources were skipped; the history cursor must not advance.`,
          ],
        };
      }
      upperSecond = midpoint;
    }
    return { urls: new Map(), coverageInfo: [], warnings: [
      `Notification history reached its ${notificationWindowProbes}-probe limit; no sources were skipped and the history cursor must not advance.`,
    ] };
  }
  private async memberTeams(signal: AbortSignal, warnings: string[], coverageInfo: string[]) {
    const teams = new Set<string>();
    try {
      for (let page = 1; page <= 2; page++) {
        const response = await this.api(`/user/teams?per_page=100&page=${page}`, signal);
        const rows = parse(z.array(team.extend({ organization: z.object({ login: loginSchema }) })).max(100), response.body);
        rows.forEach(value => teams.add(`${value.organization.login}/${value.slug}`.toLowerCase()));
        const next = pageLink(response, 'next', '/user/teams');
        if (!next) return teams;
        if (next !== page + 1) throw new ServiceError('invalid_output');
      }
      coverageInfo.push('GitHub team membership is capped at 200 teams; unconfirmed team requests were not inferred.');
    } catch (error) {
      checkAbort(signal);
      const failure = sanitized(error);
      if (['authentication', 'rate_limit'].includes(failure.code)) throw error;
      warnings.push(`GitHub team membership could not be fully read: ${failure.message}`);
    }
    return teams;
  }
  private async discussions(ref: Reference, signal: AbortSignal, warnings: string[], coverageInfo: string[]): Promise<Event[]> {
    if (ref.kind !== 'pr') return [];
    const events: Event[] = [];
    for (const kind of ['reviews', 'comments'] as const) {
      const path = `/repos/${ref.repo}/pulls/${ref.number}/${kind}`;
      const first = await this.api(`${path}?per_page=100&page=1`, signal);
      const last = pageLink(first, 'last', path) ?? 1;
      const pages = [first];
      if (last > 1) pages.push(await this.api(`${path}?per_page=100&page=${last}`, signal));
      if (last > 2 || (last === 1 && pageLink(first, 'next', path))) {
        coverageInfo.push(`${ref.repo}#${ref.number}: ${kind} are capped to first and latest pages; context may be incomplete.`);
      }
      for (const response of pages) {
        for (const raw of parse(z.array(z.unknown()).max(100), response.body)) {
          const parsed = discussionSchema.safeParse(raw);
          if (!parsed.success) { warnings.push(`${ref.repo}#${ref.number}: a ${kind} record could not be validated.`); continue; }
          if (kind === 'reviews' && (!parsed.data.submitted_at || parsed.data.state === 'PENDING')) continue;
          events.push({ ...parsed.data, event: kind === 'reviews' ? 'reviewed' : 'review_comment' });
        }
      }
    }
    return events;
  }
  private requestContext(source: Source, events: Event[], url: string, ref: Reference, coverageInfo: string[], graph?: Graph): GitHubRequestContext {
    const messages: GitHubRequestContext['messages'] = [{
      eventId: identity(ref, 'created', source.id), sourceTimestamp: source.created_at, sourceUrl: url,
      author: source.user?.login ?? null, kind: 'description', body: (source.body ?? '').slice(0, 8000),
    }];
    const comments = [...new Map(events.filter(event =>
      ['commented', 'reviewed', 'review_comment'].includes(event.event) && (event.body || event.event === 'reviewed' && event.state)
      && (event.id ?? event.node_id) && (event.created_at ?? event.submitted_at),
    ).map(event => [identity(ref, event.event, event.id ?? event.node_id!), event])).values()]
      .sort((a, b) => (a.created_at ?? a.submitted_at!).localeCompare(b.created_at ?? b.submitted_at!));
    if ((source.body?.length ?? 0) > 8000 || comments.length > 30 || comments.some(event => (event.body?.length ?? 0) > 2000)) {
      coverageInfo.push(`${ref.repo}#${ref.number}: request context is capped to an 8,000-character description and 30 recent 2,000-character messages; context may be incomplete.`);
    }
    if (!source.user || comments.some(event => !event.user && !event.actor)) {
      coverageInfo.push(`${ref.repo}#${ref.number}: some request authors are unavailable; requests with unknown authors were not inferred.`);
    }
    for (const event of comments.slice(-30)) {
      const eventId = event.id ?? event.node_id!;
      // Construct permalinks from validated source IDs, never follow source-supplied links.
      const anchor = typeof event.id === 'number'
        ? `${event.event === 'commented' ? 'issuecomment' : event.event === 'reviewed' ? 'pullrequestreview' : 'discussion_r'}${event.event === 'review_comment' ? '' : '-'}${event.id}` : '';
      messages.push({
        eventId: identity(ref, event.event, eventId), sourceTimestamp: event.created_at ?? event.submitted_at!,
        sourceUrl: anchor ? `${url}#${anchor}` : url, author: event.user?.login ?? event.actor?.login ?? null,
        kind: event.event, body: (event.body ?? '').slice(0, 2000), ...(event.state ? { state: event.state } : {}),
      });
    }
    return {
      url, title: source.title, author: source.user?.login ?? null,
      reviewDecision: graph?.reviewDecision ?? null, draft: source.draft ?? graph?.isDraft ?? false,
      assignees: (source.assignees ?? []).map(user => user.login),
      reviewRecipients: [
        ...(source.requested_reviewers ?? []).map(user => user.login),
        ...(source.requested_teams ?? []).map(team => `${ref.repo.split('/')[0]}/${team.slug}`),
      ], messages,
    };
  }
  private async extractRequests(
    contexts: GitHubRequestContext[], viewer: string, teams: string[], input: z.infer<typeof workCollectInputSchema>,
    signal: AbortSignal, warnings: string[], coverageInfo: string[],
  ): Promise<WorkCandidate[]> {
    const candidates: WorkCandidate[] = [];
    const batches: GitHubRequestContext[][] = [];
    const bytes = (sources: GitHubRequestContext[]) => Buffer.byteLength(JSON.stringify({ viewer, teams, sources }));
    let batch: GitHubRequestContext[] = [];
    for (const source of contexts) {
      if (!source.messages.some(message => (message.body || message.kind === 'description' && source.title)
        && message.author && !same(message.author, viewer))) continue;
      if (bytes([source]) > LIMITS.workModelBytes) {
        coverageInfo.push(`${source.url}: request context exceeds model input limit; no request was inferred.`);
        continue;
      }
      if (batch.length && bytes([...batch, source]) > LIMITS.workModelBytes) { batches.push(batch); batch = []; }
      batch.push(source);
    }
    if (batch.length) batches.push(batch);
    for (const sources of batches) {
      const messages = new Map(sources.flatMap(source => source.messages.map(message => [message.eventId, { source, message }] as const)));
      try {
        if (!this.copilot.extractGitHubRequests) throw new ServiceError('copilot_unavailable');
        const result = await this.copilot.extractGitHubRequests({ viewer, teams, sources }, input.model, signal);
        const extracted = result.requests.map((request): WorkCandidate => {
          const original = messages.get(request.eventId);
          if (!original || !githubWorkActionSchema.safeParse(request.action).success
            || !original.message.author || same(original.message.author, viewer)
            || (!original.message.body.trim() && original.message.kind !== 'description')) throw new ServiceError('copilot_output');
          const { message, source } = original;
          if (Date.parse(message.sourceTimestamp) > this.now().getTime() + 300_000) throw new ServiceError('copilot_output');
          return {
            title: request.title, action: request.action, url: source.url,
            evidence: [{
              id: message.eventId, source: 'github', streamId: input.stream.id,
              at: message.sourceTimestamp, url: message.sourceUrl, summary: request.summary,
            }],
          };
        });
        candidates.push(...extracted);
        warnings.push(...result.warnings);
        if (result.requests.length === 200) coverageInfo.push('GitHub request extraction reached its 200-request limit; source context coverage may be incomplete.');
      } catch (error) {
        checkAbort(signal);
        const failure = sanitized(error);
        if (!['copilot_output', 'limit'].includes(failure.code)) throw error;
        warnings.push(`Request extraction failed for ${sources.length} sources: ${failure.message}`);
      }
    }
    return candidates;
  }
  private async read(input: z.infer<typeof workCollectInputSchema>, signal: AbortSignal): Promise<WorkCollection> {
    const stop = new AbortController();
    signal = AbortSignal.any([signal, stop.signal]);
    const { stream } = input;
    const collectedAt = this.now().toISOString();
    const accountResponse = (await this.api('/user', signal)).body;
    const viewer = parse(z.object({ login: loginSchema }), accountResponse).login;
    const cache = stream.kind === 'github' && !input.observeOnly ? this.cache : null;
    const accountSchema = z.object({ id: z.number().int().positive().safe(), login: loginSchema });
    const account = cache ? parse(accountSchema, accountResponse) : undefined;
    const cacheKey = cacheHash([1, 'github.com', account, stream, input.model]);
    const record = cache?.load(cacheKey);
    const cached = record?.state;
    const pending = cached?.pending.filter(delivery => !input.since || Date.parse(delivery.at) > Date.parse(input.since)) ?? [];
    const timelines = new Map<string, CachedTimeline>(cached?.timelines);
    // Validate stored events outside source error recovery: corruption is not a
    // partial upstream read and must never become a successful cache fallback.
    for (const timeline of timelines.values()) parse(z.array(eventSchema).max(200), timeline.events);
    const replies = new Map(cached?.replies.map(reply => [reply.key, reply.candidates]));
    const usedReplies = new Set<string>();
    // The saved expression is data in a single URL-encoded query value; never a command or shell fragment.
    const query = `${stream.query.replace(/@me\b/g, viewer)} is:open archived:false`;
    const warnings: string[] = [];
    const coverageInfo: string[] = [];
    const notificationStream = stream.kind === 'github-notifications';
    const discovery = notificationStream && !input.observeOnly
      ? await this.notifications(input.since, collectedAt, signal) : undefined;
    const urls = discovery?.urls ?? new Map<string, Target>();
    warnings.push(...discovery?.warnings ?? []);
    coverageInfo.push(...discovery?.coverageInfo ?? []);
    const safeQuery = incrementalSearchSafe(query);
    const fullSearch = !cached?.scannedAt || !cached.reconciledAt || !input.since || !safeQuery
      || Date.parse(collectedAt) - Date.parse(cached.reconciledAt) >= SEARCH_RECONCILE_MS
      || Date.parse(cached.scannedAt) >= Date.parse(collectedAt)
      || Date.parse(input.since) >= Date.parse(collectedAt);
    const lower = Math.min(Date.parse(input.since ?? collectedAt), Date.parse(cached?.scannedAt ?? collectedAt));
    const searchQuery = fullSearch ? query
      : `${query} updated:${new Date(lower - SEARCH_OVERLAP_MS).toISOString()}..${collectedAt}`;
    if (cache && !safeQuery) coverageInfo.push('This saved expression uses date, relative, Boolean, or unrecognized syntax; full search preserves its original meaning.');
    let total = 0;
    let incomplete = false;
    for (let page = 1; !notificationStream && !input.observeOnly && page <= 2; page++) {
      const search = parse(searchSchema, (await this.api(
        `/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=100&page=${page}${cache && safeQuery ? '&sort=updated&order=asc' : ''}`, signal,
      )).body);
      total = Math.max(total, search.total_count);
      incomplete ||= search.incomplete_results;
      for (const item of search.items) {
        const url = canonicalGithubUrl(item.html_url);
        if (!url) throw new ServiceError('invalid_output');
        const ref = reference(url);
        if (ref.number !== item.number) throw new ServiceError('invalid_output');
        urls.set(url, { ref, matched: true });
      }
      if (search.items.length < 100 || page * 100 >= total) break;
    }
    if (total > urls.size || incomplete) {
      warnings.push(urls.size === 200 && total > 200
        ? 'GitHub search is capped at 200 matches. Missing matches are not completion.'
        : 'GitHub search returned incomplete results. Missing matches are not completion.');
    }
    const completeSearch = !incomplete && total <= urls.size;
    const members = new Set(fullSearch && completeSearch ? urls.keys() : [...cached?.members ?? [], ...urls.keys()]);
    if (cache) {
      if (members.size > 200) throw new ServiceError('limit');
      for (const url of members) if (!urls.has(url)) urls.set(url, { ref: reference(url), matched: true });
      for (const url of [...cached?.members ?? [], ...pending.map(delivery => delivery.candidate.url)]) {
        if (!urls.has(url)) urls.set(url, { ref: reference(url), matched: false });
      }
    }
    for (const raw of input.knownUrls) {
      const url = canonicalGithubUrl(raw);
      if (!url) continue;
      if (!urls.has(url)) urls.set(url, { ref: reference(url), matched: false });
    }
    if (urls.size > 300) throw new ServiceError('limit');
    const candidates: WorkCandidate[] = [];
    const observations: WorkCollection['observations'] = [];
    const replyInputs: { source: z.infer<typeof sourceSchema>; events: Event[]; url: string; ref: Reference }[] = [];
    const requestInputs: GitHubRequestContext[] = [];
    let teamLookup: Promise<Set<string>> | undefined;
    const memberships = () => teamLookup ??= this.memberTeams(signal, warnings, coverageInfo);
    const entries = [...urls.entries()];
    if (notificationStream) entries.sort((a, b) => (a[1].notification?.updatedAt ?? '').localeCompare(b[1].notification?.updatedAt ?? ''));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [url, { ref, matched }] = entries[cursor++]!;
        checkAbort(signal);
        const observedAt = this.now().toISOString();
        let observed = false;
        try {
          const { source, ref: sourceRef } = await this.sourceRoot(ref, signal);
          const graph = await this.sourceGraph(sourceRef, source, signal);
          const state = source.merged || graph?.state === 'MERGED' ? 'merged'
            : source.state === 'closed' || graph?.state === 'CLOSED' ? 'closed'
            : graph?.mergeQueueEntry ? 'queued' : 'open';
          observations.push({
            url, state, observedAt, reason: state === 'queued' ? 'GitHub confirms current merge queue membership.' : '',
            reference: sourceRef,
            context: sourceContext(source, sourceRef, graph),
          });
          observed = true;
          if (!matched || state !== 'open') continue;
          const revision = hash([source, graph?.headRefOid, graph?.reviewDecision]);
          const previous = timelines.get(url);
          let events: Event[];
          if (cache && source.updated_at && previous?.revision === revision
            && Date.parse(previous.fetchedAt) <= Date.parse(collectedAt)
            && Date.parse(collectedAt) - Date.parse(previous.fetchedAt) < SEARCH_RECONCILE_MS) {
            events = parse(z.array(eventSchema).max(200), previous.events);
            warnings.push(...previous.warnings);
            coverageInfo.push(...previous.coverageInfo);
          } else {
            const sourceWarnings: string[] = [];
            const sourceInfo: string[] = [];
            events = await this.timeline(sourceRef, signal, sourceWarnings, sourceInfo);
            warnings.push(...sourceWarnings);
            coverageInfo.push(...sourceInfo);
            if (cache && source.updated_at && !sourceWarnings.length) {
              timelines.set(url, { revision, fetchedAt: collectedAt, events, warnings: [], coverageInfo: sourceInfo });
            }
          }
          if (notificationStream) {
            const sourceEvents = [
              ...events, ...await this.discussions(sourceRef, signal, warnings, coverageInfo),
            ].sort((a, b) => (a.created_at ?? a.submitted_at ?? '').localeCompare(b.created_at ?? b.submitted_at ?? ''));
            const context = this.requestContext(source, sourceEvents, url, sourceRef, coverageInfo, graph);
            const needsTeams = (source.requested_teams?.length ?? 0) > 0
              || /@[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(source.title)
              || context.messages.some(message => /@[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(message.body));
            const teams = needsTeams ? await memberships() : new Set<string>();
            const actions: Workstream['action'][] = ['review'];
            if (source.assignees?.some(user => same(user.login, viewer))) actions.push('implement');
            if (sourceRef.kind === 'pr' && source.user && same(source.user.login, viewer)) actions.push('fix', 'merge');
            for (const action of actions) {
              const inferredStream = { ...stream, action, query: [...teams].map(team => `team-review-requested:${team}`).join(' ') };
              const evidence = this.evidence(source, graph, sourceEvents, sourceRef, inferredStream, viewer, url, warnings, coverageInfo);
              if (evidence.length > 200) coverageInfo.push(`${sourceRef.repo}#${sourceRef.number}: ${action} evidence is capped at 200 events.`);
              if (evidence.length) candidates.push({ title: source.title, action, url, evidence: evidence.slice(-200) });
            }
            requestInputs.push(context);
          } else {
            const evidence = this.evidence(source, graph, events, ref, stream, viewer, url, warnings, coverageInfo);
            if (evidence.length > 200) warnings.push(`${ref.repo}#${ref.number}: evidence is capped at 200 events.`);
            if (evidence.length) candidates.push({
              title: source.title, action: stream.action, url, evidence: evidence.slice(-200),
            });
          }
          if (!notificationStream && stream.action === 'reply') {
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
    if (notificationStream) candidates.push(...await this.extractRequests(
      requestInputs, viewer, [...(await teamLookup ?? [])], input, signal, warnings, coverageInfo,
    ));
    type ReplyMessage = Parameters<CopilotService['extractReplies']>[0]['messages'][number];
    const batches: ReplyMessage[][] = [];
    const owners = new Map<string, { source: z.infer<typeof sourceSchema>; url: string }>();
    const replyKeys = new Map<string, string>();
    const bytes = (messages: ReplyMessage[]) => Buffer.byteLength(JSON.stringify({ viewer, query: stream.query, messages }));
    let batch: ReplyMessage[] = [];
    for (const { source, events, url, ref } of replyInputs) {
      const comments = events.filter(event => event.event === 'commented' && event.body && (event.id ?? event.node_id) && event.created_at);
      if (comments.length > 15 || comments.some(comment => comment.body!.length > 2000)) {
        warnings.push(`${ref.repo}#${ref.number}: reply extraction is limited to 15 comments and 2,000 characters per comment; context may be incomplete.`);
      }
      const messages = [...new Map(comments
        .slice(-15).map(event => ({
          eventId: identity(ref, event.event, event.id ?? event.node_id!),
          sourceTimestamp: event.created_at!, sourceUrl: event.html_url ?? url, body: event.body!.slice(0, 2000),
        })).map(message => [message.eventId, message])).values()];
      if (!messages.length) {
        warnings.push(`${ref.repo}#${ref.number}: no immutable comment evidence for reply extraction.`);
        continue;
      }
      if (bytes(messages) > LIMITS.modelBytes) {
        warnings.push(`${ref.repo}#${ref.number}: reply context exceeds the model input limit; no reply was inferred.`);
        continue;
      }
      const replyKey = cacheHash([1, viewer, stream, input.model, source.title, messages]);
      replyKeys.set(url, replyKey);
      usedReplies.add(replyKey);
      const reusable = cache ? replies.get(replyKey) : undefined;
      if (reusable) { candidates.push(...reusable); continue; }
      if (batch.length && bytes([...batch, ...messages]) > LIMITS.modelBytes) {
        batches.push(batch);
        batch = [];
      }
      batch.push(...messages);
      for (const message of messages) owners.set(message.eventId, { source, url });
    }
    if (batch.length) batches.push(batch);
    for (const messages of batches) {
      try {
        const result = await this.copilot.extractReplies({ viewer, query: stream.query, messages }, input.model, signal);
        const extracted = result.requests.map((request): WorkCandidate => {
          const owner = owners.get(request.eventId);
          const original = messages.find(message => message.eventId === request.eventId);
          if (!owner || !original || request.action !== 'reply') throw new ServiceError('copilot_output');
          return {
            title: request.title || owner.source.title, action: 'reply', url: owner.url,
            evidence: [{ id: request.eventId, source: 'github', streamId: stream.id,
              at: original.sourceTimestamp, url: original.sourceUrl, summary: request.summary }],
          };
        });
        candidates.push(...extracted);
        warnings.push(...result.warnings);
        if (cache && !result.warnings.length) {
          for (const url of new Set(messages.map(message => owners.get(message.eventId)!.url))) {
            replies.set(replyKeys.get(url)!, extracted.filter(candidate => candidate.url === url));
          }
        }
      } catch (error) {
        checkAbort(signal);
        const failure = sanitized(error);
        if (!['copilot_output', 'limit'].includes(failure.code)) throw error;
        warnings.push(`Reply extraction failed for ${new Set(messages.map(message => owners.get(message.eventId)!.url)).size} sources: ${failure.message}`);
      }
    }
    const currentCandidates = structuredClone(candidates);
    const accessible = new Set(observations.filter(observation => observation.state !== 'unknown').map(observation => observation.url));
    const merged = new Map<string, WorkCandidate>();
    for (const candidate of [...pending.filter(delivery => accessible.has(delivery.candidate.url)).map(delivery => delivery.candidate), ...candidates]) {
      const notification = urls.get(candidate.url)?.notification;
      if (notification) candidate.notification = notification;
      const key = `${candidate.url}:${candidate.action}`;
      const existing = merged.get(key);
      if (!existing) merged.set(key, structuredClone(candidate));
      else {
        const evidence = [...new Map([...existing.evidence, ...candidate.evidence].map(event => [event.id, event])).values()];
        if (cache && evidence.length > 200) throw new ServiceError('limit');
        if (evidence.length > 200) (notificationStream ? coverageInfo : warnings).push(`${candidate.url}: merged ${candidate.action} evidence is capped at 200 events.`);
        existing.evidence = evidence.slice(-200);
      }
    }
    if (merged.size > 200) {
      if (notificationStream || cache) throw new ServiceError('limit');
      warnings.push('GitHub candidates are capped at 200 source/action pairs; coverage is incomplete and missing requests are not completion.');
    }
    const uniqueWarnings = [...new Set(warnings)];
    const uniqueInfo = [...new Set(coverageInfo)];
    const output = parse(workCollectOutputSchema, {
      candidates: [...merged.values()].slice(0, 200), observations,
      warnings: uniqueWarnings.length > 30
        ? [...uniqueWarnings.slice(0, 29), `${uniqueWarnings.length - 29} additional source warnings omitted; coverage remains incomplete.`]
        : uniqueWarnings,
      coverageInfo: uniqueInfo.length > 30
        ? [...uniqueInfo.slice(0, 29), `${uniqueInfo.length - 29} additional bounded-context or exclusion notes omitted.`]
        : uniqueInfo,
      ...(discovery?.coveredThrough ? { coveredThrough: discovery.coveredThrough } : {}),
      collectedAt,
    });
    // Include envelope overhead before making any durable checkpoint.
    if (Buffer.byteLength(JSON.stringify(output)) > LIMITS.responseBytes - 1024) throw new ServiceError('limit');
    if (cache && cached && record) {
      checkAbort(signal);
      const currentAccount = parse(accountSchema, (await this.api('/user', signal)).body);
      if (currentAccount.id !== account!.id || !same(currentAccount.login, account!.login)) throw new ServiceError('authentication');
      const deliveries = new Map(pending.map(delivery => [cacheHash(delivery.candidate), delivery]));
      for (const candidate of currentCandidates) {
        const key = cacheHash(candidate);
        if (!deliveries.has(key)) deliveries.set(key, { at: collectedAt, candidate });
      }
      const retained = new Set([...members, ...[...deliveries.values()].map(delivery => delivery.candidate.url)]);
      cache.save(cacheKey, record.revision, {
        version: 1,
        scannedAt: uniqueWarnings.length ? cached.scannedAt : collectedAt,
        reconciledAt: fullSearch && !uniqueWarnings.length ? collectedAt : cached.reconciledAt,
        members: [...members],
        timelines: [...timelines].filter(([url]) => retained.has(url)),
        replies: [...replies].filter(([key]) => usedReplies.has(key) || uniqueWarnings.length > 0)
          .map(([key, candidates]) => ({ key, candidates })),
        pending: [...deliveries.values()],
      });
    }
    return output;
  }
  close(): void { this.cache?.close(); }
  private evidence(
    source: z.infer<typeof sourceSchema>, graph: Graph | undefined, events: Event[],
    ref: Reference, stream: Workstream, viewer: string, url: string, warnings: string[], coverageInfo = warnings,
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
        coverageInfo.push(`${ref.repo}#${ref.number}: current review request confirmed, but original request event is outside available history; age is unknown.`);
        // Source creation is stable evidence time, not a claim about request freshness.
        return fallback(`review:${recipient}`, `Current review request for ${recipient}; original request time unavailable. Source created ${source.created_at}.`);
      });
    }
    if (stream.action === 'fix' || stream.action === 'merge') {
      if (!graph || graph.isDraft) return [];
      const commit = graph.commits.nodes[0]!.commit;
      const contexts = commit.statusCheckRollup?.contexts;
      if (contexts?.pageInfo.hasNextPage) {
        coverageInfo.push(`${ref.repo}#${ref.number}: checks are capped; readiness cannot be established.`);
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
