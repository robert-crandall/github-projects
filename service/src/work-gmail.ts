import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { checkAbort, ServiceError } from './errors.ts';
import { executable, run, type Runner } from './process.ts';
import {
  gmailArchiveInputSchema,
  gmailArchiveResultSchema,
  gmailctlFilterInputSchema,
  gmailctlFilterResultSchema,
  workCollectInputSchema,
  workCollectOutputSchema,
  type GmailArchiveInput,
  type GmailArchiveResult,
  type GmailctlFilterInput,
  type GmailctlFilterResult,
  type WorkCandidate,
  type WorkCollection,
} from './work-schema.ts';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError('invalid_input');
  return result.data;
}

export {
  gmailArchiveInputSchema,
  gmailArchiveResultSchema,
  gmailctlFilterInputSchema,
  gmailctlFilterResultSchema,
  type GmailArchiveInput,
  type GmailArchiveResult,
  type GmailctlFilterInput,
  type GmailctlFilterResult,
};

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountEmail?: string;
}

interface GmailMessageHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: GmailMessageHeader[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
}

export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function parseEmailAddress(rawFrom: string): { name: string; email: string } {
  const trimmed = rawFrom.trim();
  const angle = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed);
  if (angle) {
    const email = angle[2]!.trim().toLowerCase();
    const rawName = angle[1]!.trim().replace(/^["']|["']$/g, '').trim();
    return { name: rawName || email, email };
  }
  const emailMatch = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(trimmed);
  if (emailMatch) {
    const email = emailMatch[1]!.toLowerCase();
    return { name: trimmed, email };
  }
  return { name: trimmed || 'Unknown sender', email: '' };
}

export function parseListId(rawListId: string): string | undefined {
  const trimmed = rawListId.trim();
  if (!trimmed) return undefined;
  const angle = /<([^<>]+)>/.exec(trimmed);
  const candidate = (angle ? angle[1]! : trimmed).trim();
  return candidate ? candidate.slice(0, 320) : undefined;
}

export function parseListUnsubscribe(rawHeader: string): {
  unsubscribeUrl?: string;
  unsubscribeMailto?: string;
} {
  let unsubscribeUrl: string | undefined;
  let unsubscribeMailto: string | undefined;
  const matches = rawHeader.matchAll(/<([^<>]+)>/g);
  for (const match of matches) {
    const value = match[1]?.trim() ?? '';
    if (!unsubscribeUrl && /^https?:\/\//i.test(value)) {
      unsubscribeUrl = value.slice(0, 2_000);
    } else if (!unsubscribeMailto && /^mailto:/i.test(value)) {
      unsubscribeMailto = value.slice(0, 1_000);
    }
  }
  if (!unsubscribeUrl) {
    const bareUrl = /(https?:\/\/[^\s,>]+)/i.exec(rawHeader);
    if (bareUrl) unsubscribeUrl = bareUrl[1]!.slice(0, 2_000);
  }
  return { unsubscribeUrl, unsubscribeMailto };
}

function decodeBase64Url(encoded: string): string {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractGmailBody(payload?: GmailMessageResponse['payload'], fallbackSnippet = ''): string {
  if (!payload) return fallbackSnippet;
  const findPart = (parts: GmailMessagePart[] | undefined, mime: string): string | undefined => {
    for (const part of parts ?? []) {
      if (part.mimeType === mime && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts?.length) {
        const nested = findPart(part.parts, mime);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  const plain = findPart(payload.parts, 'text/plain');
  if (plain?.trim()) return plain.trim().slice(0, 4_000);
  if (payload.body?.data) {
    const direct = decodeBase64Url(payload.body.data).trim();
    if (direct) {
      const isHtml = payload.mimeType?.toLowerCase() === 'text/html';
      return (isHtml ? stripHtml(direct) : direct).slice(0, 4_000);
    }
  }
  const html = findPart(payload.parts, 'text/html');
  if (html?.trim()) return stripHtml(html).slice(0, 4_000);
  return fallbackSnippet.trim().slice(0, 4_000);
}

function jsonnetLiteral(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;
}

export function buildGmailctlRuleSnippet(input: {
  from?: string;
  list?: string;
  subject?: string;
  archive?: boolean;
  markRead?: boolean;
  deleteIt?: boolean;
}): string {
  const filters: string[] = [];
  if (input.list?.trim()) filters.push(`list: ${jsonnetLiteral(input.list.trim())}`);
  else if (input.from?.trim()) filters.push(`from: ${jsonnetLiteral(input.from.trim())}`);
  if (input.subject?.trim()) filters.push(`subject: ${jsonnetLiteral(input.subject.trim())}`);
  if (!filters.length) throw new ServiceError('invalid_input');

  const actions: string[] = [];
  if (input.deleteIt) {
    actions.push('delete: true');
  } else {
    if (input.archive !== false) actions.push('archive: true');
    if (input.markRead !== false) actions.push('markRead: true');
  }
  if (!actions.length) throw new ServiceError('invalid_input');

  return `    {\n      filter: { ${filters.join(', ')} },\n      actions: { ${actions.join(', ')} },\n    },`;
}

export function insertGmailctlRuleIntoJsonnet(source: string, ruleSnippet: string): string {
  const expectedRuleBody = ruleSnippet.trim().replace(/,$/, '').trim();
  let openBracketIndex = -1;
  let lastTokenIndex = -1;
  let depth = 0;
  let braceDepth = 0;
  let currentRule = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (escaped) {
      if (braceDepth > 0) currentRule += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && (inSingle || inDouble)) {
      if (braceDepth > 0) currentRule += ch;
      escaped = true;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]!))) {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }
    if (ch === "'" && !inDouble) {
      if (braceDepth > 0) currentRule += ch;
      inSingle = !inSingle;
      if (!inSingle && openBracketIndex !== -1) lastTokenIndex = i;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (braceDepth > 0) currentRule += ch;
      inDouble = !inDouble;
      if (!inDouble && openBracketIndex !== -1) lastTokenIndex = i;
      continue;
    }
    if (inSingle || inDouble) {
      if (braceDepth > 0) currentRule += ch;
      continue;
    }
    if (openBracketIndex === -1) {
      if (ch === 'r' && (i === 0 || !/[A-Za-z0-9_$]/.test(source[i - 1]!))) {
        const match = /^rules\s*:\s*\[/.exec(source.slice(i));
        if (match) {
          openBracketIndex = i + match[0].length - 1;
          lastTokenIndex = openBracketIndex;
          i = openBracketIndex;
          depth = 1;
        }
      }
      continue;
    }
    if (depth === 1 && braceDepth === 0 && ch === '{') {
      braceDepth = 1;
      currentRule = '{';
    } else if (braceDepth > 0) {
      currentRule += ch;
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') {
        braceDepth -= 1;
        if (braceDepth === 0 && currentRule.trim() === expectedRuleBody) {
          return source;
        }
      }
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const withComma = lastTokenIndex > openBracketIndex && source[lastTokenIndex] !== ','
          ? `${source.slice(0, lastTokenIndex + 1)},${source.slice(lastTokenIndex + 1, i)}`
          : source.slice(0, i);
        const before = withComma.replace(/[ \t]*$/, '');
        const after = source.slice(i);
        const prefix = before.endsWith('\n') ? before : `${before}\n`;
        return `${prefix}${ruleSnippet}\n  ${after}`;
      }
    }
    if (!/\s/.test(ch)) lastTokenIndex = i;
  }
  throw new ServiceError('invalid_input');
}

