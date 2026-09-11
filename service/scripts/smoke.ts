// Explicitly invoked only; never part of tests/build/startup. One synthetic SDK request, no GitHub writes.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureOutputSchema, errorSchema, LIMITS } from '../src/schema.ts';

const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const binary = resolve(import.meta.dir, '..', 'dist', `github-projects-service-${triple}`);
const cwd = await mkdtemp(join(tmpdir(), 'github-projects-live-smoke-'));
try {
  const child = spawn(binary, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const timeout = setTimeout(() => { child.stdin.end(); }, 120_000);
  const result = await new Promise<unknown>((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > LIMITS.responseBytes) { child.stdin.end(); reject(new Error('response-limit')); }
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        try { resolve(JSON.parse(buffer.slice(0, newline))); }
        catch { reject(new Error('invalid-json')); }
        child.stdin.end();
      }
    });
    child.stderr.on('data', data => {
      // Print only the fixed diagnostic vocabulary, never arbitrary SDK/CLI stderr.
      for (const code of String(data).match(/\bcopilot:(?:output-(?:empty|wrapper|json-malformed|json-presentation|schema|limit)|retry-format)\b/g) ?? []) {
        process.stderr.write(`${code}\n`);
      }
    });
    child.on('error', () => reject(new Error('spawn-failed')));
    child.on('close', () => { clearTimeout(timeout); reject(new Error('no-response')); });
    child.stdin.write(JSON.stringify({
      v: 1, id: 'smoke', op: 'copilot.interpretCapture',
      input: { captureId: 'synthetic-smoke', text: 'Write a short rollout checklist.', timeZone: 'UTC' },
    }) + '\n');
  });
  if (typeof result !== 'object' || result === null || !('ok' in result)) throw new Error('invalid-envelope');
  if (result.ok === false && 'error' in result) {
    const error = errorSchema.parse(result.error);
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else if ('result' in result) {
    const output = captureOutputSchema.parse(result.result);
    if (output.captureId !== 'synthetic-smoke') throw new Error('invalid-identity');
    process.stdout.write('Packaged SDK preview passed outside the repository using isolated state and supported gh authentication.\n');
  } else throw new Error('invalid-envelope');
} catch {
  process.stderr.write('Synthetic packaged SDK smoke failed; no raw provider output was logged.\n');
  process.exitCode = 1;
} finally { await rm(cwd, { recursive: true, force: true }); }
