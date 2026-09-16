import { describe, expect, test } from 'bun:test';
import { WorkGitHub } from '../src/work-github.ts';
import { defaultWorkState, githubWorkActionSchema, workMetadataSchema, workSettingsSchema, workstreamSchema, type Workstream } from '../src/work-schema.ts';
import type { Runner } from '../src/process.ts';
import type { CopilotService } from '../src/copilot.ts';

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

describe('saved GitHub workstream reads', () => {
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
    expect(result.warnings.join(' ')).toContain('capped at 50');
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
