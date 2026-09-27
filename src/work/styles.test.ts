import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { assessmentBatch } from '../../tests/assessment-fixture.ts';
import { savedAssessmentSchema, storedAssessmentSchema } from '../../service/src/work-assessment.ts';
import { assessmentIdentity, workStylesSchema } from '../../service/src/work-styles.ts';
import { emptyWorkspace, restoreDesktop } from '../domain/live.ts';
import { AssessmentHistory } from './AssessmentHistory.tsx';
import { consolidateWorkTasks, rankInput, rankedTasks, reconcileWork } from './engine.ts';
import { createWorkProfile, switchWorkProfile } from './profiles.ts';
import { matchesStyles, taskStyles } from './styles.ts';

const at = '2026-09-27T12:00:00.000Z';
const styles = [
  { id: 'quick', name: 'Quick wins', description: 'Small, clear tasks with little context switching.' },
  { id: 'focus', name: 'Deep focus', description: 'Work that needs uninterrupted concentration.' },
];
async function fixture() {
  const state = emptyWorkspace(at, 'UTC');
  state.work.settings.workStyles = structuredClone(styles);
  state.tasks = ['a', 'b', 'c'].map(id => ({ id, title: id, notes: '', status: 'open', createdAt: at }));
  state.work.ranking = { orderedIds: ['c', 'b', 'a'], reasons: [], rankedAt: at };
  const { assessments } = await assessmentBatch(rankInput(state), at);
  assessments[0]!.assessment.workStyleIds = ['quick', 'focus'];
  return { state, assessment: assessments[0]! };
}

test('style filtering keeps ranks and multiple matches while manual choices, including none, override the model', async () => {
  const { state, assessment } = await fixture();
  const task = state.tasks.find(task => task.id === assessment.id)!;
  expect(taskStyles(task, styles, assessment).map(style => style.id)).toEqual(['quick', 'focus']);
  expect(matchesStyles(task, styles, ['focus'], assessment)).toBe(true);
  expect(matchesStyles(task, styles, ['quick', 'focus'], assessment)).toBe(true);
  expect(matchesStyles(task, styles, [], assessment)).toBe(false);
  expect(matchesStyles(task, styles, null)).toBe(true);
  expect(matchesStyles(task, styles, ['focus'])).toBe(false);
  task.workStyleOverride = ['focus'];
  expect(taskStyles(task, styles, assessment).map(style => style.id)).toEqual(['focus']);
  expect(matchesStyles(task, styles, ['quick'], assessment)).toBe(false);
  task.workStyleOverride = [];
  expect(taskStyles(task, styles, assessment)).toEqual([]);
  delete task.workStyleOverride;
  expect(taskStyles(task, styles, assessment)).toHaveLength(2);
  expect(taskStyles(task, styles.slice(1), assessment).map(style => style.id)).toEqual(['focus']);
  state.tasks[0]!.workStyleOverride = ['focus'];
  const original = structuredClone(state.work.ranking);
  expect(rankedTasks(state).filter(task => matchesStyles(task, styles, ['focus'], task.id === assessment.id ? assessment : undefined))
    .map(task => task.id)).toEqual(['c', 'a']);
  expect(state.work.ranking).toEqual(original);
});

test('definitions, overrides and filters survive relaunch and stay scoped to profiles', async () => {
  let { state } = await fixture();
  state.tasks[0]!.workStyleOverride = [];
  state.work.styleFilter = ['quick'];
  state = createWorkProfile(state, 'Other');
  expect(state.work.settings.workStyles).toBeUndefined();
  expect(state.work.styleFilter).toBeUndefined();
  state = restoreDesktop(JSON.parse(JSON.stringify(state)), at);
  state = switchWorkProfile(state, 'default');
  expect(state.work.settings.workStyles).toEqual(styles);
  expect(state.work.styleFilter).toEqual(['quick']);
  expect(state.tasks[0]!.workStyleOverride).toEqual([]);
  state = createWorkProfile(state, 'Copy', true);
  expect(state.work.settings.workStyles).toEqual(styles);
  expect(state.work.styleFilter).toBeUndefined();
  state.work.settings.workStyles![0]!.name = 'Small jobs';
  expect(state.inactiveWorkProfiles.find(profile => profile.id === 'default')!.work.settings.workStyles).toEqual(styles);
});

test('definitions change assessor identity and reject ambiguous or invalid model styles', async () => {
  const { state, assessment } = await fixture();
  expect(rankInput(state).workStyles).toEqual(styles);
  const original = structuredClone(assessmentIdentity(state.work.settings));
  state.work.settings.workStyles![0]!.description = 'Only five-minute tasks';
  expect(assessmentIdentity(state.work.settings)).not.toEqual(original);
  expect(workStylesSchema.safeParse([styles[0], { ...styles[1], name: 'QUICK WINS' }]).success).toBe(false);
  expect(workStylesSchema.safeParse([styles[0], { ...styles[1], id: 'quick' }]).success).toBe(false);
  expect(workStylesSchema.safeParse([{ ...styles[0], description: ' ' }]).success).toBe(false);
  for (const ids of [['invented'], ['quick', 'quick']]) {
    expect(savedAssessmentSchema.safeParse({ ...assessment, assessment: { ...assessment.assessment, workStyleIds: ids } }).success).toBe(false);
  }
});

test('v3 history stays readable without invented styles; v4 retains original style names', async () => {
  const { state, assessment } = await fixture();
  const { workStyles: _, ...envelope } = assessment;
  const { workStyleIds: _ids, ...rated } = assessment.assessment;
  const legacy = storedAssessmentSchema.parse({ ...envelope, assessmentVersion: 'work-assessment-v3', assessment: rated, sequence: 1 });
  const task = state.tasks.find(task => task.id === assessment.id)!;
  expect(taskStyles(task, styles, legacy)).toEqual([]);
  const html = renderToStaticMarkup(createElement(AssessmentHistory, {
    task: { ...task, assessments: [legacy] }, profileId: 'default', settings: state.work.settings,
  }));
  expect(html).toContain('Not recorded in this assessment format.');
  expect(html).toContain('No implementation evidence is supplied.');
  state.work.settings.workStyles![0]!.name = 'Renamed';
  const current = storedAssessmentSchema.parse({ ...assessment, sequence: 2 });
  expect(renderToStaticMarkup(createElement(AssessmentHistory, {
    task: { ...task, assessments: [current] }, profileId: 'default', settings: state.work.settings,
  }))).toContain('Quick wins, Deep focus');
});

test('canonical duplicates retain current manual corrections from both source rows', () => {
  const state = emptyWorkspace(at, 'UTC');
  state.work.settings.workStyles = styles;
  const url = 'https://github.com/octo/repo/issues/1';
  const collected = reconcileWork(state, {
    collectedAt: at, warnings: [], observations: [],
    candidates: [{ title: 'Task', url, action: 'implement', evidence: [
      { id: 'request', source: 'github', streamId: 'issues', at, url, summary: 'Please implement' },
    ] }],
  }, at);
  const first = collected.tasks[0]!;
  first.workStyleOverride = ['quick', 'deleted-style'];
  collected.tasks.push({ ...structuredClone(first), id: 'duplicate', workStyleOverride: ['focus'] });
  expect(consolidateWorkTasks(collected).tasks[0]!.workStyleOverride).toEqual(['quick', 'focus']);
});
