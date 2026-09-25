import { expect, type Page } from '@playwright/test';
import { test, gate, persisted, type NativeMock } from './native-fixture.ts';
import { emptyWorkspace } from '../src/domain/live.ts';
import { reconcileWork } from '../src/work/engine.ts';
import { createWorkProfile, switchWorkProfile } from '../src/work/profiles.ts';
import { snapshotSchema } from '../src/platform/native.ts';
import { assessmentBatch } from './assessment-fixture.ts';
import { rankInput } from '../src/work/engine.ts';
import { taskAgent, taskAgentJobs } from '../service/src/work-agents.ts';

test.use({ referenceWorkspace: false });

function codeTask(native: NativeMock, kind: 'pr' | 'issue' = 'pr') {
  const url = `https://github.com/octo/project/${kind === 'pr' ? 'pull' : 'issues'}/47`;
  const state = reconcileWork(emptyWorkspace(native.now, 'UTC'), {
    collectedAt: native.now, warnings: [], candidates: [{
      title: 'Inspect source safely', action: kind === 'pr' ? 'review' : 'implement', url,
      evidence: [{ id: 'code-request', streamId: 'github-assigned', source: 'github', at: native.now, url, summary: 'Inspect source' }],
    }], observations: [{ url, reference: { repo: 'octo/project', number: 47, kind }, state: 'open', observedAt: native.now, reason: '' }],
  }, native.now);
  native.saved = { revision: crypto.randomUUID(), savedAt: native.now, snapshot: snapshotSchema.parse(JSON.parse(JSON.stringify({
    formatVersion: 1, reminders: [], workspace: { version: 1, state, scroll: {} },
  }))) };
}

test('code sessions run only explicitly, retain partial outcomes, and keep edits/navigation usable', async ({ page, native }, testInfo) => {
  codeTask(native);
  await page.goto('/');
  await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  await expect(panel.getByRole('button', { name: 'Review PR', exact: true })).toBeEnabled();
  expect(native.requests).toHaveLength(0);
  native.holdCode = gate();
  await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Reading pinned code');
  expect(native.codeRuns.entries[0]!.outcome.status).toBe('running');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await page.getByLabel('Task notes', { exact: true }).fill('Private notes during review');
  await persisted(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Implementation assessor', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'PR reviewer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  native.holdCode.release();
  await expect(panel).toContainText('Partial inspection saved');
  await expect(panel).toContainText('Partial code inspection only. This is not an approval to merge.');
  await expect(panel).toContainText('No grounded findings returned. This is not approval');
  await expect(panel).toContainText('Partial coverage: bounded, selective inspection');
  expect(native.state.tasks[0]!.notes).toBe('Private notes during review');
  expect(native.state.tasks[0]!.status).toBe('open');
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode']);
  expect(JSON.stringify(native.requests)).not.toContain('Private notes');
  await page.screenshot({ path: testInfo.outputPath('code-session-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByLabel('Code session version').focus();
  await expect(panel.getByLabel('Code session version')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('code-session-narrow.png') });
  await page.reload();
  await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
  await expect(panel).toContainText('Partial code inspection only.');
  expect(native.requests).toHaveLength(1);
});

test('not-inspected and source-changed are honest, reruns retain history, cancellation waits for target', async ({ page, native }) => {
  codeTask(native); native.codeInspected = false;
  await page.goto('/');
  await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(panel).toContainText('No source-code lines were inspected. No code review or approval was completed.');
  await expect(panel).toContainText('No code coverage obtained.');
  await expect(panel).not.toContainText('Partial coverage: bounded, selective inspection');
  native.codeError = 'source_changed';
  await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(panel).toContainText('The source or branch moved. Start a new run');
  await expect(panel.getByLabel('Code session version').locator('option')).toHaveCount(2);
  native.holdCode = gate(); native.codeError = ''; native.cancelCode = true;
  await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Reading pinned code');
  await panel.getByRole('button', { name: 'Cancel code job' }).click();
  await expect(panel.getByRole('status')).toContainText('Waiting for the actual outcome');
  expect(native.codeRuns.entries.at(-1)!.outcome.status).toBe('cancelling');
  native.holdCode.release();
  await expect(panel).toContainText('Run cancelled');
  expect(native.state.tasks[0]!.status).toBe('open');
  expect(native.launches).toHaveLength(0);
});

test('restoring a workspace keeps every Copilot action disabled until the old code target settles', async ({ page, native }) => {
  codeTask(native);
  await page.goto('/');
  await persisted(page);
  const backupId = crypto.randomUUID();
  native.backups.set(backupId, structuredClone(native.saved));
  await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  const held = native.holdCode = gate();
  try {
    await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Reading pinned code');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Backups & recovery', exact: true }).click();
    await page.getByRole('combobox', { name: 'Saved backup', exact: true }).selectOption(backupId);
    await page.getByLabel('I exported pending edits and results.', { exact: false }).check();
    await page.getByRole('button', { name: 'Restore selected backup', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => native.requests.some(request => request.op === 'cancel')).toBe(true);
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
    for (const name of ['Run now', 'Run assessor', 'Run prioritizer', 'Review PR']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    await expect(panel.getByRole('status')).toContainText('Waiting for the previous code job');
    await page.getByLabel('Task notes', { exact: true }).fill('Editable during old request cleanup');
    await persisted(page);
    expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
    expect(native.codeRuns.entries).toHaveLength(0);
  } finally {
    held.release();
    native.holdCode = undefined;
  }
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await expect.poll(() => native.codeRuns.entries.some(run => run.quarantined)).toBe(true);
  await panel.getByRole('button', { name: 'Review PR', exact: true }).click();
  await expect(panel).toContainText('Partial inspection saved');
  expect(native.requests.filter(request => request.op === 'work.reviewCode')).toHaveLength(2);
  expect(native.state.tasks[0]!.notes).toBe('Editable during old request cleanup');
});

test('implementation result save failure retries without model replay and prior-workspace results remain separate', async ({ page, native }) => {
  codeTask(native, 'issue');
  await page.goto('/');
  await page.locator('.task-row').filter({ hasText: 'Inspect source safely' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  native.codeRuns.failUpdate = true;
  await panel.getByRole('button', { name: 'Assess implementation' }).click();
  await expect(panel).toContainText('Result not saved');
  await expect(panel).toContainText('No code was implemented or task marked Done');
  await expect(panel).toContainText('Recommended next step');
  await page.getByLabel('Task notes', { exact: true }).fill('Notes still save');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText('Task edits saved; code results pending');
  native.codeRuns.failUpdate = false;
  await panel.getByRole('button', { name: 'Retry saving result' }).click();
  await expect(panel).toContainText('Partial inspection saved');
  expect(native.requests).toHaveLength(1);
  expect(native.state.tasks[0]!.notes).toBe('Notes still save');
});

async function add(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add task', exact: false }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a task' });
  await dialog.getByLabel('What do you need to do?').fill(title);
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await persisted(page);
}
async function run(page: Page) {
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await persisted(page);
}

test('configurable agents run independently with named roles, durable ratings and whole-list priority', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await add(page, 'First manual task');
  await add(page, 'Second manual task');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const assessor = page.getByRole('group', { name: 'Task assessor', exact: true });
  const prioritizer = page.getByRole('group', { name: 'Task prioritizer', exact: true });
  await assessor.getByLabel('Agent name').fill('Evidence specialist');
  await assessor.getByLabel('Agent model').fill('assessor-model');
  await assessor.getByLabel('How should tasks be assessed?').fill('State what is unknown; never estimate missing effort.');
  await prioritizer.getByLabel('Agent name').fill('Roadmap sorter');
  await prioritizer.getByLabel('Agent model').fill('priority-model');
  await prioritizer.getByLabel('What should come first?').fill('Favor explicit commitments.');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await persisted(page);
  await page.screenshot({ path: testInfo.outputPath('agent-settings-desktop.png') });
  await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Run prioritizer', exact: true }).click();
  await expect(page.getByText(/Run assessor first, then run prioritizer/)).toBeAttached();
  expect(native.requests).toEqual([]);
  native.holdAssessment = gate();
  await page.getByRole('button', { name: 'Run assessor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run prioritizer', exact: true })).toBeDisabled();
  await expect(page.getByText('Assessor only · Order unchanged')).toBeVisible();
  native.holdAssessment.release();
  await expect(page.getByRole('button', { name: 'Run assessor', exact: true })).toBeEnabled();
  await persisted(page);
  expect(native.requests.map(request => request.op)).toEqual(['work.assess']);
  expect(native.state.work.ranking).toBeNull();
  expect(native.assessments.entries).toHaveLength(2);
  await page.locator('.task-row').filter({ hasText: 'First manual task' }).click();
  const history = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(history).toContainText('unknown - No implementation evidence is supplied.');
  await expect(history.getByRole('status')).toHaveText('Current for saved task content');
  await history.getByText('Assessment provenance', { exact: true }).click();
  await expect(history).toContainText('Evidence specialist');
  await expect(history).toContainText('assessor-model');
  const firstIds = native.assessments.entries.map(value => value.resultId);
  await page.getByRole('button', { name: 'Run prioritizer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run prioritizer', exact: true })).toBeEnabled();
  await persisted(page);
  expect(native.requests.map(request => request.op)).toEqual(['work.assess', 'work.rank']);
  expect(native.state.work.ranking?.orderedIds).toEqual(native.state.tasks.map(task => task.id).reverse());
  expect(native.assessments.entries.map(value => value.resultId)).toEqual(firstIds);
  const order = structuredClone(native.state.work.ranking);
  native.failRank = true;
  await page.getByRole('button', { name: 'Run prioritizer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run prioritizer', exact: true })).toBeEnabled();
  await persisted(page);
  expect(native.state.work.ranking).toEqual(order);
  expect(native.assessments.entries.map(value => value.resultId)).toEqual(firstIds);
  await page.getByRole('button', { name: 'Run assessor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run assessor', exact: true })).toBeEnabled();
  await persisted(page);
  expect(native.assessments.entries).toHaveLength(4);
  await expect(history.getByLabel('Assessment version').locator('option')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('agents-history-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Run assessor', exact: true })).toBeVisible();
  await expect(history.getByLabel('Assessment version')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agents-history-narrow.png') });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(assessor.getByLabel('Agent name')).toHaveValue('Evidence specialist');
  await expect(prioritizer.getByLabel('Agent model')).toHaveValue('priority-model');
});

