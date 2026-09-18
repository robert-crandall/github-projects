import { expect, test } from 'bun:test';
import { createNativePlatform, snapshotSchema, type NativeWorkspace } from '../platform/native.ts';
import { legacyFixture } from '../domain/test-fixtures.ts';
import { emptyWorkspace } from '../domain/live.ts';
import { reconcileWork } from '../work/engine.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';

const now = '2026-09-11T20:00:00Z';
function fixture(initial?: NativeWorkspace) {
  let saved: NativeWorkspace = initial ?? { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  const commands: string[] = [];
  const backups: NativeWorkspace[] = [];
  let fail = false;
  let failBackup = false;
  const platform = createNativePlatform(async (command, args) => {
    commands.push(command);
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now, timeZone: 'UTC', error: null };
    if (command === 'workspace_create_backup') {
      if (failBackup) throw { code: 'io', retryable: true, message: 'Backup failed' };
      expect(args?.expectedRevision).toBe(saved.revision);
      backups.push(structuredClone(saved));
      return { id: crypto.randomUUID(), createdAt: now };
    }
    if (command === 'workspace_save') {
      if (fail) throw { code: 'storage-unavailable', retryable: true, message: 'Storage unavailable; pending work is retained.' };
      if (args?.expectedRevision !== saved.revision) throw { code: 'revision-conflict', retryable: false, message: 'Saved copy changed.' };
      saved = { revision: crypto.randomUUID(), snapshot: snapshotSchema.parse(args?.snapshot), savedAt: now };
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command ${command}`);
  });
  return { platform, commands, backups, saved: () => saved, fail: (value: boolean) => { fail = value; }, failBackup: () => { failBackup = true; } };
}

test('native captures, notes and Done survive a fresh controller without model calls or reminder schedules', async () => {
  const mock = fixture();
  const first = new DesktopWorkspace(mock.platform);
  expect(first.getSnapshot().workspace).toBeNull();
  await first.load(); await first.flush();
  expect(first.state.tasks).toEqual([]);
  expect(first.state.threads).toEqual([]);
  expect(mock.commands).toEqual(['workspace_read', 'clock_now', 'workspace_save']);
  first.dispatch({ type: 'draft', text: 'Original capture\nMore text' });
  first.dispatch({ type: 'capture' });
  const key = first.state.selectedKey!;
  first.dispatch({ type: 'edit', key, notes: 'Private scratch note' });
  first.dispatch({ type: 'done', key });
  await first.flush();
  const second = new DesktopWorkspace(mock.platform);
  await second.load(); await second.flush();
  expect(second.state.tasks[0]!.title).toBe('Original capture\nMore text');
  expect(second.state.tasks[0]!.notes).toBe('Private scratch note');
  expect(second.state.tasks[0]!.status).toBe('done');
  expect(second.state.selectedKey).toBe(key);
  expect(second.state.view).toBe('tasks');
  expect(mock.saved().snapshot?.reminders).toEqual([]);
});

test('local changes use current timestamps without relying on retired native clock ticks', async () => {
  const mock = fixture();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load(); await workspace.flush();
  const before = Date.now();
  workspace.dispatch({ type: 'draft', text: 'Created now, not at launch' });
  workspace.dispatch({ type: 'capture' });
  await workspace.flush();
  expect(Date.parse(workspace.state.tasks[0]!.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(workspace.state.tasks[0]!.createdAt)).toBeLessThanOrEqual(Date.now());
  expect(mock.commands.filter(command => command === 'clock_now')).toHaveLength(1);
});

test('corrupt native load never exposes a writable empty fallback or overwrites saved data', async () => {
  const commands: string[] = [];
  const platform = createNativePlatform(async command => {
    commands.push(command);
    if (command === 'workspace_read') throw { code: 'storage-corrupt', retryable: false, message: 'Saved workspace is damaged. Recover explicitly.' };
    if (command === 'clock_now') return { now, timeZone: 'UTC', error: null };
    throw new Error('No write allowed');
  });
  const workspace = new DesktopWorkspace(platform);
  await workspace.load();
  expect(workspace.getSnapshot().workspace).toBeNull();
  expect(workspace.getSnapshot().loadError).toContain('damaged');
  expect(workspace.dispatch({ type: 'draft', text: 'Must not create fallback' })).toBe(false);
  expect(commands).toEqual(['workspace_read', 'clock_now']);
});

test('storage failure retains pending work and only explicit retry reports saved', async () => {
  const mock = fixture();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load(); await workspace.flush();
  mock.fail(true);
  workspace.dispatch({ type: 'draft', text: 'Retain this' });
  await expect(workspace.flush()).rejects.toThrow('Storage unavailable');
  workspace.dispatch({ type: 'draft', text: 'Newest pending capture' });
  expect(workspace.getSnapshot().persistence.pending).toBe(true);
  mock.fail(false);
  await workspace.retryStorage();
  expect(workspace.getSnapshot().persistence.pending).toBe(false);
  expect(workspace.getSnapshot().feedback).toContain('saved on this Mac');
});

function legacySnapshot(): NativeWorkspace {
  return {
    revision: crypto.randomUUID(), savedAt: now,
    snapshot: snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state: legacyFixture(true), scroll: {} },
      reminders: [{ id: 'routine', occurrenceId: 'routine:old', dueAt: now, timeZone: 'UTC', daily: { time: '10:00', timeZone: 'UTC' } }] }),
  };
}

test('desktop migration backs up v2 before saving notes and Tasks with schedules cleared atomically', async () => {
  const original = legacySnapshot();
  const mock = fixture(original);
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load(); await workspace.flush();
  expect(mock.commands).toEqual(['workspace_read', 'clock_now', 'workspace_create_backup', 'workspace_save']);
  expect(mock.backups).toEqual([original]);
  expect(mock.saved().snapshot?.reminders).toEqual([]);
  expect(workspace.state.notes.map(note => note.text)).toEqual(['First distinct annotation', 'Second distinct annotation', 'Captured thread annotation']);
  expect(workspace.state.tasks.map(task => task.id)).toEqual(['captured', 'routine']);
  workspace.dispatch({ type: 'note', threadId: workspace.state.notes[0]!.threadId, noteId: workspace.state.notes[0]!.id, text: 'Newest annotation' });
  await workspace.flush();
  const next = new DesktopWorkspace(mock.platform);
  await next.load(); await next.flush();
  expect(mock.backups).toEqual([original]);
  expect(next.state.notes[0]!.text).toBe('Newest annotation');
  expect(mock.saved().snapshot?.reminders).toEqual([]);
  expect(mock.commands.some(command => command.startsWith('reminders_'))).toBe(false);
});

test('failed migration backup blocks conversion and leaves original workspace recoverable', async () => {
  const original = legacySnapshot();
  const mock = fixture(original);
  mock.failBackup();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load();
  expect(workspace.getSnapshot().workspace).toBeNull();
  expect(workspace.getSnapshot().loadError).toContain('Backup failed');
  expect(mock.saved()).toEqual(original);
  expect(mock.commands).not.toContain('workspace_save');
});

function duplicateSnapshot(): NativeWorkspace {
  const url = 'https://github.com/github/usersd/issues/1897';
  const state = reconcileWork(emptyWorkspace(now, 'UTC'), {
    candidates: [{
      title: 'Implement the repair', action: 'implement', url,
      evidence: [{ id: 'assignment', source: 'github', streamId: 'assigned', at: now, url, summary: 'Assigned repair' }],
    }],
    observations: [{ url, state: 'open', observedAt: now, reason: '' }], warnings: [], collectedAt: now,
  }, now);
  const first = state.tasks[0]!;
  first.work!.identity = `implement:${url}`;
  state.tasks.push({
    ...first, id: 'follow-up', title: 'Resolve the overdue repair', notes: 'Follow-up notes',
    work: {
      ...first.work!, identity: `follow-up:${url}`, action: 'follow-up',
      evidence: [{ id: 'request', source: 'github', streamId: 'notifications', at: now, url, summary: 'Resolve overdue repair' }],
    },
  });
  state.selectedKey = 'a:follow-up';
  return {
    revision: crypto.randomUUID(), savedAt: now,
    snapshot: snapshotSchema.parse({ formatVersion: 1, workspace: { version: 1, state, scroll: {} }, reminders: [] }),
  };
}

test('loading saved duplicates backs up before persisting one task and never repeats the backup', async () => {
  const original = duplicateSnapshot();
  const mock = fixture(original);
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load(); await workspace.flush();
  expect(mock.commands).toEqual(['workspace_read', 'clock_now', 'workspace_create_backup', 'workspace_save']);
  expect(mock.backups).toEqual([original]);
  expect(workspace.state.tasks).toHaveLength(1);
  const task = workspace.state.tasks[0]!;
  expect(task.notes).toBe('Resolve the overdue repair\nFollow-up notes');
  expect(task.work!.evidence.map(item => item.id)).toEqual(['assignment', 'request']);
  expect(workspace.state.selectedKey).toBe(`a:${task.id}`);
  const reloaded = new DesktopWorkspace(mock.platform);
  await reloaded.load(); await reloaded.flush();
  expect(reloaded.state.tasks).toEqual(workspace.state.tasks);
  expect(mock.backups).toEqual([original]);
});

test('a failed duplicate backup prevents any change to saved tasks', async () => {
  const original = duplicateSnapshot();
  const mock = fixture(original);
  mock.failBackup();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load();
  expect(workspace.getSnapshot().workspace).toBeNull();
  expect(workspace.getSnapshot().loadError).toContain('Backup failed');
  expect(mock.saved()).toEqual(original);
  expect(mock.commands).not.toContain('workspace_save');
});
