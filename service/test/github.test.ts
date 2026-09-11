import { describe, expect, test } from 'bun:test';
import { GhApi, GitHubService, classifyEvents, parseResponse, sourceReference, type ApiResponse, type GitHubApi } from '../src/github.ts';
import { ServiceError } from '../src/errors.ts';
import { requestSchema } from '../src/schema.ts';

const at = (hour: number) => `2026-09-10T${String(hour).padStart(2, '0')}:00:00Z`;
const reference = { repo: 'integrations/provider', number: 12, kind: 'pr' as const };
const viewer = 'viewer';
const request = (id: number, hour = id, login = viewer) => ({
  id, event: 'review_requested', created_at: at(hour), actor: { login: 'author' }, requested_reviewer: { login },
});
const pending = {
  number: 12, title: 'Synthetic pull request', state: 'open' as const, merged: false,
  additions: 10, deletions: 2, changed_files: 1,
  requested_reviewers: [{ login: viewer }], requested_teams: [],
};
const notification = (id = '1', unread = true) => ({
  id, repository: { full_name: reference.repo },
  subject: { type: 'PullRequest', url: 'https://api.github.com/repos/integrations/provider/pulls/12',
    latest_comment_url: 'https://attacker.invalid/credentials', title: 'Synthetic' },
  reason: 'review_requested', unread, updated_at: at(20), last_read_at: null,
});
const response = (body: unknown, headers: Record<string, string> = {}, status = 200): ApiResponse => ({ body, headers, status });
class FakeApi implements GitHubApi {
  calls: { method: string; path: string; body?: unknown }[] = [];
  overrides = new Map<string, ApiResponse | ServiceError>();
  async request(method: 'GET' | 'DELETE' | 'PUT', path: string, _signal: AbortSignal, body?: { ignored: true }) {
    this.calls.push({ method, path, body });
    const override = this.overrides.get(`${method} ${path}`);
    if (override instanceof Error) throw override;
    if (override) return override;
    if (path === '/user') return response({ login: viewer }, { 'x-oauth-scopes': 'repo, read:org' });
    if (path.startsWith('/user/teams?')) return response([]);
    if (path.startsWith('/notifications?')) return response([notification('1', true), notification('2', false)]);
    if (method === 'GET' && /^\/notifications\/threads\/\d+$/.test(path)) return response(notification(path.split('/').at(-1)));
    if (method === 'GET' && path.endsWith('/subscription')) return response({ subscribed: true, ignored: false });
    if (path.endsWith('/pulls/12')) return response(pending);
    if (path.includes('/timeline?')) return response([request(1)]);
    if (method === 'DELETE') return response(null, {}, 204);
    if (method === 'PUT') return response({ ignored: true });
    throw new Error(`Unexpected synthetic route ${method} ${path}`);
  }
}
const signal = () => new AbortController().signal;
const classify = (events: Parameters<typeof classifyEvents>[0], source = pending) =>
  classifyEvents(events, reference, source, viewer, new Set()).evidence;

