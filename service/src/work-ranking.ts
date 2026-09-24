import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { checkAbort, ServiceError } from './errors.ts';
import { LIMITS } from './schema.ts';
import { semanticRankTask, type SemanticRankTask } from './work-rank-input.ts';
import { workRankOutputSchema, type WorkRankInput } from './work-schema.ts';

// Bump when assessment meaning, canonical inputs, or either prompt changes.
export const ASSESSMENT_VERSION = 'work-assessment-v1';
export const ASSESSMENT_MAX_AGE = 24 * 60 * 60 * 1000;
export const ORDER_MAX_AGE = 60 * 60 * 1000;
export const MIN_REEVALUATION = 60 * 1000;
export const CACHE_LIMITS = { records: 10000, bytes: 32 * 1024 * 1024, fileBytes: 64 * 1024 * 1024 } as const;
const time = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(400);
export const assessmentSchema = z.strictObject({
  importance: text, urgency: text, blockers: text,
  supportingEvidence: z.array(z.strictObject({
    reference: z.string().min(1).max(500), summary: z.string().trim().min(1).max(240),
  })).min(1).max(8),
  uncertainty: z.string().max(400),
  reevaluateAt: time,
});
export type Assessment = z.infer<typeof assessmentSchema>;
const savedAssessmentSchema = z.strictObject({
  id: z.string().min(1).max(500), fingerprint: hash,
  evaluatedAt: time, assessment: assessmentSchema,
});
export type SavedAssessment = z.infer<typeof savedAssessmentSchema>;
const savedOrderSchema = z.strictObject({
  fingerprint: hash, result: workRankOutputSchema.extend({ evaluatedAt: time, expiresAt: time }),
});
type SavedOrder = z.infer<typeof savedOrderSchema>;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function assessmentScope(credential: string, input: WorkRankInput, version = ASSESSMENT_VERSION): string {
  return digest(['github-projects:work-assessments', credential, input.instructions, input.model, version]);
}
export function exactPermutation(expected: string[], actual: string[], code: 'copilot_output' | 'assessment_storage' = 'copilot_output'): void {
  const ids = new Set(actual);
  if (ids.size !== actual.length || expected.length !== actual.length || expected.some(id => !ids.has(id))) {
    throw new ServiceError(code);
  }
}
export function validateReevaluation(at: string, evaluatedAt: string, maxAge: number): void {
  const duration = Date.parse(at) - Date.parse(evaluatedAt);
  if (duration < MIN_REEVALUATION || duration > maxAge) throw new ServiceError('copilot_output');
}
export function validateAssessment(value: Assessment, task: SemanticRankTask, evaluatedAt: string): void {
  validateReevaluation(value.reevaluateAt, evaluatedAt, ASSESSMENT_MAX_AGE);
  const references = new Set([
    '$title', '$createdAt', '$availability', ...task.evidence.map(event => event.id),
    ...(task.notes ? ['$notes'] : []), ...(task.context ? ['$source'] : []),
  ]);
  if (value.supportingEvidence.some(item => !references.has(item.reference))
    || task.availability === 'unknown' && !value.uncertainty.trim()) throw new ServiceError('copilot_output');
}

/** No raw task bodies or credentials: only bounded derived assessments and one order per scope. */
export class WorkAssessmentCache {
  constructor(private readonly path: string, private readonly limits: { records: number; bytes: number } = CACHE_LIMITS) {}

  private use<T>(operation: (db: Database) => T): T {
    let db: Database | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      closeSync(openSync(this.path, 'a', 0o600));
      chmodSync(this.path, 0o600);
      if (statSync(this.path).size > CACHE_LIMITS.fileBytes) throw new ServiceError('assessment_capacity');
      db = new Database(this.path, { create: true, strict: true });
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;`);
      const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
      db.exec(`PRAGMA max_page_count=${Math.floor(CACHE_LIMITS.fileBytes / pageSize)};
        CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
      return operation(db);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('assessment_storage');
    } finally { db?.close(); }
  }

  private key(scope: string, kind: string, id = '') { return digest([scope, kind, id]); }
  private read<T>(db: Database, key: string, schema: z.ZodType<T>): T | undefined {
    const row = db.query<{ payload: string }, [string]>('SELECT payload FROM records WHERE key = ?').get(key);
    if (!row) return undefined;
    return schema.parse(JSON.parse(row.payload));
  }
  load(scope: string, ids: string[]): { assessments: Map<string, SavedAssessment>; order?: SavedOrder } {
    return this.use(db => db.transaction(() => {
      const assessments = new Map<string, SavedAssessment>();
      for (const id of ids) {
        const value = this.read(db, this.key(scope, 'assessment', id), savedAssessmentSchema);
        if (value) {
          if (value.id !== id) throw new ServiceError('assessment_storage');
          assessments.set(id, value);
        }
      }
      return { assessments, order: this.read(db, this.key(scope, 'order'), savedOrderSchema) };
    })());
  }
  private write(rows: { key: string; payload: string }[]): void {
    this.use(db => db.transaction(() => {
      const insert = db.query('INSERT INTO records (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload');
      for (const row of rows) insert.run(row.key, row.payload);
      const size = db.query<{ count: number; bytes: number }, []>(
        'SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB)) + length(key)), 0) AS bytes FROM records',
      ).get()!;
      if (size.count > this.limits.records || size.bytes > this.limits.bytes) throw new ServiceError('assessment_capacity');
    }).immediate());
  }
  saveAssessments(scope: string, values: SavedAssessment[]): void {
    this.write(values.map(value => ({
      key: this.key(scope, 'assessment', value.id), payload: JSON.stringify(savedAssessmentSchema.parse(value)),
    })));
  }
  saveOrder(scope: string, value: SavedOrder): void {
    this.write([{ key: this.key(scope, 'order'), payload: JSON.stringify(savedOrderSchema.parse(value)) }]);
  }
}

