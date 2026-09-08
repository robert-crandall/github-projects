import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCheck, ChevronDown, Clock3, Download, Folder, Inbox, Layers2, ListFilter, Pause, Plus, RefreshCw, RotateCcw, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { useWorkspace } from './useWorkspace.ts';
import { outstanding } from './domain/clock.ts';
import { isActionable, rankedItems } from './domain/ranking.ts';
import type { Command, Scenario, WorkItem } from './domain/types.ts';
import { CapturePanel } from './components/Capture.tsx';
import { Projects } from './components/Projects.tsx';
import { day, FocusWork, stamp, WorkDetail, WorkRow } from './components/Work.tsx';
import { Connections } from './components/Connections.tsx';
import { desktop, errorText } from './desktop.ts';
import { downloadCaptures } from './export.ts';
import appLogo from './assets/github-projects.png';

type View = 'now' | 'waiting' | 'projects' | 'captures' | 'history' | 'connections';
const scenarios: { id: Scenario; title: string; detail: string }[] = [
  { id: 'before', title: 'Before 10am', detail: 'Next 09:40; saved progress stays intact.' },
  { id: 'due', title: 'Routine due', detail: 'Move forward to the next daily due time.' },
  { id: 'arrival', title: 'New review arrives', detail: 'Your active action stays in Now.' },
  { id: 'missed', title: 'Return after 3 days', detail: 'One outstanding routine, with missed-day history.' },
  { id: 'empty', title: 'No actionable work', detail: 'Set available work aside. Undo brings it back.' },
  { id: 'sync-error', title: 'Simulate sync error', detail: 'Retain the last successful sample data.' },
  { id: 'interpretation-error', title: 'Simulate interpretation error', detail: 'Captures still save before the simulated failure.' },
];

