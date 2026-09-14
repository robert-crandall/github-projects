import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { CopilotService } from '../src/copilot.ts';
import { ServiceError, checkAbort, sanitized } from '../src/errors.ts';
import { GitHubService } from '../src/github.ts';
import { createHandler } from '../src/main.ts';
import type { Runner, RunResult } from '../src/process.ts';
import { serve, type Handler } from '../src/protocol.ts';
import { LIMITS, requestSchema, waitingSchema, type WaitingDigest, type WaitingItem } from '../src/schema.ts';
import { WaitingService } from '../src/waiting.ts';

const now = new Date('2026-09-14T12:00:00.000Z');
const signal = () => new AbortController().signal;
const daysAgo = (days: number, offset = 0) => new Date(now.getTime() - days * 86_400_000 + offset).toISOString();
const source = (number: number, overrides: Record<string, unknown> = {}) => ({
  number, title: `Synthetic ${number}`, repository: { nameWithOwner: 'octo/project' },
  author: { login: 'someone' }, updatedAt: daysAgo(1), isDraft: false, ...overrides,
});
const detail = (number: number, overrides: Record<string, unknown> = {}) => ({
  number, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false, statusCheckRollup: [], ...overrides,
});
const authArgs = [
  'api', '--hostname', 'github.com', '--include', '--method', 'GET',
  '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '/user',
];
const commands = [
  ['search', 'prs', 'user-review-requested:@me', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,author,updatedAt,isDraft'],
  ['search', 'prs', 'team-review-requested:integrations/terraform-provider-core-maintainers', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,author,updatedAt,isDraft'],
  ['search', 'prs', '--author=@me', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,isDraft,updatedAt'],
  ['search', 'prs', '--mentions=@me', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,author,updatedAt'],
  ['search', 'prs', '--reviewed-by=@me', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,author,updatedAt'],
  ['search', 'issues', '--assignee=@me', '--archived=false', '--state=open', '--limit', '50', '--json', 'number,title,repository,author,updatedAt'],
];
const viewArgs = (number: number, repo = 'octo/project') => [
  'pr', 'view', String(number), '--repo', repo, '--json', 'number,reviewDecision,mergeable,isDraft,statusCheckRollup',
];
const json = (body: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(body) });
type Override = Error | RunResult | ((signal: AbortSignal) => Promise<RunResult>);
class Fixture {
  searches: unknown[] = [[], [], [], [], [], []];
  details = new Map<number, unknown>();
  overrides = new Map<string, Override>();
  calls: string[][] = [];
  viewer: unknown = { login: 'ViEwEr' };
  resolutions: string[] = [];
  runner: Runner = async (program, args, signal, input) => {
    expect(program).toBe('/synthetic/gh');
    expect(input).toBeUndefined();
    this.calls.push([...args]);
    let key: string;
    let output: RunResult;
    if (JSON.stringify(args) === JSON.stringify(authArgs)) {
      key = 'auth';
      output = { code: 0, stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(this.viewer)}` };
    } else if (args[0] === 'search') {
      const index = commands.findIndex(command => JSON.stringify(command) === JSON.stringify(args));
      expect(index).toBeGreaterThanOrEqual(0);
      key = `search:${index}`;
      output = json(this.searches[index]);
    } else {
      const number = Number(args[2]);
      expect(args).toEqual(viewArgs(number, args[4]));
      key = `view:${number}`;
      output = json(this.details.has(number) ? this.details.get(number) : detail(number));
    }
    const override = this.overrides.get(key);
    if (override instanceof Error) throw override;
    return typeof override === 'function' ? override(signal) : override ?? output;
  };
  service(options: { deadlineMs?: number } = {}) {
    return new WaitingService({
      runner: this.runner, resolve: async name => { this.resolutions.push(name); return '/synthetic/gh'; },
      now: () => now, ...options,
    });
  }
}
const numbers = (digest: WaitingDigest) => digest.buckets.map(bucket => [bucket.id, bucket.items.map(item => item.reference.number)]);
async function oneReply(handler: Handler, op = 'github.waiting', input: unknown = {}) {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const replies: unknown[] = [];
  async function* lines() {
    yield Buffer.from(JSON.stringify({ v: 1, id: 'waiting', op, input }) + '\n');
    await done;
  }
  await serve(lines(), async line => { replies.push(JSON.parse(line)); finish(); }, handler);
  expect(replies).toHaveLength(1);
  return replies[0] as { v: 1; id: string | null; ok: boolean; result?: WaitingDigest; error?: { code: string; message: string } };
}
function handler(fixture: Fixture) {
  const forbidden = async () => { throw new Error('Unexpected notification or model operation'); };
  const github = new GitHubService({ request: forbidden });
  const copilot = new CopilotService({
    client: () => { throw new Error('Unexpected model initialization'); }, token: forbidden, cli: forbidden,
  });
  return createHandler(github, copilot, fixture.service());
}

test('uses only the six sequential fixed searches, one viewer GET, and bounded PR view arguments', async () => {
  const fixture = new Fixture();
  fixture.searches[2] = [source(1), source(2, { isDraft: true })];
  let active = 0;
  let peak = 0;
  for (let index = 0; index < commands.length; index++) {
    fixture.overrides.set(`search:${index}`, async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return json(fixture.searches[index]);
    });
  }
  const result = await fixture.service().fetch(signal());
  expect(fixture.resolutions).toEqual(['gh']);
  expect(fixture.calls).toEqual([authArgs, ...commands, viewArgs(1)]);
  expect(peak).toBe(1);
  expect(result).toEqual({
    fetchedAt: now.toISOString(), viewer: 'ViEwEr', limitedQueries: [],
    buckets: [{ id: 'ready-to-merge', items: [{
      reference: { repo: 'octo/project', kind: 'pr', number: 1 }, title: 'Synthetic 1',
      author: 'ViEwEr', updatedAt: daysAgo(1), reasons: [],
    }] }],
  });
});

test('all six digest searches exclude archived repositories before limiting results', async () => {
  const fixture = new Fixture();
  await fixture.service().fetch(signal());
  const searches = fixture.calls.filter(args => args[0] === 'search');
  expect(searches).toHaveLength(6);
  for (const args of searches) {
    expect(args.filter(arg => arg.startsWith('--archived'))).toEqual(['--archived=false']);
    expect(args).toContain('--state=open');
  }
});

test('first-match priority deduplicates case-insensitive repo/number identities, including across source kinds', async () => {
  const fixture = new Fixture();
  fixture.searches = [
    [source(1, { repository: { nameWithOwner: 'OCTO/Project' }, author: null }), source(2, { isDraft: true })],
    [source(1), source(2), source(3), source(30, { isDraft: true })],
    [1, 3, 4, 5, 6, 7, 8].map(number => source(number, { isDraft: number === 7 })),
    [1, 2, 3, 4, 5, 9].map(number => source(number)),
    [source(9), source(13)],
    [source(9, { repository: { nameWithOwner: 'Octo/PROJECT' } }), source(14, { author: null })],
  ];
  fixture.details.set(5, detail(5, { reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING',
    statusCheckRollup: [{ conclusion: 'FAILURE' }, { state: 'PENDING' }] }));
  fixture.details.set(6, detail(6, { statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }));
  fixture.details.set(8, detail(8, { isDraft: true }));
  const result = await fixture.service().fetch(signal());
  expect(numbers(result)).toEqual([
    ['direct-review', [1]], ['team-review', [2, 3]], ['ready-to-merge', [4]],
    ['needs-fix', [5]], ['mentioned', [9]], ['reviewed', [13]], ['assigned', [14]],
  ]);
  expect(result.buckets[0]!.items[0]!.author).toBeNull();
  expect(result.buckets[3]!.items[0]!.reasons).toEqual(['changes-requested', 'conflicts', 'ci']);
  expect(fixture.calls.filter(args => args[0] === 'pr').map(args => Number(args[2]))).toEqual([1, 3, 4, 5, 6, 8]);
  expect(waitingSchema.safeParse(result).success).toBe(true);
});

test('inclusive 3/2/30-day windows exclude future/older updates and sort oldest first with identity tie-breaks', async () => {
  const fixture = new Fixture();
  for (const [index, days] of [[3, 3], [4, 2], [5, 30]] as const) {
    const base = index * 100;
    fixture.searches[index] = [
      source(base + 4, { updatedAt: now.toISOString(), isDraft: true }),
      source(base + 3, { updatedAt: daysAgo(days, 1), isDraft: true }),
      source(base + 2, { updatedAt: daysAgo(days), isDraft: true }),
      source(base + 1, { updatedAt: daysAgo(days), isDraft: true }),
      source(base + 5, { updatedAt: daysAgo(days, -1) }),
      source(base + 6, { updatedAt: new Date(now.getTime() + 1).toISOString() }),
    ];
  }
  expect(numbers(await fixture.service().fetch(signal()))).toEqual([
    ['mentioned', [301, 302, 303, 304]], ['reviewed', [401, 402, 403, 404]], ['assigned', [501, 502, 503, 504]],
  ]);
});

test('own and unknown authors do not become mention/review signals; known other authors and drafts do', async () => {
  const fixture = new Fixture();
  for (const index of [3, 4]) {
    const base = index * 100;
    fixture.searches[index] = [
      source(base + 1, { author: { login: 'viewer' } }),
      source(base + 2, { author: { login: 'VIEWER' } }),
      source(base + 3, { author: null }),
      source(base + 4, { author: { login: '' } }),
      source(base + 5, { author: { login: 'other[bot]' }, isDraft: true }),
    ];
  }
  fixture.searches[0] = [source(1, { author: { login: '' } })];
  fixture.searches[5] = [source(2, { author: { login: 'viewer' } })];
  const result = await fixture.service().fetch(signal());
  expect(numbers(result)).toEqual([['direct-review', [1]], ['mentioned', [305]], ['reviewed', [405]], ['assigned', [2]]]);
  expect(result.buckets[0]!.items[0]!.author).toBeNull();
});

describe('authored review, mergeability and CI classification', () => {
  for (const state of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR']) {
    test(`failing ${state} beats pending and passing in conclusion or fallback state`, async () => {
      for (const check of [{ conclusion: state }, { conclusion: '', state }, { conclusion: null, state }, { state }]) {
        const fixture = new Fixture();
        fixture.searches[2] = [source(1)];
        fixture.details.set(1, detail(1, { statusCheckRollup: [{ state: 'SUCCESS' }, { state: 'PENDING' }, check] }));
        const result = await fixture.service().fetch(signal());
        expect(numbers(result)).toEqual([['needs-fix', [1]]]);
        expect(result.buckets[0]!.items[0]!.reasons).toEqual(['ci']);
      }
    });
  }
  for (const state of ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', null]) {
    test(`pending ${String(state)} never becomes ready or needs-fix by itself`, async () => {
      for (const check of [{ conclusion: state }, { state }, { conclusion: '', state }, { conclusion: null, state }]) {
        const fixture = new Fixture();
        fixture.searches[2] = [source(1)];
        fixture.details.set(1, detail(1, { statusCheckRollup: [{ state: 'SUCCESS' }, check] }));
        expect((await fixture.service().fetch(signal())).buckets).toEqual([]);
      }
    });
  }
  for (const state of ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE']) {
    test(`non-failing non-pending ${state} follows the specified passing rule`, async () => {
      const fixture = new Fixture();
      fixture.searches[2] = [source(1), source(2)];
      fixture.details.set(1, detail(1, { statusCheckRollup: [{ conclusion: state }] }));
      fixture.details.set(2, detail(2, { statusCheckRollup: [{ conclusion: null, state }] }));
      expect(numbers(await fixture.service().fetch(signal()))).toEqual([['ready-to-merge', [1, 2]]]);
    });
  }
  test('actual gh CheckRun/StatusContext shapes use conclusion then state, not lifecycle status', async () => {
    const fixture = new Fixture();
    fixture.searches[2] = [1, 2, 3, 4, 5, 6].map(number => source(number));
    const checks = [
      { __typename: 'CheckRun', conclusion: '', status: 'IN_PROGRESS', name: 'build' },
      { __typename: 'CheckRun', conclusion: null, status: 'COMPLETED', name: 'build' },
      { __typename: 'CheckRun', conclusion: 'SUCCESS', status: 'COMPLETED', name: 'build' },
      { __typename: 'StatusContext', state: 'SUCCESS', context: 'lint' },
      { conclusion: 'SUCCESS', state: 'FAILURE' },
      { conclusion: 'FAILURE', state: 'SUCCESS' },
    ];
    checks.forEach((check, index) => fixture.details.set(index + 1, detail(index + 1, { statusCheckRollup: [check] })));
    expect(numbers(await fixture.service().fetch(signal()))).toEqual([['ready-to-merge', [3, 4, 5]], ['needs-fix', [6]]]);
  });
  test('empty/no checks pass only with APPROVED and MERGEABLE; empty review and UNKNOWN are not blockers', async () => {
    const fixture = new Fixture();
    const cases = [
      {}, { statusCheckRollup: null }, { reviewDecision: '' }, { mergeable: 'UNKNOWN' },
      { reviewDecision: '', mergeable: 'UNKNOWN' }, { reviewDecision: 'REVIEW_REQUIRED' },
      { reviewDecision: '', mergeable: 'CONFLICTING' }, { reviewDecision: 'CHANGES_REQUESTED', mergeable: 'UNKNOWN' },
    ];
    fixture.searches[2] = cases.map((_, index) => source(index + 1));
    cases.forEach((value, index) => fixture.details.set(index + 1, detail(index + 1, value)));
    const result = await fixture.service().fetch(signal());
    expect(numbers(result)).toEqual([['ready-to-merge', [1, 2]], ['needs-fix', [7, 8]]]);
    expect(result.buckets[1]!.items.map(item => item.reasons)).toEqual([['conflicts'], ['changes-requested']]);
  });
  test('needs-fix returns every applicable reason in stable order', async () => {
    const fixture = new Fixture();
    fixture.searches[2] = Array.from({ length: 7 }, (_, index) => source(index + 1));
    for (let mask = 1; mask <= 7; mask++) {
      fixture.details.set(mask, detail(mask, {
        reviewDecision: mask & 1 ? 'CHANGES_REQUESTED' : '',
        mergeable: mask & 2 ? 'CONFLICTING' : 'UNKNOWN',
        statusCheckRollup: [{ state: mask & 4 ? 'ERROR' : 'PENDING' }],
      }));
    }
    const result = await fixture.service().fetch(signal());
    expect(result.buckets.map(bucket => bucket.id)).toEqual(['needs-fix']);
    for (const value of result.buckets[0]!.items) {
      const mask = value.reference.number;
      expect(value.reasons).toEqual([
        ...(mask & 1 ? ['changes-requested' as const] : []), ...(mask & 2 ? ['conflicts' as const] : []), ...(mask & 4 ? ['ci' as const] : []),
      ]);
    }
  });
});

test('successful empty results omit all buckets; each explicit run searches again without caching', async () => {
  const fixture = new Fixture();
  const service = fixture.service();
  for (let index = 0; index < 2; index++) {
    expect(await service.fetch(signal())).toEqual({ fetchedAt: now.toISOString(), viewer: 'ViEwEr', buckets: [], limitedQueries: [] });
  }
  expect(fixture.calls).toEqual([...Array.from({ length: 2 }, () => [authArgs, ...commands]).flat()]);
});

test('50-hit searches report limits before filtering/dedup; all six searches bound the total to 300', async () => {
  const fixture = new Fixture();
  fixture.searches = commands.map((_, index) => Array.from({ length: 50 }, (_, offset) => source(index * 100 + offset + 1)));
  const result = await fixture.service().fetch(signal());
  expect(result.limitedQueries).toEqual(['direct-review', 'team-review', 'authored', 'mentioned', 'reviewed', 'assigned']);
  expect(result.buckets.reduce((count, bucket) => count + bucket.items.length, 0)).toBe(300);
  expect(fixture.calls).toHaveLength(57);
  fixture.searches = commands.map((_, index) => Array.from({ length: 50 }, () => source(1, {
    isDraft: true, updatedAt: daysAgo(31), author: null,
  })));
  const filtered = await fixture.service().fetch(signal());
  expect(filtered.buckets).toEqual([]);
  expect(filtered.limitedQueries).toEqual(result.limitedQueries);
  fixture.searches = [Array.from({ length: 49 }, (_, index) => source(index + 1)), [], [], [], [], []];
  expect((await fixture.service().fetch(signal())).limitedQueries).toEqual([]);
});

describe('all-or-nothing upstream failures', () => {
  test('auth failure, malformed viewer and missing CLI stop before searches', async () => {
    for (const override of [
      { code: 1, stdout: 'HTTP/2.0 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{"message":"secret"}' },
      { code: 1, stdout: 'secret private text' },
      new ServiceError('authentication'),
    ]) {
      const fixture = new Fixture();
      fixture.overrides.set('auth', override);
      await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'authentication' } });
      expect(fixture.calls).toEqual([authArgs]);
    }
    for (const viewer of [null, {}, { login: '' }, { login: 'bad/login' }, { login: 'a'.repeat(101) }]) {
      const fixture = new Fixture();
      fixture.viewer = viewer;
      await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
      expect(fixture.calls).toEqual([authArgs]);
    }
    let runs = 0;
    await expect(new WaitingService({
      resolve: async () => { throw new ServiceError('missing_cli'); },
      runner: async () => { runs++; return json([]); },
    }).fetch(signal())).rejects.toMatchObject({ dto: { code: 'missing_cli' } });
    expect(runs).toBe(0);
  });
  for (let index = 0; index < commands.length; index++) {
    test(`search ${index + 1} failure rejects rather than publishing earlier matches, and stops later reads`, async () => {
      for (const [override, code] of [
        [{ code: 1, stdout: 'secret private text' }, 'unavailable'],
        [{ code: 4, stdout: 'secret token' }, 'authentication'],
        [new ServiceError('access'), 'access'],
        [new ServiceError('rate_limit', true), 'rate_limit'],
        [new Error('secret private text'), 'internal'],
        [{ code: 0, stdout: 'malformed private text' }, 'invalid_output'],
        [json({ items: [] }), 'invalid_output'],
      ] as const) {
        const fixture = new Fixture();
        fixture.searches[0] = [source(1)];
        fixture.searches[2] = [source(2)];
        fixture.overrides.set(`search:${index}`, override);
        const reply = await oneReply(handler(fixture));
        expect(reply).toMatchObject({ ok: false, error: { code } });
        expect(reply.result).toBeUndefined();
        expect(JSON.stringify(reply)).not.toMatch(/secret|private text/);
        expect(fixture.calls).toEqual([authArgs, ...commands.slice(0, index + 1)]);
      }
    });
  }
  test('all search identities and displayed fields validate even for skipped drafts', async () => {
    for (const value of [
      source(1, { number: 0 }), source(1, { number: 1.1 }), source(1, { number: Number.MAX_SAFE_INTEGER + 1 }),
      source(1, { title: 'x'.repeat(501) }), source(1, { title: null }), source(1, { updatedAt: 'yesterday' }),
      source(1, { updatedAt: '2026-02-30T00:00:00Z' }),
      source(1, { repository: { full_name: 'octo/project' } }),
      source(1, { repository: { nameWithOwner: 'octo/project;touch-secret' } }),
      source(1, { repository: { nameWithOwner: '--repo/malicious' } }),
      source(1, { author: {} }), source(1, { author: { login: 'bad/login' } }),
      source(1, { author: undefined }), source(1, { isDraft: null }), source(1, { isDraft: undefined }),
      source(1, { isDraft: true, title: 'x'.repeat(501) }),
    ]) {
      const fixture = new Fixture();
      fixture.searches[0] = [value];
      await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
      expect(fixture.calls).toEqual([authArgs, commands[0]!]);
    }
    const fixture = new Fixture();
    fixture.searches[0] = [source(1, { title: 'x'.repeat(500) })];
    expect((await fixture.service().fetch(signal())).buckets[0]!.items[0]!.title).toHaveLength(500);
  });
  test('enrichment failures are errors even when another bucket is usable', async () => {
    for (const [override, code] of [
      [{ code: 1, stdout: 'secret' }, 'unavailable'],
      [{ code: 4, stdout: 'secret' }, 'authentication'],
      [new ServiceError('access'), 'access'], [new ServiceError('rate_limit'), 'rate_limit'],
      [new Error('secret'), 'internal'], [{ code: 0, stdout: 'not JSON secret' }, 'invalid_output'],
    ] as const) {
      const fixture = new Fixture();
      fixture.searches[0] = [source(10)];
      fixture.searches[2] = [source(1)];
      fixture.overrides.set('view:1', override);
      const reply = await oneReply(handler(fixture));
      expect(reply).toMatchObject({ ok: false, error: { code } });
      expect(reply.result).toBeUndefined();
      expect(JSON.stringify(reply)).not.toContain('secret');
    }
  });
  test('malformed enrichment and rollups cannot fake passing; number must match even for drafts', async () => {
    const invalid = [
      null, [], {}, detail(2), detail(2, { isDraft: true }), detail(1, { number: undefined }),
      detail(1, { reviewDecision: undefined }), detail(1, { reviewDecision: null }), detail(1, { reviewDecision: 'unknown' }),
      detail(1, { mergeable: undefined }), detail(1, { mergeable: null }), detail(1, { mergeable: 'yes' }),
      detail(1, { isDraft: undefined }), detail(1, { isDraft: 'false' }),
      detail(1, { statusCheckRollup: undefined }), detail(1, { statusCheckRollup: {} }),
      ...[null, {}, 'SUCCESS', { status: 'COMPLETED' }, { conclusion: 'BOGUS' }, { conclusion: 1 },
        { conclusion: 'SUCCESS', state: 'BOGUS' }, { conclusion: 'SUCCESS', status: 'BOGUS' },
        { __typename: 'Other', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', state: 'SUCCESS' },
        { __typename: 'StatusContext', conclusion: 'SUCCESS' },
      ].map(check => detail(1, { statusCheckRollup: [check] })),
      detail(1, { statusCheckRollup: Array.from({ length: 1_001 }, () => ({ state: 'SUCCESS' })) }),
    ];
    for (const value of invalid) {
      const fixture = new Fixture();
      fixture.searches[2] = [source(1)];
      fixture.details.set(1, value);
      await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
    }
  });
  test('oversized search counts and CLI JSON reject with explicit limits', async () => {
    for (const override of [
      json(Array.from({ length: 51 }, (_, index) => source(index + 1))),
      { code: 0, stdout: ' '.repeat(LIMITS.processBytes + 1) },
    ]) {
      const fixture = new Fixture();
      fixture.overrides.set('search:0', override);
      await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'limit' } });
      expect(fixture.calls).toEqual([authArgs, commands[0]!]);
    }
  });
});

test('authored enrichment uses at most three workers and preserves deterministic output', async () => {
  const fixture = new Fixture();
  fixture.searches[2] = Array.from({ length: 9 }, (_, index) => source(index + 1));
  let active = 0;
  let peak = 0;
  for (let number = 1; number <= 9; number++) {
    fixture.overrides.set(`view:${number}`, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10 - number));
      active--;
      return json(detail(number));
    });
  }
  expect(numbers(await fixture.service().fetch(signal()))).toEqual([['ready-to-merge', [1, 2, 3, 4, 5, 6, 7, 8, 9]]]);
  expect(peak).toBe(3);
  expect(active).toBe(0);
});

const untilAbort = (signal: AbortSignal, cleaned?: () => void) => new Promise<RunResult>((_resolve, reject) => {
  checkAbort(signal);
  signal.addEventListener('abort', () => { cleaned?.(); reject(signal.reason); }, { once: true });
});

test('first enrichment failure cancels active peers, awaits cleanup and never starts remaining work', async () => {
  const fixture = new Fixture();
  fixture.searches[2] = [1, 2, 3, 4, 5].map(number => source(number));
  let cleaned = 0;
  fixture.overrides.set('view:1', async () => { await Promise.resolve(); throw new ServiceError('access'); });
  fixture.overrides.set('view:2', signal => untilAbort(signal, () => { cleaned++; }));
  fixture.overrides.set('view:3', signal => untilAbort(signal, () => { cleaned++; }));
  await expect(fixture.service().fetch(signal())).rejects.toMatchObject({ dto: { code: 'access' } });
  expect(fixture.calls.filter(args => args[0] === 'pr').map(args => args[2])).toEqual(['1', '2', '3']);
  expect(cleaned).toBe(2);
});

test('pre-cancellation, query cancellation and process deadlines use sanitized read-only messages', async () => {
  for (const reason of [undefined, new ServiceError('cancelled'), new ServiceError('deadline', true)]) {
    const fixture = new Fixture();
    const controller = new AbortController();
    controller.abort(reason);
    const error = await fixture.service().fetch(controller.signal).catch(sanitized);
    expect(error).toMatchObject({ code: reason?.dto.code ?? 'cancelled' });
    expect((error as { message: string }).message).toContain('read-only');
    expect(fixture.calls).toEqual([]);
    expect(fixture.resolutions).toEqual([]);
  }
  for (const code of ['cancelled', 'deadline'] as const) {
    const fixture = new Fixture();
    const controller = new AbortController();
    fixture.overrides.set('search:2', async () => {
      controller.abort(new ServiceError(code, true));
      return json([]);
    });
    const error = await fixture.service().fetch(controller.signal).catch(sanitized);
    expect(error).toMatchObject({ code });
    expect((error as { message: string }).message).not.toContain('external write');
    expect(fixture.calls).toEqual([authArgs, ...commands.slice(0, 3)]);
    const processFailure = new Fixture();
    processFailure.overrides.set('search:0', new ServiceError(code, true));
    expect(await processFailure.service().fetch(signal()).catch(sanitized)).toMatchObject({ code, message: expect.stringContaining('read-only') });
  }
});

test('overall deadline covers auth, sequential queries, and enrichment without returning a partial digest', async () => {
  for (const stage of ['auth', 'search:4', 'view:1']) {
    const fixture = new Fixture();
    fixture.searches[0] = [source(10)];
    fixture.searches[2] = [source(1)];
    let aborted = false;
    fixture.overrides.set(stage, signal => untilAbort(signal, () => { aborted = true; }));
    const error = await fixture.service({ deadlineMs: 10 }).fetch(signal()).catch(sanitized);
    expect(error).toMatchObject({ code: 'deadline', retryable: true, message: expect.stringContaining('read-only') });
    expect(aborted).toBe(true);
  }
});

test('JSONL routes strict github.waiting without GitHub notifications or any Copilot connection/generation', async () => {
  const fixture = new Fixture();
  expect(await oneReply(handler(fixture))).toEqual({
    v: 1, id: 'waiting', ok: true,
    result: { fetchedAt: now.toISOString(), viewer: 'ViEwEr', buckets: [], limitedQueries: [] },
  });
  expect(fixture.calls).toEqual([authArgs, ...commands]);
  for (const input of [{ command: 'rm -rf' }, { args: ['--limit', '1000'] }, { team: 'other/all' }, { model: 'anything' }, [], null]) {
    fixture.calls = [];
    expect(await oneReply(handler(fixture), 'github.waiting', input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(fixture.calls).toEqual([]);
  }
  for (const op of ['github.search', 'github.waiting.run', 'shell']) {
    expect(requestSchema.safeParse({ v: 1, id: 'x', op, input: {} }).success).toBe(false);
  }
});

test('JSONL explicit cancellation and outer deadline abort waiting queries with read-only failures', async () => {
  for (const cancel of [true, false]) {
    const fixture = new Fixture();
    const input = new PassThrough();
    const replies: { id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    fixture.overrides.set('search:0', signal => { started(); return untilAbort(signal); });
    const task = serve(input, async line => {
      replies.push(JSON.parse(line));
      if (replies.some(reply => reply.id === 'waiting')) input.end();
    }, handler(fixture), { deadlineMs: cancel ? 1_000 : 20 });
    input.write(JSON.stringify({ v: 1, id: 'waiting', op: 'github.waiting', input: {} }) + '\n');
    await running;
    if (cancel) input.write(JSON.stringify({ v: 1, id: 'cancel', op: 'cancel', input: { requestId: 'waiting' } }) + '\n');
    await task;
    const reply = replies.find(value => value.id === 'waiting');
    expect(reply).toMatchObject({ ok: false, error: { code: cancel ? 'cancelled' : 'deadline' } });
    expect(reply!.error!.message).toContain('read-only');
    expect(fixture.calls).toEqual([authArgs, commands[0]!]);
  }
});

test('response contract rejects unknown fields, buckets, duplicates, empty buckets and over-limit output', async () => {
  const value: WaitingItem = {
    reference: { repo: 'octo/project', kind: 'pr', number: 1 }, title: 'Title', author: null, updatedAt: daysAgo(1), reasons: [],
  };
  const valid: WaitingDigest = {
    fetchedAt: now.toISOString(), viewer: 'viewer', limitedQueries: [], buckets: [{ id: 'direct-review', items: [value] }],
  };
  for (const invalid of [
    { ...valid, report: 'No items' }, { ...valid, fetchedAt: 'today' }, { ...valid, viewer: null },
    { ...valid, buckets: [{ id: 'authored', items: [value] }] },
    { ...valid, buckets: [{ id: 'direct-review', items: [] }] },
    { ...valid, buckets: [{ id: 'direct-review', items: [{ ...value, title: 'x'.repeat(501) }] }] },
    { ...valid, buckets: [{ id: 'direct-review', items: [{ ...value, reasons: ['ci'] }] }] },
    { ...valid, buckets: [{ id: 'needs-fix', items: [value] }] },
    { ...valid, buckets: [{ id: 'needs-fix', items: [{ ...value, reasons: ['ci', 'ci'] }] }] },
    { ...valid, buckets: [{ id: 'assigned', items: [value] }] },
    { ...valid, buckets: [{ id: 'team-review', items: [value] }, { id: 'direct-review', items: [{ ...value, reference: { ...value.reference, number: 2 } }] }] },
    { ...valid, buckets: [{ id: 'direct-review', items: [value] }, { id: 'team-review', items: [{ ...value, reference: { ...value.reference, repo: 'OCTO/PROJECT' } }] }] },
    { ...valid, limitedQueries: ['ready-to-merge'] }, { ...valid, limitedQueries: ['authored', 'authored'] },
    { ...valid, buckets: [{ id: 'direct-review', items: Array.from({ length: 51 }, (_, index) => ({ ...value, reference: { ...value.reference, number: index + 1 } })) }] },
    { ...valid, buckets: ['direct-review', 'team-review', 'ready-to-merge', 'needs-fix', 'mentioned', 'reviewed', 'assigned'].map((id, bucket) => ({
      id, items: Array.from({ length: 50 }, (_, index) => ({
        ...value, reference: { ...value.reference, kind: id === 'assigned' ? 'issue' : 'pr', number: bucket * 100 + index + 1 },
        reasons: id === 'needs-fix' ? ['ci'] : [],
      })),
    })) },
  ]) expect(waitingSchema.safeParse(invalid).success).toBe(false);
  expect(waitingSchema.safeParse(valid).success).toBe(true);
  expect((await oneReply(async () => ({ ...valid, buckets: [{ id: 'direct-review', items: [] }] })))).toMatchObject({
    ok: false, error: { code: 'invalid_output' },
  });
});
