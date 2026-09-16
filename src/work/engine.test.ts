import { describe, expect, test } from 'bun:test';
import {
  defaultWorkState, workCollectOutputSchema, workRankInputSchema, type WorkCollection, type WorkEvidence,
} from '../../service/src/work-schema.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { transition } from '../domain/engine.ts';
import { stateSchema, type AppState, type Task } from '../types.ts';
import { canonicalSource, completeWorkTask, rankInput, rankedTasks, reconcileWork, restoreWorkTask, taskIdentity } from './engine.ts';

const before = '2026-09-15T10:00:00.000Z';
const completed = '2026-09-15T11:00:00.000Z';
const after = '2026-09-15T12:00:00.000Z';
const url = 'https://github.com/Owner/Repo/pull/42';
const slack = 'https://team.slack.com/archives/C123/p1789473600000000';
const state = (): AppState => ({ ...emptyWorkspace(before, 'UTC'), work: defaultWorkState() });
function evidence(id = 'github:event:1', at = before, source: WorkEvidence['source'] = 'github'): WorkEvidence {
  return { id, at, source, streamId: `${source}-stream`, url: source === 'slack' ? slack : url, summary: 'Review requested.' };
}
function batch(events = [evidence()], sourceState: WorkCollection['observations'][number]['state'] = 'open'): WorkCollection {
  return {
    candidates: [{ title: 'Review the change', url, action: 'review', evidence: events }],
    observations: [{ url, state: sourceState, observedAt: after, reason: `Source is ${sourceState}` }],
    warnings: [], collectedAt: after,
  };
}
function done(): AppState {
  const initial = reconcileWork(state(), batch(), before);
  return completeWorkTask(initial, initial.tasks[0]!.id, completed);
}

