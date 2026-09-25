import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Check, ExternalLink, Github, ListFilter, ListOrdered, Plus, RefreshCw, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { Modal } from '../Modal.tsx';
import { ConnectionsPanel, RecoveryPanel } from '../runtime/NativePanels.tsx';
import { DestinationPanel } from '../runtime/DestinationPanel.tsx';
import { ConversationReader } from '../runtime/ConversationReader.tsx';
import { getRow } from '../domain/engine.ts';
import { referenceSchema } from '../../service/src/schema.ts';
import type { Destination } from '../runtime/view.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { ServiceWorkspace } from '../runtime/service-workspace.ts';
import type { Task } from '../types.ts';
import { WorkQueue } from './controller.ts';
import { canonicalSource, rankedTasks } from './engine.ts';
import { Settings } from './Settings.tsx';
import { RunProgress } from './RunProgress.tsx';
import { workProfiles } from './profiles.ts';
import { matchesSources, sourceCounts, taskSources } from './filters.ts';
import { SourceTree } from './SourceTree.tsx';
import { TaskAssessmentHistory } from './AssessmentHistory.tsx';
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
function NewProfile({ queue, currentName, close, created }: {
  queue: WorkQueue; currentName: string; close: () => void; created: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [copySettings, setCopySettings] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="Add work profile" close={close} initialFocus={ref}>
    <form onSubmit={event => {
      event.preventDefault();
      try { queue.createProfile(name, copySettings); created(); close(); }
      catch (error) { setError(error instanceof Error ? error.message : 'The work profile could not be created.'); }
    }}>
      <label htmlFor="new-profile-name">Profile name</label>
      <input id="new-profile-name" ref={ref} value={name} maxLength={80} required
        placeholder="For example, On call" onChange={event => setName(event.target.value)} />
      <p className="field-help">Start with an empty task list. Your other profiles keep their tasks and Done history.</p>
      <label className="checkbox-label"><input type="checkbox" checked={copySettings}
        onChange={event => setCopySettings(event.target.checked)} />Copy saved instructions and sources from {currentName}</label>
      <p className="field-help">Without a copy, instructions and sources start empty. Automatic runs start off.</p>
      {error && <p className="task-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={!name.trim()}>Create profile</button></footer>
    </form>
  </Modal>;
}
function TaskDetail({ task, reason, queue, controller, remote, close }: {
  task: Task; reason?: string; queue: WorkQueue; controller: DesktopWorkspace; remote: ServiceWorkspace; close: () => void;
}) {
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false);
  const [unsubscribeError, setUnsubscribeError] = useState('');
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const unsubscribing = !!task.work && status.unsubscribing.includes(canonicalSource(task.work.url));
  const subscription = task.work?.unsubscribe;
  const threads = controller.state.threads.filter(thread => thread.id === task.threadId
    || (task.work && canonicalSource(`https://github.com/${thread.repo}/issues/${thread.number}`) === canonicalSource(task.work.url)));
  const notes = controller.state.notes.filter(note => threads.some(thread => thread.id === note.threadId));
  const url = task.work ? new URL(task.work.url) : null;
  const match = url?.hostname === 'github.com' ? /^\/([^/]+\/[^/]+)\/(pull|pulls|issues)\/(\d+)\/?$/.exec(url.pathname) : null;
  const thread = threads[0];
  const parsed = referenceSchema.safeParse(task.work?.notification?.reference ?? (thread && {
    repo: thread.repo, kind: thread.kind, number: thread.number,
  }) ?? (match && {
    repo: match[1], kind: match[2] === 'issues' ? 'issue' : 'pr', number: Number(match[3]),
  }));
  const reference = parsed.success ? parsed.data : null;
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
    <TaskAssessmentHistory key={task.id} task={task} controller={controller} />
    <label>Task notes<textarea id="task-notes" rows={6} value={task.notes} maxLength={16000}
      onChange={event => run(() => queue.edit(task.id, task.title, event.target.value))} /></label>
    <p className="field-help">Task notes inform Copilot's ranking.</p>
    {!!task.work?.evidence.length && <section><h3>What brought this task here</h3>
      <ol className="task-evidence">{task.work.evidence.map(item => <li key={`${item.source}:${item.streamId}:${item.id}`}>
        <p>{item.summary}</p><span>{item.source} · {date(item.at)}</span>
        <button className="text-button" onClick={() => run(() => controller.platform.launchWebUrl(item.url))}>Open request<ExternalLink size={12} /></button>
      </li>)}</ol></section>}
    {notes.length > 0 && <section><h3>Saved thread notes</h3>
      <p className="field-help">Private notes from the previous workspace. These do not inform Copilot's ranking.</p>
      {notes.map((note, index) => <div key={note.id}>
        <label htmlFor={`thread-note-${index}`}>{index ? `Thread note ${index + 1}` : 'Thread notes'}</label>
        {note.sourceTitle && <p className="field-help">{note.sourceTitle}</p>}
        <textarea id={`thread-note-${index}`} rows={4} value={note.text} onChange={event => controller.dispatch({
          type: 'note', threadId: note.threadId, noteId: note.id, text: event.target.value,
        })} />
      </div>)}
    </section>}
    {reference && <ConversationReader reference={reference} controller={remote.conversation}
      platform={controller.platform} refreshing={false} timeZone={controller.state.timeZone} />}
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

export function TaskApp({ controller, queue, remote }: {
  controller: DesktopWorkspace; queue: WorkQueue; remote: ServiceWorkspace;
}) {
  const saved = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const run = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const network = useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  const [capture, setCapture] = useState(false);
  const [newProfile, setNewProfile] = useState(false);
  const [settings, setSettings] = useState(false);
  const [filters, setFilters] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [connections, setConnections] = useState(false);
  const [destination, setDestination] = useState<Destination>();
  const [selection, setSelection] = useState<string | null>(null);
  const [view, setView] = useState<'tasks' | 'done' | 'waiting'>('tasks');
  const invoke = (operation: () => Promise<unknown>) => { void operation().catch(error => controller.report(error)); };
  useEffect(() => { invoke(async () => { await controller.load(); if (controller.getSnapshot().workspace) await queue.tick(); }); }, [controller, queue]);
  useEffect(() => {
    if (window.location.hash === '#reference') window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
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
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setSelection(null);
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
  const runError = run.error || (run.running ? '' : state.work.lastError);
  const error = saved.persistence.error || saved.assessmentError || saved.operationError || (settings ? runError : '');
  const runDetails = [...new Set([...run.warnings, ...runError.split('\n').filter(Boolean)])];
  const profileBusy = run.running || run.unsubscribing.length > 0;
  const ranked = rankedTasks(state);
  const done = state.tasks.filter(task => task.status === 'done');
  const waiting = state.tasks.filter(task => task.status === 'open' && task.work?.availability === 'waiting');
  const sources = taskSources(state.work.settings, state.tasks);
  const sourceFilter = state.work.sourceFilter ?? { selectedSources: null, collapsedProviders: [] };
  const selectedSources = sourceFilter.selectedSources;
  const selectedSourceCount = sources.filter(item => selectedSources === null || selectedSources.includes(item.id)).length;
  const filterTasks = (tasks: Task[]) => filters ? tasks.filter(task => matchesSources(task, selectedSources)) : tasks;
  const filteredRanked = filterTasks(ranked);
  const filteredDone = filterTasks(done);
  const filteredWaiting = filterTasks(waiting);
  const unfiltered = view === 'done' ? done : view === 'waiting' ? waiting : ranked;
  const visible = view === 'done' ? filteredDone : view === 'waiting' ? filteredWaiting : filteredRanked;
  const selected = state.tasks.find(task => task.id === selection && (!filters || matchesSources(task, selectedSources)));
  const positions = new Map(ranked.map((task, index) => [task.id, index + 1]));
  const saveFilter = (next: typeof sourceFilter) => {
    try {
      queue.saveSourceFilter(next);
      if (selected && !matchesSources(selected, next.selectedSources)) setSelection(null);
    } catch (error) { controller.report(error); }
  };
  const selectAllSources = () => saveFilter({ ...sourceFilter, selectedSources: null });
  const reasons = new Map(state.work.ranking?.reasons.map(item => [item.id, item.reason]) ?? []);
  return <div className={`task-app ${filters && !settings ? 'task-filter-view' : ''}`}>
    <a className="skip-link" href={settings ? '#task-settings' : '#ranked-tasks'}>Skip to {settings ? 'settings' : 'tasks'}</a>
    <aside className="task-sidebar" aria-label="Workspace navigation">
      <div className="task-brand"><Github size={20} /><span>GitHub Projects</span></div>
      <button className="secondary task-capture" onClick={() => setCapture(true)}><Plus size={16} />Add task<span className="task-shortcut">⌘K</span></button>
      <nav aria-label="Workspace">
        <button className="nav-link" aria-current={!settings && !filters ? 'page' : undefined} onClick={() => { setSettings(false); setFilters(false); }}>
          <ListOrdered size={17} />Ranked Tasks<span className="count">{ranked.length}</span></button>
        <button className="nav-link" aria-current={!settings && filters ? 'page' : undefined}
          aria-expanded={!settings && filters} aria-controls="task-source-tree" onClick={() => { setSettings(false); setFilters(true); }}>
          <ListFilter size={17} />Filters<span className="count">{ranked.filter(task => matchesSources(task, selectedSources)).length}</span></button>
        {filters && !settings && <SourceTree key={state.activeWorkProfile.id} sources={sources} selected={selectedSources}
          collapsed={sourceFilter.collapsedProviders} counts={sourceCounts(unfiltered)} selectAll={selectAllSources}
          toggle={(ids, checked) => {
            const next = new Set(selectedSources ?? sources.map(item => item.id));
            for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
            saveFilter({ ...sourceFilter, selectedSources: [...next] });
          }} collapse={(provider, closed) => saveFilter({ ...sourceFilter, collapsedProviders: closed
            ? [...sourceFilter.collapsedProviders, provider] : sourceFilter.collapsedProviders.filter(item => item !== provider) })} />}
      </nav>
      <div className="task-sidebar-bottom">
        <button className="nav-link" aria-current={settings ? 'page' : undefined} onClick={() => setSettings(true)}><Settings2 size={17} />Settings</button>
        <button className="nav-link" onClick={() => setConnections(true)}><SlidersHorizontal size={17} />Connections</button>
        <p>Local workspace</p>
      </div>
    </aside>
    <div className="task-workspace">
    {!settings && <header className="task-top"><h1>{filters ? 'Filters' : 'Ranked Tasks'}</h1>
      <button className="primary" disabled={run.running} onClick={() => invoke(() => queue.run())}><RefreshCw size={15} />{run.running ? 'Running...' : 'Run now'}</button>
    </header>}
    {!settings && <div className="task-profile-bar">
      <label htmlFor="work-profile">Work profile</label>
      <select id="work-profile" value={state.activeWorkProfile.id} disabled={profileBusy}
        aria-describedby="work-profile-help" onChange={event => {
          try { queue.switchProfile(event.target.value); setSelection(null); setView('tasks'); }
          catch (error) { controller.report(error); }
        }}>
        {workProfiles(state).map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
      <button className="quiet" disabled={profileBusy} onClick={() => setNewProfile(true)}><Plus size={15} />Add profile</button>
      <p id="work-profile-help" className="field-help">{profileBusy
        ? 'Profiles can be switched after the current run or unsubscribe finishes.'
        : 'Only this profile collects and ranks work. Other task lists stay saved.'}</p>
    </div>}
    {error && <div className="task-error" role="alert">
      <p>{error}</p>
      {saved.persistence.error && <button className="secondary" onClick={() => invoke(() => controller.retryStorage())}>Retry storage</button>}
      {saved.assessmentError && <div className="button-row">
        <button className="secondary" disabled={saved.assessmentSaving} onClick={() => invoke(() => controller.retryAssessments())}>Retry assessment save</button>
        <button className="secondary" onClick={() => setRecovery(true)}>Export pending results</button>
      </div>}
    </div>}
    {saved.assessmentQuarantined.length > 0 && <div className="task-run-details" role="status">
      <p>{saved.assessmentQuarantined.length} results from a previous workspace are kept separately in this session. Export before quitting. Current runs and saves are unaffected.</p>
      <button className="secondary" onClick={() => setRecovery(true)}>Export previous workspace results</button>
    </div>}
    {settings ? <Settings key={state.activeWorkProfile.id} profileName={state.activeWorkProfile.name}
      settings={state.work.settings} queue={queue} close={() => setSettings(false)} recover={() => setRecovery(true)} /> : <>
      {!run.progress && <div className="task-context"><p>{state.work.ranking ? `Ranked ${date(state.work.ranking.rankedAt)}` : 'Your tasks, in one place. Run Copilot to put them in order.'}</p>
        <span>{state.work.settings.schedule.enabled ? `Runs every ${state.work.settings.schedule.everyMinutes} min while open` : 'Manual runs'}</span></div>}
      {!run.running && !state.work.lastError && state.work.collectionCursor && state.work.lastStartedAt
        && Date.parse(state.work.collectionCursor) < Date.parse(state.work.lastStartedAt)
        && <p className="task-detail-notice" role="status">More notification history remains. The next run continues after {date(state.work.collectionCursor)}.</p>}
      <RunProgress key={state.activeWorkProfile.id} run={run} details={runDetails} />
      {filters && <div className="task-filter-summary">
        <span role="status"><strong>{visible.length} of {unfiltered.length} {view === 'tasks' ? 'to dos' : view === 'done' ? 'completed tasks' : 'tasks with no action now'}</strong>
          <span>From {selectedSourceCount} selected {selectedSourceCount === 1 ? 'source' : 'sources'}</span></span>
        <button className="text-button" onClick={selectAllSources}>Show all sources</button>
      </div>}
      <div className={`task-body ${selected ? 'task-with-detail' : ''}`}>
        <main id="ranked-tasks" className="task-main">
          <nav className="task-tabs" aria-label="Task lists">{([['tasks', 'To do', filteredRanked.length], ['done', 'Done', filteredDone.length], ['waiting', 'No action now', filteredWaiting.length]] as const).map(([value, title, count]) =>
            <button key={value} aria-current={view === value ? 'page' : undefined} onClick={() => { setView(value); setSelection(null); }}>{title}<span>{count}</span></button>)}</nav>
          {filters && view === 'tasks' && <p className="task-filter-order">Original ranks · Same order as Ranked Tasks</p>}
          {visible.length ? <ol className="ranked-list" aria-label={view === 'tasks' ? 'Prioritized tasks' : view === 'done' ? 'Completed tasks' : 'Tasks with no action now'}>
            {visible.map(task => <li key={task.id} data-task-id={task.id} className={task.id === selection ? 'task-selected' : ''}>
              <span className="task-rank" aria-label={view === 'tasks' ? `Rank ${positions.get(task.id)}` : undefined}>{view === 'tasks' ? positions.get(task.id) : task.status === 'done' ? <Check size={16} /> : '—'}</span>
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
          </ol> : filters ? <div className="task-empty">
            <h2>{selectedSourceCount ? 'No matching tasks' : 'No sources selected'}</h2>
            <p>{selectedSourceCount ? 'The selected sources have no tasks in this tab. Choose another source or task tab.'
              : 'Select a source in the sidebar to show its tasks. Your tasks are still saved.'}</p>
            <div className="button-row"><button className="secondary" onClick={selectAllSources}>Show all sources</button></div>
          </div> : <div className="task-empty"><h2>{view === 'done' ? 'Nothing completed yet' : view === 'waiting' ? 'No tasks waiting on other people or systems' : 'No tasks to act on'}</h2>
            <p>{view === 'done' ? 'Completed work stays here. Repeated searches will not put it back on your list.'
              : view === 'waiting' ? 'Tasks linked to queued, closed or merged work leave the active list without being marked Done.'
                : 'Add a task, or run your sources to find work. Only actionable requests belong on this list.'}</p>
            {view === 'tasks' && <div className="button-row"><button className="secondary" onClick={() => setCapture(true)}>Add a task</button>
              <button className="quiet" onClick={() => setSettings(true)}>Choose sources and priorities</button></div>}
          </div>}
        </main>
        {selected ? <TaskDetail key={`${state.activeWorkProfile.id}:${selected.id}`} task={selected} reason={reasons.get(selected.id)}
          queue={queue} controller={controller} remote={remote} close={() => setSelection(null)} />
          : <aside className="task-detail task-detail-empty" aria-label="Task details"><h2>Select a task</h2><p>See why it ranks here, read its source, and keep your notes alongside.</p></aside>}
      </div>
    </>}
    <footer className="task-footer workspace-footer"><span role="status">{saved.persistence.pending ? 'Saving on this Mac...' : saved.persistence.error ? 'Not saved'
      : saved.assessmentPending.length ? 'Task edits saved; assessments pending' : 'Saved on this Mac'}</span>
      {run.progress && <span>{state.work.settings.schedule.enabled ? `Runs every ${state.work.settings.schedule.everyMinutes} min while open` : 'Manual runs'}</span>}
      <span>{run.running ? 'Collecting and ranking; local edits remain available' : `Last successful run: ${date(state.work.lastCompletedAt)}`}</span></footer>
    </div>
    {capture && <Capture queue={queue} close={() => setCapture(false)} />}
    {newProfile && <NewProfile queue={queue} currentName={state.activeWorkProfile.name} close={() => setNewProfile(false)}
      created={() => { setSelection(null); setView('tasks'); setSettings(true); }} />}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
    {connections && <ConnectionsPanel controller={controller} checking={network.checking} diagnostics={network.diagnostics}
      check={() => invoke(() => remote.check())} recover={() => { setConnections(false); setRecovery(true); }}
      close={() => setConnections(false)} retryOperation={id => {
        const operation = state.operations.find(operation => operation.id === id);
        const row = operation && getRow(state, `t:${operation.threadId}`);
        if (row && operation) { setConnections(false); setDestination({ row, kind: 'notification', action: operation.action, retryId: id }); }
      }} />}
    {destination && <DestinationPanel destination={destination} controller={controller} remote={remote} close={() => setDestination(undefined)} />}
  </div>;
}
