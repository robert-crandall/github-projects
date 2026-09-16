import type { MCPServerConfig } from '@github/copilot-sdk';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ServiceError } from './errors.ts';
import { workActionSchema, type Workstream } from './work-schema.ts';

const toolName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/);
const serverName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/);
const values = z.record(z.string().max(200), z.string().max(16_000));
const common = {
  tools: z.array(z.string().max(200)).max(500).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
};
const serverSchema = z.union([
  z.object({
    ...common, type: z.enum(['local', 'stdio']).optional(),
    command: z.string().min(1).max(4000), args: z.array(z.string().max(16_000)).max(100).optional(),
    env: values.optional(), workingDirectory: z.string().max(4000).optional(),
  }),
  z.object({
    ...common, type: z.enum(['http', 'sse']), url: z.url().max(4000),
    headers: values.optional(),
    oauthClientId: z.string().min(1).max(2000).optional(),
    oauthPublicClient: z.boolean().optional(),
  }),
]);
const configSchema = z.object({ mcpServers: z.record(serverName, serverSchema) });
export type McpOAuthScope = { homeDirectory: string; configDirectory: string };
export function sharedMcpOAuthScope(): McpOAuthScope {
  const homeDirectory = homedir();
  const configDirectory = process.env.COPILOT_MCP_OAUTH_CONFIG_DIR ?? join(homeDirectory, '.copilot');
  if (!isAbsolute(configDirectory)) throw new ServiceError('mcp_configuration');
  return { homeDirectory, configDirectory };
}
export const connectionInstructions = 'Copilot App MCP connections are not automatically shared with this service. '
  + 'Use the official Copilot CLI /mcp add setup (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-server), '
  + 'or explicitly export/copy an existing MCP configuration to a private file and set backend COPILOT_MCP_CONFIG_PATH to its absolute path. '
  + 'The default is ~/.copilot/mcp-config.json. Selected collectors use the SDK-supported persistent OAuth store (OS keychain); '
  + 'and the existing CLI HOME/config directory with all other discovery disabled. '
  + 'Backend COPILOT_MCP_OAUTH_CONFIG_DIR can select an explicit shared CLI OAuth configuration directory. '
  + 'Credentials must be available to this CLI connection, and app sign-in is not guaranteed to be shared. Tokens are never copied. '
  + 'The official Slack endpoint is https://mcp.slack.com/mcp. Complete any required OAuth sign-in through supported CLI MCP setup first. '
  + 'Tool names shown are explicit configured names, not live discovery. An empty list means no explicit names were configured. '
  + 'Select only known read tools (search and full-thread reads). Wildcards and write tools are never approved. '
  + 'Never paste tokens, commands, or configuration JSON into the app.';

export class McpConnections {
  constructor(private readonly options: {
    path?: string; read?: (path: string) => Promise<string>; environment?: NodeJS.ProcessEnv;
  } = {}) {}
  private async configurations() {
    const path = this.options.path ?? process.env.COPILOT_MCP_CONFIG_PATH ?? join(homedir(), '.copilot', 'mcp-config.json');
    if (!isAbsolute(path)) throw new ServiceError('mcp_configuration');
    let text: string;
    try {
      if (!this.options.read) {
        const file = await stat(path);
        if (!file.isFile() || file.size > 1_048_576) throw new ServiceError('mcp_configuration');
      }
      text = await (this.options.read ?? (path => readFile(path, 'utf8')))(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw new ServiceError('mcp_configuration');
    }
    if (Buffer.byteLength(text) > 1_048_576) throw new ServiceError('mcp_configuration');
    try { return configSchema.parse(JSON.parse(text)).mcpServers; }
    catch { throw new ServiceError('mcp_configuration'); }
  }
  async list() {
    const config = await this.configurations();
    return {
      servers: Object.entries(config).map(([name, value]) => ({
        name, tools: value.tools?.filter(name => toolName.safeParse(name).success) ?? [],
        source: this.options.path || process.env.COPILOT_MCP_CONFIG_PATH ? 'explicit backend MCP configuration' : 'Copilot CLI configuration',
      })),
      instructions: connectionInstructions,
    };
  }
  async selected(stream: Workstream): Promise<MCPServerConfig> {
    if (!serverName.safeParse(stream.server).success || !stream.tools.length
      || new Set(stream.tools).size !== stream.tools.length
      || stream.tools.some(name => !toolName.safeParse(name).success)) throw new ServiceError('mcp_configuration');
    const configured = (await this.configurations())[stream.server];
    if (!configured) throw new ServiceError('mcp_configuration');
    if (configured.tools && !configured.tools.includes('*')
      && stream.tools.some(name => !configured.tools!.includes(name))) throw new ServiceError('mcp_configuration');
    const env = this.options.environment ?? process.env;
    const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      if (!env[key]) throw new ServiceError('mcp_configuration');
      return env[key]!;
    });
    const record = (value: Record<string, string> | undefined) =>
      value && Object.fromEntries(Object.entries(value).map(([key, value]) => [key, expand(value)]));
    const config: MCPServerConfig = 'url' in configured
      ? { ...configured, url: expand(configured.url), headers: record(configured.headers) }
      : { ...configured, args: configured.args?.map(expand), env: record(configured.env) };
    if ('url' in config) {
      const url = new URL(config.url);
      if (url.username || url.password || !(url.protocol === 'https:'
        || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new ServiceError('mcp_configuration');
      }
    }
    return { ...config, tools: [...stream.tools], timeout: Math.min(config.timeout ?? 20_000, 20_000) };
  }
}

