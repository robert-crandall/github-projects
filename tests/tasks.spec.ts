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

test('task-first home captures and completes work offline across relaunch', async ({ page, native }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What’s next' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
  await page.getByLabel('What should come first?').fill('Prioritize usersd roadmap phase one and Slack reviews.');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await run(page);
  const rank = native.requests.find(request => request.op === 'work.rank');
  expect(rank?.op).toBe('work.rank');
  if (rank?.op !== 'work.rank') throw new Error('Rank request missing');
  expect(rank.input.tasks).toHaveLength(3);
  expect(rank.input.instructions).toContain('usersd roadmap phase one');
  await expect(page.locator('.task-title').first()).toHaveText('Review the usersd rollout');
  await expect(page.locator('.task-reason').first()).toHaveText('Priority for Review the usersd rollout');
  expect(native.requests.some(request => request.op.startsWith('github.'))).toBe(false);
  expect(native.state.tasks.filter(task => task.work)).toHaveLength(1);
});

test('Done survives repeated queries and only a newer request reopens it', async ({ page, native }) => {
  await page.goto('/');
  await run(page);
  await page.getByRole('button', { name: 'Mark done: Review the usersd rollout', exact: true }).click();
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
  await expect(page.locator('.task-title')).toHaveText('Review the usersd rollout');
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
  await expect(page.locator('.task-title')).toHaveText('Review the usersd rollout');
  expect(native.state.tasks[0]?.status).toBe('open');
  native.workCollection.observations[0]!.state = 'open';
  native.workCollection.observations[0]!.reason = '';
  await run(page);
  await page.getByRole('button', { name: /^To do/ }).click();
  await expect(page.locator('.task-title')).toHaveText('Review the usersd rollout');
});

test('model failure preserves discoveries and makes unranked work explicit', async ({ page, native }) => {
  await page.goto('/');
  await add(page, 'Existing local task');
  native.failRank = true;
  await run(page);
  await expect(page.getByRole('alert')).toContainText('Copilot ranking failed');
  await expect(page.locator('.task-title')).toHaveCount(2);
  expect(native.state.work.ranking).toBeNull();
  expect(native.state.work.lastCompletedAt).toBeNull();
  native.failRank = false;
  await run(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('unknown source state stays visible instead of silently removing work', async ({ page, native }) => {
  await page.goto('/');
  await run(page);
  native.workCollection.candidates = [];
  native.workCollection.observations[0]!.state = 'unknown';
  native.workCollection.observations[0]!.reason = 'GitHub state could not be checked. Retry the source.';
  await run(page);
  await expect(page.locator('.task-title')).toHaveText('Review the usersd rollout');
  await expect(page.locator('.task-uncertain')).toContainText('GitHub state could not be checked');
  const rank = native.requests.filter(request => request.op === 'work.rank').at(-1);
  if (rank?.op !== 'work.rank') throw new Error('Rank request missing');
  expect(rank.input.tasks).toHaveLength(1);
  expect(rank.input.tasks[0]!.notes).toContain('GitHub state could not be checked');
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
  await expect(page.locator('.task-title')).toContainText(['Review the usersd rollout', 'Arrived during the run']);
  expect(native.state.tasks.find(task => task.title === 'Already handled')?.status).toBe('done');
  await expect(page.locator('.ranked-list > li').filter({ hasText: 'Arrived during the run' })).toContainText('Not ranked yet');
});

test('settings accept explicit read tools and scheduled native ticks use the same run', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
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
  await page.getByRole('button', { name: 'Sources and priorities', exact: true }).click();
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

test('ranked list and details stay readable on desktop and narrow screens', async ({ page, native }, testInfo) => {
  native.workCollection.candidates[0]!.title = '<img src=x> Review a long usersd task with a source that needs context';
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
