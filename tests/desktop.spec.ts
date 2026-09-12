import { expect } from '@playwright/test';
import { snapshotSchema } from '../src/platform/native.ts';
import { assertMigration, at, capture, checkMigratedReader, checkRelaunchedThreadLink, detail, inbox, legacyFixture, row, tasks } from './workspace-fixtures.ts';
import { evidence, gate, persisted, refresh, test, thread } from './native-fixture.ts';
import { rawMessage } from './conversation-fixture.ts';
import { ServiceError } from '../service/src/errors.ts';

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
