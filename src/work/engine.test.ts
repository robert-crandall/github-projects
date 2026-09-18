import { describe, expect, test } from 'bun:test';
import {
  defaultWorkState, workCollectOutputSchema, workRankInputSchema, type WorkAction, type WorkCollection, type WorkEvidence,
} from '../../service/src/work-schema.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { transition } from '../domain/engine.ts';
import { stateSchema, type AppState, type Task } from '../types.ts';
import { canonicalSource, completeWorkTask, consolidateWorkTasks, rankInput, rankedTasks, reconcileWork, restoreWorkTask, taskIdentity } from './engine.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';

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
function legacyTask(id: string, action: WorkAction): Task & { work: NonNullable<Task['work']> } {
  const incoming = batch([evidence(id)]);
  incoming.candidates[0]!.action = action;
  const task = reconcileWork(state(), incoming, before).tasks[0]!;
  return { ...task, id, work: { ...task.work!, identity: `${action}:${canonicalSource(url)}` } };
}

describe('current source context separate from immutable evidence', () => {
  const context = { revision: 'a'.repeat(64), title: 'Current title', body: 'Current body', labels: ['bug'] };
  test('same-ID source edits persist across restart and affect rank without changing owner text or Done', () => {
    const first = batch();
    first.observations[0]!.context = context;
    const saved = reconcileWork(state(), first, before);
    saved.tasks[0]!.title = 'Owner title';
    saved.tasks[0]!.notes = 'Owner notes';
    const original = rankInput(saved);
    const completedState = completeWorkTask(saved, saved.tasks[0]!.id, completed);
    const edited = { ...context, body: 'Urgent deadline changed', revision: 'b'.repeat(64) };
    const updated = reconcileWork(completedState, {
      ...batch(), candidates: [],
      observations: [{ url, state: 'open', observedAt: after, reason: 'Source is open', context: edited }],
    }, after);
    const reloaded = stateSchema.parse(JSON.parse(JSON.stringify(updated)));
    expect(reloaded.tasks[0]).toMatchObject({
      title: 'Owner title', notes: 'Owner notes', status: 'done',
      work: { context: edited, contextObservedAt: after, evidence: saved.tasks[0]!.work!.evidence },
    });
    expect(rankInput(reloaded).tasks).toEqual([]);
    const restored = restoreWorkTask(reloaded, reloaded.tasks[0]!.id);
    expect(rankInput(restored).tasks[0]!.context).toEqual(edited);
    expect(semanticRankTask(rankInput(restored).tasks[0]!)).not.toEqual(semanticRankTask(original.tasks[0]!));
  });
  test('incidental confirmation times and evidence provenance do not change effective assessment input', () => {
    const first = batch();
    first.observations[0]!.context = context;
    const saved = reconcileWork(state(), first, before);
    const incoming = batch([{ ...evidence(), streamId: 'another-query' }]);
    incoming.observations[0] = { ...incoming.observations[0]!, observedAt: '2026-09-16T00:00:00.000Z', context };
    const updated = reconcileWork(saved, incoming, after);
    expect(updated.tasks[0]!.work!.availabilityObservedAt).not.toBe(saved.tasks[0]!.work!.availabilityObservedAt);
    expect(updated.tasks[0]!.work!.evidence).toHaveLength(2);
    expect(semanticRankTask(rankInput(updated).tasks[0]!)).toEqual(semanticRankTask(rankInput(saved).tasks[0]!));
  });
  test('unknown source retains latest known context with its own timestamp and rejects stale content', () => {
    const first = batch();
    first.observations[0]!.context = context;
    const saved = reconcileWork(state(), first, before);
    const unknownAt = '2026-09-15T14:00:00.000Z';
    const unknown = reconcileWork(saved, {
      ...batch(), candidates: [],
      observations: [{ url, state: 'unknown', observedAt: unknownAt, reason: 'Unavailable' }],
    }, unknownAt);
    expect(unknown.tasks[0]!.work).toMatchObject({ availability: 'unknown', context, contextObservedAt: after });
    const stale = reconcileWork(unknown, {
      ...batch(), candidates: [],
      observations: [{ url, state: 'open', observedAt: before, reason: 'Open', context: { ...context, body: 'Old body' } }],
    }, unknownAt);
    expect(stale.tasks[0]!.work!.context).toEqual(context);
    expect(rankInput(stale).tasks[0]).toMatchObject({ availability: 'unknown', availabilityReason: 'Unavailable', context });
  });
  test.each([false, true])('duplicate consolidation preserves newest known context despite later failed checks: %s', reverse => {
    const first = legacyTask('first', 'implement');
    const second = legacyTask('second', 'reply');
    first.work.context = { ...context, body: 'Older known content' };
    first.work.contextObservedAt = before;
    first.work.availability = 'unknown';
    first.work.availabilityObservedAt = '2026-09-16T00:00:00.000Z';
    second.work.context = context;
    second.work.contextObservedAt = after;
    const saved = state();
    saved.tasks = reverse ? [second, first] : [first, second];
    const merged = consolidateWorkTasks(saved);
    expect(merged.tasks[0]!.work).toMatchObject({ availability: 'unknown', context, contextObservedAt: after });
  });
  test('closed sources leave active ordering without completing the owner task', () => {
    const first = batch();
    first.observations[0]!.context = context;
    const saved = reconcileWork(state(), first, before);
    const closed = reconcileWork(saved, { ...batch([], 'closed'), candidates: [] }, after);
    expect(closed.tasks[0]!.status).toBe('open');
    expect(rankInput(closed).tasks).toEqual([]);
  });
  test('oversized source contexts fail instead of silently shortening or dropping current content', () => {
    const incoming = batch();
    incoming.observations[0]!.context = { ...context, body: 'x'.repeat(100001) };
    expect(() => reconcileWork(state(), incoming, after)).toThrow();
  });
});

