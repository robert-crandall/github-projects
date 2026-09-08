import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, Circle, Clock3, ExternalLink, GitPullRequest, MessageCircle, MoreHorizontal, Pause, Play, RotateCcw, Trash2, Wrench } from 'lucide-react';
import type { AppState, Command, WorkItem } from '../domain/types.ts';
import { outstanding } from '../domain/clock.ts';
import { isActionable, isPossibleRereview, recommendationReason } from '../domain/ranking.ts';
import { desktop, desktopCommand, errorText } from '../desktop.ts';

export type Commit = (command: Command, message?: string) => Promise<boolean>;
export const stamp = (value: string, timeZone = desktop ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC') => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
}).format(new Date(value));
export const day = (value: string, timeZone = desktop ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC') => new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone,
}).format(new Date(value));

function GitHubLink({ url }: { url?: string }) {
  const [error, setError] = useState('');
  if (!desktop || !url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/[1-9]\d*$/.test(url)) return null;
  return <><button className="quiet" onClick={async () => {
    try { await desktopCommand('open_github', { url }); setError(''); }
    catch (error) { setError(errorText(error)); }
  }}><ExternalLink size={15} />Open on GitHub</button>{error && <p className="warning" role="alert">{error}</p>}</>;
}

export function ItemIcon({ item }: { item: WorkItem }) {
  const Icon = item.kind === 'review' ? GitPullRequest : item.kind === 'routine' ? Clock3
    : item.kind === 'fix' ? Wrench : item.kind === 'mention' ? MessageCircle : Circle;
  return <Icon size={19} strokeWidth={1.6} aria-hidden="true" />;
}

export function signal(item: WorkItem) {
  if (item.review?.request === 'direct') return 'Direct review request';
  if (item.review?.request === 'team') return 'Team review request';
  if (isPossibleRereview(item)) return 'Recent activity - may need re-review';
  if (item.review) return 'Captured review';
  if (item.kind === 'fix') return 'Authored PR';
  if (item.kind === 'mention') return 'Mention - may need a reply';
  if (item.kind === 'routine') return 'Daily routine';
  return 'Personal action';
}

export function secondaryReason(item: WorkItem, state: AppState) {
  if (item.status === 'waiting') return `Waiting: ${item.reason}`;
  if (item.status === 'deferred') return `${item.reason || 'Deferred'}${item.availableAt ? ` - until ${stamp(item.availableAt)}` : ''}`;
  if (item.status === 'completed') return `Completed locally${item.completedAt ? ` ${stamp(item.completedAt)}` : ''}`;
  if (item.status === 'removed') return 'Removed locally - recoverable';
  if (item.routine && !outstanding(item)) return `Next occurrence ${stamp(item.routine.nextDueAt)}`;
  const occurrence = outstanding(item);
  if (occurrence?.snoozedUntil && occurrence.snoozedUntil > state.clock) return `Snoozed until ${stamp(occurrence.snoozedUntil)}`;
  if (item.availableAt && item.availableAt > state.clock) return `Available ${stamp(item.availableAt)}`;
  return recommendationReason(item, state);
}

export function WorkRow({ item, state, open, commit, number }: {
  item: WorkItem; state: AppState; open: (id: string) => void; commit: Commit; number?: number;
}) {
  const actionable = isActionable(item, state);
  const restorable = ['waiting', 'deferred', 'completed', 'removed'].includes(item.status);
  return <li className="work-row">
    <span className={`row-symbol ${item.kind}`}><ItemIcon item={item} /></span>
    <button className="row-body" onClick={() => open(item.id)}>
      <span className="row-title">{item.title}</span>
      <span className="row-meta"><span>{signal(item)}</span><span className="meta-separator" aria-hidden="true">/</span><span>{secondaryReason(item, state)}</span></span>
    </button>
    {actionable && state.activeId !== item.id && <button className="row-action quiet" onClick={() => commit({ type: 'start', id: item.id }, state.activeId ? 'Switched. Your place is saved.' : 'Started. Your place is saved.')} aria-label={`${state.activeId ? 'Switch to' : 'Start'} ${item.title}`}>
      {state.activeId ? 'Switch' : 'Start'}<ArrowRight size={15} />
    </button>}
    {restorable && <button className="row-action quiet" onClick={() => commit({ type: 'restore', id: item.id }, 'Restored.')} aria-label={`Restore ${item.title}`}><RotateCcw size={15} />Restore</button>}
    {!actionable && !restorable && <button className="icon-button" aria-label={`Details for ${item.title}`} onClick={() => open(item.id)}><ChevronRight size={17} /></button>}
    {number !== undefined && <span className="sr-only">Rank {number}</span>}
  </li>;
}

