import { describe, expect, test } from 'bun:test';
import { WorkGitHub } from '../src/work-github.ts';
import { WorkService } from '../src/work.ts';
import { ServiceError } from '../src/errors.ts';
import { LIMITS } from '../src/schema.ts';
import type { CopilotService } from '../src/copilot.ts';
import type { Runner } from '../src/process.ts';
import { githubWorkActionSchema, type Workstream } from '../src/work-schema.ts';

const at = '2026-08-20T12:00:00Z';
const requestedAt = '2026-09-10T12:00:00Z';
const now = '2026-09-17T12:00:00Z';
const url = 'https://github.com/octo/repo/issues/12';
const stream: Workstream = {
  id: 'notifications', name: 'GitHub notifications', kind: 'github-notifications',
  query: 'Inspect notifications for requests', action: 'follow-up', enabled: true, tools: [], server: '',
};
const input = () => ({ stream, model: 'chosen-model', since: null as string | null });
const signal = () => new AbortController().signal;
const source = {
  id: 12, number: 12, title: 'A source issue', body: '', user: { login: 'owner' },
  state: 'open', created_at: at, updated_at: now, assignees: [],
  requested_reviewers: [], requested_teams: [],
};
const graph = {
  state: 'OPEN', mergeQueueEntry: null, headRefOid: 'a'.repeat(40), isDraft: false,
  mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  commits: { nodes: [{ commit: { committedDate: at, statusCheckRollup: null } }] },
};
const notification = (number = 12, type = 'Issue') => ({
  id: String(number), repository: { full_name: 'octo/repo', archived: false },
  subject: { type, title: 'Notification title is not the source', url: `https://api.github.com/repos/octo/repo/${type === 'PullRequest' ? 'pulls' : 'issues'}/${number}` },
  reason: 'mention', unread: false, updated_at: now, last_read_at: now,
});
const comment = (id = 50, body = '@viewer please clarify.', author = 'requester') => ({
  id, event: 'commented', created_at: requestedAt, body, user: { login: author },
  html_url: `${url}#issuecomment-${id}`,
});
type Extraction = CopilotService['extractGitHubRequests'];
function harness(options: {
  notifications?: unknown[][]; infinitePages?: boolean; source?: object; graph?: object;
  events?: unknown[]; reviews?: unknown[]; inline?: unknown[]; teams?: unknown[][];
  sourceFor?: (number: number) => object; eventsFor?: (number: number) => unknown[];
  extract?: Extraction; fail?: string; failStatus?: number;
  clock?: () => Date; timelineLast?: number; discussionLast?: number;
  onNotifications?: (params: URLSearchParams) => void; failNotificationProbe?: number;
} = {}) {
  const calls: string[] = [];
  const extracted: Parameters<Extraction>[0][] = [];
  let notificationProbes = 0;
  const response = (body: unknown, headers = '', status = 200) => ({
    code: status < 400 ? 0 : 1,
    stdout: `HTTP/2 ${status} OK\r\n${headers}\r\n\r\n${JSON.stringify(body)}`,
  });
  const runner: Runner = async (_, args, _signal, body) => {
    const path = args.find(arg => arg.startsWith('/'))!;
    calls.push(path);
    if (options.fail && path.startsWith(options.fail)) return response({}, '', options.failStatus ?? 403);
    if (path === '/user') return response({ login: 'viewer' });
    if (path.startsWith('/notifications?')) {
      const params = new URL(`https://api.github.com${path}`).searchParams;
      const page = Number(params.get('page'));
      if (++notificationProbes === options.failNotificationProbe) return response({}, '', 403);
      options.onNotifications?.(params);
      const rows = (options.notifications ?? [[notification()]]).flat().filter(row => {
        const updated = row && typeof row === 'object' && 'updated_at' in row ? Date.parse(String(row.updated_at)) : NaN;
        return !Number.isFinite(updated) || updated > Date.parse(params.get('since')!) && updated < Date.parse(params.get('before')!);
      }).sort((a, b) => {
        const timestamp = (row: unknown) => row && typeof row === 'object' && 'updated_at' in row ? String(row.updated_at) : '';
        return timestamp(b).localeCompare(timestamp(a));
      });
      const next = options.infinitePages || page * 50 < rows.length
        ? `Link: <https://api.github.com/notifications?page=${page + 1}>; rel="next"` : '';
      return response(rows.slice((page - 1) * 50, page * 50), next);
    }
    if (path.startsWith('/user/teams?')) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
      const pages = options.teams ?? [[]];
      return response(pages[page - 1], page < pages.length ? `Link: <https://api.github.com/user/teams?page=${page + 1}>; rel="next"` : '');
    }
    if (path.startsWith('/search/issues?')) return response({
      total_count: 1, incomplete_results: false, items: [{ number: 12, html_url: options.notifications?.[0]?.[0]
        && (options.notifications[0][0] as ReturnType<typeof notification>).subject.type === 'PullRequest' ? url.replace('/issues/', '/pull/') : url }],
    });
    if (path === '/graphql') {
      expect(body).toBeDefined();
      return response({ data: { repository: { pullRequest: options.graph ?? graph } } });
    }
    const match = /^\/repos\/octo\/repo\/(issues|pulls)\/(\d+)(?:\/(timeline|reviews|comments)\?per_page=100&page=(\d+))?$/.exec(path);
    if (!match) throw new Error(`Unexpected API request: ${path}`);
    const number = Number(match[2]);
    if (!match[3]) return response(options.sourceFor?.(number) ?? { ...source, ...options.source, number, id: number });
    const last = match[3] === 'timeline' ? options.timelineLast : options.discussionLast;
    const headers = last && match[4] === '1'
      ? `Link: <https://api.github.com/repos/octo/repo/${match[1]}/${number}/${match[3]}?per_page=100&page=${last}>; rel="last"` : '';
    return response(match[3] === 'timeline' ? options.eventsFor?.(number) ?? options.events ?? []
      : match[3] === 'reviews' ? options.reviews ?? [] : options.inline ?? [], headers);
  };
  const service = new WorkGitHub({
    runner, resolve: async () => '/synthetic/gh', now: options.clock ?? (() => new Date(now)),
    copilot: {
      extractReplies: async () => ({ requests: [], warnings: [] }),
      extractGitHubRequests: async (data, model, abort) => {
        extracted.push(data);
        expect(model).toBe('chosen-model');
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(LIMITS.workModelBytes);
        return options.extract?.(data, model, abort) ?? { requests: [], warnings: [] };
      },
    },
  });
  return { service, calls, extracted };
}
const requests = (data: Parameters<Extraction>[0], action: 'reply' | 'implement' = 'reply') => ({
  requests: data.sources.flatMap(source => source.messages.filter(message => message.kind === 'commented').map(message => ({
    ...message, title: 'An explicit request', summary: 'Please clarify.', targetUrl: null, action,
  }))), warnings: [],
});