export function App() {
  const workspace = useWorkspace();
  const { state, storageError, blocked, actionError, feedback } = workspace;
  const [view, setView] = useState<View>('now');
  const [detailId, setDetailId] = useState<string>();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [exportError, setExportError] = useState('');
  const timeZone = desktop ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const ranked = rankedItems(state);
  const now = ranked[0];
  const next = ranked.slice(1);
  const waiting = state.items.filter((item) => item.status === 'waiting');
  const later = state.items.filter((item) => !isActionable(item, state) && ['available', 'deferred'].includes(item.status));
  const history = state.items.filter((item) => ['completed', 'removed'].includes(item.status));
  const detail = state.items.find((item) => item.id === detailId);
  const dueNotice = state.items.find((item) => {
    const occurrence = outstanding(item);
    return item.id !== now?.id && isActionable(item, state) && occurrence?.reminderAt && !occurrence.reminderDismissed;
  });
  const lastUndo = state.undo.at(-1);
  const unavailable = state.sync.status !== 'ok' || blocked;
  const emptyMessage = unavailable
    ? desktop ? 'GitHub data is not available. Capture work now, or check your connection.' : 'Data is unavailable. This is not confirmation that there is no work.'
    : 'Your deferred and waiting work is still here. Capture anything else on your mind.';
  const syncLabel = desktop
    ? !state.sync.login ? 'GitHub not yet synced' : state.sync.status === 'error' ? 'Showing saved GitHub data' : `GitHub / ${state.sync.login} + your captures`
    : state.sync.status === 'error' ? 'Sample data unavailable to refresh' : 'Synthetic GitHub + your captures';

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCaptureOpen((open) => !open);
      }
      if (event.key === 'Escape') { setCaptureOpen(false); setDemoOpen(false); }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    listen('desktop-capture', () => setCaptureOpen(true)).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(error => workspace.setNativeError(errorText(error)));
    return () => { disposed = true; stop?.(); };
  }, [workspace.setNativeError]);

  function navigate(target: View) {
    setView(target);
    setDetailId(undefined);
  }
  function openItem(id: string) {
    setDetailId(id);
    setCaptureOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  async function commit(command: Command, message = '') {
    const saved = desktop && command.type === 'interpret'
      ? await workspace.interpretCapture(command.captureId)
      : await workspace.commit(command, message);
    if (saved && (command.type === 'start' || command.type === 'complete')) navigate('now');
    return saved;
  }
  async function runScenario(scenario: Scenario) {
    if (await commit({ type: 'scenario', scenario }, scenario === 'reset' ? 'Samples reset. Your captures are retained.' : 'Demo scenario applied.')) {
      navigate('now');
      setDemoOpen(false);
    }
  }
  function rows(items: WorkItem[]) {
    return <ul className="work-list">{items.map((item, index) => <WorkRow key={item.id} item={item} state={state} open={openItem} commit={commit} number={index + 1} />)}</ul>;
  }

  if (workspace.loading) return <main><div className="page-heading"><h1>GitHub Projects</h1><p role="status">Opening your saved workspace...</p></div></main>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-workspace">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={appLogo} width={32} height={32} alt="" /><span>GitHub Projects</span></div>
      <button className="capture-trigger secondary" onClick={() => setCaptureOpen((open) => !open)} aria-expanded={captureOpen}><Plus size={18} />Capture<span className="shortcut">Cmd K</span></button>
      <nav aria-label="Main navigation">
        <button className={view === 'now' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('now')} aria-current={view === 'now' && !detail ? 'page' : undefined}><Layers2 size={18} />Now<span className="nav-marker" /></button>
        <button className={view === 'waiting' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('waiting')} aria-current={view === 'waiting' && !detail ? 'page' : undefined}><Pause size={18} />Waiting<span className="count">{waiting.length}</span></button>
        <button className={view === 'captures' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('captures')} aria-current={view === 'captures' && !detail ? 'page' : undefined}><Inbox size={18} />Captures<span className="count">{state.captures.length}</span></button>
        <div className="nav-divider" />
        <button className={view === 'projects' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('projects')} aria-current={view === 'projects' && !detail ? 'page' : undefined}><Folder size={18} />Projects</button>
        <button className={view === 'history' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('history')} aria-current={view === 'history' && !detail ? 'page' : undefined}><CheckCheck size={18} />History</button>
        {desktop && <button className={view === 'connections' && !detail ? 'nav-item selected' : 'nav-item'} onClick={() => navigate('connections')} aria-current={view === 'connections' && !detail ? 'page' : undefined}><Settings2 size={18} />Connections</button>}
      </nav>
      <div className="sidebar-bottom">
        <button className="quiet undo-control" disabled={!lastUndo} onClick={() => commit({ type: 'undo' }, 'Undone.')} title={lastUndo ? `Undo ${lastUndo.label}` : 'Nothing to undo'}><RotateCcw size={15} />Undo last change</button>
        <div className="demo-clock"><Clock3 size={15} /><div><strong>{new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(state.clock))}</strong><span>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(new Date(state.clock))} / {desktop ? timeZone : 'Simulated UTC'}</span></div></div>
        {!desktop && <button className={`demo-trigger quiet ${demoOpen ? 'selected' : ''}`} aria-expanded={demoOpen} onClick={() => setDemoOpen((open) => !open)}><SlidersHorizontal size={16} />Demo scenarios<ChevronDown size={14} /></button>}
        <div className="prototype-label">{desktop ? 'Local desktop app' : 'Browser prototype'} <span aria-hidden="true">/</span> Dusk</div>
      </div>
    </aside>
    <div className="workspace-column">
      <header className="topbar"><div><span className="connection-dot" aria-hidden="true" />{syncLabel}{desktop && <button className="icon-button" disabled={workspace.syncing} aria-label="Refresh GitHub" onClick={() => void workspace.syncGitHub()}><RefreshCw size={14} /></button>}</div><span className="storage-indicator">{storageError ? <AlertCircle size={14} /> : workspace.pendingSaves ? null : <Check size={14} />}{storageError ? 'Not saved' : workspace.pendingSaves ? 'Saving...' : desktop ? 'Saved on this Mac' : 'Saved in this browser'}</span></header>
      <main id="main-workspace" tabIndex={-1}>
        {storageError && <section className="error-panel" role="alert"><AlertCircle size={20} /><div><h2>Local changes are not saved</h2><p>{storageError}</p><div className="button-row"><button className="secondary" onClick={() => workspace.retryStorage()}>Retry local storage</button>{blocked && !desktop && <button className="quiet" onClick={() => workspace.retryStorage(true)}>Back up existing data &amp; start fresh</button>}{desktop && <button className="quiet" onClick={() => navigate('connections')}>Export pending work</button>}</div></div></section>}
        {actionError && <p className="error-panel" role="alert"><AlertCircle size={18} />{actionError}</p>}
        {state.sync.status === 'error' && <section className="error-panel" role="status"><AlertCircle size={20} /><div><h2>{desktop ? 'GitHub refresh failed' : 'Simulated sync failed'}</h2><p>{desktop ? state.sync.error : `Showing the last successful fixtures from ${stamp(state.sync.lastSuccessAt)}. This is not an empty inbox.`}</p>{desktop ? <button className="quiet" onClick={() => navigate('connections')}>Check connections</button> : <button className="quiet" onClick={() => runScenario('recover')}><RotateCcw size={15} />Restore simulated sync</button>}</div></section>}
        {desktop && state.sync.warnings?.map(warning => <p className="notice-inline warning" key={warning}>{warning}</p>)}
        {desktop && workspace.aiError && <section className="notice-panel warning" role="status"><AlertCircle size={18} /><div><strong>Copilot suggestions unavailable</strong><p>{workspace.aiError}</p><p>Your work is saved. Default ordering remains available.</p><button className="quiet" onClick={() => navigate('connections')}>Check Copilot</button></div></section>}
        {desktop && workspace.nativeError && <section className="notice-panel warning" role="status"><AlertCircle size={18} /><div>{workspace.nativeError}<button className="quiet" onClick={() => navigate('connections')}>Reminder settings</button></div></section>}
        {!desktop && state.interpretationError && <section className="notice-panel warning"><AlertCircle size={18} /><div>Interpretation error simulation is on. Original captures still save.<button className="quiet" onClick={() => runScenario('recover')}>Turn simulation off</button></div></section>}
        {!desktop && demoOpen && <section className="demo-panel" aria-label="Demo scenarios">
          <div className="section-heading"><h2>Demo scenarios</h2><button className="icon-button" aria-label="Close demo scenarios" onClick={() => setDemoOpen(false)}><X size={18} /></button></div>
          <p className="subtle">{stamp(state.clock)} UTC, simulated. Time moves forward only. No live sync, AI, or OS notifications.</p>
          <div className="scenario-grid">{scenarios.map((scenario) => <button className="scenario-button" key={scenario.id} onClick={() => runScenario(scenario.id)}><strong>{scenario.title}</strong><span>{scenario.detail}</span><ArrowRight size={15} /></button>)}</div>
          <div className="demo-footer"><button className="secondary" onClick={() => commit({ type: 'advance', to: new Date(Date.parse(state.clock) + 30 * 60_000).toISOString() }, 'Demo clock advanced 30 minutes.')}><Clock3 size={15} />Advance 30 minutes</button><button className="quiet" onClick={() => runScenario('reset')}><RotateCcw size={15} />Reset samples, keep my captures</button></div>
        </section>}
        {captureOpen && <CapturePanel state={state} commit={commit} close={() => setCaptureOpen(false)} openItem={openItem} saving={workspace.pendingSaves > 0} saveError={storageError} />}
        {detail ? <WorkDetail key={detail.id} item={detail} state={state} commit={commit} back={() => setDetailId(undefined)} /> : <>
          {view === 'now' && <>
            <div className="page-heading now-heading"><div><h1>Now</h1><p>{state.activeId ? 'Right where you left off.' : 'A place to pick up, not keep up.'}</p></div><span className="heading-date">{day(state.clock)}</span></div>
            {now ? <FocusWork key={now.id} item={now} state={state} commit={commit} open={openItem} /> : <section className="empty-state"><CheckCheck size={28} strokeWidth={1.5} /><h2>{unavailable ? 'No actionable items in the saved view' : 'Nothing needs your attention now.'}</h2><p>{emptyMessage}</p><div className="button-row"><button className="secondary" onClick={() => setCaptureOpen(true)}><Plus size={17} />Capture something</button>{desktop && state.sync.status !== 'ok' && <button className="quiet" onClick={() => navigate('connections')}>Connect GitHub</button>}</div></section>}
            {dueNotice && <section className="routine-reminder" aria-label={desktop ? 'Routine reminder' : 'Simulated routine reminder'}>
              <Clock3 size={19} className="warning" /><div><strong>Your routine is due.</strong><p>{desktop ? 'Your active action stays put.' : 'One simulated reminder. Your active action stays put.'}</p></div>
              <div className="button-row"><button className="secondary" onClick={() => openItem(dueNotice.id)}>View routine</button><button className="quiet" onClick={() => commit({ type: 'snooze', id: dueNotice.id, minutes: 30 }, desktop ? 'Snoozed for 30 minutes.' : 'Snoozed for 30 demo minutes.')}>Snooze 30m</button><button className="quiet" onClick={() => commit({ type: 'skip', id: dueNotice.id }, 'Occurrence skipped. The daily routine remains.')}>Skip</button><button className="icon-button" aria-label={desktop ? 'Dismiss reminder' : 'Dismiss simulated reminder'} onClick={() => commit({ type: 'dismiss-reminder', id: dueNotice.id })}><X size={16} /></button></div>
            </section>}
            {now?.routine && !state.activeId && <div className="routine-options"><span className="subtle">{desktop ? 'One reminder. No repeated nudges.' : 'One simulated reminder; no OS notification.'}</span><button className="quiet" onClick={() => commit({ type: 'snooze', id: now.id, minutes: 30 }, desktop ? 'Snoozed for 30 minutes.' : 'Snoozed for 30 demo minutes.')}>Snooze 30m</button><button className="quiet" onClick={() => commit({ type: 'skip', id: now.id }, 'Occurrence skipped. The daily routine remains.')}>Skip occurrence</button></div>}
            <section className="next-section" aria-labelledby="next-heading"><div className="section-heading"><h2 id="next-heading">Next <span className="section-count">{next.length}</span></h2><span className="subtle">Choose something else</span></div>
              {next.length ? rows(showAll ? next : next.slice(0, 4)) : <p className="quiet-empty">No other available actions. Later and Waiting are kept separate.</p>}
              {next.length > 4 && <button className="quiet show-all" onClick={() => setShowAll((all) => !all)}>{showAll ? 'Show fewer' : `Show all ${next.length} available actions`}<ChevronDown size={15} /></button>}
            </section>
            <details className="later-section" open={laterOpen} onToggle={(event) => setLaterOpen(event.currentTarget.open)}><summary><span><Clock3 size={18} />Later <span className="section-count">{later.length}</span></span><span className="later-summary">{desktop ? 'Sleeping, future & someday' : 'Future, deferred & someday'}<ChevronDown size={15} /></span></summary><div>{later.length ? rows(later) : <p className="quiet-empty">Nothing set aside.</p>}</div></details>
            <details className="ranking-explainer"><summary><ListFilter size={14} />How this is ordered</summary><p>Active work stays first. Then due routines, small reviews, and other available work. Older evidence breaks ties. Small-review claims use {desktop ? 'recorded' : 'fixture'} diffs, not time estimates. No review quota.</p>{desktop && <><p>{state.aiRanking?.summary || 'Using default ordering until Copilot provides a suggestion.'}</p><button className="quiet" disabled={workspace.aiBusy} onClick={() => void workspace.prioritize()}>{workspace.aiBusy ? 'Considering your work...' : 'Ask Copilot to reconsider'}</button></>}</details>
          </>}
          {view === 'waiting' && <><div className="page-heading"><h1>Waiting</h1><p>Blocked on someone else, not work you chose to defer.</p></div>{waiting.length ? rows(waiting) : <div className="empty-state"><Pause size={25} /><h2>Nothing waiting on someone else.</h2><p>Use an action's Waiting control to keep the reason with it.</p></div>}</>}
          {view === 'projects' && <Projects state={state} commit={commit} openItem={openItem} />}
          {view === 'captures' && <><div className="page-heading"><h1>Captures</h1><p>Your original words, kept even when interpretation cannot help.</p></div>{!desktop && <button className="quiet" onClick={() => {
            try { downloadCaptures(state); setExportError(''); }
            catch (error) { setExportError(errorText(error)); }
          }}><Download size={15} />Export captures for desktop</button>}{exportError && <p className="error-panel" role="alert">{exportError}</p>}{state.captures.length ? <ul className="capture-log">{[...state.captures].reverse().map((capture) => <li key={capture.id}><button onClick={() => openItem(capture.itemId)}><span className="capture-log-time">{stamp(capture.createdAt)}<span>{capture.interpretation === 'error' ? 'Interpretation failed; original saved' : capture.interpretation === 'unsupported' ? 'Saved without interpretation' : `${desktop ? '' : 'Simulated '}${capture.interpretation}`}</span></span><span className="preserve-text">{capture.original}</span><ArrowRight size={17} /></button></li>)}</ul> : <div className="empty-state"><Inbox size={28} /><h2>A request, a link, a loose end.</h2><p>No captures yet. You don't need to know where it belongs.</p><button className="secondary" onClick={() => setCaptureOpen(true)}><Plus size={17} />Capture something</button></div>}</>}
          {view === 'connections' && <Connections workspace={workspace} />}
          {view === 'history' && <><div className="page-heading"><h1>History</h1><p>Local decisions, not proof of work in GitHub or Slack.</p></div>{lastUndo && <button className="secondary history-undo" onClick={() => commit({ type: 'undo' }, 'Undone.')}><RotateCcw size={15} />Undo {lastUndo.label}</button>}{history.length ? rows(history) : <p className="quiet-empty">No completed or removed actions yet.</p>}<section className="section-space"><div className="section-heading"><h2>Routine occurrences</h2></div><p className="subtle">Inspect a routine for completed, skipped, and missed dates.</p>{rows(state.items.filter((item) => item.routine))}</section></>}
        </>}
        <footer className="workspace-footer"><span>{desktop ? !state.sync.login ? 'GitHub has not synced successfully yet' : `Last successful sync: ${stamp(state.sync.lastSuccessAt)}` : `Sample snapshot: ${stamp(state.sync.lastSuccessAt)}`}</span><span>No external actions are performed.</span></footer>
      </main>
    </div>
    {feedback && <div className="toast" role="status"><Check size={17} className="success" /><span>{feedback}</span>{lastUndo?.id === workspace.feedbackUndoId && lastUndo && <button className="quiet" onClick={() => commit({ type: 'undo' }, 'Undone.')}>Undo</button>}<button className="icon-button" aria-label="Dismiss feedback" onClick={() => workspace.setFeedback('')}><X size={15} /></button></div>}
  </div>;
}