export function DecisionControls({ item, commit, compact = false }: { item: WorkItem; commit: Commit; compact?: boolean }) {
  const [mode, setMode] = useState<'defer' | 'wait' | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const available = item.status === 'available';
  return <div className="decisions">
    <div className="button-row">
      {available && <>
        <button className="quiet" onClick={() => { setMode(mode === 'defer' ? null : 'defer'); setReason(''); }}><Clock3 size={15} />Defer</button>
        <button className="quiet" onClick={() => { setMode(mode === 'wait' ? null : 'wait'); setReason(''); }}><Pause size={15} />Waiting on someone</button>
      </>}
      {!available && <button className="secondary" onClick={() => commit({ type: 'restore', id: item.id }, 'Restored.')}><RotateCcw size={15} />Restore action</button>}
      {!compact && item.status !== 'removed' && <button className="quiet" onClick={() => commit({ type: 'remove', id: item.id }, 'Removed locally. You can undo this.')}><Trash2 size={15} />Remove</button>}
    </div>
    {mode && <form className="decision-form" onSubmit={async (event) => {
      event.preventDefault();
      const command: Command = mode === 'defer'
        ? { type: 'defer', id: item.id, reason: reason.trim(), until: until ? desktop ? new Date(until).toISOString() : `${until}:00.000Z` : undefined }
        : { type: 'wait', id: item.id, reason: reason.trim() };
      if (await commit(command, mode === 'defer' ? 'Deferred. Your place is saved.' : 'Moved to Waiting.')) setMode(null);
    }}>
      <label>{mode === 'wait' ? 'Who or what are you waiting on?' : 'Why set this aside?'}
        <input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder={mode === 'wait' ? 'Waiting for a response from...' : 'Not ready to pick this up yet'} required />
      </label>
      {mode === 'defer' && <label className="optional-time">Revisit after <span className="subtle">({desktop ? 'optional, local time' : 'optional, demo UTC'})</span><input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} /><span className="field-help">{desktop ? 'Returns automatically at this time; leave blank for someday.' : 'Stays in Later until you restore it.'}</span></label>}
      <div className="button-row"><button className="secondary" type="submit">{mode === 'wait' ? 'Mark waiting' : 'Move to Later'}</button><button type="button" className="quiet" onClick={() => setMode(null)}>Cancel</button></div>
    </form>}
  </div>;
}

export function Progress({ item, state, commit }: { item: WorkItem; state: AppState; commit: Commit }) {
  const occurrence = outstanding(item);
  const steps = occurrence?.steps ?? item.steps;
  const currentIndex = steps.findIndex((step) => !step.doneAt);
  const zone = item.routine?.timeZone ?? 'UTC';
  const stale = occurrence && day(occurrence.dueAt, zone) !== day(state.clock, zone);
  return <div className="working-context">
    {occurrence && <div className="occurrence-heading"><Clock3 size={15} /><span>Occurrence due {stamp(occurrence.dueAt, zone)} / {zone}</span></div>}
    {stale && <p className="notice-inline warning">This occurrence began on {day(occurrence.dueAt)}. Saved steps have not been repeated. Check whether an earlier announcement still applies before increasing the flag.</p>}
    {steps.length > 0 ? <ol className="step-list" aria-label={item.routine ? 'Ordered routine steps' : 'Action checklist'}>
      {steps.map((step, index) => {
        const disabled = !!item.routine && !step.doneAt && index !== currentIndex;
        return <li key={step.id} className={`${step.doneAt ? 'step-done' : ''} ${index === currentIndex ? 'step-current' : ''}`}>
          <label>
            <input type="checkbox" checked={!!step.doneAt} disabled={disabled} onChange={(event) => commit({ type: 'step', id: item.id, stepId: step.id, done: event.target.checked }, event.target.checked ? 'Step recorded locally.' : 'Step reopened.')} />
            <span className="step-label">{step.title}<span className="step-description">{step.doneAt ? `Recorded ${stamp(step.doneAt)}` : disabled ? 'After the previous step' : item.routine ? 'Do this in your tools, then mark it done here.' : 'Your next concrete step'}</span></span>
          </label>
          {step.doneAt && <Check size={16} className="success" />}
        </li>;
      })}
    </ol> : <div className="next-step"><span className="subtle">Next step</span><p>{item.nextStep}</p></div>}
    <label className="notes-label">Scratch notes <span className="subtle">Local autosave</span>
      <textarea aria-label={`Scratch notes for ${item.title}`} rows={3} value={item.notes} onChange={(event) => commit({ type: 'notes', id: item.id, text: event.target.value })} placeholder="Leave yourself a place to pick up..." />
    </label>
  </div>;
}

