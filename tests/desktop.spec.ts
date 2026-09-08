import { expect, test, type Page } from '@playwright/test';
import { createDesktopState } from '../src/domain/live.ts';
import { applyCommand } from '../src/domain/engine.ts';

test.use({ timezoneId: 'America/Los_Angeles' });

async function desktopBridge(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isTauri', { value: true });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, unknown>) => {
        const data = JSON.parse(sessionStorage.getItem('desktop-workspace') || '{"revision":0,"state":null}');
        const calls: string[] = JSON.parse(sessionStorage.getItem('desktop-calls') || '[]');
        calls.push(command);
        sessionStorage.setItem('desktop-calls', JSON.stringify(calls));
        switch (command) {
          case 'workspace_load': return structuredClone(data);
          case 'workspace_save': {
            await new Promise(resolve => setTimeout(resolve, 15));
            if (sessionStorage.getItem('fail-save')) throw new Error('Disk is full');
            if (args.expectedRevision !== data.revision) throw new Error('Revision conflict');
            const next = { revision: data.revision + 1, state: args.state };
            sessionStorage.setItem('desktop-workspace', JSON.stringify(next));
            return next.revision;
          }
          case 'connection_status':
          case 'configure_tools':
            return {
              github: { available: true, authenticated: false, path: '/opt/homebrew/bin/gh', error: 'GitHub is offline for this test.' },
              copilot: { available: true, path: '/usr/local/bin/copilot' }, databasePath: '/example/workspace.sqlite3',
            };
          case 'github_sync': {
            if (!sessionStorage.getItem('sync-success')) throw new Error('GitHub is offline for this test.');
            const now = new Date().toISOString().replace('Z', '123456+00:00');
            const issue = sessionStorage.getItem('sync-issue') === 'yes';
            const url = `https://github.com/example/work/${issue ? 'issues' : 'pull'}/42`;
            return {
              fetchedAt: now, login: 'example-user', warnings: [],
              pings: JSON.parse(sessionStorage.getItem('github-pings') || '[]'),
              items: sessionStorage.getItem('sync-empty') ? [] : [{
                id: `github:${url}:${issue ? 'reply' : 'review'}`, title: 'Review the native snapshot', kind: issue ? 'mention' : 'review', status: 'available',
                createdAt: now, updatedAt: now,
                sources: [{ id: 'direct', kind: 'github', label: 'Direct review request', reference: url }],
                notes: '', steps: [], nextStep: 'Review the requested pull request.',
                ...(issue ? {} : { review: { identity: url, request: 'direct', lines: 15, files: 2 } }),
              }],
            };
          }
          case 'interpret_capture': {
            if (!data.state?.captures.some((capture: { original: string }) => capture.original === args.text)) {
              throw new Error('The model was called before the original capture was saved.');
            }
            if (sessionStorage.getItem('fail-ai')) throw new Error('Copilot sign-in required');
            return { kind: 'task', title: args.text, nextStep: 'Write the first paragraph.', explanation: 'A concrete next step for your saved task.' };
          }
          case 'prioritize_work': throw new Error('Copilot ranking is offline for this test.');
          case 'workspace_export': return true;
          case 'open_github': return null;
          case 'plugin:event|listen': return 1;
          case 'plugin:event|unlisten': return null;
          case 'notification_status': return { permission: 'prompt' };
          case 'request_notification_permission': return { permission: 'denied' };
          case 'cancel_copilot': return null;
          default: throw new Error(`Unexpected IPC command: ${command}`);
        }
      },
    } });
    Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: () => undefined } });
  });
}

test.beforeEach(async ({ page }) => {
  await desktopBridge(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible();
});

test('real native timestamp precision survives refresh and becomes the saved recommendation', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sync-success', 'yes'));
  await page.getByRole('button', { name: 'Refresh GitHub', exact: true }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the native snapshot');
  await expect(page.getByRole('heading', { name: 'GitHub refresh failed' })).not.toBeVisible();
  await expect(page.getByText('Saved on this Mac')).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-workspace')!).state);
  expect(stored.sync.status).toBe('ok');
  expect(stored.sync.login).toBe('example-user');
  expect(stored.items).toHaveLength(1);
});

test('first-run import keeps automatically discovered GitHub work', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sync-success', 'yes'));
  await page.getByRole('button', { name: 'Refresh GitHub', exact: true }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the native snapshot');
  const backup = applyCommand(createDesktopState(), { type: 'capture', id: 'imported', text: 'Write the imported plan' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'captures.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect.poll(async () => page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-workspace')!).state.captures.length)).toBe(1);
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-workspace')!).state);
  expect(stored.items).toHaveLength(2);
  expect(stored.items.some((item: { title: string }) => item.title === 'Review the native snapshot')).toBe(true);
  expect(stored.captures[0].original).toBe('Write the imported plan');
});

