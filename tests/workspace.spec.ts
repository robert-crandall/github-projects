import { expect, test, type Page } from '@playwright/test';
import type { AppState, Scenario } from '../src/types.ts';

const key = 'github-projects:greenfield-prototype:v1';
const detail = (page: Page) => page.getByRole('article', { name: 'Selected item' });
const work = (page: Page) => page.getByRole('region', { name: 'Working on' });
async function saved(page: Page): Promise<AppState> {
  return page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).state, key);
}
async function stage(page: Page, scenario: Scenario) {
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Activity scenario').selectOption(scenario);
  await page.getByRole('button', { name: 'Stage activity', exact: true }).click();
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
}
async function startReview(page: Page) {
  await page.goto('/');
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  const state = await saved(page);
  return { id: state.activeId!, threadId: state.actions.find(action => action.id === state.activeId)!.threadId! };
}

test('inspection, active work, notes, and reload remain separate', async ({ page }) => {
  await page.goto('/');
  await expect(work(page)).toContainText('Choose an action');
  await page.getByLabel('A note for when you return').fill('Check the retry window before approving.');
  await expect(work(page)).toContainText('Choose an action');
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  const state = await saved(page);
  const activeTitle = state.actions.find(action => action.id === state.activeId)!.title;
  await page.locator('.row-select').nth(1).click();
  await expect(work(page)).toContainText(activeTitle);
  expect((await saved(page)).activeId).toBe(state.activeId);
  await page.reload();
  expect((await saved(page)).selectedKey).not.toBe(`a:${state.activeId}`);
  await work(page).getByRole('button').click();
  await expect(page.getByLabel('A note for when you return')).toHaveValue('Check the retry window before approving.');
});

test('source activity is staged until manual refresh and never replaces current work', async ({ page }) => {
  await startReview(page);
  await page.getByLabel('A note for when you return').fill('Keep this context');
  const before = await saved(page);
  const rowKeys = await page.locator('[data-row-key]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')));
  await stage(page, 'new-review');
  expect((await saved(page)).refresh.lastSuccessAt).toBe(before.refresh.lastSuccessAt);
  expect(await page.locator('[data-row-key]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')))).toEqual(rowKeys);
  await page.reload();
  expect((await saved(page)).staged.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const after = await saved(page);
  expect(after.activeId).toBe(before.activeId);
  expect(after.selectedKey).toBe(before.selectedKey);
  expect(after.actions.find(action => action.id === before.activeId)?.notes).toBe('Keep this context');
  const afterKeys = await page.locator('[data-row-key]').evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')));
  expect(afterKeys.slice(0, rowKeys.length)).toEqual(rowKeys);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
});

test('finished review survives merge queue activity; new request is a new action', async ({ page }) => {
  const started = await startReview(page);
  await detail(page).getByRole('button', { name: 'Done', exact: true }).click();
  expect((await saved(page)).actions.find(action => action.id === started.id)?.status).toBe('done');
  await stage(page, 'merge-queue');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const queued = await saved(page);
  expect(queued.actions.find(action => action.id === started.id)?.status).toBe('done');
  expect(queued.activeId).toBeNull();
  expect(queued.actions.filter(action => action.threadId === started.threadId && action.status === 'available')).toHaveLength(0);
  await stage(page, 're-request');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator(`[data-row-key="t:${started.threadId}"] .row-select`).click();
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  const requested = await saved(page);
  expect(requested.activeId).not.toBe(started.id);
  expect(requested.actions.find(action => action.id === started.id)?.status).toBe('done');
});

test('Copilot cancellation, failure, and simulated return never finish an action', async ({ page }) => {
  const started = await startReview(page);
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await saved(page)).activeId).toBe(started.id);
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.getByLabel('Simulate an unavailable app').check();
  await page.getByRole('button', { name: 'Simulate launch' }).click();
  await expect(page.getByRole('dialog')).toContainText('could not be opened');
  await page.getByLabel('Simulate an unavailable app').uncheck();
  await page.getByRole('button', { name: 'Retry simulation' }).click();
  await expect(page.getByRole('dialog')).toContainText('Launch requested, not completed');
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  expect((await saved(page)).actions.find(action => action.id === started.id)?.status).toBe('available');
  expect((await saved(page)).activeId).toBe(started.id);
});