export async function loadGmailCredentials(): Promise<GmailCredentials | null> {
  const candidates = [
    process.env.GITHUB_PROJECTS_GMAIL_CONFIG,
    process.env.MONA_CONFIG_PATH,
    join(homedir(), '.config', 'github-projects', 'gmail.json'),
    join(homedir(), '.mona', 'config.json'),
  ].filter((item): item is string => Boolean(item?.trim()));

  for (const candidatePath of candidates) {
    try {
      const raw = JSON.parse(await readFile(expandHomePath(candidatePath), 'utf8')) as Record<string, unknown>;
      const block = (raw.gmail && typeof raw.gmail === 'object' ? raw.gmail : raw) as Record<string, unknown>;
      const clientId = typeof block.clientId === 'string' ? block.clientId.trim() : '';
      const clientSecret = typeof block.clientSecret === 'string' ? block.clientSecret.trim() : '';
      const refreshToken = typeof block.refreshToken === 'string' ? block.refreshToken.trim() : '';
      const accountEmail = typeof block.accountEmail === 'string' ? block.accountEmail.trim() : undefined;
      if (clientId && clientSecret && refreshToken) {
        return { clientId, clientSecret, refreshToken, accountEmail };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class WorkGmail {
  private readonly fetchFn: typeof fetch;
  private readonly credentialsLoader: () => Promise<GmailCredentials | null>;
  private readonly runner: Runner;
  private readonly resolveGmailctl: () => Promise<string>;
  private readonly gmailctlConfigPath: string;
  private readonly now: () => Date;
  private readonly operations = new Map<string, { context: string; result: Promise<unknown> }>();
  private filterWriteQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    fetchFn?: typeof fetch;
    credentialsLoader?: () => Promise<GmailCredentials | null>;
    runner?: Runner;
    resolveGmailctl?: () => Promise<string>;
    gmailctlConfigPath?: string;
    now?: () => Date;
  } = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.credentialsLoader = options.credentialsLoader ?? loadGmailCredentials;
    this.runner = options.runner ?? run;
    this.resolveGmailctl = options.resolveGmailctl ?? (() => executable('gmailctl'));
    this.gmailctlConfigPath = options.gmailctlConfigPath
      ?? process.env.GMAILCTL_CONFIG_PATH
      ?? '~/repos/documents/gmailctl/config.jsonnet';
    this.now = options.now ?? (() => new Date());
  }

  private async accessToken(signal: AbortSignal): Promise<{ token: string; credentials: GmailCredentials }> {
    checkAbort(signal);
    const credentials = await this.credentialsLoader();
    if (!credentials) throw new ServiceError('authentication');
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });
    if (!response.ok) throw new ServiceError('unavailable', true);
    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) throw new ServiceError('unavailable', true);
    return { token: data.access_token, credentials };
  }

  async collect(raw: z.input<typeof workCollectInputSchema>, signal: AbortSignal): Promise<WorkCollection> {
    const parsedInput = workCollectInputSchema.safeParse(raw);
    if (!parsedInput.success || parsedInput.data.stream.kind !== 'gmail') {
      throw new ServiceError('invalid_input');
    }
    const input = parsedInput.data;
    checkAbort(signal);
    const { stream } = input;
    const collectedAt = this.now().toISOString();
    if (input.observeOnly) {
      return workCollectOutputSchema.parse({
        candidates: [],
        observations: [],
        warnings: [],
        collectedAt,
      });
    }
    const credentials = await this.credentialsLoader();
    if (!credentials) {
      return workCollectOutputSchema.parse({
        candidates: [],
        observations: [],
        warnings: [],
        coverageInfo: ['Configure Gmail OAuth in ~/.mona/config.json or ~/.config/github-projects/gmail.json.'],
        collectedAt,
      });
    }
    const { token } = await this.accessToken(signal);
    const query = stream.query.trim() || 'in:inbox is:unread';
    const messageRefs: Array<{ id: string; threadId: string }> = [];
    const coverageInfo: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 2; page += 1) {
      const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      listUrl.searchParams.set('q', query);
      listUrl.searchParams.set('maxResults', '25');
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

      const listResp = await this.fetchFn(listUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!listResp.ok) throw new ServiceError('unavailable', true);
      const listJson = (await listResp.json()) as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };
      messageRefs.push(...(listJson.messages ?? []));
      pageToken = listJson.nextPageToken?.trim() || undefined;
      if (!pageToken) break;
    }
    if (pageToken) {
      coverageInfo.push('Gmail collection is capped at 50 messages per run; archive or filter older messages to surface the rest.');
    }

    const seenThreads = new Set<string>();
    const candidates: WorkCandidate[] = [];
    const observations: WorkCollection['observations'] = [];
    const accountSegment = credentials.accountEmail ? encodeURIComponent(credentials.accountEmail) : '0';

    for (const ref of messageRefs) {
      if (seenThreads.has(ref.threadId)) continue;
      seenThreads.add(ref.threadId);
      checkAbort(signal);
      const msgUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}`);
      msgUrl.searchParams.set('format', 'full');
      const msgResp = await this.fetchFn(msgUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!msgResp.ok) {
        if (msgResp.status === 404) continue;
        throw new ServiceError('unavailable', true);
      }
      const msg = (await msgResp.json()) as GmailMessageResponse;
      const headers = msg.payload?.headers ?? [];
      const header = (name: string): string =>
        headers.find(item => item.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? '';

      const subject = (header('Subject') || '(no subject)').slice(0, 1000);
      const rawFrom = header('From') || 'Unknown sender';
      const { name: senderName, email: senderEmail } = parseEmailAddress(rawFrom);
      const listId = parseListId(header('List-Id'));
      const { unsubscribeUrl } = parseListUnsubscribe(header('List-Unsubscribe'));
      const snippet = (msg.snippet ?? '').replace(/\s+/g, ' ').trim();
      const bodyPreview = extractGmailBody(msg.payload, snippet);
      const internalMs = Number(msg.internalDate);
      const updatedAt = Number.isFinite(internalMs) && internalMs > 0
        ? new Date(internalMs).toISOString()
        : collectedAt;
      const threadId = msg.threadId || ref.threadId || msg.id;
      const url = `https://mail.google.com/mail/u/${accountSegment}/#inbox/${encodeURIComponent(threadId)}`;
      const summaryText = bodyPreview
        ? `From ${senderName}${senderEmail && senderEmail !== senderName ? ` <${senderEmail}>` : ''}:\n${bodyPreview}`
        : `Unread email from ${senderName}`;

      observations.push({
        url,
        state: 'open',
        observedAt: collectedAt,
        reason: '',
      });

      candidates.push({
        title: subject,
        action: stream.action,
        url,
        email: {
          messageId: msg.id.slice(0, 200),
          threadId: threadId.slice(0, 200),
          from: rawFrom.slice(0, 500),
          senderEmail: (senderEmail || undefined)?.slice(0, 320),
          subject,
          snippet: (bodyPreview || snippet).slice(0, 4000) || undefined,
          listId: listId?.slice(0, 500),
          unsubscribeUrl: unsubscribeUrl && unsubscribeUrl.startsWith('https://') ? unsubscribeUrl : undefined,
        },
        evidence: [
          {
            id: `gmail:${threadId}:${msg.id}`.slice(0, 500),
            source: 'gmail',
            streamId: stream.id,
            at: updatedAt,
            url,
            summary: summaryText.slice(0, 2000),
          },
        ],
      });
    }

    return workCollectOutputSchema.parse({
      candidates,
      observations,
      warnings: [],
      ...(coverageInfo.length ? { coverageInfo } : {}),
      collectedAt,
    });
  }

  async archive(input: GmailArchiveInput, signal: AbortSignal): Promise<GmailArchiveResult> {
    const value = parse(gmailArchiveInputSchema, input);
    const context = JSON.stringify(value);
    const existing = this.operations.get(value.operationId);
    if (existing) {
      if (existing.context !== context) throw new ServiceError('invalid_input');
      return existing.result as Promise<GmailArchiveResult>;
    }
    if (this.operations.size >= 4096) throw new ServiceError('limit');
    const promise = this.performArchive(value, signal);
    this.operations.set(value.operationId, { context, result: promise });
    try {
      return await promise;
    } catch (error) {
      this.operations.delete(value.operationId);
      throw error;
    }
  }

  private async performArchive(value: GmailArchiveInput, signal: AbortSignal): Promise<GmailArchiveResult> {
    const { token } = await this.accessToken(signal);
    const explicitThreadId = value.threadId?.trim();
    const removeLabelIds = [
      ...(value.archive !== false ? ['INBOX'] : []),
      ...(value.markRead ? ['UNREAD'] : []),
    ];
    const endpoint = explicitThreadId
      ? `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(explicitThreadId)}/modify`
      : `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(value.messageId)}/modify`;
    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds }),
      signal,
    });
    if (!response.ok) throw new ServiceError('unavailable', true);
    const payload = (await response.json().catch(() => ({}))) as { id?: string; threadId?: string };
    const threadId = explicitThreadId || payload.threadId?.trim() || payload.id?.trim() || value.messageId;
    return gmailArchiveResultSchema.parse({
      operationId: value.operationId,
      messageId: value.messageId,
      threadId,
      status: 'confirmed',
      confirmedAt: this.now().toISOString(),
    });
  }

  async addGmailctlFilter(input: GmailctlFilterInput, signal: AbortSignal): Promise<GmailctlFilterResult> {
    const value = parse(gmailctlFilterInputSchema, input);
    const context = JSON.stringify(value);
    const existing = this.operations.get(value.operationId);
    if (existing) {
      if (existing.context !== context) throw new ServiceError('invalid_input');
      return existing.result as Promise<GmailctlFilterResult>;
    }
    if (this.operations.size >= 4096) throw new ServiceError('limit');
    const promise = this.performAddGmailctlFilter(value, signal);
    this.operations.set(value.operationId, { context, result: promise });
    try {
      return await promise;
    } catch (error) {
      this.operations.delete(value.operationId);
      throw error;
    }
  }

  private async performAddGmailctlFilter(
    value: GmailctlFilterInput,
    signal: AbortSignal,
  ): Promise<GmailctlFilterResult> {
    checkAbort(signal);
    const configPath = expandHomePath(this.gmailctlConfigPath.trim() || '~/repos/documents/gmailctl/config.jsonnet');
    const ruleSnippet = buildGmailctlRuleSnippet(value);
    const writeStep = this.filterWriteQueue.then(async () => {
      checkAbort(signal);
      let writeTargetPath = configPath;
      try {
        writeTargetPath = realpathSync(configPath);
      } catch { /* Use configPath directly if realpath resolution fails. */ }
      const original = await readFile(writeTargetPath, 'utf8').catch(() => {
        throw new ServiceError('invalid_input');
      });
      const updated = insertGmailctlRuleIntoJsonnet(original, ruleSnippet);
      if (updated !== original) {
        const tmpPath = join(dirname(writeTargetPath), `.config.jsonnet.${randomUUID()}.tmp`);
        try {
          await writeFile(tmpPath, updated, { encoding: 'utf8', mode: 0o600 });
          await rename(tmpPath, writeTargetPath);
        } catch (error) {
          await rm(tmpPath, { force: true }).catch(() => {});
          throw error;
        }
      }
    });
    this.filterWriteQueue = writeStep.catch(() => {});
    await writeStep;
    let applied = false;
    if (value.apply) {
      const binary = await this.resolveGmailctl();
      const configDir = dirname(configPath);
      const defaultDir = expandHomePath('~/.gmailctl');
      const defaultConfig = join(defaultDir, 'config.jsonnet');
      let applyDir = configDir;
      if (!existsSync(join(configDir, 'credentials.json')) && existsSync(defaultConfig)) {
        try {
          if (realpathSync(defaultConfig) === realpathSync(configPath)) applyDir = defaultDir;
        } catch { /* Fall back to configDir if symlink resolution fails. */ }
      }
      const applyRun = await this.runner(binary, ['apply', '--config', applyDir, '--yes'], signal);
      if (applyRun.code !== 0) throw new ServiceError('unavailable', true);
      applied = true;
    }
    return gmailctlFilterResultSchema.parse({
      operationId: value.operationId,
      configPath,
      ruleSnippet: ruleSnippet.trim(),
      applied,
      status: 'confirmed',
      confirmedAt: this.now().toISOString(),
    });
  }
}
