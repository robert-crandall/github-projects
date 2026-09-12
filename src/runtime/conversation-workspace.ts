import {
  conversationKey, type ConversationCache, type ConversationInput, type ConversationPage, type Reference,
} from '../../service/src/schema.ts';
import type { Platform } from './desktop-workspace.ts';
import { ServiceClient } from '../platform/service.ts';

export type ConversationStatus = {
  reference: Reference | null; cache: ConversationCache | null;
  reading: boolean; busy: boolean; error: string;
};
type Prepared = { generation: number; cache: ConversationCache | null; error: string };
export const conversationStreams = (reference: Reference): ConversationInput['stream'][] =>
  reference.kind === 'pr' ? ['description', 'comments', 'reviews', 'inline'] : ['description', 'comments'];
const message = (error: unknown) => error instanceof Error ? error.message : 'Conversation could not load. Saved messages and private notes are unchanged.';

export class ConversationWorkspace {
  private status: ConversationStatus = { reference: null, cache: null, reading: false, busy: false, error: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  constructor(private readonly platform: Platform, private readonly client: ServiceClient) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.status;
  private publish(patch: Partial<ConversationStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
  async select(reference: Reference | null): Promise<void> {
    if (reference && this.status.reference && conversationKey(reference) === conversationKey(this.status.reference)) return;
    const generation = ++this.generation;
    this.publish({ reference, cache: null, reading: !!reference, error: '' });
    if (!reference) return;
    try {
      const cache = await this.platform.conversationRead(reference);
      if (cache && conversationKey(cache.reference) !== conversationKey(reference)) throw new Error('The cached conversation does not match this source.');
      if (generation === this.generation) this.publish({ cache });
    } catch (error) {
      if (generation === this.generation) this.publish({ error: message(error) });
    } finally {
      if (generation === this.generation) this.publish({ reading: false });
    }
  }
  private async collect(inputs: ConversationInput[]): Promise<Prepared> {
    const generation = this.generation;
    let cache = this.status.cache;
    const errors: string[] = [];
    for (const input of inputs) {
      try {
        const page = await this.client.call('github.conversation', input);
        if (conversationKey(page.reference) !== conversationKey(input.reference) || page.stream !== input.stream
          || (input.page !== null && page.page !== input.page)) throw new Error('The conversation response does not match the requested source page.');
        if (page.error) errors.push(`${input.stream}: ${page.error.message}`);
        cache = await this.platform.conversationMerge(page);
        if (conversationKey(cache.reference) !== conversationKey(input.reference)) throw new Error('The saved conversation does not match this source.');
      } catch (error) {
        errors.push(`${input.stream}: ${message(error)}`);
        // Persist failed attempts too, so offline pages do not look freshly verified.
        const prior = cache?.pages.filter(page => page.stream === input.stream).sort((a, b) => b.page - a.page)[0];
        const page = input.page ?? prior?.newestPage ?? 1;
        const failed: ConversationPage = {
          reference: input.reference, stream: input.stream, page, newestPage: Math.max(page, prior?.newestPage ?? 1),
          olderPage: page > 1 ? page - 1 : null, fetchedAt: new Date().toISOString(), messages: [],
          error: { code: 'unavailable', message: 'This page could not be refreshed. Previously saved messages may be out of date. Retry explicitly.', retryable: true },
        };
        try { cache = await this.platform.conversationMerge(failed); }
        catch (saveError) { errors.push(`Cache: ${message(saveError)}`); }
      }
    }
    return { generation, cache, error: [...new Set(errors)].join(' ') };
  }
  async load(stream?: ConversationInput['stream'], page: number | null = null): Promise<void> {
    const reference = this.status.reference;
    if (!reference || this.status.reading || this.status.busy) return;
    this.publish({ busy: true, error: '' });
    const result = await this.collect((stream ? [stream] : conversationStreams(reference)).map(stream => ({ reference, stream, page })));
    this.commit(result);
  }
  async prepareRefresh(): Promise<Prepared | null> {
    const { reference, cache, reading, busy } = this.status;
    if (!reference || !cache || reading) return null;
    if (busy) {
      this.publish({ error: 'Conversation loading is already in progress. This Refresh updates notifications only.' });
      return null;
    }
    this.publish({ busy: true, error: '' });
    return this.collect(conversationStreams(reference).map(stream => ({ reference, stream, page: null })));
  }
  commit(result: Prepared | null): void {
    if (!result) return;
    if (result.generation === this.generation) this.publish({ cache: result.cache, error: result.error, busy: false });
    else this.publish({ busy: false });
  }
  async reset(): Promise<void> {
    if (this.status.busy || this.status.reading) throw new Error('Wait for conversation loading before discarding the cache.');
    this.publish({ busy: true });
    try {
      await this.platform.conversationReset();
      // Discard empties every source, including reads started by navigation while reset was pending.
      ++this.generation;
      this.publish({ cache: null, reading: false, error: '' });
    } catch (error) { this.publish({ error: message(error) }); }
    finally { this.publish({ busy: false }); }
  }
}
