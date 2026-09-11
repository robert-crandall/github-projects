import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ServiceError, checkAbort } from './errors.ts';
import { LIMITS } from './schema.ts';

export async function executable(name: 'gh' | 'copilot'): Promise<string> {
  // Finder-launched apps may have a minimal PATH. Never search cwd or accept a renderer path.
  const directories = [
    ...(process.env.PATH ?? '').split(':').filter(isAbsolute),
    join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ];
  for (const directory of [...new Set(directories)]) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; }
    catch (error) {
      if (!isMissing(error)) throw new ServiceError('unavailable');
    }
  }
  throw new ServiceError('missing_cli');
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR');
}
export function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmpdir(), LANG: 'en_US.UTF-8',
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1',
  };
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
export type RunResult = { stdout: string; code: number };
export type Runner = (program: string, args: string[], signal: AbortSignal, input?: string) => Promise<RunResult>;
export const run: Runner = async (program, args, signal, input) => {
  checkAbort(signal);
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: tmpdir(), env: cliEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: ServiceError | undefined;
    const stop = (error: ServiceError) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal.reason instanceof ServiceError ? signal.reason : new ServiceError('cancelled'));
    const timer = setTimeout(() => stop(new ServiceError('deadline', true)), LIMITS.processMs);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > LIMITS.processBytes) stop(new ServiceError('limit'));
      else chunks.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      // Do not retain/log gh errors: they can contain credentials or private source text.
      bytes += data.length;
      if (bytes > LIMITS.processBytes) stop(new ServiceError('limit'));
    });
    child.stdin.on('error', () => stop(new ServiceError('unavailable', true)));
    child.on('error', error => { failure = new ServiceError(isMissing(error) ? 'missing_cli' : 'unavailable'); });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code: code ?? 1 });
    });
    child.stdin.end(input);
  });
};
