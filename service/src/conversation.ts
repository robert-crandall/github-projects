import { z } from 'zod';
import { checkAbort, sanitized, ServiceError } from './errors.ts';
import { pageLink, parse, requireStatus, type GitHubApi } from './github.ts';
import {
  conversationInputSchema, conversationKey, conversationPageSchema, LIMITS, loginSchema,
  type ConversationInput, type ConversationMessage, type ConversationPage, type Reference,
} from './schema.ts';

const time = z.iso.datetime();
const sourceId = z.number().int().positive().safe();
const rawMessage = z.object({
  id: sourceId, body: z.string().nullable(),
  user: z.object({ login: loginSchema }).nullable(),
  created_at: time.optional(), updated_at: time.optional(), submitted_at: time.nullable().optional(),
  html_url: z.string(),
  in_reply_to_id: sourceId.optional(), pull_request_review_id: sourceId.optional(),
  path: z.string().max(4_096).optional(),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
});

function messageId(reference: Reference, stream: ConversationInput['stream'], id: number): string {
  return `github:${conversationKey(reference)}:${stream}:${id}`;
}

export function sourceUrl(reference: Reference): string {
  return `https://github.com/${reference.repo}/${reference.kind === 'pr' ? 'pull' : 'issues'}/${reference.number}`;
}

function validateUrl(value: string, reference: Reference): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError('invalid_output'); }
  // API links are evidence, not permission to navigate to arbitrary hosts.
  const root = sourceUrl(reference);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search
    || `${url.origin}${url.pathname}`.toLowerCase() !== root.toLowerCase()
    || (url.hash && !/^#(?:issue-\d+|issuecomment-\d+|pullrequestreview-\d+|discussion_r\d+)$/.test(url.hash))) {
    throw new ServiceError('invalid_output');
  }
  return url.href;
}

function normalize(raw: unknown, input: ConversationInput): ConversationMessage {
  const value = parse(rawMessage, raw);
  const createdAt = value.created_at ?? value.submitted_at;
  if (!createdAt) throw new ServiceError('invalid_output');
  return {
    id: messageId(input.reference, input.stream, value.id), kind: input.stream,
    body: value.body ?? '', author: value.user?.login ?? null,
    createdAt, updatedAt: value.updated_at ?? createdAt,
    url: validateUrl(value.html_url, input.reference),
    replyTo: value.in_reply_to_id ? messageId(input.reference, 'inline', value.in_reply_to_id) : null,
    reviewId: value.pull_request_review_id ? messageId(input.reference, 'reviews', value.pull_request_review_id) : null,
    path: value.path ?? null, line: value.line ?? value.original_line ?? null,
  };
}

export async function readConversation(api: GitHubApi, input: ConversationInput, signal: AbortSignal): Promise<ConversationPage> {
  const value = parse(conversationInputSchema, input);
  if ((value.stream === 'reviews' || value.stream === 'inline') && value.reference.kind !== 'pr') {
    throw new ServiceError('invalid_input');
  }
  if (value.stream === 'description' && value.page !== null && value.page !== 1) throw new ServiceError('invalid_input');
  const result: ConversationPage = {
    reference: value.reference, stream: value.stream, page: value.page ?? 1,
    newestPage: value.page ?? 1, olderPage: null, fetchedAt: new Date().toISOString(), messages: [], error: null,
  };
  try {
    checkAbort(signal);
    if (value.stream === 'description') {
      const response = await api.request('GET',
        `/repos/${value.reference.repo}/${value.reference.kind === 'pr' ? 'pulls' : 'issues'}/${value.reference.number}`, signal);
      requireStatus(response);
      const source = parse(rawMessage.extend({ number: sourceId, created_at: time, updated_at: time }), response.body);
      if (source.number !== value.reference.number) throw new ServiceError('invalid_output');
      result.messages = [normalize(source, value)];
    } else {
      const path = `/repos/${value.reference.repo}/${value.stream === 'comments' ? 'issues' : 'pulls'}/${value.reference.number}/${value.stream === 'reviews' ? 'reviews' : 'comments'}`;
      const read = async (page: number) => {
        const response = await api.request('GET', `${path}?per_page=5&page=${page}`, signal);
        requireStatus(response);
        return response;
      };
      let response = await read(value.page ?? 1);
      const last = pageLink(response, 'last', path);
      if (value.page === null && !last && pageLink(response, 'next', path)) throw new ServiceError('invalid_output');
      result.newestPage = last ?? value.page ?? 1;
      result.page = value.page ?? result.newestPage;
      result.olderPage = result.page > 1 ? result.page - 1 : null;
      if (value.page === null && result.page !== 1) response = await read(result.page);
      const list = parse(z.array(z.unknown()).max(5), response.body);
      // One bad message makes this page incomplete, but readable siblings still survive.
      for (const raw of list) {
        try { result.messages.push(normalize(raw, value)); }
        catch (error) { result.error = sanitized(error); }
      }
      if (value.page === null && pageLink(response, 'next', path)) {
        result.error = sanitized(new ServiceError('unavailable', true));
      }
    }
    const unique = new Map<string, ConversationMessage>();
    for (const message of result.messages) {
      const before = unique.get(message.id);
      if (!before || before.updatedAt <= message.updatedAt) unique.set(message.id, message);
    }
    result.messages = [...unique.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.responseBytes - 4_096) {
      // Never clip a body or advance silently past an untransportable page.
      result.messages = [];
      result.error = sanitized(new ServiceError('limit'));
    }
  } catch (error) {
    checkAbort(signal);
    result.error = sanitized(error);
  }
  return conversationPageSchema.parse(result);
}
