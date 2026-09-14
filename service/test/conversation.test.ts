import { expect, test } from 'bun:test';
import { GhApi, GitHubService, type ApiResponse, type GitHubApi } from '../src/github.ts';
import { ServiceError } from '../src/errors.ts';
import { conversationPageSchema, LIMITS, requestSchema, type ConversationInput } from '../src/schema.ts';
import { createHandler } from '../src/main.ts';
import { serve } from '../src/protocol.ts';

const reference = { repo: 'octo/project', kind: 'pr' as const, number: 12 };
const at = '2026-09-11T01:00:00Z';
const raw = (id: number, body = `Message ${id}`) => ({
  id, number: 12, body, user: { login: 'author' }, created_at: at, updated_at: at,
  html_url: `https://github.com/octo/project/pull/12#issuecomment-${id}`,
});
const response = (body: unknown, headers: Record<string, string> = {}, status = 200): ApiResponse => ({ body, headers, status });
const signal = () => new AbortController().signal;
class Api implements GitHubApi {
  calls: string[] = [];
  routes = new Map<string, ApiResponse | Error>();
  async request(method: string, path: string) {
    expect(method).toBe('GET');
    this.calls.push(path);
    const value = this.routes.get(path);
    if (!value) throw new Error(`Unexpected route ${path}`);
    if (value instanceof Error) throw value;
    return value;
  }
}
const path = '/repos/octo/project/issues/12/comments';

test('real descriptions and >2k comments keep exact Markdown through the JSONL service contract', async () => {
  for (const kind of ['pr', 'issue'] as const) {
    const api = new Api();
    const body = '# Long source\n\n' + 'Full text with `code` and 日本語.\n'.repeat(300);
    api.routes.set(`/repos/octo/project/${kind === 'pr' ? 'pulls' : 'issues'}/12`,
      response({ ...raw(1, body), html_url: `https://github.com/octo/project/${kind === 'pr' ? 'pull' : 'issues'}/12` }));
    const request = requestSchema.parse({ v: 1, id: 'reader-test', op: 'github.conversation', input: { reference: { ...reference, kind }, stream: 'description', page: null } });
    const outputs: unknown[] = [];
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    async function* lines() {
      yield Buffer.from(JSON.stringify(request) + '\n');
      await done;
    }
    await serve(lines(), async line => { outputs.push(JSON.parse(line)); finished(); }, createHandler(new GitHubService(api)));
    expect(outputs).toHaveLength(1);
    const reply = outputs[0] as { ok: boolean; result: unknown };
    expect(reply.ok).toBe(true);
    expect(conversationPageSchema.parse(reply.result).messages[0]?.body).toBe(body);
    expect(api.calls).toHaveLength(1);
  }
});

test('newest pages use bounded probes, older pages are explicit, stable IDs retain edits and deduplicate', async () => {
  const api = new Api();
  api.routes.set(`${path}?per_page=5&page=1`, response([raw(1)], { link: `<https://api.github.com${path}?per_page=5&page=3>; rel="last"` }));
  api.routes.set(`${path}?per_page=5&page=3`, response([
    { ...raw(12, 'Latest duplicate edit'), updated_at: '2026-09-12T01:00:00Z' },
    raw(11, 'x'.repeat(10_000)), raw(12),
  ]));
  const service = new GitHubService(api);
  const input: ConversationInput = { reference, stream: 'comments', page: null };
  const newest = await service.conversation(input, signal());
  expect(newest).toMatchObject({ page: 3, newestPage: 3, olderPage: 2, error: null });
  expect(newest.messages.map(item => item.id)).toEqual(['github:octo/project:pr:12:comments:11', 'github:octo/project:pr:12:comments:12']);
  expect(newest.messages[0]?.body).toHaveLength(10_000);
  expect(newest.messages[1]?.body).toBe('Latest duplicate edit');
  api.routes.set(`${path}?per_page=5&page=2`, response([raw(6), raw(7)]));
  const older = await service.conversation({ ...input, page: 2 }, signal());
  expect(older.page).toBe(2);
  expect(api.calls).toEqual([`${path}?per_page=5&page=1`, `${path}?per_page=5&page=3`, `${path}?per_page=5&page=2`]);
  api.routes.set(`${path}?per_page=5&page=2`, response([{ ...raw(6, 'Edited older body'), updated_at: '2026-09-12T01:00:00Z' }]));
  const edit = await service.conversation({ ...input, page: 2 }, signal());
  expect(edit.messages[0]?.id).toBe(older.messages[0]?.id);
  expect(edit.messages[0]?.body).toBe('Edited older body');
});

