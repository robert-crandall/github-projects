import { expect, type Page } from '@playwright/test';
import type { Scenario } from '../src/types.ts';
import { assertMigration, capture, checkMigratedReader, checkRelaunchedThreadLink, detail, inbox, legacyFixture, row, saved, storageKey, tasks, test } from './workspace-fixtures.ts';

test('Waiting on me prototype generates only labeled samples and keeps Tasks separate', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, storageKey)).toBe(true);
  const before = await saved(page);
  const opener = page.getByRole('button', { name: 'Waiting on me', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Waiting on me', exact: true });
  await expect(dialog.getByText('Prototype - synthetic digest, no GitHub requests', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Generate sample', exact: true }).click();
  await expect(dialog.getByRole('checkbox')).toHaveCount(7);
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Open sample/notification-client#42 on GitHub', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Synthetic example only. No browser was opened.');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(await saved(page)).toEqual(before);
  await opener.click();
  await expect(dialog.getByRole('checkbox').first()).toBeChecked();
  const add = dialog.getByRole('button', { name: /^Add checked items to Tasks/ });
  await expect(add).toHaveText('Add checked items to Tasks (1)');
  await add.evaluate(button => {
    if (!(button instanceof HTMLButtonElement)) throw new Error('Expected the task capture button.');
    button.click(); button.click();
  });
  await expect(add).toBeDisabled();
  const captured = await saved(page);
  expect(captured.tasks).toHaveLength(before.tasks.length + 1);
  expect(captured.tasks.at(-1)).toMatchObject({
    title: 'Keep thread notes when navigating', notes: 'I need to review.\nhttps://github.com/sample/notification-client/pull/42', status: 'open',
  });
  await dialog.getByRole('button', { name: 'Open Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.reload();
  expect((await saved(page)).tasks).toEqual(captured.tasks);
});

async function stage(page: Page, scenario: Scenario) {
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Activity scenario').selectOption(scenario);
  await page.getByRole('button', { name: 'Stage activity', exact: true }).click();
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
}
async function configure(page: Page, failure: 'none' | 'partial' | 'error') {
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Next refresh').selectOption(failure);
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
}

test('selecting threads and typing the first character keeps focus and never creates Tasks', async ({ page }) => {
  await page.goto('/');
  const before = await saved(page);
  await page.locator('.row-select').nth(1).click();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('');
  expect((await saved(page)).tasks).toEqual(before.tasks);
  const selected = (await saved(page)).selectedKey;
  const input = page.getByLabel('Thread notes', { exact: true });
  await input.focus();
  await page.keyboard.type('F');
  await expect(input).toBeFocused();
  await page.keyboard.type('irst note\nKeep private.');
  await expect(input).toHaveValue('First note\nKeep private.');
  await detail(page).getByRole('button', { name: 'Add note' }).click();
  await page.getByLabel('Thread note 2').fill('Separate second annotation');
  await input.fill('Edited first annotation');
  const annotated = await saved(page);
  expect(annotated.tasks).toEqual(before.tasks);
  expect(annotated.notes.filter(note => `t:${note.threadId}` === selected).map(note => note.text))
    .toEqual(['Edited first annotation', 'Separate second annotation']);
  await tasks(page).click();
  await expect(page.locator('.work-row')).toHaveCount(before.tasks.length);
  await inbox(page).click();
  await row(page, selected!).click();
  await page.reload();
  await expect(input).toHaveValue('Edited first annotation');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Separate second annotation');
  expect((await saved(page)).tasks).toEqual(before.tasks);
});

for (const view of ['Inbox', 'Tasks'] as const) {
  test(`capture from ${view} saves exact URL and daily text as standalone Tasks without interpretation`, async ({ page }) => {
    await page.goto('/');
    if (view === 'Tasks') await tasks(page).click();
    const before = await saved(page);
    const text = `  https://github.com/octo/project/pull/123\nEvery day at 10am, announce, then increase — from ${view}  `;
    await capture(page, text);
    const after = await saved(page);
    expect(after.tasks).toHaveLength(before.tasks.length + 1);
    expect(after.tasks.at(-1)).toEqual({
      id: after.selectedKey!.slice(2), title: text, notes: '', status: 'open', createdAt: before.clock,
    });
    expect(after.threads).toEqual(before.threads);
    expect(after.notes).toEqual(before.notes);
    expect(after.draft).toBe('');
    expect(after.view).toBe('tasks');
    await page.reload();
    expect((await saved(page)).tasks).toEqual(after.tasks);
    await expect(detail(page).getByRole('heading')).toHaveText(text);
  });
}

test('task text, notes and Done survive reload, new requests, source closure and sample reset', async ({ page }) => {
  await page.goto('/');
  await capture(page, 'A standalone follow-up');
  await detail(page).getByRole('button', { name: 'Edit text' }).click();
  await page.getByRole('textbox', { name: 'Task text', exact: true }).fill('  My revised task\nSecond line  ');
  await page.getByRole('button', { name: 'Save text' }).click();
  await page.getByLabel('Task notes').fill('Private task notes');
  await page.getByRole('checkbox', { name: 'Done', exact: true }).check();
  const before = await saved(page);
  const task = before.tasks.at(-1)!;
  expect(task).toMatchObject({ title: '  My revised task\nSecond line  ', notes: 'Private task notes', status: 'done', completedAt: before.clock });
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await expect(page.getByLabel('Task notes')).toHaveValue(task.notes);
  await expect(page.getByRole('region', { name: 'Completed tasks' })).toContainText('My revised task');
  await inbox(page).click();
  await row(page, 't:demo-relay-101').click();
  for (const scenario of ['merge-queue', 're-request', 'comment', 'closed'] as const) {
    await stage(page, scenario);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    expect((await saved(page)).tasks).toEqual(before.tasks);
  }
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByRole('button', { name: 'Reset samples, keep notes and tasks' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  expect((await saved(page)).tasks).toEqual(before.tasks);
  await tasks(page).click();
  await row(page, `a:${task.id}`).click();
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Done', exact: true }).uncheck();
  expect((await saved(page)).tasks.at(-1)?.status).toBe('open');
});

test('staged activity requires explicit Refresh and preserves row order, selection and notes', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Thread notes', { exact: true }).fill('Keep this thread context');
  const before = await saved(page);
  const keys = await page.locator('.queue .work-row:visible').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')));
  await stage(page, 'new-review');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.reload();
  expect((await saved(page)).refresh).toEqual(before.refresh);
  expect((await saved(page)).staged).toHaveLength(1);
  expect(await page.locator('.queue .work-row:visible').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')))).toEqual(keys);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const after = await saved(page);
  expect(after.staged).toEqual([]);
  expect(after.selectedKey).toBe(before.selectedKey);
  expect(after.notes).toEqual(before.notes);
  expect(after.tasks).toEqual(before.tasks);
  expect(after.order.slice(0, before.order.length)).toEqual(before.order);
  await expect(page.locator('.new-updates')).toContainText('Add delivery timeout diagnostics');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
});

for (const action of ['Archive thread', 'Unsubscribe on GitHub']) {
  test(`${action} retains notes without changing Tasks`, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Thread notes', { exact: true }).fill('I still need this annotation');
    await detail(page).getByRole('button', { name: 'Add note' }).click();
    await page.getByLabel('Thread note 2').fill('Independent annotation');
    const before = await saved(page);
    if (action === 'Archive thread') {
      await page.getByRole('button', { name: /Demo scenarios/ }).click();
      await page.getByLabel('External handoff fails').check();
      await page.getByRole('button', { name: 'Back to workspace' }).click();
      await detail(page).getByRole('button', { name: action, exact: true }).click();
      expect((await saved(page)).threads[0]!.archive).not.toBeNull();
      await detail(page).getByRole('button', { name: 'Retry GitHub operation' }).click();
    } else await detail(page).getByRole('button', { name: action, exact: true }).click();
    await page.getByLabel('Simulate a failed GitHub write').check();
    await page.getByRole('button', { name: 'Simulate success' }).click();
    await expect(page.getByRole('dialog')).toContainText('Nothing was acknowledged or unsubscribed');
    if (action !== 'Archive thread') expect((await saved(page)).threads).toEqual(before.threads);
    await page.getByLabel('Simulate a failed GitHub write').uncheck();
    await page.getByRole('button', { name: 'Retry simulation' }).click();
    await page.getByRole('button', { name: 'Return to workspace' }).click();
    const after = await saved(page);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.notes).toEqual(before.notes);
    const thread = after.threads.find(thread => `t:${thread.id}` === before.selectedKey)!;
    expect(action === 'Archive thread' ? thread.notification : thread.subscribed).toBe(action === 'Archive thread' ? 'done' : false);
    await page.getByRole('navigation', { name: 'Inboxes' }).getByRole('button', { name: action === 'Archive thread' ? /^Archive/ : /^Inbox/ }).click();
    await row(page, before.selectedKey!).click();
    await page.reload();
    await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('I still need this annotation');
    await expect(page.getByLabel('Thread note 2')).toHaveValue('Independent annotation');
  });
}

test('external handoff cancellation, failure and requested launch leave tasks and notes unchanged', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Thread notes', { exact: true }).fill('Never send this private annotation');
  const before = await saved(page);
  for (const destination of ['Open on GitHub', 'Review in Copilot']) {
    const button = detail(page).getByRole('button', { name: destination, exact: true });
    await button.click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(button).toBeFocused();
    await button.click();
    await page.getByLabel('Simulate an unavailable app').check();
    await page.getByRole('button', { name: 'Simulate launch' }).click();
    await expect(page.getByRole('dialog')).toContainText('could not be opened');
    await page.getByLabel('Simulate an unavailable app').uncheck();
    await page.getByRole('button', { name: 'Retry simulation' }).click();
    await expect(page.getByRole('dialog')).toContainText('Launch requested, not completed');
    await page.getByRole('button', { name: 'Return to workspace' }).click();
    expect(await saved(page)).toEqual(before);
  }
});

test('failed and partial Refresh preserve saved context and recover only on explicit retry', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Thread notes', { exact: true }).fill('Retained through failed refresh');
  const before = await saved(page);
  await stage(page, 'comment');
  await stage(page, 're-request');
  await configure(page, 'error');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Refresh failed; showing saved work')).toBeVisible();
  expect((await saved(page)).threads).toEqual(before.threads);
  expect((await saved(page)).staged).toHaveLength(2);
  await configure(page, 'partial');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Some activity could not be refreshed')).toBeVisible();
  expect((await saved(page)).staged).toHaveLength(1);
  expect((await saved(page)).refresh.lastSuccessAt).toBe(before.refresh.lastSuccessAt);
  await configure(page, 'none');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect((await saved(page)).refresh.status).toBe('ok');
  expect((await saved(page)).notes).toEqual(before.notes);
  expect((await saved(page)).tasks).toEqual(before.tasks);
  await stage(page, 'empty');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.queue .work-row')).toHaveCount(before.threads.filter(thread => !thread.archive && !thread.terminal).length);
  expect((await saved(page)).notes).toEqual(before.notes);
  expect((await saved(page)).threads).toHaveLength(before.threads.length);
});

test('storage failure keeps pending notes and Retry storage saves the latest edit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Local storage fails').check();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByLabel('Thread notes', { exact: true }).fill('Pending version one');
  await page.getByLabel('Thread notes', { exact: true }).fill('Pending latest version');
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved');
  expect((await saved(page)).notes.some(note => note.text.startsWith('Pending'))).toBe(false);
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Pending latest version');
});

