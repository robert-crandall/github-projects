import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Check, ExternalLink, ListOrdered, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { Modal } from '../App.tsx';
import { RecoveryPanel } from '../runtime/NativePanels.tsx';
import { DesktopApp } from '../runtime/DesktopApp.tsx';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { ServiceWorkspace } from '../runtime/service-workspace.ts';
import type { Task } from '../types.ts';
import { WorkQueue } from './controller.ts';
import { canonicalSource, rankedTasks } from './engine.ts';
import { Settings } from './Settings.tsx';
import './tasks.css';

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not run yet';
}
function source(task: Task) {
  if (!task.work) return 'Manual task';
  const url = new URL(task.work.url);
  return `${[...new Set(task.work.evidence.map(item => item.source))].join(' + ')} · ${url.hostname === 'github.com' ? url.pathname.slice(1).replace(/\/(?:pull|issues)\//, '#') : url.hostname}`;
}
function Capture({ queue, close }: { queue: WorkQueue; close: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  return <Modal title="Add a task" close={close} initialFocus={ref}>
    <form onSubmit={event => {
      event.preventDefault();
      try { queue.capture(title); close(); }
      catch (error) { setError(error instanceof Error ? error.message : 'Task could not be added.'); }
    }}>
      <label htmlFor="capture-task">What do you need to do?</label>
      <textarea id="capture-task" ref={ref} rows={4} maxLength={2000} value={title}
        onChange={event => setTitle(event.target.value)} />
      <p className="field-help">Saved locally now. Copilot places it in the order on the next run.</p>
      {error && <p className="task-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={!title.trim()} type="submit">Add task</button></footer>
    </form>
  </Modal>;
}
function TaskDetail({ task, reason, queue, controller, close }: {
  task: Task; reason?: string; queue: WorkQueue; controller: DesktopWorkspace; close: () => void;
}) {
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false);
  const [unsubscribeError, setUnsubscribeError] = useState('');
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const unsubscribing = !!task.work && status.unsubscribing.includes(canonicalSource(task.work.url));
  const subscription = task.work?.unsubscribe;
  const run = (operation: () => void | Promise<unknown>) => {
    try { Promise.resolve(operation()).catch(error => controller.report(error)); }
    catch (error) { controller.report(error); }
  };
  return <aside className="task-detail" aria-label="Task details">
    <header><h2>Task details</h2><button className="quiet" aria-label="Close task details" onClick={close}><X size={18} /></button></header>
    <label>Task<input value={task.title} maxLength={2000} onChange={event => run(() => queue.edit(task.id, event.target.value, task.notes))} /></label>
    <p className="task-source">{source(task)}</p>
    <div className="button-row"><button className="primary" onClick={() => run(() => task.status === 'done' ? queue.restore(task.id) : queue.complete(task.id))}>
      <Check size={16} />{task.status === 'done' ? 'Reopen task' : 'Mark done'}</button>
      {task.work && <button className="secondary" onClick={() => run(() => controller.platform.launchWebUrl(task.work!.url))}><ExternalLink size={14} />Open source</button>}
    </div>
    {task.status === 'done' && <p className="task-detail-notice">Done {date(task.completedAt ?? null)}. Only a fresh actionable request can bring this task back.</p>}
    {task.work?.notification && <section><h3>Conversation notifications</h3>
      <p>Done handles the current request. Unsubscribe stops following the conversation without changing this task or closing the source.</p>
      {subscription?.status === 'confirmed' ? <p role="status">Unsubscribed on GitHub {date(subscription.confirmedAt ?? null)}. Direct mentions, team mentions and review requests can still notify you.</p>
        : <><button className="secondary" disabled={unsubscribing} onClick={() => { setUnsubscribeError(''); setConfirmUnsubscribe(true); }}>
          {unsubscribing ? 'Unsubscribing...' : subscription ? 'Retry unsubscribe on GitHub' : 'Unsubscribe on GitHub'}</button>
          {subscription && !unsubscribing && <p className="task-detail-notice" role="status">
            {subscription.error || 'Unsubscribe is not confirmed. Retry explicitly; this app never resends it automatically.'}
          </p>}</>}
    </section>}
    {task.work?.availability !== undefined && task.work.availability !== 'actionable' && <p className="task-detail-notice">{task.work.availabilityReason}</p>}
    <section><h3>Why this order</h3><p>{reason ?? 'Not ranked yet. The next run considers this task alongside all your other work.'}</p></section>
    <label>Task notes<textarea id="task-notes" rows={6} value={task.notes} maxLength={16000}
      onChange={event => run(() => queue.edit(task.id, task.title, event.target.value))} /></label>
    <p className="field-help">Task notes inform Copilot's ranking.</p>
    {!!task.work?.evidence.length && <section><h3>What brought this task here</h3>
      <ol className="task-evidence">{task.work.evidence.map(item => <li key={`${item.source}:${item.streamId}:${item.id}`}>
        <p>{item.summary}</p><span>{item.source} · {date(item.at)}</span>
        <button className="text-button" onClick={() => run(() => controller.platform.launchWebUrl(item.url))}>Open request<ExternalLink size={12} /></button>
      </li>)}</ol></section>}
    {confirmUnsubscribe && <Modal title="Unsubscribe on GitHub" close={() => { if (!unsubscribing) setConfirmUnsubscribe(false); }}>
      <p>Stop following this conversation on GitHub? Your task, Done status and notes will stay unchanged.</p>
      <p>Direct mentions, team mentions and review requests can still notify you again.</p>
      {unsubscribeError && <p className="task-error" role="alert">{unsubscribeError}</p>}
      <footer className="modal-footer"><button className="secondary" disabled={unsubscribing} onClick={() => setConfirmUnsubscribe(false)}>Cancel</button>
        <button className="primary" disabled={unsubscribing} onClick={() => {
          setUnsubscribeError('');
          void queue.unsubscribe(task.id).then(() => setConfirmUnsubscribe(false))
            .catch(error => setUnsubscribeError(error instanceof Error ? error.message : 'Unsubscribe is not confirmed.'));
        }}>{unsubscribing ? 'Unsubscribing...' : 'Unsubscribe'}</button></footer>
    </Modal>}
  </aside>;
}

export function TaskApp({ controller, queue, reference }: {
  controller: DesktopWorkspace; queue: WorkQueue; reference: ServiceWorkspace;
}) {
  const saved = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const run = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [capture, setCapture] = useState(false);
  const [settings, setSettings] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [oldWorkspace, setOldWorkspace] = useState(() => window.location.hash === '#reference');
  const [selection, setSelection] = useState<string | null>(null);
  const [view, setView] = useState<'tasks' | 'done' | 'waiting'>('tasks');
  const invoke = (operation: () => Promise<unknown>) => { void operation().catch(error => controller.report(error)); };
  useEffect(() => { invoke(async () => { await controller.load(); if (controller.getSnapshot().workspace) await queue.tick(); }); }, [controller, queue]);
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen('work-tick', () => {
      if (controller.getSnapshot().workspace) invoke(() => queue.tick());
    }).then(release => { if (stopped) release(); else unlisten = release; })
      .catch(error => controller.report(new Error(`Scheduled runs are unavailable: ${error instanceof Error ? error.message : 'native clock connection failed'}`)));
    return () => { stopped = true; unlisten?.(); };
  }, [controller, queue]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCapture(true); }
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!saved.workspace) return <main className="task-loading"><h1>{saved.loading ? 'Reading saved tasks...' : 'Saved tasks could not load'}</h1>
    {saved.loadError && <p role="alert">{saved.loadError}</p>}
    {!saved.loading && <div className="button-row"><button className="primary" onClick={() => invoke(() => controller.reload())}>Retry</button>
      <button className="secondary" onClick={() => setRecovery(true)}>Backups & recovery</button></div>}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
  </main>;
  const state = saved.workspace.state;
  const ranked = rankedTasks(state);
  const done = state.tasks.filter(task => task.status === 'done');
  const waiting = state.tasks.filter(task => task.status === 'open' && task.work?.availability === 'waiting');
  const visible = view === 'done' ? done : view === 'waiting' ? waiting : ranked;
  const selected = state.tasks.find(task => task.id === selection);
  const reasons = new Map(state.work.ranking?.reasons.map(item => [item.id, item.reason]) ?? []);
  if (oldWorkspace) return <div className="task-reference"><div className="task-reference-back"><button className="secondary" onClick={() => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setOldWorkspace(false); setSettings(false);
  }}><ArrowLeft size={16} />Back to ranked tasks</button>
    <span>Saved conversations and thread notes</span></div><DesktopApp controller={controller} remote={reference} /></div>;
  return <div className="task-app">
    <a className="skip-link" href="#ranked-tasks">Skip to tasks</a>
    {!settings && <header className="task-top"><div className="task-brand"><ListOrdered size={22} /><h1>What’s next</h1></div>
      <div className="button-row"><button className="secondary" onClick={() => setCapture(true)}><Plus size={16} />Add task<span className="task-shortcut">⌘K</span></button>
        <button className="primary" disabled={run.running} onClick={() => invoke(() => queue.run())}><RefreshCw size={15} />{run.running ? 'Running...' : 'Run now'}</button>
        <button className="quiet" aria-label="Sources and priorities" onClick={() => setSettings(true)}><Settings2 size={18} /></button></div>
    </header>}
    {(run.error || state.work.lastError || saved.operationError || saved.persistence.error) && <div className="task-error" role="alert">
      <p>{saved.persistence.error || saved.operationError || run.error || state.work.lastError}</p>
      {saved.persistence.error && <button className="secondary" onClick={() => invoke(() => controller.retryStorage())}>Retry storage</button>}
    </div>}
    {settings ? <Settings settings={state.work.settings} queue={queue} close={() => setSettings(false)} recover={() => setRecovery(true)}
      reference={() => { window.history.replaceState(null, '', '#reference'); setOldWorkspace(true); }} /> : <>
      <div className="task-context"><p>{run.running ? run.phase : state.work.ranking ? `Ranked ${date(state.work.ranking.rankedAt)}` : 'Your tasks, in one place. Run Copilot to put them in order.'}</p>
        <span>{state.work.settings.schedule.enabled ? `Runs every ${state.work.settings.schedule.everyMinutes} min while open` : 'Manual runs'}</span></div>
      {!run.running && !state.work.lastError && state.work.collectionCursor && state.work.lastStartedAt
        && Date.parse(state.work.collectionCursor) < Date.parse(state.work.lastStartedAt)
        && <p className="task-detail-notice" role="status">More notification history remains. The next run continues after {date(state.work.collectionCursor)}.</p>}
      {!!run.warnings.length && <details className="task-run-details"><summary>Coverage and run details ({run.warnings.length})</summary>
        <ul>{run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className={`task-body ${selected ? 'task-with-detail' : ''}`}>
        <main id="ranked-tasks" className="task-main">
          <nav className="task-tabs" aria-label="Task lists">{([['tasks', 'To do', ranked.length], ['done', 'Done', done.length], ['waiting', 'No action now', waiting.length]] as const).map(([value, title, count]) =>
            <button key={value} aria-current={view === value ? 'page' : undefined} onClick={() => { setView(value); setSelection(null); }}>{title}<span>{count}</span></button>)}</nav>
          {visible.length ? <ol className="ranked-list" aria-label={view === 'tasks' ? 'Prioritized tasks' : view === 'done' ? 'Completed tasks' : 'Tasks with no action now'}>
            {visible.map((task, index) => <li key={task.id} data-task-id={task.id} className={task.id === selection ? 'task-selected' : ''}>
              <span className="task-rank" aria-label={view === 'tasks' ? `Rank ${index + 1}` : undefined}>{view === 'tasks' ? index + 1 : task.status === 'done' ? <Check size={16} /> : '—'}</span>
              <button className="task-row" aria-current={task.id === selection ? 'true' : undefined} onClick={() => setSelection(task.id)}>
                <span className="task-title">{task.title}</span>
                <span className="task-source">{source(task)}</span>
                <span className="task-reason">{view === 'waiting' ? task.work?.availabilityReason : view === 'done' ? `Done ${date(task.completedAt ?? null)}`
                  : reasons.get(task.id) ?? 'Not ranked yet · included on the next run'}</span>
                {task.work?.availability === 'unknown' && <span className="task-uncertain">{task.work.availabilityReason || 'Source state could not be confirmed.'}</span>}
              </button>
              {view === 'tasks' && <button className="task-complete" aria-label={`Mark done: ${task.title}`} onClick={() => {
                try { queue.complete(task.id); } catch (error) { controller.report(error); }
              }}><Check size={17} /></button>}
            </li>)}
          </ol> : <div className="task-empty"><h2>{view === 'done' ? 'Nothing completed yet' : view === 'waiting' ? 'No tasks waiting on other people or systems' : 'No tasks to act on'}</h2>
            <p>{view === 'done' ? 'Completed work stays here. Repeated searches will not put it back on your list.'
              : view === 'waiting' ? 'Tasks linked to queued, closed or merged work leave the active list without being marked Done.'
                : 'Add a task, or run your sources to find work. Only actionable requests belong on this list.'}</p>
            {view === 'tasks' && <div className="button-row"><button className="secondary" onClick={() => setCapture(true)}>Add a task</button>
              <button className="quiet" onClick={() => setSettings(true)}>Choose sources and priorities</button></div>}
          </div>}
        </main>
        {selected && <TaskDetail key={selected.id} task={selected} reason={reasons.get(selected.id)} queue={queue} controller={controller} close={() => setSelection(null)} />}
      </div>
    </>}
    <footer className="task-footer workspace-footer"><span role="status">{saved.persistence.pending ? 'Saving on this Mac...' : saved.persistence.error ? 'Not saved' : 'Saved on this Mac'}</span>
      <span>{run.running ? 'Collecting and ranking; local edits remain available' : `Last successful run: ${date(state.work.lastCompletedAt)}`}</span></footer>
    {capture && <Capture queue={queue} close={() => setCapture(false)} />}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
  </div>;
}