test('assessment history stays readable after order failure, edits, Done and relaunch', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await add(page, 'Write the proposal');
  native.failRank = true;
  await run(page);
  await page.locator('.task-row').filter({ hasText: 'Write the proposal' }).click();
  const history = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(history.getByRole('status')).toHaveText('Current for saved task content');
  await expect(history).toContainText('Assessment of Write the proposal');
  const first = native.assessments.values(native.state.tasks.find(task => task.title === 'Write the proposal')!.id)[0]!;
  await history.getByText('Assessment provenance', { exact: true }).click();
  await expect(history).toContainText('SDK default (resolved model not reported)');
  await expect(history).toContainText(first.resultId);
  await page.getByLabel('Task', { exact: true }).fill('Write the updated proposal');
  await expect(history.getByRole('status')).toHaveText('Outdated: task content changed');
  native.failRank = false;
  native.now = '2026-09-11T18:00:00.000Z';
  await page.clock.setFixedTime(new Date(native.now));
  await run(page);
  await expect(history.getByRole('status')).toHaveText('Current for saved task content');
  await expect(history).toContainText('Assessment of Write the updated proposal');
  const versions = [...native.assessments.values(first.id)];
  expect(versions).toHaveLength(2);
  await history.getByLabel('Assessment version').selectOption(first.resultId);
  await expect(history).toContainText('Historical result.');
  await expect(history).toContainText('Assessment of Write the proposal');
  await expect(history.getByRole('status')).toHaveText('Outdated: task content changed');
  await page.screenshot({ path: testInfo.outputPath('assessment-history-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history.getByLabel('Assessment version')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('assessment-history-narrow.png') });
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await persisted(page);
  await page.reload();
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.locator('.task-row').filter({ hasText: 'Write the updated proposal' }).click();
  await expect(history.getByLabel('Assessment version').locator('option')).toHaveCount(2);
  await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
  await persisted(page);
  expect(native.assessments.values(first.id)).toEqual(versions);
});

test('assessment expiry never hides its history', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Keep this assessment');
  await run(page);
  await page.locator('.task-row').filter({ hasText: 'Keep this assessment' }).click();
  const history = page.getByRole('region', { name: 'Assessment', exact: true });
  const version = native.assessments.values(native.state.tasks.find(task => task.title === 'Keep this assessment')!.id)[0]!;
  native.now = version.assessment.reevaluateAt;
  await page.clock.setFixedTime(new Date(native.now));
  await page.reload();
  await page.locator('.task-row').filter({ hasText: 'Keep this assessment' }).click();
  await expect(history.getByRole('status')).toHaveText('Expired: reassessment due');
  await expect(history).toContainText('Assessment of Keep this assessment');
  expect(native.assessments.values(version.id)).toEqual([version]);
});

test('latest assessment selection follows saved logical order after the clock moves backwards', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Clock-safe history');
  await run(page);
  const original = native.assessments.values(native.state.tasks.find(task => task.title === 'Clock-safe history')!.id)[0]!;
  native.now = '2026-09-11T16:00:00.000Z';
  await page.clock.setFixedTime(new Date(native.now));
  await run(page);
  const versions = [...native.assessments.values(original.id)];
  expect(versions).toHaveLength(2);
  expect(Date.parse(versions[1]!.evaluatedAt)).toBeLessThan(Date.parse(versions[0]!.evaluatedAt));
  expect(versions[1]!.sequence).toBeGreaterThan(versions[0]!.sequence!);
  await page.reload();
  await page.locator('.task-row').filter({ hasText: 'Clock-safe history' }).click();
  const history = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(history.getByLabel('Assessment version')).toHaveValue(versions[1]!.resultId);
  await expect(history.getByRole('status')).toHaveText('Current for saved task content');
  await run(page);
  await expect(history.getByLabel('Assessment version')).toHaveValue(versions[1]!.resultId);
  expect(native.assessments.values(original.id)).toEqual(versions);
  await history.getByLabel('Assessment version').selectOption(original.resultId);
  await expect(history).toContainText('Historical result.');
});

test('paged history remains readable and exportable without embedding results in task saves', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Paged history');
  const id = native.state.tasks[0]!.id;
  const first = (await assessmentBatch(rankInput(native.state), native.now)).assessments[0]!;
  native.assessments.append('default', Array.from({ length: 45 }, () => ({ ...first, resultId: crypto.randomUUID() })), native.state);
  await page.reload();
  await page.locator('.task-row').filter({ hasText: 'Paged history' }).click();
  const history = page.getByRole('region', { name: 'Assessment', exact: true });
  await expect(history.getByLabel('Assessment version').locator('option')).toHaveCount(20);
  await page.getByRole('button', { name: 'Older assessments', exact: true }).click();
  await expect(history).toContainText('Historical result.');
  await expect(history.getByLabel('Assessment version').locator('option')).toHaveCount(20);
  await page.getByRole('button', { name: 'Older assessments', exact: true }).click();
  await expect(history.getByLabel('Assessment version').locator('option')).toHaveCount(5);
  await page.getByRole('button', { name: 'Latest assessments', exact: true }).click();
  await expect(history).toContainText('Latest saved result.');
  await page.getByLabel('Task notes', { exact: true }).fill('Notes after long history');
  await persisted(page);
  expect(native.state.tasks[0]).not.toHaveProperty('assessments');
  expect(native.assessments.values(id)).toHaveLength(45);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backups & recovery' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export pending copy', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('github-projects-pending.json');
  await expect(page.getByLabel('Import a workspace JSON export')).toHaveCount(0);
  expect(native.assessments.values(id)).toHaveLength(45);
  expect(native.state.tasks[0]!.notes).toBe('Notes after long history');
});

