import { expect, type Page } from '@playwright/test';
import { test as nativeTest } from './native-fixture.ts';
import { catalog } from '../src/themes/controller.ts';

nativeTest.use({ referenceWorkspace: false });

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: 'Appearance', exact: true });
}
async function painted(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      name: root.dataset.theme, tone: root.dataset.themeTone,
      surface: getComputedStyle(root).getPropertyValue('--surface').trim(),
      scheme: getComputedStyle(root).colorScheme,
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
    };
  });
}

nativeTest('desktop persists theme independently of task settings and paints it before React mounts', async ({ page, native }) => {
  native.appearance = { name: 'Fox', mode: 'light' };
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.getElementById('root')?.childElementCount) return;
      document.documentElement.dataset.firstPaintTheme = document.documentElement.dataset.theme;
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ranked Tasks' })).toBeVisible();
  expect(await painted(page)).toEqual({ name: 'Fox', tone: 'light', surface: '#f6f2ee', scheme: 'light', meta: '#f6f2ee' });
  await expect(page.locator('html')).toHaveAttribute('data-first-paint-theme', 'Fox');
  const appearance = await settings(page);
  await expect(appearance.getByRole('combobox', { name: 'Theme', exact: true }).locator('option')).toHaveCount(57);
  const instructions = await page.getByLabel('What should come first?').inputValue();
  await page.getByLabel('What should come first?').fill('Unsaved priority changes');
  await appearance.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('Tokyo Night');
  await appearance.getByLabel('Color mode').selectOption('dark');
  await expect.poll(() => native.appearance).toEqual({ name: 'Tokyo Night', mode: 'dark' });
  expect(native.state.work.settings.instructions).toBe(instructions);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'Tokyo Night');
  await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'dark');
  await expect.poll(() => native.appliedAppearance.at(-1)?.tone).toBe('dark');
  expect(native.appliedAppearance.at(-1)?.background).toBe((await painted(page)).surface);
});

nativeTest('System follows OS changes, explicit modes do not, and task dialogs share the theme', async ({ page, native }) => {
  native.appearance = { name: 'Fox', mode: 'system' };
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'dark');
  await expect.poll(() => native.appliedAppearance.at(-1)?.mode).toBe('system');
  const appearance = await settings(page);
  await appearance.getByLabel('Color mode').selectOption('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'light');
  await appearance.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('GitHub');
  await page.getByRole('button', { name: 'Add task', exact: false }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add task', exact: false })).toBeFocused();
  expect(native.requests).toEqual([]);
});

nativeTest('theme storage errors do not block tasks and have working retries', async ({ page, native }) => {
  native.failAppearanceRead = true;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ranked Tasks' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Could not read your theme');
  native.failAppearanceRead = false;
  native.appearance = { name: 'Fox', mode: 'light' };
  await page.getByRole('button', { name: 'Retry appearance' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const appearance = await settings(page);
  native.failAppearanceSave = true;
  await appearance.getByLabel('Color mode').selectOption('dark');
  await expect(page.getByRole('alert')).toContainText('not saved');
  expect(native.appearance.mode).toBe('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme-tone', 'dark');
  native.failAppearanceSave = false;
  await page.getByRole('button', { name: 'Retry appearance' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(native.appearance.mode).toBe('dark');
});

nativeTest('all catalog themes render on desktop and narrow settings without losing controls', async ({ page, native }, testInfo) => {
  await page.goto('/');
  const appearance = await settings(page);
  for (const theme of catalog) {
    await appearance.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme.name);
    for (const tone of ['dark', 'light'] as const) {
      await appearance.getByLabel('Color mode').selectOption(tone);
      const resolved = theme[tone] ?? theme.dark ?? theme.light!;
      expect((await painted(page)).surface).toBe(resolved.surface);
      await expect(appearance.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await appearance.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('Fox');
  await appearance.getByLabel('Color mode').selectOption('dark');
  await page.screenshot({ path: testInfo.outputPath('fox-dark-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await appearance.getByLabel('Color mode').selectOption('light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fox-light-narrow.png') });
  expect(native.requests).toEqual([]);
});