describe('notification discovery metadata', () => {
  const notification = { threadId: '123', reference: { repo: 'Owner/Repo', number: 42, kind: 'pr' as const }, updatedAt: after };

  test('notification updates attach to the same query task without reopening Done', () => {
    const initial = done();
    const incoming = batch([{ ...evidence(), streamId: 'notifications' }]);
    incoming.candidates[0]!.notification = notification;
    const result = reconcileWork(initial, incoming, after);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: initial.tasks[0]!.id, status: 'done', completedAt: completed, work: { notification },
    });
    expect(result.tasks[0]!.work!.evidence).toHaveLength(2);
    expect(stateSchema.parse(JSON.parse(JSON.stringify(result))).tasks[0]!.work!.notification).toEqual(notification);
    const older = structuredClone(incoming);
    older.candidates[0]!.notification!.updatedAt = before;
    expect(reconcileWork(result, older, after).tasks[0]!.work!.notification).toEqual(notification);
  });

  test('new action on an unsubscribed source retains subscription without suppressing a genuine request', () => {
    const initial = done();
    initial.tasks[0]!.work!.notification = notification;
    const unsubscribe = {
      operationId: 'unsubscribe:1', notification, status: 'confirmed' as const, error: '', confirmedAt: completed,
    };
    initial.tasks[0]!.work!.unsubscribe = unsubscribe;
    const incoming = batch([evidence('new-mention', after)]);
    incoming.candidates[0]!.notification = notification;
    const reopened = reconcileWork(initial, incoming, after);
    expect(reopened.tasks[0]!.status).toBe('open');
    expect(reopened.tasks[0]!.work!.unsubscribe).toEqual(unsubscribe);
    incoming.candidates[0]!.action = 'reply';
    const secondAction = reconcileWork(initial, incoming, after);
    expect(secondAction.tasks).toHaveLength(1);
    expect(secondAction.tasks[0]!.work).toMatchObject({ notification, unsubscribe });
    expect(secondAction.tasks[0]!.status).toBe('open');
  });

  test('a notification cannot attach unsubscribe controls for another source', () => {
    const incoming = batch();
    incoming.candidates[0]!.notification = { ...notification, reference: { ...notification.reference, number: 99 } };
    expect(() => reconcileWork(state(), incoming, after)).toThrow('notification does not match');
  });
});