describe('GitHub evidence identity', () => {
  test('merge queue, commits and sticky reason never become a review request', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /repos/integrations/provider/issues/12/timeline?per_page=100&page=1', response([
      request(1), { id: 2, event: 'added_to_merge_queue', created_at: at(2), actor: { login: 'bot' } },
      { id: 3, event: 'committed', created_at: at(3), actor: { login: 'author' } },
      { id: 4, event: 'commented', created_at: at(4), body: 'Ordinary progress', user: { login: 'author' } },
    ]));
    const result = await new GitHubService(api).refresh(signal());
    const evidence = result.threads[0]!.evidence;
    expect(evidence.map(event => event.kind)).toEqual(['review-request', 'merge-queue', 'commit', 'comment']);
    const handled = [evidence[0]!.id];
    expect(evidence.filter(event => event.kind === 'review-request' && !handled.includes(event.id))).toEqual([]);
    expect((await new GitHubService(api).refresh(signal())).threads[0]!.evidence.map(event => event.id)).toEqual(evidence.map(event => event.id));
  });
  test('re-request gets a new identity; another reviewer does not erase it', () => {
    const events = classify([
      request(1), { id: 2, event: 'reviewed', submitted_at: at(2), user: { login: viewer } },
      request(3), { id: 4, event: 'reviewed', submitted_at: at(4), user: { login: 'someone-else' } },
      request(5, 5, 'someone-else'),
    ]);
    expect(events[0]!.requestState).toBe('historical');
    expect(events[2]!.requestState).toBe('current');
    expect(events[2]!.id).not.toBe(events[0]!.id);
    expect(events[0]!.kind).toBe('review-request');
  });
  test('cancelled, reviewed, closed, merged and no-longer-requested events stay historical', () => {
    const removal = { ...request(2), event: 'review_request_removed' };
    expect(classify([request(1), removal])[0]!.requestState).toBe('historical');
    expect(classify([request(1), { id: 2, event: 'reviewed', submitted_at: at(2), user: { login: viewer } }])[0]!.requestState).toBe('historical');
    expect(classify([request(1)], { ...pending, state: 'closed' as 'open' })[0]!.requestState).toBe('historical');
    expect(classify([request(1)], { ...pending, merged: true })[0]!.requestState).toBe('historical');
    expect(classify([request(1)], { ...pending, requested_reviewers: [] })[0]!.requestState).toBe('historical');
  });
  test('specific team identity/membership is not a direct assignment', () => {
    const team = { slug: 'terraform-provider-core-maintainers' };
    const event = { id: 1, event: 'review_requested', created_at: at(1), actor: { login: 'author' }, requested_team: team };
    const source = { ...pending, requested_teams: [team] };
    const known = classifyEvents([event, request(2)], reference, source, viewer,
      new Set(['integrations/terraform-provider-core-maintainers'])).evidence;
    expect(known[0]!.recipient).toEqual({ kind: 'team', team: 'integrations/terraform-provider-core-maintainers', viewerMembership: 'member' });
    expect(known[0]!.requestState).toBe('current');
    expect(known[1]!.requestState).toBe('current');
    expect(classifyEvents([event], reference, source, viewer, null).evidence[0]!.requestState).toBe('uncertain');
    const removed = { ...event, id: 3, created_at: at(3), event: 'review_request_removed' };
    const interleaved = classifyEvents([event, request(2), removed], reference, source, viewer,
      new Set(['integrations/terraform-provider-core-maintainers'])).evidence;
    expect(interleaved[0]!.requestState).toBe('historical');
    expect(interleaved[1]!.requestState).toBe('current');
  });
  test('actual mentions remain uncertain messages, not review requests', () => {
    const evidence = classify([
      { id: 1, event: 'commented', created_at: at(1), body: '@viewer can you explain?', user: { login: 'author' } },
      { id: 2, event: 'commented', created_at: at(2), body: '@viewer-other hello', user: { login: 'author' } },
    ]);
    expect(evidence.map(value => value.kind)).toEqual(['mention', 'comment']);
    expect(evidence.every(value => value.requestState === 'not-request')).toBe(true);
  });
});
describe('bounded GitHub refresh', () => {
  test('manual call includes read and unread; connection never fetches notifications', async () => {
    const api = new FakeApi();
    const service = new GitHubService(api);
    expect(api.calls).toEqual([]);
    await service.connection(signal());
    expect(api.calls.map(value => value.path)).toEqual(['/user']);
    const result = await service.refresh(signal());
    expect(result.threads.map(value => value.notification)).toEqual(['unread', 'read']);
    expect(result.coverage.missingMeansDone).toBe(false);
    expect(api.calls.some(value => value.path.includes('attacker'))).toBe(false);
    expect(api.calls.some(value => /search|events\?/.test(value.path))).toBe(false);
  });
  test('notification pagination failure retains first page with partial coverage', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1', response([notification()], {
      link: '<https://api.github.com/notifications?all=true&per_page=50&page=2>; rel="next"',
    }));
    api.overrides.set('GET /notifications?all=true&per_page=50&page=2', new ServiceError('rate_limit', true));
    const result = await new GitHubService(api).refresh(signal());
    expect(result.status).toBe('partial');
    expect(result.threads.length).toBe(1);
    expect(result.diagnostics.some(value => value.code === 'rate_limit')).toBe(true);
  });
  test('empty successful listing differs from failed listing', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1', response([]));
    const result = await new GitHubService(api).refresh(signal());
    expect(result.status).toBe('complete');
    expect(result.threads).toEqual([]);
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1', new ServiceError('access'));
    await expect(new GitHubService(api).refresh(signal())).rejects.toMatchObject({ dto: { code: 'access' } });
  });
  test('only newest contiguous timeline page can promote requests when coverage has gaps', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /repos/integrations/provider/issues/12/timeline?per_page=100&page=1', response([request(1)], {
      link: '<https://api.github.com/repos/integrations/provider/issues/12/timeline?per_page=100&page=9>; rel="last"',
    }));
    api.overrides.set('GET /repos/integrations/provider/issues/12/timeline?per_page=100&page=9', response([
      { id: 10, event: 'added_to_merge_queue', created_at: at(10) },
    ]));
    const thread = (await new GitHubService(api).refresh(signal())).threads[0]!;
    expect(thread.evidence.map(value => value.kind)).toEqual(['merge-queue']);
    expect(thread.coverage).toMatchObject({ timeline: 'partial', newestPage: 9, fetchedPages: [9] });
  });
  test('missing membership and malformed latest event suppress certainty', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /user/teams?per_page=100&page=1', new ServiceError('access'));
    api.overrides.set('GET /repos/integrations/provider/issues/12/timeline?per_page=100&page=1', response([request(1), { event: 'review_request_removed' }]));
    const result = await new GitHubService(api).refresh(signal());
    expect(result.status).toBe('partial');
    expect(result.diagnostics.some(value => value.scope === 'teams')).toBe(true);
    expect(result.threads[0]!.evidence[0]!.requestState).toBe('uncertain');
  });
  test('missing read:org scope preserves direct evidence and reports unknown team coverage', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /user', response({ login: viewer }, { 'x-oauth-scopes': 'repo' }));
    const result = await new GitHubService(api).refresh(signal());
    expect(result.diagnostics.some(value => value.scope === 'teams' && value.code === 'missing_scope')).toBe(true);
    expect(api.calls.some(value => value.path.startsWith('/user/teams'))).toBe(false);
    expect(result.threads[0]!.evidence[0]!.requestState).toBe('current');
  });
  test('missing notification scope fails before notification discovery', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /user', response({ login: viewer }, { 'x-oauth-scopes': 'read:org' }));
    await expect(new GitHubService(api).refresh(signal())).rejects.toMatchObject({ dto: { code: 'missing_scope' } });
    expect(api.calls.map(value => value.path)).toEqual(['/user']);
  });
  test('source access failure is explicit; it never means local work is done', async () => {
    const api = new FakeApi();
    api.overrides.set('GET /repos/integrations/provider/pulls/12', new ServiceError('access'));
    await expect(new GitHubService(api).refresh(signal())).rejects.toMatchObject({ dto: { code: 'access' } });
  });
  test('malicious source and Link URLs never get followed', async () => {
    for (const url of [
      'https://api.github.com.evil/repos/integrations/provider/pulls/12',
      'http://api.github.com/repos/integrations/provider/pulls/12',
      'https://api.github.com/repos/integrations/provider/pulls/12?token=secret',
      'https://api.github.com/repos/integrations/provider/pulls/12/../../user',
      'https://api.github.com/repos/other/repo/pulls/12',
    ]) {
      expect(() => sourceReference({ ...notification(), subject: { ...notification().subject, url } })).toThrow();
    }
    const api = new FakeApi();
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1', response([], {
      link: '<https://attacker.invalid/notifications?page=2>; rel="next"',
    }));
    await expect(new GitHubService(api).refresh(signal())).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
    expect(api.calls.every(value => !value.path.includes('attacker'))).toBe(true);
  });
});
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function timedApi(latency: (path: string, call: number) => number) {
  const api = new FakeApi();
  const original = api.request.bind(api);
  const counts = new Map<string, number>();
  const activity = { active: 0, maximum: 0 };
  api.request = async (method, path, signal, body) => {
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    const milliseconds = latency(path, count);
    if (!milliseconds) return original(method, path, signal, body);
    activity.active++;
    activity.maximum = Math.max(activity.maximum, activity.active);
    try { await pause(milliseconds, signal); return await original(method, path, signal, body); }
    finally { activity.active--; }
  };
  return { api, activity, counts };
}
describe('refresh concurrency and collection budget', () => {
  const source = '/repos/integrations/provider/pulls/12';
  test('enriches at most three threads concurrently but returns notification order', async () => {
    const { api, activity } = timedApi((path, call) => path === source ? call === 1 ? 40 : 5 : 0);
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1',
      response(Array.from({ length: 6 }, (_, index) => notification(String(index + 1)))));
    const result = await new GitHubService(api).refresh(signal());
    expect(activity.maximum).toBe(3);
    expect(activity.active).toBe(0);
    expect(result.threads.map(thread => thread.id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  test('soft budget keeps completed threads and reports in-flight and unstarted gaps', async () => {
    const { api, activity, counts } = timedApi((path, call) => path === source ? call === 1 ? 5 : 1000 : 0);
    api.overrides.set('GET /notifications?all=true&per_page=50&page=1',
      response(Array.from({ length: 6 }, (_, index) => notification(String(index + 1)))));
    const started = performance.now();
    const result = await new GitHubService(api, { refreshBudgetMs: 60 }).refresh(signal());
    expect(performance.now() - started).toBeLessThan(300);
    expect(result.status).toBe('partial');
    expect(result.threads.map(thread => thread.id)).toEqual(['1']);
    expect(result.coverage).toMatchObject({ notifications: 'complete', received: 6, returned: 1, missingMeansDone: false });
    expect(result.diagnostics.some(value => value.code === 'deadline' && value.threadId === '5')).toBe(true);
    expect(result.diagnostics.some(value => value.code === 'deadline' && value.threadId === '2')).toBe(true);
    expect(result.diagnostics.every(value => !value.message.includes('write'))).toBe(true);
    expect(counts.get(source)).toBe(4);
    expect(activity.active).toBe(0);
  });
  test('budget interruption preserves usable source data and acquired timeline evidence', async () => {
    for (const stage of ['timeline', 'subscription']) {
      const { api, activity } = timedApi(path => path.includes(stage) ? 1000 : 0);
      const result = await new GitHubService(api, { refreshBudgetMs: 30 }).refresh(signal());
      expect(result.status).toBe('partial');
      expect(result.threads.length).toBe(2);
      expect(result.threads[0]!.state).toBe('open');
      expect(result.threads[0]!.subscription).toBe('unknown');
      expect(result.threads[0]!.coverage.timeline).toBe(stage === 'timeline' ? 'unavailable' : 'complete');
      expect(result.threads[0]!.evidence.length).toBe(stage === 'timeline' ? 0 : 1);
      expect(result.diagnostics.some(value => value.code === 'deadline' && value.scope === stage)).toBe(true);
      expect(activity.active).toBe(0);
    }
  });
  test('budget with no usable thread is a read-only error, never successful empty', async () => {
    const { api, activity } = timedApi(path => path === source ? 1000 : 0);
    const outcome = await new GitHubService(api, { refreshBudgetMs: 30 }).refresh(signal()).catch(error => error);
    expect(outcome).toMatchObject({ dto: { code: 'deadline' } });
    expect(outcome.dto.message).toContain('read-only');
    expect(outcome.dto.message).not.toContain('write');
    expect(activity.active).toBe(0);
  });
  test('explicit cancellation stays an error, awaits all workers, and releases single-refresh guard', async () => {
    let slow = true;
    const { api, activity } = timedApi(path => slow && path === source ? 1000 : 0);
    const service = new GitHubService(api, { refreshBudgetMs: 200 });
    const controller = new AbortController();
    const pending = service.refresh(controller.signal).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(service.refresh(signal())).rejects.toMatchObject({ dto: { code: 'busy' } });
    controller.abort(new ServiceError('cancelled'));
    expect(await pending).toMatchObject({ dto: { code: 'cancelled' } });
    expect(activity.active).toBe(0);
    slow = false;
    expect((await service.refresh(signal())).threads.length).toBe(2);
  });
});

describe('explicit GitHub writes (mocked only)', () => {
  const input = { operationId: 'op-1', threadId: '1', reference, displayedEvidenceIds: ['evidence-1'] };
  test('DONE is DELETE, never PATCH read; unsubscribe confirms ignored true', async () => {
    const api = new FakeApi();
    const service = new GitHubService(api);
    expect(await service.write('acknowledge', input, signal())).toMatchObject({ ...input, status: 'confirmed', action: 'acknowledge' });
    expect(api.calls.at(-1)).toEqual({ method: 'DELETE', path: '/notifications/threads/1', body: undefined });
    await service.write('unsubscribe', { ...input, operationId: 'op-2' }, signal());
    expect(api.calls.at(-1)).toEqual({ method: 'PUT', path: '/notifications/threads/1/subscription', body: { ignored: true } });
  });
  test('confirmed operations deduplicate by stable operation ID; conflicting reuse is rejected', async () => {
    const api = new FakeApi();
    const service = new GitHubService(api);
    const first = await service.write('acknowledge', input, signal());
    expect(await service.write('acknowledge', input, signal())).toEqual(first);
    expect(api.calls.filter(value => value.method === 'DELETE').length).toBe(1);
    await expect(service.write('unsubscribe', input, signal())).rejects.toMatchObject({ dto: { code: 'invalid_input' } });
  });
  test('wrong subject context, queued status and failed writes never claim success', async () => {
    const api = new FakeApi();
    const service = new GitHubService(api);
    await expect(service.write('acknowledge', { ...input, reference: { ...reference, number: 99 } }, signal())).rejects.toThrow();
    expect(api.calls.every(value => value.method === 'GET')).toBe(true);
    api.overrides.set('DELETE /notifications/threads/1', response(null, {}, 202));
    await expect(service.write('acknowledge', input, signal())).rejects.toThrow();
    api.overrides.set('PUT /notifications/threads/1/subscription', response({ ignored: false }));
    await expect(service.write('unsubscribe', input, signal())).rejects.toThrow();
  });
  test('no arbitrary commands/paths/URLs or read/write operation names', async () => {
    for (const op of ['github.read', 'github.merge', 'shell', 'github.close']) {
      expect(requestSchema.safeParse({ v: 1, id: 'a', op, input: {} }).success).toBe(false);
    }
    const api = new GhApi(async () => { throw new Error('Must not run'); });
    await expect(api.request('GET', 'https://evil.invalid/', signal())).rejects.toThrow();
    await expect(api.request('PUT', '/repos/a/b/pulls/1', signal(), { ignored: true })).rejects.toThrow();
  });
  test('gh output headers carry status, scopes and rate limits without logging raw errors', async () => {
    expect(parseResponse('HTTP/2.0 204 No Content\r\nX-Test: yes\r\n\r\n')).toEqual({ status: 204, headers: { 'x-test': 'yes' }, body: null });
    const api = new GhApi(async () => ({
      code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\n\r\n{"message":"private body and token"}',
    }), async () => '/synthetic/gh');
    await expect(api.request('GET', '/user', signal())).rejects.toMatchObject({ dto: { code: 'rate_limit' } });
  });
});