describe('GitHub notification work discovery', () => {
  test('routes notifications to GitHub rather than MCP; observeOnly never repeats discovery', async () => {
    const seen: string[] = [];
    const service = new WorkService({ github: {
      collect: async () => { seen.push('collect'); return { candidates: [], observations: [], warnings: [], collectedAt: now }; },
      observe: async () => { seen.push('observe'); return []; },
    } });
    await service.collect(input(), signal());
    await service.collect({ ...input(), observeOnly: true }, signal());
    expect(seen).toEqual(['collect', 'observe']);
    const backend = harness();
    await backend.service.collect({ ...input(), observeOnly: true, knownUrls: [url] }, signal());
    expect(backend.calls.some(path => path.startsWith('/notifications'))).toBe(false);
  });
  test('includes read notifications, starts 30 days ago with overlap, and records scan START', async () => {
    let clock = 0;
    const { service, calls } = harness({ clock: () => new Date(Date.parse(now) + clock++ * 5000) });
    const result = await service.collect(input(), signal());
    const endpoint = calls.find(path => path.startsWith('/notifications?'))!;
    const params = new URL(`https://api.github.com${endpoint}`).searchParams;
    expect(params.get('all')).toBe('true');
    expect(params.get('per_page')).toBe('50');
    expect(params.get('since')).toBe('2026-08-18T11:59:59.000Z');
    expect(result.collectedAt).toBe('2026-09-17T12:00:00.000Z');
    expect(result.observations).toHaveLength(1);
    expect(calls.some(path => path.startsWith('/search/'))).toBe(false);
  });
  test('subsequent scans overlap last success and read one complete fixed notification window', async () => {
    const { service, calls } = harness({ notifications: [[notification()], [notification(13)], [notification(14)]] });
    const result = await service.collect({ ...input(), since: requestedAt }, signal());
    expect(result.observations).toHaveLength(3);
    const params = calls.filter(path => path.startsWith('/notifications?')).map(path => new URL(`https://api.github.com${path}`).searchParams);
    expect(params.map(value => value.get('page'))).toEqual(['1']);
    expect(params.every(value => value.get('since') === '2026-09-10T11:59:59.000Z' && value.get('all') === 'true')).toBe(true);
    expect(params.every(value => value.get('before') === '2026-09-17T12:00:01.000Z')).toBe(true);
  });
  test('sticky mention reasons are not actionable evidence or model input', async () => {
    const { service, extracted } = harness({ events: [comment(50, '@viewer FYI, this shipped.')] });
    const result = await service.collect(input(), signal());
    expect(result.candidates).toEqual([]);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(extracted)).not.toContain('last_read_at');
    expect(JSON.stringify(extracted)).not.toContain('updated_at');
    expect(result.warnings).toEqual([]);
  });
  test('grounded requests attach metadata and ORIGINAL evidence, never notification or model timestamps', async () => {
    const { service, extracted } = harness({
      events: [comment()], extract: async data => ({
        ...requests(data), requests: requests(data).requests.map(request => ({
          ...request, sourceTimestamp: now, sourceUrl: 'https://evil.example/invented',
        })),
      }),
    });
    const result = await service.collect(input(), signal());
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      url, action: 'reply',
      notification: { threadId: '12', reference: { repo: 'octo/repo', kind: 'issue', number: 12 }, updatedAt: now },
      evidence: [{ id: 'github:octo/repo:12:commented:50', at: requestedAt, url: `${url}#issuecomment-50` }],
    });
    expect(extracted[0]!.sources[0]).toMatchObject({ title: source.title, author: 'owner', assignees: [] });
    expect(extracted[0]!.sources[0]!.messages[1]!.author).toBe('requester');
  });
  test.each(['Issue', 'PullRequest'])('canonical notification references match %s candidate URLs', async type => {
    const thread = notification(12, type);
    const { service } = harness({
      notifications: [[{
        ...thread, repository: { ...thread.repository, full_name: 'Octo/Repo' },
        subject: { ...thread.subject, url: thread.subject.url.replace('octo/repo', 'Octo/Repo') },
      }]],
      events: [comment()], extract: async data => requests(data),
    });
    const result = await service.collect(input(), signal());
    const candidate = result.candidates[0]!;
    const ref = candidate.notification!.reference;
    expect(ref).toEqual({ repo: 'octo/repo', kind: type === 'PullRequest' ? 'pr' : 'issue', number: 12 });
    expect(candidate.url).toBe(`https://github.com/${ref.repo}/${ref.kind === 'pr' ? 'pull' : 'issues'}/${ref.number}`);
    expect(candidate.evidence[0]!.url).toBe(`${candidate.url}#issuecomment-50`);
    expect(result.warnings).toEqual([]);
  });
  test('description discovery retains original source time even when the description was edited today', async () => {
    const { service } = harness({
      source: { body: '@viewer please implement this.' },
      extract: async data => ({ requests: [{
        ...data.sources[0]!.messages[0]!, action: 'implement', title: 'Implement request', summary: 'An explicit ask.', targetUrl: null,
      }], warnings: [] }),
    });
    expect((await service.collect(input(), signal())).candidates[0]!.evidence[0]).toMatchObject({
      id: 'github:octo/repo:12:created:12', at, url,
    });
  });
  test('title-only requests are inspected and old evidence survives updated notification metadata', async () => {
    const evidence = [];
    for (const updated_at of [requestedAt, now]) {
      const { service, extracted } = harness({
        source: { title: '@viewer please implement a fix', body: '' },
        notifications: [[{ ...notification(), updated_at }]],
        extract: async data => ({ requests: [{
          ...data.sources[0]!.messages[0]!, action: 'implement', title: 'Implement a fix', summary: 'An explicit title ask.', targetUrl: null,
        }], warnings: [] }),
      });
      const result = await service.collect(input(), signal());
      expect(extracted[0]!.sources[0]!.title).toBe('@viewer please implement a fix');
      expect(result.candidates[0]!.notification!.updatedAt).toBe(updated_at);
      evidence.push(result.candidates[0]!.evidence);
    }
    expect(evidence[0]).toEqual(evidence[1]);
  });
  test('invalid subject identities warn; unsupported types and archives are neutral exclusions', async () => {
    const wrong = [
      'https://evil.example/repos/octo/repo/issues/12', 'https://api.github.com/repos/other/repo/issues/12',
      'https://api.github.com/repos/octo/repo/issues/12?token=x', 'https://api.github.com/repos/octo/repo/issues/../12',
      'https://api.github.com/repos/octo/repo/pulls/12', 'https://api.github.com/repos/octo/repo/issues/9007199254740992',
    ].map(value => ({ ...notification(), subject: { ...notification().subject, url: value }, latest_comment_url: 'https://evil.example/read' }));
    const { service, calls } = harness({ notifications: [[...wrong, notification(13, 'Discussion'), {
      ...notification(14), repository: { full_name: 'octo/repo', archived: true },
    }]] });
    const result = await service.collect(input(), signal());
    expect(result.candidates).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('invalid GitHub subject identity');
    expect(result.coverageInfo!.join(' ')).toContain('Unsupported GitHub notification subject type Discussion');
    expect(calls.filter(path => path.startsWith('/repos/'))).toEqual([]);
  });
  test('review and assignment evidence IDs match saved query collectors', async () => {
    for (const action of ['review', 'implement'] as const) {
      const isReview = action === 'review';
      const { service } = harness({
        notifications: [[notification(12, isReview ? 'PullRequest' : 'Issue')]],
        source: isReview ? { requested_reviewers: [{ login: 'viewer' }] } : { assignees: [{ login: 'viewer' }] },
        events: [{ id: 101, created_at: requestedAt, event: isReview ? 'review_requested' : 'assigned',
          ...(isReview ? { requested_reviewer: { login: 'viewer' } } : { assignee: { login: 'viewer' } }) }],
      });
      const discovered = await service.collect(input(), signal());
      const searched = await service.collect({ ...input(), stream: { ...stream, kind: 'github', action, query: 'repo:octo/repo' } }, signal());
      expect(discovered.candidates[0]!.action).toBe(action);
      expect(discovered.candidates[0]!.evidence).toEqual(searched.candidates[0]!.evidence);
      expect(discovered.candidates[0]!.notification).toBeDefined();
      expect(searched.candidates[0]!.notification).toBeUndefined();
    }
  });
  test('removed formal review requests and assignments never survive just because the notification persists', async () => {
    const { service } = harness({ notifications: [[notification(12, 'PullRequest')]], events: [
      { id: 101, event: 'review_requested', created_at: requestedAt, requested_reviewer: { login: 'viewer' } },
      { id: 102, event: 'assigned', created_at: requestedAt, assignee: { login: 'viewer' } },
    ] });
    expect((await service.collect(input(), signal())).candidates).toEqual([]);
  });
  test('only confirmed viewer teams qualify for review requests and team mentions', async () => {
    const team = { slug: 'reviewers', organization: { login: 'octo' } };
    for (const member of [true, false]) {
      const { service, extracted } = harness({
        notifications: [[notification(12, 'PullRequest')]], source: { requested_teams: [{ slug: 'reviewers' }] },
        teams: member ? [[], [team]] : [[]],
        events: [
          { id: 101, event: 'review_requested', created_at: requestedAt, requested_team: { slug: 'reviewers' } },
          comment(50, '@octo/reviewers please inspect.'),
        ],
      });
      const result = await service.collect(input(), signal());
      expect(result.candidates).toHaveLength(member ? 1 : 0);
      expect(extracted[0]!.teams).toEqual(member ? ['octo/reviewers'] : []);
    }
  });
  test('terminal and queued sources suppress ALL inference while read notifications remain discovery', async () => {
    for (const state of ['closed', 'merged', 'queued'] as const) {
      const { service, extracted, calls } = harness({
        notifications: [[notification(12, 'PullRequest')]],
        source: state === 'closed' ? { state: 'closed' } : {},
        graph: { ...graph, state: state === 'merged' ? 'MERGED' : 'OPEN', mergeQueueEntry: state === 'queued' ? { id: 'queue' } : null },
        events: [comment()], extract: async data => requests(data),
      });
      const result = await service.collect(input(), signal());
      expect(result.observations[0]!.state).toBe(state);
      expect(result.candidates).toEqual([]);
      expect(extracted).toEqual([]);
      expect(calls.some(path => path.includes('/timeline'))).toBe(false);
    }
  });
  test('PR fix/merge conditions only apply to the viewer-owned PR, not everybody’s CI', async () => {
    const failing = { ...graph, mergeable: 'CONFLICTING' };
    for (const owner of ['viewer', 'someone-else']) {
      const { service } = harness({
        notifications: [[notification(12, 'PullRequest')]], source: { user: { login: owner } }, graph: failing,
      });
      expect((await service.collect(input(), signal())).candidates.map(candidate => candidate.action)).toEqual(owner === 'viewer' ? ['fix'] : []);
      const ready = harness({
        notifications: [[notification(12, 'PullRequest')]], source: { user: { login: owner } },
        graph: { ...graph, reviewDecision: 'APPROVED' },
      });
      expect((await ready.service.collect(input(), signal())).candidates.map(candidate => candidate.action)).toEqual(owner === 'viewer' ? ['merge'] : []);
    }
  });
  test('whole source contexts include description, author, later answers, reviews and inline requests', async () => {
    const { service, extracted } = harness({
      notifications: [[notification(12, 'PullRequest')]], source: { body: 'Full source description' },
      events: [comment(), comment(51, 'Here is the answer.', 'viewer')],
      reviews: [{ id: 70, submitted_at: at, body: '@viewer please fix this.', user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }],
      inline: [{ id: 80, created_at: at, body: '@viewer can you explain this line?', user: { login: 'reviewer' }, html_url: 'https://evil.example/injected' }],
      extract: async data => {
        expect(data.sources).toHaveLength(1);
        expect(data.sources[0]!.messages.map(message => message.author)).toContain('viewer');
        return { requests: [], warnings: [] };
      },
    });
    expect((await service.collect(input(), signal())).candidates).toEqual([]);
    const messages = extracted[0]!.sources[0]!.messages;
    expect(messages[0]!.body).toBe('Full source description');
    expect(messages.find(message => message.kind === 'reviewed')).toMatchObject({
      eventId: 'github:octo/repo:12:reviewed:70', sourceTimestamp: at,
      sourceUrl: 'https://github.com/octo/repo/pull/12#pullrequestreview-70',
    });
    expect(messages.find(message => message.kind === 'review_comment')).toMatchObject({
      eventId: 'github:octo/repo:12:review_comment:80', sourceTimestamp: at,
      sourceUrl: 'https://github.com/octo/repo/pull/12#discussion_r80',
    });
  });
  test('empty later approvals and current review state remain context, never request evidence', async () => {
    const { service, extracted } = harness({
      notifications: [[notification(12, 'PullRequest')]], graph: { ...graph, reviewDecision: 'APPROVED' },
      reviews: [
        { id: 70, submitted_at: at, body: '@viewer please fix.', user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
        { id: 71, submitted_at: requestedAt, body: '', user: { login: 'reviewer' }, state: 'APPROVED' },
      ],
      extract: async data => ({
        requests: [{
          ...data.sources[0]!.messages.find(message => message.state === 'APPROVED')!,
          action: 'fix', title: 'Invented approval request', summary: 'Not an ask.', targetUrl: null,
        }], warnings: [],
      }),
    });
    const result = await service.collect(input(), signal());
    expect(extracted[0]!.sources[0]!.reviewDecision).toBe('APPROVED');
    expect(extracted[0]!.sources[0]!.messages.map(message => message.state)).toContain('APPROVED');
    expect(result.candidates).toEqual([]);
    expect(result.warnings.join(' ')).toContain('Request extraction failed');
  });
  test('unknown model refs, unsupported actions and viewer-authored evidence fail explicitly', async () => {
    for (const invalid of ['reference', 'action', 'author']) {
      const { service } = harness({
        events: [comment(), comment(51, 'My answer', 'viewer')],
        extract: async data => {
          const result = requests(data);
          const selected = result.requests[invalid === 'author' ? 1 : 0]!;
          return { requests: [{ ...selected, ...(invalid === 'reference' ? { eventId: 'invented' }
            : invalid === 'action' ? { action: 'review-result' as 'reply' } : {}) }], warnings: [] };
        },
      });
      const result = await service.collect(input(), signal());
      expect(result.candidates).toEqual([]);
      expect(result.warnings.join(' ')).toContain('Request extraction failed');
    }
  });
  test('authentication, source and model failures cannot look like complete empty scans', async () => {
    await expect(harness({ fail: '/notifications', failStatus: 401 }).service.collect(input(), signal()))
      .rejects.toMatchObject({ dto: { code: 'authentication' } });
    await expect(harness({
      notifications: [Array.from({ length: 80 }, (_, index) => notification(index + 1))], failNotificationProbe: 2,
    }).service.collect(input(), signal()))
      .rejects.toMatchObject({ dto: { code: 'access' } });
    const sourceFailure = await harness({ fail: '/repos/' }).service.collect(input(), signal());
    expect(sourceFailure.observations[0]!.state).toBe('unknown');
    expect(sourceFailure.warnings.length).toBeGreaterThan(0);
    await expect(harness({ events: [comment()], extract: async () => { throw new ServiceError('copilot_unavailable'); } }).service.collect(input(), signal()))
      .rejects.toMatchObject({ dto: { code: 'copilot_unavailable' } });
  });
  test('multiple saved runs process more than 200 sources oldest-first without losing source/action pairs', async () => {
    const rows = Array.from({ length: 240 }, (_, index) => ({
      ...notification(index + 1), updated_at: new Date(Date.parse(at) + index * 2 * 3600_000).toISOString(),
    }));
    const { service } = harness({
      notifications: [rows],
      sourceFor: number => ({ ...source, id: number, number, assignees: [{ login: 'viewer' }] }),
      eventsFor: number => [
        { id: number, event: 'assigned', created_at: at, assignee: { login: 'viewer' } },
        comment(number),
      ], extract: async data => ({
        requests: requests(data).requests.flatMap(request => githubWorkActionSchema.options.map(action => ({ ...request, action }))),
        warnings: [],
      }),
    });
    const saved = new Map<string, unknown>();
    let since: string | null = null;
    let latestProcessed = 0;
    let complete = false;
    for (let run = 0; run < 60; run++) {
      const result = await service.collect({ ...input(), since }, signal());
      expect(result.warnings).toEqual([]);
      expect(result.candidates.length).toBeLessThanOrEqual(196);
      expect(result.observations.length).toBeLessThanOrEqual(28);
      const times = result.candidates.map(candidate => Date.parse(candidate.notification!.updatedAt));
      if (times.length) {
        expect(Math.min(...times)).toBeGreaterThanOrEqual(latestProcessed);
        latestProcessed = Math.max(...times);
      }
      for (const candidate of result.candidates) saved.set(`${candidate.url}:${candidate.action}`, candidate);
      if (!result.coveredThrough) { complete = true; break; }
      expect(Date.parse(result.coveredThrough)).toBeGreaterThan(Date.parse(since ?? '2026-08-18T12:00:00Z'));
      expect(Date.parse(result.coveredThrough)).toBeLessThanOrEqual(Date.parse(result.collectedAt));
      expect(result.coverageInfo!.join(' ')).toContain('more history remains');
      since = result.coveredThrough;
    }
    expect(complete).toBe(true);
    expect(saved.size).toBe(240 * githubWorkActionSchema.options.length);
    for (const row of rows) for (const action of githubWorkActionSchema.options) {
      expect(saved.has(`https://github.com/octo/repo/issues/${row.id}:${action}`)).toBe(true);
    }
  });
  test('incomplete first pages of unsupported subjects cannot hide older actionable sources', async () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => ({ ...notification(index + 1), updated_at: at })),
      ...Array.from({ length: 50 }, (_, index) => ({ ...notification(index + 21, 'Discussion'), updated_at: requestedAt })),
    ];
    const { service, calls } = harness({ notifications: [rows], events: [comment()], extract: async data => requests(data) });
    const older = await service.collect(input(), signal());
    expect(older.warnings).toEqual([]);
    expect(older.candidates).toHaveLength(20);
    expect(older.coveredThrough).toBeDefined();
    expect(older.candidates.every(candidate => Date.parse(candidate.notification!.updatedAt) < Date.parse(older.coveredThrough!))).toBe(true);
    const newer = await service.collect({ ...input(), since: older.coveredThrough! }, signal());
    expect(newer.warnings).toEqual([]);
    expect(newer.candidates).toEqual([]);
    expect(newer.coveredThrough).toBeUndefined();
    expect(newer.coverageInfo!.join(' ')).toContain('Unsupported GitHub notification subject type Discussion is excluded');
    expect(calls.filter(path => path.startsWith('/notifications')).every(path =>
      new URL(`https://api.github.com${path}`).searchParams.get('page') === '1',
    )).toBe(true);
  });
  test('exclusive timestamp boundaries retain the entire equal-second bucket and fractional-cursor overlap', async () => {
    const prior = '2026-09-17T11:59:58.500Z';
    const firstBucket = '2026-09-17T11:59:58Z';
    const nextBucket = '2026-09-17T11:59:59Z';
    const rows = [
      ...Array.from({ length: 28 }, (_, index) => ({ ...notification(index + 1), updated_at: firstBucket })),
      { ...notification(29), updated_at: nextBucket },
    ];
    const { service, calls } = harness({ notifications: [rows], events: [comment()], extract: async data => requests(data) });
    const first = await service.collect({ ...input(), since: prior }, signal());
    expect(first.warnings).toEqual([]);
    expect(first.candidates).toHaveLength(28);
    expect(first.coveredThrough).toBe('2026-09-17T11:59:59.000Z');
    expect(Date.parse(first.coveredThrough!)).toBeGreaterThan(Date.parse(prior));
    expect(Date.parse(first.coveredThrough!)).toBeLessThanOrEqual(Date.parse(first.collectedAt));
    const params = calls.filter(path => path.startsWith('/notifications')).map(path => new URL(`https://api.github.com${path}`).searchParams);
    expect(params.every(value => value.get('since') === '2026-09-17T11:59:57.000Z')).toBe(true);
    expect(params.at(-1)!.get('before')).toBe(first.coveredThrough!);
    const second = await service.collect({ ...input(), since: first.coveredThrough! }, signal());
    expect(second.warnings).toEqual([]);
    expect(second.coveredThrough).toBeUndefined();
    expect(second.candidates.map(candidate => candidate.notification!.threadId)).toEqual(['29']);
    expect(second.candidates[0]!.notification!.updatedAt).toBe(nextBucket);
  });
  test('current-second full scans overlap on the next run instead of dropping later same-second updates', async () => {
    let clock = Date.parse('2026-09-17T12:00:00.500Z');
    const rows = [{ ...notification(1), updated_at: now }];
    const { service, calls } = harness({
      notifications: [rows], clock: () => new Date(clock), events: [comment()], extract: async data => requests(data),
    });
    const first = await service.collect(input(), signal());
    expect(first.coveredThrough).toBeUndefined();
    expect(first.candidates).toHaveLength(1);
    rows.push({ ...notification(2), updated_at: now });
    clock += 1000;
    const second = await service.collect({ ...input(), since: first.collectedAt }, signal());
    expect(second.candidates.map(candidate => candidate.notification!.threadId).sort()).toEqual(['1', '2']);
    const parameters = calls.filter(path => path.startsWith('/notifications')).map(path => new URL(`https://api.github.com${path}`).searchParams);
    expect(parameters[0]!.get('before')).toBe('2026-09-17T12:00:01.000Z');
    expect(parameters[1]!.get('since')).toBe('2026-09-17T11:59:59.000Z');
  });
  test('deletions and updates between window probes cannot offset unchanged notifications out of later pages', async () => {
    let clock = Date.parse(now);
    let probes = 0;
    const rows = Array.from({ length: 120 }, (_, index) => ({
      ...notification(index + 1), updated_at: new Date(Date.parse(at) + index * 4 * 3600_000).toISOString(),
    }));
    const { service } = harness({
      notifications: [rows], clock: () => new Date(clock), events: [comment()], extract: async data => requests(data),
      onNotifications: params => {
        expect(params.get('page')).toBe('1');
        if (++probes === 2) {
          rows.splice(rows.findIndex(row => row.id === '119'), 1);
          rows.find(row => row.id === '10')!.updated_at = new Date(Date.parse(now) + 1000).toISOString();
        }
      },
    });
    const saved = new Set<string>();
    let since: string | null = null;
    let complete = false;
    for (let run = 0; run < 50; run++) {
      const result = await service.collect({ ...input(), since }, signal());
      expect(result.warnings).toEqual([]);
      result.candidates.forEach(candidate => saved.add(candidate.notification!.threadId));
      if (!result.coveredThrough) { complete = true; break; }
      since = result.coveredThrough;
      clock += 60_000;
    }
    expect(complete).toBe(true);
    expect(saved.size).toBe(119);
    for (let id = 1; id <= 120; id++) expect(saved.has(String(id))).toBe(id !== 119);
  });
  test('an indivisible overloaded second never enriches, truncates or advances history', async () => {
    const { service, calls, extracted } = harness({
      notifications: [Array.from({ length: 29 }, (_, index) => ({ ...notification(index + 1), updated_at: at }))],
    });
    const result = await service.collect({ ...input(), since: at }, signal());
    expect(result.candidates).toEqual([]);
    expect(result.coveredThrough).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('cannot safely split this timestamp bucket');
    expect(result.warnings.join(' ')).toContain('28 sources or 50 notifications');
    expect(calls.filter(path => path.startsWith('/notifications')).length).toBeLessThanOrEqual(32);
    expect(calls.some(path => path.startsWith('/repos/'))).toBe(false);
    expect(extracted).toEqual([]);
  });
  test('window probing has a hard limit and malformed source records still prevent cursor advancement', async () => {
    const endless = harness({ notifications: [[]], infinitePages: true });
    const result = await endless.service.collect({ ...input(), since: '0001-01-01T00:00:00Z' }, signal());
    expect(endless.calls.filter(path => path.startsWith('/notifications'))).toHaveLength(32);
    expect(result.warnings.join(' ')).toContain('32-probe limit');
    expect(result.coveredThrough).toBeUndefined();
    const malformed = await harness({ events: [{ event: 'commented', created_at: 'yesterday' }] }).service.collect(input(), signal());
    expect(malformed.warnings.join(' ')).toContain('source events could not be validated');
  });
  test('source context caps and failed extraction batches preserve explicit incomplete coverage', async () => {
    const { service, extracted } = harness({
      notifications: [[notification(12, 'PullRequest')]], source: { body: 'x'.repeat(8001) },
      timelineLast: 3, discussionLast: 3,
      events: Array.from({ length: 35 }, (_, index) => comment(index + 1, '@viewer please clarify ' + 'x'.repeat(2100))),
    });
    const result = await service.collect(input(), signal());
    expect(extracted[0]!.sources[0]!.messages).toHaveLength(31);
    expect(result.warnings).toEqual([]);
    expect(result.coverageInfo!.join(' ')).toContain('request context is capped');
    expect(result.coverageInfo!.join(' ')).toContain('timeline is capped');
    expect(result.coverageInfo!.join(' ')).toContain('reviews are capped');
  });
  test('large notification batches keep each complete source together and retain successful batches', async () => {
    let count = 0;
    const seen = new Set<string>();
    const { service } = harness({
      notifications: [Array.from({ length: 28 }, (_, number) => notification(number + 1))],
      eventsFor: number => Array.from({ length: 5 }, (_, index) => comment(number * 10 + index, '@viewer please clarify ' + '界'.repeat(1900))),
      extract: async data => {
        for (const context of data.sources) {
          expect(context.messages).toHaveLength(6);
          expect(seen.has(context.url)).toBe(false);
          seen.add(context.url);
        }
        if (++count === 1) throw new ServiceError('copilot_output');
        return requests(data);
      },
    });
    const result = await service.collect(input(), signal());
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(10);
    expect(seen.size).toBe(28);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThan(28);
    expect(result.observations).toHaveLength(28);
    expect(result.warnings.join(' ')).toContain('Request extraction failed');
  });
});