export type AssessmentInput = { evaluatedAt: string; tasks: SemanticRankTask[] };
export type AssessmentOutput = { assessments: (Assessment & { id: string })[] };
export type OrderInput = {
  evaluatedAt: string;
  tasks: { id: string; assessedAt: string; assessment: Assessment }[];
};
export type OrderOutput = { ranking: { id: string; reason: string }[]; reevaluateAt: string };
export type RankingModels = {
  assess(input: AssessmentInput): Promise<AssessmentOutput>;
  order(input: OrderInput): Promise<OrderOutput>;
};

export class WorkRanker {
  constructor(private readonly cache: WorkAssessmentCache, private readonly now: () => Date = () => new Date()) {}

  async rank(input: WorkRankInput, scope: string, models: RankingModels, signal: AbortSignal) {
    checkAbort(signal);
    const tasks = input.tasks.map(semanticRankTask).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const evaluatedAt = this.now().toISOString();
    const now = Date.parse(evaluatedAt);
    const { assessments, order } = this.cache.load(scope, tasks.map(task => task.id));
    const fingerprints = new Map(tasks.map(task => [task.id, digest(task)]));
    const changed = tasks.filter(task => {
      const cached = assessments.get(task.id);
      if (!cached) return true;
      // A backwards clock or stale content can never extend a model judgment.
      return cached.fingerprint !== fingerprints.get(task.id) || Date.parse(cached.evaluatedAt) > now
        || Date.parse(cached.assessment.reevaluateAt) <= now;
    });
    const batches: SemanticRankTask[][] = [];
    const bytes = (tasks: SemanticRankTask[]) => Buffer.byteLength(JSON.stringify({ evaluatedAt, tasks }));
    let batch: SemanticRankTask[] = [];
    for (const task of changed) {
      if (bytes([task]) > LIMITS.workModelBytes) throw new ServiceError('limit');
      if (batch.length && (batch.length >= LIMITS.workAssessmentTasks || bytes([...batch, task]) > LIMITS.workModelBytes)) {
        batches.push(batch);
        batch = [];
      }
      batch.push(task);
    }
    if (batch.length) batches.push(batch);
    for (const tasks of batches) {
      checkAbort(signal);
      const assessedAt = this.now().toISOString();
      const assessmentInput = { evaluatedAt: assessedAt, tasks };
      const result = await models.assess(assessmentInput);
      checkAbort(signal);
      exactPermutation(tasks.map(task => task.id), result.assessments.map(value => value.id));
      const values = result.assessments.map(({ id, ...assessment }) => {
        const task = tasks.find(task => task.id === id)!;
        validateAssessment(assessment, task, assessedAt);
        if (Date.parse(assessment.reevaluateAt) <= this.now().getTime()) throw new ServiceError('copilot_output');
        return { id, fingerprint: fingerprints.get(id)!, evaluatedAt: assessedAt, assessment };
      });
      // Commit each batch before continuing so a later failure retains paid-for assessments.
      this.cache.saveAssessments(scope, values);
      for (const value of values) assessments.set(value.id, value);
    }
    const current = tasks.map(task => {
      const cached = assessments.get(task.id)!;
      try { validateAssessment(cached.assessment, task, cached.evaluatedAt); }
      catch (error) {
        if (error instanceof ServiceError && error.dto.code === 'copilot_output') throw new ServiceError('assessment_storage');
        throw error;
      }
      return cached;
    });
    const fingerprint = digest(current);
    const orderAt = this.now().toISOString();
    const earliestExpiry = Math.min(...current.map(value => Date.parse(value.assessment.reevaluateAt)));
    if (earliestExpiry <= Date.parse(orderAt)) throw new ServiceError('copilot_output');
    if (order?.fingerprint === fingerprint && Date.parse(order.result.evaluatedAt) <= Date.parse(orderAt)
      && Date.parse(order.result.expiresAt) > Date.parse(orderAt)) {
      const result = order.result;
      if (Date.parse(result.expiresAt) > Math.min(Date.parse(result.evaluatedAt) + ORDER_MAX_AGE, earliestExpiry)) {
        throw new ServiceError('assessment_storage');
      }
      exactPermutation(tasks.map(task => task.id), result.orderedIds, 'assessment_storage');
      exactPermutation(tasks.map(task => task.id), result.reasons.map(value => value.id), 'assessment_storage');
      return result;
    }
    const orderInput = {
      evaluatedAt: orderAt,
      tasks: current.map(value => ({ id: value.id, assessedAt: value.evaluatedAt, assessment: value.assessment })),
    };
    if (Buffer.byteLength(JSON.stringify(orderInput)) > LIMITS.workModelBytes) throw new ServiceError('limit');
    const ordered = await models.order(orderInput);
    checkAbort(signal);
    exactPermutation(tasks.map(task => task.id), ordered.ranking.map(value => value.id));
    validateReevaluation(ordered.reevaluateAt, orderAt, ORDER_MAX_AGE);
    const expiresAt = Math.min(Date.parse(ordered.reevaluateAt), earliestExpiry);
    if (expiresAt <= this.now().getTime()) throw new ServiceError('copilot_output');
    const result = savedOrderSchema.shape.result.parse({
      orderedIds: ordered.ranking.map(value => value.id),
      reasons: ordered.ranking.map(value => ({ id: value.id, reason: value.reason })),
      evaluatedAt: orderAt, expiresAt: new Date(expiresAt).toISOString(),
    });
    this.cache.saveOrder(scope, { fingerprint, result });
    return result;
  }
}