export const extractedRequestsSchema = z.strictObject({
  requests: z.array(z.strictObject({
    eventId: z.string().min(1).max(500),
    sourceTimestamp: z.string().min(1).max(100),
    sourceUrl: z.url().max(2000),
    targetUrl: z.url().max(2000).nullable(),
    title: z.string().trim().min(1).max(1000),
    summary: z.string().trim().min(1).max(2000),
    action: workActionSchema,
  })).max(200),
  warnings: z.array(z.string().max(1000)).max(20),
});
export type ExtractedRequests = z.infer<typeof extractedRequestsSchema>;
export function sourceTime(value: string): string {
  if (z.iso.datetime().safeParse(value).success) return value;
  // Slack ts is the immutable message time, never last-edited time.
  if (/^\d{10}\.\d{6}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  throw new ServiceError('copilot_output');
}

export function sourceReadFailed(text: string): boolean {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return object.isError === true || object.ok === false || object.success === false
    || typeof object.error === 'string' && object.error.length > 0
    || !!object.error && typeof object.error === 'object';
}

export function canonicalGithubUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})\/(pull|issues)\/([1-9]\d{0,15})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || url.username || url.password || !match) return undefined;
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/${match[3]}/${match[4]}`;
}

export function normalizeWorkUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ServiceError('invalid_input'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ServiceError('invalid_input');
  const github = canonicalGithubUrl(raw);
  if (github) return github;
  if (url.hostname.endsWith('.slack.com') && /^\/archives\/[A-Z0-9]+\/p\d{16}$/.test(url.pathname)) {
    url.search = '';
    url.hash = '';
  }
  return url.href;
}

export function sourceLinks(text: string): string[] {
  const links = new Set<string>();
  let consumedThrough = 0;
  for (const match of text.matchAll(/https:\/\//g)) {
    const start = match.index;
    if (start < consumedThrough) continue;
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(text[previous]!)) previous--;
    const angle = text[start - 1] === '<';
    const markdown = !angle && text[previous] === '(' && text[previous - 1] === ']';
    let value = '';
    let depth = 0;
    let index = start;
    for (; index < text.length; index++) {
      const character = text[index]!;
      if (/[\s<>"`]/.test(character) || angle && character === '|') break;
      if (character === '\\') {
        const next = text[index + 1];
        if (markdown && next && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(next)) {
          value += next;
          index++;
          continue;
        }
        break;
      }
      if (markdown && character === '(') depth++;
      if (markdown && character === ')') {
        if (depth === 0) break;
        depth--;
      }
      value += character;
    }
    consumedThrough = index;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) links.add(value);
    } catch { /* Invalid link destinations cannot establish source evidence. */ }
  }
  return [...links];
}

// Bind immutable fields within one message, not edit times or unrelated values elsewhere in a thread.
export function groundedRequests(result: ExtractedRequests, outputs: string[]): ExtractedRequests {
  const records: { ids: Set<string>; times: Set<string>; urls: Set<string> }[] = [];
  const idFields = new Set(['id', 'eventId', 'event_id', 'messageId', 'message_id', 'ts', 'uuid']);
  const timeFields = new Set(['created_at', 'createdAt', 'occurredAt', 'occurred_at', 'sourceTimestamp', 'ts', 'timestamp', 'submitted_at']);
  const urlFields = new Set(['url', 'sourceUrl', 'html_url', 'permalink', 'web_url', 'targetUrl']);
  const textFields = new Set(['text', 'body', 'content', 'message']);
  const collect = (raw: unknown, depth = 0): void => {
    if (depth > 30) throw new ServiceError('limit');
    if (Array.isArray(raw)) {
      for (const item of raw) collect(item, depth + 1);
    } else if (raw && typeof raw === 'object') {
      const object = raw as Record<string, unknown>;
      if (object.type === 'text' && typeof object.text === 'string' && Object.keys(object).every(key => ['type', 'text', 'annotations'].includes(key))) {
        let parsed: unknown;
        try { parsed = JSON.parse(object.text); } catch { /* Non-structured tool output cannot prove a source event. */ }
        if (parsed !== undefined) collect(parsed, depth + 1);
      }
      const record = { ids: new Set<string>(), times: new Set<string>(), urls: new Set<string>() };
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' || typeof value === 'number') {
          const scalar = String(value);
          if (idFields.has(key)) record.ids.add(scalar);
          if (timeFields.has(key)) record.times.add(scalar);
          if (urlFields.has(key)) record.urls.add(scalar);
          if (textFields.has(key)) for (const url of sourceLinks(scalar)) record.urls.add(url);
        }
        collect(value, depth + 1);
      }
      if (record.ids.size && record.times.size) records.push(record);
    }
  };
  for (const text of outputs) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    collect(parsed);
  }
  for (const request of result.requests) {
    sourceTime(request.sourceTimestamp);
    if (!records.some(record => record.ids.has(request.eventId) && record.times.has(request.sourceTimestamp)
      && record.urls.has(request.sourceUrl)
      && (!request.targetUrl || [...record.urls].some(value => canonicalGithubUrl(value) === canonicalGithubUrl(request.targetUrl!))))) {
      throw new ServiceError('copilot_output');
    }
    if (request.targetUrl && !canonicalGithubUrl(request.targetUrl)) throw new ServiceError('copilot_output');
    const source = new URL(request.sourceUrl);
    if (source.protocol !== 'https:' || source.username || source.password) throw new ServiceError('copilot_output');
    if (source.hostname.endsWith('.slack.com')) {
      const match = /^\/archives\/[A-Z0-9]+\/p(\d{16})$/.exec(source.pathname);
      if (!match || request.sourceTimestamp.replace('.', '') !== match[1]
        || request.eventId !== request.sourceTimestamp) throw new ServiceError('copilot_output');
    }
  }
  return result;
}
