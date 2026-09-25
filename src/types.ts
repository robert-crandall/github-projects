import { z } from 'zod';
import { sourceStateSchema } from '../service/src/schema.ts';
import { defaultWorkState, workMetadataSchema, workStateSchema } from '../service/src/work-schema.ts';

const time = z.iso.datetime();
const boundarySchema = z.object({ at: time, notificationUpdatedAt: time.optional(), evidenceAt: time.optional() });
const localId = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/);
const nameSchema = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');
const stepSchema = z.object({ id: z.string(), title: z.string(), doneAt: time.optional() });
export const eventSchema = z.object({
  id: z.string(), threadId: z.string(),
  kind: z.enum(['review-request', 'team-request', 'mention', 'comment', 'commit', 'merge-queue', 'merged', 'read', 'acknowledged', 'unknown']),
  at: time, actor: z.string(), summary: z.string(),
  rawKind: z.string().optional(),
  provenance: z.record(z.string(), z.json()).optional(),
  requestState: z.enum(['current', 'historical', 'uncertain', 'not-request']).optional(),
  recipient: z.object({
    kind: z.enum(['user', 'team']), name: z.string(), viewerIsMember: z.boolean().optional(),
  }).optional(),
});
export const threadSchema = z.object({
  id: z.string(), repo: z.string(), number: z.number().int().positive(),
  kind: z.enum(['pr', 'issue']), title: z.string(),
  reason: z.enum(['review_requested', 'mention', 'subscribed']),
  state: z.enum(['open', 'queued', 'closed']), notification: z.enum(['unread', 'read', 'done']),
  subscribed: z.boolean(), lines: z.number().optional(), events: z.array(eventSchema),
  source: z.literal('github').optional(),
  subscription: z.enum(['subscribed', 'unsubscribed', 'unknown']).optional(),
  subscriptionObservedAt: time.optional(),
  notificationUpdatedAt: time.optional(),
  archive: boundarySchema.nullable().optional(),
  sourceState: sourceStateSchema.optional(),
  terminal: z.object({
    reason: z.enum(['closed', 'merged', 'queued']), boundary: boundarySchema,
  }).nullable().optional(),
  rawReason: z.string().optional(),
  sourceMetadata: z.record(z.string(), z.json()).optional(),
  coverage: z.object({
    timeline: z.enum(['complete', 'partial', 'unavailable']), newestPage: z.boolean(),
    fetchedPages: z.number().int().nonnegative(), observedAt: time,
  }).optional(),
  diagnostics: z.array(z.string()).optional(),
});
const occurrenceSchema = z.object({
  dueAt: time, status: z.enum(['done', 'skipped', 'missed']), steps: z.array(stepSchema),
});
export const actionSchema = z.object({
  id: z.string(), title: z.string(), threadId: z.string().optional(), eventIds: z.array(z.string()),
  status: z.enum(['available', 'later', 'done', 'removed']), notes: z.string(), project: z.string(),
  nextStep: z.string(), captures: z.array(z.string()), steps: z.array(stepSchema),
  origin: z.enum(['fixture', 'capture', 'github']), createdAt: time, completedAt: time.optional(),
  remindAt: time.optional(), reminderDismissed: z.boolean().optional(),
  reminderDueAt: time.optional(),
  interpretation: z.enum(['none', 'pending', 'supported', 'unsupported', 'error']),
  interpretationMessage: z.string().optional(),
  routine: z.object({
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string(), nextDueAt: time, dueAt: time.optional(),
    history: z.array(occurrenceSchema), snoozedUntil: time.optional(),
  }).optional(),
});
export const externalOperationSchema = z.object({
  id: z.string(), threadId: z.string(), action: z.enum(['done', 'unsubscribe']),
  eventIds: z.array(z.string()), startedAt: time,
  status: z.enum(['pending', 'uncertain', 'failed', 'confirmed']),
  message: z.string(), finishedAt: time.optional(),
  notificationUpdatedAt: time.optional(),
});
const viewSchema = z.enum(['attention', 'later', 'history', 'routines', 'projects']);
const undoSchema = z.object({
  label: z.string(), before: z.array(actionSchema), after: z.array(actionSchema),
  activeBefore: z.string().nullable(), activeAfter: z.string().nullable(),
  handledAdded: z.array(z.string()),
});
export const legacyStateSchema = z.object({
  version: z.literal(2), clock: time, timeZone: z.string(),
  runtime: z.enum(['demo', 'desktop']).optional(),
  threads: z.array(threadSchema), actions: z.array(actionSchema), staged: z.array(eventSchema),
  handled: z.array(z.string()), seen: z.array(z.string()), order: z.array(z.string()), newKeys: z.array(z.string()),
  selectedKey: z.string().nullable(), activeId: z.string().nullable(), view: viewSchema, draft: z.string(),
  refresh: z.object({
    lastSuccessAt: time.nullable(), status: z.enum(['saved', 'ok', 'partial', 'error']), message: z.string(),
    diagnostics: z.array(z.string()).optional(),
    coverageMessage: z.string().optional(),
  }),
  failures: z.object({
    refresh: z.enum(['none', 'partial', 'error']), storage: z.boolean(), interpretation: z.boolean(), external: z.boolean(),
  }),
  undo: z.array(undoSchema), sequence: z.number().int().nonnegative(),
  operations: z.array(externalOperationSchema).default([]),
});

