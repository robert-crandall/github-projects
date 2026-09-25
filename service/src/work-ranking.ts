import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { checkAbort, ServiceError } from './errors.ts';
import { LIMITS } from './schema.ts';
import { orderingRankTask, semanticRankTask, type SemanticRankTask } from './work-rank-input.ts';
import { workRankOutputSchema, type WorkRankInput } from './work-schema.ts';
import { agentIdentity, taskAgent, taskAgentJobs } from './work-agents.ts';
import {
  ASSESSMENT_VERSION, ASSESSMENT_MAX_AGE, currentSavedAssessmentSchema, savedAssessmentSchema, type Assessment, type SavedAssessment, type CurrentAssessment,
} from './work-assessment.ts';
export { ASSESSMENT_VERSION, ASSESSMENT_MAX_AGE, assessmentSchema, type Assessment, type SavedAssessment } from './work-assessment.ts';

export const ORDER_MAX_AGE = 60 * 60 * 1000;
export const MIN_REEVALUATION = 60 * 1000;
export const CACHE_LIMITS = { records: 10000, bytes: 32 * 1024 * 1024, fileBytes: 64 * 1024 * 1024 } as const;
const time = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const savedOrderSchema = z.strictObject({
  fingerprint: hash, result: workRankOutputSchema.extend({ evaluatedAt: time, expiresAt: time }),
});
type SavedOrder = z.infer<typeof savedOrderSchema>;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function assessmentScope(credential: string, input: WorkRankInput, version: string = ASSESSMENT_VERSION): string {
  return digest(['github-projects:work-assessments', credential, input.profileId ?? 'default',
    agentIdentity(taskAgent(input, 'task-assessment')), version]);
}
export function exactPermutation(expected: string[], actual: string[], code: 'copilot_output' | 'assessment_storage' | 'assessment_required' = 'copilot_output'): void {
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
  tasks: {
    id: string; title: string; assessedAt: string; assessment: SavedAssessment['assessment'];
    savedInputsChanged: boolean;
    currentState: {
      action: WorkRankInput['tasks'][number]['action'];
      availability: 'actionable' | 'unknown';
      reason: string;
      pullRequest: WorkRankInput['tasks'][number]['pullRequest'] | null;
    };
  }[];
};
export type OrderOutput = { ranking: { id: string; reason: string }[]; reevaluateAt: string };
export type RankingModels = {
  assess(input: AssessmentInput): Promise<AssessmentOutput>;
  order(input: OrderInput): Promise<OrderOutput>;
};

export class WorkRanker {
  constructor(private readonly cache: WorkAssessmentCache, private readonly now: () => Date = () => new Date()) {}

  private current(value: SavedAssessment | undefined, task: SemanticRankTask, input: WorkRankInput): value is CurrentAssessment {
    if (!value) return false;
    const agent = taskAgent(input, 'task-assessment');
    return value.fingerprint === digest(task) && value.profileId === (input.profileId ?? 'default')
      && value.instructionsFingerprint === digest(agent.instructions) && value.model === agent.model
      && value.assessmentVersion === ASSESSMENT_VERSION
      && value.agent.id === agent.id
      && value.agent.configurationFingerprint === digest(agentIdentity(agent))
      && Date.parse(value.evaluatedAt) <= this.now().getTime()
      && Date.parse(value.assessment.reevaluateAt) > this.now().getTime();
  }

