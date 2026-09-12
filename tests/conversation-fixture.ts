import { conversationCacheSchema, conversationKey, type ConversationCache, type ConversationPage, type Reference } from '../service/src/schema.ts';
import type { ApiResponse, GitHubApi } from '../service/src/github.ts';

export const conversationAt = '2026-09-11T17:00:00Z';
export const longBody = '# The complete conversation\n\n' + 'Readable source content, not a summary. '.repeat(100) + '\n\nEND OF LONG MESSAGE';
export function rawMessage(reference: Reference, id: number, body: string, inline = false) {
  return {
    id, number: reference.number, user: { login: 'octocat' }, body,
    created_at: conversationAt, updated_at: conversationAt, submitted_at: conversationAt,
    html_url: `https://github.com/${reference.repo}/${reference.kind === 'pr' ? 'pull' : 'issues'}/${reference.number}#${inline ? 'discussion_r' : 'issuecomment-'}${id}`,
  };
}
export class ConversationApi implements GitHubApi {
  calls: string[] = [];
  routes = new Map<string, ApiResponse | Error>();
  hold?: Promise<void>;
  failure?: Error;
  async request(method: string, path: string): Promise<ApiResponse> {
    this.calls.push(path);
    if (method !== 'GET') throw new Error('Reader cannot write to GitHub');
    if (this.hold) await this.hold;
    if (this.failure) throw this.failure;
    const reply = this.routes.get(path);
    if (!reply) throw new Error(`Unexpected conversation fixture route ${path}`);
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  }
  seed(reference: Reference) {
    const root = `/repos/${reference.repo}`;
    const item = reference.number;
    const comments = `${root}/issues/${item}/comments`;
    const inline = `${root}/pulls/${item}/comments`;
    const set = (path: string, body: unknown, headers: Record<string, string> = {}) => this.routes.set(path, { status: 200, body, headers });
    set(`${root}/${reference.kind === 'pr' ? 'pulls' : 'issues'}/${item}`, {
      ...rawMessage(reference, 1, longBody), html_url: `https://github.com/${reference.repo}/${reference.kind === 'pr' ? 'pull' : 'issues'}/${item}`,
    });
    set(`${comments}?per_page=5&page=1`, [rawMessage(reference, 10, 'Old comment')], {
      link: `<https://api.github.com${comments}?per_page=5&page=2>; rel="last"`,
    });
    set(`${comments}?per_page=5&page=2`, [rawMessage(reference, 11, 'Newest comment')]);
    if (reference.kind === 'pr') {
      set(`${root}/pulls/${item}/reviews?per_page=5&page=1`, [
        { ...rawMessage(reference, 20, 'Review body with **real feedback**.'), html_url: `https://github.com/${reference.repo}/pull/${item}#pullrequestreview-20` },
      ]);
      set(`${inline}?per_page=5&page=1`, [
        { ...rawMessage(reference, 100, 'Opening discussion A', true), path: 'src/a.ts', line: 3, pull_request_review_id: 20 },
        { ...rawMessage(reference, 101, 'Opening discussion B', true), path: 'src/b.ts', line: 5, pull_request_review_id: 20 },
      ], { link: `<https://api.github.com${inline}?per_page=5&page=2>; rel="last"` });
      set(`${inline}?per_page=5&page=2`, [
        { ...rawMessage(reference, 102, 'Reply in A', true), path: 'src/a.ts', line: 3, in_reply_to_id: 100, pull_request_review_id: 21 },
        { ...rawMessage(reference, 103, 'Reply in B', true), path: 'src/b.ts', line: 5, in_reply_to_id: 101, pull_request_review_id: 21 },
        { ...rawMessage(reference, 104, 'Second reply in A', true), path: 'src/a.ts', line: 3, in_reply_to_id: 100, pull_request_review_id: 22 },
      ]);
    }
  }
}

// IPC fixture only: actual disk safety and merge rules are exercised by Rust tests.
export function mergeCachedPage(existing: ConversationCache | undefined, page: ConversationPage): ConversationCache {
  const messages = new Map(existing?.messages.map(item => [item.id, item]));
  for (const item of page.messages) {
    const before = messages.get(item.id);
    if (!before || item.updatedAt >= before.updatedAt) messages.set(item.id, item);
  }
  const { messages: _, ...metadata } = page;
  const pages = (existing?.pages ?? []).filter(item => item.stream !== page.stream || item.page !== page.page);
  return conversationCacheSchema.parse({
    reference: page.reference, messages: [...messages.values()], pages: [...pages, metadata],
  });
}
export function cacheKey(reference: Reference) { return conversationKey(reference); }