test('desktop starts without sample work and saves captures before asking Copilot', async ({ page }, testInfo) => {
  await expect(page.getByRole('heading', { name: 'GitHub refresh failed' })).toBeVisible();
  await expect(page.getByText('Browser prototype', { exact: false })).not.toBeVisible();
  await expect(page.getByText('Review the retry backoff fix', { exact: false })).not.toBeVisible();
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await page.getByLabel('Freeform capture').fill('Write the release plan');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByText('A concrete next step for your saved task.')).toBeVisible();
  await page.getByRole('button', { name: 'Close capture' }).click();
  await page.getByRole('button', { name: 'Start action', exact: true }).click();
  await page.getByLabel('Scratch notes for Write the release plan').fill('Resume with the migration risks.');
  await expect(page.getByText('Saved on this Mac')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Scratch notes for Write the release plan')).toHaveValue('Resume with the migration risks.');
  await expect(page.locator('.focus-work')).toContainText('Active - stays here');
  await page.screenshot({ path: testInfo.outputPath('desktop-live.png'), fullPage: true });
});

test('failed durable capture retains its draft and can be recovered without duplication', async ({ page }) => {
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await page.getByLabel('Freeform capture').fill('Do not lose this commitment');
  await expect(page.getByText('Saved on this Mac')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('fail-save', 'yes'));
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local changes are not saved' })).toBeVisible();
  await expect(page.getByLabel('Freeform capture')).toHaveValue('Do not lose this commitment');
  await expect(page.getByText('Saved original', { exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-calls')!).includes('interpret_capture'))).toBe(false);
  await page.evaluate(() => sessionStorage.removeItem('fail-save'));
  await page.getByRole('button', { name: 'Retry local storage' }).click();
  await expect(page.getByText('A concrete next step for your saved task.')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-workspace')!).state.captures.length)).toBe(1);
});

test('manual daily routines work when Copilot cannot interpret a capture', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('fail-ai', 'yes'));
  await page.getByRole('button', { name: /^Capture(?: Cmd K)?$/ }).click();
  await page.getByLabel('Freeform capture').fill('Prepare the daily rollout');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Prepare the daily rollout' })).toBeVisible();
  await page.getByRole('button', { name: /View & edit action/ }).click();
  await page.getByText('Edit action', { exact: false }).click();
  await page.getByLabel('Make this a daily routine').check();
  await page.getByLabel('Routine timezone').selectOption('America/Los_Angeles');
  await page.getByLabel('Daily due time').fill('10:00');
  await page.getByLabel('Ordered steps').fill('Announce the rollout\nIncrease the flag');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Action updated.', { exact: true })).toBeVisible();
  const routine = await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-workspace')!).state.items[0].routine);
  expect(routine.timeZone).toBe('America/Los_Angeles');
  expect(routine.time).toBe('10:00');
  await page.reload();
  await expect(page.locator('.later-section')).toContainText('1');
});

test('connections distinguish denied notifications and show local lifecycle', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('GitHub CLI')).toHaveCount(1);
  await page.getByRole('button', { name: 'Enable reminders' }).click();
  await expect(page.getByRole('alert')).toContainText('Notifications are not allowed');
  await expect(page.getByText(/Closing the window keeps the menu-bar app running/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('connections-narrow.png'), fullPage: true });
});

