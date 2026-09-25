import { z } from 'zod';

export const idSchema = z.string().min(1).max(500).regex(/^[A-Za-z0-9:_.\/-]+$/);
export const repoSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/);
export const referenceSchema = z.strictObject({
  repo: repoSchema, number: z.number().int().positive().safe(), kind: z.enum(['pr', 'issue']),
});

export function githubReference(value: string): z.infer<typeof referenceSchema> | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname) || url.username || url.password) return null;
  const match = /^\/([^/]+\/[^/]+)\/(issues|pull|pulls)\/(\d+)(?:\/|$)/i.exec(url.pathname);
  const parsed = referenceSchema.safeParse(match && {
    repo: match[1]!.toLowerCase(), kind: match[2]!.toLowerCase() === 'issues' ? 'issue' : 'pr', number: Number(match[3]),
  });
  return parsed.success ? parsed.data : null;
}
