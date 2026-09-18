import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServiceError } from '../src/errors.ts';
import { WorkGitHub } from '../src/work-github.ts';
import {
  CACHE_ENTRY_BYTES, cacheHash, emptyGitHubCache, incrementalSearchSafe,
  SEARCH_OVERLAP_MS, SEARCH_RECONCILE_MS, WorkGitHubCache, type GitHubCacheState,
} from '../src/work-github-cache.ts';
import type { CopilotService } from '../src/copilot.ts';
import type { Runner } from '../src/process.ts';
import { workSourceContextSchema, type Workstream } from '../src/work-schema.ts';

const start = '2026-09-18T12:00:00.000Z';
const old = '2026-08-01T12:00:00.000Z';
const stream: Workstream = {
  id: 'saved-search', name: 'Assigned work', enabled: true, kind: 'github',
  query: 'repo:octo/repo is:issue assignee:@me', action: 'implement', server: '', tools: [],
};
const url = (number: number, pr = false) => `https://github.com/octo/repo/${pr ? 'pull' : 'issues'}/${number}`;
const root = (number: number) => ({
  id: number, number, title: `Issue ${number}`, body: 'Original body', state: 'open',
  user: { login: 'author' }, created_at: old, updated_at: old,
  labels: [{ name: 'ready' }], assignees: [] as { login: string }[],
});
const graph = () => ({
  state: 'OPEN', mergeQueueEntry: null as { id: string } | null, headRefOid: 'a'.repeat(40),
  isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  commits: { nodes: [{ commit: { committedDate: old, statusCheckRollup: {
    contexts: { nodes: [{
      __typename: 'CheckRun', id: 'check-1', name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS',
      startedAt: old, completedAt: old,
    }], pageInfo: { hasNextPage: false } },
  } } }] },
});
const event = (number: number, id = number, body = '@viewer please explain this.') => ({
  id, event: 'commented', created_at: old, body,
  html_url: `${url(number)}#issuecomment-${id}`,
});
const response = (body: unknown, status = 200) => ({
  code: status < 400 ? 0 : 1,
  stdout: `HTTP/2 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
});

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, count = 1) {
  const f = await setup(count);
  try { await run(f); }
  finally { f.service.close(); await rm(f.directory, { recursive: true, force: true }); }
}
async function setup(count: number) {
  const directory = await mkdtemp(join(tmpdir(), 'work-github-cache-test-'));
  const path = join(directory, 'cache.sqlite3');
  const sources = new Map(Array.from({ length: count }, (_, i) => [i + 1, root(i + 1)]));
  const events = new Map(Array.from({ length: count }, (_, i) => [i + 1, [event(i + 1)]]));
  const matches = new Set(sources.keys());
  const prs = new Map<number, ReturnType<typeof graph>>();
  const paths: string[] = [];
  const modelInputs: Parameters<CopilotService['extractReplies']>[0][] = [];
  const world = {
    now: Date.parse(start), account: { id: 1, login: 'viewer' },
    fail: new Map<string, number>(), incomplete: false, duplicatePage: false,
    failModel: false, emptyModel: false,
    beforeSearch: undefined as ((params: URLSearchParams) => void) | undefined,
    beforeUser: undefined as (() => void) | undefined,
  };
  const runner: Runner = async (_exe, args, signal, body) => {
    expect(signal.aborted).toBe(false);
    const target = args.find(arg => arg.startsWith('/'))!;
    paths.push(target);
    if (world.fail.has(target)) return response({}, world.fail.get(target)!);
    if (target === '/user') { world.beforeUser?.(); return response(world.account); }
    if (target.startsWith('/search/issues?')) {
      const params = new URL(`https://api.github.com${target}`).searchParams;
      world.beforeSearch?.(params);
      const range = / updated:([^\s]+)\.\.([^\s]+)/.exec(params.get('q')!);
      const matching = [...matches].filter(number => {
        const source = sources.get(number)!;
        return source.state === 'open' && (!range || Date.parse(source.updated_at) >= Date.parse(range[1]!)
          && Date.parse(source.updated_at) <= Date.parse(range[2]!));
      }).sort((a, b) => sources.get(a)!.updated_at.localeCompare(sources.get(b)!.updated_at) || a - b);
      const page = Number(params.get('page'));
      const numbers = matching.slice((page - 1) * 100, page * 100);
      if (world.duplicatePage && page === 2) numbers[0] = matching[0]!;
      return response({
        total_count: matching.length, incomplete_results: world.incomplete,
        items: numbers.map(number => ({ number, html_url: url(number, prs.has(number)) })),
      });
    }
    if (target === '/graphql') {
      const number = JSON.parse(body!).variables.number as number;
      return response({ data: { repository: { pullRequest: prs.get(number) } } });
    }
    const match = /^\/repos\/octo\/repo\/(issues|pulls)\/(\d+)(\/timeline\?per_page=100&page=1)?$/.exec(target);
    if (!match) throw new Error(`Unexpected synthetic request ${target}`);
    const number = Number(match[2]);
    if (match[3]) return response(events.get(number) ?? []);
    return response(sources.get(number) ?? {}, sources.has(number) ? 200 : 404);
  };
  const copilot: Pick<CopilotService, 'extractReplies'> = {
    extractReplies: async data => {
      modelInputs.push(structuredClone(data));
      if (world.failModel) throw new ServiceError('copilot_output');
      return {
        requests: (world.emptyModel ? [] : data.messages).map(message => ({
          ...message, title: 'Answer the question', action: 'reply' as const,
          summary: message.body, targetUrl: null,
        })), warnings: [],
      };
    },
  };
  let cache = new WorkGitHubCache({ path });
  let service = new WorkGitHub({ cache, runner, resolve: async () => '/synthetic/gh', now: () => new Date(world.now), copilot });
  const collect = (since: string | null = null, override: Partial<Workstream> = {}, options: {
    knownUrls?: string[]; model?: string; observeOnly?: boolean;
  } = {}) => service.collect({
    stream: { ...stream, ...override }, model: '', since, ...options,
  }, new AbortController().signal);
  return {
    directory, path, world, sources, events, matches, prs, paths, modelInputs, collect,
    get service() { return service; }, get cache() { return cache; },
    advance(ms = 60_000) { world.now += ms; },
    restart() {
      service.close();
      cache = new WorkGitHubCache({ path });
      service = new WorkGitHub({ cache, runner, resolve: async () => '/synthetic/gh', now: () => new Date(world.now), copilot });
    },
    states() {
      const db = new Database(path, { readonly: true });
      try {
        return db.query<{ payload: string }, []>('SELECT payload FROM collections').all()
          .map(row => JSON.parse(row.payload) as GitHubCacheState);
      } finally { db.close(); }
    },
    queries() { return paths.filter(path => path.startsWith('/search/issues?')).map(path => new URL(`https://api.github.com${path}`).searchParams.get('q')!); },
    count(part: string) { return paths.filter(path => path.includes(part)).length; },
  };
}

