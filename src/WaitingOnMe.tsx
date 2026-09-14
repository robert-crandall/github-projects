import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { Modal, stamp } from './App.tsx';
import type { WaitingDigest, WaitingItem } from '../service/src/schema.ts';
import {
  waitingAge, waitingCaptures, waitingCoverage, waitingDate, waitingIdentity, waitingKey, waitingLabels,
  waitingMarkdown, waitingReasons, waitingSummary,
} from './domain/waiting.ts';
import type { WorkspaceView } from './runtime/view.ts';

function sampleDigest(now: string): WaitingDigest {
  const item = (number: number, title: string, days: number, kind: 'pr' | 'issue' = 'pr', reasons: WaitingItem['reasons'] = []): WaitingItem => ({
    reference: { repo: 'sample/notification-client', kind, number }, title, author: 'sample-author',
    updatedAt: new Date(Date.parse(now) - days * 86_400_000).toISOString(), reasons,
  });
  return { fetchedAt: now, viewer: 'sample-viewer', limitedQueries: [], buckets: [
    { id: 'direct-review', items: [item(42, 'Keep thread notes when navigating', 7)] },
    { id: 'team-review', items: [item(43, 'Update provider resource validation', 4)] },
    { id: 'ready-to-merge', items: [item(44, 'Preserve the selected conversation', 5)] },
    { id: 'needs-fix', items: [item(45, 'Load older review comments', 3, 'pr', ['changes-requested', 'ci'])] },
    { id: 'mentioned', items: [item(46, 'Clarify the retry behavior', 1)] },
    { id: 'reviewed', items: [item(47, 'Show conversation freshness', 1)] },
    { id: 'assigned', items: [item(48, 'Make the inbox keyboard-accessible', 14, 'issue')] },
  ] };
}

