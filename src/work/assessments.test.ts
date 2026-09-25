import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assessmentBatch } from '../../tests/assessment-fixture.ts';
import { AssessmentStoreFixture } from '../../tests/assessment-store-fixture.ts';
import { assessmentScope, WorkAssessmentCache, WorkRanker, type RankingModels } from '../../service/src/work-ranking.ts';
import { identityDigest, savedAssessmentSchema, storedAssessmentSchema, type TaskAssessment } from '../../service/src/work-assessment.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { type Task } from '../types.ts';
import { assessmentFreshness } from './assessments.ts';
import { completeWorkTask, consolidateWorkTasks, rankInput, rankTask, reconcileWork, restoreWorkTask } from './engine.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';
import { AssessmentHistory } from './AssessmentHistory.tsx';
import { agentIdentity, taskAgent } from '../../service/src/work-agents.ts';

const at = '2026-09-24T12:00:00.000Z';
async function manual() {
  const state = emptyWorkspace(at, 'UTC');
  state.tasks = [{ id: 'manual', title: 'Write the proposal', notes: 'Owner notes', createdAt: at, status: 'open' }];
  const { assessments } = await assessmentBatch(rankInput(state), at);
  const history = new AssessmentStoreFixture();
  history.append('default', assessments, state);
  return { state, history };
}

test('task history survives Done, restore, profile switches and snapshot round trips without source metadata', async () => {
  let { state, history } = await manual();
  const original = structuredClone(state.tasks[0]!);
  const versions = [...history.entries];
  state = completeWorkTask(state, original.id, at);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at);
  expect(history.read('default', original.id, null, state).assessments).toEqual(versions);
  expect(state.tasks[0]!.status).toBe('done');
  state = createWorkProfile(state, 'Second profile');
  expect(state.tasks).toEqual([]);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at);
  expect(history.read('default', original.id, null, state).assessments).toEqual(versions);
  state = switchWorkProfile(state, 'default');
  state = restoreWorkTask(state, original.id);
  expect(state.tasks[0]).toMatchObject({ notes: original.notes, status: 'open' });
  expect(history.read('default', original.id, null, state).assessments).toEqual(versions);
  expect(state.tasks[0]!.work).toBeUndefined();
});

test('freshness distinguishes changed content, settings, expiry and a backwards clock without removing history', async () => {
  const { state, history } = await manual();
  const task = state.tasks[0]!;
  const version = history.entries[0]!;
  const current = {
    fingerprint: await identityDigest(semanticRankTask(rankTask(task))),
    instructionsFingerprint: await identityDigest(taskAgent(state.work.settings, 'task-assessment').instructions),
    configurationFingerprint: await identityDigest(agentIdentity(taskAgent(state.work.settings, 'task-assessment'))),
    profileId: 'default', model: '',
  };
  expect(assessmentFreshness(version, current, Date.parse(at))).toBe('Current for saved task content');
  expect(assessmentFreshness(version, current, Date.parse(at) + 86400000)).toBe('Expired: reassessment due');
  expect(assessmentFreshness(version, { ...current, fingerprint: '0'.repeat(64) }, Date.parse(at)))
    .toBe('Outdated: task content changed');
  expect(assessmentFreshness(version, { ...current, model: 'changed' }, Date.parse(at))).toContain('settings changed');
  expect(assessmentFreshness(version, { ...current, instructionsFingerprint: '0'.repeat(64) }, Date.parse(at))).toContain('settings changed');
  expect(assessmentFreshness(version, current, Date.parse(at) - 1)).toContain('clock moved backwards');
  expect(history.entries).toEqual([version]);
});

test('new successful versions append; reuse deduplicates and conflicting immutable IDs fail explicitly', async () => {
  const { state, history } = await manual();
  const { sequence: _, ...first } = history.entries[0]!;
  const next = { ...first, resultId: crypto.randomUUID(), evaluatedAt: '2026-09-23T12:00:00.000Z' };
  history.append('default', [next, first, next], state);
  expect(history.entries.map(value => value.resultId)).toEqual([first.resultId, next.resultId]);
  expect(() => history.append('default', [{ ...first, fingerprint: '0'.repeat(64) }], state)).toThrow('Conflicting assessment');
});