describe('durable incremental saved searches', () => {
  test('unchanged cache survives restart, authenticates every source, and avoids all timeline/model rereads', async () => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      expect(first.candidates).toHaveLength(3);
      expect(f.count('/timeline')).toBe(3);
      expect(f.modelInputs).toHaveLength(1);
      expect(f.paths).toHaveLength(9); // viewer, search, 3 roots, 3 timelines, viewer confirmation
      f.restart();
      f.advance();
      const second = await f.collect(first.collectedAt, { action: 'reply' });
      expect(second.candidates).toEqual(first.candidates);
      expect(f.count('/timeline')).toBe(3);
      expect(f.modelInputs).toHaveLength(1);
      expect(f.paths).toHaveLength(15);
      expect(f.queries()[1]).toContain(' updated:2026-09-18T11:55:00.000Z..2026-09-18T12:01:00.000Z');
      expect(f.paths.filter(path => /^\/repos\/octo\/repo\/issues\/\d$/.test(path))).toHaveLength(6);
      expect(second.observations[0]!.context).toEqual(first.observations[0]!.context);
      expect(second.warnings).toEqual([]);
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    }, 3);
  });

  test('old issues edited or reopened enter updated discovery; creation time never becomes the cursor', async () => {
    await fixture(async f => {
      f.matches.clear();
      const first = await f.collect();
      expect(first.candidates).toEqual([]);
      f.advance();
      const edited = f.sources.get(1)!;
      edited.title = 'Changed old title';
      edited.body = 'Changed old body';
      edited.labels = [{ name: 'urgent' }];
      edited.updated_at = new Date(f.world.now).toISOString();
      f.matches.add(1);
      const second = await f.collect(first.collectedAt);
      expect(second.candidates[0]!.evidence[0]!.at).toBe(old);
      expect(second.observations[0]!.context).toMatchObject({ title: edited.title, body: edited.body, labels: ['urgent'] });
      edited.state = 'closed';
      f.advance();
      const closed = await f.collect(second.collectedAt);
      expect(closed.observations[0]!.state).toBe('closed');
      edited.state = 'open';
      edited.updated_at = new Date(f.world.now).toISOString();
      f.advance();
      const reopened = await f.collect(closed.collectedAt);
      expect(reopened.candidates).toHaveLength(1);
      expect(reopened.observations[0]!.state).toBe('open');
      expect(f.queries().slice(1).every(query => query.includes('updated:') && !query.includes('created:'))).toBe(true);
    });
  });

  test('full reconciliation removes query membership but still observes tracked/removed/closed sources', async () => {
    await fixture(async f => {
      const first = await f.collect();
      f.matches.delete(1);
      f.sources.get(2)!.state = 'closed';
      f.advance(SEARCH_RECONCILE_MS);
      const second = await f.collect(first.collectedAt, {}, { knownUrls: [url(1), url(2)] });
      expect(f.queries()[1]).not.toContain('updated:');
      expect(second.candidates).toEqual([]);
      expect(second.observations.find(observation => observation.url === url(1))!.state).toBe('open');
      expect(second.observations.find(observation => observation.url === url(2))!.state).toBe('closed');
      expect(f.states()[0]!.members).toEqual([]);
      f.sources.delete(1);
      f.advance();
      const deleted = await f.collect(second.collectedAt, {}, { knownUrls: [url(1)] });
      expect(deleted.observations[0]).toMatchObject({ state: 'unknown' });
      expect(deleted.observations[0]!.context).toBeUndefined();
      expect(deleted.warnings.length).toBeGreaterThan(0);
    }, 2);
  });

  test.each(['cap', 'incomplete', 'duplicate'] as const)('an initial %s search never establishes a baseline or silently skips the remainder', async kind => {
    await fixture(async f => {
      f.world.incomplete = kind === 'incomplete';
      f.world.duplicatePage = kind === 'duplicate';
      const first = await f.collect();
      expect(first.warnings.join(' ')).toMatch(/capped|incomplete/);
      expect(f.states()[0]!.scannedAt).toBeNull();
      expect(f.states()[0]!.reconciledAt).toBeNull();
      f.restart();
      f.advance();
      await f.collect(first.collectedAt);
      expect(f.queries().every(query => !query.includes('updated:'))).toBe(true);
      expect(f.states()[0]!.scannedAt).toBeNull();
    }, kind === 'cap' ? 201 : kind === 'duplicate' ? 150 : 1);
  });

  test('overlap includes the exact boundary and concurrent updates remain eligible next run', async () => {
    await fixture(async f => {
      f.matches.clear();
      const first = await f.collect();
      f.advance();
      f.sources.get(1)!.updated_at = '2026-09-18T11:55:00.000Z';
      f.matches.add(1);
      f.world.beforeSearch = () => {
        f.world.beforeSearch = undefined;
        f.sources.set(2, { ...root(2), updated_at: new Date(f.world.now + 1000).toISOString() });
        f.matches.add(2);
        f.world.now += 2000;
      };
      const second = await f.collect(first.collectedAt);
      expect(second.collectedAt).toBe('2026-09-18T12:01:00.000Z');
      expect(second.candidates.map(candidate => candidate.url)).toEqual([url(1)]);
      f.advance();
      const third = await f.collect(second.collectedAt);
      expect(third.candidates.map(candidate => candidate.url).sort()).toEqual([url(1), url(2)]);
    });
  });

  test('backend checkpoint before desktop save replays a now-unmatched discovery after restart', async () => {
    await fixture(async f => {
      const first = await f.collect();
      const previousDesktopCursor = new Date(Date.parse(first.collectedAt) - 1).toISOString();
      f.matches.clear();
      f.restart();
      f.advance(SEARCH_RECONCILE_MS);
      const replay = await f.collect(previousDesktopCursor);
      expect(replay.candidates).toEqual(first.candidates);
      expect(replay.observations[0]!.state).toBe('open');
      expect(f.states()[0]!.pending).toHaveLength(1);
      f.advance();
      const acknowledged = await f.collect(replay.collectedAt);
      expect(acknowledged.candidates).toEqual([]);
      expect(f.states()[0]!.pending).toEqual([]);
    });
  });

  test('failed ranking/null desktop cursor reuses extraction while replaying pending discoveries', async () => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      f.advance();
      f.restart();
      const retry = await f.collect(null, { action: 'reply' });
      expect(retry.candidates).toEqual(first.candidates);
      expect(f.modelInputs).toHaveLength(1);
      expect(f.count('/timeline')).toBe(1);
      expect(f.states()[0]!.pending).toHaveLength(1);
    });
  });

  test('empty successful extraction is reusable, not mistaken for a cache miss', async () => {
    await fixture(async f => {
      f.world.emptyModel = true;
      const first = await f.collect(null, { action: 'reply' });
      expect(first.candidates).toEqual([]);
      expect(first.warnings).toEqual([]);
      f.advance();
      f.restart();
      const next = await f.collect(first.collectedAt, { action: 'reply' });
      expect(next.candidates).toEqual([]);
      expect(f.modelInputs).toHaveLength(1);
      expect(f.count('/timeline')).toBe(1);
    });
  });

  test('full reconciliation recovers delayed search indexing and refreshes old timelines', async () => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      f.events.get(1)!.push(event(1, 99, 'A comment missing from earlier source timestamps'));
      f.sources.set(2, root(2));
      f.events.set(2, [event(2)]);
      f.matches.add(2);
      f.advance(SEARCH_RECONCILE_MS);
      const next = await f.collect(first.collectedAt, { action: 'reply' });
      expect(f.queries()[1]).not.toContain('updated:');
      expect(next.candidates).toHaveLength(2);
      expect(next.candidates.find(candidate => candidate.url === url(1))!.evidence).toHaveLength(2);
      expect(f.modelInputs).toHaveLength(2);
      expect(f.count('/timeline')).toBe(3);
    });
  });

  test('incomplete delta and failed search retain the last durable successful boundary', async () => {
    await fixture(async f => {
      const first = await f.collect();
      f.advance();
      f.world.incomplete = true;
      const partial = await f.collect(first.collectedAt);
      expect(partial.warnings.join(' ')).toContain('incomplete');
      expect(f.states()[0]!.scannedAt).toBe(first.collectedAt);
      expect(partial.candidates).toEqual(first.candidates);
      f.advance();
      f.world.beforeSearch = () => { throw new ServiceError('unavailable'); };
      await expect(f.collect(first.collectedAt)).rejects.toMatchObject({ dto: { code: 'unavailable' } });
      expect(f.states()[0]!.scannedAt).toBe(first.collectedAt);
    });
  });

  test('failed timeline and model reads retain the previous cursor and can be retried', async () => {
    await fixture(async f => {
      const timeline = '/repos/octo/repo/issues/1/timeline?per_page=100&page=1';
      f.world.fail.set(timeline, 403);
      const failed = await f.collect(null, { action: 'reply' });
      expect(failed.warnings.length).toBeGreaterThan(0);
      expect(f.states()[0]!.scannedAt).toBeNull();
      f.world.fail.clear();
      f.world.failModel = true;
      f.advance();
      const modelFailed = await f.collect(null, { action: 'reply' });
      expect(modelFailed.warnings.join(' ')).toContain('Reply extraction failed');
      expect(f.states()[0]!.scannedAt).toBeNull();
      f.world.failModel = false;
      f.restart();
      f.advance();
      const retry = await f.collect(null, { action: 'reply' });
      expect(retry.candidates).toHaveLength(1);
      expect(retry.warnings).toEqual([]);
      expect(f.states()[0]!.scannedAt).toBe(retry.collectedAt);
      expect(f.modelInputs).toHaveLength(2);
      expect(f.count('/timeline')).toBe(2);
    });
  });

  test('failed cache persistence cannot advance coverage or lose a discovery on retry', async () => {
    await fixture(async f => {
      const original = f.cache.save.bind(f.cache);
      f.cache.save = () => { throw new ServiceError('internal'); };
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'internal' } });
      expect(f.states()).toEqual([]);
      f.cache.save = original;
      f.restart();
      f.advance();
      const retry = await f.collect();
      expect(retry.candidates).toHaveLength(1);
      expect(f.queries().every(query => !query.includes('updated:'))).toBe(true);
      expect(f.states()[0]!.pending).toHaveLength(1);
    });
  });

  test('query, stream settings, model and account IDs cannot share a collection cache', async () => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      f.advance();
      await f.collect(first.collectedAt, { action: 'reply', query: 'repo:octo/repo label:ready' });
      f.advance();
      await f.collect(first.collectedAt, { action: 'reply', name: 'Different saved settings' });
      f.advance();
      await f.collect(first.collectedAt, { action: 'reply' }, { model: 'different-model' });
      f.advance();
      f.world.account = { id: 2, login: 'viewer' };
      f.sources.get(1)!.body = 'Account two content';
      const accountTwo = await f.collect(first.collectedAt, { action: 'reply' });
      expect(accountTwo.observations[0]!.context!.body).toBe('Account two content');
      expect(f.queries().every(query => !query.includes('updated:'))).toBe(true);
      expect(f.modelInputs).toHaveLength(5);
      expect(f.states()).toHaveLength(5);
      expect(f.count('/timeline')).toBe(5);
    });
  });

  test.each([403, 404])('cached private content is not emitted after a live %i permission read', async status => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      f.world.fail.set('/repos/octo/repo/issues/1', status);
      f.advance();
      f.restart();
      const denied = await f.collect(null, { action: 'reply' });
      expect(denied.candidates).toEqual([]);
      expect(denied.observations[0]!.state).toBe('unknown');
      expect(denied.observations[0]!.context).toBeUndefined();
      expect(JSON.stringify(denied)).not.toContain('Original body');
      expect(f.states()[0]!.scannedAt).toBe(first.collectedAt);
      expect(f.states()[0]!.pending).toHaveLength(1);
      f.world.fail.clear();
      f.advance();
      expect((await f.collect(null, { action: 'reply' })).candidates).toEqual(first.candidates);
      expect(f.modelInputs).toHaveLength(1);
    });
  });

  test('authentication failure or a mid-scan account switch rejects the entire result', async () => {
    await fixture(async f => {
      f.world.fail.set('/user', 401);
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'authentication' } });
      expect(f.paths).toEqual(['/user']);
      f.world.fail.clear();
      let reads = 0;
      f.world.beforeUser = () => { if (++reads === 2) f.world.account = { id: 2, login: 'other' }; };
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'authentication' } });
      expect(f.states()).toEqual([]);
    });
  });

  test('PR checks, review and queue state stay live with unchanged root updated_at and empty delta search', async () => {
    await fixture(async f => {
      const pr = graph();
      f.prs.set(1, pr);
      const first = await f.collect(null, { action: 'fix', query: 'repo:octo/repo is:pr author:@me' });
      expect(first.candidates).toEqual([]);
      const oldRevision = first.observations[0]!.context!.revision;
      f.advance();
      const check = pr.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!;
      check.conclusion = 'FAILURE';
      check.completedAt = new Date(f.world.now).toISOString();
      const failed = await f.collect(first.collectedAt, { action: 'fix', query: 'repo:octo/repo is:pr author:@me' });
      expect(failed.candidates[0]!.evidence[0]!.summary).toContain('FAILURE');
      expect(failed.observations[0]!.context!.body).toContain('"conclusion":"FAILURE"');
      expect(failed.observations[0]!.context!.revision).not.toBe(oldRevision);
      expect(f.count('/timeline')).toBe(1);
      expect(f.count('/graphql')).toBe(2);
      f.advance();
      pr.reviewDecision = 'CHANGES_REQUESTED';
      const reviewed = await f.collect(failed.collectedAt, { action: 'fix', query: 'repo:octo/repo is:pr author:@me' });
      expect(reviewed.observations[0]!.context!.body).toContain('"reviewDecision":"CHANGES_REQUESTED"');
      expect(reviewed.candidates[0]!.evidence.length).toBeGreaterThan(1);
      expect(f.count('/timeline')).toBe(2);
      f.advance();
      pr.mergeQueueEntry = { id: 'queue-1' };
      const queued = await f.collect(reviewed.collectedAt, { action: 'fix', query: 'repo:octo/repo is:pr author:@me' });
      expect(queued.candidates).toEqual([]);
      expect(queued.observations[0]!.state).toBe('queued');
      expect(queued.observations[0]!.context!.body).toContain('"queued":true');
      expect(f.sources.get(1)!.updated_at).toBe(old);
    });
  });

  test('changed comments re-extract only their source and edited body/title/labels update tracked-only context', async () => {
    await fixture(async f => {
      const first = await f.collect(null, { action: 'reply' });
      f.advance();
      f.events.set(1, [event(1, 77, 'Changed question')]);
      const source = f.sources.get(1)!;
      source.updated_at = new Date(f.world.now).toISOString();
      const second = await f.collect(first.collectedAt, { action: 'reply' });
      expect(f.modelInputs).toHaveLength(2);
      expect(f.modelInputs[1]!.messages).toHaveLength(1);
      expect(second.candidates.find(candidate => candidate.url === url(1))!.evidence[0]!.id).toContain('77');
      expect(f.count('/timeline')).toBe(4);
      f.advance();
      source.title = 'New title with the same creation event';
      source.body = 'New source body with no new event';
      source.labels = [{ name: 'z' }, { name: 'a' }];
      const tracked = await f.collect(second.collectedAt, {}, { knownUrls: [url(1)], observeOnly: true });
      expect(tracked.candidates).toEqual([]);
      expect(tracked.observations[0]!.context).toMatchObject({ title: source.title, body: source.body, labels: ['a', 'z'] });
      expect(tracked.observations[0]!.context!.revision).not.toBe(first.observations.find(observation => observation.url === url(1))!.context!.revision);
      expect(f.queries()).toHaveLength(2);
      expect(f.modelInputs).toHaveLength(2);
    }, 3);
  });

  test.each([
    'repo:octo/repo updated:>=2026-09-01',
    'repo:octo/repo created:>=@today-7d',
    'repo:octo/repo created:>=2026-01-01',
    'repo:octo/repo OR repo:other/repo',
    '(repo:octo/repo is:issue)',
    'repo:octo/repo sort:created-desc',
    'repo:octo/repo unknown:qualifier',
    'repo:octo/repo label:"unterminated',
  ])('unsafe/dynamic expression remains unchanged on the full-search path: %s', async query => {
    await fixture(async f => {
      const first = await f.collect(null, { query });
      f.advance();
      const second = await f.collect(first.collectedAt, { query });
      expect(f.queries()).toEqual([`${query} is:open archived:false`, `${query} is:open archived:false`]);
      expect(second.coverageInfo!.join(' ')).toContain('full search preserves');
      expect(second.warnings).toEqual([]);
    });
  });

  test('bounded source content reports unknown without truncating; frame overflow does not checkpoint', async () => {
    await fixture(async f => {
      f.sources.get(1)!.body = 'x'.repeat(100001);
      const oversize = await f.collect();
      expect(oversize.observations[0]!.state).toBe('unknown');
      expect(oversize.observations[0]!.context).toBeUndefined();
      expect(oversize.warnings.length).toBeGreaterThan(0);
      expect(f.states()[0]!.scannedAt).toBeNull();
    });
    await fixture(async f => {
      for (const source of f.sources.values()) source.body = '界'.repeat(60000);
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'limit' } });
      expect(f.states()).toEqual([]);
      for (const source of f.sources.values()) source.body = 'Now within the complete response bound';
      expect((await f.collect()).candidates).toHaveLength(10);
      expect(f.states()[0]!.scannedAt).not.toBeNull();
    }, 10);
  });

  test('context labels are normalized, timestamps are not revisions, and strict bounds reject unknown fields', async () => {
    await fixture(async f => {
      const source = f.sources.get(1)!;
      source.labels = [{ name: 'z' }, { name: 'a' }];
      const first = await f.collect();
      f.advance();
      source.labels.reverse();
      source.updated_at = new Date(f.world.now).toISOString();
      const second = await f.collect(first.collectedAt);
      expect(second.observations[0]!.context).toEqual(first.observations[0]!.context);
      expect(workSourceContextSchema.safeParse({ ...second.observations[0]!.context, extra: true }).success).toBe(false);
      expect(second.candidates).toEqual(first.candidates);
    });
  });

  test('content-only edits change current context without manufacturing new immutable evidence', async () => {
    await fixture(async f => {
      const first = await f.collect();
      const source = f.sources.get(1)!;
      source.title = 'Edited source title';
      source.body = 'Edited body without a new source event';
      source.labels = [{ name: 'urgent' }];
      f.advance();
      const second = await f.collect(first.collectedAt);
      expect(second.observations[0]!.context).toMatchObject({ title: source.title, body: source.body, labels: ['urgent'] });
      expect(second.observations[0]!.context!.revision).not.toBe(first.observations[0]!.context!.revision);
      expect(second.candidates[0]!.evidence).toEqual(first.candidates[0]!.evidence);
      expect(f.count('/timeline')).toBe(2);
      expect(source.updated_at).toBe(old);
    });
  });
});