test('every GitHub row exposes both destinations at rest', async ({ page }) => {
  await page.goto('/');
  const githubRows = page.locator('.work-row').filter({ has: page.getByRole('button', { name: 'Open on GitHub', exact: true }) });
  expect(await githubRows.count()).toBeGreaterThan(2);
  for (const row of await githubRows.all()) {
    await expect(row.getByRole('button', { name: 'Open on GitHub', exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: /Review in Copilot|Open in Copilot/ })).toBeVisible();
  }
});

test('notification acknowledgement and unsubscribe leave the local action intact', async ({ page }) => {
  const started = await startReview(page);
  await page.getByLabel('A note for when you return').fill('I still owe a follow-up');
  for (const label of ['Mark notification done on GitHub', 'Unsubscribe on GitHub']) {
    await detail(page).getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: 'Simulate success' }).click();
    await page.getByRole('button', { name: 'Return to workspace' }).click();
  }
  const state = await saved(page);
  expect(state.actions.find(action => action.id === started.id)?.status).toBe('available');
  expect(state.actions.find(action => action.id === started.id)?.notes).toBe('I still owe a follow-up');
  expect(state.threads.find(thread => thread.id === started.threadId)?.subscribed).toBe(false);
  expect(state.threads.find(thread => thread.id === started.threadId)?.notification).toBe('done');
});

test('capture is saved before simulated interpretation and survives reset', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Capture/ }).first().click();
  await page.getByLabel('What do you want to remember?').fill('Send the rollout plan to the team');
  await page.getByRole('button', { name: 'Save capture' }).click();
  await expect(detail(page)).toContainText('Send the rollout plan to the team');
  let state = await saved(page);
  const captured = state.actions.find(action => action.captures.includes('Send the rollout plan to the team'))!;
  expect(captured.interpretation).toBe('pending');
  await page.getByRole('button', { name: 'Try simulated interpretation' }).click();
  await page.getByLabel('A note for when you return').fill('Mention the staged deployment');
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByRole('button', { name: 'Reset samples, keep captures' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.reload();
  state = await saved(page);
  const retained = state.actions.find(action => action.captures.includes('Send the rollout plan to the team'))!;
  expect(retained.notes).toBe('Mention the staged deployment');
});

test('storage failure is explicit and retry saves pending notes', async ({ page }) => {
  await startReview(page);
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Local storage fails').check();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByLabel('A note for when you return').fill('Preserve this pending note');
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved');
  expect((await saved(page)).actions.some(action => action.notes === 'Preserve this pending note')).toBe(false);
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('A note for when you return')).toHaveValue('Preserve this pending note');
});

