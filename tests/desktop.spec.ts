import { expect, test, type Page } from '@playwright/test';
import { requestSchema, type Evidence, type Request, type Thread } from '../service/src/schema.ts';
import { snapshotSchema, type NativeSnapshot, type NativeWorkspace } from '../src/platform/native.ts';
import { desktopEnvelopeSchema } from '../src/runtime/desktop-workspace.ts';

const at = '2026-09-11T17:00:00Z';
function evidence(id = 'request-1', kind: Evidence['kind'] = 'review-request'): Evidence {
  return { id, kind, at, actor: 'octocat', text: 'Review the requested changes.',
    recipient: { kind: 'user', login: 'viewer', isViewer: true },
    requestState: kind === 'review-request' ? 'current' : 'not-request', textTruncated: false };
}
function thread(events = [evidence()], id = '123'): Thread {
  return { id, reference: { repo: 'octo/project', number: Number(id), kind: 'pr' }, title: `Requested review ${id}`,
    reason: 'review_requested', notification: 'unread', updatedAt: at, lastReadAt: null, state: 'open',
    size: { additions: 20, deletions: 2, changedFiles: 1 }, subscription: 'subscribed', evidence: events,
    coverage: { timeline: 'complete', newestPage: 1, fetchedPages: [1], observedAt: at } };
}
function batch(threads: Thread[], partial = false) {
  return { batchId: crypto.randomUUID(), fetchedAt: new Date().toISOString(), viewer: 'viewer',
    status: partial ? 'partial' : 'complete', threads,
    diagnostics: partial ? [{ scope: 'timeline', code: 'access', threadId: '123', message: 'Some timeline evidence is unavailable.' }] : [],
    coverage: { notifications: partial ? 'partial' : 'complete', pages: 1, received: threads.length, returned: threads.length, missingMeansDone: false } };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class NativeMock {
  saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  calls: string[] = [];
  requests: Request[] = [];
  now = at;
  threads = [thread()];
  partial = false;
  corrupt = false;
  failWrite = false;
  failSdk = false;
  holdRead?: ReturnType<typeof gate>;
  holdRefresh?: ReturnType<typeof gate>;
  holdWrite?: ReturnType<typeof gate>;
  holdSdk?: ReturnType<typeof gate>;
  permission = 'not-determined';
  get state() { return desktopEnvelopeSchema.parse(this.saved.snapshot!.workspace).state; }
  private async invoke(command: string, args: Record<string, unknown>) {
    this.calls.push(command);
    if (command === 'workspace_read') {
      if (this.holdRead) await this.holdRead.promise;
      if (this.corrupt) throw new Error('Saved workspace is damaged. Recover explicitly.');
      return structuredClone(this.saved);
    }
    if (command === 'clock_now') return { now: this.now, timeZone: 'UTC', error: null };
    if (command === 'workspace_save') {
      if (this.corrupt) throw new Error('Saved workspace is damaged.');
      expect(args.expectedRevision).toBe(this.saved.revision);
      this.saved = { revision: crypto.randomUUID(), snapshot: snapshotSchema.parse(args.snapshot), savedAt: this.now };
      return structuredClone(this.saved);
    }
    if (command === 'reminders_status') return { revision: this.saved.revision, permission: { state: this.permission, alertsEnabled: this.permission === 'granted' },
      deliveries: [], limitations: 'Closing keeps reminders running. Quit stops them. Sleep and Focus may delay delivery.' };
    if (command === 'reminders_request_permission') { this.permission = 'granted'; return { state: this.permission, alertsEnabled: true }; }
    if (command === 'workspace_list_backups') return [];
    if (command === 'workspace_export_raw') return { id: crypto.randomUUID(), directory: 'isolated-test-export' };
    if (command === 'launch_github' || command === 'launch_copilot') return { status: 'dispatch-requested', url: 'https://github.com/octo/project/pull/123' };
    if (command !== 'service_request') throw new Error(`Unexpected command ${command}`);
    const request = requestSchema.parse(args.request);
    this.requests.push(request);
    let result: unknown;
    switch (request.op) {
      case 'connection.check':
        result = { github: { available: true, viewer: 'viewer', scopes: ['repo'] }, copilot: { available: true } };
        break;
      case 'github.refresh':
        if (this.holdRefresh) await this.holdRefresh.promise;
        result = batch(this.threads, this.partial);
        break;
      case 'github.acknowledge':
      case 'github.unsubscribe':
        expect(this.state.operations.find(operation => operation.id === request.input.operationId)?.status).toBe('pending');
        if (this.holdWrite) await this.holdWrite.promise;
        if (this.failWrite) throw new Error('GitHub write unavailable; no success was confirmed.');
        result = { ...request.input, action: request.op === 'github.acknowledge' ? 'acknowledge' : 'unsubscribe', status: 'confirmed', confirmedAt: new Date().toISOString() };
        break;
      case 'copilot.triage':
        if (this.holdSdk) await this.holdSdk.promise;
        if (this.failSdk) throw new Error('Copilot structured output failed. Retry explicitly.');
        result = { previewOnly: true, suggestedOrder: request.input.items.map(item => item.itemId).reverse(),
          suggestions: request.input.items.map(item => ({ itemId: item.itemId, evidenceIds: [item.evidence[0]!.id], summary: 'A bounded evidence preview.', uncertainty: 'Inspect the source.', nextAction: 'inspect' })) };
        break;
      case 'copilot.reconsider':
        result = { previewOnly: true, suggestedOrder: request.input.items.map(item => item.itemId).reverse(),
          reasons: request.input.items.map(item => ({ itemId: item.itemId, reason: 'Consider this available work.' })) };
        break;
      case 'copilot.interpretCapture':
        expect(this.state.actions.some(action => action.id === request.input.captureId && action.captures.includes(request.input.text))).toBe(true);
        if (this.failSdk) throw new Error('Copilot structured output failed. Retry explicitly.');
        result = { previewOnly: true, captureId: request.input.captureId, proposal: { kind: 'action', title: 'Editable interpreted action',
          steps: ['Inspect the source'], dailyAt: null, timeZone: request.input.timeZone, uncertainty: 'Confirm the proposed scope.' } };
        break;
      case 'cancel': result = { requestId: request.input.requestId, cancelled: true }; break;
    }
    return { v: 1, id: request.id, ok: true, result };
  }
  async install(page: Page) {
    await page.exposeFunction('nativeInvoke', async (command: string, args: Record<string, unknown>) => {
      try { return { value: await this.invoke(command, args) }; }
      catch (error) { return { failure: { code: 'io', message: error instanceof Error ? error.message : 'Native test failure', retryable: true } }; }
    });
    await page.addInitScript(() => {
      const callbacks = new Map<number, (event: unknown) => void>();
      let callbackId = 0;
      let listener = 0;
      const target = window as unknown as {
        isTauri: boolean; __TAURI_INTERNALS__: object; __TAURI_EVENT_PLUGIN_INTERNALS__: object;
        nativeInvoke(command: string, args: Record<string, unknown>): Promise<{ value?: unknown; failure?: unknown }>;
        emitNativeTick(payload: unknown): void;
      };
      target.isTauri = true;
      target.__TAURI_INTERNALS__ = {
        transformCallback(callback: (event: unknown) => void) { callbacks.set(++callbackId, callback); return callbackId; },
        unregisterCallback(id: number) { callbacks.delete(id); },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          if (command === 'plugin:event|listen') { listener = Number(args.handler); return 1; }
          if (command === 'plugin:event|unlisten') return null;
          const reply = await target.nativeInvoke(command, args);
          if (reply.failure) throw reply.failure;
          return reply.value;
        },
      };
      target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      target.emitNativeTick = payload => callbacks.get(listener)?.({ event: 'workspace://tick', id: 1, payload });
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Desktop must never access browser localStorage'); } });
    });
  }
  async tick(page: Page, now: string) {
    this.now = now;
    await page.evaluate(now => {
      (window as unknown as { emitNativeTick(payload: unknown): void }).emitNativeTick({ clock: { now, timeZone: 'UTC', error: null }, reminders: null, error: null });
    }, now);
  }
}
const detail = (page: Page) => page.getByRole('article', { name: 'Selected item' });
async function refresh(page: Page) {
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
}
async function capture(page: Page, text: string) {
  await page.getByRole('button', { name: /^Capture/ }).first().click();
  await page.getByLabel('What do you want to remember?').fill(text);
  await page.getByRole('button', { name: 'Save capture' }).click();
}

