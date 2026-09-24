import { expect, test } from 'bun:test';
import { assessmentBatch } from '../../tests/assessment-fixture.ts';
import { identityDigest } from '../../service/src/work-assessment.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { stateSchema } from '../types.ts';
import { assessmentFreshness, attachAssessments, mergeAssessments } from './assessments.ts';
import { completeWorkTask, consolidateWorkTasks, rankInput, rankTask, reconcileWork, restoreWorkTask } from './engine.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';

const at = '2026-09-24T12:00:00.000Z';
async function manual() {
  const state = emptyWorkspace(at, 'UTC');
  state.tasks = [{ id: 'manual', title: 'Write the proposal', notes: 'Owner notes', createdAt: at, status: 'open' }];
  const { assessments } = await assessmentBatch(rankInput(state), at);
  return attachAssessments(state, 'default', assessments);
}

test('task history survives Done, restore, profile switches and snapshot round trips without source metadata', async () => {
  let state = await manual();
  const original = structuredClone(state.tasks[0]!);
  state = completeWorkTask(state, original.id, at);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at);
  expect(state.tasks[0]!.assessments).toEqual(original.assessments);
  expect(state.tasks[0]!.status).toBe('done');
  state = createWorkProfile(state, 'Second profile');
  expect(state.tasks).toEqual([]);
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at);
  expect(state.inactiveWorkProfiles[0]!.tasks[0]!.assessments).toEqual(original.assessments);
  state = switchWorkProfile(state, 'default');
  state = restoreWorkTask(state, original.id);
  expect(state.tasks[0]).toMatchObject({ notes: original.notes, status: 'open', assessments: original.assessments });
  expect(state.tasks[0]!.work).toBeUndefined();
});

test('freshness distinguishes changed content, settings, expiry and a backwards clock without removing history', async () => {
  const state = await manual();
  const task = state.tasks[0]!;
  const version = task.assessments![0]!;
  const current = {
    fingerprint: await identityDigest(semanticRankTask(rankTask(task))),
    instructionsFingerprint: await identityDigest(state.work.settings.instructions),
    profileId: 'default', model: '',
  };
  expect(assessmentFreshness(version, current, Date.parse(at))).toBe('Current for saved task content');
  expect(assessmentFreshness(version, current, Date.parse(at) + 86400000)).toBe('Expired: reassessment due');
  expect(assessmentFreshness(version, { ...current, fingerprint: '0'.repeat(64) }, Date.parse(at)))
    .toBe('Outdated: task content changed');
  expect(assessmentFreshness(version, { ...current, model: 'changed' }, Date.parse(at))).toContain('settings changed');
  expect(assessmentFreshness(version, { ...current, instructionsFingerprint: '0'.repeat(64) }, Date.parse(at))).toContain('settings changed');
  expect(assessmentFreshness(version, current, Date.parse(at) - 1)).toContain('clock moved backwards');
  expect(task.assessments).toEqual([version]);
});

test('new successful versions append; reuse deduplicates and conflicting immutable IDs fail explicitly', async () => {
  const state = await manual();
  const first = state.tasks[0]!.assessments![0]!;
  const next = { ...structuredClone(first), resultId: crypto.randomUUID(), evaluatedAt: '2026-09-25T12:00:00.000Z' };
  expect(mergeAssessments([first], [next, first, next])).toEqual([first, next]);
  expect(() => mergeAssessments([first], [{ ...first, fingerprint: '0'.repeat(64) }])).toThrow('changed unexpectedly');
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
  current = attachAssessments(current, 'default', (await assessmentBatch(rankInput(current))).assessments);
  const versions = current.tasks.flatMap(task => task.assessments!);
  const consolidated = consolidateWorkTasks(current);
  expect(consolidated.tasks).toHaveLength(1);
  expect(consolidated.tasks[0]!.assessments).toHaveLength(2);
  for (const value of versions) expect(consolidated.tasks[0]!.assessments).toContainEqual(value);
  const reconciled = reconcileWork(consolidated, batch, at);
  expect(reconciled.tasks[0]!.assessments).toEqual(consolidated.tasks[0]!.assessments);
  const restored = restoreDesktop(JSON.parse(JSON.stringify(reconciled)), at);
  expect(restored.tasks[0]!.assessments).toEqual(consolidated.tasks[0]!.assessments);
});

test('old saves gain no invented history and malformed saved history fails rather than disappearing', async () => {
  const state = emptyWorkspace(at, 'UTC');
  state.tasks = [{ id: 'old', title: 'Unassessed', notes: '', status: 'open', createdAt: at }];
  expect(restoreDesktop(state, at).tasks[0]!.assessments).toBeUndefined();
  const assessed = await manual();
  expect(stateSchema.safeParse({ ...assessed, tasks: [{ ...assessed.tasks[0], assessments: [{ old: 'cache record' }] }] }).success).toBe(false);
  assessed.tasks[0]!.assessments![0]!.profileId = 'wrong-profile';
  expect(() => restoreDesktop(assessed, at)).toThrow('inconsistent profile');
});
