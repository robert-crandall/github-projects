import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowRight, Bell, BellOff, Check, CheckCheck, ChevronDown, Circle,
  Clock3, ExternalLink, Folder, GitPullRequest, Github, Inbox, ListFilter, MessageSquare,
  MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Settings2, Sparkles, X,
} from 'lucide-react';
import { getRow, getRows, reminders } from './domain/engine.ts';
import type { AppState, Command, Row, Scenario, View } from './types.ts';
import { useWorkspace } from './useWorkspace.ts';
import type { Destination, WorkspaceView } from './runtime/view.ts';

type Dispatch = (command: Command, message?: string) => boolean;
const viewLabels: Record<View, string> = {
  attention: 'Needs attention', later: 'Later', history: 'History', routines: 'Routines', projects: 'Project context',
};
const viewDescriptions: Record<View, string> = {
  attention: 'A place to choose your next action. Not another inbox to clear.',
  later: 'Still yours to do. Just not right now.',
  history: 'The actions you finished, not the state of the pull request.',
  routines: 'Small commitments, on your schedule.',
  projects: 'Optional context for the work you kept.',
};
export function stamp(value: string, zone: string, date = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: 'numeric', minute: '2-digit', ...(date ? { month: 'short', day: 'numeric' } as const : {}),
  }).format(new Date(value));
}
function dateStamp(value: string, zone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function ItemIcon({ row, size = 18 }: { row: Row; size?: number }) {
  if (row.kind === 'review') return <GitPullRequest size={size} />;
  if (row.kind === 'routine') return <Clock3 size={size} />;
  if (row.kind === 'update') return <MessageSquare size={size} />;
  return <Circle size={size} />;
}

export function Modal({ title, children, close, className = '' }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
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

function WorkRow({ row, selected, active, select, open }: {
  row: Row; selected: boolean; active: boolean; select: () => void; open: (destination: Destination) => void;
}) {
  return <li className={`work-row ${selected ? 'selected' : ''}`} data-row-key={row.key}>
    <span className={`row-icon ${row.kind}`}><ItemIcon row={row} /></span>
    <div className="row-content">
      <button className="row-select" onClick={select} aria-current={selected ? 'true' : undefined}>
        <span className="row-title">{row.title}</span>
        <span className="row-meta">{row.thread ? `${row.thread.repo} #${row.thread.number}` : row.action?.project || (row.kind === 'routine' ? 'Scheduled commitment' : 'Your capture')}{active && <span className="working-label"><span className="dot" />Working on</span>}</span>
        <span className="row-reason">{row.reason}</span>
        {row.action?.status === 'later' && row.action.notes && <span className="row-note">{row.action.notes.split('\n\n').at(-1)}</span>}
      </button>
      <Destinations row={row} open={open} />
    </div>
  </li>;
}

function Capture({ state, dispatch, close }: { state: AppState; dispatch: Dispatch; close: () => void }) {
  const first = state.threads.find(thread => thread.kind === 'pr');
  const example = first ? `Review demo://github/${first.repo}/pull/${first.number}` : 'Review the rollout plan';
  return <Modal title="Capture something" close={close}>
    <p className="muted">A request, a link, a loose end. Your original words stay saved.</p>
    <form onSubmit={event => { event.preventDefault(); if (dispatch({ type: 'capture' }, 'Capture saved.')) { dispatch({ type: 'view', view: 'attention' }); close(); } }}>
      <label className="sr-only" htmlFor="capture-text">What do you want to remember?</label>
      <textarea id="capture-text" autoFocus rows={5} value={state.draft} onChange={event => dispatch({ type: 'draft', text: event.target.value })} placeholder="What do you want to remember?" required />
      {state.runtime !== 'desktop' && <div className="capture-examples"><span>Try a sample</span><button type="button" className="text-button" onClick={() => dispatch({ type: 'draft', text: example })}>A review request</button><button type="button" className="text-button" onClick={() => dispatch({ type: 'draft', text: 'Every day at 10am, announce the change, then increase the feature flag' })}>A daily routine</button></div>}
      <footer className="modal-footer"><span className="muted">No project or priority required.</span><button type="submit" className="primary"><Plus size={16} />Save capture</button></footer>
    </form>
  </Modal>;
}

function LaterDialog({ row, dispatch, state, close, error }: { row: Row; dispatch: Dispatch; state: AppState; close: () => void; error: string }) {
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  return <Modal title="Keep it for later" close={close}>
    <p className="dialog-item">{row.title}</p>
    <form onSubmit={event => {
      event.preventDefault();
      const remindAt = until ? new Date(until).toISOString() : undefined;
      if (dispatch({ type: 'later', key: row.key, note, remindAt }, 'Kept in Later. Your context stays with it.')) close();
    }}>
      <label>A note for later <span className="muted">optional</span><textarea autoFocus rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Waiting for a response, or just saving this for another day..." /></label>
      <label>Remind me <span className="muted">optional</span><input type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /><span className="field-help">{state.timeZone}. {state.runtime === 'desktop' ? 'Current time' : 'Demo clock'}: {stamp(state.clock, state.timeZone, true)}. No date means no reminder.</span></label>
      <p className="muted">GitHub updates will not move this action out of Later.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" type="submit"><Clock3 size={16} />Keep for later</button></footer>
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
    {phase === 'requested' ? <div className="outcome"><CheckCheck size={26} /><h3>{isWrite ? 'Simulated GitHub change recorded' : 'Launch requested, not completed'}</h3><p>{isWrite ? 'Your local action and its notes are unchanged.' : 'No browser or Copilot session was opened. Your action stays unfinished, right where you left it.'}</p></div> : <>
      <p>{kind === 'copilot' ? thread.kind === 'pr'
        ? 'The desktop app will ask Copilot App to open an interactive PR session with the prompt “Review this PR.” Copilot App asks for confirmation before creating it.'
        : 'The desktop app will open this issue in Copilot App. The repository may need to be added there first.'
        : kind === 'github' ? 'The desktop app will open this source in your browser. This sample stays inside the prototype.'
        : action === 'done' ? 'Acknowledge this notification, not your local action. Completing your work remains a separate choice.'
        : 'Stop ordinary conversation notifications. A direct or team mention, or another review request, can notify you again.'}</p>
      <div className="simulation-note"><strong>No external action</strong><span>Only this prototype changes. No real URLs, messages, or private notes leave the app.</span></div>
      <label className="checkbox-label"><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />{isWrite ? 'Simulate a failed GitHub write' : 'Simulate an unavailable app'}</label>
      {phase === 'error' && <p className="inline-error" role="alert"><AlertCircle size={16} />{isWrite ? 'The simulated write failed. No acknowledgement or unsubscribe was recorded.' : 'The simulated app could not be opened. Your action is still here.'} Turn off the failure to retry.</p>}
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

const scenarios: { id: Scenario; title: string; description: string }[] = [
  { id: 'new-review', title: 'A new review arrives', description: 'A separate request waits for Refresh.' },
  { id: 'merge-queue', title: 'PR enters the merge queue', description: 'A completed review must stay finished.' },
  { id: 're-request', title: 'Review is requested again', description: 'New evidence, not the old action reopened.' },
  { id: 'sticky-mention', title: 'Old mention, ordinary update', description: 'An old notification reason is not a new request.' },
  { id: 'comment', title: 'An ordinary comment', description: 'Activity is not automatically an obligation.' },
  { id: 'mention', title: 'A new mention', description: 'A mention can notify after unsubscribe.' },
  { id: 'closed', title: 'The source closes', description: 'Retained local commitments stay available.' },
  { id: 'read', title: 'Read on GitHub', description: 'Reading does not finish your action.' },
  { id: 'acknowledged', title: 'Acknowledged on GitHub', description: 'Notification done and action done are separate.' },
  { id: 'empty', title: 'No outstanding notifications', description: 'Your local work remains.' },
];
function Demo({ state, dispatch, close }: { state: AppState; dispatch: Dispatch; close: () => void }) {
  const [scenario, setScenario] = useState<Scenario>('merge-queue');
  return <Modal title="Explore the prototype" close={close} className="demo-modal">
    <p className="muted">All people, repositories, and activity here are synthetic.</p>
    <section className="demo-section"><h3>Stage GitHub activity</h3><p>Applies to the selected source where possible. Nothing arrives until Refresh.</p>
      <label htmlFor="demo-scenario" className="sr-only">Activity scenario</label>
      <select id="demo-scenario" value={scenario} onChange={event => setScenario(event.target.value as Scenario)}>
        {scenarios.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <p className="field-help">{scenarios.find(item => item.id === scenario)?.description}</p>
      <button className="secondary" onClick={() => dispatch({ type: 'stage', scenario }, 'Activity staged. Click Refresh to bring it in.')}><Plus size={15} />Stage activity</button>
      <span className="muted staged-count" role="status">{state.staged.length} staged</span>
    </section>
    <section className="demo-section"><h3>Move the local clock</h3><p>{stamp(state.clock, state.timeZone, true)} · {state.timeZone}</p>
      <div className="button-row"><button className="secondary" onClick={() => dispatch({ type: 'advance', minutes: 30 }, 'Demo clock advanced 30 minutes.')}>Advance 30 minutes</button><button className="secondary" onClick={() => dispatch({ type: 'advance', minutes: 3 * 24 * 60 }, 'Demo clock advanced 3 days.')}>Advance 3 days</button></div>
    </section>
    <section className="demo-section"><h3>Try failure and recovery</h3>
      <label>Next refresh<select value={state.failures.refresh} onChange={event => dispatch({ type: 'configure', refreshFailure: event.target.value as AppState['failures']['refresh'] })}><option value="none">Complete</option><option value="partial">Partial results</option><option value="error">Offline / failed</option></select></label>
      <label className="checkbox-label"><input type="checkbox" checked={state.failures.interpretation} onChange={event => dispatch({ type: 'configure', interpretationFailure: event.target.checked })} />Capture interpretation fails</label>
      <label className="checkbox-label"><input type="checkbox" checked={state.failures.storage} onChange={event => dispatch({ type: 'configure', storageFailure: event.target.checked })} />Local storage fails</label>
      <label className="checkbox-label"><input type="checkbox" checked={state.failures.external} onChange={event => dispatch({ type: 'configure', externalFailure: event.target.checked })} />External handoff fails</label>
    </section>
    <footer className="modal-footer"><button className="text-button" onClick={() => dispatch({ type: 'reset' }, 'Sample fixtures reset. Your captures are retained.')}><RotateCcw size={15} />Reset samples, keep captures</button><button className="primary" onClick={close}>Back to workspace</button></footer>
  </Modal>;
}

function Triage({ state, dispatch, close }: { state: AppState; dispatch: Dispatch; close: () => void }) {
  const candidates = getRows(state, 'attention');
  return <Modal title="Triage with Copilot" close={close} className="triage-modal">
    <span className="simulation-tag"><Sparkles size={13} />Deterministic sample rules · no SDK request</span>
    <p>The desktop app will use the Copilot SDK to help make sense of your notifications. This preview shows the same review-before-applying interaction.</p>
    <div className="simulation-note"><strong>Suggestions, not decisions</strong><span>Requests come before ordinary activity. Nothing here starts or finishes work, or changes a GitHub subscription.</span></div>
    <ul className="triage-suggestions">{candidates.map(row => <li key={row.key}>
      <div className="triage-suggestion-heading"><ItemIcon row={row} size={16} /><strong>{row.title}</strong></div>
      <span className="triage-category">{row.kind === 'review' ? 'Review request' : row.kind === 'update' ? 'Update to inspect · not a confirmed obligation' : row.kind === 'routine' ? 'Scheduled commitment' : 'Retained local action'}</span>
      <p>{row.reason}</p>
      <span className="field-help">Suggested next step: {row.action?.nextStep || (row.kind === 'review' ? 'Review the requested changes.' : 'Read the new activity and decide whether you owe a response.')}</span>
    </li>)}</ul>
    {!candidates.length && <p className="muted">No candidates in this saved view. Refresh can bring in staged activity; it will not replace your current work.</p>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>Keep current order</button><button className="primary" disabled={!candidates.length} onClick={() => {
      if (dispatch({ type: 'reconsider' }, 'Sample order applied. Your actions and current work are unchanged.')) close();
    }}>Apply suggested order<ArrowRight size={15} /></button></footer>
  </Modal>;
}

function Detail({ row, state, dispatch, open, later, back, unsaved, desktop }: {
  row: Row; state: AppState; dispatch: Dispatch; open: (destination: Destination) => void; later: () => void; back: () => void; unsaved: boolean; desktop?: WorkspaceView['desktop'];
}) {
  const action = row.action;
  const active = !!action && state.activeId === action.id;
  const completed = action?.status === 'done' || action?.status === 'removed';
  const latest = row.events.at(-1);
  const routine = action?.routine;
  const stale = routine?.dueAt && dateStamp(routine.dueAt, routine.timeZone) !== dateStamp(state.clock, routine.timeZone);
  const [editing, setEditing] = useState(false);
  const firstOpenStep = action?.steps.find(step => !step.doneAt)?.id;
  return <article className="detail" aria-label="Selected item">
    <header className="detail-toolbar">
      <button className="text-button back-control" onClick={back}><ArrowLeft size={15} />Back to list</button>
      <span className="detail-location">{row.thread ? <><Github size={14} />{row.thread.repo}<span className="separator">/</span>#{row.thread.number}</> : <><ItemIcon row={row} size={14} />{routine ? 'Routine' : 'Local action'}</>}</span>
      <span className={`state-tag ${completed ? 'complete' : ''}`}>{active ? 'Working on' : action?.status === 'done' ? 'Action finished' : action?.status === 'later' ? 'Kept for later' : row.thread?.state === 'queued' ? 'Queued to merge' : row.thread?.state === 'closed' ? 'Source closed' : 'Saved context'}</span>
    </header>
    <div className="detail-body">
      <div className={`detail-kind ${row.kind}`}><ItemIcon row={row} size={16} /><span>{row.kind === 'review' ? 'Review request' : row.kind === 'update' ? 'Source update' : routine ? 'Scheduled commitment' : 'Your action'}</span></div>
      <h2>{row.title}</h2>
      <Destinations row={row} open={open} />
      <section className="evidence" aria-label="Why this is here">
        <span className="eyebrow">{completed ? 'Your action is finished' : 'Why this is here'}</span>
        <p>{row.reason}</p>
        {latest && <span className="evidence-source">{latest.actor} · {stamp(latest.at, state.timeZone, true)}</span>}
        {completed && <p className="field-help">Source activity does not reopen this action. A new request has its own evidence.</p>}
      </section>
      {active && <p className="active-note"><span className="dot" />This stays your current action until you finish or switch.</p>}
      <div className="detail-actions">
        {completed ? <button className="secondary" onClick={() => dispatch({ type: 'restore', key: row.key }, 'Action restored.')}><RotateCcw size={16} />Restore action</button> : <>
          {!active && <button className="primary" disabled={!!routine && !routine.dueAt} onClick={() => dispatch({ type: 'start', key: row.key }, state.activeId ? 'Switched work. Your previous context is saved.' : 'Your current action is set.')}><Play size={15} />{state.activeId ? 'Switch to this' : 'Work on this'}</button>}
          <button className={active ? 'primary' : 'secondary'} disabled={!!routine && (!routine.dueAt || !!action?.steps.some(step => !step.doneAt))} onClick={() => dispatch({ type: 'done', key: row.key }, routine ? 'Occurrence finished. The routine remains.' : 'Your action is finished.')}><Check size={16} />{routine ? 'Finish occurrence' : 'Done'}</button>
          <button className="quiet" onClick={later}><Clock3 size={16} />Later</button>
        </>}
        <button className="icon-button edit-action" aria-label="Edit action details" title="Edit action details" onClick={() => setEditing(!editing)} aria-expanded={editing}><MoreHorizontal size={18} /></button>
      </div>
      {!completed && <p className="completion-help">Done finishes your action here. It does not {row.thread?.kind === 'pr' ? 'submit a review or close the PR' : 'change anything in GitHub'}.</p>}
      {editing && <section className="edit-form">
        <label>Action title<input value={action?.title ?? row.title} onChange={event => dispatch({ type: 'edit', key: row.key, title: event.target.value })} /></label>
        <label>Next step<input value={action?.nextStep ?? ''} onChange={event => dispatch({ type: 'edit', key: row.key, nextStep: event.target.value })} /></label>
        <label>Project context <span className="muted">optional</span><input value={action?.project ?? ''} onChange={event => dispatch({ type: 'edit', key: row.key, project: event.target.value })} placeholder="A name that helps you find this again" /></label>
        {!completed && <button className="text-button danger" onClick={() => dispatch({ type: 'remove', key: row.key }, 'Action removed locally. You can undo this.')}>Remove local action</button>}
      </section>}
      {action?.interpretation === 'pending' && <section className="interpret-panel"><p>{desktop ? 'Original text stays here. Preview a suggestion before applying it.' : "Your original text is saved. Structure it with the prototype's sample rules."}</p><button className="secondary" onClick={() => desktop ? desktop.interpret(row) : dispatch({ type: 'interpret', key: row.key }, 'Sample interpretation applied.')}><Sparkles size={15} />{desktop ? 'Interpret with Copilot' : 'Try simulated interpretation'}</button></section>}
      {desktop && action?.captures.length && !completed && !routine ? <button className="text-button" onClick={() => desktop.routine(row)}><Clock3 size={15} />Set up daily routine manually</button> : null}
      {action?.interpretationMessage && <p className={action.interpretation === 'error' ? 'inline-error' : 'notice-inline'}>{action.interpretationMessage}{action.interpretation === 'error' && <button className="text-button" onClick={() => desktop ? desktop.interpret(row) : dispatch({ type: 'interpret', key: row.key })}>Retry interpretation</button>}</p>}
      {routine && <div className="routine-context"><span><Clock3 size={15} />Daily at {routine.time} · {routine.timeZone}</span><span>{routine.dueAt ? `Occurrence due ${stamp(routine.dueAt, routine.timeZone, true)}` : `Next ${stamp(routine.nextDueAt, routine.timeZone, true)}`}</span></div>}
      {stale && <p className="notice-inline warning"><AlertCircle size={15} />This occurrence is from an earlier day. Recorded steps have not been repeated.</p>}
      {action && action.steps.length > 0 && <section className="checklist"><h3>Your next steps</h3>{action.steps.map(step => <label className={`step ${step.doneAt ? 'step-done' : ''}`} key={step.id}>
        <input type="checkbox" checked={!!step.doneAt} disabled={completed || (!!routine && (!routine.dueAt || (!step.doneAt && step.id !== firstOpenStep)))} onChange={() => dispatch({ type: 'step', key: row.key, stepId: step.id }, 'Step recorded locally.')} />
        <span>{step.title}<small>{step.doneAt ? `Recorded ${stamp(step.doneAt, state.timeZone, true)}` : 'Do this in your tools, then record it here.'}</small></span>
      </label>)}</section>}
      {action?.remindAt && <p className="notice-inline"><Bell size={15} />Reminder {stamp(action.remindAt, state.timeZone, true)}</p>}
      <section className="notes-section"><div className="section-heading"><label htmlFor="scratch-notes">A note for when you return</label><span>{unsaved ? <><AlertCircle size={12} />Not saved</> : <><Check size={12} />Autosave</>}</span></div>
        <textarea id="scratch-notes" value={action?.notes ?? ''} onChange={event => dispatch({ type: 'edit', key: row.key, notes: event.target.value })} placeholder="Leave a next step, a question, or a place to pick up..." rows={5} />
      </section>
      {row.thread && (!desktop || /^\d+$/.test(row.thread.id)) && <section className="thread-controls"><h3>The GitHub notification</h3><p className="muted">{row.thread.notification === 'done' ? 'Acknowledged' : row.thread.notification === 'read' ? 'Read' : 'Unread'} on {desktop ? 'GitHub' : 'simulated GitHub'} · {row.thread.subscription === 'unknown' ? 'Subscription not confirmed' : row.thread.subscribed ? 'Following this conversation' : 'Unsubscribed'}</p>
        <div className="button-row"><button className="text-button" onClick={() => open({ row, kind: 'notification', action: 'done' })}><CheckCheck size={14} />Mark notification done on GitHub</button><button className="text-button" disabled={!row.thread.subscribed} onClick={() => open({ row, kind: 'notification', action: 'unsubscribe' })}><BellOff size={14} />Unsubscribe on GitHub</button></div>
      </section>}
      <details className="sources"><summary>Original captures &amp; source history<ChevronDown size={14} /></summary>
        {action?.captures.map((text, index) => <blockquote key={index}>{text}</blockquote>)}
        {row.thread?.events.map(event => <div className="source-event" key={event.id}><span>{event.summary}</span><small>{event.actor} · {stamp(event.at, state.timeZone, true)}</small></div>)}
        {!action?.captures.length && !row.thread && <p className="muted">{desktop ? 'A local action.' : 'A local sample action.'} No GitHub source.</p>}
        {row.thread?.coverage && <p className="muted">Timeline: {row.thread.coverage.timeline} · {row.thread.coverage.fetchedPages} pages · newest page {row.thread.coverage.newestPage ? 'included' : 'unavailable'}</p>}
        {row.thread?.diagnostics?.map(message => <p className="notice-inline warning" key={message}>{message}</p>)}
      </details>
      {routine && <details className="sources"><summary>Previous occurrences <span>{routine.history.length}</span><ChevronDown size={14} /></summary>{routine.history.length ? [...routine.history].reverse().map((item, index) => <div className="source-event" key={`${item.dueAt}-${index}`}><span>{stamp(item.dueAt, routine.timeZone, true)} · {item.status}</span>{item.steps.filter(step => step.doneAt).map(step => <small key={step.id}>{step.title}: {stamp(step.doneAt!, routine.timeZone, true)}</small>)}</div>) : <p className="muted">No previous occurrences.</p>}</details>}
    </div>
  </article>;
}

export function App() {
  const workspace = useWorkspace();
  return <WorkspaceApp workspace={workspace} />;
}

export function WorkspaceApp({ workspace, children }: { workspace: WorkspaceView; children?: ReactNode }) {
  const { state, dispatch } = workspace;
  const live = workspace.desktop;
  const [capture, setCapture] = useState(false);
  const [demo, setDemo] = useState(false);
  const [triage, setTriage] = useState(false);
  const [later, setLater] = useState<Row>();
  const [destination, setDestination] = useState<Destination>();
  const openDestination = live?.open ?? setDestination;
  const [project, setProject] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const rows = getRows(state);
  const selected = state.selectedKey ? getRow(state, state.selectedKey) : undefined;
  const active = state.activeId ? getRow(state, `a:${state.activeId}`) : undefined;
  const due = reminders(state);
  const visible = state.view === 'projects' && project ? rows.filter(row => row.action?.project === project) : rows;
  const existing = visible.filter(row => !row.fresh);
  const fresh = visible.filter(row => row.fresh);
  const counts = { attention: getRows(state, 'attention').length, later: getRows(state, 'later').length };
  const projects = [...new Set(rows.map(row => row.action?.project).filter((value): value is string => !!value))];

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCapture(true); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = workspace.scroll[state.view] ?? 0;
  }, [state.view]);

  function rowList(items: Row[]) {
    return <ul className="work-list">{items.map(row => <WorkRow key={row.key} row={row}
      selected={state.selectedKey === row.key || (!!row.action && selected?.action?.id === row.action.id)} active={!!row.action && row.action.id === state.activeId}
      select={() => dispatch({ type: 'select', key: row.key })} open={openDestination} />)}</ul>;
  }

  function navigate(view: View) {
    dispatch({ type: 'view', view });
    dispatch({ type: 'select', key: null });
  }

  return <div className={`app ${selected ? 'has-selection' : ''}`}>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Github size={21} /></span><span>GitHub Projects</span></div>
      <button className="capture-button secondary" onClick={() => setCapture(true)}><Plus size={16} />Capture<span className="shortcut">⌘ K</span></button>
      <section className="working-on" aria-label="Working on"><div className="sidebar-label"><span>Working on</span>{active && <span className="dot" />}</div>
        {active ? <button className="active-anchor" onClick={() => dispatch({ type: 'select', key: active.key })}><ItemIcon row={active} size={15} /><span>{active.title}</span><ArrowRight size={14} /></button>
          : <p>Choose an action.<br />Your place will stay here.</p>}
      </section>
      <nav aria-label="Workspace">
        <button className={`nav-link ${state.view === 'attention' ? 'current' : ''}`} aria-current={state.view === 'attention' ? 'page' : undefined} onClick={() => navigate('attention')}><Inbox size={17} />Needs attention<span className="count">{counts.attention}</span></button>
        <button className={`nav-link ${state.view === 'later' ? 'current' : ''}`} aria-current={state.view === 'later' ? 'page' : undefined} onClick={() => navigate('later')}><Clock3 size={17} />Later<span className="count">{counts.later}</span></button>
        <div className="nav-divider" />
        <button className={`nav-link ${state.view === 'routines' ? 'current' : ''}`} onClick={() => navigate('routines')} aria-current={state.view === 'routines' ? 'page' : undefined}><RefreshCw size={16} />Routines</button>
        <button className={`nav-link ${state.view === 'projects' ? 'current' : ''}`} onClick={() => navigate('projects')} aria-current={state.view === 'projects' ? 'page' : undefined}><Folder size={16} />Project context</button>
        <button className={`nav-link ${state.view === 'history' ? 'current' : ''}`} onClick={() => navigate('history')} aria-current={state.view === 'history' ? 'page' : undefined}><CheckCheck size={17} />History</button>
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-link" disabled={!state.undo.length} onClick={() => dispatch({ type: 'undo' }, 'Local change undone.')}><RotateCcw size={15} />Undo last change</button>
        {live ? <button className="nav-link" onClick={live.connections}><Settings2 size={16} />Connections</button> : <button className="nav-link" onClick={() => setDemo(true)}><Settings2 size={16} />Demo scenarios{state.staged.length > 0 && <span className="count">{state.staged.length}</span>}</button>}
        <div className="prototype-label"><span className="demo-dot" />{live ? 'Local workspace' : 'Browser prototype'}<span>{live ? 'GitHub refresh is manual' : 'Synthetic data · local only'}</span></div>
      </div>
    </aside>
    <main id="workspace" className="workspace">
      <header className="workspace-heading"><div><span className="page-eyebrow">YOUR WORKSPACE</span><h1>{viewLabels[state.view]}</h1><p>{viewDescriptions[state.view]}</p></div>
        <div className="refresh-area"><div className="button-row"><button className="quiet triage-trigger" onClick={() => live ? live.triage('triage') : setTriage(true)}><Sparkles size={15} />Triage with Copilot</button><button className="secondary refresh-button" disabled={live?.refreshing} aria-busy={live?.refreshing} onClick={() => live ? live.refresh() : dispatch({ type: 'refresh' })}><RefreshCw size={15} />{live?.refreshing ? 'Refreshing...' : 'Refresh'}</button></div><span>{state.refresh.lastSuccessAt ? `Updated ${stamp(state.refresh.lastSuccessAt, state.timeZone)}` : live ? 'Refresh to load GitHub activity' : 'Sample snapshot · not yet refreshed'}</span></div>
      </header>
      {(workspace.storageError || workspace.operationError) && <section className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>{workspace.storageError ? 'Your changes are not saved' : 'That action could not finish'}</strong><p>{workspace.storageError || workspace.operationError}</p>
        {workspace.storageError && <div className="button-row"><button className="text-button" onClick={() => workspace.retryStorage()}>Retry storage</button><button className="text-button" onClick={() => workspace.exportBackup()}>Export pending copy</button><button className="text-button" onClick={() => workspace.exportBackup(true)}>Export saved copy</button><button className="text-button" onClick={() => workspace.retryStorage(true)}>Back up saved copy &amp; use this one</button></div>}
      </div></section>}
      {(state.refresh.status === 'error' || state.refresh.status === 'partial') && <section className="error-banner" role="status"><AlertCircle size={18} /><div><strong>{state.refresh.status === 'partial' ? 'Some activity could not be refreshed' : 'Refresh failed; showing saved work'}</strong><p>{state.refresh.message}</p></div></section>}
      {due.length > 0 && <section className="reminders" aria-label="Local reminders">{due.map(action => <div className="reminder" key={action.id}><Bell size={16} /><button className="reminder-title" onClick={() => dispatch({ type: 'select', key: `a:${action.id}` })}><strong>{action.title}</strong><span>Your reminder is due. Current work stays put.</span></button><button className="text-button" onClick={() => dispatch({ type: 'reminder', key: `a:${action.id}`, action: 'snooze' }, 'Reminder snoozed for 30 minutes.')}>Snooze 30m</button>{action.routine && <button className="text-button" onClick={() => dispatch({ type: 'reminder', key: `a:${action.id}`, action: 'skip' }, 'Occurrence skipped.')}>Skip</button>}<button className="icon-button" aria-label={`Dismiss reminder for ${action.title}`} onClick={() => dispatch({ type: 'reminder', key: `a:${action.id}`, action: 'dismiss' })}><X size={14} /></button></div>)}</section>}
      <div className="workspace-grid">
        <section className="queue" aria-label={viewLabels[state.view]}>
          <div className="queue-heading"><h2>{state.view === 'attention' ? 'Requests & commitments' : viewLabels[state.view]}<span>{visible.length}</span></h2>
            <button className="icon-button" aria-label="Reconsider order" title="Reconsider order" onClick={() => live ? live.triage('reconsider') : dispatch({ type: 'reconsider' }, 'Order reconsidered. Your current action is unchanged.')}><ListFilter size={16} /></button>
          </div>
          {state.view === 'projects' && <label className="project-filter">Project<select value={project} onChange={event => setProject(event.target.value)}><option value="">All retained work</option>{projects.map(name => <option key={name}>{name}</option>)}</select></label>}
          <div className="queue-scroll" ref={listRef} onScroll={event => workspace.saveScroll(state.view, event.currentTarget.scrollTop)}>
            {existing.length > 0 && rowList(existing)}
            {fresh.length > 0 && <section className="new-updates"><h3><span className="dot" />New since refresh<span>{fresh.length}</span></h3>{rowList(fresh)}</section>}
            {!visible.length && <div className="empty-list"><CheckCheck size={27} /><h3>{state.view === 'attention' ? 'Nothing in the saved view' : `Nothing in ${viewLabels[state.view].toLowerCase()} yet`}</h3><p>{state.view === 'attention' && state.refresh.status !== 'ok' ? 'This is not confirmation that GitHub has no work. Your saved context is retained.' : 'Your other work and notes are still here.'}</p><button className="text-button" onClick={() => setCapture(true)}><Plus size={14} />Capture something</button></div>}
          </div>
          <footer className="queue-footer"><span className="dot quiet-dot" />Only changes when you choose.</footer>
        </section>
        {selected ? <Detail row={selected} state={state} dispatch={dispatch} open={openDestination} later={() => setLater(selected)} back={() => dispatch({ type: 'select', key: null })} unsaved={!!workspace.storageError || !!live?.saving} desktop={live} />
          : <div className="empty-detail"><div className="empty-detail-icon"><Inbox size={29} strokeWidth={1.25} /></div><h2>A little room to focus.</h2><p>Select an item to see what changed.<br />Choose <strong>Work on this</strong> when you're ready.</p>{active && <button className="secondary" onClick={() => dispatch({ type: 'select', key: active.key })}>Return to your current action<ArrowRight size={15} /></button>}</div>}
      </div>
      <footer className="workspace-footer"><span><Circle size={11} />{live ? 'Current time' : 'Demo clock'}: {stamp(state.clock, state.timeZone, true)} · {state.timeZone}</span><span>{workspace.storageError ? <><AlertCircle size={12} />Pending changes not saved</> : live?.saving ? 'Saving...' : <><Check size={12} />{live ? 'Saved on this Mac' : 'Saved in this browser'}</>}</span></footer>
    </main>
    {workspace.feedback && <div className="feedback" role="status">{workspace.storageError ? <AlertCircle size={16} className="danger" /> : <Check size={16} />}<span>{workspace.feedback}</span><button className="icon-button" aria-label="Dismiss feedback" onClick={workspace.clearFeedback}><X size={14} /></button></div>}
    {capture && <Capture state={state} dispatch={dispatch} close={() => setCapture(false)} />}
    {demo && <Demo state={state} dispatch={dispatch} close={() => setDemo(false)} />}
    {triage && <Triage state={state} dispatch={dispatch} close={() => setTriage(false)} />}
    {later && <LaterDialog row={later} state={state} dispatch={dispatch} close={() => setLater(undefined)} error={workspace.operationError} />}
    {destination && <Handoff destination={destination} state={state} dispatch={dispatch} close={() => setDestination(undefined)} />}
    {children}
  </div>;
}