test('Later retains context and a routine reminder does not steal active work', async ({ page }) => {
  const started = await startReview(page);
  await detail(page).getByRole('button', { name: 'Later', exact: true }).click();
  await page.getByLabel('A note for later').fill('Waiting for a response');
  await page.getByRole('button', { name: 'Keep for later', exact: true }).click();
  expect((await saved(page)).actions.find(action => action.id === started.id)?.status).toBe('later');
  await page.getByRole('button', { name: /^Later/ }).first().click();
  await expect(page.locator('.queue')).toContainText('Waiting for a response');
  await page.getByRole('button', { name: /Needs attention/ }).first().click();
  await page.locator('.row-select').first().click();
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  const before = await saved(page);
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByRole('button', { name: 'Advance 30 minutes' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(page.getByRole('region', { name: 'Local reminders' })).toBeVisible();
  expect((await saved(page)).activeId).toBe(before.activeId);
  expect((await saved(page)).selectedKey).toBe(before.selectedKey);
});

test('narrow navigation and keyboard dialog dismissal stay usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator('.queue')).toBeVisible();
  const first = page.locator('.row-select').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(detail(page)).toBeVisible();
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: 'Review in Copilot' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a corrupt saved copy is retained until explicit backup and replacement', async ({ page }) => {
  await page.addInitScript(storageKey => {
    localStorage.setItem(storageKey, '{"damaged":');
    localStorage.setItem('unrelated-previous-app', 'untouched');
  }, key);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved');
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe('{"damaged":');
  await page.getByRole('button', { name: 'Back up saved copy & use this one' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const result = await page.evaluate(storageKey => ({
    unrelated: localStorage.getItem('unrelated-previous-app'),
    backups: Object.keys(localStorage).filter(name => name.startsWith(`${storageKey}:recovery:`)).map(name => localStorage.getItem(name)),
  }), key);
  expect(result.unrelated).toBe('untouched');
  expect(result.backups).toContain('{"damaged":');
});

test('partial and failed refreshes retain context and can recover explicitly', async ({ page }) => {
  const started = await startReview(page);
  await stage(page, 'new-review');
  const before = await saved(page);
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Next refresh').selectOption('error');
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Refresh failed; showing saved work')).toBeVisible();
  expect((await saved(page)).refresh.lastSuccessAt).toBe(before.refresh.lastSuccessAt);
  expect((await saved(page)).staged.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Next refresh').selectOption('partial');
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Some activity could not be refreshed')).toBeVisible();
  expect((await saved(page)).activeId).toBe(started.id);
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Next refresh').selectOption('none');
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect((await saved(page)).refresh.status).toBe('ok');
});

test('routine steps keep their original timestamps after missed days', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await page.locator('.row-select').first().click();
  await expect(detail(page).getByRole('button', { name: 'Finish occurrence' })).toBeDisabled();
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByRole('button', { name: 'Advance 30 minutes' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  const steps = detail(page).getByRole('checkbox');
  await expect(steps.nth(1)).toBeDisabled();
  await steps.first().check();
  const original = (await saved(page)).actions.find(action => action.routine)?.steps[0].doneAt;
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByRole('button', { name: 'Advance 3 days' }).click();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(detail(page)).toContainText('Recorded steps have not been repeated');
  expect((await saved(page)).actions.find(action => action.routine)?.steps[0].doneAt).toBe(original);
  await steps.nth(1).check();
  await detail(page).getByRole('button', { name: 'Finish occurrence' }).click();
  const routine = (await saved(page)).actions.find(action => action.routine)?.routine;
  expect(routine?.history.some(occurrence => occurrence.status === 'done' && occurrence.steps[0].doneAt === original)).toBe(true);
});

test('interpretation failure keeps the original and provides a retry', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Capture interpretation fails').check();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: /Capture/ }).first().click();
  const original = 'Every day at 10am, announce the change, then increase the feature flag';
  await page.getByLabel('What do you want to remember?').fill(original);
  await page.getByRole('button', { name: 'Save capture' }).click();
  await detail(page).getByRole('button', { name: 'Try simulated interpretation' }).click();
  expect((await saved(page)).actions.find(action => action.captures.includes(original))?.interpretation).toBe('error');
  await expect(detail(page).getByRole('button', { name: 'Retry interpretation' })).toBeVisible();
  await page.getByRole('button', { name: /Demo scenarios/ }).click();
  await page.getByLabel('Capture interpretation fails').uncheck();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await detail(page).getByRole('button', { name: 'Retry interpretation' }).click();
  expect((await saved(page)).actions.find(action => action.captures.includes(original))?.routine).toBeDefined();
});

test('Copilot triage previews suggestions before changing order and never makes local decisions', async ({ page }) => {
  const started = await startReview(page);
  const before = await saved(page);
  await page.getByRole('button', { name: 'Triage with Copilot', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Deterministic sample rules');
  expect((await saved(page)).order).toEqual(before.order);
  await page.getByRole('button', { name: 'Keep current order' }).click();
  expect((await saved(page)).order).toEqual(before.order);
  await page.getByRole('button', { name: 'Triage with Copilot', exact: true }).click();
  await page.getByRole('button', { name: 'Apply suggested order' }).click();
  const after = await saved(page);
  expect(after.activeId).toBe(started.id);
  expect(after.selectedKey).toBe(before.selectedKey);
  expect(after.actions).toEqual(before.actions);
  expect(after.threads).toEqual(before.threads);
  expect(after.handled).toEqual(before.handled);
});
