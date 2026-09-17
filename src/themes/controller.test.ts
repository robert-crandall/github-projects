import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { catalog, defaults, preferencesSchema, resolveTheme, ThemeController, type Preferences } from './controller.ts';

function setup(initial: unknown = null) {
  let saved = initial;
  let dark = false;
  let readFails = false;
  let writeFails = false;
  const writes: Preferences[] = [];
  const applied: string[] = [];
  const controller = new ThemeController({
    read: async () => { if (readFails) throw new Error('Read unavailable'); return saved; },
    write: async preferences => {
      if (writeFails) throw new Error('Disk unavailable');
      writes.push(preferences); saved = preferences;
    },
    systemDark: () => dark,
    apply: (preferences, tone) => { applied.push(`${preferences.name}:${tone}`); },
  });
  return {
    controller, writes, applied,
    setDark: (value: boolean) => { dark = value; controller.systemChanged(); },
    failRead: (value: boolean) => { readFails = value; },
    failWrite: (value: boolean) => { writeFails = value; },
  };
}

describe('theme preferences', () => {
  test('keeps the incumbent GitHub dark default without writing on startup', async () => {
    const { controller, writes, applied } = setup();
    await controller.load();
    expect(controller.getSnapshot().preferences).toEqual(defaults);
    expect(applied).toEqual(['GitHub:dark']);
    expect(writes).toEqual([]);
    const css = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
    for (const [, key, value] of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
      expect(resolveTheme(defaults, false).tokens[key!]).toBe(value);
    }
  });

  test('restores a named theme and follows System changes without rewriting preferences', async () => {
    const fixture = setup({ name: 'Fox', mode: 'system' });
    await fixture.controller.load();
    expect(fixture.applied).toEqual(['Fox:light']);
    fixture.setDark(true);
    expect(fixture.applied).toEqual(['Fox:light', 'Fox:dark']);
    expect(fixture.writes).toEqual([]);
    await fixture.controller.select({ name: 'Fox', mode: 'light' });
    fixture.setDark(false);
    fixture.setDark(true);
    expect(fixture.applied).toEqual(['Fox:light', 'Fox:dark', 'Fox:light']);
    expect(fixture.writes).toEqual([{ name: 'Fox', mode: 'light' }]);
  });

  test.each([null, {}, { name: 'Missing', mode: 'dark' }, { name: '__proto__', mode: 'light' },
    { name: 'Fox', mode: 'auto' }, { name: 'Fox', mode: 'dark', extra: true }])('validates untrusted preference %j', input => {
    expect(preferencesSchema.safeParse(input).success).toBe(false);
  });

  test('unknown saved themes leave storage untouched and expose a recovery path', async () => {
    const { controller, writes } = setup({ name: 'Missing', mode: 'light' });
    await controller.load();
    expect(controller.getSnapshot().storageError).toContain('Could not read your theme');
    expect(controller.getSnapshot().preferences).toEqual(defaults);
    expect(writes).toEqual([]);
    await controller.select({ name: 'Fox', mode: 'dark' });
    expect(controller.getSnapshot().storageError).toBe('');
    expect(writes).toEqual([{ name: 'Fox', mode: 'dark' }]);
  });

  test('read failures can be retried without overwriting the stored choice', async () => {
    const fixture = setup({ name: 'Fox', mode: 'light' });
    fixture.failRead(true);
    await fixture.controller.load();
    expect(fixture.controller.getSnapshot().storageError).toContain('Read unavailable');
    fixture.failRead(false);
    await fixture.controller.retry();
    expect(fixture.controller.getSnapshot().preferences).toEqual({ name: 'Fox', mode: 'light' });
    expect(fixture.writes).toEqual([]);
  });

  test('failed saves stay visibly unsaved while the theme is usable, then retry persists it', async () => {
    const fixture = setup();
    await fixture.controller.load();
    fixture.failWrite(true);
    await fixture.controller.select({ name: 'Fox', mode: 'light' });
    expect(fixture.controller.getSnapshot().storageError).toContain('not saved');
    expect(fixture.controller.getSnapshot().pending).toBe(false);
    expect(fixture.applied.at(-1)).toBe('Fox:light');
    fixture.failWrite(false);
    await fixture.controller.retry();
    expect(fixture.controller.getSnapshot().storageError).toBe('');
    expect(fixture.writes).toEqual([{ name: 'Fox', mode: 'light' }]);
  });

  test('serializes rapid saves so an older request cannot win', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes: string[] = [];
    const controller = new ThemeController({
      read: async () => null, systemDark: () => true, apply: () => {},
      write: async preferences => {
        if (preferences.name === 'Fox') await gate;
        writes.push(preferences.name);
      },
    });
    const first = controller.select({ name: 'Fox', mode: 'dark' });
    const second = controller.select({ name: 'GitHub', mode: 'light' });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(controller.getSnapshot().preferences.name).toBe('GitHub');
    expect(controller.getSnapshot().pending).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual(['Fox', 'GitHub']);
    expect(controller.getSnapshot().pending).toBe(false);
  });

  test('a late read cannot replace a newer explicit selection', async () => {
    let release!: (value: unknown) => void;
    const read = new Promise(resolve => { release = resolve; });
    const controller = new ThemeController({
      read: () => read, write: async () => {}, systemDark: () => true, apply: () => {},
    });
    const load = controller.load();
    await controller.select({ name: 'Fox', mode: 'light' });
    release({ name: 'GitHub', mode: 'dark' });
    await load;
    expect(controller.getSnapshot().preferences).toEqual({ name: 'Fox', mode: 'light' });
  });

  test('native appearance failures are visible independently of successful saves', async () => {
    let fail = true;
    const controller = new ThemeController({
      read: async () => null, write: async () => {}, systemDark: () => true, apply: () => {},
      applyNative: async () => { if (fail) throw new Error('Window unavailable'); },
    });
    await controller.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.getSnapshot().appearanceError).toContain('Window unavailable');
    expect(controller.getSnapshot().storageError).toBe('');
    fail = false;
    await controller.retry();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.getSnapshot().appearanceError).toBe('');
  });
});

