import { z } from 'zod';
import { taskAgents, taskAgentsSchema } from './work-agents.ts';
import { codeAgents, codeAgentsSchema } from './code-agents.ts';
import { referenceSchema } from './references.ts';
import { savedAssessmentSchema } from './work-assessment.ts';

const time = z.iso.datetime();
const id = z.string().min(1).max(500);
const url = z.url().max(2000).refine(value => {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}, 'Use an HTTPS source link without credentials.');

export const workActionSchema = z.enum(['review', 'fix', 'reply', 'merge', 'implement', 'review-result', 'follow-up', 'manual']);
export const githubWorkActionSchema = z.enum(['review', 'fix', 'reply', 'merge', 'implement', 'follow-up', 'manual']);
export const workNotificationSchema = z.strictObject({
  threadId: z.string().regex(/^[1-9]\d{0,19}$/),
  reference: z.strictObject({
    repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
    number: z.number().int().positive().safe(), kind: z.enum(['pr', 'issue']),
  }),
  updatedAt: time,
});
export const workUnsubscribeSchema = z.strictObject({
  operationId: id, notification: workNotificationSchema,
  status: z.enum(['pending', 'unconfirmed', 'confirmed']),
  error: z.string().max(1000), confirmedAt: time.optional(),
});
export const workEvidenceSchema = z.strictObject({
  id, source: z.enum(['github', 'slack', 'manual', 'mcp', 'copilot']),
  streamId: id, at: time, url, summary: z.string().min(1).max(2000),
});
export const workSourceContextSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(2000), body: z.string().max(100000),
  labels: z.array(z.string().max(200)).max(100),
});
export const pullRequestStateSchema = z.strictObject({
  observedAt: time,
  head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  author: z.string().max(100).nullable().optional(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullable().optional(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable().optional(),
  draft: z.boolean().nullable(),
  checks: z.enum(['passing', 'failing', 'pending', 'none', 'unknown']),
  checksIncomplete: z.boolean(),
  readiness: z.enum(['ready', 'not-ready', 'unknown']),
});
export const workMetadataSchema = z.strictObject({
  identity: z.string().min(1).max(2014), action: workActionSchema, url,
  reference: referenceSchema.optional(),
  evidence: z.array(workEvidenceSchema).max(2000),
  handledEvidenceIds: z.array(id).max(10000),
  availability: z.enum(['actionable', 'waiting', 'unknown']),
  availabilityReason: z.string().max(1000),
  availabilityObservedAt: time.optional(),
  context: workSourceContextSchema.optional(),
  contextObservedAt: time.optional(),
  pullRequest: pullRequestStateSchema.optional(),
  notification: workNotificationSchema.optional(),
  unsubscribe: workUnsubscribeSchema.optional(),
});
export const workstreamSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  kind: z.enum(['github', 'github-notifications', 'slack', 'mcp']),
  query: z.string().trim().min(1).max(4000),
  action: workActionSchema,
  server: z.string().max(200),
  tools: z.array(z.string().min(1).max(200)).max(20),
}).refine(stream => !isGitHubStream(stream) || githubWorkActionSchema.safeParse(stream.action).success, {
  path: ['action'],
  message: 'Choose a supported GitHub action. Review-result is supported only by Slack/MCP sources and push intake.',
});
const savedWorkSettingsSchema = z.strictObject({
  instructions: z.string().max(16000),
  model: z.string().max(100),
  agents: taskAgentsSchema.optional(),
  codeAgents: codeAgentsSchema.optional(),
  streams: z.array(workstreamSchema).max(30),
  schedule: z.strictObject({ enabled: z.boolean(), everyMinutes: z.number().int().min(5).max(1440) }),
});
export const workSettingsSchema = savedWorkSettingsSchema.transform((settings): z.infer<typeof savedWorkSettingsSchema> =>
  ({ ...settings, agents: taskAgents(settings), codeAgents: codeAgents(settings) }));
