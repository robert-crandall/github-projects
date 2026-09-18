import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotService, type SdkClient } from '../src/copilot.ts';
import { WorkGitHub } from '../src/work-github.ts';
import { WorkGitHubCache } from '../src/work-github-cache.ts';
import { WorkAssessmentCache, type AssessmentInput, type OrderInput } from '../src/work-ranking.ts';
import { defaultWorkState, type Workstream } from '../src/work-schema.ts';
import { WorkService } from '../src/work.ts';
import type { Runner } from '../src/process.ts';
import { emptyWorkspace } from '../../src/domain/live.ts';
import { rankInput, reconcileWork } from '../../src/work/engine.ts';
import { stateSchema, type AppState } from '../../src/types.ts';

test('collection, workspace restart and ranking share cache invalidation without changing request evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'work-cache-integration-'));
  const initial = '2026-09-18T12:00:00.000Z';
  const old = '2026-08-01T12:00:00.000Z';
  let clock = Date.parse(initial);
  const sources = [1, 2].map(number => ({
    id: number, number, title: `Issue ${number}`, body: `Original body ${number}`,
    state: 'open', created_at: old, updated_at: old, labels: [{ name: 'ready' }],
    user: { login: 'author' }, assignees: [{ login: 'viewer' }],
  }));
  const stream: Workstream = {
    id: 'integration', name: 'Assigned issues', enabled: true, kind: 'github',
    query: 'repo:octo/repo is:issue assignee:@me', action: 'implement', server: '', tools: [],
  };
  const calls: { phase: 'assess' | 'order'; input: AssessmentInput | OrderInput }[] = [];
  const requests: string[] = [];
  const response = (body: unknown) => ({
    code: 0, stdout: `HTTP/2 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  });
  const runner: Runner = async (_exe, args) => {
    const target = args.find(arg => arg.startsWith('/'))!;
    requests.push(target);
    if (target === '/user') return response({ id: 1, login: 'viewer' });
    if (target.startsWith('/search/issues?')) {
      const query = new URL(`https://api.github.com${target}`).searchParams.get('q')!;
      const range = / updated:([^\s]+)\.\.([^\s]+)/.exec(query);
      const matches = sources.filter(source => source.state === 'open' && (!range
        || Date.parse(source.updated_at) >= Date.parse(range[1]!) && Date.parse(source.updated_at) <= Date.parse(range[2]!)));
      return response({
        total_count: matches.length, incomplete_results: false,
        items: matches.map(source => ({ number: source.number, html_url: `https://github.com/octo/repo/issues/${source.number}` })),
      });
    }
    const match = /^\/repos\/octo\/repo\/issues\/([12])(\/timeline\?per_page=100&page=1)?$/.exec(target);
    if (!match) throw new Error(`Unexpected integration request: ${target}`);
    return response(match[2] ? [] : sources[Number(match[1]) - 1]);
  };
  const client = (): SdkClient => ({
    start: async () => {}, getAuthStatus: async () => ({ isAuthenticated: true }),
    deleteSession: async () => {}, forceStop: async () => {},
    createSession: async config => ({
      sessionId: 'integration', abort: async () => {}, disconnect: async () => {},
      sendAndWait: async message => {
        const data = JSON.parse(message.prompt).input as AssessmentInput | OrderInput;
        const phase = config.systemMessage?.content?.startsWith('Assess') ? 'assess' : 'order';
        calls.push({ phase, input: structuredClone(data) });
        const result = phase === 'assess' ? {
          assessments: data.tasks.map(task => ({
            id: task.id, importance: 'Assigned issue', urgency: 'No deadline established',
            blockers: 'None established', uncertainty: 'No further context',
            supportingEvidence: [{ reference: '$title', summary: 'Assigned source issue' }],
            reevaluateAt: new Date(clock + 86_400_000).toISOString(),
          })),
        } : {
          ranking: data.tasks.map(task => ({ id: task.id, reason: 'Address the assigned issue' })),
          reevaluateAt: new Date(clock + 3_600_000).toISOString(),
        };
        return { data: { content: JSON.stringify(result) } };
      },
    }),
  });
  const start = () => {
    const github = new WorkGitHub({
      cache: new WorkGitHubCache({ path: join(directory, 'github.sqlite3') }),
      runner, resolve: async () => '/fake/gh', now: () => new Date(clock),
    });
    const copilot = new CopilotService({
      assessmentCache: new WorkAssessmentCache(join(directory, 'assessments.sqlite3')),
      stateDirectory: () => directory, now: () => new Date(clock),
      token: async () => 'integration-test-token', cli: async () => '/fake/copilot',
      diagnostic: () => {}, client,
    });
    return { github, service: new WorkService({ github, copilot, now: () => new Date(clock) }) };
  };
  let runtime = start();
  let workspace: AppState = { ...emptyWorkspace(initial, 'UTC'), work: defaultWorkState() };
  const run = async () => {
    const at = new Date(clock).toISOString();
    const batch = await runtime.service.collect({
      stream, model: '', since: workspace.work!.collectionCursor,
      knownUrls: workspace.tasks.filter(task => task.status === 'open').map(task => task.work!.url),
    }, new AbortController().signal);
    expect(batch.warnings).toEqual([]);
    workspace = reconcileWork(workspace, batch, at);
    const ranked = await runtime.service.rank(rankInput(workspace), new AbortController().signal);
    workspace.work!.ranking = {
      orderedIds: ranked.orderedIds, reasons: ranked.reasons,
      rankedAt: ranked.evaluatedAt ?? at, expiresAt: ranked.expiresAt,
    };
    workspace.work!.collectionCursor = at;
    workspace = stateSchema.parse(JSON.parse(JSON.stringify(workspace)));
    return ranked;
  };
  try {
    await run();
    expect(calls.map(call => call.phase)).toEqual(['assess', 'order']);
    expect(workspace.tasks).toHaveLength(2);
    const first = workspace.tasks.find(task => task.work!.url.endsWith('/1'))!;
    first.title = 'My title';
    first.notes = 'My notes';
    await run();
    expect(calls).toHaveLength(4);
    const evidence = structuredClone(first.work!.evidence);
    const timelineReads = requests.filter(request => request.includes('/timeline')).length;

    clock += 60_000;
    runtime.github.close();
    runtime = start();
    const repeated = await run();
    expect(calls).toHaveLength(4);
    expect(requests.filter(request => request.includes('/timeline'))).toHaveLength(timelineReads);
    expect(repeated.evaluatedAt).toBe(initial);

    clock += 60_000;
    sources[0]!.body = 'Deadline changed; full edited source body';
    sources[0]!.updated_at = new Date(clock - 1_000).toISOString();
    await run();
    expect(calls.map(call => call.phase)).toEqual(['assess', 'order', 'assess', 'order', 'assess', 'order']);
    const changed = calls[4]!.input as AssessmentInput;
    expect(changed.tasks).toHaveLength(1);
    expect(changed.tasks[0]).toMatchObject({
      title: 'My title', notes: 'My notes', context: { body: sources[0]!.body },
    });
    expect(workspace.tasks.find(task => task.id === first.id)!.work!.evidence).toEqual(evidence);
    expect((calls[5]!.input as OrderInput).tasks).toHaveLength(2);
    expect(JSON.stringify(calls[5]!.input)).not.toContain(sources[0]!.body);

    clock += 60_000;
    sources[0]!.state = 'closed';
    sources[0]!.updated_at = new Date(clock - 1_000).toISOString();
    const closed = await run();
    expect(calls.map(call => call.phase).slice(6)).toEqual(['order']);
    expect(closed.orderedIds).toHaveLength(1);
    expect(closed.orderedIds).not.toContain(first.id);
    expect(workspace.tasks.find(task => task.id === first.id)).toMatchObject({
      status: 'open', title: 'My title', notes: 'My notes', work: { availability: 'waiting' },
    });
  } finally {
    runtime.github.close();
    await rm(directory, { recursive: true, force: true });
  }
});