describe('private cache storage and bounds', () => {
  test('corrupt persisted data is an explicit failure, not a cache miss or network fallback', async () => {
    await fixture(async f => {
      await f.collect();
      f.service.close();
      const db = new Database(f.path);
      try { db.exec("UPDATE collections SET payload = '{broken'"); }
      finally { db.close(); }
      f.restart();
      f.paths.length = 0;
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
      expect(f.paths).toEqual(['/user']);
    });
  });

  test('corrupt cached events cannot turn into a successful partial source result', async () => {
    await fixture(async f => {
      await f.collect();
      f.service.close();
      const db = new Database(f.path);
      try {
        const row = db.query<{ key: string; payload: string }, []>('SELECT key, payload FROM collections').get()!;
        const state = JSON.parse(row.payload) as GitHubCacheState;
        state.timelines[0]![1].events = [{ invalid: true }];
        const payload = JSON.stringify(state);
        db.query('UPDATE collections SET payload = ?, checksum = ? WHERE key = ?').run(payload, cacheHash(payload), row.key);
      } finally { db.close(); }
      f.restart();
      f.paths.length = 0;
      await expect(f.collect()).rejects.toMatchObject({ dto: { code: 'invalid_output' } });
      expect(f.paths).toEqual(['/user']);
    });
  });

  test('storage initialization failure and serialized snapshot limits are explicit', async () => {
    await fixture(async f => {
      const blocked = new WorkGitHubCache({ path: f.directory });
      expect(() => blocked.load('test')).toThrow(ServiceError);
      expect(() => f.cache.save('test', 0, { ...emptyGitHubCache(), members: Array(201).fill(url(1)) })).toThrow(ServiceError);
      const large: GitHubCacheState = {
        ...emptyGitHubCache(), timelines: [[url(1), {
          revision: 'a'.repeat(64), fetchedAt: start, events: ['x'.repeat(CACHE_ENTRY_BYTES)], warnings: [],
        }]],
      };
      expect(() => f.cache.save('test', 0, large)).toThrow(ServiceError);
    });
  });

  test('concurrent writers cannot overwrite a newer durable cursor or replay batch', async () => {
    await fixture(async f => {
      const second = new WorkGitHubCache({ path: f.path });
      try {
        const stale = second.load('key');
        f.cache.save('key', 0, { ...emptyGitHubCache(), scannedAt: start, reconciledAt: start });
        expect(() => second.save('key', stale.revision, emptyGitHubCache())).toThrow(ServiceError);
        expect(second.load('key').state.scannedAt).toBe(start);
      } finally { second.close(); }
    });
  });

  test('conjunctive qualifiers retain their meaning; ranges and Boolean syntax never get appended', () => {
    expect(SEARCH_OVERLAP_MS).toBe(300_000);
    expect(SEARCH_RECONCILE_MS).toBe(21_600_000);
    expect(incrementalSearchSafe('repo:octo/repo is:issue -label:"not ready" assignee:viewer')).toBe(true);
    expect(incrementalSearchSafe('repo:octo/repo updated:2025-01-01..2026-01-01')).toBe(false);
    expect(incrementalSearchSafe('repo:octo/repo OR is:issue')).toBe(false);
    expect(cacheHash({ body: 'Changed content' })).not.toBe(cacheHash({ body: 'Original content' }));
  });
});
