import { z } from 'zod';

const time = z.iso.datetime();
const stepSchema = z.object({ id: z.string(), title: z.string(), doneAt: time.optional() });
const eventSchema = z.object({
  id: z.string(), threadId: z.string(),
  kind: z.enum(['review-request', 'team-request', 'mention', 'comment', 'merge-queue', 'merged', 'read', 'acknowledged']),
  at: time, actor: z.string(), summary: z.string(),
});
const threadSchema = z.object({
  id: z.string(), repo: z.string(), number: z.number().int().positive(),
  kind: z.enum(['pr', 'issue']), title: z.string(),
  reason: z.enum(['review_requested', 'mention', 'subscribed']),
  state: z.enum(['open', 'queued', 'closed']), notification: z.enum(['unread', 'read', 'done']),
  subscribed: z.boolean(), lines: z.number().optional(), events: z.array(eventSchema),
});
const occurrenceSchema = z.object({
  dueAt: time, status: z.enum(['done', 'skipped', 'missed']), steps: z.array(stepSchema),
});
export const actionSchema = z.object({
  id: z.string(), title: z.string(), threadId: z.string().optional(), eventIds: z.array(z.string()),
  status: z.enum(['available', 'later', 'done', 'removed']), notes: z.string(), project: z.string(),
  nextStep: z.string(), captures: z.array(z.string()), steps: z.array(stepSchema),
  origin: z.enum(['fixture', 'capture']), createdAt: time, completedAt: time.optional(),
  remindAt: time.optional(), reminderDismissed: z.boolean().optional(),
  interpretation: z.enum(['none', 'pending', 'supported', 'unsupported', 'error']),
  interpretationMessage: z.string().optional(),
  routine: z.object({
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string(), nextDueAt: time, dueAt: time.optional(),
    history: z.array(occurrenceSchema), snoozedUntil: time.optional(),
  }).optional(),
});
const viewSchema = z.enum(['attention', 'later', 'history', 'routines', 'projects']);
const undoSchema = z.object({
  label: z.string(), before: z.array(actionSchema), after: z.array(actionSchema),
  activeBefore: z.string().nullable(), activeAfter: z.string().nullable(),
  handledAdded: z.array(z.string()),
});
export const stateSchema = z.object({
  version: z.literal(2), clock: time, timeZone: z.string(),
  threads: z.array(threadSchema), actions: z.array(actionSchema), staged: z.array(eventSchema),
  handled: z.array(z.string()), seen: z.array(z.string()), order: z.array(z.string()), newKeys: z.array(z.string()),
  selectedKey: z.string().nullable(), activeId: z.string().nullable(), view: viewSchema, draft: z.string(),
  refresh: z.object({
    lastSuccessAt: time.nullable(), status: z.enum(['saved', 'ok', 'partial', 'error']), message: z.string(),
  }),
  failures: z.object({
    refresh: z.enum(['none', 'partial', 'error']), storage: z.boolean(), interpretation: z.boolean(), external: z.boolean(),
  }),
  undo: z.array(undoSchema), sequence: z.number().int().nonnegative(),
});

export type AppState = z.infer<typeof stateSchema>;
export type WorkAction = z.infer<typeof actionSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Activity = z.infer<typeof eventSchema>;
export type View = z.infer<typeof viewSchema>;
export type Scenario = 'new-review' | 'comment' | 'merge-queue' | 're-request' | 'sticky-mention' | 'closed' | 'read' | 'acknowledged' | 'mention' | 'empty';
export type Row = {
  key: string; title: string; reason: string; kind: 'review' | 'update' | 'task' | 'routine';
  thread?: Thread; action?: WorkAction; events: Activity[]; fresh: boolean; available: boolean;
};
export type Command =
  | { type: 'select'; key: string | null }
  | { type: 'view'; view: View }
  | { type: 'draft'; text: string }
  | { type: 'capture' }
  | { type: 'interpret'; key: string }
  | { type: 'edit'; key: string; title?: string; notes?: string; project?: string; nextStep?: string }
  | { type: 'start' | 'done' | 'restore' | 'remove'; key: string }
  | { type: 'later'; key: string; remindAt?: string; note?: string }
  | { type: 'step'; key: string; stepId: string }
  | { type: 'undo' | 'refresh' | 'reconsider' | 'reset' }
  | { type: 'stage'; scenario: Scenario }
  | { type: 'advance'; minutes: number }
  | { type: 'reminder'; key: string; action: 'dismiss' | 'snooze' | 'skip' }
  | { type: 'notification'; threadId: string; action: 'read' | 'done' | 'unsubscribe' }
  | { type: 'configure'; refreshFailure?: AppState['failures']['refresh']; storageFailure?: boolean; interpretationFailure?: boolean; externalFailure?: boolean };