test('failed history append leaves editable tasks and visible retryable exportable results', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Keep paid result');
  native.assessments.fail = true;
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert').first()).toContainText('Assessment history is not saved');
  await page.locator('.task-row').filter({ hasText: 'Keep paid result' }).click();
  await expect(page.getByRole('region', { name: 'Unsaved assessments' })).toContainText('Task edits save separately');
  await page.getByLabel('Task notes', { exact: true }).fill('Preserved while history fails');
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect.poll(() => native.state.tasks.find(task => task.title === 'Keep paid result')!.notes).toBe('Preserved while history fails');
  await expect(page.getByRole('status').filter({ hasText: 'Task edits saved; assessments pending' })).toBeVisible();
  await page.getByRole('button', { name: 'Export pending results', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export pending assessments', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('github-projects-pending-assessments.json');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  native.assessments.fail = false;
  await page.getByRole('button', { name: 'Retry assessment save', exact: true }).first().click();
  await persisted(page);
  expect(native.assessments.entries.length).toBeGreaterThan(0);
});

test('late pre-recovery results are export-only and do not block the next run', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Original task');
  const backupId = crypto.randomUUID();
  native.backups.set(backupId, structuredClone(native.saved));
  native.assessmentBackups.set(backupId, []);
  native.holdAssessment = gate();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => native.requests.some(request => request.op === 'work.assess')).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backups & recovery', exact: true }).click();
  await page.getByRole('combobox', { name: 'Saved backup', exact: true }).selectOption(backupId);
  await page.getByLabel('I exported pending edits and results.', { exact: false }).check();
  await page.getByRole('button', { name: 'Restore selected backup', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  native.holdAssessment.release();
  native.holdAssessment = undefined;
  await expect(page.getByRole('button', { name: 'Export previous workspace results', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  await run(page);
  expect(native.assessments.entries.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Export previous workspace results', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export pending assessments', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('github-projects-pending-assessments.json');
});
test('saved team searches survive relaunch and collect through configured sources', async ({ page, native }) => {
  const query = 'is:pr is:open team-review-requested:sample/provider-maintainers';
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  const source = page.locator('.task-stream').last();
  await source.getByLabel('Name', { exact: true }).fill('Team reviews');
  await source.getByLabel('Source type').selectOption('github');
  await source.getByLabel('GitHub query').fill(query);
  await source.getByLabel('Action to take on matches').selectOption('review');
  await source.getByLabel('Enabled', { exact: true }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  const settings = structuredClone(native.state.work.settings);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ranked Tasks' })).toBeVisible();
  expect(native.state.work.settings).toEqual(settings);
  await run(page);
  const collection = native.requests.find(request => request.op === 'work.collect'
    && request.input.stream.name === 'Team reviews');
  if (collection?.op !== 'work.collect') throw new Error('Saved team search was not collected');
  expect(collection.input.stream).toMatchObject({ kind: 'github', query, enabled: true, action: 'review' });
  expect(native.state.work.settings).toEqual(settings);
  expect(native.requests.some(request => request.op.startsWith('github.'))).toBe(false);
});

test('work profiles preserve separate tasks and priorities across switching and relaunch', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await add(page, 'Regular task');
  await page.getByRole('button', { name: 'Mark done: Regular task', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('What should come first?').fill('Roadmap first');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await page.getByRole('button', { name: 'Add profile', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add work profile' });
  await expect(modal.getByLabel('Profile name')).toBeFocused();
  await modal.getByLabel('Profile name').fill('On call');
  await modal.getByLabel('Copy saved instructions and sources from Default').check();
  await modal.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByLabel('Profile name')).toHaveValue('On call');
  await expect(page.getByLabel('What should come first?')).toHaveValue('Roadmap first');
  await page.getByLabel('What should come first?').fill('Incidents first');
  await page.getByLabel('Profile name').fill('Incident response');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  const profileId = native.state.activeWorkProfile.id;
  expect(native.state.work.settings.schedule.enabled).toBe(false);
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await expect(page.locator('.task-title')).toHaveCount(0);
  await add(page, 'Investigate incident');
  await run(page);
  const request = native.requests.find(request => request.op === 'work.rank')!;
  if (request.op !== 'work.rank') throw new Error('Ranking request missing');
  expect(taskAgent(request.input, 'task-prioritization').instructions).toBe('Incidents first');
  expect(request.input.tasks.map(task => task.title)).not.toContain('Regular task');
  await page.screenshot({ path: testInfo.outputPath('work-profiles-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Work profile', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('work-profiles-narrow.png') });

  await page.getByLabel('Work profile', { exact: true }).selectOption('default');
  await persisted(page);
  await expect(page.locator('.task-title')).toHaveCount(0);
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('.task-title')).toHaveText('Regular task');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('What should come first?')).toHaveValue('Roadmap first');
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await page.getByLabel('Work profile', { exact: true }).selectOption(profileId);
  await persisted(page);
  await page.reload();
  await expect(page.getByLabel('Work profile', { exact: true })).toHaveValue(profileId);
  await expect(page.locator('.task-title')).toContainText(['Review the relay rollout', 'Investigate incident']);
  expect(native.state.inactiveWorkProfiles[0]!.tasks[0]!.status).toBe('done');
});

test('profile creation reports duplicate names and starts empty without copying', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add profile', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add work profile' });
  await modal.getByLabel('Profile name').fill(' default ');
  await modal.getByRole('button', { name: 'Create profile' }).click();
  await expect(modal.getByRole('alert')).toContainText('must be unique');
  expect(native.state.inactiveWorkProfiles).toHaveLength(0);
  await modal.getByLabel('Profile name').fill('Release week');
  await modal.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByLabel('What should come first?')).toHaveValue(taskAgentJobs['task-prioritization'].instructions);
  await expect(page.locator('.task-stream')).toHaveCount(0);
  await persisted(page);
  expect(native.state.tasks).toEqual([]);
  expect(native.state.work.settings.streams).toEqual([]);
  await page.getByLabel('Profile name').fill('Default');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert')).toContainText('must be unique');
  expect(native.state.activeWorkProfile.name).toBe('Release week');
});

test('profile selection and creation wait for an in-flight ranking', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Keep this run here');
  native.holdRank = gate();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => native.requests.filter(request => request.op === 'work.rank').length).toBe(1);
  await expect(page.getByLabel('Work profile', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add profile', exact: true })).toBeDisabled();
  await expect(page.getByText('Profiles can be switched after the current run or unsubscribe finishes.')).toBeVisible();
  native.holdRank.release();
  native.holdRank = undefined;
  await expect(page.getByLabel('Work profile', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add profile', exact: true })).toBeEnabled();
});

test('task-first home captures and completes work offline across relaunch', async ({ page, native }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ranked Tasks' })).toBeVisible();
  await add(page, 'Prepare the roadmap');
  expect(native.requests).toEqual([]);
  await page.getByRole('button', { name: 'Mark done: Prepare the roadmap', exact: true }).click();
  await persisted(page);
  await expect(page.locator('.ranked-list')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('.task-title')).toHaveText('Prepare the roadmap');
  expect(native.state.tasks[0]?.status).toBe('done');
  expect(native.requests).toEqual([]);
});

test('every run ranks all tasks with saved instructions without reading notifications', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Prepare roadmap');
  await add(page, 'Read release notes');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('What should come first?').fill('Prioritize relay roadmap phase one and Slack reviews.');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await run(page);
  const rank = native.requests.find(request => request.op === 'work.rank');
  expect(rank?.op).toBe('work.rank');
  if (rank?.op !== 'work.rank') throw new Error('Rank request missing');
  expect(rank.input.tasks).toHaveLength(3);
  expect(taskAgent(rank.input, 'task-prioritization').instructions).toContain('relay roadmap phase one');
  await expect(page.locator('.task-title').first()).toHaveText('Review the relay rollout');
  await expect(page.locator('.task-reason').first()).toHaveText('Priority for Review the relay rollout');
  expect(native.requests.some(request => request.op.startsWith('github.'))).toBe(false);
  expect(native.state.tasks.filter(task => task.work)).toHaveLength(1);
});

test('Done survives repeated queries and only a newer request reopens it', async ({ page, native }) => {
  await page.goto('/');
  await run(page);
  await page.getByRole('button', { name: 'Mark done: Review the relay rollout', exact: true }).click();
  await persisted(page);
  await run(page);
  await expect(page.locator('.task-title')).toHaveCount(0);
  native.workCollection.candidates[0]!.evidence[0]!.id = 'github:request:123:older-discovery';
  await run(page);
  await expect(page.locator('.task-title')).toHaveCount(0);
  const future = '2026-09-12T17:00:00Z';
  native.workCollection.candidates[0]!.evidence[0]!.id = 'github:request:123:fresh';
  native.workCollection.candidates[0]!.evidence[0]!.at = future;
  native.workCollection.collectedAt = future;
  await page.clock.setFixedTime(new Date(future));
  await run(page);
  await expect(page.locator('.task-title')).toHaveText('Review the relay rollout');
  expect(native.state.tasks).toHaveLength(1);
});

test('merge queue removes work without completing it and reopening restores only open work', async ({ page, native }) => {
  await page.goto('/');
  await run(page);
  native.workCollection.candidates = [];
  native.workCollection.observations[0]!.state = 'queued';
  native.workCollection.observations[0]!.reason = 'This PR is in the merge queue.';
  await run(page);
  await expect(page.locator('.task-title')).toHaveCount(0);
  await page.getByRole('button', { name: /^No action now/ }).click();
  await expect(page.locator('.task-title')).toHaveText('Review the relay rollout');
  expect(native.state.tasks[0]?.status).toBe('open');
  native.workCollection.observations[0]!.state = 'open';
  native.workCollection.observations[0]!.reason = '';
  await run(page);
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(page.locator('.task-title')).toHaveText('Review the relay rollout');
});

test('model failure preserves discoveries and makes unranked work explicit', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Existing local task');
  native.failRank = true;
  await run(page);
  const details = page.locator('.task-run-details');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(details.locator('summary')).toHaveText('Coverage and run details (1)');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toContainText('Copilot ranking failed');
  await expect(page.locator('.task-title')).toHaveCount(2);
  expect(native.state.work.ranking).toBeNull();
  expect(native.state.work.lastCompletedAt).toBeNull();
  await page.reload();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await details.locator('summary').click();
  await expect(details).toContainText('Copilot ranking failed');
  native.failRank = false;
  await run(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(details).toContainText('Coverage and run details');
  await expect(page.getByText('Run complete', { exact: true })).toBeVisible();
  await expect(details).not.toContainText('Copilot ranking failed');
});

test('coverage warnings and run errors appear only once in the expandable details', async ({ page, native }) => {
  native.workCollection.warnings = ['Search results were capped.'];
  native.workCollection.coverageInfo = ['Older history remains.'];
  native.failRank = true;
  await page.goto('/');
  await run(page);
  const details = page.locator('.task-run-details');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(details.locator('summary')).toHaveText('Coverage and run details (5) 2 sources failed');
  await details.locator('summary').click();
  await expect(details.getByRole('listitem')).toHaveCount(3);
  await expect(details.locator('.task-run-diagnostic')).toHaveCount(4);
  for (const stream of native.state.work.settings.streams.filter(stream => stream.enabled)) {
    await expect(page.getByText(`${stream.name}: Search results were capped.`, { exact: true })).toHaveCount(1);
  }
  await expect(details).toContainText('Older history remains.');
  await expect(details).toContainText('Copilot ranking failed');
});

test('task action and storage failures remain visible outside run details', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Keep this task');
  await page.locator('.task-row').first().click();
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('');
  await expect(page.getByRole('alert')).toContainText('Write a task title first.');
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Keep this task safely');
  await persisted(page);
  native.failSave = true;
  await page.getByLabel('Task notes').fill('Unsaved note');
  await expect(page.getByRole('alert')).toContainText('Disk unavailable');
  native.failSave = false;
  await page.getByRole('button', { name: 'Retry storage' }).click();
  await persisted(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unknown source state stays visible instead of silently removing work', async ({ page, native }) => {
  await page.goto('/');
  await run(page);
  await page.locator('.task-row').first().click();
  await page.getByLabel('Task notes').fill('Check the rollout plan before reviewing.');
  await persisted(page);
  await page.getByRole('button', { name: 'Close task details' }).click();
  native.workCollection.candidates = [];
  native.workCollection.observations[0]!.state = 'unknown';
  native.workCollection.observations[0]!.reason = 'GitHub state could not be checked. Retry the source.';
  await run(page);
  await expect(page.locator('.task-title')).toHaveText('Review the relay rollout');
  await expect(page.locator('.task-uncertain')).toContainText('GitHub state could not be checked');
  const rank = native.requests.filter(request => request.op === 'work.rank').at(-1);
  if (rank?.op !== 'work.rank') throw new Error('Rank request missing');
  expect(rank.input.tasks).toHaveLength(1);
  expect(rank.input.tasks[0]).toMatchObject({
    availability: 'unknown',
    availabilityReason: 'GitHub state could not be checked. Retry the source.',
    notes: 'Check the rollout plan before reviewing.',
  });
});

test('local capture and Done during ranking survive the result', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Already handled');
  native.holdRank = gate();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => native.requests.filter(request => request.op === 'work.rank').length).toBe(1);
  await page.getByRole('button', { name: 'Mark done: Already handled', exact: true }).click();
  await add(page, 'Arrived during the run');
  native.holdRank.release();
  native.holdRank = undefined;
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await persisted(page);
  await expect(page.locator('.task-title')).toContainText(['Review the relay rollout', 'Arrived during the run']);
  expect(native.state.tasks.find(task => task.title === 'Already handled')?.status).toBe('done');
  await expect(page.locator('.ranked-list > li').filter({ hasText: 'Arrived during the run' })).toContainText('Not ranked yet');
});

test('Slack sources start with official read tools and retain them across relaunch', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  await page.getByRole('button', { name: 'Add source' }).click();
  const stream = page.locator('.task-stream').last();
  await expect(stream.getByLabel('Source type')).toHaveValue('slack');
  await expect(stream.getByLabel('Allowed read tools, comma-separated'))
    .toHaveValue('slack_search_public_and_private,slack_read_thread');
  await expect(stream.getByLabel('Enabled')).not.toBeChecked();
  await expect(stream.getByLabel('MCP server name')).toHaveValue('');
  await stream.getByLabel('What should Copilot look for?').fill('Find direct requests in my team channel.');
  await stream.getByLabel('MCP server name').fill('Slack');
  await stream.getByLabel('Enabled').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.reload();
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  await expect(stream.getByLabel('Allowed read tools, comma-separated'))
    .toHaveValue('slack_search_public_and_private,slack_read_thread');
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await run(page);
  const request = native.requests.find(request => request.op === 'work.collect' && request.input.stream.kind === 'slack');
  if (request?.op !== 'work.collect') throw new Error('Slack collection request missing');
  expect(request.input.stream.tools).toEqual(['slack_search_public_and_private', 'slack_read_thread']);
});

test('selecting Slack fills only empty tool lists and preserves saved choices', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  const stream = page.locator('.task-stream').first();
  const type = stream.getByLabel('Source type');
  const tools = stream.getByLabel('Allowed read tools, comma-separated');
  await type.selectOption('mcp');
  await expect(tools).toHaveValue('');
  await tools.fill(' , ');
  await type.selectOption('slack');
  await expect(tools).toHaveValue('slack_search_public_and_private,slack_read_thread');
  await tools.fill('slack_search_public, slack_read_thread');
  await type.selectOption('mcp');
  await type.selectOption('slack');
  await expect(tools).toHaveValue('slack_search_public, slack_read_thread');
  await stream.getByLabel('Enabled').uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.reload();
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  await expect(tools).toHaveValue('slack_search_public,slack_read_thread');
  await tools.fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.reload();
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  await expect(tools).toHaveValue('');
  expect(native.state.work.settings.streams[0]?.tools).toEqual([]);
});

