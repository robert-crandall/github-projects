import { z } from 'zod';
import { workSettingsSchema } from '../../service/src/work-schema.ts';
import { workProfileIdentitySchema, type AppState } from '../types.ts';
import { createWorkProfile } from './profiles.ts';

export const MAX_PROFILE_FILE_BYTES = 2 * 1024 * 1024;
export const profileFileSchema = z.strictObject({
  format: z.literal('github-projects-work-profile'),
  version: z.literal(1),
  name: workProfileIdentitySchema.shape.name,
  settings: workSettingsSchema,
});
export type ProfileFile = z.infer<typeof profileFileSchema>;

export function decodeProfileFile(text: string): ProfileFile {
  if (new TextEncoder().encode(text).byteLength > MAX_PROFILE_FILE_BYTES) {
    throw new Error('Profile files must be 2 MiB or smaller.');
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('This file is not valid JSON. Choose an exported work profile.'); }
  const parsed = profileFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`This file is not a supported work profile. Check ${issue.path.join('.') || 'the file format'}: ${issue.message}`);
  }
  return parsed.data;
}

export function encodeProfileFile(state: AppState): string {
  return JSON.stringify(profileFileSchema.parse({
    format: 'github-projects-work-profile', version: 1,
    name: state.activeWorkProfile.name, settings: state.work.settings,
  }), null, 2);
}

export function profileFilename(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `github-projects-profile${slug ? `-${slug}` : ''}.json`;
}

export function importWorkProfile(state: AppState, file: ProfileFile, name: string): AppState {
  const parsed = profileFileSchema.parse(file);
  const next = createWorkProfile(state, name);
  const settings = structuredClone(parsed.settings);
  settings.schedule.enabled = false;
  return { ...next, work: { ...next.work, settings } };
}