test('empty native load waits for SQLite, avoids demo/storage/network, and persists capture/notes/relaunch', async ({ page }, testInfo) => {
  const native = new NativeMock(); native.holdRead = gate(); await native.install(page);
  await page.goto('/');
  await expect(page.getByText('Reading saved work...')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  native.holdRead.release();
  await expect(page.getByRole('region', { name: 'Working on' })).toContainText('Choose an action');
  await expect(page.getByRole('button', { name: /Demo scenarios/ })).toHaveCount(0);
  expect(native.requests).toEqual([]);
  await capture(page, 'Persistent desktop capture');
  await page.getByLabel('A note for when you return').fill('Private note survives relaunch');
  await expect(page.getByLabel('A note for when you return')).toBeFocused();
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  await expect.poll(() => native.state.actions[0]?.notes).toBe('Private note survives relaunch');
  const active = native.state.activeId;
  await page.reload();
  await expect(page.getByLabel('A note for when you return')).toHaveValue('Private note survives relaunch');
  expect(native.state.activeId).toBe(active);
  expect(native.requests).toEqual([]);
  expect(native.calls).not.toContain('reminders_request_permission');
  await page.screenshot({ path: testInfo.outputPath('desktop.png') });
});

test('in-flight refresh preserves typing, Done and selection; queue/sticky updates do not reopen reviews', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/'); await refresh(page);
  await page.locator('.row-select').first().click();
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByLabel('A note for when you return').fill('Typed while refreshing');
  await expect(page.getByLabel('A note for when you return')).toBeFocused();
  await detail(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => native.state.actions[0]?.status).toBe('done');
  const selected = native.state.selectedKey;
  native.threads = [thread([evidence(), evidence('queue', 'merge-queue')])];
  native.holdRefresh.release(); native.holdRefresh = undefined;
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(native.state.actions[0]!.notes).toBe('Typed while refreshing');
  expect(native.state.selectedKey).toBe(selected);
  expect(native.state.actions[0]!.status).toBe('done');
  await expect(page.locator('.work-row')).toContainText('informational update');
  native.threads = [{ ...thread([evidence(), evidence('comment', 'comment')]), reason: 'mention' }];
  await refresh(page);
  expect(native.state.actions[0]!.status).toBe('done');
  native.threads = [thread([evidence(), evidence('new-request')])];
  await refresh(page);
  await page.locator('.row-select').first().click();
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  await expect.poll(() => native.state.actions.length).toBe(2);
  expect(native.state.actions[0]!.status).toBe('done');
});

