import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { Modal } from './App.tsx';
import { matchesRule, placement, validateFilters, viewLabel } from './domain/filtering.ts';
import { ruleSchema, type AppState, type NamedInbox, type Rule } from './types.ts';
import type { WorkspaceView } from './runtime/view.ts';

type Dispatch = WorkspaceView['dispatch'];
const emptyRule = (): Rule => ({ id: crypto.randomUUID(), name: '', enabled: true, criteria: {}, action: { type: 'exclude' } });

function InboxNames({ state, dispatch }: { state: AppState; dispatch: Dispatch }) {
  const [editing, setEditing] = useState<NamedInbox>({ id: crypto.randomUUID(), name: '' });
  return <details className="inbox-settings"><summary>Manage named inboxes</summary>
    <p className="field-help">Deleting an inbox requires editing or deleting its rules first. Notes and threads are never deleted.</p>
    <ul className="rule-list">{state.inboxes.map(inbox => <li key={inbox.id}>
      <span>{inbox.name}</span><div className="button-row">
        <button className="text-button" onClick={() => setEditing(inbox)} aria-label={`Rename ${inbox.name}`}>Rename</button>
        <button className="text-button" onClick={() => {
          if (dispatch({ type: 'delete-inbox', id: inbox.id }, 'Inbox deleted; threads and notes are unchanged.') && editing.id === inbox.id) {
            setEditing({ id: crypto.randomUUID(), name: '' });
          }
        }} aria-label={`Delete inbox ${inbox.name}`}>Delete</button>
      </div>
    </li>)}</ul>
    <form onSubmit={event => {
      event.preventDefault();
      if (dispatch({ type: 'save-inbox', inbox: editing }, 'Inbox updated.')) setEditing({ id: crypto.randomUUID(), name: '' });
    }}>
      <label>Inbox name<input value={editing.name} maxLength={80} required onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <div className="button-row"><button className="secondary" type="submit">{state.inboxes.some(inbox => inbox.id === editing.id) ? 'Save inbox name' : 'Create inbox'}</button>
        {state.inboxes.some(inbox => inbox.id === editing.id) && <button className="text-button" type="button" onClick={() => setEditing({ id: crypto.randomUUID(), name: '' })}>Cancel rename</button>}</div>
    </form>
  </details>;
}

