import { describe, expect, test } from 'bun:test';
import { WorkGitHub } from '../src/work-github.ts';
import { defaultWorkState, githubWorkActionSchema, workMetadataSchema, workSettingsSchema, workstreamSchema, type Workstream } from '../src/work-schema.ts';
import type { Runner } from '../src/process.ts';
import type { CopilotService } from '../src/copilot.ts';
import { LIMITS } from '../src/schema.ts';
import { ServiceError } from '../src/errors.ts';

const at = '2026-09-01T12:00:00Z';
const requestedAt = '2026-09-10T12:00:00Z';
const url = 'https://github.com/octo/repo/pull/12';
const head = 'a'.repeat(40);
const stream: Workstream = { ...defaultWorkState().settings.streams[0]!, id: 'reviews' };
const root = {
  id: 12, number: 12, title: 'A source PR', state: 'open', created_at: at, updated_at: requestedAt,
  requested_reviewers: [{ login: 'viewer' }], requested_teams: [], draft: false,
};
const reviewEvent = {
  id: 101, event: 'review_requested', created_at: requestedAt, requested_reviewer: { login: 'viewer' },
};
const graph = {
  state: 'OPEN', mergeQueueEntry: null, headRefOid: head,
  isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  commits: { nodes: [{ commit: { committedDate: at, statusCheckRollup: null } }] },
};
function harness(options: {
  root?: object; graph?: object; events?: unknown[]; matches?: boolean; total?: number;
  failGraph?: boolean; failAuth?: boolean; extraKnown?: boolean; lastPage?: number;
  failTimeline?: boolean;
  copilot?: Pick<CopilotService, 'extractReplies'>;
} = {}) {
  const calls: { args: string[]; body?: string }[] = [];
  const response = (body: unknown, headers = '', status = 200) => ({
    code: status < 400 ? 0 : 1,
    stdout: `HTTP/2 ${status} OK\r\n${headers}\r\n\r\n${JSON.stringify(body)}`,
  });
  const runner: Runner = async (_, args, signal, body) => {
    expect(signal.aborted).toBe(false);
    calls.push({ args, body });
    const path = args.find(arg => arg.startsWith('/'))!;
    if (path === '/user') return response({ login: 'viewer' }, '', options.failAuth ? 401 : 200);
    if (path.startsWith('/search/issues?')) return response({
      total_count: options.total ?? (options.matches === false ? 0 : 1), incomplete_results: false,
      items: options.matches === false ? [] : [{ number: 12, html_url: url }],
    });
    if (path === '/repos/octo/repo/pulls/12') return response(options.root ?? root);
    if (path === '/repos/octo/repo/issues/12') return response({ ...root, pull_request: { html_url: url } });
    if (path === '/repos/octo/repo/issues/99') return response({ id: 99, number: 99, title: 'Gone from search', state: 'closed', created_at: at });
    if (path === '/graphql') {
      if ('variables' in JSON.parse(body!)) expect(JSON.parse(body!).variables).toEqual({ owner: 'octo', name: 'repo', number: 12 });
      return response(options.failGraph ? { errors: [{ message: 'private upstream data' }] } : {
        data: { repository: { pullRequest: options.graph ?? graph } },
      });
    }
    if (path.startsWith('/repos/octo/repo/issues/12/timeline')) {
      if (options.failTimeline) return response({}, '', 403);
      const headers = options.lastPage && path.endsWith('page=1')
        ? `Link: <https://api.github.com/repos/octo/repo/issues/12/timeline?per_page=100&page=${options.lastPage}>; rel="last"` : '';
      return response(options.events ?? [reviewEvent], headers);
    }
    throw new Error(`Unexpected path ${path}`);
  };
  return { calls, service: new WorkGitHub({ runner, resolve: async () => '/synthetic/gh', now: () => new Date('2026-09-16T12:00:00Z'), copilot: options.copilot }) };
}
const input = (override: Partial<Workstream> = {}) => ({ stream: { ...stream, ...override }, model: '', since: null });
const signal = () => new AbortController().signal;

