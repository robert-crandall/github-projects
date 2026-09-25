import { z } from 'zod';
import { workAssessOutputSchema } from './work-assessment.ts';
import { idSchema, repoSchema, referenceSchema } from './references.ts';
import { codeReviewInputSchema, codeReviewResultSchema } from './code-review-schema.ts';
export { idSchema, repoSchema, referenceSchema } from './references.ts';
import {
  workCollectInputSchema, workCollectOutputSchema, workConnectionsSchema,
  workIntakeAckSchema, workIntakeOutputSchema, workRankInputSchema, workRankOutputSchema,
} from './work-schema.ts';

export const LIMITS = {
  frameBytes: 1_048_576, responseBytes: 1_048_576, concurrent: 4, deadlineMs: 120_000,
  processBytes: 4_194_304, processMs: 20_000, notificationPages: 2, threads: 50,
  refreshMs: 90_000, enrichmentConcurrency: 3,
  eventPages: 2, events: 200, evidenceText: 2_000, modelBytes: 60_000, modelMs: 90_000,
  workModelBytes: 240_000, workAssessmentTasks: 20, workModelMs: 180_000, workDeadlineMs: 300_000,
} as const;

export const threadIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const loginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/);
const owner = '[A-Za-z0-9][A-Za-z0-9-]{0,99}';
export const teamSchema = z.string().regex(new RegExp(`^${owner}/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`));
const time = z.iso.datetime();
const text = z.string().max(LIMITS.evidenceText);
export const errorCodeSchema = z.enum([
  'invalid_input', 'invalid_output', 'missing_cli', 'authentication', 'missing_scope',
  'access', 'rate_limit', 'unavailable', 'deadline', 'cancelled', 'busy', 'protocol',
  'limit', 'unsupported', 'copilot_unavailable', 'copilot_output', 'internal', 'source_changed',
  'mcp_configuration', 'mcp_unavailable',
  'assessment_storage', 'assessment_capacity', 'assessment_required',
]);
export const errorSchema = z.strictObject({
  code: errorCodeSchema, message: z.string().max(300), retryable: z.boolean(),
});
export const diagnosticSchema = z.strictObject({
  scope: z.enum(['notifications', 'teams', 'thread', 'timeline', 'subscription', 'source-state']),
  code: errorCodeSchema, threadId: threadIdSchema.optional(),
  message: z.string().max(300),
});
export const sourceStateSchema = z.strictObject({
  state: z.enum(['open', 'closed', 'merged', 'queued', 'unknown']),
  observedAt: time, updatedAt: time.nullable(),
  error: errorSchema.nullable(),
}).refine(value => (value.state === 'unknown') === (value.error !== null),
  'Unknown source state requires an explicit error; confirmed state cannot include an error.');