describe('source identity', () => {
  test('GitHub case, number, issue/pull aliases, subpaths, query and anchor share one identity', () => {
    expect(canonicalSource('https://GITHUB.com/OWNER/RePo/pull/0042/files?x=1#discussion')).toBe('https://github.com/owner/repo/issues/42');
    expect(taskIdentity(url, 'review')).toBe(taskIdentity('https://github.com/owner/repo/issues/42#issuecomment-8', 'review'));
    expect(taskIdentity(url, 'review')).not.toBe(taskIdentity(url, 'review-result'));
    expect(() => canonicalSource('https://user:pass@github.com/owner/repo/pull/42')).toThrow();
  });

  test('Slack permalinks discard thread context without merging distinct messages', () => {
    expect(canonicalSource(`${slack}/?thread_ts=123#reply`)).toBe(slack);
    expect(canonicalSource('https://TEAM.slack.com/archives/C123/p1789473600.000000')).toBe(slack);
    expect(taskIdentity(slack, 'reply')).not.toBe(taskIdentity(slack.replace('000000', '000001'), 'reply'));
  });

  test.each([
    'https://tracker.example/task?id=101',
    'https://tracker.example/CaseSensitive/?id=101#tasks/active',
    'https://tracker.example/app#/task/101',
    'https://github.com/OWNER/Repo/issues?q=is%3Aopen#results',
    'https://team.slack.com/client?channel=C123&message=101#thread',
  ])('unrecognized source formats preserve navigable identity: %s', source => {
    expect(canonicalSource(source)).toBe(source);
  });

  test('generic MCP query and fragment identities remain distinct through collection, Done and replay', () => {
    const urls = [
      'https://tracker.example/task?id=101', 'https://tracker.example/task?id=102',
      'https://tracker.example/app#/task/101', 'https://tracker.example/app#/task/102',
    ];
    expect(new Set(urls.map(source => taskIdentity(source, 'follow-up'))).size).toBe(4);
    const incoming: WorkCollection = {
      candidates: urls.map((url, index) => ({
        title: `Task ${index}`, action: 'follow-up', url,
        evidence: [{ ...evidence(`mcp:${index}`, before, 'mcp'), url }],
      })),
      observations: [], warnings: [], collectedAt: before,
    };
    const initial = reconcileWork(state(), incoming, before);
    expect(initial.tasks).toHaveLength(4);
    expect(initial.tasks.map(task => task.work!.url)).toEqual(urls);
    const completedState = completeWorkTask(initial, initial.tasks[0]!.id, completed);
    const replayed = reconcileWork(completedState, incoming, after);
    expect(replayed.tasks).toHaveLength(4);
    expect(replayed.tasks.map(task => task.status)).toEqual(['done', 'open', 'open', 'open']);
    expect(rankInput(replayed).tasks.map(task => task.url)).toEqual(urls.slice(1));
  });

  test('maximum-length source URLs persist and rank without increasing task or evidence ID limits', () => {
    const prefix = 'https://tracker.example/task?id=';
    const source = prefix + 'x'.repeat(2000 - prefix.length);
    const incoming: WorkCollection = {
      candidates: [{
        title: 'Read the long-linked report', action: 'review-result', url: source,
        evidence: [{ ...evidence('mcp:long', before, 'mcp'), url: source }],
      }],
      observations: [], warnings: [], collectedAt: before,
    };
    expect(source).toHaveLength(2000);
    const initial = reconcileWork(state(), incoming, before);
    const persisted = stateSchema.parse(JSON.parse(JSON.stringify(initial)));
    expect(persisted.tasks[0]!.work!.identity).toBe(`review-result:${source}`);
    expect(persisted.tasks[0]!.work!.identity).toHaveLength(2014);
    const input = rankInput(persisted);
    expect(input.tasks[0]!.url).toBe(source);
    expect(input.tasks[0]!.id.length).toBeLessThanOrEqual(500);
    const replayed = reconcileWork(completeWorkTask(persisted, persisted.tasks[0]!.id, completed), incoming, after);
    expect(replayed.tasks).toHaveLength(1);
    expect(replayed.tasks[0]!.status).toBe('done');
    expect(workRankInputSchema.safeParse({ ...input, tasks: [{ ...input.tasks[0]!, id: 'x'.repeat(501) }] }).success).toBe(false);
    incoming.candidates[0]!.evidence[0]!.id = 'x'.repeat(501);
    expect(workCollectOutputSchema.safeParse(incoming).success).toBe(false);
  });

  test('queries and cross-source requests merge once, preserve provenance, and keep review results separate', () => {
    const first = reconcileWork(state(), batch(), before);
    const incoming = batch([evidence('slack:message:1', before, 'slack'), { ...evidence(), streamId: 'another-github-query' }]);
    incoming.candidates[0]!.url = 'https://github.com/owner/repo/issues/42?source=slack';
    let next = reconcileWork(first, incoming, after);
    next = reconcileWork(next, incoming, after);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]!.id).toBe(first.tasks[0]!.id);
    expect(next.tasks[0]!.work!.evidence.map(item => item.source)).toEqual(['github', 'slack', 'github']);
    expect(next.tasks[0]!.work!.evidence[1]!.url).toBe(slack);
    incoming.candidates[0]!.action = 'review-result';
    expect(reconcileWork(next, incoming, after).tasks).toHaveLength(2);
    expect(first.tasks[0]!.work!.evidence).toHaveLength(1);
  });
});

