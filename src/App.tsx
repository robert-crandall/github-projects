import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, Circle, ExternalLink,
  GitPullRequest, Github, Inbox, MessageSquare, Plus, RefreshCw, RotateCcw, Settings2, Sparkles, X,
} from 'lucide-react';
import { earlierThreads, getRow, getRows } from './domain/engine.ts';
import { threadIdSchema } from '../service/src/schema.ts';
import type { AppState, LocalHistory, Row, Scenario, Task, View } from './types.ts';
import { useWorkspace } from './useWorkspace.ts';
import type { Destination, WorkspaceView } from './runtime/view.ts';

type Dispatch = WorkspaceView['dispatch'];
const viewLabels: Record<View, string> = { inbox: 'Inbox', tasks: 'Tasks' };
export function stamp(value: string, zone: string, date = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: 'numeric', minute: '2-digit', ...(date ? { month: 'short', day: 'numeric' } as const : {}),
  }).format(new Date(value));
}
function ItemIcon({ row, size = 18 }: { row: Row; size?: number }) {
  if (row.kind === 'review') return <GitPullRequest size={size} />;
  if (row.kind === 'update') return <MessageSquare size={size} />;
  return row.task?.status === 'done' ? <CheckCheck size={size} /> : <Circle size={size} />;
}

