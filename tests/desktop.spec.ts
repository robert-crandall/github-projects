import { expect } from '@playwright/test';
import { test, persisted, thread } from './native-fixture.ts';
import { emptyWorkspace } from '../src/domain/live.ts';
import { sourceThread } from '../src/runtime/service-workspace.ts';
import { snapshotSchema } from '../src/platform/native.ts';
import { legacyFixture } from './workspace-fixtures.ts';

test('ranked tasks is the only workspace, including old reference links and the browser entry', async ({ page, native }) => {
  for (const url of ['/#reference', 'http://127.0.0.1:5173/#reference']) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Ranked Tasks', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Task details', exact: true })).toContainText('Select a task');
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button')).toHaveText(['Ranked Tasks0']);
    await expect(page.getByRole('button', { name: /^(Inbox|Filtered|Archive|Tasks|Waiting on me|Filtering rules|Appearance)$/ })).toHaveCount(0);
    await expect(page).not.toHaveURL(/#reference/);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Appearance', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open saved thread notes' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ranked Tasks', exact: false }).click();
  }
  expect(native.requests).toEqual([]);
});

test('three panes scroll independently and narrow details return to the ranked list', async ({ page, native }, testInfo) => {
  const state = emptyWorkspace(native.now, 'UTC');
  state.tasks = Array.from({ length: 30 }, (_, index) => ({
    id: `manual-${index}`, title: `Task ${index + 1}: review the rollout plan`, notes: 'Keep this context.',
    status: 'open' as const, createdAt: native.now,
  }));
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, reminders: [], workspace: { version: 1, state, scroll: {} } });
  await page.goto('/');
  await page.locator('.task-row').first().click();
  const sidebar = await page.locator('.task-sidebar').boundingBox();
  const list = await page.locator('.task-main').boundingBox();
  const detail = await page.locator('.task-detail').boundingBox();
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(list!.x);
  expect(list!.x + list!.width).toBeLessThanOrEqual(detail!.x);
  expect(await page.locator('.task-main').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator('.task-main').evaluate(element => { element.scrollTop = 300; });
  expect(await page.locator('.task-detail').evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('three-panels-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.task-main')).toBeHidden();
  await expect(page.getByLabel('Task notes')).toHaveValue('Keep this context.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('three-panels-narrow.png') });
  await page.getByRole('button', { name: 'Close task details' }).click();
  await expect(page.locator('.task-main')).toBeVisible();
  expect(await page.locator('.task-main').evaluate(element => element.scrollTop)).toBe(300);
  expect(native.requests).toEqual([]);
});

test('retired filters cannot hide ranked work and matching private notes stay editable', async ({ page, native }) => {
  const state = emptyWorkspace(native.now, 'UTC');
  state.threads = [sourceThread(thread(), [])];
  native.conversationApi.seed(thread().reference);
  state.notes = [{ id: 'private-note', threadId: '123', text: 'Private source note' }];
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, reminders: [], workspace: {
    version: 1, scroll: {}, state: { ...state, view: 'inbox:old', inboxes: [{ id: 'old', name: 'Old inbox' }],
      rules: [{ id: 'exclude', name: 'Exclude all PRs', enabled: true, criteria: { kind: 'pr' }, action: { type: 'exclude' } }] },
  } });
  await page.goto('/#reference');
  await persisted(page);
  expect(native.backups.size).toBe(1);
  expect(native.state).not.toHaveProperty('rules');
  expect(native.state).not.toHaveProperty('inboxes');
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.locator('.task-title')).toHaveText('Review the relay rollout');
  await page.locator('.task-row').click();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Private source note');
  await page.getByLabel('Thread notes', { exact: true }).fill('Still private after consolidation');
  await persisted(page);
  expect(native.requests.some(request => request.op.startsWith('github.'))).toBe(false);
  expect(JSON.stringify(native.requests)).not.toContain('Private source note');
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.locator('.conversation-message').first()).toBeVisible();
  expect(native.requests.filter(request => request.op.startsWith('github.')).every(request => request.op === 'github.conversation')).toBe(true);
  await page.reload();
  await page.locator('.task-row').click();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Still private after consolidation');
  expect(native.backups.size).toBe(1);
});

test('legacy captures and Done survive migration into the ranked workspace', async ({ page, native }) => {
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, reminders: [], workspace: {
    version: 1, state: legacyFixture(true), scroll: {},
  } });
  await page.goto('/');
  await expect(page.locator('.task-title')).toHaveText('Announce, then increase');
  await page.getByRole('button', { name: /^Done/ }).click();
  await page.locator('.task-row').click();
  await expect(page.getByLabel('Task', { exact: true })).toHaveValue('My edited captured task');
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First distinct annotation');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Second distinct annotation');
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
  await persisted(page);
  expect(native.backups.size).toBe(1);
  expect(native.requests).toEqual([]);
});

test('storage and connections remain accessible without the retired workspace', async ({ page, native }) => {
  await page.goto('/');
  await persisted(page);
  native.failSave = true;
  await page.keyboard.press('Control+k');
  await page.getByLabel('What do you need to do?').fill('Do not lose this task');
  await page.getByRole('dialog').getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Pending edits are not saved');
  native.failSave = false;
  await page.getByRole('button', { name: 'Retry storage' }).click();
  await persisted(page);
  await page.reload();
  await expect(page.locator('.task-title')).toHaveText('Do not lose this task');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  expect(native.requests).toEqual([]);
  await page.getByRole('button', { name: 'Check connections' }).click();
  await expect(page.getByRole('dialog')).toContainText('GitHub connected as viewer.');
  await page.getByRole('button', { name: 'Backups & recovery' }).click();
  await expect(page.getByRole('dialog', { name: 'Recover saved work' })).toBeVisible();
  expect(native.requests.map(request => request.op)).toEqual(['connection.check']);
});
