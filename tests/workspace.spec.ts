import { expect, test, type Page } from '@playwright/test';

async function scenario(page: Page, title: string) {
  await page.getByRole('button', { name: 'Demo scenarios', exact: true }).click();
  await page.getByRole('button', { name: title, exact: false }).click();
}

async function capture(page: Page, text: string) {
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await page.getByLabel('Freeform capture').fill(text);
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByText('Saved original', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /View & edit action/ }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('Dusk hierarchy renders at desktop and narrow widths', async ({ page }, testInfo) => {
  await expect(page).toHaveTitle('GitHub Projects');
  await expect(page.locator('.brand')).toHaveText('GitHub Projects');
  await expect(page.locator('.brand img')).toBeVisible();
  await expect.poll(() => page.locator('.brand img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(128);
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
  await expect(page.getByRole('button', { name: 'Start review', exact: true })).toBeVisible();
  await expect(page.locator('.later-section')).not.toHaveAttribute('open');
  await expect(page.locator('.later-section > summary')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeVisible();
  await expect(page.locator('.focus-work')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true });
});

test('active work survives arrivals, notes, switching and reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('textbox', { name: /Scratch notes for Review the retry/ }).fill('Check jitter around retries. Pick up at the boundary case.');
  await scenario(page, 'New review arrives');
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
  await page.reload();
  await expect(page.getByRole('textbox', { name: /Scratch notes for Review the retry/ })).toHaveValue('Check jitter around retries. Pick up at the boundary case.');
  await page.getByRole('button', { name: /Switch to / }).first().click();
  await expect(page.locator('.focus-work')).not.toContainText('Review the retry backoff fix');
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
  await page.getByRole('button', { name: 'Complete action', exact: true }).click();
  await expect(page.locator('.focus-work')).not.toContainText('Review the retry backoff fix');
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
});

test('capture deduplicates a review and retains both sources and original text', async ({ page }) => {
  await capture(page, 'Drive-by: can you review demo://github/harbor/pull/42 when you get a chance?');
  await expect(page.getByRole('heading', { name: 'Review the retry backoff fix' })).toBeVisible();
  await expect(page.getByText('Drive-by: can you review demo://github/harbor/pull/42 when you get a chance?', { exact: true })).toBeVisible();
  const result = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('follow-through.prototype.v1')!);
    return {
      count: data.items.filter((item: { review?: { identity?: string } }) => item.review?.identity === 'demo://github/harbor/pull/42').length,
      sourceCount: data.items.find((item: { id: string }) => item.id === 'direct-review').sources.length,
    };
  });
  expect(result).toEqual({ count: 1, sourceCount: 2 });
  await page.getByText('Edit action', { exact: false }).click();
  await page.getByLabel('Action', { exact: true }).fill('Review retry edge cases');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^Captures/ }).click();
  await page.getByRole('button', { name: /Drive-by:/ }).click();
  await expect(page.getByRole('heading', { name: 'Review retry edge cases' })).toBeVisible();
});

test('unsupported capture and simulated interpretation failure both preserve text', async ({ page }) => {
  await capture(page, 'Order a replacement adapter. This is not a GitHub obligation.');
  await expect(page.locator('.original-capture')).toContainText('Order a replacement adapter. This is not a GitHub obligation.');
  await scenario(page, 'Simulate interpretation error');
  await capture(page, 'Review the changes sometime');
  await expect(page.locator('.original-capture')).toContainText('Review the changes sometime');
  await page.getByRole('button', { name: 'Turn simulation off' }).click();
  await page.getByRole('navigation').getByRole('button', { name: /^Captures/ }).click();
  await page.getByRole('button', { name: /Review the changes sometime/ }).click();
  await page.getByRole('button', { name: 'Retry interpretation', exact: true }).click();
  await expect(page.locator('.source-line')).toContainText('Captured review');
});

