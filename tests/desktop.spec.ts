import { expect } from '@playwright/test';
import { snapshotSchema } from '../src/platform/native.ts';
import { assertMigration, at, capture, checkMigratedReader, checkRelaunchedThreadLink, detail, inbox, legacyFixture, row, tasks } from './workspace-fixtures.ts';
import { evidence, gate, persisted, refresh, test, thread } from './native-fixture.ts';

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
  await detail(page).getByRole('button', { name: 'Mark notification done on GitHub' }).click();
  native.holdSave = gate();
  native.holdWrite = gate();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByText('Saving intent, then waiting for GitHub confirmation...')).toBeVisible();
  await expect.poll(() => native.activeSaves).toBe(1);
  expect(native.requests.filter(request => request.op === 'github.acknowledge')).toEqual([]);
  native.holdSave.release();
  native.holdSave = undefined;
  await expect.poll(() => native.requests.filter(request => request.op === 'github.acknowledge').length).toBe(1);
  const intent = structuredClone(native.state.operations[0]!);
  expect(intent.eventIds).toEqual(['request-1']);
  expect(intent.status).toBe('pending');
  native.threads = [thread([evidence(), evidence('later-request')])];
  native.holdRefresh.release();
  native.holdRefresh = undefined;
  await expect.poll(() => native.state.threads[0]!.events.length).toBe(2);
  native.holdWrite.release();
  native.holdWrite = undefined;
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  expect(native.state.handled).toEqual(['request-1']);
  expect(native.state.threads[0]?.notification).toBe('unread');
  expect(native.state.operations[0]).toMatchObject({ id: intent.id, status: 'confirmed', eventIds: ['request-1'] });
  expect(native.state.notes).toEqual(before.notes);
  expect(native.state.tasks).toEqual(before.tasks);
  await expect(page.locator('.queue')).toContainText('Requested review 123');
  expect(JSON.stringify(native.requests)).not.toContain('Private note');
});

for (const action of ['Mark notification done on GitHub', 'Unsubscribe on GitHub']) {
  test(`${action} retains separately editable notes under Earlier threads after relaunch`, async ({ page, native }) => {
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
    await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
    await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
    await page.getByRole('button', { name: 'Return to workspace' }).click();
    expect(native.state.tasks).toEqual(before.tasks);
    expect(native.state.notes).toEqual(before.notes);
    expect(action.startsWith('Mark') ? native.state.threads[0]?.notification : native.state.threads[0]?.subscription)
      .toBe(action.startsWith('Mark') ? 'done' : 'unsubscribed');
    await inbox(page).click();
    await page.locator('.earlier-threads > summary').click();
    await page.locator('.earlier-threads').locator('[data-row-key="t:123"] .row-select').click();
    await page.getByLabel('Thread note 2').fill('Second edited after acknowledgement');
    await persisted(page);
    await page.reload();
    await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First retained annotation');
    await expect(page.getByLabel('Thread note 2')).toHaveValue('Second edited after acknowledgement');
    expect(native.state.tasks).toEqual(before.tasks);
    expect(native.requests.map(request => request.op)).toEqual(['github.refresh', action.startsWith('Mark') ? 'github.acknowledge' : 'github.unsubscribe']);
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