test('service backwards-clock reassessment persists as latest and remains latest when histories merge', async () => {
  const base = resolve('test-artifacts');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'assessment-clock-'));
  try {
    let clock = Date.parse(at);
    const ranker = new WorkRanker(new WorkAssessmentCache(join(directory, 'cache.sqlite3')), () => new Date(clock));
    const state = emptyWorkspace(at, 'UTC');
    state.tasks = [{ id: 'original', title: 'Same source', notes: '', status: 'open', createdAt: at }];
    const input = rankInput(state);
    const scope = assessmentScope('synthetic-credential', input);
    const seed = (await assessmentBatch(input, at)).assessments[0]!.assessment;
    let modelCalls = 0;
    const models: RankingModels = {
      assess: async input => ({ assessments: input.tasks.map(task => ({
        ...seed, id: task.id, importance: `Judgment ${++modelCalls}`,
        reevaluateAt: new Date(Date.parse(input.evaluatedAt) + 86400000).toISOString(),
      })) }),
      order: async () => { throw new Error('This regression never orders or calls a live model'); },
    };
    const signal = new AbortController().signal;
    const first = await ranker.assess(input, scope, models, signal);
    const history = new AssessmentStoreFixture();
    history.append('default', first.assessments, state);
    clock -= 3600000;
    const second = await ranker.assess(input, scope, models, signal);
    expect(modelCalls).toBe(2);
    expect(Date.parse(second.assessments[0]!.evaluatedAt)).toBeLessThan(Date.parse(first.assessments[0]!.evaluatedAt));
    history.append('default', second.assessments, state);
    history.append('default', (await ranker.assess(input, scope, models, signal)).assessments, state);
    expect(modelCalls).toBe(2);
    const path = join(directory, 'workspace.json');
    await writeFile(path, JSON.stringify({ state, assessments: history.entries }));
    const exported = JSON.parse(await readFile(path, 'utf8'));
    const restored = restoreDesktop(exported.state, new Date(clock).toISOString());
    const reloadedHistory = new AssessmentStoreFixture();
    reloadedHistory.entries = exported.assessments;
    const versions = reloadedHistory.read('default', 'original', null, restored).assessments.reverse();
    expect(versions.map(value => value.sequence)).toEqual([1, 2]);
    expect(versions.at(-1)!.resultId).toBe(second.assessments[0]!.resultId);
    const render = (task: Task & { assessments: TaskAssessment[] }) => renderToStaticMarkup(createElement(AssessmentHistory, {
      task, profileId: 'default', settings: restored.work.settings,
    }));
    expect(render({ ...restored.tasks[0]!, assessments: versions })).toContain('Judgment 2');
    expect(render({ ...restored.tasks[0]!, assessments: versions })).not.toContain('Judgment 1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('source reconciliation and duplicate consolidation retain both histories and original task provenance', async () => {
  const state = emptyWorkspace(at, 'UTC');
  const url = 'https://github.com/example/repo/issues/1';
  const batch = {
    candidates: [{
      title: 'First request', action: 'implement' as const, url,
      evidence: [{ id: 'request', source: 'github' as const, streamId: 'source', at, url, summary: 'Please implement' }],
    }],
    observations: [{ url, state: 'open' as const, observedAt: at, reason: 'Open' }],
    collectedAt: at, warnings: [],
  };
  let current = reconcileWork(state, batch, at);
  current.tasks.push({ ...structuredClone(current.tasks[0]!), id: 'duplicate', title: 'Second request' });
  const history = new AssessmentStoreFixture();
  const versions = history.append('default', (await assessmentBatch(rankInput(current))).assessments, current);
  current.tasks.reverse();
  const consolidated = consolidateWorkTasks(current);
  expect(consolidated.tasks).toHaveLength(1);
  expect(history.read('default', consolidated.tasks[0]!.id, null, consolidated).assessments).toEqual([...versions].reverse());
  const reconciled = reconcileWork(consolidated, batch, at);
  const restored = restoreDesktop(JSON.parse(JSON.stringify(reconciled)), at);
  expect(history.read('default', restored.tasks[0]!.id, null, restored).assessments).toEqual([...versions].reverse());
});

test('old saves gain no invented history', () => {
  const state = emptyWorkspace(at, 'UTC');
  state.tasks = [{ id: 'old', title: 'Unassessed', notes: '', status: 'open', createdAt: at }];
  expect(restoreDesktop(state, at).tasks[0]).not.toHaveProperty('assessments');
});

for (const shape of ['live-task', 'shared-alias'] as const) test(`rejects ambiguous ${shape} assessment ownership`, async () => {
  const { state } = await manual();
  state.tasks.push({ ...state.tasks[0]!, id: 'other' });
  if (shape === 'live-task') state.tasks[0]!.assessmentTaskIds = ['other'];
  else for (const task of state.tasks) task.assessmentTaskIds = ['shared'];
  expect(() => restoreDesktop(state, at)).toThrow('exactly one task');
});

test('legacy v2 history decodes and displays without manufacturing new ratings or agent identity', async () => {
  const { state, history } = await manual();
  const current = history.entries[0]!;
  const legacy = storedAssessmentSchema.parse({
    resultId: crypto.randomUUID(), id: current.id, profileId: current.profileId, fingerprint: current.fingerprint,
    instructionsFingerprint: current.instructionsFingerprint, model: current.model, evaluatedAt: current.evaluatedAt,
    sequence: current.sequence, assessmentVersion: 'work-assessment-v2', assessment: {
      importance: 'Historical importance', urgency: 'Historical urgency', blockers: 'None known',
      supportingEvidence: current.assessment.supportingEvidence, uncertainty: 'Historical uncertainty',
      reevaluateAt: current.assessment.reevaluateAt,
    },
  });
  const html = renderToStaticMarkup(createElement(AssessmentHistory, {
    task: { ...state.tasks[0]!, assessments: [legacy] }, profileId: 'default', settings: state.work.settings,
  }));
  expect(html).toContain('Historical importance');
  expect(html).toContain('Legacy task assessor');
  expect(html.match(/Not recorded in this assessment format/g)).toHaveLength(3);
  const { sequence: _, ...result } = legacy;
  expect(savedAssessmentSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(savedAssessmentSchema.safeParse({ ...result, assessmentVersion: 'work-assessment-v3' }).success).toBe(false);
});
