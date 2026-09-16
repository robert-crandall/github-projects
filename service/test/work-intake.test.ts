import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { WorkIntake, type AddTask } from '../src/work-intake.ts';
import { IntakeMcpProtocol, serveIntakeMcp } from '../src/work-mcp-protocol.ts';
import { requestSchema, resultSchemas } from '../src/schema.ts';
import { APP_NAMESPACE } from '../src/work-storage.ts';

const task: AddTask = {
  source: 'copilot', producer: 'review-integration', eventId: 'review-100',
  occurredAt: '2026-09-10T12:00:00Z', action: 'review-result',
  title: 'Read AI review result', url: 'https://github.com/octo/repo/pull/12',
  summary: 'The AI review is ready. The user has not completed their review.',
};
async function storeTest(operation: (store: WorkIntake, path: string) => Promise<void>) {
  const directory = resolve('test-artifacts', `work-intake-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'intake.sqlite3');
  const store = new WorkIntake({ path });
  try { await operation(store, path); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
test('durable intake survives process lifetime, reads do not consume, ACK and replay are idempotent', async () => {
  await storeTest(async (store, path) => {
    const accepted = store.add(task);
    expect(accepted).toMatchObject({ duplicate: false, pending: true });
    expect(store.add(task)).toEqual({ ...accepted, duplicate: true });
    expect(store.pending().items[0]!.candidate.action).toBe('review-result');
    expect(store.pending().items).toHaveLength(1);
    store.close();
    const reopened = new WorkIntake({ path });
    try {
      expect(reopened.pending().items[0]!.id).toBe(accepted.id);
      expect(reopened.ack({ ids: [accepted.id] })).toEqual({ ids: [accepted.id] });
      expect(reopened.pending()).toEqual({ items: [], hasMore: false });
      expect(reopened.add(task)).toEqual({ ...accepted, duplicate: true, pending: false });
      expect(reopened.pending().items).toHaveLength(0);
      expect(() => reopened.add({ ...task, summary: 'Changed replay body' })).toThrow();
    } finally { reopened.close(); }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
test('intake rejects missing external IDs, timestamps, arbitrary protocols, credentials, and oversized content', async () => {
  await storeTest(async store => {
    for (const change of [
      { eventId: '' }, { eventId: undefined }, { producer: '' }, { occurredAt: '' }, { occurredAt: '2099-01-01T00:00:00Z' },
      { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com' },
      { summary: 'a'.repeat(2001) }, { arbitrary: true },
    ]) expect(() => store.add({ ...task, ...change })).toThrow();
    expect(store.pending().items).toHaveLength(0);
  });
});
test('pending cap is honest and ACK preserves pending events outside the saved page', async () => {
  await storeTest(async store => {
    for (let i = 0; i < 201; i++) store.add({ ...task, eventId: `event-${i}` });
    const page = store.pending();
    expect(page.items).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    store.ack({ ids: page.items.map(item => item.id) });
    expect(store.pending().items).toHaveLength(1);
    expect(store.pending().hasMore).toBe(false);
  });
});
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
} };
test('real stdio MCP adapter initializes, lists, calls, and replays with protocol-only output', async () => {
  await storeTest(async (store, path) => {
    const messages = [
      initialize, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'ping', method: 'ping' },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list' },
      { jsonrpc: '2.0', id: 'add', method: 'tools/call', params: { name: 'add_task', arguments: task } },
      { jsonrpc: '2.0', id: 'replay', method: 'tools/call', params: { name: 'add_task', arguments: task } },
      { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { name: 'add_task', arguments: { title: 'missing event' } } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    const output: string[] = [];
    await serveIntakeMcp(Readable.from([messages.slice(0, 37), messages.slice(37)]), async frame => { output.push(frame); }, store);
    const responses = output.map(frame => JSON.parse(frame));
    expect(responses).toHaveLength(6);
    expect(responses[0].result.protocolVersion).toBe('2025-06-18');
    expect(responses[2].result.tools[0].name).toBe('add_task');
    expect(responses[3].result.structuredContent).toMatchObject({ duplicate: false, pending: true });
    expect(responses[4].result.structuredContent).toMatchObject({ duplicate: true, pending: true });
    expect(responses[5].result.isError).toBe(true);
    const reopened = new WorkIntake({ path });
    try { expect(reopened.pending().items).toHaveLength(1); }
    finally { reopened.close(); }
  });
});
test('MCP negotiation, parse errors, unknown methods, bounds, and initialization are explicit', async () => {
  await storeTest(async store => {
    const protocol = new IntakeMcpProtocol(store);
    expect(protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({ error: { code: -32002 } });
    expect(protocol.handle({ ...initialize, params: { ...initialize.params, protocolVersion: 'future-version' } }))
      .toMatchObject({ result: { protocolVersion: '2025-11-25' } });
    protocol.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(protocol.handle({ jsonrpc: '2.0', id: 3, method: 'arbitrary' })).toMatchObject({ error: { code: -32601 } });
    expect(protocol.handle([{ method: 'ping' }])).toMatchObject({ error: { code: -32600 } });
    const output: string[] = [];
    await serveIntakeMcp(Readable.from(['{\n']), async frame => { output.push(frame); }, store);
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { code: -32700 } });
    await expect(serveIntakeMcp(Readable.from(['a'.repeat(32769)]), async () => {}, store)).rejects.toMatchObject({ dto: { code: 'limit' } });
  });
});
test('work operation schemas are routed with strict inputs and exact result schemas', () => {
  for (const op of ['work.connections', 'work.intake'] as const) {
    expect(requestSchema.safeParse({ v: 1, id: 'request-1', op, input: {} }).success).toBe(true);
    expect(requestSchema.safeParse({ v: 1, id: 'request-1', op, input: { path: 'anything' } }).success).toBe(false);
  }
  expect(resultSchemas['work.ackIntake'].parse({ ids: ['external-event'] })).toEqual({ ids: ['external-event'] });
});

const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const binary = resolve(import.meta.dir, '..', 'dist', `github-projects-service-${triple}`);
test.skipIf(!existsSync(binary))('packaged --mcp writes while app is closed; native reads and ACK survive separate processes', async () => {
  const home = resolve('test-artifacts', `packaged-intake-${randomUUID()}`);
  await mkdir(home, { recursive: true });
  const run = async (args: string[], messages: unknown[], count: number): Promise<any[]> => {
    const child = spawn(binary, args, {
      cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin', LOCALAPPDATA: home, XDG_DATA_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.split('\n').length - 1 >= count) child.stdin.end();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const exit = new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
      child.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      expect(await exit).toBe(0);
      expect(stderr).toBe('');
      return stdout.trim().split('\n').map(line => JSON.parse(line));
    } finally { clearTimeout(timer); child.kill('SIGKILL'); }
  };
  try {
    const replies = await run(['--mcp'], [
      initialize, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'add', method: 'tools/call', params: { name: 'add_task', arguments: task } },
    ], 2);
    const id = replies[1].result.structuredContent.id;
    const pending = await run([], [{ v: 1, id: 'read', op: 'work.intake', input: {} }], 1);
    expect(pending[0].result.items[0].id).toBe(id);
    expect(pending[0].result.items[0].candidate.action).toBe('review-result');
    const ack = await run([], [{ v: 1, id: 'ack', op: 'work.ackIntake', input: { ids: [id] } }], 1);
    expect(ack[0]).toMatchObject({ ok: true, result: { ids: [id] } });
    const empty = await run([], [{ v: 1, id: 'read', op: 'work.intake', input: {} }], 1);
    expect(empty[0].result).toEqual({ items: [], hasMore: false });
    const location = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', APP_NAMESPACE) : join(home, APP_NAMESPACE);
    expect(existsSync(join(location, 'work-intake', 'intake.sqlite3'))).toBe(true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