test('settings accept explicit read tools and scheduled native ticks use the same run', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add source' }).click();
  const stream = page.locator('.task-stream').last();
  await stream.getByLabel('Name', { exact: true }).fill('Slack requests');
  await stream.getByLabel('What should Copilot look for?').fill('Find direct requests in my team channel.');
  await stream.getByLabel('MCP server name').fill('slack');
  await stream.getByLabel('Allowed read tools, comma-separated').fill('search_messages, get_thread');
  await stream.getByLabel('Enabled').check();
  await page.getByLabel('Collect and prioritize automatically').check();
  await page.getByLabel('Minutes between runs').fill('5');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  expect(native.state.work.settings.streams.at(-1)?.tools).toEqual(['search_messages', 'get_thread']);
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('native-work-tick')));
  await expect.poll(() => native.requests.filter(request => request.op === 'work.rank').length).toBe(1);
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('native-work-tick')));
  expect(native.requests.filter(request => request.op === 'work.rank')).toHaveLength(1);
});

test('completed-review extraction is offered only for MCP sources', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const stream = page.locator('.task-stream').first();
  const action = stream.getByLabel('Action to take on matches');
  await expect(action.locator('option[value="review-result"]')).toHaveCount(0);
  await stream.getByLabel('Source type').selectOption('mcp');
  await stream.getByLabel('Default action').selectOption('review-result');
  await stream.getByLabel('Source type').selectOption('github');
  await expect(action.locator('option:checked')).toHaveText('Choose a supported GitHub action');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert')).toContainText(/review-result/i);
  expect(native.state.work.settings.streams[0]?.action).toBe('review');
  await action.selectOption('reply');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(native.state.work.settings.streams[0]?.action).toBe('reply');
});