export function Modal({ title, children, close, className = '', initialFocus }: {
  title: string; children: ReactNode; close: () => void; className?: string; initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    initialFocus?.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={19} /></button></header>
    {children}
  </dialog>;
}

function Destinations({ row, open }: { row: Row; open: (destination: Destination) => void }) {
  if (!row.thread) return null;
  return <div className="destinations">
    <button className="text-button" onClick={() => open({ row, kind: 'github' })}><ExternalLink size={13} />Open on GitHub</button>
    <button className="text-button" onClick={() => open({ row, kind: 'copilot' })}><Sparkles size={13} />{row.thread.kind === 'pr' ? 'Review in Copilot' : 'Open in Copilot'}</button>
  </div>;
}

function WorkRow({ row, selected, select, open }: {
  row: Row; selected: boolean; select: () => void; open: (destination: Destination) => void;
}) {
  return <li className={`work-row ${selected ? 'selected' : ''}`} data-row-key={row.key}>
    <span className={`row-icon ${row.kind}`}><ItemIcon row={row} /></span>
    <div className="row-content">
      <button className="row-select" onClick={select} aria-current={selected ? 'true' : undefined}>
        <span className="row-title">{row.title}</span>
        <span className="row-meta">{row.thread ? `${row.thread.repo} #${row.thread.number}` : row.task?.status === 'done' ? 'Done' : 'Your task'}</span>
        <span className="row-reason">{row.reason}</span>
      </button>
      <Destinations row={row} open={open} />
    </div>
  </li>;
}

function Capture({ state, dispatch, close }: { state: AppState; dispatch: Dispatch; close: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  return <Modal title="Capture a task" close={close} initialFocus={input}>
    <p className="muted">Saved directly to Tasks. Links stay as text; nothing is sent to GitHub or Copilot.</p>
    <form onSubmit={event => { event.preventDefault(); if (dispatch({ type: 'capture' }, 'Task saved.')) close(); }}>
      <label htmlFor="capture-text">What do you want to remember?</label>
      <textarea ref={input} id="capture-text" rows={5} value={state.draft} onChange={event => dispatch({ type: 'draft', text: event.target.value })} required />
      <footer className="modal-footer"><span className="muted">No project or priority required.</span><button type="submit" className="primary"><Plus size={16} />Save task</button></footer>
    </form>
  </Modal>;
}

function Handoff({ destination, state, dispatch, close }: { destination: Destination; state: AppState; dispatch: Dispatch; close: () => void }) {
  const [phase, setPhase] = useState<'ready' | 'requested' | 'error'>('ready');
  const [fail, setFail] = useState(state.failures.external);
  const { row, kind, action } = destination;
  const thread = row.thread!;
  const isWrite = kind === 'notification';
  const label = isWrite ? action === 'done' ? 'Mark notification done on GitHub' : 'Unsubscribe on GitHub'
    : kind === 'github' ? 'Open on GitHub' : thread.kind === 'pr' ? 'Review in Copilot' : 'Open in Copilot';
  return <Modal title={label} close={close}>
    <span className="simulation-tag"><Circle size={11} />Prototype simulation</span>
    <p className="dialog-item">{row.title}</p>
    <p className="muted">{thread.repo} #{thread.number}</p>
    {phase === 'requested' ? <div className="outcome"><CheckCheck size={26} /><h3>{isWrite ? 'Simulated GitHub change recorded' : 'Launch requested, not completed'}</h3><p>{isWrite ? 'Your notes and tasks are unchanged.' : 'No browser or Copilot session was opened. Your notes and tasks are unchanged.'}</p></div> : <>
      <p>{kind === 'copilot' ? thread.kind === 'pr'
        ? 'The desktop app asks Copilot App to open an interactive PR session with the prompt “Review this PR.” Copilot App asks for confirmation before creating it.'
        : 'The desktop app opens this issue in Copilot App. The repository may need to be added there first.'
        : kind === 'github' ? 'The desktop app opens this source in your browser. This sample stays inside the prototype.'
        : action === 'done' ? 'Acknowledge this notification. Your notes remain under Earlier threads; Tasks are unchanged.'
        : 'Stop ordinary conversation notifications. Mentions and new review requests can notify you again. Your notes remain available.'}</p>
      <div className="simulation-note"><strong>No external action</strong><span>No real URLs, messages, or private notes leave the prototype.</span></div>
      <label className="checkbox-label"><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />{isWrite ? 'Simulate a failed GitHub write' : 'Simulate an unavailable app'}</label>
      {phase === 'error' && <p className="inline-error" role="alert">{isWrite ? 'The simulated write failed. Nothing was acknowledged or unsubscribed.' : 'The simulated app could not be opened.'} Turn off the failure to retry.</p>}
    </>}
    <footer className="modal-footer">
      <button className="secondary" onClick={close}>{phase === 'requested' ? 'Return to workspace' : 'Cancel'}</button>
      {phase !== 'requested' && <button className="primary" onClick={() => {
        if (fail) { setPhase('error'); return; }
        if (isWrite) {
          dispatch({ type: 'configure', externalFailure: false });
          if (!dispatch({ type: 'notification', threadId: thread.id, action: action! }, 'Simulated GitHub change recorded.')) { setPhase('error'); return; }
        }
        setPhase('requested');
      }}>{phase === 'error' ? 'Retry simulation' : isWrite ? 'Simulate success' : 'Simulate launch'}<ArrowRight size={15} /></button>}
    </footer>
  </Modal>;
}

const scenarios: { id: Scenario; title: string }[] = [
  { id: 'new-review', title: 'A new review arrives' }, { id: 'merge-queue', title: 'PR enters the merge queue' },
  { id: 're-request', title: 'Review is requested again' }, { id: 'sticky-mention', title: 'Old mention, ordinary update' },
  { id: 'comment', title: 'An ordinary comment' }, { id: 'mention', title: 'A new mention' },
  { id: 'closed', title: 'The source closes' }, { id: 'read', title: 'Read on GitHub' },
  { id: 'acknowledged', title: 'Acknowledged on GitHub' }, { id: 'empty', title: 'No outstanding notifications' },
];
function Demo({ state, dispatch, close }: { state: AppState; dispatch: Dispatch; close: () => void }) {
  const [scenario, setScenario] = useState<Scenario>('comment');
  return <Modal title="Explore the prototype" close={close} className="demo-modal">
    <p className="muted">All people, repositories, and activity here are synthetic.</p>
    <section className="demo-section"><h3>Stage GitHub activity</h3><p>Applies to the selected thread where possible. Nothing arrives until Refresh.</p>
      <label htmlFor="demo-scenario">Activity scenario</label>
      <select id="demo-scenario" value={scenario} onChange={event => setScenario(event.target.value as Scenario)}>
        {scenarios.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button className="secondary" onClick={() => dispatch({ type: 'stage', scenario }, 'Activity staged. Click Refresh to bring it in.')}><Plus size={15} />Stage activity</button>
      <span className="muted staged-count" role="status">{state.staged.length} staged</span>
    </section>
    <section className="demo-section"><h3>Try failure and recovery</h3>
      <label>Next refresh<select value={state.failures.refresh} onChange={event => dispatch({ type: 'configure', refreshFailure: event.target.value as AppState['failures']['refresh'] })}><option value="none">Complete</option><option value="partial">Partial results</option><option value="error">Offline / failed</option></select></label>
      <label className="checkbox-label"><input type="checkbox" checked={state.failures.storage} onChange={event => dispatch({ type: 'configure', storageFailure: event.target.checked })} />Local storage fails</label>
      <label className="checkbox-label"><input type="checkbox" checked={state.failures.external} onChange={event => dispatch({ type: 'configure', externalFailure: event.target.checked })} />External handoff fails</label>
    </section>
    <footer className="modal-footer"><button className="text-button" onClick={() => dispatch({ type: 'reset' }, 'Sample activity reset. Your notes and tasks are retained.')}><RotateCcw size={15} />Reset samples, keep notes and tasks</button><button className="primary" onClick={close}>Back to workspace</button></footer>
  </Modal>;
}

function History({ history, state }: { history: LocalHistory; state: AppState }) {
  return <details className="sources"><summary>Preserved action history<ChevronDown size={14} /></summary>
    <p className="muted">Original status: {history.status}. {history.routine || history.remindAt ? 'Reminders retired; this record cannot schedule notifications.' : ''}</p>
    {history.project && <p>Project: {history.project}</p>}
    {history.nextStep && <p>Next step: {history.nextStep}</p>}
    {history.captures.map((text, index) => <blockquote key={index}>{text}</blockquote>)}
    {history.steps.map(step => <p key={step.id}>{step.title}{step.doneAt ? ` · ${stamp(step.doneAt, state.timeZone, true)}` : ' · not recorded'}</p>)}
    <details className="sources"><summary>Original record<ChevronDown size={14} /></summary><pre className="history-record">{JSON.stringify(history, null, 2)}</pre></details>
  </details>;
}

function TaskText({ task, dispatch }: { task: Task; dispatch: Dispatch }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.title);
  return editing ? <form className="edit-form" onSubmit={event => {
    event.preventDefault();
    if (dispatch({ type: 'edit', key: `a:${task.id}`, title: text }, 'Task text saved.')) setEditing(false);
  }}><label>Task text<textarea autoFocus value={text} onChange={event => setText(event.target.value)} required /></label>
    <button type="submit" className="secondary">Save text</button></form>
    : <button className="text-button" onClick={() => { setText(task.title); setEditing(true); }}>Edit text</button>;
}

function Detail({ row, state, dispatch, open, back, unsaved }: {
  row: Row; state: AppState; dispatch: Dispatch; open: (destination: Destination) => void; back: () => void; unsaved: boolean;
}) {
  const task = row.task;
  const thread = row.thread;
  const notes = thread ? state.notes.filter(note => note.threadId === thread.id) : [];
  const canWrite = state.runtime !== 'desktop' || (thread?.source === 'github' && threadIdSchema.safeParse(thread.id).success);
  return <article className="detail" aria-label="Selected item">
    <header className="detail-toolbar">
      <button className="text-button back-control" onClick={back}><ArrowLeft size={15} />Back to list</button>
      <span className="detail-location">{thread ? <><Github size={14} />{thread.repo}<span className="separator">/</span>#{thread.number}</> : <><Circle size={14} />Task</>}</span>
      <span className={`state-tag ${task?.status === 'done' ? 'complete' : ''}`}>{thread ? thread.state === 'queued' ? 'In merge queue' : thread.state === 'closed' ? 'Source closed' : 'Open' : task?.status === 'done' ? 'Done' : 'Open'}</span>
    </header>
    <div className="detail-body">
      <h2 className="preserve-text">{row.title}</h2>
      <Destinations row={row} open={open} />
      {task && <>
        <div className="detail-actions task-controls"><label className="checkbox-label"><input type="checkbox" checked={task.status === 'done'}
          onChange={event => dispatch({ type: event.target.checked ? 'done' : 'restore', key: row.key }, event.target.checked ? 'Task done.' : 'Task reopened.')} />Done</label><TaskText key={task.id} task={task} dispatch={dispatch} /></div>
        <section className="notes-section"><div className="section-heading"><label htmlFor="task-notes">Task notes</label><span>{unsaved ? 'Not saved yet' : 'Saved locally'}</span></div>
          <textarea id="task-notes" rows={6} value={task.notes} onChange={event => dispatch({ type: 'edit', key: row.key, notes: event.target.value })} />
        </section>
        {task.threadId && <p className="field-help">Notes from the linked action are kept with its thread.
          <button className="text-button" onClick={() => {
            dispatch({ type: 'view', view: 'inbox' });
            dispatch({ type: 'select', key: `t:${task.threadId}` });
          }}>Open thread notes<ArrowRight size={14} /></button></p>}
        {task.history && <History history={task.history} state={state} />}
      </>}
      {thread && <>
        <section className="evidence" aria-label="Saved source summary"><h3>Saved source summary</h3>
          {thread.events.slice(-3).map(event => <div className="source-event" key={event.id}><p className="preserve-text">{event.summary}</p><small>{event.actor} · {stamp(event.at, state.timeZone, true)}</small></div>)}
          {!thread.events.length && <p>No source activity saved yet. Open on GitHub for the conversation.</p>}
          <p className="field-help">Bounded source summaries, not the full conversation.</p>
        </section>
        <section className="notes-section" aria-label="Private thread notes">
          {(notes.length ? notes : [undefined]).map((note, index) => <div className="thread-note" key={index}>
            <div className="section-heading"><label htmlFor={`thread-note-${index}`}>{index === 0 ? 'Thread notes' : `Thread note ${index + 1}`}</label><span>{unsaved ? 'Not saved yet' : 'Private · saved locally'}</span></div>
            {note?.sourceTitle !== undefined && <p className="note-source preserve-text">{note.sourceTitle}</p>}
            <textarea id={`thread-note-${index}`} rows={5} value={note?.text ?? ''} onChange={event => dispatch({ type: 'note', threadId: thread.id, noteId: note?.id, text: event.target.value })} />
            {note?.history && <History history={note.history} state={state} />}
          </div>)}
          <button className="text-button" onClick={() => dispatch({ type: 'note', threadId: thread.id, text: '' })}><Plus size={14} />Add note</button>
        </section>
        <section className="thread-controls"><h3>GitHub notification</h3><p className="muted">{thread.notification} · {thread.subscription ?? (thread.subscribed ? 'subscribed' : 'unsubscribed')}. These controls do not change notes or Tasks.</p>
          {canWrite ? <div className="button-row"><button className="text-button" onClick={() => open({ row, kind: 'notification', action: 'done' })}>Mark notification done on GitHub</button>
            <button className="text-button" onClick={() => open({ row, kind: 'notification', action: 'unsubscribe' })}>Unsubscribe on GitHub</button></div>
            : <p className="field-help">Refresh to look for a GitHub notification before using notification controls. You can still open the source above.</p>}
        </section>
        <details className="sources"><summary>Saved source history<ChevronDown size={14} /></summary>
          {thread.events.map(event => <div className="source-event" key={event.id}><span className="preserve-text">{event.summary}</span><small>{event.actor} · {stamp(event.at, state.timeZone, true)}</small></div>)}
          {thread.coverage && <p className="muted">Timeline: {thread.coverage.timeline} · {thread.coverage.fetchedPages} pages · newest page {thread.coverage.newestPage ? 'included' : 'unavailable'}</p>}
        </details>
        {thread.diagnostics?.map(message => <p className="notice-inline warning" key={message}>{message}</p>)}
      </>}
    </div>
  </article>;
}

export function App() { return <WorkspaceApp workspace={useWorkspace()} />; }

export function WorkspaceApp({ workspace, children }: { workspace: WorkspaceView; children?: ReactNode }) {
  const { state, dispatch } = workspace;
  const live = workspace.desktop;
  const [capture, setCapture] = useState(false);
  const [demo, setDemo] = useState(false);
  const [destination, setDestination] = useState<Destination>();
  const openDestination = live?.open ?? setDestination;
  const listRef = useRef<HTMLDivElement>(null);
  const rows = getRows(state);
  const selected = state.selectedKey ? getRow(state, state.selectedKey) : undefined;
  const earlier = state.view === 'inbox' ? earlierThreads(state) : [];
  const open = rows.filter(row => row.task?.status !== 'done');
  const done = rows.filter(row => row.task?.status === 'done');
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCapture(true); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = workspace.scroll[state.view] ?? 0; }, [state.view]);
  function rowList(items: Row[]) {
    return <ul className="work-list">{items.map(row => <WorkRow key={row.key} row={row} selected={state.selectedKey === row.key}
      select={() => dispatch({ type: 'select', key: row.key })} open={openDestination} />)}</ul>;
  }
  return <div className={`app ${selected ? 'has-selection' : ''}`}>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Github size={21} /></span><span>GitHub Projects</span></div>
      <button className="capture-button secondary" onClick={() => setCapture(true)}><Plus size={16} />Capture<span className="shortcut">⌘ K</span></button>
      <nav aria-label="Inboxes">
        <button className={`nav-link ${state.view === 'inbox' ? 'current' : ''}`} aria-current={state.view === 'inbox' ? 'page' : undefined} onClick={() => dispatch({ type: 'view', view: 'inbox' })}><Inbox size={17} />Inbox<span className="count">{getRows(state, 'inbox').length}</span></button>
        <button className={`nav-link ${state.view === 'tasks' ? 'current' : ''}`} aria-current={state.view === 'tasks' ? 'page' : undefined} onClick={() => dispatch({ type: 'view', view: 'tasks' })}><CheckCheck size={17} />Tasks<span className="count">{state.tasks.filter(task => task.status === 'open').length}</span></button>
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-link" disabled={!state.undo.length} onClick={() => dispatch({ type: 'undo' }, 'Task change undone.')}><RotateCcw size={15} />Undo task change</button>
        {live ? <button className="nav-link" onClick={live.connections}><Settings2 size={16} />Connections</button> : <button className="nav-link" onClick={() => setDemo(true)}><Settings2 size={16} />Demo scenarios{state.staged.length > 0 && <span className="count">{state.staged.length}</span>}</button>}
        <div className="prototype-label"><span className="demo-dot" />{live ? 'Local workspace' : 'Browser prototype'}<span>{live ? 'GitHub refresh is manual' : 'Synthetic data · local only'}</span></div>
      </div>
    </aside>
    <main id="workspace" className="workspace">
      <header className="workspace-heading"><div><h1>{viewLabels[state.view]}</h1><p>{state.view === 'inbox' ? 'GitHub conversations, with your notes alongside.' : 'Your tasks. Separate from GitHub activity.'}</p></div>
        <div className="refresh-area"><button className="secondary refresh-button" disabled={live?.refreshing} aria-busy={live?.refreshing} onClick={() => live ? live.refresh() : dispatch({ type: 'refresh' })}><RefreshCw size={15} />{live?.refreshing ? 'Refreshing...' : 'Refresh'}</button>
          <span>{state.refresh.lastSuccessAt ? `Updated ${stamp(state.refresh.lastSuccessAt, state.timeZone)}` : live ? 'Refresh to load GitHub activity' : 'Sample snapshot · not yet refreshed'}</span></div>
      </header>
      {(workspace.storageError || workspace.operationError) && <section className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>{workspace.storageError ? 'Your changes are not saved' : 'That action could not finish'}</strong><p>{workspace.storageError || workspace.operationError}</p>
        {workspace.storageError && <div className="button-row"><button className="text-button" onClick={() => workspace.retryStorage()}>Retry storage</button><button className="text-button" onClick={() => workspace.exportBackup()}>Export pending copy</button><button className="text-button" onClick={() => workspace.exportBackup(true)}>Export saved copy</button><button className="text-button" onClick={() => workspace.retryStorage(true)}>Back up saved copy &amp; use this one</button></div>}
      </div></section>}
      {(state.refresh.status === 'error' || state.refresh.status === 'partial') && <section className="error-banner" role="status"><AlertCircle size={18} /><div><strong>{state.refresh.status === 'partial' ? 'Some activity could not be refreshed' : 'Refresh failed; showing saved work'}</strong><p>{state.refresh.message}</p></div></section>}
      <div className="workspace-grid">
        <section className="queue" aria-label={viewLabels[state.view]}>
          <div className="queue-heading"><h2>{state.view === 'inbox' ? 'Threads' : 'Open tasks'}<span>{open.length}</span></h2></div>
          <div className="queue-scroll" ref={listRef} onScroll={event => workspace.saveScroll(state.view, event.currentTarget.scrollTop)}>
            {rowList(open.filter(row => !row.fresh))}
            {open.some(row => row.fresh) && <section className="new-updates"><h3>New since refresh</h3>{rowList(open.filter(row => row.fresh))}</section>}
            {!open.length && <div className="empty-list"><Inbox size={27} /><h3>{state.view === 'inbox' ? 'No threads in this saved inbox' : 'No open tasks'}</h3><p>{state.view === 'inbox' ? 'Refresh to check GitHub. Earlier threads and their notes remain available below.' : 'Capture a task from anywhere in the app.'}</p></div>}
            {!!done.length && <section className="completed-tasks" aria-label="Completed tasks"><h3>Done <span>{done.length}</span></h3>{rowList(done)}</section>}
            {!!earlier.length && <details className="earlier-threads"><summary>Earlier threads <span>{earlier.length}</span><ChevronDown size={14} /></summary>
              <p className="field-help">Retained conversations, not pending tasks.</p>{rowList(earlier)}</details>}
          </div>
          <footer className="queue-footer">{state.view === 'inbox' ? 'GitHub refresh is manual.' : 'GitHub activity never reopens a task.'}</footer>
        </section>
        {selected ? <Detail row={selected} state={state} dispatch={dispatch} open={openDestination} back={() => dispatch({ type: 'select', key: null })} unsaved={!!workspace.storageError || !!live?.saving} />
          : <div className="empty-detail"><Inbox size={29} strokeWidth={1.25} /><h2>{state.view === 'inbox' ? 'Select a thread' : 'Select a task'}</h2><p>{state.view === 'inbox' ? 'Read saved activity and keep private notes.' : 'Edit its text, keep notes, or mark it Done.'}</p></div>}
      </div>
      <footer className="workspace-footer"><span><Circle size={11} />{live ? 'Workspace time' : 'Demo clock'}: {stamp(state.clock, state.timeZone, true)} · {state.timeZone}</span><span>{workspace.storageError ? <><AlertCircle size={12} />Pending changes not saved</> : live?.saving ? 'Saving...' : <><Check size={12} />{live ? 'Saved on this Mac' : 'Saved in this browser'}</>}</span></footer>
    </main>
    {workspace.feedback && <div className="feedback" role="status">{workspace.storageError ? <AlertCircle size={16} className="danger" /> : <Check size={16} />}<span>{workspace.feedback}</span><button className="icon-button" aria-label="Dismiss feedback" onClick={workspace.clearFeedback}><X size={14} /></button></div>}
    {capture && <Capture state={state} dispatch={dispatch} close={() => setCapture(false)} />}
    {demo && <Demo state={state} dispatch={dispatch} close={() => setDemo(false)} />}
    {destination && <Handoff destination={destination} state={state} dispatch={dispatch} close={() => setDestination(undefined)} />}
    {children}
  </div>;
}
