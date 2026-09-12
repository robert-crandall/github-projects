import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkAbort, sanitized, ServiceError } from './errors.ts';
import { executable, run, type Runner } from './process.ts';
import { readConversation } from './conversation.ts';
import {
  LIMITS, loginSchema, referenceSchema, repoSchema, threadIdSchema, teamSchema, refreshSchema,
  writeInputSchema, writeResultSchema,
  type ConversationInput, type Diagnostic, type Evidence, type Reference, type Thread,
} from './schema.ts';

export type ApiResponse = { status: number; headers: Record<string, string>; body: unknown };
export interface GitHubApi {
  request(method: 'GET' | 'DELETE' | 'PUT' | 'POST', endpoint: string, signal: AbortSignal, body?: { ignored: true } | { query: string }): Promise<ApiResponse>;
}
const repoPath = '[A-Za-z0-9][A-Za-z0-9-]{0,99}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}';
const getRoute = new RegExp(
  `^(?:/user|/user/teams\\?per_page=100&page=[1-9]\\d{0,5}|/notifications\\?all=true&per_page=50&page=[12]`
  + `|/notifications/threads/[1-9]\\d{0,19}(?:/subscription)?`
  + `|/repos/${repoPath}/(?:pulls|issues)/[1-9]\\d{0,15}`
  + `|/repos/${repoPath}/(?:issues/[1-9]\\d{0,15}/comments|pulls/[1-9]\\d{0,15}/(?:reviews|comments))\\?per_page=5&page=[1-9]\\d{0,5}`
  + `|/repos/${repoPath}/issues/[1-9]\\d{0,15}/timeline\\?per_page=100&page=[1-9]\\d{0,5})$`,
);
const stateQuery = (owner: string, name: string, number: number) =>
  `query { repository(owner:"${owner}",name:"${name}") { pullRequest(number:${number}) { state updatedAt mergeQueueEntry { id } } } }`;
export function pullRequestStateQuery(reference: Reference): string {
  const valid = parse(referenceSchema, reference);
  const [owner, name] = valid.repo.split('/');
  return stateQuery(owner!, name!, valid.number);
}
function allowedStateQuery(query: string): boolean {
  const match = /^query \{ repository\(owner:"([A-Za-z0-9][A-Za-z0-9-]{0,99})",name:"([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})"\) \{ pullRequest\(number:([1-9]\d{0,15})\) \{ state updatedAt mergeQueueEntry \{ id \} \} \} \}$/.exec(query);
  return !!match && query === pullRequestStateQuery({ repo: `${match[1]}/${match[2]}`, number: Number(match[3]), kind: 'pr' });
}
export class GhApi implements GitHubApi {
  constructor(private readonly runner: Runner = run, private readonly resolve = executable) {}
  async request(method: 'GET' | 'DELETE' | 'PUT' | 'POST', endpoint: string, signal: AbortSignal, body?: { ignored: true } | { query: string }): Promise<ApiResponse> {
    const allowed = method === 'GET' ? getRoute.test(endpoint) && body === undefined
      : method === 'DELETE' ? /^\/notifications\/threads\/[1-9]\d{0,19}$/.test(endpoint) && body === undefined
      : method === 'POST' ? endpoint === '/graphql' && body && Object.keys(body).length === 1 && 'query' in body && allowedStateQuery(body.query)
      : /^\/notifications\/threads\/[1-9]\d{0,19}\/subscription$/.test(endpoint) && body && Object.keys(body).length === 1 && 'ignored' in body && body.ignored === true;
    if (!allowed) throw new ServiceError('invalid_input');
    const args = ['api', '--hostname', 'github.com', '--include', '--method', method,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
    if (body) args.push('--input', '-');
    const output = await this.runner(await this.resolve('gh'), args, signal, body ? JSON.stringify(body) : undefined);
    const response = parseResponse(output.stdout);
    if (!response) throw new ServiceError(output.code === 0 ? 'invalid_output' : 'authentication', true);
    if (response.status >= 400) throw apiError(response);
    if (response.status >= 300 || output.code !== 0) throw new ServiceError('unavailable', true);
    return response;
  }
}
export function parseResponse(raw: string): ApiResponse | undefined {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const headers: Record<string, string> = {};
  for (const line of match[2]!.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body: unknown = null;
  if (match[3]!.trim()) {
    try { body = JSON.parse(match[3]!); }
    catch { throw new ServiceError('invalid_output'); }
  }
  return { status: Number(match[1]), headers, body };
}
function apiError(response: ApiResponse): ServiceError {
  if (response.status === 401) return new ServiceError('authentication');
  if (response.status === 429 || response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after']) {
    return new ServiceError('rate_limit', true);
  }
  if (response.status === 403 || response.status === 404) return new ServiceError('access');
  return new ServiceError('unavailable', true);
}
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ServiceError('invalid_output');
  return result.data;
}
export function requireStatus(response: ApiResponse, status = 200): void {
  if (response.status !== status) throw response.status >= 400 ? apiError(response) : new ServiceError('invalid_output');
}
const time = z.iso.datetime();
const actor = z.object({ login: loginSchema });
const team = z.object({ slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), organization: z.object({ login: loginSchema }).optional() });
const notificationSchema = z.object({
  id: threadIdSchema, repository: z.object({ full_name: repoSchema }),
  subject: z.object({ type: z.string(), url: z.string().nullable(), title: z.string() }),
  reason: z.string().max(100), unread: z.boolean(), updated_at: time, last_read_at: time.nullable(),
});
type Notification = z.infer<typeof notificationSchema>;
const sourceSchema = z.object({
  number: z.number().int().positive().safe(), title: z.string(), state: z.enum(['open', 'closed']),
  updated_at: time.optional(),
  merged: z.boolean().optional(), additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(), changed_files: z.number().int().nonnegative().optional(),
  requested_reviewers: z.array(actor).optional(), requested_teams: z.array(team).optional(),
});
type Source = z.infer<typeof sourceSchema>;
const eventSchema = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)]).optional(),
  node_id: z.string().regex(/^[A-Za-z0-9_=+-]{1,120}$/).optional(),
  sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/).optional(),
  event: z.string().max(100),
  created_at: time.nullable().optional(), submitted_at: time.nullable().optional(),
  actor: actor.nullable().optional(), user: actor.nullable().optional(),
  author: z.object({ date: time.optional() }).passthrough().nullable().optional(),
  body: z.string().nullable().optional(),
  requested_reviewer: actor.nullable().optional(), requested_team: team.nullable().optional(),
  review_requester: actor.nullable().optional(),
});
type SourceEvent = z.infer<typeof eventSchema>;

