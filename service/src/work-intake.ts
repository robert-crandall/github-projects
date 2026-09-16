import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './errors.ts';
import { normalizeWorkUrl } from './work-mcp.ts';
import { privateAppDirectory } from './work-storage.ts';
import {
  workActionSchema, workCandidateSchema, workIntakeAckSchema, workIntakeOutputSchema,
} from './work-schema.ts';

export const addTaskSchema = z.strictObject({
  source: z.enum(['copilot', 'mcp']),
  producer: z.string().trim().min(1).max(200),
  eventId: z.string().trim().min(1).max(500),
  occurredAt: z.iso.datetime(),
  action: workActionSchema,
  title: workCandidateSchema.shape.title,
  url: workCandidateSchema.shape.url,
  summary: z.string().trim().min(1).max(2000),
});
export type AddTask = z.infer<typeof addTaskSchema>;

export class WorkIntake {
  private database?: Database;
  constructor(private readonly options: { path?: string; now?: () => Date } = {}) {}
  private db() {
    if (this.database) return this.database;
    const path = this.options.path ?? join(privateAppDirectory(), 'work-intake', 'intake.sqlite3');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    const db = new Database(path, { create: true, strict: true });
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS intake (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, candidate TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
      );`);
    this.database = db;
    return db;
  }
  add(raw: unknown) {
    const parsed = addTaskSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError('invalid_input');
    const input = parsed.data;
    if (Date.parse(input.occurredAt) > (this.options.now?.() ?? new Date()).getTime() + 300_000) throw new ServiceError('invalid_input');
    const id = `intake:${createHash('sha256').update(JSON.stringify([input.source, input.producer, input.eventId])).digest('hex')}`;
    const payload = JSON.stringify(input);
    const candidate = workCandidateSchema.parse({
      title: input.title, action: input.action, url: normalizeWorkUrl(input.url),
      evidence: [{
        id, source: input.source, streamId: `push:${input.source}`, at: input.occurredAt,
        url: input.url, summary: `${input.summary}\nProducer: ${input.producer}`.slice(0, 2000),
      }],
    });
    const db = this.db();
    return db.transaction(() => {
      const existing = db.query<{ payload: string; consumed: number }, [string]>('SELECT payload, consumed FROM intake WHERE id = ?').get(id);
      if (existing) {
        if (existing.payload !== payload) throw new ServiceError('invalid_input');
        return { id, duplicate: true, pending: existing.consumed === 0 };
      }
      const count = db.query<{ count: number }, []>('SELECT count(*) AS count FROM intake').get()!.count;
      if (count >= 100_000) throw new ServiceError('limit');
      db.query('INSERT INTO intake (id, payload, candidate) VALUES (?, ?, ?)').run(id, payload, JSON.stringify(candidate));
      return { id, duplicate: false, pending: true };
    }).immediate();
  }
  pending() {
    const rows = this.db().query<{ id: string; candidate: string }, []>(
      'SELECT id, candidate FROM intake WHERE consumed = 0 ORDER BY rowid LIMIT 201',
    ).all();
    return workIntakeOutputSchema.parse({
      items: rows.slice(0, 200).map(row => ({ id: row.id, candidate: JSON.parse(row.candidate) })),
      hasMore: rows.length > 200,
    });
  }
  ack(raw: unknown) {
    const input = workIntakeAckSchema.safeParse(raw);
    if (!input.success) throw new ServiceError('invalid_input');
    const db = this.db();
    db.transaction(() => {
      const update = db.query('UPDATE intake SET consumed = 1 WHERE id = ?');
      for (const id of input.data.ids) update.run(id);
    }).immediate();
    return input.data;
  }
  close() { this.database?.close(); this.database = undefined; }
}
