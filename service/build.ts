import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const architecture = process.argv[2] ?? process.arch;
if (architecture !== 'arm64' && architecture !== 'x64') throw new Error('Expected arm64 or x64');
const triple = architecture === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const root = import.meta.dir;
await mkdir(join(root, 'dist'), { recursive: true });
const child = Bun.spawn([
  process.execPath, 'build', '--compile', `--target=bun-darwin-${architecture}`,
  '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
  join(root, 'src/main.ts'),
  '--outfile', join(root, 'dist', `github-projects-service-${triple}`),
], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
