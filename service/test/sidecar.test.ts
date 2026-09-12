import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { refreshSchema } from '../src/schema.ts';
import { pullRequestStateQuery } from '../src/github.ts';

const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const binary = resolve(import.meta.dir, '..', 'dist', `github-projects-service-${triple}`);
test.skipIf(!existsSync(binary))('compiled sidecar runs outside repo/node_modules with no startup network and strict JSONL', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'github-projects-sidecar-test-'));
  try {
    await writeFile(join(cwd, 'bunfig.toml'), 'This is deliberately invalid TOML and must never load.');
    // No gh/Copilot in PATH: pure protocol and cancellation must still run with the embedded runtime.
    const child = spawn(binary, [], { cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    child.stdin.write('{"v":1,"id":"bad","op":"shell","input":{"command":"touch nope"}}\n');
    child.stdin.write('{"v":1,"id":"cancel","op":"cancel","input":{"requestId":"absent"}}\n');
    child.stdin.end();
    const code = await exit;
    if (code !== 0) throw new Error(`Sidecar exited ${code}: ${stderr}`);
    expect(code).toBe(0);
    const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(replies[0]).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(replies[1]).toEqual({ v: 1, id: 'cancel', ok: true, result: { requestId: 'absent', cancelled: false } });
    expect(existsSync(join(cwd, 'nope'))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test.skipIf(!existsSync(binary))('compiled refresh executes the fixed POST read through gh stdin, not the GET introspection route', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'github-projects-graphql-test-'));
  let child: ReturnType<typeof spawn> | undefined;
  const query = pullRequestStateQuery({ repo: 'octo/project', number: 12, kind: 'pr' });
  try {
    await writeFile(join(cwd, 'gh'), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const path = args.find(value => value.startsWith('/'));
const input = args.includes('--input') ? JSON.parse(await Bun.stdin.text()) : null;
appendFileSync(${JSON.stringify(join(cwd, 'calls.jsonl'))}, JSON.stringify({method,path,input})+'\\n');
const time='2026-09-11T17:00:00Z';
let body;
if (method === 'POST' && path === '/graphql' && JSON.stringify(input) === JSON.stringify({query:${JSON.stringify(query)}})) {
  body={data:{repository:{pullRequest:{state:'OPEN',updatedAt:time,mergeQueueEntry:{id:'MQE_sample'}}}}};
} else if (method !== 'GET') process.exit(7);
else if (path === '/user') body={login:'viewer'};
else if (path.startsWith('/user/teams')) body=[];
else if (path.startsWith('/notifications?')) body=[{id:'123',repository:{full_name:'octo/project'},
  subject:{type:'PullRequest',url:'https://api.github.com/repos/octo/project/pulls/12',title:'Sample PR'},
  reason:'subscribed',unread:true,updated_at:time,last_read_at:null}];
else if (path === '/repos/octo/project/pulls/12') body={number:12,title:'Sample PR',state:'open',merged:false,updated_at:time};
else if (path.includes('/timeline?')) body=[];
else if (path.endsWith('/subscription')) body={subscribed:true,ignored:false};
else if (path.startsWith('/graphql?')) body={data:{__schema:{queryType:{name:'Query'}}}};
else process.exit(8);
process.stdout.write('HTTP/2.0 200 OK\\r\\nX-OAuth-Scopes: repo, read:org\\r\\n\\r\\n'+JSON.stringify(body));
`, { mode: 0o700 });
    child = spawn(binary, [], { cwd, env: { PATH: `${cwd}:/usr/bin:/bin`, HOME: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.resume();
    const exited = new Promise<number | null>((resolve, reject) => { child!.on('exit', resolve); child!.on('error', reject); });
    const reply = new Promise<unknown>((resolve, reject) => {
      let output = '';
      child!.stdout!.on('data', data => {
        output += data;
        if (output.includes('\n')) {
          try { resolve(JSON.parse(output.split('\n')[0]!)); } catch (error) { reject(error); }
        }
      });
      child!.on('error', reject);
      child!.on('exit', () => reject(new Error('Service exited before refresh replied.')));
    });
    child.stdin!.write('{"v":1,"id":"queue-read","op":"github.refresh","input":{}}\n');
    const envelope = await reply;
    expect(envelope).toMatchObject({ ok: true });
    const result = z.object({ ok: z.literal(true), result: refreshSchema }).parse(envelope).result;
    expect(result.status).toBe('complete');
    expect(result.threads[0]!.sourceState).toMatchObject({ state: 'queued', error: null });
    child.stdin!.end();
    expect(await exited).toBe(0);
    const calls = (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method !== 'GET')).toEqual([{ method: 'POST', path: '/graphql', input: { query } }]);
  } finally {
    child?.kill('SIGKILL');
    await rm(cwd, { recursive: true, force: true });
  }
});
