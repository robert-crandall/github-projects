import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { checkAbort, ServiceError } from './errors.ts';
import { executable, run, type Runner } from './process.ts';
import {
  copilotProjectItemSchema,
  copilotProjectsDispatchInputSchema,
  copilotProjectsDispatchResultSchema,
  copilotProjectsListOutputSchema,
  selectCopilotProject,
  type CopilotProjectItem,
  type CopilotProjectsDispatchInput,
  type CopilotProjectsDispatchResult,
  type CopilotProjectsListOutput,
} from './work-schema.ts';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError('invalid_input');
  return result.data;
}

export {
  copilotProjectItemSchema,
  copilotProjectsDispatchInputSchema,
  copilotProjectsDispatchResultSchema,
  copilotProjectsListOutputSchema,
  selectCopilotProject,
  type CopilotProjectItem,
  type CopilotProjectsDispatchInput,
  type CopilotProjectsDispatchResult,
  type CopilotProjectsListOutput,
};

const PROJECT_LINE = /^\s*(\*?)\s*\[([a-zA-Z0-9_-]+)\s*\]\s+(.+?)\s+\((\d+)\s+sessions?\)\s+([0-9A-Fa-f-]{36})\s*$/;

export function deterministicRequestId(operationId: string): string {
  if (z.uuid().safeParse(operationId).success) return operationId.toLowerCase();
  const hex = createHash('sha256').update(`copilot-projects:${operationId}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function parseCopilotProjectsList(stdout: string): CopilotProjectItem[] {
  const projects: CopilotProjectItem[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = PROJECT_LINE.exec(line);
    if (!match) continue;
    projects.push({
      active: match[1] === '*',
      state: match[2]!,
      name: match[3]!.trim(),
      sessions: Number(match[4]!),
      id: match[5]!,
    });
  }
  return projects;
}

export class CopilotProjectsService {
  private readonly runner: Runner;
  private readonly resolve: () => Promise<string>;
  private readonly now: () => Date;
  private readonly dispatches = new Map<string, { context: string; result: Promise<CopilotProjectsDispatchResult> }>();

  constructor(options: {
    runner?: Runner;
    resolve?: () => Promise<string>;
    now?: () => Date;
  } = {}) {
    this.runner = options.runner ?? run;
    this.resolve = options.resolve ?? (() => executable('copilot-projects'));
    this.now = options.now ?? (() => new Date());
  }

  async list(signal: AbortSignal): Promise<CopilotProjectsListOutput> {
    checkAbort(signal);
    try {
      const binary = await this.resolve();
      const result = await this.runner(binary, ['list-projects'], signal);
      if (result.code !== 0) return { available: false, projects: [] };
      return copilotProjectsListOutputSchema.parse({
        available: true,
        projects: parseCopilotProjectsList(result.stdout),
      });
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ServiceError && (error.dto.code === 'missing_cli' || error.dto.code === 'unavailable')) {
        return { available: false, projects: [] };
      }
      throw error;
    }
  }

  async dispatch(input: CopilotProjectsDispatchInput, signal: AbortSignal): Promise<CopilotProjectsDispatchResult> {
    const value = parse(copilotProjectsDispatchInputSchema, input);
    const context = JSON.stringify(value);
    const existing = this.dispatches.get(value.operationId);
    if (existing) {
      if (existing.context !== context) throw new ServiceError('invalid_input');
      return existing.result;
    }
    if (this.dispatches.size >= 4096) throw new ServiceError('limit');
    const result = this.performDispatch(value, signal);
    this.dispatches.set(value.operationId, { context, result });
    try {
      return await result;
    } catch (error) {
      this.dispatches.delete(value.operationId);
      throw error;
    }
  }

  private async performDispatch(
    value: CopilotProjectsDispatchInput,
    signal: AbortSignal,
  ): Promise<CopilotProjectsDispatchResult> {
    checkAbort(signal);
    const binary = await this.resolve();
    const listed = await this.list(signal);
    const target = selectCopilotProject(listed.projects, value);
    if (!target) throw new ServiceError('unavailable');
    const requestId = deterministicRequestId(value.operationId);
    const promptPath = join(tmpdir(), `copilot-projects-prompt-${requestId}.md`);
    try {
      await writeFile(promptPath, value.prompt, { encoding: 'utf8', mode: 0o600 });
      const args = [
        'new-copilot-session',
        '--project', target.id,
        '--request-id', requestId,
        '--prompt-file', promptPath,
        '--title', value.title,
      ];
      if (value.host?.trim()) args.push('--host', value.host.trim());
      const launched = await this.runner(binary, args, signal);
      if (launched.code !== 0) throw new ServiceError('unavailable', true);
      return copilotProjectsDispatchResultSchema.parse({
        operationId: value.operationId,
        requestId,
        projectId: target.id,
        projectName: target.name,
        status: 'confirmed',
        confirmedAt: this.now().toISOString(),
      });
    } finally {
      await rm(promptPath, { force: true }).catch(() => {});
    }
  }
}