test('corrupt browser copy is never overwritten without explicit backup and replacement', async ({ page }) => {
  await page.addInitScript(key => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(key, '{"damaged":');
      localStorage.setItem('unrelated-previous-app', 'untouched');
      sessionStorage.setItem('seeded', 'yes');
    }
  }, storageKey);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved');
  await page.getByLabel('Thread notes', { exact: true }).fill('Pending recovery annotation');
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('{"damaged":');
  await page.getByRole('button', { name: 'Back up saved copy & use this one' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const copies = await page.evaluate(key => ({
    unrelated: localStorage.getItem('unrelated-previous-app'),
    backups: Object.keys(localStorage).filter(name => name.startsWith(`${key}:recovery:`)).map(name => localStorage.getItem(name)),
  }), storageKey);
  expect(copies).toEqual({ unrelated: 'untouched', backups: ['{"damaged":'] });
  await page.reload();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('Pending recovery annotation');
});

test('v2 browser migration backs up before v3 writes and preserves distinct annotations and retired routine history', async ({ page }) => {
  const legacy = legacyFixture();
  const original = JSON.stringify({ state: legacy, scroll: {} });
  await page.addInitScript(({ key, original }) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(key, original);
      sessionStorage.setItem('seeded', 'yes');
    }
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && JSON.parse(value).state.version === 3 && localStorage.getItem(key) === original) {
        const backedUp = Object.keys(localStorage).some(name => name.startsWith(`${key}:recovery:`) && localStorage.getItem(name) === original);
        if (!backedUp) throw new Error('Migration tried to write v3 before preserving v2');
      }
      write.call(this, name, value);
    };
  }, { key: storageKey, original });
  await page.goto('/');
  assertMigration(await saved(page), legacy);
  await checkMigratedReader(page);
  const beforeReload = await saved(page);
  await page.reload();
  expect((await saved(page)).notes).toEqual(beforeReload.notes);
  expect((await saved(page)).tasks).toEqual(beforeReload.tasks);
  await checkRelaunchedThreadLink(page);
  expect((await saved(page)).selectedKey).toBe('t:123');
  await stage(page, 're-request');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect((await saved(page)).tasks).toEqual(beforeReload.tasks);
  expect((await saved(page)).notes).toEqual(beforeReload.notes);
  expect(await page.evaluate(key => Object.keys(localStorage).filter(name => name.startsWith(`${key}:recovery:`)).map(name => localStorage.getItem(name)), storageKey)).toEqual([original]);
});

test('390px navigation, first-note typing and keyboard capture retain focus without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator('.queue')).toBeVisible();
  const first = page.locator('.row-select').first();
  await first.focus();
  await page.keyboard.press('Enter');
  const notes = page.getByLabel('Thread notes', { exact: true });
  await notes.focus();
  await page.keyboard.type('N');
  await expect(notes).toBeFocused();
  await page.keyboard.type('arrow note');
  await expect(notes).toHaveValue('Narrow note');
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('What do you want to remember?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(notes).toBeFocused();
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.keyboard.press('Escape');
  await expect(detail(page).getByRole('button', { name: 'Review in Copilot' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
