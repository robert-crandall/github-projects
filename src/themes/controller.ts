import { z } from 'zod';
import catalogData from './catalog.json' with { type: 'json' };

export const toneSchema = z.enum(['light', 'dark']);
export const modeSchema = z.enum(['light', 'dark', 'system']);
export type Tone = z.infer<typeof toneSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type Tokens = Record<string, string>;
export type Theme = { name: string; light?: Tokens; dark?: Tokens };
export const catalog: readonly Theme[] = catalogData;
const byName = new Map(catalog.map(theme => [theme.name, theme]));
export const preferencesSchema = z.object({
  name: z.string().refine(name => byName.has(name), 'This theme is no longer in the catalog. Choose another theme.'),
  mode: modeSchema,
}).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaults: Preferences = { name: 'GitHub', mode: 'dark' };

export function resolveTheme(preferences: Preferences, systemDark: boolean) {
  const valid = preferencesSchema.parse(preferences);
  const theme = byName.get(valid.name)!;
  const requested: Tone = valid.mode === 'system' ? (systemDark ? 'dark' : 'light') : valid.mode;
  const tone = theme[requested] ? requested : requested === 'dark' ? 'light' : 'dark';
  const tokens = theme[tone];
  if (!tokens) throw new Error(`${theme.name} has no palette.`);
  return { tone, tokens };
}

type State = {
  preferences: Preferences; tone: Tone; pending: boolean;
  storageError: string; appearanceError: string;
};
type Options = {
  read: () => Promise<unknown>;
  write: (preferences: Preferences) => Promise<void>;
  systemDark: () => boolean;
  apply: (preferences: Preferences, tone: Tone, tokens: Tokens) => void;
  applyNative?: (tone: Tone, background: string, mode: Mode) => Promise<void>;
};
function message(error: unknown) {
  if (error instanceof Error) return error.message;
  const failure = z.object({ message: z.string() }).safeParse(error);
  return failure.success ? failure.data.message : 'The operation failed.';
}

export class ThemeController {
  private state: State;
  private listeners = new Set<() => void>();
  private writes = Promise.resolve();
  private nativeWrites = Promise.resolve();
  private revision = 0;
  private nativeRevision = 0;
  private retryRead = false;
  constructor(private readonly options: Options) {
    this.state = { preferences: defaults, tone: resolveTheme(defaults, options.systemDark()).tone,
      pending: false, storageError: '', appearanceError: '' };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  async load() {
    const revision = this.revision;
    try {
      const stored = await this.options.read();
      if (revision !== this.revision) return;
      const preferences = stored === null ? defaults : preferencesSchema.parse(stored);
      this.retryRead = false;
      this.publish({ preferences, storageError: '' });
    } catch (error) {
      if (revision !== this.revision) return;
      this.retryRead = true;
      this.publish({ storageError: `Could not read your theme. ${message(error)} Choose a theme or retry.` });
    }
    this.apply();
  }
  private apply() {
    const { tone, tokens } = resolveTheme(this.state.preferences, this.options.systemDark());
    this.options.apply(this.state.preferences, tone, tokens);
    this.publish({ tone });
    const revision = ++this.nativeRevision;
    const mode = this.state.preferences.mode;
    this.nativeWrites = this.nativeWrites.then(async () => {
      if (revision !== this.nativeRevision) return;
      try {
        await this.options.applyNative?.(tone, tokens.surface!, mode);
        if (revision === this.nativeRevision) this.publish({ appearanceError: '' });
      } catch (error) {
        if (revision === this.nativeRevision) this.publish({
          appearanceError: `The window appearance could not change. ${message(error)} Retry to match the window to your theme.`,
        });
      }
    });
  }
  systemChanged = () => {
    if (this.state.preferences.mode === 'system') this.apply();
  };
  async select(input: Preferences) {
    const parsed = preferencesSchema.safeParse(input);
    if (!parsed.success) {
      this.publish({ storageError: 'Choose an available theme and Light, Dark, or System mode.' });
      return;
    }
    this.retryRead = false;
    const preferences = parsed.data;
    const revision = ++this.revision;
    this.publish({ preferences, pending: true, storageError: '' });
    this.apply();
    this.writes = this.writes.then(async () => {
      try {
        await this.options.write(preferences);
        if (revision === this.revision) this.publish({ pending: false, storageError: '' });
      } catch (error) {
        if (revision === this.revision) this.publish({
          pending: false, storageError: `Your theme changed but was not saved. ${message(error)} Retry to keep it after relaunch.`,
        });
      }
    });
    await this.writes;
  }
  retry = async () => {
    if (this.retryRead) await this.load();
    else if (this.state.storageError) await this.select(this.state.preferences);
    else this.apply();
  };
}
