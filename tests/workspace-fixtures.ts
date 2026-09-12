import { expect, test as base, type Page } from '@playwright/test';
import type { AppState, LegacyAction, LegacyState } from '../src/types.ts';

export const storageKey = 'github-projects:greenfield-prototype:v1';
export const at = '2026-09-11T17:00:00Z';
export const detail = (page: Page) => page.getByRole('article', { name: 'Selected item' });
export const inbox = (page: Page) => page.getByRole('navigation', { name: 'Inboxes' }).getByRole('button', { name: /^Inbox/ });
export const tasks = (page: Page) => page.getByRole('navigation', { name: 'Inboxes' }).getByRole('button', { name: /^Tasks/ });
export const row = (page: Page, key: string) => page.locator(`[data-row-key="${key}"] .row-select`);

export const test = base.extend<{ noUnexpectedBrowserRequests: void }>({
  noUnexpectedBrowserRequests: [async ({ page }, use) => {
    const unexpected: string[] = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' || ['fetch', 'xhr'].includes(request.resourceType())) {
        unexpected.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    await use();
    expect(unexpected, 'No browser network/model calls or unhandled errors').toEqual([]);
  }, { auto: true }],
});

export async function saved(page: Page): Promise<AppState> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!).state, storageKey);
}

export async function capture(page: Page, text: string) {
  await page.getByRole('button', { name: /^Capture/ }).click();
  await page.getByLabel('What do you want to remember?').fill(text);
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await expect(detail(page).getByRole('heading')).toHaveText(text);
}

export function legacyFixture(desktop = false): LegacyState {
  const linked = { threadId: '123', eventIds: ['request-1'] };
  const action = (id: string, title: string, notes: string): LegacyAction => ({
    id, title, notes, eventIds: [], status: 'available', project: 'Original project\nKeep this text',
    nextStep: 'Original next step', captures: [],
    steps: [
      { id: `${id}-announce`, title: 'Announce the change', doneAt: '2026-09-10T17:01:00Z' },
      { id: `${id}-increase`, title: 'Increase the flag' },
    ],
    origin: 'github', createdAt: at, interpretation: 'none',
  });
  return {
    version: 2, runtime: desktop ? 'desktop' : 'demo', clock: at, timeZone: 'UTC',
    threads: [{
      id: '123', repo: 'octo/project', number: 123, kind: 'pr', title: 'Requested review 123',
      reason: 'review_requested', state: 'open', notification: 'unread', subscribed: true,
      ...(desktop ? { source: 'github' as const } : {}),
      events: [{ id: 'request-1', threadId: '123', kind: 'review-request', at, actor: 'octocat',
        summary: 'Review the requested changes.', requestState: 'current', rawKind: 'review-request' }],
    }],
    actions: [
      { ...action('generated-1', 'My earlier title', 'First distinct annotation'), ...linked },
      { ...action('generated-2', 'A different follow-up', 'Second distinct annotation'), ...linked,
        status: 'done', completedAt: at },
      { ...action('captured', 'My edited captured task', 'Captured thread annotation'), ...linked, origin: 'capture',
        captures: ['  Review https://github.com/octo/project/pull/123\nOriginal second line  '],
        status: 'done', completedAt: at },
      { ...action('routine', 'Announce, then increase', 'Routine notes'), origin: 'capture',
        captures: ['Every day at 10am, announce, then increase'], status: 'later', remindAt: '2026-09-12T10:00:00Z',
        routine: { time: '10:00', timeZone: 'UTC', dueAt: at, nextDueAt: '2026-09-12T10:00:00Z',
          history: [{ dueAt: '2026-09-10T10:00:00Z', status: 'done',
            steps: [{ id: 'history-step', title: 'Historic announcement', doneAt: '2026-09-10T10:01:00Z' }] }] } },
    ],
    selectedKey: 'a:generated-1', activeId: 'generated-1', view: 'attention',
    staged: [], handled: [], seen: [], order: ['t:123', 'a:generated-1', 'a:generated-2', 'a:captured', 'a:routine'],
    newKeys: [], draft: '', refresh: { lastSuccessAt: null, status: 'saved', message: 'Saved legacy workspace' },
    failures: { refresh: 'none', storage: false, interpretation: false, external: false },
    undo: [], sequence: 100, operations: [],
  };
}

export function assertMigration(state: AppState, legacy: LegacyState) {
  expect(state.version).toBe(3);
  expect(state.tasks.map(task => task.id)).toEqual(['captured', 'routine']);
  expect(state.notes.map(note => ({ id: note.id, threadId: note.threadId, text: note.text, sourceTitle: note.sourceTitle }))).toEqual(
    legacy.actions.slice(0, 3).map(action => ({ id: action.id, threadId: '123', text: action.notes, sourceTitle: action.title })),
  );
  for (const action of legacy.actions) {
    const { title, notes, ...history } = action;
    if (action.id.startsWith('generated-')) {
      expect(state.notes.find(note => note.id === action.id)?.history).toEqual(history);
    } else {
      expect(state.tasks.find(task => task.id === action.id)).toEqual({
        id: action.id, title, notes: action.threadId ? '' : notes, status: action.id === 'captured' ? 'done' : 'open',
        createdAt: action.createdAt, ...(action.completedAt ? { completedAt: action.completedAt } : {}),
        ...(action.threadId ? { threadId: action.threadId } : {}), history,
      });
    }
  }
  expect(state.selectedKey).toBe('t:123');
  expect(state.view).toBe('inbox');
  expect(state).not.toHaveProperty('activeId');
  expect(state).not.toHaveProperty('actions');
}

export async function checkMigratedReader(page: Page) {
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First distinct annotation');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Second distinct annotation');
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
  await page.getByLabel('Thread notes', { exact: true }).fill('First independently edited annotation');
  await page.getByLabel('Thread note 2').fill('Second independently edited annotation');
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
  await tasks(page).click();
  await expect(page.locator('.work-row')).toHaveCount(2);
  await page.getByRole('region', { name: 'Completed tasks' }).getByRole('button', { name: /My edited captured task/ }).click();
  await expect(page.getByLabel('Task notes')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await detail(page).getByText('Preserved action history', { exact: true }).click();
  await expect(detail(page).locator('blockquote')).toHaveText('  Review https://github.com/octo/project/pull/123\nOriginal second line  ');
  await detail(page).getByRole('button', { name: 'Open thread notes' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First independently edited annotation');
  await tasks(page).click();
  await row(page, 'a:routine').click();
  await expect(page.getByLabel('Task notes')).toHaveValue('Routine notes');
  await detail(page).getByText('Preserved action history', { exact: true }).click();
  await expect(detail(page)).toContainText('Reminders retired');
  await detail(page).getByText('Original record', { exact: true }).click();
  const history = JSON.parse(await detail(page).locator('.history-record').innerText());
  const { title: _title, notes: _notes, ...expected } = legacyFixture().actions[3]!;
  expect(history).toEqual(expected);
  await expect(detail(page).getByRole('checkbox')).toHaveCount(1);
}

export async function checkRelaunchedThreadLink(page: Page) {
  await tasks(page).click();
  await row(page, 'a:captured').click();
  await expect(page.getByLabel('Task notes')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Done', exact: true })).toBeChecked();
  await detail(page).getByRole('button', { name: 'Open thread notes' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByLabel('Thread notes', { exact: true })).toHaveValue('First independently edited annotation');
  await expect(page.getByLabel('Thread note 2')).toHaveValue('Second independently edited annotation');
  await expect(page.getByLabel('Thread note 3')).toHaveValue('Captured thread annotation');
}
