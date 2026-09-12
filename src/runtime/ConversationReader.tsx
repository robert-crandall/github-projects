import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { conversationKey, type ConversationMessage, type Reference } from '../../service/src/schema.ts';
import { webUrlSchema } from '../platform/native.ts';
import type { Platform } from './desktop-workspace.ts';
import { conversationStreams, type ConversationWorkspace } from './conversation-workspace.ts';

const names = { description: 'Description', comments: 'Comments', reviews: 'Reviews', inline: 'Inline discussions' };
export function groupMessages(messages: ConversationMessage[]): { id: string; messages: ConversationMessage[]; missingRoot: boolean }[] {
  const byId = new Map(messages.map(message => [message.id, message]));
  const groups = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    let root = message;
    const seen = new Set([root.id]);
    while (root.replyTo && byId.has(root.replyTo) && !seen.has(root.replyTo)) {
      root = byId.get(root.replyTo)!;
      seen.add(root.id);
    }
    const key = root.replyTo && !seen.has(root.replyTo) ? root.replyTo : root.id;
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  return [...groups].map(([id, items]) => ({
    id, missingRoot: !byId.has(id),
    messages: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  })).sort((a, b) => {
    const first = a.messages[0]!, second = b.messages[0]!;
    if (first.kind === 'description') return -1;
    if (second.kind === 'description') return 1;
    return first.createdAt.localeCompare(second.createdAt) || a.id.localeCompare(b.id);
  });
}

export const SafeMarkdown = memo(function SafeMarkdown({ body, open }: { body: string; open: (url: string) => void }) {
  return <div className="message-markdown">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={url => webUrlSchema.safeParse(url).success ? url : ''}
      components={{
        a: ({ href, children }) => href
          ? <a href={href} onClick={event => { event.preventDefault(); open(href); }}>{children}</a>
          : <span>{children} <small>(unsafe or relative link omitted)</small></span>,
        img: ({ src, alt }) => <span className="blocked-embed">Image not loaded: {alt || 'image'}{typeof src === 'string' && src && <> · <a href={src} onClick={event => { event.preventDefault(); open(src); }}>Open image externally</a></>}</span>,
      }}>{body || '_No message body._'}</Markdown>
    {/<[A-Za-z!/?]/.test(body) && <p className="field-help">Raw HTML is not rendered. Open the source to inspect HTML-only content.</p>}
  </div>;
});