function issues(options: {
  total: number; incomplete?: boolean; overlap?: boolean; body?: string;
  copilot?: Pick<CopilotService, 'extractReplies'>;
}) {
  const pages: number[] = [];
  const issueUrl = (number: number) => `https://github.com/octo/repo/issues/${number}`;
  const runner: Runner = async (_, args) => {
    const path = args.find(arg => arg.startsWith('/'))!;
    let body: unknown;
    if (path === '/user') body = { login: 'viewer' };
    else if (path.startsWith('/search/issues?')) {
      const params = new URL(`https://api.github.com${path}`).searchParams;
      expect(params.get('per_page')).toBe('100');
      const page = Number(params.get('page'));
      pages.push(page);
      const start = (page - 1) * 100;
      body = {
        total_count: options.total, incomplete_results: options.incomplete ?? false,
        items: Array.from({ length: Math.min(100, Math.max(0, options.total - start)) }, (_, index) => {
          const number = options.overlap && page === 2 && index === 0 ? 1 : start + index + 1;
          return { number, html_url: issueUrl(number) };
        }),
      };
    } else {
      const match = /^\/repos\/octo\/repo\/issues\/(\d+)(\/timeline\?per_page=100&page=1)?$/.exec(path);
      if (!match) throw new Error(`Unexpected path: ${path}`);
      const number = Number(match[1]);
      body = match[2] ? [{
        id: number, event: 'commented', created_at: requestedAt,
        html_url: `${issueUrl(number)}#issuecomment-${number}`, body: options.body ?? '@viewer please clarify.',
      }] : { id: number, number, title: `Issue ${number}`, state: 'open', created_at: at };
    }
    return { code: 0, stdout: `HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}` };
  };
  return { pages, issueUrl, service: new WorkGitHub({ runner, resolve: async () => '/synthetic/gh', copilot: options.copilot }) };
}