  async assess(input: WorkRankInput, scope: string, models: RankingModels, signal: AbortSignal) {
    checkAbort(signal);
    const tasks = input.tasks.map(semanticRankTask).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const evaluatedAt = this.now().toISOString();
    const { assessments } = this.cache.load(scope, tasks.map(task => task.id));
    const reusable = tasks.flatMap(task => {
      const value = assessments.get(task.id);
      if (input.force || !this.current(value, task, input)) return [];
      try { validateAssessment(value.assessment, task, value.evaluatedAt); }
      catch (error) {
        if (error instanceof ServiceError && error.dto.code === 'copilot_output') throw new ServiceError('assessment_storage');
        throw error;
      }
      return [value];
    }).slice(0, LIMITS.workAssessmentTasks);
    // Deliver cached work before invoking another model; each response is saved by the caller.
    if (reusable.length) return { assessments: reusable };
    const bytes = (tasks: SemanticRankTask[]) => Buffer.byteLength(JSON.stringify({ evaluatedAt, tasks }));
    const batch: SemanticRankTask[] = [];
    for (const task of tasks) {
      if (bytes([task]) > LIMITS.workModelBytes) throw new ServiceError('limit');
      if (batch.length && (batch.length >= LIMITS.workAssessmentTasks || bytes([...batch, task]) > LIMITS.workModelBytes)) break;
      batch.push(task);
    }
    if (!batch.length) throw new ServiceError('invalid_input');
    const result = await models.assess({ evaluatedAt, tasks: batch });
    checkAbort(signal);
    exactPermutation(batch.map(task => task.id), result.assessments.map(value => value.id));
    const agent = taskAgent(input, 'task-assessment');
    const values: CurrentAssessment[] = result.assessments.map(({ id, ...assessment }) => {
      const task = batch.find(task => task.id === id)!;
      validateAssessment(assessment, task, evaluatedAt);
      if (Date.parse(assessment.reevaluateAt) <= this.now().getTime()) throw new ServiceError('copilot_output');
      return currentSavedAssessmentSchema.parse({
        resultId: randomUUID(), id, profileId: input.profileId ?? 'default', fingerprint: digest(task),
        instructionsFingerprint: digest(agent.instructions), assessmentVersion: ASSESSMENT_VERSION,
        model: agent.model, evaluatedAt, assessment,
        agent: {
          id: agent.id, name: agent.name, jobType: 'task-assessment',
          configurationFingerprint: digest(agentIdentity(agent)),
        },
      });
    });
    this.cache.saveAssessments(scope, values);
    return { assessments: values };
  }

  async rank(input: WorkRankInput, scope: string, models: RankingModels, signal: AbortSignal) {
    checkAbort(signal);
    if (!input.assessmentIds || !input.assessments) throw new ServiceError('assessment_required');
    const tasks = input.tasks.map(semanticRankTask).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const { order } = this.cache.load(scope, []);
    exactPermutation(tasks.map(task => task.id), input.assessments.map(value => value.taskId), 'assessment_required');
    const saved = new Map(input.assessments.map(value => [value.taskId, value.result]));
    const sources = new Map(input.tasks.map(task => [task.id, task]));
    const current = tasks.map(task => {
      const value = saved.get(task.id)!;
      if (value.profileId !== (input.profileId ?? 'default')) throw new ServiceError('assessment_required');
      return value;
    });
    exactPermutation(current.map(value => value.resultId), input.assessmentIds, 'assessment_required');
    const fingerprint = digest([current, tasks.map(task => orderingRankTask(sources.get(task.id)!)), agentIdentity(taskAgent(input, 'task-prioritization')),
      taskAgentJobs['task-prioritization'].resultFormat]);
    const orderAt = this.now().toISOString();
    if (!input.force && order?.fingerprint === fingerprint && Date.parse(order.result.evaluatedAt) <= Date.parse(orderAt)
      && Date.parse(order.result.expiresAt) > Date.parse(orderAt)) {
      const result = order.result;
      if (Date.parse(result.expiresAt) > Date.parse(result.evaluatedAt) + ORDER_MAX_AGE) {
        throw new ServiceError('assessment_storage');
      }
      exactPermutation(tasks.map(task => task.id), result.orderedIds, 'assessment_storage');
      exactPermutation(tasks.map(task => task.id), result.reasons.map(value => value.id), 'assessment_storage');
      return result;
    }
    const orderInput = {
      evaluatedAt: orderAt,
      tasks: tasks.map((task, index) => ({
        id: task.id, title: task.title, assessedAt: current[index]!.evaluatedAt, assessment: current[index]!.assessment,
        savedInputsChanged: current[index]!.fingerprint !== digest(task),
        currentState: {
          action: task.action, availability: task.availability, reason: task.availabilityReason,
          pullRequest: sources.get(task.id)!.pullRequest ?? null,
        },
      })),
    };
    if (Buffer.byteLength(JSON.stringify(orderInput)) > LIMITS.workModelBytes) throw new ServiceError('limit');
    const ordered = await models.order(orderInput);
    checkAbort(signal);
    exactPermutation(tasks.map(task => task.id), ordered.ranking.map(value => value.id));
    validateReevaluation(ordered.reevaluateAt, orderAt, ORDER_MAX_AGE);
    const expiresAt = Date.parse(ordered.reevaluateAt);
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
