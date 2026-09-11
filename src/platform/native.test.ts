import { describe, expect, test } from 'bun:test';
import { createNativePlatform, NativePlatformError, nativeTickSchema, type NativeSnapshot, type NativeTransport } from './native.ts';

const revision = '97656881-c64b-4be7-84f4-5ec7fe6c1cc1';
const saved = { revision, snapshot: null, savedAt: null };
const snapshot: NativeSnapshot = {
  formatVersion: 1, workspace: { version: 1, notes: 'local only' },
  reminders: [{ id: 'action', occurrenceId: 'action:2026-09-11T17:00:00Z', dueAt: '2026-09-11T17:00:00Z', timeZone: 'America/Los_Angeles' }],
};

describe('typed native boundary', () => {
  test('fresh read stays empty, save atomically includes schedule and revision', async () => {
    const calls: unknown[] = [];
    const native = createNativePlatform(async (command, args) => { calls.push({ command, args }); return saved; });
    expect((await native.workspaceRead()).snapshot).toBeNull();
    await native.workspaceSave(revision, snapshot);
    expect(calls).toEqual([
      { command: 'workspace_read', args: undefined },
      { command: 'workspace_save', args: { expectedRevision: revision, snapshot } },
    ]);
  });

  test('invalid snapshots, duplicate schedules and stale-shaped revisions never reach native', () => {
    let calls = 0;
    const native = createNativePlatform(async () => { calls++; return saved; });
    expect(() => native.workspaceSave('old-number-2', snapshot)).toThrow(NativePlatformError);
    expect(() => native.workspaceSave(revision, { ...snapshot, reminders: [snapshot.reminders[0], snapshot.reminders[0]] })).toThrow();
    expect(() => native.workspaceSave(revision, { ...snapshot, reminders: [{ ...snapshot.reminders[0], timeZone: 'Bad/Zone' }] })).toThrow();
    expect(calls).toBe(0);
  });

  test('native CAS failures and malformed replies never become Saved', async () => {
    const conflict: NativeTransport = async () => { throw { code: 'revision-conflict', message: 'Reload before saving.', retryable: false }; };
    await expect(createNativePlatform(conflict).workspaceSave(revision, snapshot)).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(createNativePlatform(async () => ({ saved: true })).workspaceRead()).rejects.toMatchObject({ code: 'invalid-response' });
    const raw: NativeTransport = async () => { throw new Error('credential-like subprocess output must not reach settings'); };
    await expect(createNativePlatform(raw).workspaceRead()).rejects.toMatchObject({ code: 'native-unavailable' });
  });

  test('launch never takes arbitrary URLs, prompts, or fixture identities', async () => {
    const calls: unknown[] = [];
    const native = createNativePlatform(async (command, args) => {
      calls.push({ command, args }); return { status: 'dispatch-requested', url: 'ghapp://validated-in-rust' };
    });
    const identity = { source: 'github', owner: 'octo-org', repo: 'repo', kind: 'pr', number: 123 } as const;
    await native.launchCopilot(identity);
    expect(calls).toEqual([{ command: 'launch_copilot', args: { identity } }]);
    expect(() => native.launchCopilot({ ...identity, owner: 'sample' })).toThrow();
    expect(() => native.launchCopilot({ ...identity, repo: 'repo&prompt=private' })).toThrow();
    expect(() => native.launchCopilot({ ...identity, number: 0 })).toThrow();
    expect(() => native.launchGitHub({ ...identity, ...{ url: 'https://evil.test' } })).toThrow();
    expect(calls.length).toBe(1);
  });

  test('permission requests are an explicit separate operation', async () => {
    const commands: string[] = [];
    const native = createNativePlatform(async command => {
      commands.push(command);
      return command === 'workspace_read' ? saved : { state: 'denied', alertsEnabled: false };
    });
    await native.workspaceRead();
    expect(commands).toEqual(['workspace_read']);
    expect(await native.requestReminderPermission()).toEqual({ state: 'denied', alertsEnabled: false });
    expect(commands[1]).toBe('reminders_request_permission');
  });

  test('backup recovery requires opaque token, paths cannot enter API', () => {
    const native = createNativePlatform(async () => saved);
    expect(() => native.recoverBackup('../old-app', revision)).toThrow();
    expect(() => native.recoverBackup('latest', '1')).toThrow();
  });

  test('clock events retain explicit errors without inventing reminders', () => {
    const event = nativeTickSchema.parse({
      clock: { now: '2026-09-11T20:00:00+00:00', timeZone: 'America/Los_Angeles', error: null },
      reminders: null, error: { code: 'notification-unavailable', message: 'Unavailable', retryable: true },
    });
    expect(event.reminders).toBeNull();
    expect(event.error?.code).toBe('notification-unavailable');
  });

  test('default browser transport refuses native operations', async () => {
    await expect(createNativePlatform().workspaceRead()).rejects.toMatchObject({ code: 'desktop-required' });
  });
});