export const ConversationReader = memo(function ConversationReader({ reference, controller, platform, refreshing, timeZone }: {
  reference: Reference; controller: ConversationWorkspace; platform: Platform; refreshing: boolean; timeZone: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [confirmReset, setConfirmReset] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [pagesOpen, setPagesOpen] = useState(false);
  const key = conversationKey(reference);
  useEffect(() => { void controller.select(reference); }, [controller, key]);
  const matches = !!state.reference && conversationKey(state.reference) === key;
  const cache = matches ? state.cache : null;
  const latestAttempt = cache?.pages.map(page => page.fetchedAt).sort().at(-1);
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const date = (value: string) => format.format(new Date(value));
  const disabled = refreshing || state.busy || state.reading || !matches;
  const open = useCallback((url: string) => {
    setLinkError('');
    void platform.launchWebUrl(url).catch(error => setLinkError(error instanceof Error ? error.message : 'The link could not be opened.'));
  }, [platform]);
  return <section className="conversation" aria-label="Conversation">
    <div className="section-heading"><h3>Conversation</h3><span>{cache ? `${cache.messages.length} saved messages` : 'Not cached'}</span></div>
    <p className="field-help">{latestAttempt ? <>Latest page attempt: <time dateTime={latestAttempt}>{date(latestAttempt)} {timeZone}</time>. </> : 'Read saved messages offline. '}
      Refresh checks newest pages only. Reload a saved page to check older edits.</p>
    {(state.reading || !matches) && <p role="status">Reading cached conversation...</p>}
    {!cache && <p className="notice-inline">No conversation is cached yet. Load it explicitly to read here; selecting a thread never contacts GitHub.</p>}
    <div className="button-row conversation-actions">
      <button className="secondary" disabled={disabled} onClick={() => void controller.load()}>{state.busy ? 'Loading conversation...' : cache ? 'Reload newest messages' : 'Load conversation'}</button>
      <button className="text-button" disabled={disabled} onClick={() => setConfirmReset(true)}>Discard conversation cache</button>
    </div>
    {matches && state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {linkError && <p className="inline-error" role="alert">{linkError}</p>}
    {confirmReset && <div className="cache-confirm" role="group" aria-label="Confirm cache discard">
      <p>Discard all saved conversations on this Mac? Notes, Tasks and notifications are untouched. The native app preserves the old cache file for recovery. No network request follows.</p>
      <div className="button-row"><button className="secondary" disabled={disabled} onClick={() => { setConfirmReset(false); void controller.reset(); }}>Discard cached conversations</button><button className="text-button" onClick={() => setConfirmReset(false)}>Cancel</button></div>
    </div>}
    {cache && <>
      <details className="conversation-pages" open={pagesOpen} onToggle={event => setPagesOpen(event.currentTarget.open)}><summary>Pages, freshness and older history</summary>
        {conversationStreams(reference).map(stream => {
          const pages = cache.pages.filter(page => page.stream === stream).sort((a, b) => a.page - b.page);
          const successful = pages.filter(page => !page.error);
          const oldest = successful[0];
          return <section key={stream} aria-label={`${names[stream]} pages`}>
            <h4>{names[stream]}</h4>
            {!pages.length && <p className="field-help">Not loaded. <button className="text-button" disabled={disabled} onClick={() => void controller.load(stream)}>Load {names[stream].toLowerCase()}</button></p>}
            {pages.map(page => <div key={page.page} className="conversation-page">
              <span>Page {page.page} · <time dateTime={page.fetchedAt}>{date(page.fetchedAt)} {timeZone}</time>{page.error ? ' · partial / unavailable' : ' · saved'}</span>
              <button className="text-button" disabled={disabled} onClick={() => void controller.load(stream, page.page)}>Reload {names[stream].toLowerCase()} page {page.page}</button>
              {page.error && <p className="inline-error">{page.error.message} Previously cached bodies may be out of date.</p>}
            </div>)}
            {stream !== 'description' && oldest && (oldest.page > 1
              ? <button className="secondary" disabled={disabled} onClick={() => void controller.load(stream, oldest.page - 1)}>Load older {names[stream].toLowerCase()}</button>
              : <p className="field-help">Oldest page reached. Saved pages are not a live mirror; deleted messages may remain cached.</p>)}
          </section>;
        })}
      </details>
      {cache.pages.some(page => page.error) && <p className="notice-inline warning">Some pages are partial or unavailable. Check Pages, freshness and older history for details and retries.</p>}
      {cache.pages.some(page => page.page > 1) && <p className="field-help">Older history may not be loaded. Loading it does not create new Inbox activity.</p>}
      <div className="conversation-messages">
        {groupMessages(cache.messages).map(group => <section className={group.messages[0]?.kind === 'inline' ? 'review-discussion' : 'message-group'} key={group.id} aria-label={group.messages[0]?.kind === 'inline' ? 'Inline discussion' : undefined}>
          {group.messages[0]?.kind === 'inline' && <h4>{group.messages[0].path ?? 'Inline discussion'}{group.messages[0].line ? `:${group.messages[0].line}` : ''}</h4>}
          {group.missingRoot && <p className="notice-inline warning">Earlier discussion context is not cached. Load older inline discussions to find the opening comment.</p>}
          {group.messages.map(item => <article key={item.id} data-reader-anchor={item.id} className="conversation-message" aria-label={`${names[item.kind]} by ${item.author ?? 'deleted user'}`}>
            <header><strong>{item.author ?? 'Deleted user'}</strong><span>{item.replyTo ? 'Reply' : names[item.kind]}</span>
              <a href={item.url} onClick={event => { event.preventDefault(); open(item.url); }}><time dateTime={item.createdAt} title={`${item.createdAt} (${timeZone})`}>{date(item.createdAt)}</time></a>
            </header>
            {item.updatedAt !== item.createdAt && <p className="message-edited">Edited <time dateTime={item.updatedAt}>{date(item.updatedAt)}</time></p>}
            <SafeMarkdown body={item.body} open={open} />
          </article>)}
        </section>)}
      </div>
    </>}
    <p className="field-help cache-limits">Cache limits: 4 MiB per issue or PR (repository + type + number), 64 MiB total. Pages hold at most 5 messages within 1 MiB. Limits never clip bodies; unavailable pages stay explicit. Discard only the cache to make room.</p>
  </section>;
}, (before, after) => conversationKey(before.reference) === conversationKey(after.reference)
  && before.controller === after.controller && before.platform === after.platform
  && before.refreshing === after.refreshing && before.timeZone === after.timeZone);