describe('source identity', () => {
  test('GitHub case, number, issue/pull aliases, subpaths, query and anchor share one identity', () => {
    expect(canonicalSource('https://GITHUB.com/OWNER/RePo/pull/0042/files?x=1#discussion')).toBe('https://github.com/owner/repo/issues/42');
    expect(taskIdentity(url, 'review')).toBe(taskIdentity('https://github.com/owner/repo/issues/42#issuecomment-8', 'review'));
    expect(taskIdentity(url, 'review')).toBe(taskIdentity(url, 'review-result'));
    expect(taskIdentity(url, 'review')).toBe('https://github.com/owner/repo/issues/42');
    expect(() => canonicalSource('https://user:pass@github.com/owner/repo/pull/42')).toThrow();
  });

  test('Slack permalinks discard thread context without merging distinct messages', () => {
    expect(canonicalSource(`${slack}/?thread_ts=123#reply`)).toBe(slack);
    expect(canonicalSource('https://TEAM.slack.com/archives/C123/p1789473600.000000')).toBe(slack);
    expect(taskIdentity(slack, 'reply')).not.toBe(taskIdentity(slack.replace('000000', '000001'), 'reply'));
    expect(taskIdentity(slack, 'reply')).not.toBe(taskIdentity(slack, 'follow-up'));
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

  test('queries and cross-source requests merge once across actions and preserve provenance', () => {
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
    expect(reconcileWork(next, incoming, after).tasks).toHaveLength(1);
    expect(first.tasks[0]!.work!.evidence).toHaveLength(1);
  });
});

describe('saved task consolidation', () => {
  test('different actions on one GitHub issue share a row while other sources and captures remain separate', () => {
    const incoming = batch();
    incoming.candidates = [
      { ...incoming.candidates[0]!, url: 'https://github.com/github/usersd/issues/1897', action: 'implement' },
      { ...incoming.candidates[0]!, url: 'https://github.com/GitHub/Usersd/issues/01897#issuecomment-1', action: 'follow-up' },
      { ...incoming.candidates[0]!, url: 'https://github.com/github/usersd/issues/1982', action: 'implement' },
      { ...incoming.candidates[0]!, url: 'https://tracker.example/task?id=1897', action: 'implement' },
      { ...incoming.candidates[0]!, url: 'https://tracker.example/task?id=1897', action: 'follow-up' },
    ];
    const initial = state();
    initial.tasks.push({ id: 'capture', title: incoming.candidates[0]!.url, notes: '', status: 'open', createdAt: before });
    const next = reconcileWork(initial, incoming, after);
    expect(next.tasks).toHaveLength(5);
    expect(next.tasks.filter(task => task.work?.url.includes('/usersd/issues/1897'))).toHaveLength(1);
    expect(next.tasks[0]).toEqual(initial.tasks[0]);
  });

  test('saved duplicates combine notes and evidence, stay open, remap references and persist idempotently', () => {
    const initial = state();
    const first = legacyTask('first', 'implement');
    const second = legacyTask('second', 'follow-up');
    first.title = 'Owner title';
    first.notes = 'Keep my implementation notes';
    first.status = 'done';
    first.completedAt = completed;
    first.work.handledEvidenceIds = ['first'];
    second.title = 'Resolve overdue repair item';
    second.notes = 'Keep my follow-up notes\n  ';
    second.work.evidence.push(first.work.evidence[0]!);
    const capture: Task = { id: 'capture', title: 'Manual task', notes: 'Separate', status: 'open', createdAt: before };
    initial.tasks = [first, second, capture];
    initial.selectedKey = 'a:second';
    initial.order = ['a:second', 'a:capture', 'a:first'];
    initial.newKeys = ['a:second', 'a:first'];
    initial.undo = [first, second, capture].map(task => ({ before: task, after: task }));
    initial.work.ranking = {
      orderedIds: ['second', 'capture', 'first'],
      reasons: [{ id: 'second', reason: 'Overdue' }, { id: 'capture', reason: 'Next' }, { id: 'first', reason: 'Assigned' }],
      rankedAt: before,
    };
    const next = reconcileWork(initial, { ...batch(), candidates: [], observations: [] }, after);
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0]).toMatchObject({
      id: 'first', title: 'Owner title', status: 'open', completedAt: completed,
      notes: 'Keep my implementation notes\n\nResolve overdue repair item\nKeep my follow-up notes\n  ',
      work: { identity: canonicalSource(url), handledEvidenceIds: ['first'] },
    });
    expect(next.tasks[0]!.work!.evidence.map(item => item.id)).toEqual(['first', 'second']);
    expect(next.selectedKey).toBe('a:first');
    expect(next.order).toEqual(['a:first', 'a:capture']);
    expect(next.newKeys).toEqual(['a:first']);
    expect(next.work.ranking).toEqual({
      orderedIds: ['first', 'capture'], reasons: [{ id: 'first', reason: 'Overdue' }, { id: 'capture', reason: 'Next' }], rankedAt: before,
    });
    expect(next.undo).toEqual([{ before: capture, after: capture }]);
    expect(next.tasks[1]).toEqual(capture);
    expect(initial.tasks).toHaveLength(3);
    expect(initial.tasks[0]!.notes).toBe('Keep my implementation notes');
    const reloaded = stateSchema.parse(JSON.parse(JSON.stringify(next)));
    expect(consolidateWorkTasks(reloaded)).toBe(reloaded);
    expect(rankInput(reloaded).tasks.map(task => task.id)).toEqual(['first', 'capture']);
  });

  test.each([false, true])('all-Done groups keep completion and handled evidence, including missing boundaries: %s', missing => {
    const initial = state();
    const first = legacyTask('first', 'implement');
    const second = legacyTask('second', 'follow-up');
    const third = legacyTask('third', 'reply');
    for (const task of [first, second, third]) {
      task.status = 'done';
      task.completedAt = completed;
      task.work.handledEvidenceIds = [task.id];
    }
    second.completedAt = after;
    if (missing) delete first.completedAt;
    initial.tasks = [first, second, third];
    const next = consolidateWorkTasks(initial);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]!.status).toBe('done');
    expect(next.tasks[0]!.completedAt).toBe(missing ? undefined : after);
    expect(next.tasks[0]!.work!.handledEvidenceIds).toEqual(['first', 'second', 'third']);
    const incoming = batch([evidence('older-new-action', completed)]);
    incoming.candidates[0]!.action = 'fix';
    expect(reconcileWork(next, incoming, after).tasks[0]!.status).toBe('done');
  });

  test.each([false, true])('newest source and notification state survive either saved row order: %s', reverse => {
    const first = legacyTask('first', 'implement');
    const second = legacyTask('second', 'follow-up');
    const notification = { threadId: '123', reference: { repo: 'Owner/Repo', number: 42, kind: 'pr' as const }, updatedAt: before };
    first.work.availabilityObservedAt = before;
    first.work.notification = notification;
    second.work.availability = 'waiting';
    second.work.availabilityReason = 'In merge queue';
    second.work.availabilityObservedAt = after;
    second.work.notification = { ...notification, updatedAt: after };
    second.work.unsubscribe = { operationId: 'unsubscribe:1', notification, status: 'unconfirmed', error: 'Retry explicitly' };
    const initial = state();
    initial.tasks = reverse ? [second, first] : [first, second];
    const next = consolidateWorkTasks(initial);
    expect(next.tasks[0]!.work).toMatchObject({
      availability: 'waiting', availabilityReason: 'In merge queue', availabilityObservedAt: after,
      notification: { updatedAt: after }, unsubscribe: second.work.unsubscribe,
    });
    expect(rankedTasks(next)).toEqual([]);
  });

  test('invalid notification references and evidence overflow block consolidation rather than dropping data', () => {
    const initial = state();
    const first = legacyTask('first', 'implement');
    const second = legacyTask('second', 'follow-up');
    second.work.notification = { threadId: '123', reference: { repo: 'Other/Repo', number: 42, kind: 'pr' }, updatedAt: after };
    initial.tasks = [first, second];
    expect(() => consolidateWorkTasks(initial)).toThrow('notification does not match');
    delete second.work.notification;
    for (const task of initial.tasks) task.work!.evidence = Array.from({ length: 1001 }, (_, index) => evidence(`${task.id}:${index}`));
    expect(() => consolidateWorkTasks(initial)).toThrow();
    expect(initial.tasks).toHaveLength(2);
    expect(initial.tasks[0]!.work!.evidence).toHaveLength(1001);
  });
});

