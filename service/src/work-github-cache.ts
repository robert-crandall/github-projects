import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './errors.ts';
import { workCandidateSchema } from './work-schema.ts';
import { privateAppDirectory } from './work-storage.ts';

export const SEARCH_OVERLAP_MS = 5 * 60_000;
export const SEARCH_RECONCILE_MS = 6 * 60 * 60_000;
export const CACHE_ENTRY_BYTES = 16 * 1024 * 1024;
const CACHE_TOTAL_BYTES = 128 * 1024 * 1024;
export const cacheHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = z.iso.datetime();
const sourceUrl = z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*$/).max(2000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const cachedTimelineSchema = z.strictObject({
  revision: digest, fetchedAt: time, events: z.array(z.unknown()).max(200),
  warnings: z.array(z.string().max(1000)).max(30),
});
const cachedCandidateSchema = workCandidateSchema.extend({ url: sourceUrl });
const replySchema = z.strictObject({
  key: digest, candidates: z.array(cachedCandidateSchema).max(200),
});
export const githubCacheStateSchema = z.strictObject({
  version: z.literal(1),
  scannedAt: time.nullable(), reconciledAt: time.nullable(),
  members: z.array(sourceUrl).max(200),
  timelines: z.array(z.tuple([sourceUrl, cachedTimelineSchema])).max(300),
  replies: z.array(replySchema).max(300),
  pending: z.array(z.strictObject({ at: time, candidate: cachedCandidateSchema })).max(1000),
});
export type GitHubCacheState = z.infer<typeof githubCacheStateSchema>;
export type CachedTimeline = z.infer<typeof cachedTimelineSchema>;
export type GitHubCacheRecord = { revision: number; state: GitHubCacheState };

export function emptyGitHubCache(): GitHubCacheState {
  return { version: 1, scannedAt: null, reconciledAt: null, members: [], timelines: [], replies: [], pending: [] };
}

// Appending another updated qualifier can replace rather than intersect the saved
// range. Boolean/relative/unknown syntax stays verbatim on the full-search path.
export function incrementalSearchSafe(query: string): boolean {
  const qualifiers = new Set([
    'repo', 'org', 'user', 'is', 'type', 'state', 'archived', 'assignee', 'author',
    'mentions', 'commenter', 'involves', 'user-review-requested', 'team-review-requested',
    'review-requested', 'reviewed-by', 'review', 'label', 'no', 'has', 'milestone',
    'project', 'language',
  ]);
  const tokens = query.match(/(?:[^\s"]|"[^"]*")+/g);
  if (!tokens || tokens.join(' ') !== query.trim().replace(/\s+/g, ' ')) return false;
  return tokens.every(token => {
    if (/[()\\]/.test(token) || /^(AND|OR|NOT)$/i.test(token) || /@(?:today|now)/i.test(token)) return false;
    const match = /^-?([a-z-]+):(.+)$/i.exec(token);
    if (!match) return !token.includes(':') && !token.includes('"') && !/[<>]/.test(token);
    return qualifiers.has(match[1]!.toLowerCase()) && !/[<>]/.test(match[2]!);
  });
}

/** Private, versioned snapshots. CAS prevents concurrent collectors losing replay data. */
export class WorkGitHubCache {
  private database?: Database;
  constructor(private readonly options: { path?: string } = {}) {}
  private db(): Database {
    if (this.database) return this.database;
    let db: Database | undefined;
    try {
      const path = this.options.path ?? join(privateAppDirectory(), 'work-github-cache', 'cache.sqlite3');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
      db = new Database(path, { create: true, strict: true });
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS collections (
          key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL
        );`);
      this.database = db;
      return db;
    } catch {
      db?.close();
      throw new ServiceError('internal');
    }
  }
  load(key: string): GitHubCacheRecord {
    try {
      const row = this.db().query<{ revision: number; payload: string; checksum: string }, [string]>(
        'SELECT revision, payload, checksum FROM collections WHERE key = ?',
      ).get(key);
      if (!row) return { revision: 0, state: emptyGitHubCache() };
      if (Buffer.byteLength(row.payload) > CACHE_ENTRY_BYTES) throw new ServiceError('limit');
      if (row.checksum !== cacheHash(row.payload)) throw new ServiceError('invalid_output');
      const state = githubCacheStateSchema.safeParse(JSON.parse(row.payload));
      if (!state.success || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ServiceError('invalid_output');
      if (new Set(state.data.members).size !== state.data.members.length
        || new Set(state.data.timelines.map(([url]) => url)).size !== state.data.timelines.length
        || new Set(state.data.replies.map(reply => reply.key)).size !== state.data.replies.length) throw new ServiceError('invalid_output');
      if (Boolean(state.data.scannedAt) !== Boolean(state.data.reconciledAt)
        || state.data.scannedAt && state.data.reconciledAt
          && Date.parse(state.data.reconciledAt) > Date.parse(state.data.scannedAt)) throw new ServiceError('invalid_output');
      return { revision: row.revision, state: state.data };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('invalid_output');
    }
  }
  save(key: string, previousRevision: number, state: GitHubCacheState): void {
    const parsed = githubCacheStateSchema.safeParse(state);
    if (!parsed.success || !Number.isSafeInteger(previousRevision + 1)) throw new ServiceError('limit');
    const payload = JSON.stringify(parsed.data);
    if (Buffer.byteLength(payload) > CACHE_ENTRY_BYTES) throw new ServiceError('limit');
    try {
      const db = this.db();
      db.transaction(() => {
        const previous = db.query<{ revision: number }, [string]>('SELECT revision FROM collections WHERE key = ?').get(key);
        if ((previous?.revision ?? 0) !== previousRevision) throw new ServiceError('busy', true);
        const size = db.query<{ bytes: number; count: number }, [string]>(
          'SELECT coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes, count(*) AS count FROM collections WHERE key != ?',
        ).get(key)!;
        if (size.count >= 100 || size.bytes + Buffer.byteLength(payload) > CACHE_TOTAL_BYTES) throw new ServiceError('limit');
        db.query('INSERT OR REPLACE INTO collections (key, revision, payload, checksum) VALUES (?, ?, ?, ?)')
          .run(key, previousRevision + 1, payload, cacheHash(payload));
      }).immediate();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('internal');
    }
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
