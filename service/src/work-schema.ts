import { z } from 'zod';

const time = z.iso.datetime();
const id = z.string().min(1).max(500);
const url = z.url().max(2000).refine(value => {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}, 'Use an HTTPS source link without credentials.');

export const workActionSchema = z.enum(['review', 'fix', 'reply', 'merge', 'implement', 'review-result', 'follow-up', 'manual']);
export const githubWorkActionSchema = z.enum(['review', 'fix', 'reply', 'merge', 'implement', 'follow-up', 'manual']);
export const workEvidenceSchema = z.strictObject({
  id, source: z.enum(['github', 'slack', 'manual', 'mcp', 'copilot']),
  streamId: id, at: time, url, summary: z.string().min(1).max(2000),
});
export const workMetadataSchema = z.strictObject({
  identity: z.string().min(1).max(2014), action: workActionSchema, url,
  evidence: z.array(workEvidenceSchema).max(2000),
  handledEvidenceIds: z.array(id).max(10000),
  availability: z.enum(['actionable', 'waiting', 'unknown']),
  availabilityReason: z.string().max(1000),
  availabilityObservedAt: time.optional(),
});
export const workstreamSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  kind: z.enum(['github', 'slack', 'mcp']),
  query: z.string().trim().min(1).max(4000),
  action: workActionSchema,
  server: z.string().max(200),
  tools: z.array(z.string().min(1).max(200)).max(20),
}).refine(stream => stream.kind !== 'github' || githubWorkActionSchema.safeParse(stream.action).success, {
  path: ['action'],
  message: 'Choose a supported GitHub action. Review-result is supported only by Slack/MCP sources and push intake.',
});
export const workSettingsSchema = z.strictObject({
  instructions: z.string().max(16000),
  model: z.string().max(100),
  streams: z.array(workstreamSchema).max(30),
  schedule: z.strictObject({ enabled: z.boolean(), everyMinutes: z.number().int().min(5).max(1440) }),
});
export const workRankingSchema = z.strictObject({
  orderedIds: z.array(id).max(2000),
  reasons: z.array(z.strictObject({ id, reason: z.string().trim().min(1).max(1000) })).max(2000),
  rankedAt: time,
});
export const workStateSchema = z.strictObject({
  settings: workSettingsSchema,
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
});
export const workObservationSchema = z.strictObject({
  url, state: z.enum(['open', 'queued', 'closed', 'merged', 'unknown']),
  observedAt: time, reason: z.string().max(1000),
});
export const workCollectInputSchema = z.strictObject({
  stream: workstreamSchema, model: z.string().max(100),
  since: time.nullable(),
  knownUrls: z.array(url).max(100).default([]),
});
export const workCollectOutputSchema = z.strictObject({
  candidates: z.array(workCandidateSchema).max(200),
  observations: z.array(workObservationSchema).max(300),
  warnings: z.array(z.string().max(1000)).max(30),
  collectedAt: time,
});
export const workRankInputSchema = z.strictObject({
  instructions: z.string().max(16000), model: z.string().max(100),
  tasks: z.array(z.strictObject({
    id, title: z.string().max(2000), notes: z.string().max(16000),
    action: workActionSchema, url: url.nullable(),
    evidence: z.array(workEvidenceSchema).max(2000),
    createdAt: time,
  })).max(2000),
});
export const workRankOutputSchema = workRankingSchema.omit({ rankedAt: true });
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
export type WorkMetadata = z.infer<typeof workMetadataSchema>;
export type Workstream = z.infer<typeof workstreamSchema>;
export type WorkSettings = z.infer<typeof workSettingsSchema>;
export type WorkState = z.infer<typeof workStateSchema>;
export type WorkCandidate = z.infer<typeof workCandidateSchema>;
export type WorkObservation = z.infer<typeof workObservationSchema>;
export type WorkCollection = z.infer<typeof workCollectOutputSchema>;
export type WorkRankInput = z.infer<typeof workRankInputSchema>;

export function defaultWorkState(): WorkState {
  return {
    settings: {
      instructions: '', model: '',
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
