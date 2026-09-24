import { expect, type Page } from '@playwright/test';
import { test, gate, persisted } from './native-fixture.ts';

test.use({ referenceWorkspace: false });

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
  expect(request.input.instructions).toBe('Incidents first');
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
  await expect(page.getByLabel('What should come first?')).toHaveValue('');
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
  expect(rank.input.instructions).toContain('relay roadmap phase one');
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
  await expect(details).toHaveCount(0);
});

test('coverage warnings and run errors appear only once in the expandable details', async ({ page, native }) => {
  native.workCollection.warnings = ['Search results were capped.'];
  native.workCollection.coverageInfo = ['Older history remains.'];
  native.failRank = true;
  await page.goto('/');
  await run(page);
  const details = page.locator('.task-run-details');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(details.locator('summary')).toHaveText('Coverage and run details (5)');
  await details.locator('summary').click();
  await expect(details.getByRole('listitem')).toHaveCount(5);
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

test('settings accept explicit read tools and scheduled native ticks use the same run', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add source' }).click();
  const stream = page.locator('.task-stream').last();
  await stream.getByLabel('Name', { exact: true }).fill('Slack requests');
  await stream.getByLabel('What should Copilot look for?').fill('Find direct requests in my team channel.');
  await stream.getByLabel('MCP server name').fill('slack');
  await stream.getByLabel('Allowed read tools, comma-separated').pressSequentially('search_messages, get_thread');
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