describe('saved GitHub workstream reads', () => {
  test.each([0, 50, 51, 92, 100, 101, 200, 201, 400])('collects up to 200 of %i issues without false cap warnings', async total => {
    const { service, pages, issueUrl } = issues({ total });
    const result = await service.collect(input({ action: 'implement', query: 'repo:octo/repo is:issue no:assignee' }), signal());
    const count = Math.min(total, 200);
    expect(result.candidates.map(candidate => candidate.url).sort()).toEqual(
      Array.from({ length: count }, (_, index) => issueUrl(index + 1)).sort(),
    );
    expect(result.observations).toHaveLength(count);
    expect(pages).toEqual(total > 100 ? [1, 2] : [1]);
    expect(result.warnings).toEqual(total > 200
      ? ['GitHub search is capped at 200 matches. Missing matches are not completion.'] : []);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LIMITS.responseBytes);
  });
  test('overlapping pages dedupe candidates and incomplete search results stay visible', async () => {
    for (const options of [{ total: 150, overlap: true }, { total: 92, incomplete: true }]) {
      const result = await issues(options).service.collect(input({ action: 'implement' }), signal());
      expect(result.candidates).toHaveLength(options.overlap ? 149 : 92);
      expect(new Set(result.candidates.map(candidate => candidate.url)).size).toBe(result.candidates.length);
      expect(result.warnings.join(' ')).toContain('incomplete results');
    }
  });
  test('200 matches retain another 100 tracked observations outside the query', async () => {
    const { service, issueUrl } = issues({ total: 200 });
    const result = await service.collect({
      ...input({ action: 'implement' }),
      knownUrls: Array.from({ length: 100 }, (_, index) => issueUrl(index + 201)),
    }, signal());
    expect(result.candidates).toHaveLength(200);
    expect(result.observations).toHaveLength(300);
    expect(result.observations.some(observation => observation.url === issueUrl(300))).toBe(true);
    expect(result.warnings).toEqual([]);
  });
  test('37 reply sources share one model call and retain their own source identities', async () => {
    let calls = 0;
    const { service, issueUrl } = issues({ total: 37, copilot: {
      extractReplies: async data => {
        calls++;
        expect(data.messages).toHaveLength(37);
        return { requests: [...data.messages].reverse().map(message => ({
          ...message, title: `Reply ${message.eventId}`, summary: 'An explicit question.', action: 'reply', targetUrl: null,
        })), warnings: [] };
      },
    } });
    const result = await service.collect(input({ action: 'reply', query: 'is:issue mentions:@me' }), signal());
    expect(calls).toBe(1);
    expect(result.candidates).toHaveLength(37);
    for (let number = 1; number <= 37; number++) {
      expect(result.candidates.find(candidate => candidate.url === issueUrl(number))!.evidence[0]).toMatchObject({
        id: `github:octo/repo:${number}:commented:${number}`,
        at: requestedAt, url: `${issueUrl(number)}#issuecomment-${number}`,
      });
    }
    expect(result.warnings).toEqual([]);
  });
  test('reply batches respect UTF-8 byte limits and a rejected batch does not discard other discoveries', async () => {
    const seen: string[] = [];
    let calls = 0;
    const { service } = issues({ total: 37, body: '界'.repeat(1900), copilot: {
      extractReplies: async data => {
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(LIMITS.modelBytes);
        seen.push(...data.messages.map(message => message.eventId));
        if (++calls === 1) throw new ServiceError('copilot_output');
        return { requests: data.messages.map(message => ({
          ...message, title: 'Reply to the question', summary: 'A question.', action: 'reply', targetUrl: null,
        })), warnings: [] };
      },
    } });
    const result = await service.collect(input({ action: 'reply' }), signal());
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
    expect(new Set(seen).size).toBe(37);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThan(37);
    expect(result.observations).toHaveLength(37);
    expect(result.warnings.join(' ')).toContain('Reply extraction failed');
  });
  test('unsupported GitHub review-result action fails explicitly before any source request', async () => {
    const { service, calls } = harness();
    await expect(service.collect(input({ action: 'review-result' }), signal()))
      .rejects.toMatchObject({ dto: { code: 'invalid_input' } });
    expect(calls).toEqual([]);
  });
  test('settings reject GitHub review-result at the action field but retain manual and MCP support', () => {
    const invalid = workSettingsSchema.safeParse({
      ...defaultWorkState().settings, streams: [{ ...stream, action: 'review-result' }],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]!.path).toEqual(['streams', 0, 'action']);
      expect(invalid.error.issues[0]!.message).toContain('Choose a supported GitHub action');
    }
    for (const action of githubWorkActionSchema.options) {
      expect(workstreamSchema.safeParse({ ...stream, action }).success).toBe(true);
    }
    for (const kind of ['slack', 'mcp']) {
      expect(workstreamSchema.safeParse({ ...stream, kind, action: 'review-result' }).success).toBe(true);
    }
  });
  test('availability observation time is optional for old metadata and validated when present', () => {
    const metadata = {
      identity: `${url}:review`, action: 'review', url, evidence: [], handledEvidenceIds: [],
      availability: 'waiting', availabilityReason: 'Queued',
    };
    expect(workMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(workMetadataSchema.parse({ ...metadata, availabilityObservedAt: requestedAt }).availabilityObservedAt).toBe(requestedAt);
    expect(workMetadataSchema.safeParse({ ...metadata, availabilityObservedAt: 'yesterday' }).success).toBe(false);
  });
  test('search uses argv encoded data, @me, open/archived qualifiers, and never notifications', async () => {
    const { service, calls } = harness();
    const query = 'is:pr assignee:@me $(touch secret) ; --repo=other';
    const result = await service.collect(input({ query }), signal());
    const search = calls.find(call => call.args.some(arg => arg.startsWith('/search/issues?')))!;
    const endpoint = search.args.find(arg => arg.startsWith('/search/issues?'))!;
    expect(new URL(`https://api.github.com${endpoint}`).searchParams.get('q')).toBe(`${query.replace('@me', 'viewer')} is:open archived:false`);
    expect(search.args).not.toContain('--repo=other');
    expect(JSON.stringify(calls)).not.toContain('/notifications');
    expect(result.candidates[0]!.evidence[0]).toMatchObject({
      id: 'github:octo/repo:12:review_requested:101', at: requestedAt,
    });
  });
  test('immutable review evidence survives changed updatedAt, comments, commits, query name and repeated runs', async () => {
    const first = await harness().service.collect(input(), signal());
    const changed = harness({
      root: { ...root, updated_at: '2026-09-16T10:00:00Z' },
      graph: { ...graph, headRefOid: 'b'.repeat(40) },
      events: [reviewEvent, { id: 102, event: 'commented', created_at: '2026-09-16T10:00:00Z', body: 'pushed a commit' }],
    });
    const later = await changed.service.collect(input({ name: 'Renamed', id: 'different-stream', query: 'is:pr repo:octo/repo' }), signal());
    expect(later.candidates[0]!.evidence.map(event => [event.id, event.at]))
      .toEqual(first.candidates[0]!.evidence.map(event => [event.id, event.at]));
    expect(first.candidates[0]!.evidence[0]!.id).not.toContain(stream.id);
  });
  test('new actual review request changes identity/time; removed request does not stay actionable', async () => {
    const newEvent = { ...reviewEvent, id: 103, created_at: '2026-09-15T12:00:00Z' };
    const result = await harness({ events: [reviewEvent, { ...reviewEvent, event: 'review_request_removed', id: 102 }, newEvent] })
      .service.collect(input(), signal());
    expect(result.candidates[0]!.evidence[0]).toMatchObject({ id: 'github:octo/repo:12:review_requested:103', at: newEvent.created_at });
    expect((await harness({ root: { ...root, requested_reviewers: [] } }).service.collect(input(), signal())).candidates).toEqual([]);
  });
  test('fallback request identity/time use source evidence, never collection time or query', async () => {
    const first = await harness({ events: [] }).service.collect(input(), signal());
    const second = await harness({ events: [], root: { ...root, updated_at: '2026-09-16T12:00:00Z' } })
      .service.collect(input({ id: 'new-stream', name: 'New', query: 'is:pr review-requested:@me' }), signal());
    const a = first.candidates[0]!.evidence[0]!;
    const b = second.candidates[0]!.evidence[0]!;
    expect([a.id, a.at]).toEqual([b.id, b.at]);
    expect(a.at).toBe(at);
    expect(first.warnings.join(' ')).toContain('original request event');
  });
  test('only a direct viewer or explicitly selected current team request qualifies', async () => {
    const teams = { ...root, requested_reviewers: [{ login: 'someone-else' }], requested_teams: [{ slug: 'reviewers' }] };
    expect((await harness({ root: teams }).service.collect(input(), signal())).candidates).toEqual([]);
    const result = await harness({ root: teams, events: [{
      id: 303, event: 'review_requested', created_at: requestedAt, requested_team: { slug: 'reviewers' },
    }] }).service.collect(input({ query: 'team-review-requested:octo/reviewers' }), signal());
    expect(result.candidates[0]!.evidence[0]!.id).toBe('github:octo/repo:12:review_requested:303');
  });
  test('tracked URLs get closed/queued/merged/unknown observations even outside query', async () => {
    for (const [change, state] of [
      [{ mergeQueueEntry: { id: 'queue-id' } }, 'queued'], [{ state: 'MERGED' }, 'merged'], [{ state: 'CLOSED' }, 'closed'],
    ] as const) {
      const result = await harness({ graph: { ...graph, ...change }, matches: false }).service.collect({ ...input(), knownUrls: [url] }, signal());
      expect(result.observations[0]!.state).toBe(state);
      expect(result.candidates).toEqual([]);
    }
    const unknown = await harness({ failGraph: true }).service.collect(input(), signal());
    expect(unknown.observations[0]!.state).toBe('unknown');
    expect(unknown.candidates).toEqual([]);
    expect(JSON.stringify(unknown)).not.toContain('private upstream data');
    const gone = await harness({ matches: false }).service.collect({ ...input(), knownUrls: ['https://github.com/octo/repo/issues/99'] }, signal());
    expect(gone.observations[0]!.state).toBe('closed');
    const closed = harness({ root: { ...root, state: 'closed', merged: true }, failGraph: true });
    const closedResult = await closed.service.collect(input(), signal());
    expect(closedResult.observations[0]!.state).toBe('merged');
    expect(closed.calls.some(call => call.args.includes('/graphql'))).toBe(false);
    const noTimeline = await harness({ failTimeline: true }).service.collect(input(), signal());
    expect(noTimeline.observations).toHaveLength(1);
    expect(noTimeline.observations[0]!.state).toBe('open');
    expect(noTimeline.candidates).toEqual([]);
    expect(noTimeline.warnings).toHaveLength(1);
  });
  test('fixes use actual head/check identity and actual completion time, not PR updatedAt', async () => {
    const check = {
      __typename: 'CheckRun', id: 'check-1', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED',
      completedAt: requestedAt, startedAt: at,
    };
    const failingGraph = {
      ...graph, commits: { nodes: [{ commit: { committedDate: at, statusCheckRollup: {
        contexts: { nodes: [check], pageInfo: { hasNextPage: false } },
      } } }] },
    };
    const a = await harness({ graph: failingGraph }).service.collect(input({ action: 'fix' }), signal());
    const b = await harness({ graph: failingGraph, root: { ...root, updated_at: '2026-09-16T12:00:00Z' } })
      .service.collect(input({ action: 'fix' }), signal());
    expect(a.candidates[0]!.evidence).toEqual(b.candidates[0]!.evidence);
    expect(a.candidates[0]!.evidence[0]!.at).toBe(requestedAt);
    const fresh = await harness({ graph: { ...failingGraph, headRefOid: 'c'.repeat(40) } }).service.collect(input({ action: 'fix' }), signal());
    expect(fresh.candidates[0]!.evidence[0]!.id).not.toBe(a.candidates[0]!.evidence[0]!.id);
    expect((await harness().service.collect(input({ action: 'fix' }), signal())).candidates).toEqual([]);
  });
  test('search and history caps remain explicit; authentication fails rather than empty success', async () => {
    const result = await harness({ total: 400, lastPage: 5 }).service.collect(input(), signal());
    expect(result.warnings.join(' ')).toContain('incomplete results');
    expect(result.warnings.join(' ')).toContain('timeline is capped');
    await expect(harness({ failAuth: true }).service.collect(input(), signal())).rejects.toMatchObject({ dto: { code: 'authentication' } });
  });
  test('merge needs actual approval, mergeability, and complete passing check coverage', async () => {
    const approved = { ...graph, reviewDecision: 'APPROVED' };
    const ready = await harness({ graph: approved }).service.collect(input({ action: 'merge' }), signal());
    expect(ready.candidates[0]!.action).toBe('merge');
    const pending = { ...approved, commits: { nodes: [{ commit: { committedDate: at, statusCheckRollup: {
      contexts: { nodes: [{ __typename: 'CheckRun', id: 'pending', name: 'CI', status: 'IN_PROGRESS',
        conclusion: null, completedAt: null, startedAt: at }], pageInfo: { hasNextPage: false } },
    } } }] } };
    expect((await harness({ graph: pending }).service.collect(input({ action: 'merge' }), signal())).candidates).toEqual([]);
    const capped = { ...approved, commits: { nodes: [{ commit: { committedDate: at, statusCheckRollup: {
      contexts: { nodes: [], pageInfo: { hasNextPage: true } },
    } } }] } };
    const partial = await harness({ graph: capped }).service.collect(input({ action: 'merge' }), signal());
    expect(partial.candidates).toEqual([]);
    expect(partial.warnings.join(' ')).toContain('checks are capped');
  });
  test('linked MCP targets and canonical /issues PR identities receive real queue observations without searches', async () => {
    const { service, calls } = harness({ graph: { ...graph, mergeQueueEntry: { id: 'queue' } } });
    const result = await service.observe([url, 'https://github.com/octo/repo/issues/12', 'https://example.slack.com/archives/C123/p1757505600000000'], signal());
    expect(result.map(observation => observation.state)).toEqual(['queued']);
    expect(calls.some(call => call.args.some(arg => arg.startsWith('/search/issues?')))).toBe(false);
    expect(calls.filter(call => call.args.includes('/repos/octo/repo/pulls/12'))).toHaveLength(1);
    const canonical = await service.observe(['https://github.com/octo/repo/issues/12'], signal());
    expect(canonical[0]!.state).toBe('queued');
    expect(calls.some(call => call.args.includes('/repos/octo/repo/issues/12'))).toBe(true);
    const unknown = await harness({ failGraph: true }).service.observe([url], signal());
    expect(unknown[0]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('denied access') });
    const knownCanonical = await harness({ matches: false }).service.collect({
      ...input(), knownUrls: ['https://github.com/octo/repo/issues/12'],
    }, signal());
    expect(knownCanonical.observations[0]!.state).toBe('open');
  });
  test('GitHub reply extraction uses actual immutable comments and explicit truncation warnings', async () => {
    const commentUrl = `${url}#issuecomment-500`;
    const { service } = harness({
      events: [{ id: 500, event: 'commented', body: '@viewer please clarify.\n' + 'x'.repeat(2100), created_at: requestedAt, html_url: commentUrl }],
      copilot: { extractReplies: async (data, model) => {
        expect(data.viewer).toBe('viewer');
        expect(model).toBe('');
        expect(data.messages[0]).toMatchObject({
          eventId: 'github:octo/repo:12:commented:500', sourceTimestamp: requestedAt, sourceUrl: commentUrl,
        });
        expect(data.messages[0]!.body).toHaveLength(2000);
        return { requests: [{ ...data.messages[0]!, title: 'Reply to clarification', action: 'reply',
          targetUrl: null, summary: 'The viewer was asked for clarification.' }], warnings: [] };
      } },
    });
    const result = await service.collect(input({ action: 'reply' }), signal());
    expect(result.candidates[0]!.evidence[0]).toMatchObject({
      id: 'github:octo/repo:12:commented:500', at: requestedAt, url: commentUrl,
    });
    expect(result.warnings.join(' ')).toContain('context may be incomplete');
  });
});