export function MainAction({ item, state, commit }: { item: WorkItem; state: AppState; commit: Commit }) {
  const active = state.activeId === item.id;
  const occurrence = outstanding(item);
  const ready = !item.routine || !!occurrence && occurrence.steps.every((step) => !!step.doneAt);
  if (active) return <div className="button-row">
    <button className="primary" disabled={!ready} onClick={() => commit({ type: 'complete', id: item.id }, item.routine ? 'Occurrence completed locally.' : 'Completed locally.')}><Check size={18} />{item.routine ? 'Complete occurrence' : 'Complete action'}</button>
    <button className="quiet" onClick={() => commit({ type: 'pause' }, 'Paused. Notes and progress are saved.')}><Pause size={15} />Pause / switch</button>
  </div>;
  if (!isActionable(item, state)) return null;
  return <button className="primary" onClick={() => commit({ type: 'start', id: item.id }, state.activeId ? 'Switched. Your place is saved.' : 'Started. Your place is saved.')}><Play size={17} />{state.activeId ? 'Switch to this action' : item.kind === 'review' ? 'Start review' : item.routine ? 'Start routine' : 'Start action'}</button>;
}

export function FocusWork({ item, state, commit, open }: { item: WorkItem; state: AppState; commit: Commit; open: (id: string) => void }) {
  const active = state.activeId === item.id;
  return <section className={`focus-work ${active ? 'is-active' : ''}`} aria-label={active ? 'Active action' : 'Recommended action'}>
    <div className="focus-title-line"><h2>{item.title}</h2><span className={`focus-icon ${item.kind}`}><ItemIcon item={item} /></span></div>
    <div className="source-line"><span className={item.review?.request === 'direct' ? 'signal-direct' : 'subtle'}>{signal(item)}</span>
      {item.review?.identity && <span className="fixture-reference">{item.review.identity.replace('demo://github/', '').replace('https://github.com/', '').replace('/pull/', ' #')}</span>}
      {item.sources.length > 1 && <span className="subtle">{item.sources.length} sources</span>}
    </div>
    <div className="focus-reason">{active ? <><span className="active-dot" aria-hidden="true" />Active - stays here until you finish or switch.</> : <>{recommendationReason(item, state)}<span className="simulation">{desktop ? state.aiRanking ? 'Copilot-assisted' : 'Default ordering' : 'Simulated ranking'}</span></>}</div>
    {!active && <p className="focus-evidence">{item.evidence || item.nextStep}</p>}
    {active && <Progress item={item} state={state} commit={commit} />}
    <div className="focus-actions"><MainAction item={item} state={state} commit={commit} /><GitHubLink url={item.sources.find(source => source.reference?.startsWith('https://github.com/'))?.reference} /><button className="quiet" onClick={() => open(item.id)}>Details &amp; sources<ChevronRight size={16} /></button></div>
    {active && <><p className="local-disclaimer">Local progress only. No review, message, or flag change is sent.</p><DecisionControls item={item} commit={commit} compact /></>}
  </section>;
}