for (const kind of ['mention', 'review-request'] as const) {
  test(`sleeping work stays quiet through refresh and reload, then wakes on a new ${kind}`, async ({ page }, testInfo) => {
    await expect(page.getByText('Saved on this Mac')).toBeVisible();
    await page.clock.install({ time: new Date(Date.now() + 60_000) });
    await page.evaluate(issue => {
      sessionStorage.removeItem('desktop-workspace');
      sessionStorage.setItem('sync-success', 'yes');
      if (issue) sessionStorage.setItem('sync-issue', 'yes');
    }, kind === 'mention');
    await page.reload();
    await expect(page.locator('.focus-work')).toContainText('Review the native snapshot');
    await page.getByRole('button', { name: 'Sleep', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: /Wake on a new @mention/ })).toBeChecked();
    if (kind === 'mention') {
      await page.screenshot({ path: testInfo.outputPath('sleep-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('sleep-narrow.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.getByRole('button', { name: 'Put to sleep', exact: true }).click();
    await expect(page.getByText('Sleeping in Later. Your place is saved.')).toBeVisible();
    await expect(page.locator('.focus-work')).toHaveCount(0);
    await page.locator('.later-section > summary').click();
    await expect(page.locator('.later-section')).toContainText('Sleeping until a new @mention or review request');
    await page.getByRole('button', { name: 'Refresh GitHub', exact: true }).click();
    await expect(page.getByText('Saved on this Mac')).toBeVisible();
    await page.reload();
    await expect(page.locator('.focus-work')).toHaveCount(0);
    await expect(page.getByText('Saved on this Mac')).toBeVisible();
    await page.clock.runFor(2_000);
    await page.evaluate(pingKind => {
      const url = `https://github.com/example/work/${pingKind === 'mention' ? 'issues' : 'pull'}/42`;
      sessionStorage.setItem('github-pings', JSON.stringify([{ reference: url, kind: pingKind, at: new Date().toISOString() }]));
      sessionStorage.setItem('sync-empty', 'yes');
    }, kind);
    await page.getByRole('button', { name: 'Refresh GitHub', exact: true }).click();
    await expect(page.locator('.focus-work')).toContainText(kind === 'mention'
      ? 'Awake: someone mentioned you on GitHub.' : 'Awake: your review was requested.');
    await expect(page.getByText('Saved on this Mac')).toBeVisible();
    await page.reload();
    await expect(page.locator('.focus-work')).toContainText('Review the native snapshot');
  });
}

test('local work sleeps until its chosen local time while GitHub is offline', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-08T18:00:00Z') });
  const state = applyCommand(createDesktopState('2026-09-08T18:00:00Z'), { type: 'capture', id: 'local', text: 'Write the plan' });
  await page.addInitScript(saved => sessionStorage.setItem('desktop-workspace', JSON.stringify({ revision: 1, state: saved })), state);
  await page.reload();
  await expect(page.locator('.focus-work')).toContainText('Write the plan');
  await page.getByRole('button', { name: 'Sleep', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Wake on a new @mention/ })).toHaveCount(0);
  await page.getByLabel('Wake at', { exact: false }).fill('2026-09-08T11:02');
  await page.getByRole('button', { name: 'Put to sleep', exact: true }).click();
  await expect(page.locator('.focus-work')).toHaveCount(0);
  await expect(page.getByText('Saved on this Mac')).toBeVisible();
  await page.clock.runFor(120_000);
  await expect(page.locator('.focus-work')).toContainText('Awake: your chosen time has arrived.');
  await expect(page.locator('.focus-work')).toContainText('Write the plan');
});

test('sleep can be cancelled, manually woken, and undone without mandatory notes', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sync-success', 'yes'));
  await page.getByRole('button', { name: 'Refresh GitHub', exact: true }).click();
  await expect(page.locator('.focus-work')).toContainText('Review the native snapshot');
  await page.getByRole('button', { name: 'Sleep', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Put to sleep', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sleep', exact: true }).click();
  await page.getByRole('button', { name: 'Put to sleep', exact: true }).click();
  await expect(page.locator('.focus-work')).toHaveCount(0);
  await page.locator('.later-section > summary').click();
  await page.getByRole('button', { name: 'Wake Review the native snapshot', exact: true }).click();
  await expect(page.locator('.focus-work')).toContainText('You brought this action back.');
  await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
  await expect(page.locator('.focus-work')).toHaveCount(0);
  await expect(page.locator('.later-section')).toContainText('Sleeping until a new @mention');
});