export const evidenceSchema = z.strictObject({
  id: idSchema, kind: z.enum([
    'review-request', 'review-request-removed', 'review', 'comment', 'mention',
    'merge-queue', 'commit', 'closed', 'reopened', 'other',
  ]),
  at: time, actor: loginSchema.nullable(), text,
  recipient: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user'), login: loginSchema, isViewer: z.boolean() }),
    z.strictObject({ kind: z.literal('team'), team: teamSchema, viewerMembership: z.enum(['member', 'not-member', 'unknown']) }),
    z.strictObject({ kind: z.literal('none') }),
  ]),
  requestState: z.enum(['current', 'historical', 'uncertain', 'not-request']),
  textTruncated: z.boolean(),
});
export const threadSchema = z.strictObject({
  id: threadIdSchema, reference: referenceSchema, title: z.string().max(500),
  reason: z.string().max(100), notification: z.enum(['read', 'unread']),
  updatedAt: time, lastReadAt: time.nullable(),
  state: z.enum(['open', 'closed', 'merged']),
  sourceState: sourceStateSchema,
  size: z.strictObject({
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
  }).nullable(),
  subscription: z.enum(['subscribed', 'unsubscribed', 'unknown']),
  evidence: z.array(evidenceSchema).max(LIMITS.events),
  coverage: z.strictObject({
    timeline: z.enum(['complete', 'partial', 'unavailable']),
    newestPage: z.number().int().nonnegative(),
    fetchedPages: z.array(z.number().int().positive()).max(LIMITS.eventPages),
    observedAt: time,
  }),
});
export const refreshSchema = z.strictObject({
  batchId: idSchema, fetchedAt: time, viewer: loginSchema,
  status: z.enum(['complete', 'partial']),
  threads: z.array(threadSchema).max(LIMITS.threads),
  diagnostics: z.array(diagnosticSchema).max(250),
  coverage: z.strictObject({
    notifications: z.enum(['complete', 'partial']), pages: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(), returned: z.number().int().nonnegative(),
    // Neither a complete notification listing nor a missing result resolves a local action.
    missingMeansDone: z.literal(false),
  }),
});
export const writeInputSchema = z.strictObject({
  operationId: idSchema, threadId: threadIdSchema, reference: referenceSchema,
  displayedEvidenceIds: z.array(idSchema).max(LIMITS.events),
  notificationUpdatedAt: time.optional(),
});
export const writeResultSchema = writeInputSchema.extend({
  action: z.enum(['acknowledge', 'unsubscribe']), confirmedAt: time,
  status: z.literal('confirmed'),
});
export const conversationStreamSchema = z.enum(['description', 'comments', 'reviews', 'inline']);
export const conversationInputSchema = z.strictObject({
  reference: referenceSchema, stream: conversationStreamSchema,
  page: z.number().int().min(1).max(999_999).nullable(),
});
export const conversationMessageSchema = z.strictObject({
  id: idSchema, kind: conversationStreamSchema,
  body: z.string().max(1_048_576), author: loginSchema.nullable(),
  createdAt: time, updatedAt: time,
  url: z.string().url().max(2_000),
  replyTo: idSchema.nullable(),
  reviewId: idSchema.nullable(),
  path: z.string().max(4_096).nullable(),
  line: z.number().int().positive().nullable(),
});
export const conversationPageSchema = z.strictObject({
  reference: referenceSchema, stream: conversationStreamSchema,
  page: z.number().int().min(1).max(999_999),
  newestPage: z.number().int().min(1).max(999_999),
  olderPage: z.number().int().min(1).max(999_999).nullable(),
  fetchedAt: time, messages: z.array(conversationMessageSchema).max(5),
  error: errorSchema.nullable(),
});
export const conversationCacheSchema = z.strictObject({
  reference: referenceSchema,
  messages: z.array(conversationMessageSchema).max(5_000),
  pages: z.array(conversationPageSchema.omit({ messages: true })).max(2_000),
});
export type ConversationInput = z.infer<typeof conversationInputSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationPage = z.infer<typeof conversationPageSchema>;
export type ConversationCache = z.infer<typeof conversationCacheSchema>;
export function conversationKey(reference: Reference): string {
  return `${reference.repo.toLowerCase()}:${reference.kind}:${reference.number}`;
}
export const connectionSchema = z.strictObject({
  github: z.strictObject({
    available: z.boolean(), viewer: loginSchema.optional(),
    scopes: z.array(z.string().max(100)).max(100), error: errorSchema.optional(),
  }),
  copilot: z.strictObject({ available: z.boolean(), error: errorSchema.optional() }),
});
export const triageItemSchema = z.strictObject({
  itemId: idSchema, title: z.string().max(500), reference: referenceSchema,
  evidence: z.array(evidenceSchema).min(1).max(20),
  handledEvidenceIds: z.array(idSchema).max(200),
  coverage: z.enum(['complete', 'partial', 'unavailable']),
  size: threadSchema.shape.size,
});
export const triageInputSchema = z.strictObject({
  items: z.array(triageItemSchema).min(1).max(10),
});
export const captureInputSchema = z.strictObject({
  captureId: idSchema, text: z.string().min(1).max(8_000),
  timeZone: z.string().max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Expected an IANA timezone'),
});
export const orderItemSchema = z.strictObject({
  itemId: idSchema, title: z.string().max(500),
  category: z.enum(['due', 'direct-review', 'team-review', 'explicit-request', 'capture', 'informational']),
  changedLines: z.number().int().nonnegative().nullable(),
  evidenceIds: z.array(idSchema).max(20),
});
export const reconsiderInputSchema = z.strictObject({
  items: z.array(orderItemSchema).min(1).max(30),
});
export const triageOutputSchema = z.strictObject({
  previewOnly: z.literal(true),
  suggestions: z.array(z.strictObject({
    itemId: idSchema, evidenceIds: z.array(idSchema).min(1).max(20),
    summary: z.string().min(1).max(800),
    uncertainty: z.string().max(500),
    nextAction: z.enum(['inspect', 'review', 'consider-reply', 'none']),
  })).max(10),
  suggestedOrder: z.array(idSchema).max(10),
});
export const captureOutputSchema = z.strictObject({
  previewOnly: z.literal(true), captureId: idSchema,
  proposal: z.strictObject({
    kind: z.enum(['action', 'routine', 'unsupported']),
    title: z.string().min(1).max(500), steps: z.array(z.string().min(1).max(500)).max(10),
    dailyAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
    timeZone: z.string().max(100), uncertainty: z.string().max(500),
  }),
});
export const reconsiderOutputSchema = z.strictObject({
  previewOnly: z.literal(true), suggestedOrder: z.array(idSchema).max(30),
  reasons: z.array(z.strictObject({ itemId: idSchema, reason: z.string().max(500) })).max(30),
});
const empty = z.strictObject({});
const envelope = { v: z.literal(1), id: idSchema.max(180) };
export const requestSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...envelope, op: z.literal('connection.check'), input: empty }),
  z.strictObject({ ...envelope, op: z.literal('github.refresh'), input: empty }),
  z.strictObject({ ...envelope, op: z.literal('github.conversation'), input: conversationInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('github.acknowledge'), input: writeInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('github.unsubscribe'), input: writeInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('copilot.triage'), input: triageInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('copilot.interpretCapture'), input: captureInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('copilot.reconsider'), input: reconsiderInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('work.collect'), input: workCollectInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('work.assess'), input: workRankInputSchema.omit({ assessmentIds: true, assessments: true }).required({ profileId: true }) }),
  z.strictObject({ ...envelope, op: z.literal('work.rank'), input: workRankInputSchema.required({ profileId: true, assessmentIds: true, assessments: true }) }),
  z.strictObject({ ...envelope, op: z.literal('work.reviewCode'), input: codeReviewInputSchema }),
  z.strictObject({ ...envelope, op: z.literal('work.connections'), input: empty }),
  z.strictObject({ ...envelope, op: z.literal('work.intake'), input: empty }),
  z.strictObject({ ...envelope, op: z.literal('work.ackIntake'), input: workIntakeAckSchema }),
  z.strictObject({ ...envelope, op: z.literal('cancel'), input: z.strictObject({ requestId: idSchema }) }),
]);
export const resultSchemas = {
  'connection.check': connectionSchema,
  'github.refresh': refreshSchema,
  'github.conversation': conversationPageSchema,
  'github.acknowledge': writeResultSchema,
  'github.unsubscribe': writeResultSchema,
  'copilot.triage': triageOutputSchema,
  'copilot.interpretCapture': captureOutputSchema,
  'copilot.reconsider': reconsiderOutputSchema,
  'work.collect': workCollectOutputSchema,
  'work.assess': workAssessOutputSchema,
  'work.rank': workRankOutputSchema,
  'work.reviewCode': codeReviewResultSchema,
  'work.connections': workConnectionsSchema,
  'work.intake': workIntakeOutputSchema,
  'work.ackIntake': workIntakeAckSchema,
  cancel: z.strictObject({ requestId: idSchema, cancelled: z.boolean() }),
} as const;
export type Request = z.infer<typeof requestSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type ServiceErrorDTO = z.infer<typeof errorSchema>;
