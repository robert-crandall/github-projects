import { expect, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { serve, type Handler } from '../src/protocol.ts';
import { LIMITS } from '../src/schema.ts';
import { ServiceError } from '../src/errors.ts';
import { defaultWorkState } from '../src/work-schema.ts';

const success = { github: { available: true, scopes: ['repo'], viewer: 'synthetic' }, copilot: { available: true } };
const request = (id: string, op = 'connection.check', input: unknown = {}) => JSON.stringify({ v: 1, id, op, input }) + '\n';
async function harness(operation: (input: PassThrough, replies: Record<string, unknown>[]) => Promise<void>, handler: Handler, deadlineMs = 1000) {
  const input = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  const task = serve(input, async line => { replies.push(JSON.parse(line)); }, handler, { deadlineMs });
  await operation(input, replies);
  input.end();
  await task;
  return replies;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('split frames, validated output, strict input, and protocol-only stdout', async () => {
  const replies = await harness(async input => {
    const line = request('a');
    input.write(line.slice(0, 10));
    input.write(line.slice(10));
    input.write(request('b', 'connection.check', { command: 'ls' }));
    input.write('not json\n');
    await tick();
  }, async () => success);
  expect(replies.find(reply => reply.id === 'a')).toEqual({ v: 1, id: 'a', ok: true, result: success });
  expect(replies.filter(reply => reply.ok === false).map(reply => reply.error)).toMatchObject([{ code: 'invalid_input' }, { code: 'protocol' }]);
});
test('oversized frames discard through newline then recover', async () => {
  const replies = await harness(async input => {
    input.write('x'.repeat(LIMITS.frameBytes + 1));
    input.write('x\n');
    input.write(request('after'));
    await tick();
  }, async () => success);
  expect(replies.length).toBe(2);
  expect(replies[0]!.error).toMatchObject({ code: 'limit' });
  expect(replies[1]!.id).toBe('after');
});
test('concurrency is bounded and explicit cancellation frees the slot', async () => {
  const replies = await harness(async (input, replies) => {
    for (let i = 0; i < 5; i++) input.write(request(`job-${i}`));
    await tick();
    expect(replies[0]!.error).toMatchObject({ code: 'busy' });
    input.write(request('cancel-1', 'cancel', { requestId: 'job-0' }));
    await tick();
    expect(replies.some(reply => reply.id === 'job-0' && (reply.error as { code: string })?.code === 'cancelled')).toBe(true);
  }, async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  expect(replies.filter(reply => (reply.error as { code?: string })?.code === 'cancelled').length).toBe(4);
});
test('deadlines propagate and error messages never reveal thrown private text', async () => {
  const replies = await harness(async input => {
    input.write(request('slow'));
    await new Promise(resolve => setTimeout(resolve, 40));
  }, async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), 10);
  expect(replies[0]!.error).toMatchObject({ code: 'deadline' });
  const errors = await harness(async input => { input.write(request('private')); await tick(); },
    async () => { throw new Error('secret-token private-comment'); });
  expect(JSON.stringify(errors)).not.toContain('secret-token');
});
test('invalid service output and duplicate request IDs are rejected', async () => {
  const replies = await harness(async input => {
    input.write(request('dup'));
    await tick();
    input.write(request('dup'));
    await tick();
  }, async () => ({ token: 'secret' }));
  expect(replies.map(reply => reply.error)).toMatchObject([{ code: 'invalid_output' }, { code: 'protocol' }]);
});
test('work deadline and cancellation errors never imply an external GitHub write', async () => {
  for (const code of ['deadline', 'cancelled'] as const) {
    const replies = await harness(async input => {
      input.write(request('rank', 'work.rank', { instructions: '', model: '', tasks: [] }));
      await tick();
    }, async () => { throw new ServiceError(code, true); });
    expect(replies[0]!.error).toMatchObject({ code, message: expect.stringContaining('read-only') });
    expect(JSON.stringify(replies)).not.toContain('external write');
  }
});
test('work operations get five minutes without extending legacy operation deadlines', async () => {
  const timeout = spyOn(globalThis, 'setTimeout');
  const input = new PassThrough();
  const replies: unknown[] = [];
  const task = serve(input, async line => { replies.push(JSON.parse(line)); }, async request => {
    if (request.op === 'work.rank') return { orderedIds: [], reasons: [] };
    if (request.op === 'work.collect') return { candidates: [], observations: [], warnings: [], collectedAt: new Date().toISOString() };
    return success;
  });
  try {
    input.write(request('rank', 'work.rank', { instructions: '', model: '', tasks: [] }));
    input.write(request('collect', 'work.collect', { stream: defaultWorkState().settings.streams[0], model: '', since: null }));
    input.write(request('legacy'));
    await tick();
    expect(replies).toHaveLength(3);
    expect(timeout.mock.calls.filter(call => call[1] === 300_000)).toHaveLength(2);
    expect(timeout.mock.calls.filter(call => call[1] === 120_000)).toHaveLength(1);
  } finally {
    input.end();
    await task;
    timeout.mockRestore();
  }
});
test('closing stdin cancels active work and incomplete lines are errors', async () => {
  let cancelled = false;
  const replies = await harness(async input => {
    input.write(request('active'));
    await tick();
    input.write('{"unfinished":');
  }, async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(new ServiceError('cancelled')); }, { once: true });
  }));
  expect(cancelled).toBe(true);
  expect(replies.some(value => (value.error as { code: string })?.code === 'protocol')).toBe(true);
});
test('blocked stdout cannot delay cancellation frames or EOF cleanup', async () => {
  const input = new PassThrough();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let aborted = 0;
  const task = serve(input, () => blocked, async (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
  }));
  for (let i = 0; i < 5; i++) input.write(request(`job-${i}`));
  input.write(request('cancel', 'cancel', { requestId: 'job-0' }));
  await tick();
  expect(aborted).toBe(1);
  input.end();
  await tick();
  expect(aborted).toBe(4);
  release();
  await task;
});
test('EPIPE is terminal: cancel peers immediately without another write or unhandled rejection', async () => {
  const input = new PassThrough();
  let aborted = false;
  let writes = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const task = serve(input, async () => { writes++; throw new Error('synthetic EPIPE'); }, async (request, signal) => {
      if (request.id === 'ready') return success;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      });
    }, { closeInput: () => { input.destroy(); } });
    const outcome = task.then(() => undefined, error => error);
    input.write(request('peer') + request('ready'));
    expect(await outcome).toMatchObject({ dto: { code: 'protocol' } });
    await tick();
    expect(aborted).toBe(true);
    expect(writes).toBe(1);
    expect(input.destroyed).toBe(true);
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', onUnhandled); input.destroy(); }
});
test('response buffering and write stalls are bounded even while stdin remains open', async () => {
  const input = new PassThrough();
  const task = serve(input, async () => new Promise(() => {}), async () => success, {
    outputTimeoutMs: 20, closeInput: () => { input.destroy(); },
  });
  const outcome = task.then(() => undefined, error => error);
  input.write('invalid\n'.repeat(100));
  expect(await outcome).toMatchObject({ dto: { code: 'limit' } });
  expect(input.destroyed).toBe(true);
});
