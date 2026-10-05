import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, persisted, gate, type NativeMock } from './native-fixture.ts';
import { emptyWorkspace } from '../src/domain/live.ts';
import { createWorkProfile, switchWorkProfile } from '../src/work/profiles.ts';
import { snapshotSchema } from '../src/platform/native.ts';
import { encodeProfileFile, MAX_PROFILE_FILE_BYTES } from '../src/work/profile-files.ts';

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
  await expect(panel.getByRole('button', { name: 'Import profile', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Export profile', exact: true })).toBeFocused();
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

test('profile JSON export and import round-trip configuration, preserve other work and persist without network calls', async ({ page, native }, testInfo) => {
  profiles(native);
  const source = native.state;
  source.work.settings.instructions = 'Shared priorities';
  source.work.settings.model = 'collection-model';
  source.work.settings.workStyles = [{ id: 'quick', name: 'Quick wins', description: 'Small clear work' }];
  source.work.settings.schedule = { enabled: false, everyMinutes: 45 };
  source.work.sourceFilter = { selectedSources: [], collapsedProviders: ['github'] };
  source.tasks[0]!.notes = 'Private notes not to export';
  native.saved.snapshot!.workspace.state = source;
  const original = structuredClone(source);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /^Work profile / });
  const panel = page.getByRole('region', { name: 'Work profiles', exact: true });
  await trigger.click();
  await page.screenshot({ path: testInfo.outputPath('profile-menu-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('profile-menu-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export profile', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('github-projects-profile-default.json');
  const exported = testInfo.outputPath('profile.json');
  await download.saveAs(exported);
  expect(JSON.parse(await readFile(exported, 'utf8'))).toEqual({
    format: 'github-projects-work-profile', version: 1, name: 'Default', settings: original.work.settings,
  });
  await expect(trigger).toBeFocused();
  await trigger.click();
  await panel.getByRole('button', { name: 'Import profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import work profile' });
  await expect(dialog.getByLabel('Profile JSON file')).toBeFocused();
  await dialog.getByLabel('Profile JSON file').setInputFiles(exported);
  await expect(dialog.getByLabel('Profile name')).toHaveValue('Default');
  await dialog.getByRole('button', { name: 'Import profile', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('must be unique');
  await expect(trigger).toHaveAccessibleName('Work profile Default');
  await dialog.getByLabel('Profile name').fill('Shared');
  await page.screenshot({ path: testInfo.outputPath('profile-import-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Import profile', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('profile-import-mobile.png') });
  await dialog.getByRole('button', { name: 'Import profile', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('Shared');
  await persisted(page);
  expect(native.state.tasks).toEqual([]);
  expect(native.state.work.sourceFilter).toBeUndefined();
  expect(native.state.work.settings).toEqual(original.work.settings);
  expect(native.state.inactiveWorkProfiles.find(profile => profile.id === 'default')).toEqual({
    ...original.activeWorkProfile, work: original.work, tasks: original.tasks, undo: original.undo,
  });
  await page.reload();
  await expect(trigger).toHaveAccessibleName('Work profile Shared');
  expect(native.requests).toEqual([]);
});

test('profile import handles invalid files, cancellation and enabled schedules without automatic collection', async ({ page, native }) => {
  profiles(native);
  const file = JSON.parse(encodeProfileFile(native.state));
  file.settings.schedule.enabled = true;
  await page.goto('/');
  await persisted(page);
  const original = structuredClone(native.state);
  const trigger = page.getByRole('button', { name: /^Work profile / });
  const open = async () => {
    await trigger.click();
    await page.getByRole('region', { name: 'Work profiles', exact: true }).getByRole('button', { name: 'Import profile', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Import work profile' });
  const input = dialog.getByLabel('Profile JSON file');
  const submit = dialog.getByRole('button', { name: 'Import profile', exact: true });
  for (const buffer of [Buffer.from('{'), Buffer.from(JSON.stringify({ ...file, version: 2 })),
    Buffer.from(JSON.stringify({ ...file, settings: { ...file.settings, streams: [{}] } })),
    Buffer.alloc(MAX_PROFILE_FILE_BYTES + 1, ' ')]) {
    await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(native.state).toEqual(original);
  }
  await input.setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(dialog.getByLabel('Profile name')).toHaveValue('Default');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(native.state).toEqual(original);
  await open();
  await input.setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await dialog.getByLabel('Profile name').fill('Imported');
  await submit.click();
  await persisted(page);
  expect(native.state.work.settings.schedule.enabled).toBe(false);
  expect(native.requests).toEqual([]);
});

test('profile selector blocks importing during a run but keeps configuration export available', async ({ page, native }) => {
  profiles(native);
  native.holdRank = gate();
  await page.goto('/');
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => native.requests.some(request => request.op === 'work.rank')).toBe(true);
  await page.getByRole('button', { name: /^Work profile / }).click();
  const panel = page.getByRole('region', { name: 'Work profiles', exact: true });
  await expect(panel.getByRole('button', { name: 'Import profile', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Add profile', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Export profile', exact: true })).toBeEnabled();
  native.holdRank.release();
  await expect(panel.getByRole('button', { name: 'Import profile', exact: true })).toBeEnabled();
});
