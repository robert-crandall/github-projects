import { expect, test } from 'bun:test';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { clientOptions, CopilotService } from '../src/copilot.ts';
import { ServiceError } from '../src/errors.ts';

const delay = () => new Promise(resolve => setTimeout(resolve, 10));
const fixture = resolve(import.meta.dir, 'fixtures/sdk-runtime.ts');
test('SDK child permits persistent OAuth only for explicitly selected MCP collectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-projects-sdk-oauth-'));
  try {
    for (const oauth of [undefined, { homeDirectory: directory, configDirectory: join(directory, 'oauth') }]) {
      const marker = join(directory, oauth ? 'collector' : 'isolated');
      const client = new CopilotClient({
        ...clientOptions(process.execPath, directory, 'synthetic-not-a-credential', oauth),
        workingDirectory: directory,
        connection: RuntimeConnection.forStdio({
          path: process.execPath, args: ['run', fixture, marker, 'respond', '--'],
        }),
      });
      try {
        await client.start();
        expect(JSON.parse(await readFile(`${marker}.environment`, 'utf8'))).toEqual({
          keychainDisabled: oauth ? null : '1',
          home: directory, copilotHome: oauth?.configDirectory ?? join(directory, 'config'),
        });
      } finally { await client.forceStop(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
test('public SDK startup cancellation kills a real SIGTERM-resistant synthetic runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-projects-sdk-lifecycle-'));
  const marker = join(directory, 'pid');
  let pid: number | undefined;
  const controller = new AbortController();
  const sdk = new CopilotService({
    cli: async () => process.execPath, token: async () => 'synthetic-not-a-credential',
    client: options => new CopilotClient({
      ...options,
      connection: RuntimeConnection.forStdio({
        path: process.execPath,
        args: ['run', fixture, marker, 'hang', '--'],
      }),
    }),
  });
  const pending = sdk.connection(controller.signal);
  const outcome = pending.then(() => undefined, error => error);
  try {
    for (let i = 0; i < 200; i++) {
      try { pid = Number(await readFile(marker, 'utf8')); break; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await delay();
    }
    if (!pid) throw new Error('Synthetic SDK runtime did not start');
    process.kill(pid, 'SIGTERM');
    await delay();
    expect(alive(pid)).toBe(true);
    controller.abort(new ServiceError('cancelled'));
    expect(await outcome).toMatchObject({ dto: { code: 'cancelled' } });
    for (let i = 0; i < 100 && alive(pid); i++) await delay();
    expect(alive(pid)).toBe(false);
  } finally {
    controller.abort(new ServiceError('cancelled'));
    await pending.catch(() => {});
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('completed SDK auth shutdown kills a runtime after successful RPC shutdown would ignore SIGTERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-projects-sdk-shutdown-'));
  const marker = join(directory, 'pid');
  let pid: number | undefined;
  const sdk = new CopilotService({
    cli: async () => process.execPath, token: async () => 'synthetic-not-a-credential',
    client: options => new CopilotClient({
      ...options,
      connection: RuntimeConnection.forStdio({
        path: process.execPath, args: ['run', fixture, marker, 'respond', '--'],
      }),
    }),
  });
  try {
    expect(await sdk.connection(AbortSignal.timeout(5_000))).toEqual({ available: true });
    pid = Number(await readFile(marker, 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await delay();
    expect(alive(pid)).toBe(false);
  } finally {
    pid ??= Number(await readFile(marker, 'utf8').catch(() => '0'));
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
