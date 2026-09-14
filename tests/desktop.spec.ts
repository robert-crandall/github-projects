import { expect } from '@playwright/test';
import { snapshotSchema } from '../src/platform/native.ts';
import { assertMigration, at, capture, checkMigratedReader, checkRelaunchedThreadLink, detail, inbox, legacyFixture, row, tasks } from './workspace-fixtures.ts';
import { evidence, gate, persisted, refresh, test, thread } from './native-fixture.ts';
import { rawMessage } from './conversation-fixture.ts';
import { ServiceError } from '../service/src/errors.ts';

test('Waiting on me is explicitly generated, read-only, and keeps checklist state across closing', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Waiting on me', exact: true })).toBeVisible();
  expect(native.requests).toEqual([]);
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('PRIVATE note stays here');
  await capture(page, 'PRIVATE standalone task');
  await persisted(page);
  const before = structuredClone(native.state);
  const writesBefore = native.writes.length;
  const requestsBefore = native.requests.length;
  const opener = page.getByRole('button', { name: 'Waiting on me', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  await expect(dialog.getByRole('button', { name: 'Generate digest', exact: true })).toBeFocused();
  expect(native.requests).toHaveLength(requestsBefore);
  expect(await dialog.getByRole('combobox').count()).toBe(0);
  native.holdWaiting = gate();
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Generating...', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText('Reading GitHub searches');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  native.holdWaiting.release(); native.holdWaiting = undefined;
  await opener.click();
  await expect(dialog.getByRole('region', { name: 'Review requested of me', exact: true })).toContainText('octo/project#42 - @octocat, 7d');
  await expect(dialog.getByRole('region', { name: 'Team review requested - integrations/terraform-provider-core-maintainers', exact: true })).toContainText('octo/provider#43');
  await expect(dialog.getByText('Fix: changes requested / conflicts / CI failing', { exact: true })).toBeVisible();
  await expect(dialog.locator('.waiting-summary')).toContainText('Direct reviews: 1; Provider Core Maintainers team reviews: 1');
  await dialog.getByRole('checkbox', { name: 'Checked locally: octo/project#42' }).check();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.digestClipboard = text; },
    } });
  });
  await dialog.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Markdown copied.');
  const copied = await page.locator('html').getAttribute('data-digest-clipboard');
  expect(copied).toContain('- [x] octo/project#42 - Keep thread notes (@octocat, 7d)');
  expect(copied).toContain('https://github.com/octo/project/issues/45');
  expect(copied).not.toContain('PRIVATE');
  await dialog.getByRole('button', { name: 'Open octo/project#42 on GitHub', exact: true }).click();
  expect(native.launches.at(-1)).toEqual({
    command: 'launch_github', args: { identity: { source: 'github', owner: 'octo', repo: 'project', kind: 'pr', number: 42 } },
  });
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('waiting-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('waiting-narrow.png') });
  await page.keyboard.press('Escape');
  await opener.click();
  await expect(dialog.getByRole('checkbox', { name: 'Checked locally: octo/project#42' })).toBeChecked();
  expect(native.writes).toHaveLength(writesBefore);
  expect(native.state).toEqual(before);
  expect(native.requests.slice(requestsBefore).map(request => request.op)).toEqual(['github.waiting']);
  expect(native.requests.at(-1)?.input).toEqual({});
  await page.keyboard.press('Escape');
  await page.reload();
  await opener.click();
  await expect(dialog.getByRole('button', { name: 'Generate digest', exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Waiting on me digest', exact: true })).toHaveCount(0);
  expect(native.requests.slice(requestsBefore).map(request => request.op)).toEqual(['github.waiting']);
});

test('Waiting on me retains prior results on failure, reports limits and needs explicit retry', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Waiting on me', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  native.failWaiting = true;
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('No digest was produced');
  await expect(dialog.getByText('Nothing is waiting on you right now.')).toHaveCount(0);
  native.failWaiting = false;
  native.waiting.limitedQueries = ['team-review'];
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  await expect(dialog.getByText(/Search limit reached \(50 results\): Team review requested/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Checked locally: octo/project#42' }).check();
  native.failWaiting = true;
  await dialog.getByRole('button', { name: 'Regenerate digest', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The previous digest is unchanged');
  await expect(dialog.getByRole('checkbox', { name: 'Checked locally: octo/project#42' })).toBeChecked();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward('01:00:00');
  expect(native.requests.filter(request => request.op === 'github.waiting')).toHaveLength(3);
  native.failWaiting = false;
  native.waiting = { ...native.waiting, buckets: [], limitedQueries: [] };
  await dialog.getByRole('button', { name: 'Regenerate digest', exact: true }).click();
  await expect(dialog.getByText('Nothing is waiting on you right now.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  expect(native.requests.every(request => request.op === 'github.waiting')).toBe(true);
});

test('Waiting on me surfaces clipboard and launch failures and renders source titles as inert text', async ({ page, native }) => {
  native.waiting.buckets[0]!.items[0]!.title = '<img src="https://untrusted.test/pixel"> ' + 'Long source title '.repeat(25);
  await page.goto('/');
  await page.getByRole('button', { name: 'Waiting on me', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  await expect(dialog.locator('.waiting-title').first()).toContainText('<img src=');
  await expect(dialog.locator('img')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new Error('Blocked clipboard'); },
    } });
  });
  await dialog.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('clipboard is unavailable');
  native.failLaunch = true;
  await dialog.getByRole('button', { name: 'Open octo/project#42 on GitHub', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('destination app is unavailable');
  expect(native.requests.map(request => request.op)).toEqual(['github.waiting']);
  expect(native.state.operations).toEqual([]);
});

test('Waiting on me adds only checked items as persisted Tasks without replacing the draft or reader', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private note');
  await page.getByRole('button', { name: /^Capture/ }).click();
  await page.getByLabel('What do you want to remember?').fill('Unfinished capture');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await persisted(page);
  const before = structuredClone(native.state);
  await page.getByRole('button', { name: 'Waiting on me', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  const add = dialog.getByRole('button', { name: /^Add checked items to Tasks/ });
  await expect(add).toBeDisabled();
  const requests = native.requests.length;
  for (const number of [42, 44, 45]) await dialog.getByRole('checkbox', { name: `Checked locally: octo/project#${number}` }).check();
  await expect(add).toHaveText('Add checked items to Tasks (3)');
  await add.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('waiting-task-capture-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await add.scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('waiting-task-capture-narrow.png') });
  await add.evaluate(button => {
    if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the task capture button.');
    button.click(); button.click();
  });
  await expect(add).toBeDisabled();
  await expect(dialog.locator('.waiting-task-status')).toContainText('3 tasks added here. Saved locally.');
  expect(native.state.tasks).toHaveLength(before.tasks.length + 3);
  const added = native.state.tasks.slice(-3);
  expect(added.map(task => ({ title: task.title, notes: task.notes, status: task.status }))).toEqual([
    { title: 'Keep thread notes', notes: 'I need to review.\nhttps://github.com/octo/project/pull/42', status: 'open' },
    { title: 'Load older comments', notes: 'I need to fix the listed blockers.\nFix: changes requested / conflicts / CI failing\nhttps://github.com/octo/project/pull/44', status: 'open' },
    { title: 'Improve keyboard navigation', notes: 'My task.\nhttps://github.com/octo/project/issues/45', status: 'open' },
  ]);
  expect(added.every(task => task.threadId === undefined)).toBe(true);
  expect(native.state.tasks.slice(0, before.tasks.length)).toEqual(before.tasks);
  expect(native.state.draft).toBe('Unfinished capture');
  expect(native.state.selectedKey).toBe(before.selectedKey);
  expect(native.state.view).toBe(before.view);
  expect(native.state.threads).toEqual(before.threads);
  expect(native.state.notes).toEqual(before.notes);
  expect(native.state.operations).toEqual(before.operations);
  expect(native.requests).toHaveLength(requests);
  expect(native.launches).toEqual([]);
  await dialog.getByRole('button', { name: 'Open Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await row(page, `a:${added[0]!.id}`).click();
  await expect(page.getByLabel('Task notes', { exact: true })).toHaveValue(added[0]!.notes);
  await persisted(page);
  await page.reload();
  await expect(page.getByLabel('Task notes', { exact: true })).toHaveValue(added[0]!.notes);
  expect(native.state.tasks.slice(-3)).toEqual(added);
  expect(native.requests).toHaveLength(requests);
});

test('Waiting on me keeps pending Tasks on save failure and retries storage without creating duplicates', async ({ page, native }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Waiting on me', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  await dialog.getByRole('button', { name: 'Generate digest', exact: true }).click();
  await persisted(page);
  const before = structuredClone(native.state.tasks);
  await dialog.getByRole('checkbox', { name: 'Checked locally: octo/project#42' }).check();
  native.failSave = true;
  await dialog.getByRole('button', { name: /^Add checked items to Tasks/ }).click();
  await expect(dialog.locator('.waiting-task-status')).toContainText('1 task added here. Not saved yet.');
  await expect(dialog.locator('.waiting-task-status').getByRole('alert')).toContainText('Disk unavailable');
  await expect(dialog.getByRole('button', { name: /^Add checked items to Tasks/ })).toBeDisabled();
  expect(native.state.tasks).toEqual(before);
  native.failSave = false;
  await dialog.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await expect(dialog.locator('.waiting-task-status')).toContainText('1 task added here. Saved locally.');
  expect(native.state.tasks).toHaveLength(before.length + 1);
  expect(native.requests.map(request => request.op)).toEqual(['github.waiting']);
  expect(native.state.operations).toEqual([]);
});

test('filter rules preview literal matches, persist ordered CRUD and named inboxes without network or task changes', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('PRIVATE filtering note');
  await capture(page, 'Requested review 123');
  await inbox(page).click();
  await row(page, 't:123').click();
  await persisted(page);
  const tasksBefore = structuredClone(native.state.tasks);
  const requestsBefore = native.requests.length;
  const rulesButton = page.getByRole('button', { name: 'Filtering rules', exact: true });
  await rulesButton.click();
  const dialog = page.getByRole('dialog', { name: 'Filtering rules' });
  await dialog.getByText('Manage named inboxes', { exact: true }).click();
  await dialog.getByLabel('Inbox name', { exact: true }).fill('Inbox');
  await dialog.getByRole('button', { name: 'Create inbox' }).click();
  await expect(dialog.getByRole('alert')).toContainText('unique');
  await dialog.getByLabel('Inbox name', { exact: true }).fill('Work');
  await dialog.getByRole('button', { name: 'Create inbox' }).click();
  await expect.poll(() => native.state.inboxes.length).toBe(1);
  await dialog.getByRole('button', { name: 'New rule', exact: true }).click();
  await dialog.getByLabel('Rule name', { exact: true }).fill('PR work');
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await expect(dialog.getByRole('alert')).toContainText('at least one criterion');
  await dialog.getByLabel('Repository', { exact: false }).fill('invalid');
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await expect(dialog.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  await dialog.getByLabel('Repository', { exact: false }).fill('OCTO/project');
  await dialog.getByRole('combobox', { name: 'Thread type', exact: true }).selectOption('pr');
  await dialog.getByLabel('Title contains', { exact: false }).fill(' requested REVIEW ');
  await dialog.getByRole('combobox', { name: 'Action', exact: true }).selectOption({ label: 'Route to Work' });
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await expect(dialog.getByRole('region', { name: 'Rule preview' })).toContainText('1 matching thread');
  await expect(dialog.getByRole('region', { name: 'Rule preview' })).toContainText('Effective location: Work');
  expect(native.state.rules).toEqual([]);
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await expect.poll(() => native.state.rules.length).toBe(1);
  await dialog.getByRole('button', { name: 'New rule', exact: true }).click();
  await dialog.getByLabel('Rule name', { exact: true }).fill('Exclude reviews');
  await dialog.getByRole('combobox', { name: 'Thread type', exact: true }).selectOption('pr');
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await expect(dialog.getByRole('region', { name: 'Rule preview' })).toContainText('Enabled matches in order: PR work, Exclude reviews');
  await expect(dialog.getByRole('region', { name: 'Rule preview' })).toContainText('Effective location: Work');
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await dialog.getByRole('button', { name: 'Move Exclude reviews up' }).click();
  await dialog.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(page.getByLabel('Thread location')).toContainText('Filtered');
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('PRIVATE filtering note');
  await page.getByRole('navigation').getByRole('button', { name: /^Filtered/ }).click();
  await expect(row(page, 't:123')).toBeVisible();
  await rulesButton.click();
  await dialog.getByLabel('Enable Exclude reviews', { exact: true }).uncheck();
  await dialog.getByText('Manage named inboxes', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete inbox Work', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Edit or delete rules');
  await dialog.getByRole('button', { name: 'Rename Work', exact: true }).click();
  await dialog.getByLabel('Inbox name', { exact: true }).fill('Engineering');
  await dialog.getByRole('button', { name: 'Save inbox name' }).click();
  await dialog.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('navigation').getByRole('button', { name: /^Engineering/ }).click();
  await expect(page.getByRole('heading', { name: 'Engineering', exact: true })).toBeVisible();
  await row(page, 't:123').click();
  await persisted(page);
  await page.reload();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('PRIVATE filtering note');
  await expect(page.getByRole('navigation').getByRole('button', { name: /^Engineering/ })).toHaveAttribute('aria-current', 'page');
  await rulesButton.click();
  await dialog.getByRole('button', { name: 'Edit PR work', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await page.screenshot({ path: testInfo.outputPath('rules-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('rules-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(rulesButton).toBeFocused();
  expect(await page.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
  await rulesButton.click();
  await dialog.getByRole('button', { name: 'Delete rule PR work', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete rule Exclude reviews', exact: true }).click();
  await dialog.getByText('Manage named inboxes', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete inbox Engineering', exact: true }).click();
  await dialog.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Back to list', exact: true }).click();
  await expect(row(page, 't:123')).toBeVisible();
  await persisted(page);
  expect(native.state.rules).toEqual([]);
  expect(native.state.inboxes).toEqual([]);
  expect(native.state.tasks).toEqual(tasksBefore);
  expect(native.requests).toHaveLength(requestsBefore);
  expect(native.state.operations).toEqual([]);
});

test('terminal suppression stays reachable, preserves reader position and notes, and fails open on unknown state', async ({ page, native }) => {
  native.conversationApi.seed(native.threads[0]!.reference);
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('Newest comment', { exact: true })).toBeVisible();
  await page.getByLabel('Thread notes', { exact: true }).fill('Terminal note survives');
  const note = page.getByLabel('Thread notes', { exact: true });
  let hour = 18;
  async function stateRefresh(state: 'queued' | 'merged' | 'closed' | 'open' | 'unknown', fresh = false) {
    const now = `2026-09-11T${hour++}:00:00Z`;
    native.now = now;
    await page.clock.setFixedTime(new Date(now));
    native.threads[0]!.sourceState = { state, observedAt: now, updatedAt: now,
      error: state === 'unknown' ? { code: 'access', message: 'Current merge queue could not be read. Terminal suppression is off.', retryable: false } : null };
    if (fresh) {
      native.threads[0]!.updatedAt = now;
      native.threads[0]!.evidence.push({ ...evidence(`fresh-${hour}`, 'comment'), at: now });
    }
    await refresh(page);
  }
  await stateRefresh('queued');
  await expect(row(page, 't:123')).toHaveCount(0);
  await expect(page.getByLabel('Thread location')).toContainText("Currently in GitHub's merge queue");
  await expect(note).toHaveValue('Terminal note survives');
  await page.getByRole('navigation').getByRole('button', { name: /^Filtered/ }).click();
  await row(page, 't:123').click();
  await note.focus();
  const offset = await detail(page).evaluate(element => element.scrollTop);
  native.holdRefresh = gate();
  const now = '2026-09-11T19:00:00Z';
  native.now = now;
  await page.clock.setFixedTime(new Date(now));
  native.threads[0]!.sourceState.observedAt = now;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await note.focus();
  native.holdRefresh.release(); native.holdRefresh = undefined;
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(note).toBeFocused();
  expect(Math.abs(await detail(page).evaluate(element => element.scrollTop) - offset)).toBeLessThan(3);
  hour = 20;
  await stateRefresh('queued', true);
  await expect(row(page, 't:123')).toBeVisible();
  await page.reload();
  await expect(row(page, 't:123')).toBeVisible();
  await expect(note).toHaveValue('Terminal note survives');
  await stateRefresh('open');
  await expect(row(page, 't:123')).toBeVisible();
  await expect(page.getByLabel('Thread location')).toContainText('No new activity');
  await stateRefresh('unknown', true);
  await expect(row(page, 't:123')).toHaveCount(0);
  await expect(page.getByLabel('Thread location')).toContainText('Terminal suppression is off');
  await inbox(page).click();
  await row(page, 't:123').click();
  await stateRefresh('open');
  await expect(row(page, 't:123')).toBeVisible();
  const requests = native.requests.length;
  await page.reload();
  await expect(note).toHaveValue('Terminal note survives');
  expect(native.requests).toHaveLength(requests);
  expect(native.requests.every(request => request.op === 'github.refresh' || request.op === 'github.conversation')).toBe(true);
  expect(native.state.operations).toEqual([]);
});

test('rule preview shows manual Archive and terminal precedence and requires preview after changes', async ({ page, native }) => {
  native.threads = [thread(), thread([evidence()], '124')];
  native.threads[1]!.sourceState.state = 'merged';
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Archive thread' }).click();
  await expect.poll(() => native.state.operations[0]?.status).toBe('confirmed');
  await page.getByRole('button', { name: 'Filtering rules', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'New rule', exact: true }).click();
  await dialog.getByLabel('Rule name').fill('All PRs');
  await dialog.getByLabel('Thread type').selectOption('pr');
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  const preview = dialog.getByRole('region', { name: 'Rule preview' });
  await expect(preview).toContainText('Effective location: Archive');
  await expect(preview).toContainText('Effective location: Filtered');
  await expect(preview).toContainText('Merged PR');
  await dialog.getByLabel('Title contains').fill('123');
  await expect(dialog.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  await expect(dialog.getByRole('status')).toContainText('Preview again');
  await dialog.getByRole('button', { name: 'Preview matches' }).click();
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await dialog.getByRole('button', { name: 'Delete rule All PRs' }).click();
  await dialog.getByRole('button', { name: 'Back to workspace' }).click();
  expect(native.state.threads[0]!.archive).not.toBeNull();
  expect(native.requests.filter(request => request.op === 'github.acknowledge')).toHaveLength(1);
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(0);
});

test('Archive retains notes across identical refresh, old conversation pages, real new activity and relaunch', async ({ page, native }, testInfo) => {
  native.conversationApi.seed(native.threads[0]!.reference);
  await page.goto('/');
  await refresh(page);
  await capture(page, 'Completed independent capture');
  await page.getByRole('checkbox', { name: 'Done', exact: true }).check();
  await inbox(page).click();
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('Newest comment', { exact: true })).toBeVisible();
  const note = page.getByLabel('Thread notes', { exact: true });
  await note.fill('PRIVATE archive context');
  await persisted(page);
  const tasksBefore = structuredClone(native.state.tasks);
  await page.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await expect.poll(() => native.state.operations[0]?.status).toBe('confirmed');
  await expect(row(page, 't:123')).toHaveCount(0);
  await expect(note).toHaveValue('PRIVATE archive context');
  expect(native.state.tasks).toEqual(tasksBefore);
  const archive = page.getByRole('navigation', { name: 'Inboxes' }).getByRole('button', { name: /^Archive/ });
  await archive.click();
  await row(page, 't:123').click();
  await refresh(page);
  await expect(row(page, 't:123')).toBeVisible();
  await page.locator('.conversation-pages > summary').click();
  await page.getByRole('button', { name: 'Load older comments', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reload comments page 2', exact: true })).toBeVisible();
  await expect(row(page, 't:123')).toBeVisible();
  await note.fill('PRIVATE archive context, edited offline');
  await note.focus();
  const position = await detail(page).evaluate(element => element.scrollTop);
  const notesBefore = structuredClone(native.state.notes);
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await note.focus();
  native.threads[0]!.notification = 'read';
  native.threads[0]!.reason = 'review_requested';
  native.threads[0]!.subscription = 'unknown';
  native.holdRefresh.release();
  native.holdRefresh = undefined;
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(note).toBeFocused();
  expect(Math.abs(await detail(page).evaluate(element => element.scrollTop) - position)).toBeLessThan(3);
  await expect(row(page, 't:123')).toBeVisible();
  await page.getByRole('button', { name: 'Restore to Inbox', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('archive-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await detail(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('archive-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const newAt = '2026-09-11T17:01:00Z';
  native.threads[0] = { ...native.threads[0]!, updatedAt: newAt, notification: 'unread',
    evidence: [...native.threads[0]!.evidence, { ...evidence('fresh-mention', 'mention'), at: newAt }] };
  await refresh(page);
  await expect(row(page, 't:123')).toHaveCount(0);
  await expect(note).toHaveValue('PRIVATE archive context, edited offline');
  expect(native.state.notes).toEqual(notesBefore);
  expect(native.state.tasks).toEqual(tasksBefore);
  expect(native.state.threads).toHaveLength(1);
  expect(native.state.handled).not.toContain('fresh-mention');
  await inbox(page).click();
  await row(page, 't:123').click();
  await persisted(page);
  const requests = native.requests.length;
  await page.reload();
  await expect(note).toHaveValue('PRIVATE archive context, edited offline');
  await expect(row(page, 't:123')).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  expect(native.requests).toHaveLength(requests);
  expect(JSON.stringify(native.requests)).not.toContain('PRIVATE');
});

test('offline Archive and interrupted acknowledgement retain local placement, explicit retry and local-only Restore', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Interrupted archive note');
  native.failWrite = true;
  await page.getByRole('button', { name: 'Archive thread', exact: true }).click();
  await expect.poll(() => native.state.operations[0]?.status).toBe('failed');
  await expect(row(page, 't:123')).toHaveCount(0);
  const original = structuredClone(native.state.operations[0]!);
  await page.reload();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Interrupted archive note');
  expect(native.requests.filter(request => request.op === 'github.acknowledge')).toHaveLength(1);
  native.failWrite = false;
  native.holdWrite = gate();
  await page.getByRole('button', { name: 'Retry GitHub operation', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect.poll(() => native.requests.filter(request => request.op === 'github.acknowledge').length).toBe(2);
  await page.getByRole('button', { name: 'Close; request continues' }).click();
  await expect(detail(page)).toContainText('pending');
  await page.reload();
  await expect(detail(page)).toContainText('uncertain');
  expect(native.state.operations[0]!.id).toBe(original.id);
  expect(native.state.threads[0]!.archive).not.toBeNull();
  native.holdWrite.release();
  native.holdWrite = undefined;
  await page.getByRole('button', { name: 'Retry GitHub operation', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  const writes = native.requests.filter(request => request.op === 'github.acknowledge');
  expect(writes).toHaveLength(3);
  expect(writes.every(request => request.input.operationId === original.id && request.input.notificationUpdatedAt === original.notificationUpdatedAt)).toBe(true);
  const count = native.requests.length;
  await page.getByRole('button', { name: 'Restore to Inbox' }).click();
  await expect(row(page, 't:123')).toBeVisible();
  expect(native.state.threads[0]!.notification).toBe('done');
  expect(native.requests).toHaveLength(count);
  await page.reload();
  await expect(row(page, 't:123')).toBeVisible();
});

test('unsubscribe remains distinct and a later mention returns an archived thread without reopening Tasks', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Subscription context');
  await page.getByRole('button', { name: 'Unsubscribe on GitHub' }).click();
  await expect(page.getByRole('dialog')).toContainText('Mentions and new review requests may still notify');
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  await expect(row(page, 't:123')).toBeVisible();
  await page.getByRole('button', { name: 'Archive thread' }).click();
  await expect.poll(() => native.state.operations.at(-1)?.status).toBe('confirmed');
  native.threads[0]!.subscription = 'unsubscribed';
  await refresh(page);
  await expect(row(page, 't:123')).toHaveCount(0);
  const newAt = '2026-09-11T17:01:00Z';
  native.threads[0]!.updatedAt = newAt;
  native.threads[0]!.evidence.push({ ...evidence('mention-after-unsubscribe', 'mention'), at: newAt });
  await refresh(page);
  await expect(row(page, 't:123')).toBeVisible();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Subscription context');
  expect(native.state.threads[0]!.subscription).toBe('unsubscribed');
  expect(native.state.tasks).toEqual([]);
});

for (const kind of ['issue', 'pr'] as const) {
  test(`conversation gaps remain reachable after ${kind} newest-page jumps and failed gap loads`, async ({ page, native }, testInfo) => {
    const reference = { repo: 'octo/project', number: 123, kind };
    native.threads[0]!.reference = reference;
    native.conversationApi.seed(reference);
    const path = '/repos/octo/project/issues/123/comments';
    const comments = (start: number, count: number) => Array.from({ length: count }, (_, index) => rawMessage(reference, start + index, `Comment ${start + index}`));
    native.conversationApi.routes.set(`${path}?per_page=5&page=1`, { status: 200, headers: {}, body: comments(1, 5) });
    await page.goto('/');
    await refresh(page);
    await row(page, 't:123').click();
    await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
    const reader = page.getByRole('region', { name: 'Conversation', exact: true });
    await expect(reader.getByText('Comment 5', { exact: true })).toBeVisible();
    const newest = (last: number) => {
      native.conversationApi.routes.set(`${path}?per_page=5&page=1`, { status: 200, body: comments(1, 5),
        headers: { link: `<https://api.github.com${path}?per_page=5&page=${last}>; rel="last"` } });
      native.conversationApi.routes.set(`${path}?per_page=5&page=${last}`, { status: 200, headers: {}, body: comments((last - 1) * 5 + 1, 1) });
    };
    newest(3);
    await reader.getByRole('button', { name: 'Reload newest messages', exact: true }).click();
    await expect(reader.getByText('Comment 11', { exact: true })).toBeVisible();
    await reader.locator('.conversation-pages > summary').click();
    const pages = reader.getByRole('region', { name: 'Comments pages', exact: true });
    await expect(pages.getByRole('button', { name: 'Load missing comments page 2', exact: true })).toBeEnabled();
    await expect(pages).not.toContainText('All known pages are saved');
    await pages.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('gap-desktop.png') });
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await pages.getByRole('button', { name: 'Load missing comments page 2', exact: true }).scrollIntoViewIfNeeded();
    expect(await detail(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('gap-narrow.png') });
    if (viewport) await page.setViewportSize(viewport);
    if (kind === 'pr') {
      await expect(reader.getByRole('region', { name: 'Reviews pages', exact: true }).getByRole('button', { name: /Load missing/ })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Load older inline discussions', exact: true })).toBeEnabled();
    }
    const streamsBefore = native.requests.filter(request => request.op === 'github.conversation' && request.input.stream !== 'comments').length;
    const callsBefore = native.conversationApi.calls.length;
    const sourceBefore = structuredClone(native.state.threads);
    native.conversationApi.routes.set(`${path}?per_page=5&page=2`, new ServiceError('rate_limit', true));
    await pages.getByRole('button', { name: 'Load missing comments page 2', exact: true }).click();
    await expect(pages).toContainText('partial / unavailable');
    const retry = pages.getByRole('button', { name: 'Reload comments page 2', exact: true });
    await expect(retry).toBeEnabled();
    native.conversationApi.routes.set(`${path}?per_page=5&page=2`, {
      status: 200, headers: {}, body: [...comments(6, 4), { id: 10, body: 'Malformed' }],
    });
    await retry.click();
    await expect(reader.getByText('Comment 6', { exact: true })).toBeVisible();
    await expect(pages).toContainText('partial / unavailable');
    native.conversationApi.routes.set(`${path}?per_page=5&page=2`, { status: 200, headers: {}, body: comments(6, 5) });
    await retry.click();
    await expect(reader.getByText('Comment 10', { exact: true })).toBeVisible();
    await expect(reader.getByText('Comment 6', { exact: true })).toHaveCount(1);
    await expect(pages).toContainText('All known pages are saved');
    expect(native.requests.filter(request => request.op === 'github.conversation' && request.input.stream !== 'comments')).toHaveLength(streamsBefore);
    expect(native.conversationApi.calls.slice(callsBefore)).toEqual(Array(3).fill(`${path}?per_page=5&page=2`));
    expect(native.state.threads).toEqual(sourceBefore);
    newest(5);
    await reader.getByRole('button', { name: 'Reload newest messages', exact: true }).click();
    await expect(pages.getByRole('button', { name: 'Load missing comments page 4', exact: true })).toBeEnabled();
    native.conversationApi.routes.set(`${path}?per_page=5&page=4`, { status: 200, headers: {}, body: comments(16, 5) });
    await pages.getByRole('button', { name: 'Load missing comments page 4', exact: true }).click();
    await expect(reader.getByText('Comment 20', { exact: true })).toBeVisible();
    await expect(pages).toContainText('All known pages are saved');
  });
}

test('cache discard during navigation releases reader controls and ignores the old native read', async ({ page, native }) => {
  native.threads.push(thread([evidence('second')], '456'));
  for (const source of native.threads) native.conversationApi.seed(source.reference);
  await page.goto('/');
  await refresh(page);
  await row(page, 't:456').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('END OF LONG MESSAGE', { exact: false })).toBeVisible();
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('END OF LONG MESSAGE', { exact: false })).toBeVisible();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private note during discard');
  await persisted(page);
  const notes = structuredClone(native.state.notes);
  const tasksBefore = structuredClone(native.state.tasks);
  const requests = native.requests.length;
  native.holdConversationReset = gate();
  await page.getByRole('button', { name: 'Discard conversation cache', exact: true }).click();
  await page.getByRole('button', { name: 'Discard cached conversations', exact: true }).click();
  native.holdConversationRead = gate();
  await row(page, 't:456').click();
  await expect(page.getByText('Reading cached conversation...', { exact: true })).toBeVisible();
  native.holdConversationReset.release();
  await expect(page.getByRole('button', { name: 'Load conversation', exact: true })).toBeEnabled();
  native.holdConversationRead.release();
  native.holdConversationRead = undefined;
  await expect(page.getByText('Reading cached conversation...', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).not.toContainText('END OF LONG MESSAGE');
  expect(native.requests).toHaveLength(requests);
  expect(native.state.notes).toEqual(notes);
  expect(native.state.tasks).toEqual(tasksBefore);
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('END OF LONG MESSAGE', { exact: false })).toBeVisible();
});

for (const kind of ['issue', 'pr'] as const) {
  test(`conversation reader loads actual ${kind} bodies through service and typed IPC only on explicit request`, async ({ page, native }) => {
    const reference = { repo: 'octo/project', number: 123, kind };
    native.threads[0]!.reference = reference;
    native.conversationApi.seed(reference);
    await page.goto('/');
    await refresh(page);
    await row(page, 't:123').click();
    const reader = page.getByRole('region', { name: 'Conversation', exact: true });
    await expect(reader.getByRole('button', { name: 'Load conversation', exact: true })).toBeEnabled();
    expect(native.conversationApi.calls).toEqual([]);
    await reader.getByRole('button', { name: 'Load conversation', exact: true }).click();
    await expect(reader.getByText('END OF LONG MESSAGE', { exact: false })).toBeVisible();
    expect((await reader.locator('.conversation-message').first().locator('.message-markdown').textContent())?.match(/Readable source content/g)).toHaveLength(100);
    if (kind === 'pr') {
      await expect(reader.getByText('Review body with', { exact: false })).toBeVisible();
      expect(await reader.getByText('Earlier discussion context is not cached.', { exact: false }).count()).toBe(2);
      await reader.locator('.conversation-pages > summary').click();
      await reader.getByRole('button', { name: 'Load older inline discussions', exact: true }).click();
      await expect(reader.getByText('Opening discussion A', { exact: true })).toBeVisible();
      const discussion = reader.getByRole('region', { name: 'Inline discussion' }).filter({ hasText: 'Opening discussion A' });
      await expect(discussion).toContainText('Reply in A');
      await expect(discussion).toContainText('Second reply in A');
      await expect(discussion).not.toContainText('Reply in B');
    }
    const before = native.requests.length;
    await page.reload();
    await expect(reader).toContainText('END OF LONG MESSAGE');
    expect(native.requests).toHaveLength(before);
    expect(native.writes.every(write => !JSON.stringify(write).includes('END OF LONG MESSAGE'))).toBe(true);
    expect(native.state.tasks).toEqual([]);
  });
}

test('conversation Markdown never executes HTML, unsafe URLs or external embeds; validated links dispatch explicitly', async ({ page, native }) => {
  const reference = native.threads[0]!.reference;
  native.conversationApi.seed(reference);
  const body = [
    '# Safe heading', '**Bold** and `code`.', '[source](https://github.com/octo/project/issues/99)',
    '[bad](javascript:alert%281%29)', '[data](data:text/html,boom)', '[file](file:///etc/passwd)',
    '![tracking](https://attacker.invalid/pixel.png)', '<img src="https://attacker.invalid/html.png" onerror="alert(1)">',
    '<script>window.__executed = true</script>', '| A | B |\n| - | - |\n| one | two |',
  ].join('\n\n');
  native.conversationApi.routes.set('/repos/octo/project/pulls/123', { status: 200, headers: {}, body: rawMessage(reference, 1, body) });
  const outbound: string[] = [];
  await page.route('https://**/*', route => { outbound.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  const reader = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(reader.getByRole('heading', { name: 'Safe heading' })).toBeVisible();
  expect(await reader.locator('img, iframe, script, video, audio, object, embed').count()).toBe(0);
  expect(await reader.locator('a[href^="javascript:"], a[href^="data:"], a[href^="file:"]').count()).toBe(0);
  await expect(reader).toContainText('Raw HTML is not rendered');
  await expect(reader.locator('table')).toContainText('one');
  await reader.getByRole('link', { name: 'source', exact: true }).click();
  expect(native.launches.at(-1)).toEqual({ command: 'launch_web_url', args: { url: 'https://github.com/octo/project/issues/99' } });
  expect(outbound).toEqual([]);
});

test('reader preserves message anchor when old history arrives and restores per-source position without implicit network', async ({ page, native }) => {
  native.threads.push(thread([evidence('second')], '456'));
  native.conversationApi.seed(native.threads[0]!.reference);
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByText('Newest comment', { exact: true })).toBeVisible();
  await page.locator('.conversation-pages > summary').click();
  const pending = gate();
  native.conversationApi.hold = pending.promise;
  await page.getByRole('button', { name: 'Load older comments', exact: true }).click();
  const anchor = page.locator('[data-reader-anchor$="comments:11"]');
  await anchor.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const before = await anchor.evaluate(element => element.getBoundingClientRect().top);
  pending.release();
  native.conversationApi.hold = undefined;
  await expect(page.getByRole('button', { name: 'Reload newest messages', exact: true })).toBeEnabled();
  expect(Math.abs((await anchor.evaluate(element => element.getBoundingClientRect().top)) - before)).toBeLessThan(3);
  const offset = await detail(page).evaluate(element => element.scrollTop);
  await persisted(page);
  const calls = native.requests.length;
  await row(page, 't:456').click();
  await expect(page.getByRole('button', { name: 'Load conversation', exact: true })).toBeEnabled();
  await row(page, 't:123').click();
  await expect(page.getByText('Newest comment', { exact: true })).toBeVisible();
  expect(Math.abs((await detail(page).evaluate(element => element.scrollTop)) - offset)).toBeLessThan(3);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  expect(native.requests).toHaveLength(calls);
});

test('stale conversation results after switching sources are ignored; partial/offline cache and recovery preserve notes', async ({ page, native }) => {
  native.threads.push(thread([evidence('second')], '456'));
  native.conversationApi.seed(native.threads[0]!.reference);
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('PRIVATE preserved note');
  await persisted(page);
  const pending = gate();
  native.conversationApi.hold = pending.promise;
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await row(page, 't:456').click();
  pending.release();
  native.conversationApi.hold = undefined;
  await expect(page.getByRole('button', { name: 'Load conversation', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).not.toContainText('END OF LONG MESSAGE');
  await row(page, 't:123').click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('END OF LONG MESSAGE');
  native.conversationApi.failure = new ServiceError('rate_limit', true);
  await page.getByRole('button', { name: 'Reload newest messages', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('Some pages are partial or unavailable');
  const calls = native.requests.length;
  await page.reload();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('END OF LONG MESSAGE');
  expect(native.requests).toHaveLength(calls);
  native.corruptCache = true;
  await page.reload();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText('cache is corrupt');
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('PRIVATE preserved note');
  await page.getByRole('button', { name: 'Discard conversation cache', exact: true }).click();
  await page.getByRole('button', { name: 'Discard cached conversations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load conversation', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('PRIVATE preserved note');
  expect(native.requests).toHaveLength(calls);
  expect(JSON.stringify(native.requests)).not.toContain('PRIVATE');
});

test('conversation reader at desktop and narrow sizes wraps Markdown without fetching embeds', async ({ page, native }, testInfo) => {
  const reference = native.threads[0]!.reference;
  native.threads[0]!.title = 'Keep review conversations readable offline';
  native.conversationApi.seed(reference);
  native.conversationApi.routes.set('/repos/octo/project/pulls/123', {
    status: 200, headers: {}, body: rawMessage(reference, 1, [
      '## What changed', 'Read the whole conversation without leaving the thread. Keep comments and their replies together.',
      '> This sample demonstrates the reader layout. No live source data is used.',
      '### Notes from the review', '- Keep older replies with their discussion.\n- Preserve private notes while refreshing.\n- Make partial pages explicit.',
      '```ts\nconst source = { repository: "octo/project", kind: "pr", number: 123 };\n```',
      '[Source context](https://github.com/octo/project/pull/123)',
    ].join('\n\n')),
  });
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByRole('button', { name: 'Load conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reader-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Back to list', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await detail(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reader-narrow.png') });
});

test('empty native load waits for SQLite and capture, notes and Done persist without demo or startup requests', async ({ page, native }) => {
  native.holdRead = gate();
  await page.goto('/');
  await expect(page.getByText('Reading saved work...')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  expect(native.calls).not.toContain('workspace_save');
  expect(native.requests).toEqual([]);
  native.holdRead.release();
  await expect(page.getByText('No threads in this saved inbox')).toBeVisible();
  await persisted(page);
  expect(native.state.tasks).toEqual([]);
  expect(native.state.threads).toEqual([]);
  expect(native.state.notes).toEqual([]);
  await expect(page.getByRole('button', { name: /Demo scenarios|Working on|Routines|Triage|Interpret/ })).toHaveCount(0);
  await capture(page, 'Persistent desktop task');
  await page.getByLabel('Task notes').fill('Private note survives relaunch');
  await page.getByRole('checkbox', { name: 'Done', exact: true }).check();
  await persisted(page);
  const before = structuredClone(native.state.tasks);
  expect(before).toEqual([{ id: native.state.selectedKey!.slice(2), title: 'Persistent desktop task',
    notes: 'Private note survives relaunch', status: 'done', createdAt: at, completedAt: at }]);
  await page.reload();
  await expect(page.getByLabel('Task notes')).toHaveValue('Private note survives relaunch');
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  expect(native.state.tasks).toEqual(before);
  expect(native.requests).toEqual([]);
  expect(native.saved.snapshot?.reminders).toEqual([]);
});

test('selecting threads and typing the first character keeps focus and never creates Tasks', async ({ page, native }) => {
  native.threads.push(thread([evidence('request-2')], '456'));
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await persisted(page);
  expect(native.state.tasks).toEqual([]);
  const notes = page.getByLabel('Thread notes', { exact: true });
  await notes.focus();
  await page.keyboard.type('F');
  await expect(notes).toBeFocused();
  await page.keyboard.type('irst annotation');
  await expect(notes).toHaveValue('First annotation');
  await detail(page).getByRole('button', { name: 'Add note' }).click();
  await page.getByLabel('Thread note 2').fill('Second annotation');
  await notes.fill('First independently edited');
  await page.getByLabel('Thread note 2').fill('Second independently edited');
  await row(page, 't:456').click();
  await expect(notes).toHaveValue('');
  await row(page, 't:123').click();
  await persisted(page);
  expect(native.state.tasks).toEqual([]);
  expect(native.state.notes.map(note => ({ threadId: note.threadId, text: note.text }))).toEqual([
    { threadId: '123', text: 'First independently edited' }, { threadId: '123', text: 'Second independently edited' },
  ]);
  await tasks(page).click();
  await expect(page.getByText('No open tasks')).toBeVisible();
  await inbox(page).click();
  await row(page, 't:123').click();
  await persisted(page);
  await page.reload();
  await expect(notes).toHaveValue('First independently edited');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Second independently edited');
  expect(native.requests.map(request => request.op)).toEqual(['github.refresh']);
});

for (const view of ['Inbox', 'Tasks'] as const) {
  test(`capture from ${view} saves exact URL and daily text as standalone Tasks without interpretation`, async ({ page, native }) => {
    await page.goto('/');
    await persisted(page);
    if (view === 'Tasks') await tasks(page).click();
    const text = `  https://github.com/octo/project/pull/123\nEvery day at 10am, announce, then increase — from ${view}  `;
    await capture(page, text);
    await persisted(page);
    expect(native.state.tasks).toEqual([{ id: native.state.selectedKey!.slice(2), title: text, notes: '', status: 'open', createdAt: at }]);
    expect(native.state.threads).toEqual([]);
    expect(native.state.notes).toEqual([]);
    expect(native.state.draft).toBe('');
    expect(native.requests).toEqual([]);
    expect(native.launches).toEqual([]);
    const captured = structuredClone(native.state.tasks);
    await page.reload();
    await expect(detail(page).getByRole('heading')).toHaveText(text);
    expect(native.state.tasks).toEqual(captured);
    expect(native.saved.snapshot?.reminders).toEqual([]);
  });
}

test('in-flight Refresh preserves newer task text, notes, Done and selection without reopening on new evidence', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private thread context');
  await capture(page, 'Task before refresh');
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refreshing...' })).toBeDisabled();
  await detail(page).getByRole('button', { name: 'Edit text' }).click();
  await page.getByRole('textbox', { name: 'Task text', exact: true }).fill('Edited during refresh\nKeep exact text');
  await page.getByRole('button', { name: 'Save text' }).click();
  await page.getByLabel('Task notes').fill('Typed while refreshing');
  await expect(page.getByLabel('Task notes')).toBeFocused();
  await page.getByRole('checkbox', { name: 'Done', exact: true }).check();
  await persisted(page);
  const before = structuredClone(native.state);
  native.threads = [thread([evidence(), evidence('queue', 'merge-queue')])];
  native.threads[0]!.sourceState.state = 'queued';
  native.holdRefresh.release();
  native.holdRefresh = undefined;
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await persisted(page);
  expect(native.state.tasks).toEqual(before.tasks);
  expect(native.state.notes).toEqual(before.notes);
  expect(native.state.selectedKey).toBe(before.selectedKey);
  expect(native.state.threads[0]?.state).toBe('queued');
  for (const event of [evidence('comment', 'comment'), evidence('new-request'), evidence('source-closed', 'closed')]) {
    native.threads = [thread([evidence(), event])];
    native.threads[0]!.sourceState.state = event.kind === 'closed' ? 'closed' : 'open';
    await refresh(page);
    expect(native.state.tasks).toEqual(before.tasks);
    expect(native.state.notes).toEqual(before.notes);
    expect(native.state.selectedKey).toBe(before.selectedKey);
  }
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await expect(page.getByLabel('Task notes')).toHaveValue('Typed while refreshing');
  await expect(detail(page).getByRole('heading')).toHaveText('Edited during refresh\nKeep exact text');
});

test('serialized saves keep the newest note while Refresh appends evidence and never show premature saved feedback', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Original saved note');
  await persisted(page);
  const original = structuredClone(native.state);
  native.holdSave = gate();
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByLabel('Thread notes', { exact: true }).fill('First pending note');
  await expect(page.locator('.workspace-footer')).toContainText('Saving...');
  await expect(detail(page)).toContainText('Not saved yet');
  await page.getByLabel('Thread notes', { exact: true }).fill('Latest note typed during save');
  expect(native.state.notes).toEqual(original.notes);
  native.threads.push(thread([evidence('second-request')], '456'));
  native.holdRefresh.release();
  native.holdRefresh = undefined;
  await expect(page.locator('.new-updates')).toContainText('Requested review 456');
  await expect(page.getByLabel('Thread notes', { exact: true })).toBeFocused();
  native.holdSave.release();
  native.holdSave = undefined;
  await persisted(page);
  expect(native.maxActiveSaves).toBe(1);
  expect(native.state.notes).toEqual([{ ...original.notes[0], text: 'Latest note typed during save' }]);
  expect(native.state.tasks).toEqual([]);
  expect(native.state.selectedKey).toBe('t:123');
  expect(native.state.order).toEqual(['t:123', 't:456']);
  await page.reload();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Latest note typed during save');
});

test('acknowledgement waits for persisted intent and leaves concurrently refreshed newer evidence pending', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await capture(page, 'An unrelated task');
  await inbox(page).click();
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private note kept through operation');
  await persisted(page);
  const before = structuredClone(native.state);
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  native.holdSave = gate();
  native.holdWrite = gate();
  await detail(page).getByRole('button', { name: 'Archive thread' }).click();
  await expect(page.getByRole('button', { name: 'Restore to Inbox' })).toBeVisible();
  await expect.poll(() => native.activeSaves).toBe(1);
  expect(native.requests.filter(request => request.op === 'github.acknowledge')).toEqual([]);
  native.holdSave.release();
  native.holdSave = undefined;
  await expect.poll(() => native.requests.filter(request => request.op === 'github.acknowledge').length).toBe(1);
  const intent = structuredClone(native.state.operations[0]!);
  expect(intent.eventIds).toEqual(['request-1']);
  expect(intent.status).toBe('pending');
  native.threads = [{ ...thread([evidence(), evidence('later-request')]), updatedAt: '2026-09-11T17:01:00Z',
    evidence: [evidence(), { ...evidence('later-request'), at: '2026-09-11T17:01:00Z' }] }];
  native.holdRefresh.release();
  native.holdRefresh = undefined;
  await expect.poll(() => native.state.threads[0]!.events.length).toBe(2);
  native.holdWrite.release();
  native.holdWrite = undefined;
  await expect(page.getByText('GitHub confirmed Done. This thread is in Inbox here; notes and Tasks are unchanged.')).toBeVisible();
  expect(native.state.handled).toEqual(['request-1']);
  expect(native.state.threads[0]?.notification).toBe('unread');
  expect(native.state.operations[0]).toMatchObject({ id: intent.id, status: 'confirmed', eventIds: ['request-1'] });
  expect(native.state.notes).toEqual(before.notes);
  expect(native.state.tasks).toEqual(before.tasks);
  await expect(page.locator('.queue')).toContainText('Requested review 123');
  expect(JSON.stringify(native.requests)).not.toContain('Private note');
});

for (const action of ['Archive thread', 'Unsubscribe on GitHub']) {
  test(`${action} retains separately editable notes after relaunch`, async ({ page, native }) => {
    await page.goto('/');
    await refresh(page);
    await capture(page, 'Separate task stays open');
    await inbox(page).click();
    await row(page, 't:123').click();
    await page.getByLabel('Thread notes', { exact: true }).fill('First retained annotation');
    await detail(page).getByRole('button', { name: 'Add note' }).click();
    await page.getByLabel('Thread note 2').fill('Second retained annotation');
    await persisted(page);
    const before = structuredClone(native.state);
    await detail(page).getByRole('button', { name: action, exact: true }).click();
    if (action === 'Archive thread') {
      await expect.poll(() => native.state.operations[0]?.status).toBe('confirmed');
    } else {
      await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
      await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
      await page.getByRole('button', { name: 'Return to workspace' }).click();
    }
    expect(native.state.tasks).toEqual(before.tasks);
    expect(native.state.notes).toEqual(before.notes);
    expect(action === 'Archive thread' ? native.state.threads[0]?.notification : native.state.threads[0]?.subscription)
      .toBe(action === 'Archive thread' ? 'done' : 'unsubscribed');
    await page.getByRole('navigation', { name: 'Inboxes' }).getByRole('button', { name: action === 'Archive thread' ? /^Archive/ : /^Inbox/ }).click();
    await row(page, 't:123').click();
    await page.getByLabel('Thread note 2').fill('Second edited after acknowledgement');
    await persisted(page);
    await page.reload();
    await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First retained annotation');
    await expect(page.getByLabel('Thread note 2')).toHaveValue('Second edited after acknowledgement');
    expect(native.state.tasks).toEqual(before.tasks);
    expect(native.requests.map(request => request.op)).toEqual(['github.refresh', action === 'Archive thread' ? 'github.acknowledge' : 'github.unsubscribe']);
  });
}

test('failed writes survive relaunch and retry only with the original operation context', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Retain on failed write');
  await persisted(page);
  const notes = structuredClone(native.state.notes);
  native.failWrite = true;
  await detail(page).getByRole('button', { name: 'Unsubscribe on GitHub' }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByRole('dialog')).toContainText('write unavailable');
  expect(native.state.operations[0]?.status).toBe('failed');
  const operation = structuredClone(native.state.operations[0]!);
  expect(native.state.notes).toEqual(notes);
  expect(native.state.threads[0]?.subscription).toBe('subscribed');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(1);
  native.threads = [thread([evidence(), evidence('later-request')])];
  await refresh(page);
  native.failWrite = false;
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Review and retry' }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  expect(native.state.operations[0]).toMatchObject({ id: operation.id, status: 'confirmed', eventIds: ['request-1'] });
  expect(native.state.handled).toEqual(['request-1']);
  expect(native.state.notes).toEqual(notes);
  expect(native.state.tasks).toEqual([]);
  const writes = native.requests.filter(request => request.op === 'github.unsubscribe');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.input).toEqual(writes[0]!.input);
});

test('external handoff cancel, failure and launch send only identity and never mutate tasks or notes', async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await capture(page, 'Personal task not sent externally');
  await inbox(page).click();
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private annotation never sent');
  await persisted(page);
  const before = structuredClone(native.state);
  for (const destination of ['Open on GitHub', 'Review in Copilot']) {
    const button = detail(page).getByRole('button', { name: destination, exact: true });
    const count = native.launches.length;
    await button.click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(button).toBeFocused();
    expect(native.launches).toHaveLength(count);
    await button.click();
    native.failLaunch = true;
    await page.getByRole('button', { name: 'Request launch' }).click();
    await expect(page.getByRole('dialog')).toContainText('destination app is unavailable');
    native.failLaunch = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Launch requested, not completed')).toBeVisible();
    await page.getByRole('button', { name: 'Return to workspace' }).click();
    expect(native.state).toEqual(before);
    expect(native.launches.slice(count)).toEqual([0, 1].map(() => ({
      command: destination === 'Open on GitHub' ? 'launch_github' : 'launch_copilot',
      args: { identity: { source: 'github', owner: 'octo', repo: 'project', kind: 'pr', number: 123 } },
    })));
  }
});

test('startup, focus, elapsed time, edits and navigation never fetch; failed, partial and missing source responses retain history', async ({ page, native }) => {
  await page.goto('/');
  await persisted(page);
  await capture(page, 'Offline task');
  await page.getByLabel('Task notes').fill('Offline note');
  await inbox(page).click();
  await persisted(page);
  const beforeTime = structuredClone(native.saved);
  native.now = '2026-09-14T17:00:00Z';
  await page.clock.setFixedTime(new Date(native.now));
  await page.clock.fastForward(3 * 24 * 60 * 60 * 1000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(native.saved).toEqual(beforeTime);
  expect(native.requests).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  expect(native.requests).toEqual([]);
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Remember saved evidence');
  await persisted(page);
  const before = structuredClone(native.state);
  native.failRefresh = true;
  await refresh(page);
  await expect(page.getByText('Refresh failed; showing saved work')).toBeVisible();
  expect(native.state.refresh.lastSuccessAt).toBe(before.refresh.lastSuccessAt);
  expect(native.state.threads[0]!.events[0]!.summary).toBe('Review the requested changes.');
  native.failRefresh = false;
  native.partial = true;
  native.threads = [{ ...thread([]), coverage: { timeline: 'unavailable', newestPage: 0, fetchedPages: [], observedAt: at } }];
  await refresh(page);
  await expect(page.getByText('Some activity could not be refreshed')).toBeVisible();
  await expect(detail(page)).toContainText('Some timeline evidence is unavailable.');
  expect(native.state.threads[0]!.events.some(event => event.id === 'request-1')).toBe(true);
  native.partial = false;
  native.threads = [];
  await refresh(page);
  expect(native.state.refresh.status).toBe('ok');
  expect(native.state.threads).toHaveLength(1);
  expect(native.state.notes).toEqual(before.notes);
  expect(native.state.tasks).toEqual(before.tasks);
  expect(native.requests.map(request => request.op)).toEqual(Array(4).fill('github.refresh'));
});

test('successful refresh with bounded coverage shows freshness without an error banner', async ({ page, native }, testInfo) => {
  native.notificationLimit = true;
  native.threads = Array.from({ length: 50 }, (_, index) => thread([], String(123 + index)));
  native.threads[0]!.coverage = { timeline: 'partial', newestPage: 5, fetchedPages: [5], observedAt: at };
  await page.goto('/');
  await refresh(page);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByText('Showing the latest 50 threads.', { exact: true })).toBeVisible();
  await expect(page.locator('.refresh-area')).toContainText('Updated');
  expect(native.state.refresh.status).toBe('ok');
  expect(native.state.threads[0]!.coverage?.timeline).toBe('partial');
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Keep this local note');
  await persisted(page);
  const requests = native.requests.length;
  await page.reload();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByText('Showing the latest 50 threads.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Keep this local note');
  expect(native.requests).toHaveLength(requests);
  await page.screenshot({ path: testInfo.outputPath('normal-refresh-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Showing the latest 50 threads.', { exact: true })).toBeVisible();
  expect(await page.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('normal-refresh-narrow.png') });
  native.partial = true;
  await refresh(page);
  await expect(page.getByText('Some activity could not be refreshed')).toBeVisible();
  await expect(page.getByText('Showing the latest 50 threads.', { exact: true })).toHaveCount(0);
});

test('repeated refresh errors stay compact with accessible details and clear after recovery', async ({ page, native }, testInfo) => {
  await page.goto('/');
  await refresh(page);
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Keep my note through partial refresh');
  native.partial = true;
  native.diagnostics = Array.from({ length: 50 }, (_, index) => {
    const { code, message } = new ServiceError(index % 2 ? 'limit' : 'invalid_output').dto;
    return { scope: 'timeline', threadId: String(index + 1), code, message };
  });
  await refresh(page);
  const banner = page.locator('.error-banner').filter({ hasText: 'Some activity could not be refreshed' });
  const disclosure = banner.locator('details');
  const details = banner.locator('summary');
  for (const [name, width, height, maximumHeight] of [['desktop', 1440, 1000, 125], ['narrow', 390, 844, 175]] as const) {
    await page.setViewportSize({ width, height });
    await expect(banner).toBeVisible();
    await expect(disclosure).not.toHaveAttribute('open', '');
    await expect(banner).toContainText('Received 1 GitHub thread.');
    expect((await banner.boundingBox())!.height).toBeLessThan(maximumHeight);
    await page.screenshot({ path: testInfo.outputPath(`refresh-errors-${name}.png`) });
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.locator('li')).toHaveCount(2);
    await expect(disclosure.getByText(new ServiceError('limit').message, { exact: true })).toBeVisible();
    await expect(disclosure.getByText(new ServiceError('invalid_output').message, { exact: true })).toBeVisible();
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    await details.click();
  }
  await persisted(page);
  const requests = native.requests.length;
  await page.reload();
  await expect(banner).toBeVisible();
  await expect(disclosure).not.toHaveAttribute('open', '');
  expect(native.requests).toHaveLength(requests);
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Keep my note through partial refresh');
  native.partial = false;
  native.diagnostics = [];
  await refresh(page);
  await expect(banner).toHaveCount(0);
  expect(native.state.refresh.diagnostics).toEqual([]);
});

for (const legacy of [true, false]) test(`long ${legacy ? 'legacy' : 'distinct'} refresh diagnostics cannot crowd out the workspace`, async ({ page, native }) => {
  await page.goto('/');
  await refresh(page);
  await persisted(page);
  const messages = Array.from({ length: 250 }, (_, index) => `Warning ${index}: ${'Unavailable '.repeat(20)}`);
  const state = native.state;
  state.refresh = { ...state.refresh, status: 'partial',
    message: legacy ? messages.join(' ') : 'Saved work is retained. Refresh to retry missing activity.',
    diagnostics: messages };
  if (legacy) delete state.refresh.diagnostics;
  native.saved.snapshot!.workspace = { version: 1, state, scroll: {} };
  const requests = native.requests.length;
  await page.reload();
  const banner = page.locator('.error-banner').filter({ hasText: 'Some activity could not be refreshed' });
  await expect(banner).toBeVisible();
  const disclosure = banner.locator('details');
  await expect(disclosure).not.toHaveAttribute('open', '');
  expect((await banner.boundingBox())!.height).toBeLessThan(125);
  await banner.locator('summary').click();
  const warnings = disclosure.locator('ul');
  await expect(warnings).toBeVisible();
  expect(await warnings.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect((await warnings.boundingBox())!.height).toBeLessThanOrEqual(160);
  await expect(warnings).toContainText(messages.at(-1)!);
  expect((await banner.boundingBox())!.height).toBeLessThan(300);
  expect(native.requests).toHaveLength(requests);
});

test('save failure retains latest pending notes and explicit retry saves them before relaunch', async ({ page, native }) => {
  await page.goto('/');
  await capture(page, 'Persistent original task');
  await persisted(page);
  native.failSave = true;
  await page.getByLabel('Task notes').fill('First pending edit');
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved');
  await page.getByLabel('Task notes').fill('Latest pending edit');
  expect(native.state.tasks[0]?.notes).toBe('');
  await expect(page.getByLabel('Task notes')).toHaveValue('Latest pending edit');
  native.failSave = false;
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await persisted(page);
  expect(native.state.tasks[0]?.notes).toBe('Latest pending edit');
  await page.reload();
  await expect(page.getByLabel('Task notes')).toHaveValue('Latest pending edit');
  expect(native.requests).toEqual([]);
});

test('revision conflict keeps both copies and backs up the competing save before replacement', async ({ page, native }) => {
  await page.goto('/');
  await capture(page, 'Task before conflict');
  await persisted(page);
  const other = structuredClone(native.saved);
  other.revision = crypto.randomUUID();
  const otherState = other.snapshot!.workspace.state as unknown as { tasks: { notes: string }[] };
  otherState.tasks[0]!.notes = 'Other window saved this';
  native.saved = other;
  await page.getByLabel('Task notes').fill('My pending copy');
  await expect(page.getByRole('alert')).toContainText('Another writer changed');
  expect(native.state.tasks[0]?.notes).toBe('Other window saved this');
  await page.getByRole('button', { name: 'Back up saved copy & use this one' }).click();
  await persisted(page);
  expect([...native.backups.values()]).toEqual([other]);
  expect(native.state.tasks[0]?.notes).toBe('My pending copy');
  const backupCall = native.calls.lastIndexOf('workspace_create_backup');
  expect(backupCall).toBeLessThan(native.calls.lastIndexOf('workspace_save'));
});

test('corrupt SQLite never exposes a fallback and restores only an explicitly selected backup', async ({ page, native }) => {
  const legacy = legacyFixture(true);
  const backupId = crypto.randomUUID();
  native.backups.set(backupId, {
    revision: crypto.randomUUID(), savedAt: at,
    snapshot: snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state: legacy, scroll: {} }, reminders: [] }),
  });
  native.corrupt = true;
  const damaged = structuredClone(native.saved);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('damaged');
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry reading saved work' }).click();
  await expect(page.getByRole('alert')).toContainText('damaged');
  expect(native.calls).not.toContain('workspace_save');
  expect(native.requests).toEqual([]);
  await page.getByRole('button', { name: 'Backups & recovery' }).click();
  await page.getByRole('button', { name: 'Preserve database files' }).click();
  await expect(page.getByRole('dialog')).toContainText('Original database files preserved locally');
  expect(native.rawExports).toEqual([damaged]);
  await page.getByLabel('Saved backup').selectOption(backupId);
  await expect(page.getByRole('button', { name: 'Restore selected backup' })).toBeDisabled();
  expect(native.saved).toEqual(damaged);
  await page.getByRole('checkbox', { name: /I exported any pending edits/ }).check();
  await page.getByRole('button', { name: 'Restore selected backup' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await persisted(page);
  assertMigration(native.state, legacy);
  expect(native.saved.snapshot?.reminders).toEqual([]);
  expect(native.requests).toEqual([]);
});

test('v2 migration creates a durable original before writing v3 and relaunch does not duplicate annotations or schedule reminders', async ({ page, native }) => {
  const legacy = legacyFixture(true);
  native.saved.snapshot = snapshotSchema.parse({
    formatVersion: 1, workspace: { version: 1, state: legacy, scroll: {} },
    reminders: [{ id: 'routine', occurrenceId: 'old-occurrence', dueAt: at, timeZone: 'UTC',
      daily: { time: '10:00', timeZone: 'UTC' } }],
  });
  const original = structuredClone(native.saved);
  native.holdSave = gate();
  await page.goto('/');
  await expect.poll(() => native.writes.length).toBe(1);
  expect([...native.backups.values()]).toEqual([original]);
  expect(native.saved).toEqual(original);
  expect(native.calls.indexOf('workspace_create_backup')).toBeLessThan(native.calls.indexOf('workspace_save'));
  expect(native.writes[0]!.reminders).toEqual([]);
  native.holdSave.release();
  native.holdSave = undefined;
  await persisted(page);
  assertMigration(native.state, legacy);
  await checkMigratedReader(page);
  await persisted(page);
  const beforeReload = structuredClone(native.state);
  await page.reload();
  await persisted(page);
  expect(native.state.tasks).toEqual(beforeReload.tasks);
  expect(native.state.notes).toEqual(beforeReload.notes);
  expect([...native.backups.values()]).toEqual([original]);
  await checkRelaunchedThreadLink(page);
  await persisted(page);
  expect(native.state.selectedKey).toBe('t:123');
  native.now = '2026-09-15T17:00:00Z';
  await page.clock.setFixedTime(new Date(native.now));
  await page.clock.fastForward(4 * 24 * 60 * 60 * 1000);
  expect(native.state.tasks).toEqual(beforeReload.tasks);
  expect(native.saved.snapshot?.reminders).toEqual([]);
  expect(native.requests).toEqual([]);
  native.threads = [thread([evidence(), evidence('new-request-after-migration')])];
  await refresh(page);
  expect(native.state.refresh.status).toBe('ok');
  expect(native.state.tasks).toEqual(beforeReload.tasks);
  expect(native.state.notes).toEqual(beforeReload.notes);
});

test('migrated capture placeholders keep source links but hide notification writes until Refresh resolves them', async ({ page, native }) => {
  const legacy = legacyFixture(true);
  const placeholderId = 'capture:octo/project:123';
  legacy.threads[0]!.id = placeholderId;
  legacy.threads[0]!.events = [];
  legacy.actions = legacy.actions.map(action => action.threadId
    ? { ...action, threadId: placeholderId, eventIds: [], interpretation: 'supported' } : action);
  native.saved.snapshot = snapshotSchema.parse({
    formatVersion: 1, workspace: { version: 1, state: legacy, scroll: {} }, reminders: [],
  });
  await page.goto('/');
  await persisted(page);
  await tasks(page).click();
  await row(page, 'a:captured').click();
  await detail(page).getByRole('button', { name: 'Open thread notes' }).click();
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
  await expect(detail(page).getByRole('button', { name: 'Mark notification done on GitHub' })).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: 'Unsubscribe on GitHub' })).toHaveCount(0);
  await expect(detail(page)).toContainText('Refresh to look for a GitHub notification');
  await expect(detail(page).getByRole('button', { name: 'Review in Copilot' })).toBeVisible();
  await detail(page).getByRole('button', { name: 'Open on GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Request launch' }).click();
  await expect(page.getByRole('dialog')).toContainText('Launch requested, not completed');
  expect(native.launches[0]!.args).toEqual({ identity: { source: 'github', owner: 'octo', repo: 'project', kind: 'pr', number: 123 } });
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  expect(native.requests).toEqual([]);
  await page.getByRole('button', { name: 'Restore to Inbox' }).click();
  await page.getByRole('button', { name: 'Archive thread' }).click();
  await expect(page.getByText('Archived here. This source has no GitHub notification ID, so no GitHub write was sent.')).toBeVisible();
  expect(native.state.operations).toEqual([]);
  expect(native.requests).toEqual([]);
  await refresh(page);
  expect(native.state.operations).toEqual([]);
  expect(native.state.selectedKey).toBe('t:123');
  await expect(detail(page).getByRole('button', { name: 'Restore to Inbox' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: 'Unsubscribe on GitHub' })).toBeVisible();
  await page.reload();
  await persisted(page);
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First distinct annotation');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Second distinct annotation');
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
  await tasks(page).click();
  await row(page, 'a:routine').click();
  await expect(page.getByLabel('Task notes')).toHaveValue('Routine notes');
  expect(native.requests.map(request => request.op)).toEqual(['github.refresh']);
});

test('failed migration backup blocks editing and writes until preserving the original succeeds', async ({ page, native }) => {
  native.saved.snapshot = snapshotSchema.parse({
    formatVersion: 1, workspace: { version: 1, state: legacyFixture(true), scroll: {} }, reminders: [],
  });
  const original = structuredClone(native.saved);
  native.failBackup = true;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Original backup could not be preserved');
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  expect(native.writes).toEqual([]);
  expect(native.saved).toEqual(original);
  native.failBackup = false;
  await page.getByRole('button', { name: 'Retry reading saved work' }).click();
  await persisted(page);
  expect([...native.backups.values()]).toEqual([original]);
  expect(native.state.version).toBe(3);
  expect(native.requests).toEqual([]);
});

test('desktop and 390px layout retain destinations, keyboard focus and bounded pane geometry', async ({ page, native }, testInfo) => {
  native.threads.push({ ...thread([evidence('issue-comment', 'comment')], '456'),
    reference: { repo: 'octo/project', number: 456, kind: 'issue' }, title: 'A long source title with context that must wrap without hiding GitHub and Copilot destinations' });
  await page.goto('/');
  await refresh(page);
  for (const source of await page.locator('.work-row').all()) {
    await expect(source.getByRole('button', { name: 'Open on GitHub', exact: true })).toBeVisible();
    await expect(source.getByRole('button', { name: /Review in Copilot|Open in Copilot/ })).toBeVisible();
  }
  await row(page, 't:123').click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Private notes stay beside this saved thread.');
  await persisted(page);
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.queue')).toBeVisible();
  await expect(detail(page)).toBeVisible();
  const bounds = await Promise.all([page.locator('.sidebar'), page.locator('.queue'), detail(page)].map(locator => locator.boundingBox()));
  expect(bounds[0]!.x + bounds[0]!.width).toBeLessThanOrEqual(bounds[1]!.x);
  expect(bounds[1]!.x + bounds[1]!.width).toBeLessThanOrEqual(bounds[2]!.x);
  expect(bounds[2]!.x + bounds[2]!.width).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: testInfo.outputPath('desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator('.queue')).toBeVisible();
  await row(page, 't:456').focus();
  await page.keyboard.press('Enter');
  const notes = page.getByLabel('Thread notes', { exact: true });
  await notes.focus();
  await page.keyboard.type('N');
  await expect(notes).toBeFocused();
  await page.keyboard.type('arrow note stays focused');
  await expect(notes).toHaveValue('Narrow note stays focused');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const narrow = await detail(page).boundingBox();
  expect(narrow!.x).toBeGreaterThanOrEqual(0);
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(390);
  await detail(page).evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('narrow.png') });
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('What do you want to remember?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(notes).toBeFocused();
  await detail(page).getByRole('button', { name: 'Open in Copilot', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(detail(page).getByRole('button', { name: 'Open in Copilot', exact: true })).toBeFocused();
  expect(native.state.tasks).toEqual([]);
});