describe('owner completion boundaries', () => {
  test('different actions share Done, ignore old evidence and reopen once for a genuinely new request', () => {
    const previous = done();
    const incoming = batch([evidence('old-follow-up', before)]);
    incoming.candidates[0]!.action = 'follow-up';
    incoming.candidates[0]!.title = 'A different suggested title';
    previous.tasks[0]!.title = 'Keep my title';
    previous.tasks[0]!.notes = 'Keep my notes';
    const old = reconcileWork(previous, incoming, after);
    expect(old.tasks).toHaveLength(1);
    expect(old.tasks[0]).toMatchObject({ id: previous.tasks[0]!.id, status: 'done', title: 'Keep my title', notes: 'Keep my notes' });
    incoming.candidates[0]!.action = 'implement';
    incoming.candidates[0]!.evidence = [evidence('new-implementation-request', after)];
    const reopened = reconcileWork(old, incoming, after);
    expect(reopened.tasks).toHaveLength(1);
    expect(reopened.tasks[0]!.status).toBe('open');
    const finished = completeWorkTask(reopened, reopened.tasks[0]!.id, after);
    expect(finished.tasks[0]!.work!.handledEvidenceIds).toEqual(['github:event:1', 'old-follow-up', 'new-implementation-request']);
    incoming.candidates[0]!.action = 'reply';
    const replayed = reconcileWork(finished, incoming, after);
    expect(replayed.tasks).toHaveLength(1);
    expect(replayed.tasks[0]!.status).toBe('done');
  });

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
    expect(input.tasks[0]!.availability).toBe('unknown');
    expect(input.tasks[0]!.availabilityReason).toBe('The source state has not been confirmed.');
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
      expect(rankInput(next).tasks[0]!.availability).toBe('unknown');
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
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]!.work!.availability).toBe('waiting');
    expect(next.tasks[0]!.work!.availabilityObservedAt).toBe(after);
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