describe('owner completion boundaries', () => {
  test('retained workspace Done and restore use handled IDs and keep the completion boundary', () => {
    const initial = reconcileWork(state(), batch(), before);
    const key = `a:${initial.tasks[0]!.id}`;
    const completedState = transition({ ...initial, clock: completed }, { type: 'done', key });
    expect(completedState.tasks[0]!.status).toBe('done');
    expect(completedState.tasks[0]!.completedAt).toBe(completed);
    expect(completedState.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1']);
    const repeated = transition({ ...completedState, clock: after }, { type: 'done', key });
    expect(repeated.tasks[0]!.completedAt).toBe(completed);
    expect(repeated.undo).toEqual(completedState.undo);
    const replayed = reconcileWork(repeated, batch([evidence('github:event:1', after), evidence('discovered-old', before)]), after);
    expect(replayed.tasks[0]!.status).toBe('done');
    const restored = transition(replayed, { type: 'restore', key });
    expect(restored.tasks[0]!.status).toBe('open');
    expect(restored.tasks[0]!.completedAt).toBe(completed);
    expect(restored.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1']);
  });

  test('retained workspace undo preserves boundaries and completes current evidence when undoing restore', () => {
    const initial = reconcileWork(state(), batch(), before);
    const key = `a:${initial.tasks[0]!.id}`;
    const completedState = transition({ ...initial, clock: completed }, { type: 'done', key });
    const undo = transition(completedState, { type: 'undo' });
    expect(undo.tasks[0]!.status).toBe('open');
    expect(undo.tasks[0]!.completedAt).toBe(completed);
    expect(undo.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1']);
    const restored = transition(completedState, { type: 'restore', key });
    const enriched = reconcileWork(restored, batch([evidence('new-after-restore', after)]), after);
    const finished = transition({ ...enriched, clock: after }, { type: 'undo' });
    expect(finished.tasks[0]!.status).toBe('done');
    expect(finished.tasks[0]!.completedAt).toBe(after);
    expect(finished.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1', 'new-after-restore']);
  });

  test.each([
    ['same ID with a fabricated newer timestamp', [evidence('github:event:1', after)]],
    ['newly discovered older evidence', [evidence('github:event:old', before)]],
    ['new evidence exactly at completion', [evidence('github:event:equal', completed)]],
  ])('%s never reopens Done', (_label, incoming) => {
    const previous = done();
    const next = reconcileWork(previous, batch(incoming as WorkEvidence[]), after);
    expect(next.tasks[0]!.status).toBe('done');
    expect(next.tasks[0]!.completedAt).toBe(completed);
    expect(next.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1']);
    expect(next.tasks[0]!.work!.evidence.length).toBeGreaterThanOrEqual(1);
  });

  test('only an unseen actionable event with source time after completion reopens', () => {
    const previous = done();
    const next = reconcileWork(previous, batch([evidence('github:event:new', after)]), '2026-09-16T12:00:00Z');
    expect(next.tasks[0]!.status).toBe('open');
    expect(next.tasks[0]!.completedAt).toBe(completed);
    expect(next.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1']);
    expect(previous.tasks[0]!.status).toBe('done');
  });

  test.each(['queued', 'closed', 'merged', 'unknown'] as const)('%s can enrich Done without reopening', availability => {
    const incoming = batch([evidence('github:event:new', after)], availability);
    const next = reconcileWork(done(), incoming, after);
    expect(next.tasks[0]!.status).toBe('done');
    expect(next.tasks[0]!.work!.evidence).toHaveLength(2);
    const open = reconcileWork(next, { ...batch([], 'open'), candidates: [] }, after);
    expect(open.tasks[0]!.status).toBe('done');
    expect(reconcileWork(open, batch([evidence('github:event:new', after)]), after).tasks[0]!.status).toBe('done');
  });

  test('completion records all evidence and repeated completion never moves the boundary', () => {
    const initial = reconcileWork(state(), batch([evidence(), evidence('slack:1', before, 'slack')]), before);
    const first = completeWorkTask(initial, initial.tasks[0]!.id, completed);
    const next = completeWorkTask(first, first.tasks[0]!.id, after);
    expect(next).toBe(first);
    expect(next.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1', 'slack:1']);
    const restored = restoreWorkTask(next, next.tasks[0]!.id);
    expect(restored.tasks[0]!.status).toBe('open');
    expect(restored.tasks[0]!.completedAt).toBe(completed);
    expect(restored.tasks[0]!.work!.handledEvidenceIds).toEqual(next.tasks[0]!.work!.handledEvidenceIds);
  });

  test('a legacy Done task with no reliable completion boundary does not auto-reopen', () => {
    const previous = done();
    delete previous.tasks[0]!.completedAt;
    expect(reconcileWork(previous, batch([evidence('fresh', after)]), after).tasks[0]!.status).toBe('done');
  });
});

describe('source availability and ranking', () => {
  test.each(['queued', 'closed', 'merged'] as const)('%s suppresses open tasks without owning Done; confirmed open re-enables', availability => {
    const initial = reconcileWork(state(), batch(), before);
    const next = reconcileWork(initial, { ...batch([], availability), candidates: [] }, after);
    expect(next.tasks[0]!.status).toBe('open');
    expect(next.tasks[0]!.completedAt).toBeUndefined();
    expect(next.tasks[0]!.work!.availability).toBe('waiting');
    expect(rankedTasks(next)).toEqual([]);
    const reopened = reconcileWork(next, { ...batch([], 'open'), candidates: [] }, after);
    expect(rankedTasks(reopened)).toHaveLength(1);
  });

  test('unknown stays visible with explicit rank context; confirmed waiting observations suppress it', () => {
    const incoming = batch();
    incoming.observations = [];
    const unknown = reconcileWork(state(), incoming, before);
    expect(unknown.tasks[0]!.work!.availability).toBe('unknown');
    unknown.tasks[0]!.notes = 'Owner task note';
    expect(rankedTasks(unknown)).toHaveLength(1);
    const input = rankInput(unknown);
    expect(input.tasks[0]!.notes).toContain('Source availability: unknown.');
    expect(input.tasks[0]!.notes).toContain('The source state has not been confirmed.');
    expect(input.tasks[0]!.notes).toContain('Owner task note');
    expect(unknown.tasks[0]!.notes).toBe('Owner task note');
    incoming.observations = [
      { url, state: 'queued', observedAt: after, reason: 'In merge queue' },
      { url, state: 'open', observedAt: before, reason: 'Older open snapshot' },
    ];
    const queued = reconcileWork(unknown, incoming, after);
    expect(queued.tasks[0]!.work!.availability).toBe('waiting');
    expect(rankedTasks(queued)).toEqual([]);
  });

  test('linked Slack and Copilot intake remains visible but uncertain until GitHub is observed', () => {
    for (const source of ['slack', 'copilot'] as const) {
      const incoming = { ...batch([evidence(`${source}:1`, before, source)]), observations: [] };
      const next = reconcileWork(state(), incoming, before);
      expect(rankedTasks(next)).toHaveLength(1);
      expect(next.tasks[0]!.work!.availability).toBe('unknown');
      expect(rankInput(next).tasks[0]!.notes).toContain('Source availability: unknown.');
    }
  });

  test('direct Slack requests do not require an unrelated GitHub observation', () => {
    const incoming = { ...batch([evidence('slack:reply', before, 'slack')]), observations: [] };
    incoming.candidates[0]!.url = slack;
    incoming.candidates[0]!.action = 'reply';
    const next = reconcileWork(state(), incoming, before);
    expect(next.tasks[0]!.work!.availability).toBe('actionable');
    expect(rankedTasks(next)).toHaveLength(1);
  });

  test('a new action from another source cannot bypass a saved merge-queue observation', () => {
    const queued = reconcileWork(state(), batch([evidence()], 'queued'), before);
    const incoming = { ...batch([evidence('slack:fix', after, 'slack')]), observations: [] };
    incoming.candidates[0]!.action = 'fix';
    const next = reconcileWork(queued, incoming, after);
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[1]!.work!.availability).toBe('waiting');
    expect(next.tasks[1]!.work!.availabilityObservedAt).toBe(after);
    expect(rankedTasks(next)).toEqual([]);
    const delayed = reconcileWork(next, {
      ...batch([], 'open'), candidates: [],
      observations: [{ url, state: 'open', observedAt: before, reason: 'Delayed older response' }],
    }, after);
    expect(delayed.tasks.every(task => task.work?.availability === 'waiting')).toBe(true);
  });

  test('durable source timestamps reject stale open observations across batches and reloads', () => {
    const queued = reconcileWork(state(), batch([evidence()], 'queued'), before);
    const reloaded = stateSchema.parse(JSON.parse(JSON.stringify(queued)));
    const delayed = reconcileWork(reloaded, {
      ...batch([], 'open'), candidates: [],
      observations: [{ url, state: 'open', observedAt: before, reason: 'Stale open snapshot' }],
    }, after);
    expect(delayed.tasks[0]!.work!.availability).toBe('waiting');
    expect(delayed.tasks[0]!.work!.availabilityObservedAt).toBe(after);
    const newer = '2026-09-15T13:00:00.000Z';
    const open = reconcileWork(delayed, {
      ...batch([], 'open'), candidates: [],
      observations: [{ url, state: 'open', observedAt: newer, reason: 'Confirmed exit from queue' }],
    }, newer);
    expect(open.tasks[0]!.work!.availability).toBe('actionable');
    expect(open.tasks[0]!.work!.availabilityObservedAt).toBe(newer);
  });

  test('confirming unchanged availability advances the boundary and rejects older terminal observations', () => {
    const initial = reconcileWork(state(), batch(), before);
    const newer = '2026-09-15T13:00:00.000Z';
    const confirmed = reconcileWork(initial, {
      ...batch([], 'open'), candidates: [],
      observations: [{ url, state: 'open', observedAt: newer, reason: 'Still open' }],
    }, newer);
    const delayed = reconcileWork(confirmed, { ...batch([], 'queued'), candidates: [] }, newer);
    expect(delayed.tasks[0]!.work!.availability).toBe('actionable');
    expect(delayed.tasks[0]!.work!.availabilityObservedAt).toBe(newer);
  });

  test('old work metadata without observation timestamps remains readable and gains its first confirmation', () => {
    const initial = reconcileWork(state(), batch(), before);
    delete initial.tasks[0]!.work!.availabilityObservedAt;
    const reloaded = stateSchema.parse(initial);
    const next = reconcileWork(reloaded, { ...batch([], 'queued'), candidates: [] }, after);
    expect(next.tasks[0]!.work!.availability).toBe('waiting');
    expect(next.tasks[0]!.work!.availabilityObservedAt).toBe(after);
  });

  test('previous rank precedes unranked tasks in stable creation order and excludes Done', () => {
    const initial = state();
    const task = (id: string, createdAt = before): Task => ({ id, createdAt, title: id, notes: '', status: 'open' });
    initial.tasks = [task('later', after), task('first'), task('tie'), task('ranked'), { ...task('done'), status: 'done' }];
    initial.work.ranking = { orderedIds: ['done', 'ranked', 'missing'], reasons: [], rankedAt: before };
    expect(rankedTasks(initial).map(task => task.id)).toEqual(['ranked', 'first', 'tie', 'later']);
    expect(initial.tasks[0]!.id).toBe('later');
  });

  test('rank input uses saved instructions/model and task provenance, never unrelated thread notes', () => {
    const initial = reconcileWork(state(), batch([evidence(), evidence('slack:1', before, 'slack')]), before);
    initial.work.settings.instructions = 'Prefer reviews, then incident follow-up.';
    initial.work.settings.model = 'owner-selected-model';
    initial.tasks[0]!.notes = 'Relevant task note';
    initial.notes.push({ id: 'private', threadId: 'unrelated', text: 'PRIVATE THREAD SECRET' });
    const input = rankInput(initial);
    expect(input.instructions).toBe(initial.work.settings.instructions);
    expect(input.model).toBe('owner-selected-model');
    expect(input.tasks[0]!.notes).toBe('Relevant task note');
    expect(input.tasks[0]!.evidence.map(item => item.source)).toEqual(['github', 'slack']);
    expect(JSON.stringify(input)).not.toContain('PRIVATE THREAD SECRET');
  });

  test('long legacy task text remains saved while bounded context still reaches the ranker', () => {
    const initial = state();
    initial.tasks.push({ id: 'long', title: 'A'.repeat(2100), notes: 'B'.repeat(17000), status: 'open', createdAt: before });
    const input = rankInput(initial);
    expect(input.tasks[0]!.title).toHaveLength(2000);
    expect(input.tasks[0]!.notes).toHaveLength(16000);
    expect(initial.tasks[0]!.title).toHaveLength(2100);
    expect(initial.tasks[0]!.notes).toHaveLength(17000);
  });

  test('pre-work v3 saves gain isolated defaults without replacing tasks, notes, or legacy history', () => {
    const initial = state();
    initial.tasks.push({ id: 'plain', title: 'Legacy task', notes: 'Keep these notes', createdAt: before, status: 'done', completedAt: completed });
    initial.notes.push({ id: 'annotation', threadId: 'legacy-thread', text: 'Keep this unrelated annotation' });
    const { work: _work, ...saved } = initial;
    const migrated = stateSchema.parse(saved);
    expect(migrated.tasks).toEqual(initial.tasks);
    expect(migrated.notes).toEqual(initial.notes);
    expect(migrated.work).toEqual(defaultWorkState());
    expect(migrated.work.settings.schedule).toEqual({ enabled: false, everyMinutes: 30 });
    migrated.work.settings.instructions = 'One workspace';
    expect(stateSchema.parse(saved).work.settings.instructions).toBe('');
  });
});
