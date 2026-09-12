import { describe, expect, test } from 'bun:test';
import { createNativePlatform, NativePlatformError, clockSchema, type NativeSnapshot, type NativeTransport } from './native.ts';

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

  test('retired permission/retry commands are absent and v3 cannot save reminder schedules', async () => {
    const commands: string[] = [];
    const native = createNativePlatform(async command => {
      commands.push(command);
      return saved;
    });
    await native.workspaceRead();
    expect(commands).toEqual(['workspace_read']);
    expect(native).not.toHaveProperty('requestReminderPermission');
    expect(native).not.toHaveProperty('retryReminder');
    expect(() => native.workspaceSave(revision, { ...snapshot, workspace: { version: 1, state: { version: 3 } } })).toThrow();
    expect(commands).toEqual(['workspace_read']);
  });

  test('backup recovery requires opaque token, paths cannot enter API', () => {
    const native = createNativePlatform(async () => saved);
    expect(() => native.recoverBackup('../old-app', revision)).toThrow();
    expect(() => native.recoverBackup('latest', '1')).toThrow();
  });

  test('clock reads retain explicit errors without inventing a timezone', () => {
    const clock = clockSchema.parse({
      now: '2026-09-11T20:00:00+00:00', timeZone: null,
      error: { code: 'timezone-unavailable', message: 'Unavailable', retryable: true },
    });
    expect(clock.timeZone).toBeNull();
    expect(clock.error?.code).toBe('timezone-unavailable');
  });

  test('default browser transport refuses native operations', async () => {
    await expect(createNativePlatform().workspaceRead()).rejects.toMatchObject({ code: 'desktop-required' });
  });
});
