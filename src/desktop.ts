import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopCommands } from './desktop-contract.ts';

export const desktop = isTauri();

export function desktopCommand<K extends keyof DesktopCommands>(
  command: K,
  args: DesktopCommands[K]['args'],
): Promise<DesktopCommands[K]['result']> {
  if (!desktop) return Promise.reject(new Error('This action requires the Tauri desktop app.'));
  return invoke<DesktopCommands[K]['result']>(command, args);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
