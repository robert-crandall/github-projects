import { z } from 'zod';
import { taskAgents, taskAgentsSchema } from './work-agents.ts';
import { codeAgents, codeAgentsSchema } from './code-agents.ts';
import { referenceSchema, idSchema } from './references.ts';
import { savedAssessmentSchema } from './work-assessment.ts';
import { workStylesSchema, workStyleIdsSchema } from './work-styles.ts';

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
export const workEmailMetadataSchema = z.strictObject({
  messageId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(200).optional(),
  from: z.string().trim().min(1).max(500),
  senderEmail: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(1000).optional(),
  listId: z.string().trim().max(500).optional(),
  unsubscribeUrl: url.optional(),
  snippet: z.string().max(4000).optional(),
});
export const workEvidenceSchema = z.strictObject({
  id, source: z.enum(['github', 'slack', 'gmail', 'manual', 'mcp', 'copilot']),
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
  acknowledge: workUnsubscribeSchema.optional(),
  unsubscribe: workUnsubscribeSchema.optional(),
  email: workEmailMetadataSchema.optional(),
});
export const defaultActionPrompts = {
  review: 'Review {{url}}. Check the diff, tests, and edge cases, then summarize your findings.',
  implement: 'Work on {{url}}. Investigate the issue, implement the fix in a new worktree, run tests, and prepare a PR.',
  fix: 'Investigate and fix {{url}}. Reproduce or trace the failure, implement a minimal fix, and verify with tests.',
  'follow-up': 'Investigate {{url}} and help me take the next action.',
} as const;
export const copilotProjectsPromptsSchema = z.strictObject({
  review: z.string().trim().min(1).max(4000).default(defaultActionPrompts.review),
  implement: z.string().trim().min(1).max(4000).default(defaultActionPrompts.implement),
  fix: z.string().trim().min(1).max(4000).default(defaultActionPrompts.fix),
  'follow-up': z.string().trim().min(1).max(4000).default(defaultActionPrompts['follow-up']),
});
export const copilotProjectsSettingsSchema = z.strictObject({
  defaultProject: z.string().trim().max(200).default(''),
  autoCompleteOnDispatch: z.boolean().default(true),
  prompts: copilotProjectsPromptsSchema.default(() => ({ ...defaultActionPrompts })),
});
export type CopilotProjectsSettings = z.infer<typeof copilotProjectsSettingsSchema>;
export function copilotProjectsSettings(settings?: { copilotProjects?: CopilotProjectsSettings }): CopilotProjectsSettings {
  const current = settings?.copilotProjects;
  if (!current) return { defaultProject: '', autoCompleteOnDispatch: true, prompts: { ...defaultActionPrompts } };
  return {
    defaultProject: current.defaultProject ?? '',
    autoCompleteOnDispatch: current.autoCompleteOnDispatch ?? true,
    prompts: { ...defaultActionPrompts, ...current.prompts },
  };
}
export const workstreamSchema = z.strictObject({
  id, name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  kind: z.enum(['github', 'github-notifications', 'gmail', 'slack', 'mcp']),
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
  workStyles: workStylesSchema.optional(),
  copilotProjects: copilotProjectsSettingsSchema.optional(),
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
    collapsedProviders: z.array(z.enum(['github', 'gmail', 'slack', 'mcp'])),
  }).optional(),
  styleFilter: workStyleIdsSchema.nullable().optional(),
  ranking: workRankingSchema.nullable(),
  lastStartedAt: time.nullable(),
  lastCompletedAt: time.nullable(),
  collectionCursor: time.nullable().default(null),
  directCollectionCursor: time.nullable().optional(),
  lastError: z.string().max(4000),
});
export const workCandidateSchema = z.strictObject({
  title: z.string().trim().min(1).max(1000),
  action: workActionSchema, url,
  evidence: z.array(workEvidenceSchema).min(1).max(200),
  notification: workNotificationSchema.optional(),
  email: workEmailMetadataSchema.optional(),
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
  skipModelExtraction: z.boolean().optional(),
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
  workStyles: workStylesSchema.optional(),
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

export type WorkEmailMetadata = z.infer<typeof workEmailMetadataSchema>;
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

export function isDirectStream(stream: { kind: string }): boolean {
  return isGitHubStream(stream) || stream.kind === 'gmail';
}

export function notificationWorkstream(): Workstream {
  return {
    id: crypto.randomUUID(), name: 'GitHub notifications', enabled: true,
    kind: 'github-notifications', query: 'Inspect updated notifications for actionable requests addressed to me.',
    action: 'follow-up', server: '', tools: [],
  };
}

export function gmailWorkstream(): Workstream {
  return {
    id: crypto.randomUUID(), name: 'Personal Gmail inbox', enabled: true,
    kind: 'gmail', query: 'in:inbox is:unread -category:promotions -category:social',
    action: 'follow-up', server: '', tools: [],
  };
}

export function budgetWorkstream(): Workstream {
  return {
    id: crypto.randomUUID(), name: 'Budget unexpected charges', enabled: false,
    kind: 'mcp', query: 'Flag unexpected, duplicate, or uncategorized charges over $50 from the last 7 days that need review.',
    action: 'follow-up', server: 'budget', tools: [],
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

export const copilotProjectItemSchema = z.strictObject({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  state: z.string().min(1).max(50),
  sessions: z.number().int().nonnegative(),
  active: z.boolean(),
});

export const copilotProjectsListOutputSchema = z.strictObject({
  available: z.boolean(),
  projects: z.array(copilotProjectItemSchema).max(200),
});

export const MAX_COPILOT_PROJECTS_PROMPT_BYTES = 8_192;

export const copilotProjectsDispatchInputSchema = z.strictObject({
  operationId: idSchema,
  projectId: z.string().trim().max(200).optional(),
  projectName: z.string().trim().max(200).optional(),
  repo: z.string().trim().max(200).optional(),
  action: workActionSchema.optional(),
  title: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(MAX_COPILOT_PROJECTS_PROMPT_BYTES)
    .refine(val => new TextEncoder().encode(val).length <= MAX_COPILOT_PROJECTS_PROMPT_BYTES,
      `Prompt must be at most ${MAX_COPILOT_PROJECTS_PROMPT_BYTES} UTF-8 bytes.`),
  host: z.string().trim().max(200).optional(),
});

export const copilotProjectsDispatchResultSchema = z.strictObject({
  operationId: idSchema,
  requestId: z.uuid(),
  projectId: z.string().min(1).max(200),
  projectName: z.string().min(1).max(200),
  status: z.literal('confirmed'),
  confirmedAt: time,
});

export const gmailArchiveInputSchema = z.strictObject({
  operationId: idSchema,
  messageId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(200).optional(),
  archive: z.boolean().optional(),
  markRead: z.boolean().default(true),
}).refine(value => (value.archive ?? true) || value.markRead, {
  message: 'At least one of archive or markRead must be enabled.',
});

export const gmailArchiveResultSchema = z.strictObject({
  operationId: idSchema,
  messageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  status: z.literal('confirmed'),
  confirmedAt: time,
});

export const gmailctlFilterInputSchema = z.strictObject({
  operationId: idSchema,
  from: z.string().trim().max(320).optional(),
  list: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(300).optional(),
  archive: z.boolean().default(true),
  markRead: z.boolean().default(true),
  deleteIt: z.boolean().default(false),
  apply: z.boolean().default(false),
});

export const gmailctlFilterResultSchema = z.strictObject({
  operationId: idSchema,
  configPath: z.string().min(1).max(500),
  ruleSnippet: z.string().min(1).max(2_000),
  applied: z.boolean(),
  status: z.literal('confirmed'),
  confirmedAt: time,
});

export type CopilotProjectItem = z.infer<typeof copilotProjectItemSchema>;
export type CopilotProjectsListOutput = z.infer<typeof copilotProjectsListOutputSchema>;
export type CopilotProjectsDispatchInput = z.infer<typeof copilotProjectsDispatchInputSchema>;
export type CopilotProjectsDispatchResult = z.infer<typeof copilotProjectsDispatchResultSchema>;
export type GmailArchiveInput = z.infer<typeof gmailArchiveInputSchema>;
export type GmailArchiveResult = z.infer<typeof gmailArchiveResultSchema>;
export type GmailctlFilterInput = z.infer<typeof gmailctlFilterInputSchema>;
export type GmailctlFilterResult = z.infer<typeof gmailctlFilterResultSchema>;

export function selectCopilotProject(
  projects: CopilotProjectItem[],
  options: {
    projectId?: string;
    projectName?: string;
    repo?: string;
    action?: string;
    allowFallback?: boolean;
  },
): { id: string; name: string } | undefined {
  const wantedId = options.projectId?.trim();
  if (wantedId) {
    const byId = projects.find(project => project.id.toLowerCase() === wantedId.toLowerCase());
    if (byId) return { id: byId.id, name: byId.name };
    const byName = projects.find(project => project.name.toLowerCase() === wantedId.toLowerCase());
    if (byName) return { id: byName.id, name: byName.name };
    if (options.allowFallback !== false) return { id: wantedId, name: options.projectName?.trim() || wantedId };
    return undefined;
  }
  const wantedName = options.projectName?.trim();
  if (wantedName) {
    const byId = projects.find(project => project.id.toLowerCase() === wantedName.toLowerCase());
    if (byId) return { id: byId.id, name: byId.name };
    const exact = projects.find(project => project.name.toLowerCase() === wantedName.toLowerCase());
    if (exact) return { id: exact.id, name: exact.name };
    return undefined;
  }
  if (options.action === 'review') {
    const reviewProject = projects.find(project =>
      project.name.toLowerCase() === 'pr reviews' || /\breview\s*prs?\b|\bprs?\s*reviews?\b/i.test(project.name),
    );
    if (reviewProject) return { id: reviewProject.id, name: reviewProject.name };
  }
  const repoShort = options.repo?.split('/').at(-1)?.trim().toLowerCase();
  if (repoShort) {
    const byRepo = projects.find(project => project.name.toLowerCase() === repoShort);
    if (byRepo) return { id: byRepo.id, name: byRepo.name };
  }
  const active = projects.find(project => project.active) ?? projects[0];
  return active ? { id: active.id, name: active.name } : undefined;
}

export function hasMatchingAcknowledge(
  notification?: WorkMetadata['notification'],
  acknowledge?: WorkMetadata['acknowledge'],
): boolean {
  return Boolean(
    notification &&
    acknowledge &&
    acknowledge.notification.threadId === notification.threadId &&
    acknowledge.notification.updatedAt === notification.updatedAt,
  );
}