test('acknowledgement persists before dispatch and concurrent newer evidence survives completion', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/'); await refresh(page);
  await page.locator('.row-select').first().click();
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await detail(page).getByRole('button', { name: 'Mark notification done on GitHub' }).click();
  native.holdWrite = gate();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect.poll(() => native.requests.filter(request => request.op === 'github.acknowledge').length).toBe(1);
  native.threads = [thread([evidence(), evidence('later-request')])];
  native.holdRefresh.release(); native.holdRefresh = undefined;
  await expect.poll(() => native.state.threads[0]!.events.length).toBe(2);
  native.holdWrite.release(); native.holdWrite = undefined;
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  expect(native.state.handled).toContain('request-1');
  expect(native.state.handled).not.toContain('later-request');
  expect(native.state.actions[0]!.status).toBe('available');
});

test('failed writes survive relaunch and retry is explicit with original operation context', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/'); await refresh(page);
  await page.locator('.row-select').first().click();
  native.failWrite = true;
  await detail(page).getByRole('button', { name: 'Unsubscribe on GitHub' }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByRole('dialog')).toContainText('write unavailable');
  await expect.poll(() => native.state.operations[0]?.status).toBe('failed');
  const id = native.state.operations[0]!.id;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
  expect(native.requests.filter(request => request.op === 'github.unsubscribe')).toHaveLength(1);
  native.failWrite = false;
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Review and retry' }).click();
  await page.getByRole('button', { name: 'Confirm GitHub change' }).click();
  await expect(page.getByText('GitHub confirmed the change')).toBeVisible();
  expect(native.state.operations[0]!.id).toBe(id);
  expect(native.state.threads[0]!.subscription).toBe('unsubscribed');
});

test('real SDK preview UI handles errors, rejects stale order and excludes private notes', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/'); await refresh(page);
  await page.locator('.row-select').first().click();
  await page.getByLabel('A note for when you return').fill('Never send this private note');
  native.failSdk = true;
  await page.getByRole('button', { name: 'Triage with Copilot', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('structured output failed');
  native.failSdk = false;
  await page.getByRole('button', { name: 'Retry Copilot preview' }).click();
  await expect(page.getByRole('dialog')).toContainText('Copilot considered 1 notifications');
  await page.getByRole('button', { name: 'Keep current order' }).click();
  native.holdRefresh = gate();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Triage with Copilot', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply suggested order' })).toBeEnabled();
  native.threads.push(thread([evidence('second-request')], '456'));
  native.holdRefresh.release(); native.holdRefresh = undefined;
  await expect.poll(() => native.state.threads.length).toBe(2);
  await page.getByRole('button', { name: 'Apply suggested order' }).click();
  await expect(page.getByRole('dialog')).toContainText('Work or evidence changed');
  expect(JSON.stringify(native.requests.filter(request => request.op.startsWith('copilot.')))).not.toContain('Never send');
});