test('routine reminder does not replace an active review', async ({ page }) => {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await scenario(page, 'Routine due');
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
  await expect(page.getByLabel('Simulated routine reminder')).toBeVisible();
  await page.getByRole('button', { name: 'Snooze 30m', exact: true }).click();
  await expect(page.getByLabel('Simulated routine reminder')).not.toBeVisible();
  await page.getByRole('button', { name: 'Demo scenarios', exact: true }).click();
  await page.getByRole('button', { name: 'Advance 30 minutes', exact: true }).click();
  await page.getByRole('button', { name: 'Close demo scenarios' }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
});

test('routine ordering, partial progress and original timestamps survive missed days', async ({ page }, testInfo) => {
  await scenario(page, 'Routine due');
  await page.getByRole('button', { name: 'Start routine', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Increase flag/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Announce change/ }).check();
  await page.getByRole('textbox', { name: /Scratch notes/ }).fill('Announcement is recorded. Flag not increased.');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /Announce change/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Increase flag/ })).not.toBeChecked();
  await scenario(page, 'Return after 3 days');
  await expect(page.locator('.focus-work')).toContainText('Sep 8');
  await expect(page.locator('.focus-work')).toContainText('Saved steps have not been repeated');
  await page.screenshot({ path: testInfo.outputPath('active-routine.png'), fullPage: true });
  const occurrences = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('follow-through.prototype.v1')!);
    return state.items.find((item: { id: string }) => item.id === 'daily-routine').routine.occurrences;
  });
  expect(occurrences.filter((entry: { status: string }) => entry.status === 'outstanding')).toHaveLength(1);
  expect(occurrences.filter((entry: { status: string }) => entry.status === 'missed').length).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: /Increase flag/ }).check();
  await page.getByRole('button', { name: 'Complete occurrence' }).click();
  await expect(page.getByRole('button', { name: 'Start routine', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await expect(page.getByRole('checkbox', { name: /Increase flag/ })).toBeChecked();
});

test('capture a daily routine, edit it and skip its due occurrence', async ({ page }) => {
  await capture(page, 'Every day at 10am, alert the Slack channels, then increase the feature flag');
  await expect(page.locator('.source-line')).toContainText('Daily routine');
  await page.getByText('Edit action', { exact: false }).click();
  await page.getByLabel('Action', { exact: true }).fill('My flag routine');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await scenario(page, 'Routine due');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('follow-through.prototype.v1')!));
  expect(stored.items.some((item: { title: string; routine?: unknown }) => item.title === 'My flag routine' && item.routine)).toBe(true);
  await page.getByRole('button', { name: 'Skip occurrence', exact: true }).click();
  await page.reload();
  expect(await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('follow-through.prototype.v1')!);
    return state.items.some((item: { routine?: { occurrences: { status: string }[] } }) => item.routine?.occurrences.some((entry) => entry.status === 'skipped'));
  })).toBe(true);
});

test('deferral and waiting remain distinct and restorable', async ({ page }) => {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('button', { name: 'Defer', exact: true }).click();
  await page.getByLabel('Why set this aside?').fill('Choose this after lunch');
  await page.getByRole('button', { name: 'Move to Later', exact: true }).click();
  await page.locator('.later-section > summary').click();
  await expect(page.locator('.later-section')).toContainText('Choose this after lunch');
  await page.getByRole('button', { name: 'Restore Review the retry backoff fix', exact: true }).click();
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await page.getByRole('button', { name: 'Waiting on someone', exact: true }).click();
  await page.getByLabel('Who or what are you waiting on?').fill('Author to explain the retry threshold');
  await page.getByRole('button', { name: 'Mark waiting', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: /^Waiting/ }).click();
  await expect(page.getByText(/Author to explain the retry threshold/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore Review the retry backoff fix', exact: true }).click();
  await page.reload();
  await expect(page.locator('.focus-work')).toContainText('Review the retry backoff fix');
});

test('empty and unavailable states are honest, and sample reset preserves captures', async ({ page }) => {
  await capture(page, 'Keep this personal note through resets');
  await scenario(page, 'No actionable work');
  await expect(page.getByRole('heading', { name: 'Nothing needs your attention now.' })).toBeVisible();
  await scenario(page, 'Simulate sync error');
  await expect(page.getByRole('heading', { name: 'Simulated sync failed' })).toBeVisible();
  await expect(page.getByText('Data is unavailable. This is not confirmation that there is no work.')).toBeVisible();
  await scenario(page, 'Reset samples, keep my captures');
  await page.getByRole('navigation').getByRole('button', { name: /^Captures/ }).click();
  await expect(page.getByText('Keep this personal note through resets', { exact: true })).toBeVisible();
});

test('project context saves without being required for capture', async ({ page }) => {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Add a little context').fill('Release preparation');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel(/Context notes/).fill('Wait for the maintenance window.');
  await page.reload();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: /Release preparation/ }).click();
  await expect(page.getByLabel(/Context notes/)).toHaveValue('Wait for the maintenance window.');
});

test('storage failure is visible and never acknowledges an unsaved capture', async ({ page }) => {
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await page.getByLabel('Freeform capture').fill('Must not lose this raw capture');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Simulated disk quota', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local changes are not saved' })).toBeVisible();
  await expect(page.getByLabel('Freeform capture')).toHaveValue('Must not lose this raw capture');
  await expect(page.getByText('Saved original', { exact: true })).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await expect(page.getByLabel('Freeform capture')).toHaveValue('Must not lose this raw capture');
});

test('damaged storage is preserved rather than silently replaced', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('follow-through.prototype.v1', '{"version":99,"important":"retain"}'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Local changes are not saved' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('follow-through.prototype.v1'))).toBe('{"version":99,"important":"retain"}');
  await page.getByRole('button', { name: 'Back up existing data & start fresh' }).click();
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('follow-through.prototype.v1.backup.')))).toBe(true);
});

test('keyboard capture, focus and freeform text are safe', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByLabel('Freeform capture')).toBeFocused();
  await page.getByLabel('Freeform capture').fill('<img src=x onerror=alert(1)> remember the adapter');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Saved original', { exact: true })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Freeform capture')).not.toBeVisible();
});