export const workRankingSchema = z.strictObject({
  orderedIds: z.array(id).max(2000),
  reasons: z.array(z.strictObject({ id, reason: z.string().trim().min(1).max(1000) })).max(2000),
  rankedAt: time,
  expiresAt: time.optional(),
});
export const workStateSchema = z.strictObject({
  settings: workSettingsSchema,
  sourceFilter: z.strictObject({
    selectedSources: z.array(z.string().min(1).max(4000)).nullable(),
    collapsedProviders: z.array(z.enum(['github', 'slack', 'mcp'])),
  }).optional(),
  ranking: workRankingSchema.nullable(),
  lastStartedAt: time.nullable(),
  lastCompletedAt: time.nullable(),
  collectionCursor: time.nullable().default(null),
  lastError: z.string().max(4000),
});
export const workCandidateSchema = z.strictObject({
  title: z.string().trim().min(1).max(1000),
  action: workActionSchema, url,
  evidence: z.array(workEvidenceSchema).min(1).max(200),
  notification: workNotificationSchema.optional(),
});
export const workObservationSchema = z.strictObject({
  url, state: z.enum(['open', 'queued', 'closed', 'merged', 'unknown']),
  reference: referenceSchema.optional(),
  observedAt: time, reason: z.string().max(1000),
  context: workSourceContextSchema.optional(),
  pullRequest: pullRequestStateSchema.optional(),
});
export const workCollectInputSchema = z.strictObject({
  stream: workstreamSchema, model: z.string().max(100),
  since: time.nullable(),
  knownUrls: z.array(url).max(100).default([]),
  observeOnly: z.boolean().default(false),
  stateOnly: z.boolean().optional(),
}).refine(input => !input.stateOnly || input.observeOnly, 'State-only requests must observe saved sources without collecting.');
export const workCollectOutputSchema = z.strictObject({
  candidates: z.array(workCandidateSchema).max(200),
  observations: z.array(workObservationSchema).max(300),
  warnings: z.array(z.string().max(1000)).max(30),
  coverageInfo: z.array(z.string().max(1000)).max(30).optional(),
  coveredThrough: time.optional(),
  collectedAt: time,
});
export const workRankInputSchema = z.strictObject({
  profileId: z.string().min(1).max(100).optional(),
  assessmentIds: z.array(z.uuid()).max(2000).optional(),
  assessments: z.array(z.strictObject({ taskId: id, result: savedAssessmentSchema })).max(2000).optional(),
  instructions: z.string().max(16000), model: z.string().max(100),
  agents: taskAgentsSchema.optional(),
  force: z.boolean().optional(),
  tasks: z.array(z.strictObject({
    id, title: z.string().max(2000), notes: z.string().max(16000),
    action: workActionSchema, url: url.nullable(),
    evidence: z.array(workEvidenceSchema).max(2000),
    createdAt: time,
    availability: z.enum(['actionable', 'unknown']).optional(),
    availabilityReason: z.string().max(1000).optional(),
    context: workSourceContextSchema.optional(),
    pullRequest: pullRequestStateSchema.optional(),
    assessmentInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })).max(2000),
});
export const workRankOutputSchema = workRankingSchema.omit({ rankedAt: true }).extend({
  evaluatedAt: time.optional(),
});
export const workConnectionsSchema = z.strictObject({
  servers: z.array(z.strictObject({
    name: z.string(), tools: z.array(z.string()), source: z.string(),
  })),
  instructions: z.string(),
});
export const workIntakeItemSchema = z.strictObject({ id, candidate: workCandidateSchema });
export const workIntakeOutputSchema = z.strictObject({
  items: z.array(workIntakeItemSchema).max(200), hasMore: z.boolean(),
});
export const workIntakeAckSchema = z.strictObject({ ids: z.array(id).max(200) });

export type WorkAction = z.infer<typeof workActionSchema>;
export type WorkEvidence = z.infer<typeof workEvidenceSchema>;
export type WorkSourceContext = z.infer<typeof workSourceContextSchema>;
export type WorkMetadata = z.infer<typeof workMetadataSchema>;
export type Workstream = z.infer<typeof workstreamSchema>;
export type WorkSettings = z.infer<typeof workSettingsSchema>;
export type WorkState = z.infer<typeof workStateSchema>;
export type WorkCandidate = z.infer<typeof workCandidateSchema>;
export type WorkObservation = z.infer<typeof workObservationSchema>;
export type WorkCollection = z.infer<typeof workCollectOutputSchema>;
export type WorkRankInput = z.infer<typeof workRankInputSchema>;

export function isGitHubStream(stream: { kind: string }): boolean {
  return stream.kind === 'github' || stream.kind === 'github-notifications';
}

export function notificationWorkstream(): Workstream {
  return {
    id: crypto.randomUUID(), name: 'GitHub notifications', enabled: true,
    kind: 'github-notifications', query: 'Inspect updated notifications for actionable requests addressed to me.',
    action: 'follow-up', server: '', tools: [],
  };
}

export function defaultWorkState(): WorkState {
  return {
    settings: {
      instructions: '', model: '',
      agents: taskAgents({ instructions: '', model: '' }), codeAgents: codeAgents({}),
      streams: [{
        id: 'github-reviews', name: 'PRs awaiting my review', enabled: true,
        kind: 'github', query: 'is:pr is:open archived:false user-review-requested:@me',
        action: 'review', server: '', tools: [],
      }, {
        id: 'github-assigned', name: 'Issues assigned to me', enabled: true,
        kind: 'github', query: 'is:issue is:open archived:false assignee:@me',
        action: 'implement', server: '', tools: [],
      }],
      schedule: { enabled: false, everyMinutes: 30 },
    },
    ranking: null, lastStartedAt: null, lastCompletedAt: null, collectionCursor: null, lastError: '',
  };
}
