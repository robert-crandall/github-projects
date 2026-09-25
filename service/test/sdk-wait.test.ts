import { expect, spyOn, test } from 'bun:test';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { waitForSdkResponse, wrapSdkClient } from '../src/sdk-client.ts';
import { clientOptions, restrictedConfig } from '../src/copilot.ts';
import { ServiceError } from '../src/errors.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.each(['session-answer','session-error','send-reject'])('real SDK wait handles %s before send acknowledgement and removes subscriptions', async mode => {
  const directory = await mkdtemp(join(tmpdir(),'code-sdk-events-'));
  const client = new CopilotClient({
    ...clientOptions(process.execPath,directory,'synthetic-not-a-credential'),workingDirectory:directory,
    connection:RuntimeConnection.forStdio({path:process.execPath,args:['run',resolve(import.meta.dir,'fixtures/sdk-runtime.ts'),join(directory,'runtime'),mode,'--']}),
  });
  try {
    await client.start();
    const session = await client.createSession(restrictedConfig(directory,directory));
    let released = 0;
    const waiting = waitForSdkResponse({
      on: handler => { const release = session.on(handler); return () => { released++; release(); }; },
      send: options => session.send(options),
    },'synthetic',1000,new AbortController().signal);
    if (mode === 'session-answer') expect((await waiting)?.data.content).toBe('final');
    else await expect(waiting).rejects.toThrow();
    expect(released).toBe(1);
  } finally { await client.forceStop(); await rm(directory,{recursive:true,force:true}); }
});

test('cancelled real SDK wait clears its idle timer and subscription even without idle/error events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-sdk-wait-'));
  const marker = join(directory, 'runtime');
  const client = new CopilotClient({
    ...clientOptions(process.execPath, directory, 'synthetic-not-a-credential'),
    workingDirectory: directory,
    connection: RuntimeConnection.forStdio({
      path: process.execPath, args: ['run', resolve(import.meta.dir, 'fixtures/sdk-runtime.ts'), marker, 'session-hang', '--'],
    }),
  });
  const timers = spyOn(globalThis, 'setTimeout'), clear = spyOn(globalThis, 'clearTimeout');
  const controller = new AbortController();
  let pid = 0;
  try {
    await client.start();
    const session = await client.createSession(restrictedConfig(directory,directory));
    pid = Number(await readFile(marker,'utf8'));
    const waiting = waitForSdkResponse(session,'synthetic prompt; no model exists',200,controller.signal);
    const idleTimer = timers.mock.results.at(-1)!.value;
    controller.abort(new ServiceError('cancelled'));
    await expect(waiting).rejects.toMatchObject({ dto: { code: 'cancelled' } });
    expect(clear.mock.calls.some(([value]) => value === idleTimer)).toBe(true);
    await client.forceStop();
    await new Promise(resolve => setTimeout(resolve,50));
    expect(() => process.kill(pid,0)).toThrow();
  } finally {
    controller.abort(); await client.forceStop(); timers.mockRestore(); clear.mockRestore();
    await rm(directory,{recursive:true,force:true});
  }
});

test('production SDK wrapper passes the signal through and rejects a hanging send within the deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(),'code-sdk-adapter-'));
  const client = new CopilotClient({
    ...clientOptions(process.execPath,directory,'synthetic-not-a-credential'),workingDirectory:directory,
    connection:RuntimeConnection.forStdio({path:process.execPath,args:['run',resolve(import.meta.dir,'fixtures/sdk-runtime.ts'),join(directory,'runtime'),'session-hang','--']}),
  });
  const adapter = wrapSdkClient(client);
  try {
    await adapter.start();
    const session = await adapter.createSession(restrictedConfig(directory,directory));
    await expect(session.sendAndWait({prompt:'synthetic'},20,new AbortController().signal)).rejects.toMatchObject({dto:{code:'deadline'}});
    await session.disconnect(); await adapter.deleteSession(session.sessionId);
  } finally { await adapter.forceStop(); await rm(directory,{recursive:true,force:true}); }
});
