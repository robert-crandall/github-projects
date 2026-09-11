import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

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
