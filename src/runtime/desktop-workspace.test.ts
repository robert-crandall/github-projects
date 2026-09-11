import { expect, test } from 'bun:test';
import { createNativePlatform, type NativeSnapshot, type NativeWorkspace } from '../platform/native.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';

const now = '2026-09-11T20:00:00Z';
function fixture() {
  let saved: NativeWorkspace = { revision: crypto.randomUUID(), snapshot: null, savedAt: null };
  const commands: string[] = [];
  let fail = false;
  let currentTime = now;
  const platform = createNativePlatform(async (command, args) => {
    commands.push(command);
    if (command === 'workspace_read') return structuredClone(saved);
    if (command === 'clock_now') return { now: currentTime, timeZone: 'UTC', error: null };
    if (command === 'workspace_save') {
      if (fail) throw { code: 'storage-unavailable', retryable: true, message: 'Storage unavailable; pending work is retained.' };
      if (args?.expectedRevision !== saved.revision) throw { code: 'revision-conflict', retryable: false, message: 'Saved copy changed.' };
      saved = { revision: crypto.randomUUID(), snapshot: args?.snapshot as NativeSnapshot, savedAt: now };
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command ${command}`);
  });
  return { platform, commands, saved: () => saved, fail: (value: boolean) => { fail = value; }, clock: (value: string) => { currentTime = value; } };
}

test('native workspace starts empty and persisted captures, notes and chosen work survive a fresh controller', async () => {
  const mock = fixture();
  const first = new DesktopWorkspace(mock.platform);
  expect(first.getSnapshot().workspace).toBeNull();
  await first.load();
  await first.flush();
  expect(first.state.clock).toBe(now);
  expect(first.state.actions).toEqual([]);
  expect(first.state.threads).toEqual([]);
  expect(mock.commands).toEqual(['workspace_read', 'clock_now', 'workspace_save']);
  first.dispatch({ type: 'draft', text: 'Original capture' });
  first.dispatch({ type: 'capture' });
  const key = first.state.selectedKey!;
  first.dispatch({ type: 'edit', key, notes: 'Private scratch note' });
  first.dispatch({ type: 'start', key });
  await first.flush();
  expect(mock.saved().snapshot?.workspace.version).toBe(1);
  const second = new DesktopWorkspace(mock.platform);
  await second.load();
  expect(second.state.actions[0]!.captures).toEqual(['Original capture']);
  expect(second.state.actions[0]!.notes).toBe('Private scratch note');
  expect(second.state.activeId).toBe(first.state.activeId);
  expect(second.state.selectedKey).toBe(key);
});

test('native clock-only ticks do not produce a save/tick loop or change current work', async () => {
  const mock = fixture();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load();
  await workspace.flush();
  const count = mock.commands.length;
  for (const now of ['2026-09-11T20:00:15Z', '2026-09-11T20:00:30Z', '2026-09-11T20:00:45Z']) {
    workspace.clock({ clock: { now, timeZone: 'UTC', error: null }, reminders: null, error: null });
  }
  await workspace.flush();
  expect(mock.commands.length).toBe(count);
  expect(workspace.state.clock).toBe('2026-09-11T20:00:45Z');
  expect(workspace.state.activeId).toBeNull();
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
  await workspace.load();
  await workspace.flush();
  mock.fail(true);
  workspace.dispatch({ type: 'draft', text: 'Retain this' });
  await expect(workspace.flush()).rejects.toThrow('Storage unavailable');
  workspace.dispatch({ type: 'draft', text: 'Newest pending capture' });
  expect(workspace.getSnapshot().persistence.pending).toBe(true);
  expect(workspace.getSnapshot().persistence.error).toContain('Storage unavailable');
  mock.fail(false);
  await workspace.retryStorage();
  expect(workspace.getSnapshot().persistence.pending).toBe(false);
  expect(workspace.getSnapshot().feedback).toContain('saved on this Mac');
});

test('clock-driven routine state persists once and relaunch saves missed-day reconciliation before Saved', async () => {
  const mock = fixture();
  const workspace = new DesktopWorkspace(mock.platform);
  await workspace.load();
  workspace.dispatch({ type: 'draft', text: 'My scheduled routine' });
  workspace.dispatch({ type: 'capture' });
  const key = workspace.state.selectedKey!;
  workspace.dispatch({ type: 'routine', key, time: '20:10', timeZone: 'UTC', steps: ['Announce', 'Increase'] });
  await workspace.flush();
  const original = mock.saved().snapshot!.reminders[0]!.occurrenceId;
  const writes = () => mock.commands.filter(command => command === 'workspace_save').length;
  const before = writes();
  const tick = (now: string) => workspace.clock({ clock: { now, timeZone: 'UTC', error: null }, reminders: null, error: null });
  tick('2026-09-11T20:10:00Z');
  await workspace.flush();
  expect(writes()).toBe(before + 1);
  expect(workspace.state.actions[0]!.routine!.dueAt).toBe('2026-09-11T20:10:00Z');
  expect(mock.saved().snapshot!.reminders[0]!.occurrenceId).toBe(original);
  tick('2026-09-11T20:10:01Z');
  await workspace.flush();
  expect(writes()).toBe(before + 1);
  workspace.dispatch({ type: 'step', key, stepId: workspace.state.actions[0]!.steps[0]!.id });
  await workspace.flush();
  const stepTime = workspace.state.actions[0]!.steps[0]!.doneAt;
  mock.clock('2026-09-14T20:10:00Z');
  const relaunched = new DesktopWorkspace(mock.platform);
  await relaunched.load();
  expect(relaunched.getSnapshot().persistence.pending).toBe(true);
  await relaunched.flush();
  expect(relaunched.getSnapshot().persistence.pending).toBe(false);
  expect(relaunched.state.actions[0]!.routine!.history).toHaveLength(3);
  expect(relaunched.state.actions[0]!.routine!.nextDueAt).toBe('2026-09-15T20:10:00Z');
  expect(relaunched.state.actions[0]!.steps[0]!.doneAt).toBe(stepTime);
  expect(mock.saved().snapshot!.reminders[0]!.occurrenceId).toBe(original);
  const afterReconcile = writes();
  relaunched.clock({ clock: { now: '2026-09-14T20:10:01Z', timeZone: 'UTC', error: null }, reminders: null, error: null });
  await relaunched.flush();
  expect(writes()).toBe(afterReconcile);
});
