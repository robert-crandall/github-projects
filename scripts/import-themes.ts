import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LinearColorSpace, PlaneColorSpace, rampa } from '@basiclines/rampa-sdk';
import { z } from 'zod';

// Import palette data, not Copilot App code or its runtime dependencies.
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const palette = z.object({
  bg: color, fg: color,
  ansi: z.object({ b: color, r: color, g: color, y: color }),
});
const source = z.record(z.string(), z.object({ dark: palette.optional(), light: palette.optional() })
  .refine(theme => theme.dark || theme.light));
const input = process.argv[2];
if (!input) throw new Error('Usage: bun run themes:import /path/to/copilot-app/src/lib/themes/themes.json');
const catalog = source.parse(JSON.parse(readFileSync(input, 'utf8')));

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
}
function readable(value: string, backgrounds: string[], minimum = 4.5) {
  if (backgrounds.every(background => contrast(value, background) >= minimum)) return value;
  const endpoint = ['#000000', '#ffffff'].sort((a, b) =>
    Math.min(...backgrounds.map(bg => contrast(b, bg))) - Math.min(...backgrounds.map(bg => contrast(a, bg))))[0]!;
  for (let step = 1; step <= 100; step++) {
    const candidate = String(rampa.mix(value, endpoint, step / 100));
    if (backgrounds.every(background => contrast(candidate, background) >= minimum)) return candidate;
  }
  throw new Error(`Cannot make ${value} readable against ${backgrounds.join(', ')}`);
}
function external(p: z.infer<typeof palette>) {
  const neutral = new LinearColorSpace(p.bg, p.fg).interpolation('lab').distribution('ease-in-out').size(12);
  const planes = Object.fromEntries(Object.entries(p.ansi).map(([key, value]) =>
    [key, new PlaneColorSpace(p.bg, p.fg, value).interpolation('lab').distribution('ease-in-out').size(12)]));
  const n = (step: number) => String(neutral.palette[step]);
  const ramp = (key: string, step: number) => String(planes[key]!(11, step));
  const tint = (step: number) => String(rampa.mix(n(step), ramp('b', Math.min(step + 2, 11)), .18));
  const text = readable(n(11), [n(0)]);
  const muted = readable(tint(7), [n(0)]);
  const surface = (value: string) => {
    for (let step = 0; step <= 100; step++) {
      const candidate = step === 0 ? value : String(rampa.mix(value, n(0), step / 100));
      if ([text, muted].every(foreground => contrast(foreground, candidate) >= 4.5)) return candidate;
    }
    throw new Error(`Cannot keep text readable on ${value}`);
  };
  const sidebar = surface(n(2));
  const button = surface(tint(1));
  const hover = surface(tint(2));
  const pressed = surface(n(4));
  const surfaces = [n(0), sidebar, button, hover, pressed];
  const accent = readable(ramp('b', 11), surfaces);
  const primary = ramp('b', 10);
  const primaryHover = primary;
  const success = readable(ramp('g', 11), surfaces);
  const selected = hover;
  return {
    surface: n(0), sidebar, subtle: sidebar, input: n(0),
    button, hover, pressed, disabled: button,
    selected, 'selected-border': tint(5), text, secondary: muted, muted,
    border: tint(3), 'input-border': readable(tint(5), [n(0), sidebar], 3),
    accent, focus: accent, primary, 'primary-hover': primaryHover, 'primary-border': primary,
    'on-primary': readable(n(0), [primary, primaryHover]),
    success, 'success-border': success,
    warning: readable(ramp('y', 11), surfaces), danger: readable(ramp('r', 11), surfaces),
    'selection-background': text, 'selection-text': n(0),
  };
}
function github(tone: 'light' | 'dark') {
  const css = readFileSync(resolve(`node_modules/@primer/primitives/dist/css/functional/themes/${tone}.css`), 'utf8');
  const values = new Map([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
  const get = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing Primer token: ${name}`);
    return value.replace(/var\(--([\w-]+)\)/g, (_, key: string) => get(key));
  };
  const tokens = {
    surface: get('bgColor-default'), sidebar: get('bgColor-muted'), subtle: get('bgColor-muted'), input: get('bgColor-default'),
    button: get('control-bgColor-rest'), hover: get('control-bgColor-hover'), pressed: get('control-bgColor-hover'),
    disabled: get('bgColor-muted'), selected: get('bgColor-accent-muted'), 'selected-border': get('borderColor-default'),
    text: get('fgColor-default'), secondary: get('fgColor-muted'), muted: get('fgColor-muted'),
    border: get('borderColor-muted'), 'input-border': get('control-borderColor-emphasis'),
    accent: get('fgColor-accent'), focus: get('fgColor-accent'),
    primary: get('bgColor-accent-emphasis'), 'primary-hover': get('bgColor-accent-emphasis'),
    'primary-border': get('bgColor-accent-emphasis'), 'on-primary': get('fgColor-onEmphasis'),
    success: get('fgColor-success'), 'success-border': get('fgColor-success'),
    warning: get('fgColor-attention'), danger: get('fgColor-danger'),
    'selection-background': get('bgColor-accent-emphasis'), 'selection-text': get('fgColor-onEmphasis'),
  };
  if (tone === 'light') {
    const surfaces = [tokens.surface, tokens.sidebar, tokens.button, tokens.hover, tokens.selected];
    tokens.warning = readable(tokens.warning, surfaces);
    tokens.success = readable(tokens.success, surfaces);
    tokens['success-border'] = tokens.success;
  }
  return tokens;
}
const themes = Object.entries(catalog).map(([name, entry]) => ({
  name,
  ...Object.fromEntries((['dark', 'light'] as const).filter(tone => entry[tone]).map(tone =>
    [tone, name === 'GitHub' ? github(tone) : external(entry[tone]!)])),
}));
if (!themes.some(theme => theme.name === 'GitHub')) throw new Error('The catalog must contain GitHub.');
writeFileSync(new URL('../src/themes/catalog.json', import.meta.url), `${JSON.stringify(themes, null, 2)}\n`);
console.log(`Imported ${themes.length} themes.`);