export function WaitingOnMe({ open, close, workspace }: {
  open: boolean; close: () => void; workspace: WorkspaceView;
}) {
  const { desktop, state: { clock: now, timeZone } } = workspace;
  const generate = useRef<HTMLButtonElement>(null);
  const [sample, setSample] = useState<WaitingDigest>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const [addedCount, setAddedCount] = useState(0);
  const [captureFailed, setCaptureFailed] = useState(false);
  const capturedSelection = useRef<Set<string> | null>(null);
  const status = desktop?.waiting;
  const result = desktop ? status?.result : sample;
  const captures = result ? waitingCaptures(result, checked) : [];
  useEffect(() => { setChecked(new Set()); setFeedback(''); setActionError(''); }, [result]);
  if (!open) return null;

  function addChecked() {
    if (!captures.length || status?.running || capturedSelection.current === checked) return;
    setActionError(''); setFeedback('');
    if (!workspace.dispatch({ type: 'capture-tasks', tasks: captures })) {
      setCaptureFailed(true);
      return;
    }
    capturedSelection.current = checked;
    setCaptureFailed(false);
    setAddedCount(captures.length);
    setChecked(new Set());
  }

  async function copy() {
    if (!result) return;
    setActionError(''); setFeedback('');
    try {
      await navigator.clipboard.writeText(waitingMarkdown(result, timeZone, checked));
      setFeedback('Markdown copied.');
    } catch {
      setActionError('The clipboard is unavailable. Select the report text to copy it manually.');
    }
  }
  async function openSource(item: WaitingItem) {
    setActionError(''); setFeedback('');
    if (!desktop) { setFeedback('Synthetic example only. No browser was opened.'); return; }
    try {
      await desktop.openWaiting(item.reference);
      setFeedback(`Requested browser launch for ${waitingIdentity(item)}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The browser could not be opened. No GitHub change was made.');
    }
  }
  return <Modal title="Waiting on me" close={close} className="waiting-modal" initialFocus={generate}>
    {!desktop && <p className="simulation-tag">Prototype - synthetic digest, no GitHub requests</p>}
    <p className="muted">{result ? 'Fixed rules, no AI. GitHub stays unchanged; adding Tasks is local.'
      : `A read-only checklist across non-archived GitHub repositories, not just your Inbox. Fixed rules, no AI. Nothing runs until you choose ${desktop ? 'Generate digest' : 'Generate sample'}.`}</p>
    <div className="button-row">
      <button ref={generate} className="primary" disabled={status?.running} aria-busy={status?.running} onClick={() => {
        setActionError(''); setFeedback('');
        if (desktop) desktop.generateWaiting();
        else setSample(sampleDigest(now));
      }}><RefreshCw size={15} />{status?.running ? 'Generating...' : desktop ? result ? 'Regenerate digest' : 'Generate digest' : 'Generate sample'}</button>
      {result && <button className="secondary" onClick={() => void copy()}><Copy size={15} />Copy Markdown</button>}
    </div>
    {status?.running && <p className="notice-inline" role="status">Reading GitHub searches and authored PR checks. {result ? 'The previous digest stays below until this finishes.' : 'No GitHub changes will be made.'}</p>}
    {status?.error && <p className="inline-error" role="alert">Digest failed. {status.error} {result ? 'The previous digest is unchanged.' : 'No digest was produced.'} Generate again to retry.</p>}
    {actionError && <p className="inline-error" role="alert">{actionError}</p>}
    {feedback && <p className="notice-inline" role="status">{feedback}</p>}
    {result ? <section className="waiting-report" aria-label="Waiting on me digest">
      <h3>Waiting on me - {waitingDate(result, timeZone)}</h3>
      <p className="field-help">Generated {stamp(result.fetchedAt, timeZone, true)} for {result.viewer}. This snapshot does not refresh itself.</p>
      <p className="waiting-summary">{waitingSummary(result, true)}</p>
      {waitingCoverage(result) && <p className="notice-inline warning">{waitingCoverage(result)}</p>}
      {!result.buckets.length ? <p className="waiting-empty">{result.limitedQueries.length
        ? 'No waiting items found in the returned results.' : 'Nothing is waiting on you right now.'}</p> : <>
        <p className="field-help">Oldest updates first in each group. Check items, then use Add checked items to Tasks below. Checking alone changes nothing; checkmarks reset when you regenerate or quit.</p>
        {result.buckets.map(bucket => <section className="waiting-bucket" key={bucket.id} aria-label={waitingLabels[bucket.id].title}>
          <h4>{waitingLabels[bucket.id].title} <span>({bucket.items.length})</span></h4>
          <p className="field-help">{waitingLabels[bucket.id].action}</p>
          <ul className="waiting-list">{bucket.items.map(item => {
            const key = waitingKey(item);
            return <li key={key} className="waiting-item">
              <input type="checkbox" aria-label={`Checked locally: ${waitingIdentity(item)}`} checked={checked.has(key)} onChange={event => {
                const next = new Set(checked);
                if (event.target.checked) next.add(key); else next.delete(key);
                setChecked(next); setFeedback('');
              }} />
              <div>
                <span className="waiting-title">{item.title}</span>
                <span className="waiting-meta">{waitingIdentity(item)} - {item.author ? `@${item.author}` : 'author unavailable'}, {waitingAge(item, result.fetchedAt)}d</span>
                {item.reasons.length > 0 && <span className="waiting-reasons">Fix: {waitingReasons(item)}</span>}
                <button className="text-button" aria-label={`Open ${waitingIdentity(item)} on GitHub`} onClick={() => void openSource(item)}>
                  <ExternalLink size={13} />Open on GitHub
                </button>
              </div>
            </li>;
          })}</ul>
        </section>)}
      </>}
    </section> : <p className="field-help">Direct and team reviews stay separate. The digest also checks your PRs, recent mentions, reviewed PRs, and assigned issues. Up to 50 results per search.</p>}
    <footer className="modal-footer waiting-footer">
      <div className="button-row">
        <button className="secondary" onClick={close}>Back to workspace</button>
        {addedCount > 0 && <button className="secondary" onClick={() => {
          if (workspace.dispatch({ type: 'view', view: 'tasks' })) close();
        }}>Open Tasks</button>}
      </div>
      {!!result?.buckets.length && <button className="primary" disabled={!captures.length || status?.running} onClick={addChecked}>
        <Plus size={15} />Add checked items to Tasks{captures.length > 0 ? ` (${captures.length})` : ''}
      </button>}
      {captureFailed && <p className="inline-error" role="alert">{workspace.operationError || 'Tasks could not be added. Your selection is unchanged; retry explicitly.'}</p>}
      {addedCount > 0 && <div className="waiting-task-status">
        <p role="status">{addedCount} {addedCount === 1 ? 'task' : 'tasks'} added here.
          {workspace.storageError ? ' Not saved yet.' : desktop?.saving ? ' Saving...' : ' Saved locally.'}</p>
        {workspace.storageError && <p className="inline-error" role="alert">{workspace.storageError}
          <button className="text-button" onClick={() => workspace.retryStorage()}>Retry storage</button>
        </p>}
      </div>}
    </footer>
  </Modal>;
}