function EditAction({ item, state, commit }: { item: WorkItem; state: AppState; commit: Commit }) {
  const [title, setTitle] = useState(item.title);
  const [nextStep, setNextStep] = useState(item.nextStep);
  const [projectId, setProjectId] = useState(item.projectId ?? '');
  const [time, setTime] = useState(item.routine?.time ?? '10:00');
  const [daily, setDaily] = useState(!!item.routine);
  const [timeZone, setTimeZone] = useState(item.routine?.timeZone ?? (desktop ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'));
  const [steps, setSteps] = useState(item.steps.map(step => step.title).join('\n') || item.nextStep);
  return <form className="edit-form" onSubmit={(event) => {
    event.preventDefault();
    void commit({
      type: 'edit', id: item.id, title: title.trim(), nextStep: nextStep.trim(), projectId: projectId || undefined,
      routineTime: daily ? time : undefined,
      ...(desktop && daily ? { routineTimeZone: timeZone, routineSteps: steps.split('\n').map(step => step.trim()).filter(Boolean) } : {}),
    }, 'Action updated.');
  }}>
    <label>Action<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
    <label>Next concrete step<input value={nextStep} onChange={(event) => setNextStep(event.target.value)} required /></label>
    {desktop && !item.routine && <label><input type="checkbox" checked={daily} onChange={event => setDaily(event.target.checked)} />Make this a daily routine</label>}
    {daily && <label>Daily due time <span className="subtle">({desktop ? timeZone : 'demo UTC'})</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /><span className="field-help">Changes future occurrences. Existing progress keeps its original date.</span></label>}
    {desktop && daily && <>
      <label>Routine timezone<select value={timeZone} onChange={event => setTimeZone(event.target.value)}>{Array.from(new Set(['UTC', timeZone, ...Intl.supportedValuesOf('timeZone')])).map(zone => <option key={zone}>{zone}</option>)}</select><span className="field-help">Stays in this timezone when you travel. Daily means every calendar day.</span></label>
      <label>Ordered steps<textarea value={steps} onChange={event => setSteps(event.target.value)} required /><span className="field-help">One step per line. Updates the template, not an occurrence already in progress.</span></label>
    </>}
    <label>Project <span className="subtle">(optional)</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">No project</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <button type="submit" className="secondary">Save changes</button>
  </form>;
}

export function WorkDetail({ item, state, commit, back }: { item: WorkItem; state: AppState; commit: Commit; back: () => void }) {
  const captures = state.captures.filter((capture) => capture.itemId === item.id);
  return <div className="detail-view">
    <button className="quiet back-button" onClick={back}><ArrowLeft size={16} />Back to workspace</button>
    <div className="page-heading"><h1>{item.title}</h1></div>
    <div className="source-line"><ItemIcon item={item} /><span>{signal(item)}</span><span className="subtle">{item.status}</span></div>
    {item.review?.team && <p className="team-name">{item.review.team}</p>}
    <p className="detail-reason">{secondaryReason(item, state)}</p>
    {item.reason && <p className="notice-inline">{item.reason}</p>}
    <MainAction item={item} state={state} commit={commit} />
    {(state.activeId === item.id || isActionable(item, state)) && <Progress item={item} state={state} commit={commit} />}
    {!isActionable(item, state) && <label className="notes-label">Scratch notes <span className="subtle">Local autosave</span><textarea rows={3} value={item.notes} onChange={(event) => commit({ type: 'notes', id: item.id, text: event.target.value })} /></label>}
    <p className="local-disclaimer">Completion here records your decision, not an external action.</p>
    <DecisionControls item={item} commit={commit} />
    <details className="disclosure" open={captures.length > 0}>
      <summary>Original captures &amp; sources <span>{item.sources.length}</span></summary>
      <div className="disclosure-body">
        {captures.map((capture) => <div key={capture.id} className="original-capture"><div className="small-label">Captured {stamp(capture.createdAt)}</div><p className="preserve-text">{capture.original}</p>
          <p className={capture.interpretation === 'error' ? 'warning' : 'subtle'}>{capture.explanation || `${desktop ? 'Interpretation' : 'Simulated interpretation'}: ${capture.interpretation}`}</p>
          {(capture.interpretation === 'error' || capture.interpretation === 'pending') && <button className="secondary" onClick={() => commit({ type: 'interpret', captureId: capture.id }, 'Interpretation retried.')}><RotateCcw size={15} />Retry interpretation</button>}
        </div>)}
        <ul className="source-list">{item.sources.map((source) => <li key={source.id}><ExternalLink size={14} /><div>{source.label}<span className="field-help">{source.reference || (source.kind === 'capture' ? 'Original text retained locally' : desktop ? 'Locally tracked work' : 'Synthetic fixture - not live GitHub data')}</span><GitHubLink url={source.reference} /></div></li>)}</ul>
        {item.evidence && <p className="subtle">{desktop ? 'Evidence' : 'Fixture evidence'}: {item.evidence}</p>}
        <p className="field-help">Created {stamp(item.createdAt)}. Item updated {stamp(item.updatedAt)}.</p>
      </div>
    </details>
    <details className="disclosure"><summary>Edit action {captures.length > 0 && <span>{desktop ? 'Your interpretation' : 'Simulated interpretation'}</span>}<MoreHorizontal size={17} /></summary><div className="disclosure-body"><EditAction item={item} state={state} commit={commit} /></div></details>
    {item.routine && <details className="disclosure"><summary>Routine history <span>{item.routine.occurrences.length}</span></summary><div className="disclosure-body"><p className="subtle">One outstanding occurrence. Missed days are history, never catch-up increases.</p>
      <ul className="history-list">{[...item.routine.occurrences].reverse().map((occurrence) => <li key={occurrence.id}><div><span>{stamp(occurrence.dueAt)}</span><span className={`history-status ${occurrence.status === 'completed' ? 'success' : ''}`}>{occurrence.status === 'missed' ? 'Missed - coalesced' : occurrence.status}</span></div>
        {occurrence.steps.filter((step) => step.doneAt).map((step) => <p key={step.id}><CheckCheck size={14} />{step.title}: {stamp(step.doneAt!)}</p>)}
        {occurrence.reminderAt && <p className="subtle">{desktop ? 'Reminder eligible since' : 'One simulated reminder'}: {stamp(occurrence.reminderAt)}</p>}
      </li>)}</ul>{!item.routine.occurrences.length && <p>No occurrences yet. First due {stamp(item.routine.nextDueAt)}.</p>}
    </div></details>}
  </div>;
}