test('PR reviews and multiple inline conversations retain authors, source links and reply identity', async () => {
  const api = new Api();
  const review = { ...raw(20, 'Full review body'), created_at: undefined, updated_at: undefined, submitted_at: at,
    html_url: 'https://github.com/octo/project/pull/12#pullrequestreview-20' };
  api.routes.set('/repos/octo/project/pulls/12/reviews?per_page=5&page=1', response([review]));
  api.routes.set('/repos/octo/project/pulls/12/comments?per_page=5&page=1', response([
    { ...raw(100, 'Root A'), pull_request_review_id: 20, path: 'src/a.ts', line: 10, html_url: 'https://github.com/octo/project/pull/12#discussion_r100' },
    { ...raw(101, 'Root B'), pull_request_review_id: 20, path: 'src/b.ts', line: 3, html_url: 'https://github.com/octo/project/pull/12#discussion_r101' },
    { ...raw(102, 'Reply A'), pull_request_review_id: 21, in_reply_to_id: 100, path: 'src/a.ts', line: null, original_line: 10, html_url: 'https://github.com/octo/project/pull/12#discussion_r102' },
  ]));
  const service = new GitHubService(api);
  expect((await service.conversation({ reference, stream: 'reviews', page: null }, signal())).messages[0]).toMatchObject({
    kind: 'reviews', body: 'Full review body', createdAt: at, updatedAt: at, author: 'author',
  });
  const inline = await service.conversation({ reference, stream: 'inline', page: null }, signal());
  expect(inline.messages[2]).toMatchObject({ replyTo: inline.messages[0]!.id, line: 10, path: 'src/a.ts' });
  expect(inline.messages[1]!.replyTo).toBeNull();
  expect(inline.messages[2]!.reviewId).not.toBe(inline.messages[0]!.reviewId);
});

test('canonical repository-ID links load newest conversation pages without following the supplied URL', async () => {
  for (const [stream, resource] of [['comments', 'issues/12/comments'], ['reviews', 'pulls/12/reviews'], ['inline', 'pulls/12/comments']] as const) {
    const api = new Api();
    const route = `/repos/octo/project/${resource}`;
    api.routes.set(`${route}?per_page=5&page=1`, response([raw(1)], {
      link: `<https://api.github.com/repositories/42/${resource}?per_page=5&page=3>; rel="last"`,
    }));
    api.routes.set(`${route}?per_page=5&page=3`, response([raw(11, 'Newest message')]));
    const result = await new GitHubService(api).conversation({ reference, stream, page: null }, signal());
    expect(result).toMatchObject({ page: 3, newestPage: 3, olderPage: 2, error: null });
    expect(result.messages.map(message => message.body)).toEqual(['Newest message']);
    expect(api.calls).toEqual([`${route}?per_page=5&page=1`, `${route}?per_page=5&page=3`]);
  }
});

test('permission, rate limit, offline and malformed pages remain explicit without fallback content', async () => {
  for (const failure of [
    response(null, {}, 403), response(null, {}, 404), response(null, { 'retry-after': '30' }, 429),
    new ServiceError('unavailable', true), response([{ ...raw(1), html_url: 'https://attacker.invalid/' }, raw(2)]),
  ]) {
    const api = new Api();
    api.routes.set(`${path}?per_page=5&page=1`, failure);
    const result = await new GitHubService(api).conversation({ reference, stream: 'comments', page: null }, signal());
    expect(result.error).not.toBeNull();
    expect(result.messages.map(item => item.body)).toEqual(failure instanceof Error || failure.status !== 200 ? [] : ['Message 2']);
  }
});

test('transport limits count serialized UTF8 and reject whole pages rather than truncate', async () => {
  const api = new Api();
  api.routes.set(`${path}?per_page=5&page=1`, response(Array.from({ length: 5 }, (_, index) => raw(index + 1, '日'.repeat(80_000)))));
  const result = await new GitHubService(api).conversation({ reference, stream: 'comments', page: null }, signal());
  expect(result.error?.code).toBe('limit');
  expect(result.messages).toEqual([]);
  expect(result.page).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LIMITS.responseBytes);
});

test('unsafe links, pagination URLs, caller endpoints and invalid stream inputs never expand capability', async () => {
  const api = new Api();
  api.routes.set(`${path}?per_page=5&page=1`, response([], { link: '<https://attacker.invalid/leak?page=2>; rel="last"' }));
  const result = await new GitHubService(api).conversation({ reference, stream: 'comments', page: null }, signal());
  expect(result.error?.code).toBe('invalid_output');
  expect(api.calls).toHaveLength(1);
  expect(requestSchema.safeParse({ v: 1, id: 'x', op: 'github.conversation', input: { reference, stream: 'comments', page: null, notes: 'PRIVATE' } }).success).toBe(false);
  const service = new GitHubService(api);
  await expect(service.conversation({ reference: { ...reference, kind: 'issue' }, stream: 'inline', page: null }, signal())).rejects.toThrow();
  let calls = 0;
  const gh = new GhApi(async () => { calls++; return { stdout: 'HTTP/2 200 OK\ncontent-type: application/json\n\n[]', stderr: '', code: 0 }; }, async () => '/fake/gh');
  await gh.request('GET', `${path}?per_page=5&page=3`, signal());
  await expect(gh.request('GET', `${path}?per_page=100&page=3`, signal())).rejects.toThrow();
  await expect(gh.request('GET', '/repos/octo/project/contents/private', signal())).rejects.toThrow();
  expect(calls).toBe(1);
});
