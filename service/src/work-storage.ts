import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export const APP_NAMESPACE = 'io.robertcrandall.github-projects-workspace';

export function privateAppDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAMESPACE);
  const configured = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_DATA_HOME;
  const base = configured && isAbsolute(configured) ? configured
    : process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'share');
  return join(base, APP_NAMESPACE);
}
