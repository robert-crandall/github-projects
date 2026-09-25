import { describe, expect, test } from 'bun:test';
import { createNativePlatform, NativePlatformError, clockSchema, type NativeSnapshot, type NativeTransport } from './native.ts';
import { type CodeRunIntent } from '../../service/src/code-runs.ts';
import { codeResult, CodeRunStoreFixture } from '../../tests/code-run-fixture.ts';
import { codeReviewResultSchema } from '../../service/src/code-review-schema.ts';
import { z } from 'zod';

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
    expect(() => native.recoverBackup('../old-app', revision, revision)).toThrow();
    expect(() => native.recoverBackup('latest', '1', revision)).toThrow();
    expect(() => native.recoverBackup('latest', revision, 'stale-shaped')).toThrow();
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

const intent: CodeRunIntent = {
  runId: '685d7983-5636-42d2-a924-d16368f02536', profileId: 'default', agentName: 'Reviewer',
  startedAt: '2026-09-25T01:00:00Z',
  input: { taskId: 'task', job: 'pr-review', source: { repo: 'octo/project', kind: 'pr', number: 47 },
    agent: { id: 'reviewer', instructions: 'Read code', model: '' } },
};

describe('typed code-run boundary', () => {
  test('creating adapters does not initialize history or dispatch jobs; explicit calls use native only', async () => {
    const store = new CodeRunStoreFixture();
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
    const native = createNativePlatform(async (command, args) => {
      calls.push({ command, args });
      return store.handle(command, args ?? {});
    });
    expect(calls).toEqual([]);
    const { generation } = await native.codeRunContext();
    const started = await native.codeRunStart(generation, intent);
    expect(started.outcome.status).toBe('running');
    const outcome = { status: 'partial', finishedAt: intent.startedAt, result: codeResult(intent.input) } as const;
    const terminal = await native.codeRunUpdate(generation, intent, outcome);
    expect(await native.codeRunUpdate(generation, intent, outcome)).toEqual(terminal);
    expect(await native.codeRunRead('default', 'task')).toEqual({ runs: [terminal], before: null });
    await native.codeRunRead('default', 'task', terminal.sequence, true);
    expect(calls).toEqual([
      { command: 'code_run_context', args: undefined },
      { command: 'code_run_start', args: { generation, intent } },
      { command: 'code_run_update', args: { generation, intent, outcome } },
      { command: 'code_run_update', args: { generation, intent, outcome } },
      { command: 'code_run_read', args: { profileId: 'default', taskId: 'task', before: null, quarantined: false } },
      { command: 'code_run_read', args: { profileId: 'default', taskId: 'task', before: terminal.sequence, quarantined: true } },
    ]);
  });

  test('invalid identities, cursors and oversized outcomes never cross native transport', () => {
    let calls = 0;
    const native = createNativePlatform(async () => { calls++; return null; });
    expect(() => native.codeRunStart('invalid', intent)).toThrow(NativePlatformError);
    expect(() => native.codeRunStart(revision, { ...intent, runId: 'invalid' })).toThrow(NativePlatformError);
    for (const cursor of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => native.codeRunRead('default', 'task', cursor)).toThrow(NativePlatformError);
    }
    const result = codeResult(intent.input);
    result.evidence[0]!.text = 'x'.repeat(1_048_576);
    expect(() => native.codeRunUpdate(revision, intent, {
      status: 'partial', finishedAt: intent.startedAt, result,
    })).toThrow(expect.objectContaining({ code: 'code-run-limit' }));
    expect(calls).toBe(0);
  });

  test('malformed or mismatched saved results never confirm persistence', async () => {
    const result = codeResult(intent.input);
    const run = { generation: revision, sequence: 1, quarantined: false, intent,
      outcome: { status: 'partial', finishedAt: intent.startedAt, result } };
    for (const invalid of [
      { ...run, sequence: 0 },
      { ...run, outcome: { ...run.outcome, status: 'not-inspected' } },
      { ...run, outcome: { ...run.outcome, result: { ...result, taskId: 'other' } } },
      { ...run, outcome: { ...run.outcome, result: { ...result, config: { ...result.config, agentId: 'other' } } } },
    ]) {
      const native = createNativePlatform(async () => invalid);
      await expect(native.codeRunStart(revision, intent)).rejects.toMatchObject({ code: 'invalid-response' });
    }
    await expect(createNativePlatform(async () => ({ runs: Array(11).fill(run), before: null }))
      .codeRunRead('default', 'task')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  test('native failures retain their code and ordinary recovery keeps its existing envelope', async () => {
    const failure: NativeTransport = async () => {
      throw { code: 'workspace-replaced', message: 'No code job was started.', retryable: false };
    };
    await expect(createNativePlatform(failure).codeRunStart(revision, intent))
      .rejects.toMatchObject({ code: 'workspace-replaced', retryable: false });
    const calls: unknown[] = [];
    const native = createNativePlatform(async (command, args) => { calls.push({ command, args }); return saved; });
    expect(await native.recoverBackup('latest', revision, revision)).toEqual(saved);
    expect(calls).toEqual([{ command: 'workspace_recover',
      args: { backupId: 'latest', expectedRecoveryToken: revision, expectedRevision: revision } }]);
  });

  test('the shared native rejection matrix is invalid for the supported result reader', async () => {
    const mutation = z.object({ path: z.string(), value: z.json(), repeat: z.number().int().positive().optional() });
    const cases = z.object({ common: z.array(mutation), implementation: z.array(mutation), requiredNullable: z.array(z.string()) })
      .parse(await Bun.file(new URL('../../tests/code-result-invalid.json', import.meta.url)).json());
    for (const implementation of [false, true]) {
      const input = implementation
        ? { ...intent.input, job: 'implementation-assessment' as const, source: { ...intent.input.source, kind: 'issue' as const } }
        : intent.input;
      const baseline = codeResult(input);
      expect(codeReviewResultSchema.safeParse(baseline).success).toBe(true);
      const casesForJob = implementation ? cases.implementation : cases.common;
      for (const item of [...casesForJob, ...cases.requiredNullable.map(path => ({ path, value: undefined, repeat: undefined }))]) {
        const invalid = z.json().parse(baseline);
        const parts = item.path.slice(1).split('/');
        const key = parts.pop()!;
        let parent = invalid;
        for (const part of parts) {
          if (!parent || typeof parent !== 'object') throw new Error(`Missing fixture path: ${item.path}`);
          parent = Array.isArray(parent) ? parent[Number(part)]! : parent[part]!;
        }
        if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new Error(`Invalid fixture path: ${item.path}`);
        if (item.value !== undefined) {
          parent[key] = item.repeat ? String(item.value).repeat(item.repeat) : item.value;
        } else {
          delete parent[key];
        }
        expect(codeReviewResultSchema.safeParse(invalid).success, item.path).toBe(false);
      }
    }
  });
});