test('notification source is opt-in, automatic, and keeps backlog searches', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const before = structuredClone(native.state.work.settings.streams);
  await page.getByRole('button', { name: 'Add GitHub notifications' }).click();
  const notification = page.locator('.task-stream').last();
  await expect(notification.getByLabel('Source type')).toHaveValue('github-notifications');
  await expect(notification.getByText('The first scan covers 30 days.', { exact: false })).toBeVisible();
  await expect(notification.getByLabel('MCP server name')).toHaveCount(0);
  await expect(notification.getByRole('combobox')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  expect(native.state.work.settings.streams.slice(0, 2)).toEqual(before);
  expect(native.state.work.settings.streams[2]).toMatchObject({ kind: 'github-notifications', enabled: true });
  expect(native.requests).toEqual([]);
  await notification.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('notification-settings-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await notification.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('notification-settings-narrow.png') });
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await run(page);
  const collectors = native.requests.filter(request => request.op === 'work.collect');
  expect(collectors.map(request => request.input.stream.kind)).toEqual(['github', 'github', 'github-notifications']);
  await page.reload();
  expect(native.state.work.settings.streams[2]!.kind).toBe('github-notifications');
});

test('partial notification coverage persists through relaunch and continues without a failure banner', async ({ page, native }) => {
  native.workCollection.coveredThrough = '2026-09-10T00:00:00.000Z';
  native.workCollection.coverageInfo = ['More notification history remains; the next run continues from this boundary.'];
  await page.goto('/');
  await run(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('More notification history remains. The next run continues after', { exact: false })).toBeVisible();
  expect(native.state.work.collectionCursor).toBe('2026-09-10T00:00:00.000Z');
  await page.reload();
  await expect(page.getByText('More notification history remains. The next run continues after', { exact: false })).toBeVisible();
  delete native.workCollection.coveredThrough;
  delete native.workCollection.coverageInfo;
  await run(page);
  await expect(page.getByText('More notification history remains. The next run continues after', { exact: false })).toHaveCount(0);
  const collections = native.requests.filter(request => request.op === 'work.collect');
  expect(collections.at(-1)!.input.since).toBe('2026-09-10T00:00:00.000Z');
});

test('unsubscribe confirms separately from Done and survives relaunch', async ({ page, native }, testInfo) => {
  native.workCollection.candidates[0]!.notification = {
    threadId: '456', reference: { repo: 'octo/project', number: 123, kind: 'pr' }, updatedAt: native.now,
  };
  await page.goto('/');
  await run(page);
  await page.locator('.task-row').first().click();
  await page.getByLabel('Task notes').fill('Keep these notes');
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await persisted(page);
  const before = structuredClone(native.state.tasks[0]!);
  await page.getByRole('button', { name: 'Unsubscribe on GitHub', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Unsubscribe on GitHub' });
  await expect(modal).toContainText('Your task, Done status and notes will stay unchanged.');
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(0);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Unsubscribe on GitHub', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('unsubscribe-confirmation-narrow.png') });
  await modal.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('Unsubscribed on GitHub', { exact: false })).toBeVisible();
  await persisted(page);
  expect(native.state.tasks[0]).toMatchObject({ id: before.id, status: 'done', notes: 'Keep these notes', completedAt: before.completedAt });
  expect(native.state.tasks[0]!.work!.evidence).toEqual(before.work!.evidence);
  expect(native.requests.filter(request => request.op.startsWith('github.')).map(request => request.op)).toEqual(['github.unsubscribe']);
  await page.reload();
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.locator('.task-row').first().click();
  await expect(page.getByText('Unsubscribed on GitHub', { exact: false })).toBeVisible();
});

test('failed unsubscribe remains visible and requires explicit retry after relaunch', async ({ page, native }) => {
  native.workCollection.candidates[0]!.notification = {
    threadId: '456', reference: { repo: 'octo/project', number: 123, kind: 'pr' }, updatedAt: native.now,
  };
  await page.goto('/');
  await run(page);
  await page.locator('.task-row').first().click();
  native.failWrite = true;
  await page.getByRole('button', { name: 'Unsubscribe on GitHub', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Unsubscribe on GitHub' });
  await modal.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('not confirmed');
  await persisted(page);
  const first = native.requests.find(request => request.op === 'github.unsubscribe')!;
  await page.reload();
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(1);
  await page.locator('.task-row').first().click();
  await expect(page.getByText('Unsubscribe is not confirmed.', { exact: false })).toBeVisible();
  native.failWrite = false;
  await page.getByRole('button', { name: 'Retry unsubscribe on GitHub', exact: true }).click();
  await modal.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await persisted(page);
  const writes = native.requests.filter(request => request.op === 'github.unsubscribe');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.input).toEqual(first.input);
  expect(native.state.tasks[0]!.status).toBe('open');
});

test('ranked list and details stay readable on desktop and narrow screens', async ({ page, native }, testInfo) => {
  native.workCollection.candidates[0]!.title = '<img src=x> Review a long relay task with a source that needs context';
  await page.goto('/');
  await add(page, 'Write phase-one rollout notes');
  await run(page);
  await expect(page.locator('img')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('ranked-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.task-row').first().click();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-detail-narrow.png') });
  await page.getByRole('button', { name: 'Close task details' }).click();
  await expect(page.locator('.ranked-list')).toBeVisible();
});

test('live collection progress shows partial failure, elapsed time and a keyboard-accessible source checklist', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of ['Project backlog', 'Notifications', 'Team updates', 'Support requests']) {
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    const source = page.locator('.task-stream').last();
    await source.getByLabel('Name', { exact: true }).fill(name);
    await source.getByLabel('Source type').selectOption('github');
    await source.getByLabel('GitHub query').fill('is:issue is:open assignee:@me');
    await source.getByLabel('Enabled', { exact: true }).check();
  }
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  const sources = native.state.work.settings.streams.filter(source => source.enabled);
  expect(sources).toHaveLength(6);
  const first = gate();
  const active = gate();
  native.workCollections.set(sources[0]!.id, { hold: first });
  native.workCollections.set(sources[3]!.id, { error: 'Authentication expired. Update your connection and run again.' });
  native.workCollections.set(sources[4]!.id, { hold: active });
  native.holdRank = gate();
  await page.clock.install({ time: new Date(native.now) });
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  const progress = page.getByRole('progressbar', { name: 'Collections processed' });
  const region = page.getByRole('region', { name: 'Run progress' });
  const details = page.locator('.task-run-details');
  await expect(progress).toHaveAttribute('aria-valuemax', '6');
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await expect(region).toContainText(`Now: ${sources[0]!.name}`);
  await expect(page.getByLabel('Work profile', { exact: true })).toBeDisabled();
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').focus();
  await page.keyboard.press('Space');
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.task-run-source-state')).toHaveText(['Collecting', 'Waiting', 'Waiting', 'Waiting', 'Waiting', 'Waiting']);
  first.release();
  await expect(progress).toHaveAttribute('aria-valuenow', '4');
  await expect(progress).toHaveAttribute('aria-valuetext', '3 done, 1 failed, 2 remaining');
  await expect(details.locator('.task-run-source-state')).toHaveText(['Done', 'Done', 'Done', 'Failed', 'Collecting', 'Waiting']);
  await expect(details.locator('summary')).toContainText('1 source failed');
  await expect(region).toContainText('Now: Team updates');
  await expect(region).toContainText('Ranking follows');
  await expect(page.getByText('Notifications: Authentication expired. Update your connection and run again.', { exact: true })).toHaveCount(1);
  const widths = await progress.evaluate(element => ({
    track: element.getBoundingClientRect().width,
    done: element.children[0]!.getBoundingClientRect().width,
    failed: element.children[1]!.getBoundingClientRect().width,
  }));
  expect(widths.done / widths.track).toBeCloseTo(0.5, 2);
  expect(widths.failed / widths.track).toBeCloseTo(1 / 6, 2);
  await page.clock.fastForward(108_000);
  await expect(region).toContainText(/Elapsed 1m 4[89]s/);
  await page.screenshot({ path: testInfo.outputPath('collection-progress-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const ledger = details.locator('.task-run-ledger');
  expect(await ledger.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await ledger.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(region.getByText('Collections · 4 of 6 processed')).toBeVisible();
  await expect(page.locator('.task-title').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('collection-progress-narrow.png') });
  await details.locator('summary').press('Enter');
  await expect(details).not.toHaveAttribute('open', '');
  active.release();
  await expect(progress).toHaveAttribute('aria-valuenow', '6');
  await expect(region).toContainText('Ranking tasks');
  await expect(page.getByRole('button', { name: 'Running...', exact: true })).toBeDisabled();
  native.holdSave = gate();
  native.holdRank.release();
  await expect(region).toContainText('Saving results');
  await expect(page.getByRole('button', { name: 'Running...', exact: true })).toBeDisabled();
  native.holdSave.release();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  await expect(region).toContainText('Run incomplete · Partial coverage');
  const elapsed = await region.locator('.task-run-now > span').last().textContent();
  await page.clock.fastForward(5000);
  await expect(region.locator('.task-run-now > span').last()).toHaveText(elapsed!);
  const retry = gate();
  native.workCollections.clear();
  native.workCollections.set(sources[0]!.id, { hold: retry });
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await expect(progress).toHaveAttribute('aria-valuetext', '0 done, 0 failed, 6 remaining');
  await expect(details).not.toContainText('Authentication expired');
  retry.release();
  await expect(region.getByText('Run complete', { exact: true })).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuetext', '6 done, 0 failed, 0 remaining');
});

test('manual-only progress omits the collection bar and stays active through assessment and ranking', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const enabled of await page.locator('.task-stream').getByLabel('Enabled', { exact: true }).all()) await enabled.uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await persisted(page);
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await add(page, 'Rank local work');
  native.holdAssessment = gate();
  native.holdRank = gate();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  const region = page.getByRole('region', { name: 'Run progress' });
  await expect(region).toContainText('No enabled collections');
  await expect(region).toContainText('Assessing tasks');
  await expect(page.getByRole('button', { name: 'Running...', exact: true })).toBeDisabled();
  native.holdAssessment.release();
  native.holdAssessment = undefined;
  await expect(region).toContainText('Ranking tasks');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.task-run-details')).toHaveCount(0);
  native.holdRank.release();
  await expect(region).toContainText('Run complete');
  expect(native.requests.some(request => request.op === 'work.collect')).toBe(false);
});

function sourceFilterFixture(native: NativeMock) {
  let state = emptyWorkspace(native.now, 'UTC');
  const template = state.work.settings.streams[0]!;
  state.work.settings.streams.push(
    { ...template, id: 'team', name: 'Team requests', kind: 'slack', enabled: false },
    { ...template, id: 'roadmap', name: 'Roadmap requests', kind: 'mcp', enabled: false },
  );
  state = reconcileWork(state, {
    candidates: [
      { title: 'Shared review', action: 'review', url: 'https://github.com/octo/project/issues/1', evidence: [
        { id: 'request-1', source: 'github', streamId: 'github-reviews', at: native.now, url: 'https://github.com/octo/project/issues/1', summary: 'Review request' },
        { id: 'request-2', source: 'slack', streamId: 'team', at: native.now, url: 'https://team.slack.com/archives/C1/p1789473600000000', summary: 'Team request' },
      ] },
      { title: 'Assigned issue', action: 'fix', url: 'https://github.com/octo/project/issues/2', evidence: [
        { id: 'request-3', source: 'github', streamId: 'github-assigned', at: native.now, url: 'https://github.com/octo/project/issues/2', summary: 'Issue request' },
      ] },
      { title: 'Agent result', action: 'review-result', url: 'https://github.com/octo/project/issues/3', evidence: [
        { id: 'request-4', source: 'mcp', streamId: 'push:mcp', at: native.now, url: 'https://github.com/octo/project/issues/3', summary: 'Agent request' },
      ] },
    ],
    observations: [1, 2, 3].map(number => ({ url: `https://github.com/octo/project/issues/${number}`, state: 'open', observedAt: native.now, reason: '' })),
    warnings: [], collectedAt: native.now,
  }, native.now);
  const review = state.tasks[0]!;
  state.tasks.push(
    { id: 'manual', title: 'Manual follow-up', notes: '', status: 'open', createdAt: native.now },
    { ...review, id: 'done-review', title: 'Completed review', status: 'done', completedAt: native.now,
      work: { ...review.work!, identity: 'https://github.com/octo/project/issues/4', url: 'https://github.com/octo/project/issues/4' } },
    { ...review, id: 'waiting-review', title: 'Queued review', work: { ...review.work!, availability: 'waiting', availabilityReason: 'Queued',
      identity: 'https://github.com/octo/project/issues/5', url: 'https://github.com/octo/project/issues/5' } },
  );
  state.work.ranking = { orderedIds: ['manual', ...state.tasks.slice(0, 3).map(task => task.id)], reasons: [], rankedAt: native.now };
  state = switchWorkProfile(createWorkProfile(state, 'On call', true), 'default');
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state, scroll: {} }, reminders: [] });
  return state;
}

