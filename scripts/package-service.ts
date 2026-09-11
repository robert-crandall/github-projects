import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const target = process.env.TAURI_ENV_TARGET_TRIPLE
  ?? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) {
  throw new Error('Desktop service packaging supports macOS arm64 and x64 targets only.');
}
const build = Bun.spawn([process.execPath, 'run', 'build', target.startsWith('aarch64') ? 'arm64' : 'x64'], {
  cwd: resolve(root, 'service'), stdout: 'inherit', stderr: 'inherit',
});
if (await build.exited !== 0) throw new Error('The service build failed. Install its locked dependencies before packaging.');
const directory = resolve(root, 'src-tauri/binaries');
await mkdir(directory, { recursive: true });
const name = `github-projects-service-${target}`;
await copyFile(resolve(root, 'service/dist', name), resolve(directory, name));
await chmod(resolve(directory, name), 0o755);
console.log(`Packaged service for ${target}.`);