export function sourceReference(notification: Notification): Reference {
  const kind = notification.subject.type === 'PullRequest' ? 'pr'
    : notification.subject.type === 'Issue' ? 'issue' : undefined;
  if (!kind) throw new ServiceError('unsupported');
  // Do not follow subject/latest_comment URLs. Accept only an exact dotcom identity, then reconstruct paths.
  const endpoint = kind === 'pr' ? 'pulls' : 'issues';
  const prefix = `https://api.github.com/repos/${notification.repository.full_name}/${endpoint}/`;
  const raw = notification.subject.url;
  if (!raw?.startsWith(prefix) || !/^[1-9]\d{0,15}$/.test(raw.slice(prefix.length))) {
    throw new ServiceError('invalid_output');
  }
  return parse(referenceSchema, {
    repo: notification.repository.full_name, kind, number: Number(raw.slice(prefix.length)),
  });
}
function teamName(value: z.infer<typeof team>, reference: Reference): string {
  return parse(teamSchema, `${value.organization?.login ?? reference.repo.split('/')[0]}/${value.slug}`);
}
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function recipientKey(event: Evidence): string {
  return event.recipient.kind === 'user' ? `user:${event.recipient.login.toLowerCase()}`
    : event.recipient.kind === 'team' ? `team:${event.recipient.team.toLowerCase()}` : '';
}
export function classifyEvents(
  events: SourceEvent[], reference: Reference, source: Source, viewer: string,
  memberships: Set<string> | null,
): { evidence: Evidence[]; omitted: boolean } {
  let omitted = false;
  const evidence: Evidence[] = [];
  for (const event of events) {
    const identity = event.id ?? (event.node_id ? createHash('sha256').update(event.node_id).digest('hex') : event.sha);
    const at = event.created_at ?? event.submitted_at ?? event.author?.date;
    if (!identity || !at) { omitted = true; continue; }
    let recipient: Evidence['recipient'] = { kind: 'none' };
    if (event.requested_reviewer) {
      recipient = { kind: 'user', login: event.requested_reviewer.login, isViewer: same(event.requested_reviewer.login, viewer) };
    } else if (event.requested_team) {
      const name = teamName(event.requested_team, reference);
      recipient = { kind: 'team', team: name, viewerMembership: memberships === null ? 'unknown'
        : memberships.has(name.toLowerCase()) ? 'member' : 'not-member' };
    }
    let kind: Evidence['kind'] = 'other';
    if (event.event === 'review_requested') kind = 'review-request';
    else if (event.event === 'review_request_removed') kind = 'review-request-removed';
    else if (event.event === 'reviewed') kind = 'review';
    else if (event.event === 'commented') {
      const mention = new RegExp(`(^|[^A-Za-z0-9_])@${viewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');
      kind = mention.test(event.body ?? '') ? 'mention' : 'comment';
    }         else if (event.event === 'added_to_merge_queue' || event.event === 'removed_from_merge_queue') kind = 'merge-queue';
    else if (event.event === 'committed' || event.event === 'head_ref_force_pushed') kind = 'commit';
    else if (event.event === 'closed' || event.event === 'merged') kind = 'closed';
    else if (event.event === 'reopened') kind = 'reopened';
    const body = event.body ?? event.event;
    evidence.push({
      id: `github:${reference.repo.toLowerCase()}:${reference.number}:${event.event}:${identity}`,
      kind, at, actor: (event.actor ?? event.user ?? event.review_requester)?.login ?? null,
      text: body.slice(0, LIMITS.evidenceText), recipient,
      requestState: kind === 'review-request' ? 'historical' : 'not-request',
      textTruncated: body.length > LIMITS.evidenceText,
    });
  }
  evidence.sort((a, b) => a.at.localeCompare(b.at));
  for (const event of evidence) {
    if (event.kind !== 'review-request') continue;
    const key = recipientKey(event);
    if (!key) { event.requestState = 'uncertain'; continue; }
    const later = evidence.slice(evidence.indexOf(event) + 1);
    if (later.some(next =>
      ((next.kind === 'review-request' || next.kind === 'review-request-removed') && recipientKey(next) === key)
      || (next.kind === 'review' && event.recipient.kind === 'user' && next.actor !== null && same(next.actor, event.recipient.login)))) continue;
    if (source.state !== 'open' || source.merged) continue;
    if (source.requested_reviewers === undefined || source.requested_teams === undefined) {
      event.requestState = 'uncertain'; continue;
    }
    if (event.recipient.kind === 'user') {
      const recipient = event.recipient;
      if (recipient.isViewer && source.requested_reviewers.some(value => same(value.login, recipient.login))) {
        event.requestState = 'current';
      }
    } else if (event.recipient.kind === 'team') {
      const recipient = event.recipient;
      if (source.requested_teams.some(value => same(teamName(value, reference), recipient.team))) {
        event.requestState = recipient.viewerMembership === 'member' ? 'current'
          : recipient.viewerMembership === 'unknown' ? 'uncertain' : 'historical';
      }
    }
  }
  return { evidence: [...new Map(evidence.map(event => [event.id, event])).values()], omitted };
}
export function pageLink(response: ApiResponse, relation: 'last' | 'next', path: string): number | undefined {
  const value = response.headers.link;
  if (!value) return undefined;
  for (const part of value.split(',')) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (!match || match[2] !== relation) continue;
    let url: URL;
    try { url = new URL(match[1]!); } catch { throw new ServiceError('invalid_output'); }
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash || url.pathname !== path) {
      throw new ServiceError('invalid_output');
    }
    const page = url.searchParams.get('page');
    if (!page || !/^[1-9]\d{0,5}$/.test(page)) throw new ServiceError('limit');
    return Number(page);
  }
  return undefined;
}
function diagnose(scope: Diagnostic['scope'], error: unknown, threadId?: string): Diagnostic {
  const dto = sanitized(error);
  const message = dto.code === 'deadline'
    ? 'GitHub collection reached its time limit. Completed results are retained; refresh explicitly to retry missing evidence.'
    : dto.message;
  return { scope, code: dto.code, message, ...(threadId ? { threadId } : {}) };
}

export class GitHubService {
  private refreshing = false;
  private readonly refreshBudgetMs: number;
  private readonly writes = new Map<string, {
    context: string; result: Promise<z.infer<typeof writeResultSchema>>;
  }>();
  constructor(private readonly api: GitHubApi = new GhApi(), options: { refreshBudgetMs?: number } = {}) {
    this.refreshBudgetMs = z.number().int().positive().max(LIMITS.refreshMs).parse(options.refreshBudgetMs ?? LIMITS.refreshMs);
  }
  conversation(input: ConversationInput, signal: AbortSignal) {
    return readConversation(this.api, input, signal);
  }
  async connection(signal: AbortSignal) {
    const response = await this.api.request('GET', '/user', signal);
    requireStatus(response);
    const viewer = parse(actor, response.body).login;
    const scopes = (response.headers['x-oauth-scopes'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (!scopes.includes('notifications') && !scopes.includes('repo')) throw new ServiceError('missing_scope');
    return { available: true, viewer, scopes };
  }
  private async memberships(signal: AbortSignal): Promise<Set<string>> {
    const values = new Set<string>();
    for (let page = 1; page <= 2; page++) {
      const response = await this.api.request('GET', `/user/teams?per_page=100&page=${page}`, signal);
      requireStatus(response);
      const list = parse(z.array(team.extend({ organization: z.object({ login: loginSchema }) })).max(100), response.body);
      for (const value of list) values.add(`${value.organization.login}/${value.slug}`.toLowerCase());
      if (!pageLink(response, 'next', '/user/teams')) return values;
    }
    throw new ServiceError('limit');
  }
  async refresh(signal: AbortSignal) {
    checkAbort(signal);
    if (this.refreshing) throw new ServiceError('busy', true);
    this.refreshing = true;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new ServiceError('deadline', true)), this.refreshBudgetMs);
    try {
      return await this.collectRefresh(signal, AbortSignal.any([signal, budget.signal]));
    } catch (error) {
      if (error instanceof ServiceError) throw new ServiceError(error.dto.code, error.dto.retryable, 'read');
      throw error;
    } finally {
      clearTimeout(timer);
      this.refreshing = false;
    }
  }
  private async collectRefresh(callerSignal: AbortSignal, signal: AbortSignal) {
    const { viewer, scopes } = await this.connection(signal);
    const diagnostics: Diagnostic[] = [];
    let memberships: Set<string> | null = null;
    try {
      if (!scopes.some(scope => ['read:org', 'write:org', 'admin:org'].includes(scope))) throw new ServiceError('missing_scope');
      memberships = await this.memberships(signal);
    }
    catch (error) { checkAbort(callerSignal); diagnostics.push(diagnose('teams', error)); }
    const notifications: Notification[] = [];
    let pages = 0;
    let complete = false;
    let received = 0;
    for (let page = 1; page <= LIMITS.notificationPages; page++) {
      try {
        checkAbort(signal);
        const response = await this.api.request('GET', `/notifications?all=true&per_page=50&page=${page}`, signal);
        requireStatus(response);
        const batch = parse(z.array(z.unknown()).max(50), response.body);
        pages++;
        received += batch.length;
        for (const raw of batch) {
          const parsed = notificationSchema.safeParse(raw);
          if (!parsed.success) { diagnostics.push(diagnose('notifications', new ServiceError('invalid_output'))); continue; }
          if (!notifications.some(value => value.id === parsed.data.id)) notifications.push(parsed.data);
        }
        if (!pageLink(response, 'next', '/notifications')) { complete = true; break; }
      } catch (error) {
        checkAbort(callerSignal);
        if (!pages) throw error;
        diagnostics.push(diagnose('notifications', error));
        break;
      }
    }
    if (!complete || notifications.length > LIMITS.threads) {
      diagnostics.push(diagnose('notifications', new ServiceError('limit')));
      complete = false;
    }
    const selected = notifications.slice(0, LIMITS.threads);
    const collected: (Thread | undefined)[] = Array.from({ length: selected.length });
    let nextIndex = 0;
    const worker = async () => {
      while (!signal.aborted && nextIndex < selected.length) {
        const index = nextIndex++;
        const notification = selected[index]!;
        try {
          collected[index] = await this.enrich(notification, viewer, memberships, diagnostics, signal, callerSignal);
        } catch (error) {
          checkAbort(callerSignal);
          diagnostics.push(diagnose('thread', error, notification.id));
        }
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(LIMITS.enrichmentConcurrency, selected.length) }, worker));
    checkAbort(callerSignal);
    const failedWorker = workers.find(worker => worker.status === 'rejected');
    if (failedWorker?.status === 'rejected') throw failedWorker.reason;
    if (signal.aborted) {
      diagnostics.push(diagnose('thread', signal.reason));
      for (const notification of selected.slice(nextIndex)) {
        diagnostics.push(diagnose('thread', signal.reason, notification.id));
      }
    }
    const threads: Thread[] = [];
    let resultBytes = 0;
    for (const thread of collected) {
      if (!thread) continue;
      const bytes = Buffer.byteLength(JSON.stringify(thread));
      if (resultBytes + bytes > LIMITS.responseBytes * 0.8) {
        diagnostics.push(diagnose('notifications', new ServiceError('limit')));
        complete = false;
        break;
      }
      resultBytes += bytes;
      threads.push(thread);
    }
    const successfulEmpty = received === 0 && complete && !diagnostics.some(value => value.scope === 'notifications');
    if (!threads.length && !successfulEmpty) {
      const failure = signal.aborted ? 'deadline'
        : diagnostics.find(value => value.scope !== 'teams')?.code ?? 'unavailable';
      throw new ServiceError(failure, failure === 'deadline' || failure === 'unavailable' || failure === 'rate_limit');
    }
    return refreshSchema.parse({
      batchId: randomUUID(), fetchedAt: new Date().toISOString(), viewer,
      status: diagnostics.length ? 'partial' : 'complete', threads, diagnostics,
      coverage: {
        notifications: complete && !diagnostics.some(value => value.scope === 'notifications') ? 'complete' : 'partial',
        pages, received, returned: threads.length, missingMeansDone: false,
      },
    });
  }
  private async enrich(
    notification: Notification, viewer: string, memberships: Set<string> | null,
    diagnostics: Diagnostic[], signal: AbortSignal, callerSignal: AbortSignal,
  ): Promise<Thread> {
    const reference = sourceReference(notification);
    const root = `/repos/${reference.repo}`;
    const observedAt = new Date().toISOString();
    const response = await this.api.request('GET', `${root}/${reference.kind === 'pr' ? 'pulls' : 'issues'}/${reference.number}`, signal);
    requireStatus(response);
    const source = parse(sourceSchema, response.body);
    if (source.number !== reference.number) throw new ServiceError('invalid_output');
    let sourceState: Thread['sourceState'] = {
      state: source.merged ? 'merged' : source.state, observedAt, updatedAt: source.updated_at ?? null, error: null,
    };
    if (reference.kind === 'pr' && sourceState.state === 'open') {
      const checkedAt = new Date().toISOString();
      try {
        checkAbort(signal);
        const current = await this.api.request('POST', '/graphql', signal, { query: pullRequestStateQuery(reference) });
        requireStatus(current);
        const envelope = parse(z.object({ errors: z.array(z.object({
          type: z.string().optional(), extensions: z.object({ code: z.string().optional() }).optional(),
        })).optional(), data: z.unknown().optional() }), current.body);
        if (envelope.errors?.length) {
          const kinds = envelope.errors.map(error => error.type ?? error.extensions?.code);
          throw new ServiceError(kinds.some(kind => kind === 'FORBIDDEN' || kind === 'NOT_FOUND') ? 'access'
            : kinds.some(kind => kind === 'undefinedField' || kind === 'GRAPHQL_VALIDATION_FAILED') ? 'unsupported' : 'unavailable');
        }
        const data = parse(z.object({ repository: z.object({ pullRequest: z.object({
          state: z.enum(['OPEN', 'CLOSED', 'MERGED']), updatedAt: time,
          mergeQueueEntry: z.object({ id: z.string().min(1).max(200) }).nullable(),
        }) }) }), envelope.data).repository.pullRequest;
        sourceState = {
          state: data.state === 'MERGED' ? 'merged' : data.state === 'CLOSED' ? 'closed' : data.mergeQueueEntry ? 'queued' : 'open',
          updatedAt: data.updatedAt, observedAt: checkedAt, error: null,
        };
      } catch (error) {
        checkAbort(callerSignal);
        const failure = sanitized(error);
        sourceState = { state: 'unknown', updatedAt: null, observedAt: checkedAt,
          error: { ...failure, message: `Current PR state / merge queue is unknown. ${failure.message}`.slice(0, 300) } };
        diagnostics.push({ scope: 'source-state', threadId: notification.id, code: failure.code, message: sourceState.error!.message });
      }
    }
    let coverage: Thread['coverage'] = { timeline: 'unavailable', newestPage: 0, fetchedPages: [], observedAt };
    let evidence: Evidence[] = [];
    try {
      checkAbort(signal);
      const path = `${root}/issues/${reference.number}/timeline`;
      const first = await this.api.request('GET', `${path}?per_page=100&page=1`, signal);
      requireStatus(first);
      const last = pageLink(first, 'last', path) ?? 1;
      if (last === 1 && pageLink(first, 'next', path)) throw new ServiceError('invalid_output');
      let raw = parse(z.array(z.unknown()).max(100), first.body);
      const fetchedPages = [1];
      if (last > 1) {
        const newest = await this.api.request('GET', `${path}?per_page=100&page=${last}`, signal);
        requireStatus(newest);
        const tail = parse(z.array(z.unknown()).max(100), newest.body);
        // Keep only contiguous newest coverage. A gap must not promote an older request.
        raw = last === 2 ? [...raw, ...tail] : tail;
        if (last > 2) fetchedPages.length = 0;
        fetchedPages.push(last);
        if (pageLink(newest, 'next', path)) throw new ServiceError('unavailable', true);
      }
      const parsed: SourceEvent[] = [];
      let invalid = false;
      for (const value of raw) {
        const result = eventSchema.safeParse(value);
        if (result.success) parsed.push(result.data);
        else invalid = true;
      }
      const classified = classifyEvents(parsed, reference, source, viewer, memberships);
      evidence = classified.evidence;
      coverage = { timeline: last > 2 || invalid || classified.omitted ? 'partial' : 'complete', newestPage: last, fetchedPages, observedAt };
      if (invalid || classified.omitted) {
        for (const event of evidence) {
          if (event.requestState === 'current') event.requestState = 'uncertain';
        }
      }
      if (coverage.timeline === 'partial') diagnostics.push(diagnose('timeline', new ServiceError('limit'), notification.id));
    } catch (error) {
      checkAbort(callerSignal);
      diagnostics.push(diagnose('timeline', error, notification.id));
    }
    let subscription: Thread['subscription'] = 'unknown';
    try {
      checkAbort(signal);
      const subscriptionResponse = await this.api.request('GET', `/notifications/threads/${notification.id}/subscription`, signal);
      requireStatus(subscriptionResponse);
      const value = parse(z.object({ subscribed: z.boolean(), ignored: z.boolean() }), subscriptionResponse.body);
      subscription = value.ignored ? 'unsubscribed' : value.subscribed ? 'subscribed' : 'unknown';
    } catch (error) {
      checkAbort(callerSignal);
      diagnostics.push(diagnose('subscription', error, notification.id));
    }
    return {
      id: notification.id, reference, title: source.title.slice(0, 500),
      reason: notification.reason, notification: notification.unread ? 'unread' : 'read',
      updatedAt: notification.updated_at, lastReadAt: notification.last_read_at,
      state: source.merged ? 'merged' : source.state,
      size: source.additions !== undefined && source.deletions !== undefined && source.changed_files !== undefined
        ? { additions: source.additions, deletions: source.deletions, changedFiles: source.changed_files } : null,
      subscription, evidence, coverage, sourceState,
    };
  }
  async write(action: 'acknowledge' | 'unsubscribe', input: z.infer<typeof writeInputSchema>, signal: AbortSignal) {
    const value = parse(writeInputSchema, input);
    const context = JSON.stringify({ action, ...value });
    const existing = this.writes.get(value.operationId);
    if (existing) {
      if (existing.context !== context) throw new ServiceError('invalid_input');
      return existing.result;
    }
    if (this.writes.size >= 4096) throw new ServiceError('limit');
    const result = this.performWrite(action, value, signal);
    this.writes.set(value.operationId, { context, result });
    try { return await result; }
    catch (error) { this.writes.delete(value.operationId); throw error; }
  }
  private async performWrite(action: 'acknowledge' | 'unsubscribe', value: z.infer<typeof writeInputSchema>, signal: AbortSignal) {
    const endpoint = `/notifications/threads/${value.threadId}`;
    const before = await this.api.request('GET', endpoint, signal);
    requireStatus(before);
    const notification = parse(notificationSchema, before.body);
    const reference = sourceReference(notification);
    if (notification.id !== value.threadId || !same(reference.repo, value.reference.repo)
      || reference.number !== value.reference.number || reference.kind !== value.reference.kind) {
      throw new ServiceError('invalid_input');
    }
    checkAbort(signal);
    if (action === 'acknowledge') {
      if (value.notificationUpdatedAt && Date.parse(notification.updated_at) > Date.parse(value.notificationUpdatedAt)) {
        throw new ServiceError('source_changed');
      }
      requireStatus(await this.api.request('DELETE', endpoint, signal), 204);
    } else {
      const response = await this.api.request('PUT', `${endpoint}/subscription`, signal, { ignored: true });
      requireStatus(response);
      const subscription = parse(z.object({ ignored: z.boolean() }), response.body);
      if (!subscription.ignored) throw new ServiceError('invalid_output');
    }
    return writeResultSchema.parse({ ...value, action, status: 'confirmed', confirmedAt: new Date().toISOString() });
  }
}