test('capture interpretation previews editable proposal without losing original or notes', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/');
  await capture(page, 'Original capture stays verbatim');
  await page.getByLabel('A note for when you return').fill('Keep my edits');
  await page.getByRole('button', { name: 'Interpret with Copilot' }).click();
  await expect(page.getByLabel('Proposed action')).toHaveValue('Editable interpreted action');
  await page.getByLabel('Proposed action').fill('My edited proposal');
  await page.getByRole('button', { name: 'Apply proposal' }).click();
  await expect(detail(page).getByRole('heading', { name: 'My edited proposal' })).toBeVisible();
  expect(native.state.actions[0]!.captures).toEqual(['Original capture stays verbatim']);
  expect(native.state.actions[0]!.notes).toBe('Keep my edits');
});

test('manual routine native clock, snooze and missed days preserve current work and original timestamps', async ({ page }) => {
  const native = new NativeMock(); await native.install(page); await page.goto('/');
  await capture(page, 'Daily commitment');
  await page.getByRole('button', { name: 'Set up daily routine manually' }).click();
  await page.getByLabel('Daily time').fill('17:10');
  await page.getByLabel('Ordered steps').fill('Announce\nIncrease');
  await page.getByRole('button', { name: 'Save routine' }).click();
  await expect.poll(() => native.saved.snapshot?.reminders.length).toBe(1);
  const occurrence = native.saved.snapshot!.reminders[0]!.occurrenceId;
  await capture(page, 'Chosen current work');
  await detail(page).getByRole('button', { name: 'Work on this', exact: true }).click();
  await expect.poll(() => native.state.activeId).not.toBeNull();
  const active = native.state.activeId;
  await native.tick(page, '2026-09-11T17:10:00Z');
  await expect(page.getByRole('region', { name: 'Local reminders' })).toBeVisible();
  await page.getByRole('button', { name: 'Snooze 30m' }).click();
  await expect(page.getByRole('region', { name: 'Local reminders' })).toHaveCount(0);
  await expect.poll(() => native.saved.snapshot!.reminders[0]!.snoozedUntil).toBe('2026-09-11T17:40:00Z');
  expect(native.saved.snapshot!.reminders[0]!.occurrenceId).toBe(occurrence);
  await native.tick(page, '2026-09-11T17:40:00Z');
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await page.locator('.row-select').first().click();
  await detail(page).getByRole('checkbox').first().check();
  await expect.poll(() => native.state.actions[0]!.steps[0]!.doneAt).toBeTruthy();
  const timestamp = native.state.actions[0]!.steps[0]!.doneAt;
  await native.tick(page, '2026-09-14T17:40:00Z');
  await expect(detail(page)).toContainText('Recorded steps have not been repeated');
  expect(native.state.actions[0]!.steps[0]!.doneAt).toBe(timestamp);
  expect(native.state.activeId).toBe(active);
  expect(native.requests).toEqual([]);
});

test('actual team context and partial timeline errors remain explicit without inventing requests', async ({ page }) => {
  const native = new NativeMock();
  native.threads = [thread([{ ...evidence(), recipient: { kind: 'team', team: 'actual-org/actual-team', viewerMembership: 'member' } }])];
  await native.install(page); await page.goto('/'); await refresh(page);
  await expect(page.locator('.work-row')).toContainText('actual-org/actual-team');
  native.partial = true;
  native.threads = [{ ...thread([]), coverage: { timeline: 'unavailable', newestPage: 0, fetchedPages: [], observedAt: at } }];
  await refresh(page);
  await expect(page.getByText('Some activity could not be refreshed')).toBeVisible();
  await expect(page.locator('.work-row')).toContainText('Incomplete request evidence');
});

test('corrupt SQLite never exposes fixtures or an editable fallback', async ({ page }) => {
  const native = new NativeMock(); native.corrupt = true; await native.install(page); await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('damaged');
  await expect(page.getByRole('button', { name: /^Capture/ })).toHaveCount(0);
  expect(native.calls).not.toContain('workspace_save');
  expect(native.requests).toEqual([]);
});

test('native destinations and narrow list/back preserve work and keyboard focus', async ({ page }, testInfo) => {
  const native = new NativeMock(); await native.install(page); await page.setViewportSize({ width: 480, height: 844 }); await page.goto('/'); await refresh(page);
  await expect(page.locator('.work-row').getByRole('button', { name: 'Open on GitHub' })).toBeVisible();
  await page.locator('.row-select').first().click();
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.keyboard.press('Escape');
  await expect(detail(page).getByRole('button', { name: 'Review in Copilot' })).toBeFocused();
  await detail(page).getByRole('button', { name: 'Review in Copilot' }).click();
  await page.getByRole('button', { name: 'Request launch' }).click();
  await expect(page.getByText('Launch requested, not completed')).toBeVisible();
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator('.queue')).toBeVisible();
  expect(native.calls).toContain('launch_copilot');
  expect(native.state.actions).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow.png') });
});