export function Rules({ state, dispatch, close, error }: { state: AppState; dispatch: Dispatch; close: () => void; error: string }) {
  const [draft, setDraft] = useState<Rule>();
  const [preview, setPreview] = useState('');
  const [validationError, setValidationError] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  const parsed = draft ? ruleSchema.safeParse(draft) : undefined;
  const candidate = parsed?.success ? { ...state, rules: state.rules.some(rule => rule.id === parsed.data.id)
    ? state.rules.map(rule => rule.id === parsed.data.id ? parsed.data : rule) : [...state.rules, parsed.data] } : undefined;
  // A changed route, source state or criterion requires a fresh preview before applying.
  const signature = JSON.stringify({ draft, rules: state.rules, inboxes: state.inboxes,
    threads: state.threads.map(({ id, repo, kind, title, archive, terminal, sourceState }) => ({ id, repo, kind, title, archive, terminal, sourceState })) });
  const ready = preview === signature && !!candidate;
  const matches = ready && parsed?.success ? state.threads.filter(thread => matchesRule(parsed.data, thread)) : [];
  function edit(rule: Rule) { setDraft(structuredClone(rule)); setPreview(''); setValidationError(''); }
  return <Modal title="Filtering rules" close={close} initialFocus={first} className="rules-modal">
    <p className="muted">Local organization only. Rules never mark notifications done on GitHub or change Tasks.</p>
    <p className="field-help">First enabled match wins, from top to bottom. Manual Archive and terminal suppression take precedence.</p>
    {(error || validationError) && <p className="inline-error" role="alert">{validationError || error}</p>}
    <button ref={first} className="secondary" onClick={() => edit(emptyRule())}><Plus size={15} />New rule</button>
    {!state.rules.length && <p className="field-help">No saved rules. Unmatched threads stay in Inbox.</p>}
    <ol className="rule-list" aria-label="Rule order">{state.rules.map((rule, index) => <li key={rule.id}>
      <div><strong>{index + 1}. {rule.name}</strong><span className="field-help">{rule.action.type === 'exclude' ? 'Keep out of Inbox'
        : `Route to ${viewLabel(state, `inbox:${rule.action.inboxId}`)}`}</span></div>
      <div className="button-row">
        <label className="checkbox-label"><input type="checkbox" checked={rule.enabled} aria-label={`Enable ${rule.name}`}
          onChange={event => dispatch({ type: 'enable-rule', id: rule.id, enabled: event.target.checked }, 'Rule updated locally.')} />Enabled</label>
        <button className="icon-button" disabled={index === 0} aria-label={`Move ${rule.name} up`} onClick={() => dispatch({ type: 'move-rule', id: rule.id, direction: 'up' })}><ArrowUp size={15} /></button>
        <button className="icon-button" disabled={index === state.rules.length - 1} aria-label={`Move ${rule.name} down`} onClick={() => dispatch({ type: 'move-rule', id: rule.id, direction: 'down' })}><ArrowDown size={15} /></button>
        <button className="text-button" onClick={() => edit(rule)} aria-label={`Edit ${rule.name}`}>Edit</button>
        <button className="text-button" onClick={() => {
          if (dispatch({ type: 'delete-rule', id: rule.id }, 'Rule deleted. Threads follow the remaining rules.') && draft?.id === rule.id) setDraft(undefined);
        }} aria-label={`Delete rule ${rule.name}`}>Delete</button>
      </div>
    </li>)}</ol>
    {draft && <form className="rule-editor" onSubmit={event => {
      event.preventDefault();
      if (!parsed?.success) { setValidationError(parsed?.error.issues.map(issue => issue.message).join(' ') ?? 'Enter a rule.'); return; }
      try { validateFilters(candidate!); } catch (error) {
        setValidationError(error instanceof Error ? error.message : 'Invalid rule destination.'); return;
      }
      setValidationError(''); setPreview(signature);
    }}>
      <h3>{state.rules.some(rule => rule.id === draft.id) ? 'Edit rule' : 'New rule'}</h3>
      <label>Rule name<input autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <p className="field-help">All supplied criteria must match. At least one is required. Text matches are literal and case-insensitive.</p>
      <label>Repository <span className="muted">(optional, owner/repo)</span><input maxLength={201} value={draft.criteria.repo ?? ''} onChange={event =>
        setDraft({ ...draft, criteria: { ...draft.criteria, repo: event.target.value || undefined } })} /></label>
      <label>Thread type<select value={draft.criteria.kind ?? ''} onChange={event => setDraft({ ...draft, criteria: {
        ...draft.criteria, kind: event.target.value === 'pr' ? 'pr' : event.target.value === 'issue' ? 'issue' : undefined,
      } })}><option value="">Any type</option><option value="pr">Pull request</option><option value="issue">Issue</option></select></label>
      <label>Title contains <span className="muted">(optional)</span><input maxLength={200} value={draft.criteria.title ?? ''}
        onChange={event => setDraft({ ...draft, criteria: { ...draft.criteria, title: event.target.value || undefined } })} /></label>
      <label>Action<select value={draft.action.type === 'exclude' ? 'exclude' : draft.action.inboxId}
        onChange={event => setDraft({ ...draft, action: event.target.value === 'exclude' ? { type: 'exclude' } : { type: 'inbox', inboxId: event.target.value } })}>
        <option value="exclude">Keep out of Inbox (in Filtered)</option>
        {state.inboxes.map(inbox => <option key={inbox.id} value={inbox.id}>Route to {inbox.name}</option>)}
      </select></label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />Rule enabled</label>
      <div className="modal-footer">
        <button className="secondary" type="submit">Preview matches</button>
        <button className="primary" type="button" disabled={!ready} onClick={() => {
          if (parsed?.success && dispatch({ type: 'save-rule', rule: parsed.data }, 'Rule updated. No GitHub write was sent.')) {
            setDraft(undefined); setPreview('');
          }
        }}>Save rule</button>
        <button className="text-button" type="button" onClick={() => setDraft(undefined)}>Cancel edit</button>
      </div>
      {preview && !ready && <p className="field-help" role="status">The rule or saved threads changed. Preview again before saving.</p>}
      {ready && candidate && <section className="rule-preview" aria-label="Rule preview" aria-live="polite">
        <h3>{matches.length} matching {matches.length === 1 ? 'thread' : 'threads'}</h3>
        <p className="field-help">Saved threads only; preview does not fetch GitHub. {draft.enabled ? '' : 'This rule is disabled and will not change placement.'}</p>
        <ul className="rule-list">{matches.map(thread => {
          const result = placement(candidate, thread);
          return <li key={thread.id}><div><strong>{thread.title}</strong><p>{thread.repo} #{thread.number}</p>
            <p>Effective location: {viewLabel(candidate, result.view)}. {result.reason}</p>
            <p className="field-help">Enabled matches in order: {result.matches.map(rule => rule.name).join(', ') || 'None'}.</p></div></li>;
        })}</ul>
      </section>}
    </form>}
    <InboxNames state={state} dispatch={dispatch} />
    <footer className="modal-footer"><button className="secondary" onClick={close}>Back to workspace</button></footer>
  </Modal>;
}
