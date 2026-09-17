import { invoke, isTauri } from '@tauri-apps/api/core';
import { ThemeController, type Preferences, type Tokens, type Tone } from './controller.ts';

export const storageKey = 'github-projects:appearance:v1';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const native = isTauri();

export function applyDocumentTheme(preferences: Preferences, tone: Tone, tokens: Tokens) {
  const root = document.documentElement;
  for (const [role, value] of Object.entries(tokens)) root.style.setProperty(`--${role}`, value);
  root.dataset.theme = preferences.name;
  root.dataset.themeMode = preferences.mode;
  root.dataset.themeTone = tone;
  root.style.colorScheme = tone;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = tokens.surface!;
}

export const themes = new ThemeController({
  read: async () => {
    if (native) return invoke('appearance_read');
    const value = localStorage.getItem(storageKey);
    return value === null ? null : JSON.parse(value);
  },
  write: async preferences => {
    if (native) await invoke('appearance_save', { preferences });
    else localStorage.setItem(storageKey, JSON.stringify(preferences));
  },
  systemDark: () => media.matches,
  apply: applyDocumentTheme,
  applyNative: native ? async (tone, background, mode) => {
    await invoke('appearance_apply', { tone, background, mode });
  } : undefined,
});

media.addEventListener('change', themes.systemChanged);
if (import.meta.hot) import.meta.hot.dispose(() => media.removeEventListener('change', themes.systemChanged));