function bulkFixture(native: NativeMock) {
  const state = sourceFilterFixture(native);
  state.tasks[0]!.work!.reference = { repo: 'octo/project', number: 1, kind: 'pr' };
  state.tasks[1]!.work!.reference = { repo: 'octo/project', number: 2, kind: 'issue' };
  state.tasks.push({ ...structuredClone(state.tasks[0]!), id: 'second-pr', title: 'Second review', work: {
    ...state.tasks[0]!.work!, url: 'https://github.com/octo/project/issues/6',
    identity: 'https://github.com/octo/project/issues/6', reference: { repo: 'octo/project', number: 6, kind: 'pr' },
  } });
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state, scroll: {} }, reminders: [] });
}

test('explicit task selection is keyboard accessible, context-bound, local-only and preserves ranks', async ({ page, native }, testInfo) => {
  bulkFixture(native);
  await page.goto('/');
  const selected = page.getByRole('region', { name: 'Selected tasks', exact: true });
  const checkbox = page.getByRole('checkbox', { name: 'Select task: Shared review', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  await expect(selected).toContainText('1 selected');
  await expect(page.getByRole('heading', { name: 'Select a task', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select visible tasks' }).focus();
  await page.keyboard.press('Enter');
  await expect(selected).toContainText('5 selected');
  await expect(selected.getByRole('button', { name: 'Assess selected (5)', exact: true })).toBeVisible();
  await expect(selected.getByRole('button', { name: 'Review selected PRs (2)', exact: true })).toBeVisible();
  await expect(selected.getByRole('button', { name: 'Assess implementation (1 issue)', exact: true })).toBeVisible();
  await selected.getByText('Code eligibility:', { exact: false }).click();
  await expect(selected).toContainText('Agent result: No code action');
  await expect(selected).toContainText('Manual follow-up: No code action');
  await expect(page.locator('.task-rank')).toHaveText(['1', '2', '3', '4', '5']);
  await page.screenshot({ path: testInfo.outputPath('bulk-selection-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('bulk-selection-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Clear selection' }).focus();
  await page.keyboard.press('Enter');
  await expect(selected).toContainText('0 selected');
  await checkbox.check();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole('checkbox', { name: 'Manual tasks', exact: true }).uncheck();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole('button', { name: 'Select visible tasks' }).click();
  await expect(selected).toContainText('4 selected');
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.getByRole('checkbox', { name: /^Select task:/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(selected).toContainText('0 selected');
  await checkbox.check();
  await page.getByLabel('Work profile', { exact: true }).selectOption({ label: 'On call' });
  await page.getByLabel('Work profile', { exact: true }).selectOption('default');
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole('button', { name: 'Mark done: Shared review', exact: true }).click();
  await expect(selected).toContainText('0 selected');
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(checkbox).not.toBeChecked();
  await persisted(page);
  expect(native.requests).toEqual([]);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Selected tasks', exact: true })).toContainText('0 selected');
  expect(native.requests).toEqual([]);
});

test('selected assessor and detail assessor save only requested judgments without collecting or ordering', async ({ page, native }) => {
  bulkFixture(native);
  const priorOrder = structuredClone(native.state.work.ranking);
  const id = native.state.tasks.find(task => task.title === 'Shared review')!.id;
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Select task: Shared review', exact: true }).check();
  native.holdAssessment = gate();
  await page.getByRole('button', { name: 'Assess selected (1)', exact: true }).click();
  await expect.poll(() => native.requests.length).toBe(1);
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  await page.getByLabel('Task notes', { exact: true }).fill('Keep concurrent assessment notes');
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await add(page, 'Captured during assessment');
  native.holdAssessment.release();
  await expect(page.getByRole('button', { name: 'Run assessor', exact: true })).toBeEnabled();
  expect(native.requests[0]).toMatchObject({ op: 'work.assess', input: { force: true, tasks: [{ id }] } });
  expect(native.assessments.entries.map(value => value.id)).toEqual([id]);
  expect(native.state.work.ranking).toEqual(priorOrder);
  await page.locator('.task-row').filter({ hasText: 'Assigned issue' }).click();
  await page.getByRole('button', { name: 'Assess task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Assess task', exact: true })).toBeEnabled();
  expect(native.requests.map(request => request.op)).toEqual(['work.assess', 'work.assess']);
  expect(native.requests[1]).toMatchObject({ input: { tasks: [{ id: native.state.tasks.find(task => task.title === 'Assigned issue')!.id }] } });
  expect(native.state.tasks.find(task => task.id === id)).toMatchObject({ status: 'done', notes: 'Keep concurrent assessment notes' });
  expect(native.state.tasks.some(task => task.title === 'Captured during assessment')).toBe(true);
});

test('mixed code batch runs only named PRs, preserves detail navigation, and saves inspectable outcomes across relaunch', async ({ page, native }, testInfo) => {
  bulkFixture(native);
  native.holdCode = gate();
  await page.goto('/');
  await page.getByRole('button', { name: 'Select visible tasks' }).click();
  await page.getByRole('button', { name: 'Review selected PRs (2)', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Code batch', exact: true });
  await expect(batch.getByRole('status')).toContainText('Current task: Shared review');
  for (const name of ['Run now', 'Run assessor', 'Run prioritizer']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.locator('.task-row').filter({ hasText: 'Assigned issue' }).click();
  await expect(page.getByRole('button', { name: 'Assess implementation', exact: true })).toBeDisabled();
  await page.getByLabel('Task notes', { exact: true }).fill('Notes while the batch runs');
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await persisted(page);
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode']);
  await batch.getByText('Batch outcomes', { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('bulk-progress-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.locator('.task-detail').boundingBox())!.height).toBeGreaterThan(200);
  await page.getByLabel('Task notes', { exact: true }).fill('Narrow notes stay reachable');
  await persisted(page);
  await batch.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('bulk-progress-narrow.png') });
  native.holdCode.release();
  await expect(batch.getByRole('status')).toHaveText('Batch finished.');
  await expect(batch).toContainText('2 completed');
  await expect(batch).toContainText('3 skipped');
  expect(native.requests.map(request => request.op === 'work.reviewCode' && request.input.job)).toEqual(['pr-review', 'pr-review']);
  expect(native.codeRuns.entries).toHaveLength(2);
  expect(native.state.tasks.find(task => task.title === 'Assigned issue')!.notes).toBe('Notes while the batch runs');
  await page.reload();
  await expect(batch).toHaveCount(0);
  await page.locator('.task-row').filter({ hasText: 'Second review' }).click();
  await expect(page.getByRole('region', { name: 'Code sessions', exact: true })).toContainText('Partial code inspection only. This is not an approval to merge.');
  expect(native.requests).toHaveLength(2);
});

test('code batch stop waits past cancel acknowledgement and never dispatches remaining tasks', async ({ page, native }) => {
  bulkFixture(native); native.holdCode = gate(); native.cancelCode = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Select visible tasks' }).click();
  await page.getByRole('button', { name: 'Review selected PRs (2)', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Code batch', exact: true });
  await expect(batch.getByRole('status')).toContainText('Current task: Shared review');
  await batch.getByRole('button', { name: 'Stop batch' }).click();
  await expect(batch).toContainText('1 not started');
  await expect(batch.getByRole('status')).toContainText('waiting for the current task outcome');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
  native.holdCode.release();
  await expect(batch.getByRole('status')).toHaveText('Batch stopped.');
  await expect(batch).toContainText('1 cancelled');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
});

test('zero-read PR batch reports no inspection, not completed or partial work', async ({ page, native }) => {
  bulkFixture(native); native.codeInspected = false;
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Select task: Shared review', exact: true }).check();
  await page.getByRole('button', { name: 'Review selected PRs (1)', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Code batch', exact: true });
  await expect(batch.getByRole('status')).toHaveText('Batch finished.');
  await expect(batch).toContainText('1 not inspected');
  await expect(batch).not.toContainText(/completed|partial/i);
  await batch.getByText('Batch outcomes', { exact: true }).click();
  await expect(batch).toContainText('No code inspected');
  await expect(batch).not.toContainText(/completed|partial/i);
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  await expect(panel).toContainText('No source-code lines were inspected. No code review or approval was completed.');
  await expect(panel).toContainText('No code coverage obtained.');
  await expect(panel).not.toContainText('Partial inspection saved');
  expect(native.codeRuns.entries[0]!.outcome.status).toBe('not-inspected');
  expect(native.requests).toHaveLength(1);
});

test('task details labels batch-wide cancellation and waits past ACK on narrow windows', async ({ page, native }) => {
  bulkFixture(native); native.holdCode = gate(); native.cancelCode = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Select visible tasks' }).click();
  await page.getByRole('button', { name: 'Review selected PRs (2)', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Code batch', exact: true });
  await expect(batch.getByRole('status')).toContainText('Current task: Shared review');
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  await expect(panel.getByRole('button', { name: 'Cancel code job', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('Stop batch cancels the current code job and leaves remaining tasks not started.');
  await panel.getByRole('button', { name: 'Stop batch', exact: true }).click();
  await expect(batch).toContainText('1 not started');
  await expect(panel.getByRole('status')).toContainText('Waiting for the actual outcome');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
  native.holdCode.release();
  await expect(batch.getByRole('status')).toHaveText('Batch stopped.');
  await expect(batch).toContainText('1 cancelled');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode', 'cancel']);
});

test('code batch context change stops only queued tasks and failed saves stay retryable without replay', async ({ page, native }) => {
  bulkFixture(native); native.holdCode = gate(); native.codeRuns.failUpdate = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Select visible tasks' }).click();
  await page.getByRole('button', { name: 'Review selected PRs (2)', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Code batch', exact: true });
  await expect(batch.getByRole('status')).toContainText('Current task: Shared review');
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(batch).toContainText('1 not started');
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode']);
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(page.getByRole('region', { name: 'Selected tasks', exact: true })).toContainText('0 selected');
  native.holdCode.release();
  await expect(batch.getByRole('status')).toHaveText('Batch stopped.');
  await expect(batch).toContainText('1 result not saved');
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  const panel = page.getByRole('region', { name: 'Code sessions', exact: true });
  await expect(panel).toContainText('Result not saved');
  native.codeRuns.failUpdate = false;
  await panel.getByRole('button', { name: 'Retry saving result' }).click();
  await expect(panel).toContainText('Partial inspection saved');
  await expect(batch).toContainText('1 completed');
  await expect(batch).not.toContainText('1 result not saved');
  expect(native.requests.map(request => request.op)).toEqual(['work.reviewCode']);
});

test('source filters match merged provenance once, preserve ranks and keep task actions working', async ({ page, native }) => {
  const original = sourceFilterFixture(native);
  await page.goto('/');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const tree = page.getByRole('region', { name: 'Filter sources' });
  await expect(page.locator('.task-title')).toHaveText(['Manual follow-up', 'Shared review', 'Assigned issue', 'Agent result']);
  await tree.getByRole('checkbox', { name: 'Manual tasks', exact: true }).uncheck();
  await tree.getByRole('checkbox', { name: 'External-agent intake', exact: true }).uncheck();
  await tree.getByRole('checkbox', { name: 'Issues assigned to me', exact: true }).uncheck();
  await expect(tree.getByRole('checkbox', { name: 'Select all GitHub sources' })).toBeChecked({ indeterminate: true });
  await expect(page.locator('.task-title')).toHaveText(['Shared review']);
  await expect(page.locator('.task-rank')).toHaveText('2');
  await expect(page.locator('.task-filter-summary')).toContainText('1 of 4 to dos');
  await expect(tree.locator('label').filter({ has: page.getByRole('checkbox', { name: 'Team requests', exact: true }) })).toContainText('1');
  await tree.getByRole('checkbox', { name: 'Select all GitHub sources' }).click();
  await expect(page.locator('.task-title')).toHaveText(['Shared review', 'Assigned issue']);
  await tree.getByRole('checkbox', { name: 'Select all GitHub sources' }).uncheck();
  await expect(page.locator('.task-title')).toHaveText(['Shared review']);
  await page.locator('.task-row').click();
  await tree.getByRole('checkbox', { name: 'Team requests', exact: true }).uncheck();
  await expect(page.getByRole('heading', { name: 'Select a task', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No matching tasks', exact: true })).toBeVisible();
  await tree.getByRole('checkbox', { name: 'Roadmap requests', exact: true }).uncheck();
  await expect(page.getByRole('heading', { name: 'No sources selected', exact: true })).toBeVisible();
  await tree.getByRole('checkbox', { name: 'Team requests', exact: true }).check();
  await page.getByRole('button', { name: /^No action now/ }).click();
  await expect(page.locator('.task-title')).toHaveText(['Queued review']);
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('.task-title')).toHaveText(['Completed review']);
  await page.getByRole('button', { name: /^To do/ }).click();
  await persisted(page);
  expect(native.state.tasks).toEqual(original.tasks);
  expect(native.state.work.settings).toEqual(original.work.settings);
  expect(native.state.work.ranking).toEqual(original.work.ranking);
  expect(native.requests).toEqual([]);
  await page.getByRole('button', { name: 'Mark done: Shared review', exact: true }).click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(page.locator('.task-title')).toHaveText(['Shared review']);
  await page.getByRole('button', { name: /^Ranked Tasks/ }).click();
  await expect(page.locator('.task-title')).toHaveCount(4);
});

test('source selections and collapsed groups persist per profile and report failed saves', async ({ page, native }) => {
  sourceFilterFixture(native);
  await page.goto('/');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('checkbox', { name: 'Manual tasks', exact: true }).uncheck();
  await page.locator('.task-source-tree summary').filter({ hasText: /^GitHub$/ }).click();
  await persisted(page);
  const selected = structuredClone(native.state.work.sourceFilter);
  await page.getByLabel('Work profile', { exact: true }).selectOption({ label: 'On call' });
  await expect(page.getByRole('checkbox', { name: 'Manual tasks', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select all GitHub sources' })).toBeVisible();
  await page.getByLabel('Work profile', { exact: true }).selectOption('default');
  await expect(page.getByRole('checkbox', { name: 'Manual tasks', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select all GitHub sources' })).not.toBeVisible();
  await persisted(page);
  await page.reload();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Manual tasks', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select all GitHub sources' })).not.toBeVisible();
  expect(native.state.work.sourceFilter).toEqual(selected);
  native.failSave = true;
  await page.getByRole('checkbox', { name: 'Manual tasks', exact: true }).check();
  await expect(page.getByRole('alert')).toContainText('Disk unavailable');
  expect(native.state.work.sourceFilter).toEqual(selected);
  native.failSave = false;
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await persisted(page);
  await page.getByRole('button', { name: 'Show all sources', exact: true }).click();
  await persisted(page);
  expect(native.state.work.sourceFilter?.selectedSources).toBeNull();
  expect(native.requests).toEqual([]);
});

test('source sidebar remains keyboard accessible and scrolls without overflowing narrow windows', async ({ page, native }) => {
  sourceFilterFixture(native);
  await page.goto('/');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const manual = page.getByRole('checkbox', { name: 'Manual tasks', exact: true });
  await manual.focus();
  await page.keyboard.press('Space');
  await expect(manual).not.toBeChecked();
  await expect(manual).toBeFocused();
  const github = page.locator('.task-source-tree summary').filter({ hasText: /^GitHub$/ });
  await github.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox', { name: 'Select all GitHub sources' })).not.toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox', { name: 'Select all GitHub sources' })).toBeVisible();
  for (const width of [1440, 901, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const list = await page.locator('.task-main').boundingBox();
    expect(list!.height).toBeGreaterThan(100);
  }
  const sidebar = page.locator('.task-sidebar');
  expect(await sidebar.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole('checkbox', { name: 'PRs awaiting my review', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(manual).toBeChecked();
  await page.locator('.task-row').filter({ hasText: 'Shared review' }).click();
  await expect(page.getByRole('button', { name: 'Close task details', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(page.locator('.task-main')).toBeVisible();
});