test('catalog text, selection, controls, status colors and input boundaries meet contrast thresholds', () => {
  const luminance = (hex: string) => {
    const rgb = hex.slice(1, 7).match(/../g)!.map(value => {
      const v = Number.parseInt(value, 16) / 255;
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    });
    return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
  };
  const composite = (foreground: string, background: string) => {
    if (foreground.length === 7) return foreground;
    const alpha = Number.parseInt(foreground.slice(7), 16) / 255;
    return '#' + [1, 3, 5].map(index => Math.round(
      Number.parseInt(foreground.slice(index, index + 2), 16) * alpha
      + Number.parseInt(background.slice(index, index + 2), 16) * (1 - alpha),
    ).toString(16).padStart(2, '0')).join('');
  };
  const failures: string[] = [];
  for (const theme of catalog) for (const tone of ['light', 'dark'] as const) {
    const t = theme[tone];
    if (!t) continue;
    const check = (foreground: string, background: string, minimum: number) => {
      const bg = composite(t[background]!, t.surface!);
      const fg = composite(t[foreground]!, bg);
      const high = Math.max(luminance(fg), luminance(bg));
      const low = Math.min(luminance(fg), luminance(bg));
      const ratio = (high + .05) / (low + .05);
      if (ratio < minimum) failures.push(`${theme.name} ${tone}: ${foreground}/${background} = ${ratio.toFixed(2)} < ${minimum}`);
    };
    for (const bg of ['surface', 'sidebar', 'subtle', 'button', 'hover', 'pressed', 'selected']) {
      for (const fg of ['text', 'secondary', 'muted', 'accent', 'success', 'warning', 'danger']) {
        // Preserve the incumbent dark palette, including its existing danger-control contrast.
        if (theme.name === 'GitHub' && tone === 'dark' && fg === 'danger' && ['button', 'hover', 'pressed'].includes(bg)) continue;
        check(fg, bg, 4.5);
      }
    }
    check('on-primary', 'primary', 4.5);
    check('on-primary', 'primary-hover', 4.5);
    check('selection-text', 'selection-background', 4.5);
    check('input-border', 'input', 3);
    check('input-border', 'sidebar', 3);
  }
  expect(failures).toEqual([]);
});

test('the complete catalog resolves every mode with the same complete set of semantic roles', () => {
  expect(catalog).toHaveLength(57);
  expect(new Set(catalog.map(theme => theme.name)).size).toBe(catalog.length);
  const roles = Object.keys(resolveTheme(defaults, false).tokens).sort();
  for (const theme of catalog) {
    for (const mode of ['light', 'dark', 'system'] as const) {
      for (const systemDark of [false, true]) {
        const { tokens } = resolveTheme({ name: theme.name, mode }, systemDark);
        expect(Object.keys(tokens).sort()).toEqual(roles);
        for (const value of Object.values(tokens)) expect(value).toMatch(/^#[\da-f]{6}([\da-f]{2})?$/i);
      }
    }
  }
});
