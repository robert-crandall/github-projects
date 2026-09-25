import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CopilotService } from './copilot.ts';
import { checkAbort, ServiceError } from './errors.ts';
import { WorkGitHub } from './work-github.ts';
import { WorkIntake } from './work-intake.ts';
import { canonicalGithubUrl, McpConnections, normalizeWorkUrl, sourceTime } from './work-mcp.ts';
import { isGitHubStream, workCollectInputSchema, workCollectOutputSchema, workObserveInputSchema, type WorkCandidate } from './work-schema.ts';

export class WorkService {
  private readonly github: Pick<WorkGitHub, 'collect' | 'observe'>;
  private readonly copilot: CopilotService;
  private readonly connections: McpConnections;
  private readonly intake: WorkIntake;
  private readonly now: () => Date;
  constructor(options: {
    github?: Pick<WorkGitHub, 'collect' | 'observe'>; copilot?: CopilotService; connections?: McpConnections;
    intake?: WorkIntake; now?: () => Date;
  } = {}) {
    this.copilot = options.copilot ?? new CopilotService();
    this.github = options.github ?? new WorkGitHub({ copilot: this.copilot });
    this.connections = options.connections ?? new McpConnections();
    this.intake = options.intake ?? new WorkIntake();
    this.now = options.now ?? (() => new Date());
  }
  async collect(raw: z.input<typeof workCollectInputSchema>, signal: AbortSignal) {
    const parsed = workCollectInputSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError('invalid_input');
    const input = parsed.data;
    checkAbort(signal);
    if (input.observeOnly) {
      const collectedAt = this.now().toISOString();
      const observations = await this.github.observe(input.knownUrls, signal);
      return workCollectOutputSchema.parse({
        candidates: [], observations, collectedAt,
        warnings: observations.some(observation => observation.state === 'unknown')
          ? ['Some tracked GitHub sources could not be observed. Inspect their source-state errors.'] : [],
      });
    }
    if (isGitHubStream(input.stream)) return this.github.collect(input, signal);
    const collectedAt = this.now().toISOString();
    const server = await this.connections.selected(input.stream);
    checkAbort(signal);
    const result = await this.copilot.collectMcp(input.stream, input.model, server, input.since, signal);
    const candidates = new Map<string, WorkCandidate>();
    for (const request of result.requests) {
      const source = new URL(request.sourceUrl);
      const sourceKind = source.hostname.endsWith('.slack.com') ? 'slack' : 'mcp';
      const at = sourceTime(request.sourceTimestamp);
      if (Date.parse(at) > this.now().getTime() + 300_000) throw new ServiceError('copilot_output');
      const candidate: WorkCandidate = {
        title: request.title, action: request.action,
        url: normalizeWorkUrl(request.targetUrl ?? request.sourceUrl),
        evidence: [{
          id: `${sourceKind}:${createHash('sha256').update(JSON.stringify([
            normalizeWorkUrl(request.sourceUrl), request.eventId,
          ])).digest('hex')}`,
          source: sourceKind, streamId: input.stream.id,
          at, url: request.sourceUrl, summary: request.summary,
        }],
      };
      const key = `${candidate.url}:${candidate.action}`;
      const existing = candidates.get(key);
      if (existing) existing.evidence.push(...candidate.evidence);
      else candidates.set(key, candidate);
    }
    const observations = await this.github.observe([...new Set([
      ...[...candidates.values()].map(candidate => candidate.url), ...input.knownUrls,
    ])].filter(url => canonicalGithubUrl(url)), signal);
    return workCollectOutputSchema.parse({
      candidates: [...candidates.values()].map(candidate => ({
        ...candidate, evidence: [...new Map(candidate.evidence.map(item => [item.id, item])).values()],
      })),
      observations, warnings: [
        ...result.warnings,
        ...(result.requests.length === 200 ? ['MCP extraction reached its 200-request limit; missing requests are not completion.'] : []),
        ...(observations.some(observation => observation.state === 'unknown')
          ? ['Some linked GitHub sources could not be observed. Those tasks remain unknown; inspect their source-state errors.'] : []),
      ],
      collectedAt,
    });
  }
  rank: CopilotService['rankWork'] = (input, signal) => this.copilot.rankWork(input, signal);
  async observe(raw: z.input<typeof workObserveInputSchema>, signal: AbortSignal) {
    const parsed = workObserveInputSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError('invalid_input');
    const input = parsed.data;
    if (input.urls.some(value => !canonicalGithubUrl(value))) throw new ServiceError('invalid_input');
    const collectedAt = this.now().toISOString();
    const observations = await this.github.observe(input.urls, signal);
    return workCollectOutputSchema.parse({
      candidates: [], observations, collectedAt,
      warnings: observations.filter(value => value.state === 'unknown')
        .map(value => `${value.url}: current source state is unknown. ${value.reason}`).slice(0, 30),
    });
  }
  assess: CopilotService['assessWork'] = (input, signal) => this.copilot.assessWork(input, signal);
  listConnections() { return this.connections.list(); }
  pendingIntake() { return this.intake.pending(); }
  ackIntake(input: unknown) { return this.intake.ack(input); }
}