export const historySchema = actionSchema.omit({ notes: true, title: true });
export const taskSchema = z.object({
  id: z.string(), title: z.string(), notes: z.string(), status: z.enum(['open', 'done']),
  createdAt: time, completedAt: time.optional(), history: historySchema.optional(), threadId: z.string().optional(),
  work: workMetadataSchema.optional(),
  assessmentTaskIds: z.array(z.string().min(1).max(500)).optional(),
});
export const noteSchema = z.object({
  id: z.string(), threadId: z.string(), text: z.string(),
  sourceTitle: z.string().optional(), history: historySchema.optional(),
});
export const workProfileIdentitySchema = z.strictObject({ id: localId, name: nameSchema });
const taskUndoSchema = z.array(z.object({ before: taskSchema, after: taskSchema }));
export const inactiveWorkProfileSchema = workProfileIdentitySchema.extend({
  tasks: z.array(taskSchema), work: workStateSchema, undo: taskUndoSchema,
});
export function defaultWorkProfile() { return { id: 'default', name: 'Default' }; }
export const stateSchema = legacyStateSchema.omit({
  version: true, actions: true, activeId: true, view: true, undo: true, failures: true,
}).extend({
  version: z.literal(3), tasks: z.array(taskSchema), notes: z.array(noteSchema),
  view: z.preprocess(value => typeof value === 'string' && value.startsWith('inbox:') ? 'inbox' : value,
    z.enum(['inbox', 'archive', 'tasks', 'filtered'])),
  work: workStateSchema.default(defaultWorkState),
  activeWorkProfile: workProfileIdentitySchema.default(defaultWorkProfile),
  inactiveWorkProfiles: z.array(inactiveWorkProfileSchema).default([]),
  failures: z.object({ refresh: z.enum(['none', 'partial', 'error']), storage: z.boolean(), external: z.boolean() }),
  undo: taskUndoSchema,
});

export type AppState = z.infer<typeof stateSchema>;
export type LegacyState = z.infer<typeof legacyStateSchema>;
export type LegacyAction = z.infer<typeof actionSchema>;
export type Task = z.infer<typeof taskSchema>;
export type ThreadNote = z.infer<typeof noteSchema>;
export type LocalHistory = z.infer<typeof historySchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Activity = z.infer<typeof eventSchema>;
export type ExternalOperation = z.infer<typeof externalOperationSchema>;
export type View = AppState['view'];
export type Scenario = 'new-review' | 'comment' | 'merge-queue' | 're-request' | 'sticky-mention' | 'closed' | 'read' | 'acknowledged' | 'mention' | 'empty';
export type Row = {
  key: string; title: string; reason: string; kind: 'review' | 'update' | 'task';
  thread?: Thread; task?: Task; fresh: boolean; available: boolean;
  // Pending evidence for writes; the reader retains the full history in thread.events.
  events: Activity[];
};
export type Command =
  | { type: 'select'; key: string | null }
  | { type: 'view'; view: View }
  | { type: 'draft'; text: string }
  | { type: 'capture' }
  | { type: 'edit'; key: string; title?: string; notes?: string }
  | { type: 'note'; threadId: string; noteId?: string; text: string }
  | { type: 'archive' | 'restore-thread'; threadId: string }
  | { type: 'done' | 'restore'; key: string }
  | { type: 'undo' | 'refresh' | 'reset' }
  | { type: 'stage'; scenario: Scenario }
  | { type: 'advance'; minutes: number }
  | { type: 'clock'; now: string }
  | { type: 'notification'; threadId: string; action: 'read' | 'done' | 'unsubscribe'; retryId?: string }
  | { type: 'configure'; refreshFailure?: AppState['failures']['refresh']; storageFailure?: boolean; externalFailure?: boolean };
