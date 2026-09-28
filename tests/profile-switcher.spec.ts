import { expect } from '@playwright/test';
import { test, persisted, type NativeMock } from './native-fixture.ts';
import { emptyWorkspace } from '../src/domain/live.ts';
import { createWorkProfile, switchWorkProfile } from '../src/work/profiles.ts';
import { snapshotSchema } from '../src/platform/native.ts';

test.use({ referenceWorkspace: false });

function profiles(native: NativeMock, names = ['On call']) {
  let state = emptyWorkspace(native.now, 'UTC');
  state.tasks = [{ id: 'manual', title: 'Keep working', notes: '', status: 'open', createdAt: native.now }];
  for (const name of names) state = createWorkProfile(state, name);
  state = switchWorkProfile(state, 'default');
  native.saved.snapshot = snapshotSchema.parse({ formatVersion: 1, reminders: [], workspace: { version: 1, state, scroll: {} } });
}

test('compact profile switcher preserves layout and selection, supports keyboard dismissal and returns focus from creation', async ({ page, native }) => {
  profiles(native);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Work profile Default', exact: true });
  const panel = page.getByRole('region', { name: 'Work profiles', exact: true });
  const close = page.getByRole('button', { name: 'Close work profiles', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(page.locator('.task-sidebar-bottom')).toContainText('Work profile');
  await expect(page.locator('.task-workspace')).not.toContainText('Work profile');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select task: Keep working' }).check();
  await page.locator('.task-row').click();
  const layout = await page.locator('.task-body').boundingBox();
  await trigger.focus();
  await trigger.press('Enter');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('id', (await trigger.getAttribute('aria-controls'))!);
  await expect(panel.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: 'On call', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.locator('.task-body').boundingBox()).toEqual(layout);
  const anchor = (await trigger.boundingBox())!;
  const bounds = (await panel.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(anchor.y - 8);
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('checkbox', { name: 'Select task: Keep working' })).toBeChecked();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();

  await trigger.press('Space');
  await close.focus();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await close.click();
  await expect(trigger).toBeFocused();
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await trigger.click();
  await expect(panel).toHaveCount(0);

  await trigger.click();
  await panel.getByRole('button', { name: 'Add profile', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(settings).toBeFocused();
  await expect(panel).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press('Shift+Tab');
  await expect(panel).toHaveCount(0);
  for (const control of [trigger, close]) {
    await trigger.click();
    await control.focus();
    await control.evaluate(element => element.blur());
    await expect(panel).toHaveCount(0);
    await expect(trigger).not.toBeFocused();
  }
  await trigger.click();
  await close.focus();
  await page.getByLabel('Task notes').click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel('Task notes')).toBeFocused();
  expect(await page.locator('.task-body').boundingBox()).toEqual(layout);

  await trigger.click();
  await panel.getByRole('button', { name: 'Add profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add work profile' });
  await expect(dialog.getByLabel('Profile name')).toBeFocused();
  await expect(panel).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('checkbox', { name: 'Select task: Keep working' })).toBeChecked();
  expect(native.requests).toEqual([]);
});

test('compact profile switcher fits long names and lists in narrow, short and scrolling sidebars', async ({ page, native }, testInfo) => {
  const names = Array.from({ length: 40 }, (_, index) => `Profile ${String(index).padStart(2, '0')} ${'x'.repeat(60)}`);
  profiles(native, names);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /^Work profile / });
  const panel = page.getByRole('region', { name: 'Work profiles', exact: true });
  await trigger.click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const bounds = await panel.boundingBox();
      return !!bounds && bounds.x >= 12 && bounds.y >= 12 && bounds.width > 0 && bounds.height > 0
        && bounds.x + bounds.width <= viewport.width - 12 && bounds.y + bounds.height <= viewport.height - 12;
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight > element.clientHeight)).toBe(true);
    await panel.getByRole('button', { name: names[39], exact: true }).focus();
    await expect(panel.getByRole('button', { name: names[39], exact: true })).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Add profile', exact: true })).toBeFocused();
    await expect(panel.getByRole('button', { name: 'Add profile', exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath('compact-profile-short.png') });
  await panel.getByRole('button', { name: names[39], exact: true }).click();
  await expect(trigger).toHaveAccessibleName(`Work profile ${names[39]}`);
  await expect(trigger).toBeFocused();
  await expect(panel).toHaveCount(0);
  await persisted(page);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close work profiles' })).toBeInViewport();
  await page.locator('.task-sidebar').evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => {
    const bounds = await panel.boundingBox();
    return !!bounds && bounds.y >= 12 && bounds.y + bounds.height <= 556;
  }).toBe(true);
  expect(native.requests).toEqual([]);
});

test('compact profile switcher stays available in Settings and exposes persistence failures', async ({ page, native }) => {
  profiles(native);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Work profile / }).click();
  native.failSave = true;
  await page.getByRole('region', { name: 'Work profiles', exact: true }).getByRole('button', { name: 'On call', exact: true }).click();
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('On call');
  await expect(page.getByRole('button', { name: 'Work profile On call', exact: true })).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Pending edits are not saved');
  native.failSave = false;
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await persisted(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Work profile On call', exact: true })).toBeVisible();
  expect(native.state.inactiveWorkProfiles.find(profile => profile.id === 'default')?.tasks[0]?.title).toBe('Keep working');
});
