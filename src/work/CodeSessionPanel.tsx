import { useEffect, useState, useSyncExternalStore } from 'react';
import { codeAgents } from '../../service/src/code-agents.ts';
import type { CodeCitation, CodeReviewResult } from '../../service/src/code-review-schema.ts';
import type { CodeRun, CodeRunPage } from '../../service/src/code-runs.ts';
import { SafeMarkdown } from '../runtime/ConversationReader.tsx';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import type { Task } from '../types.ts';
import { codeSource, type CodeSessions } from './code-sessions.ts';
import { downloadBackup } from '../storage.ts';
import { githubReference } from '../../service/src/references.ts';

const labels = {
  running: 'Inspecting code', cancelling: 'Cancellation requested', partial: 'Partial inspection saved',
  'not-inspected': 'No code inspected', failed: 'Run failed', cancelled: 'Run cancelled', interrupted: 'Run interrupted',
};
function Evidence({ items, result, open }: { items: CodeCitation[]; result: CodeReviewResult; open: (url: string) => void }) {
  return <ul className="code-evidence">{items.map((item, index) => {
    const revision = item.kind === 'code' && result.evidence.find(read => read.id === item.readId);
    const url = item.kind === 'code' && revision
      ? `https://github.com/${revision.repo}/blob/${revision.revision}/${item.path.split('/').map(encodeURIComponent).join('/')}#L${item.startLine}-L${item.endLine}`
      : `https://github.com/${result.source.reference.repo}/${result.source.reference.kind === 'pr' ? 'pull' : 'issues'}/${result.source.reference.number}`;
    return <li key={index}><button className="text-button" onClick={() => open(url)}>
      {item.kind === 'code' ? `${item.side}: ${item.path}:${item.startLine}-${item.endLine}` : 'Issue / PR evidence'}
    </button><pre>{item.quote}</pre></li>;
  })}</ul>;
}
export function CodeRunResult({ run, controller, pending = false }: { run: CodeRun; controller: DesktopWorkspace; pending?: boolean }) {
  const open = (url: string) => { void controller.platform.launchWebUrl(url).catch(error => controller.report(error)); };
  const { intent, outcome } = run;
  const result = 'result' in outcome ? outcome.result : null;
  const configured = codeAgents(controller.state.work.settings).find(agent => agent.jobType === intent.input.job);
  const settingsChanged = configured && (configured.id !== intent.input.agent.id || configured.instructions !== intent.input.agent.instructions || configured.model !== intent.input.agent.model);
  return <div className="code-run-result">
    <p><strong>{pending ? 'Result not saved' : labels[outcome.status]}</strong>{run.quarantined ? ' - previous workspace; not attached to a current task.' : ''}</p>
    <p className="field-help">{intent.agentName} · {new Date(intent.startedAt).toLocaleString()} · {intent.input.agent.model || 'SDK default (resolved model not reported)'}</p>
    {'error' in outcome && <p role="alert">{outcome.error.message}
      {outcome.error.code === 'source_changed' ? ' The source or branch moved. Start a new run to inspect its current revision.' : ''}
    </p>}
    {result && <>
      {result.answer.job === 'pr-review'
        ? <p className="task-detail-notice">{result.answer.conclusion.summary}</p>
        : <><p className="task-detail-notice">Implementation assessment only. No code was implemented or task marked Done.</p>
          <SafeMarkdown body={result.answer.summary} open={open} />
          <h4>Recommended next step</h4><SafeMarkdown body={result.answer.nextStep.text} open={open} />
          <Evidence items={result.answer.nextStep.evidence} result={result} open={open} />
          <p>{result.answer.uncertainty}</p></>}
      <p className="task-detail-notice">{result.evidence.length
        ? 'Partial coverage: bounded, selective inspection, not a comprehensive review.'
        : 'No code coverage obtained.'}
        {' '}Verified at {new Date(result.verifiedAt).toLocaleString()}. Changes after that time are not checked automatically; rerun to check current code.
      </p>
      {settingsChanged && <p className="field-help">Agent settings changed since this run. This result retains its original instructions and model.</p>}
      <p className="field-help">Inspected {result.evidence.length} code ranges. {result.coverage.changes !== 'not-applicable' &&
        <>Changed lines read: {result.coverage.reviewedChangedLines} of {result.coverage.knownChangedLines} known lines. Unknown or omitted patches are not counted.
          {result.coverage.changes === 'complete' && ' All reported changed lines were read; this is not a complete review.'}</>}</p>
      {result.coverage.warnings.length > 0 && <details><summary>Coverage limits ({result.coverage.warnings.length})</summary>
        <ul>{result.coverage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </details>}
      <h4>Findings</h4>
      {result.answer.findings.length === 0 ? <p>No grounded findings returned. This is not approval or proof that no problems exist.</p>
        : result.answer.findings.map((finding, index) => <div key={index} className="code-finding">
          <h4>{finding.severity}: {finding.title}</h4><SafeMarkdown body={finding.rationale} open={open} />
          <Evidence items={'location' in finding ? [finding.location, ...finding.evidence] : finding.evidence} result={result} open={open} />
        </div>)}
    </>}
    <details><summary>Run provenance</summary><dl>
      <dt>Run / version</dt><dd>{intent.runId} / {pending ? 'not saved' : run.sequence}</dd>
      <dt>Profile / original task</dt><dd>{intent.profileId} / {intent.input.taskId}</dd>
      <dt>Agent identity</dt><dd>{intent.input.agent.id}</dd>
      <dt>Instructions</dt><dd className="preserved-text">{intent.input.agent.instructions || 'No custom instructions'}</dd>
      <dt>Workspace generation</dt><dd>{run.generation}</dd>
      {result && <><dt>Head revision</dt><dd>{result.source.head.repo} @ {result.source.head.sha}</dd>
        {result.source.base && <><dt>Merge base</dt><dd>{result.source.base.repo} @ {result.source.base.sha}</dd></>}
        <dt>Source identity</dt><dd>{result.source.fingerprint}</dd>
        <dt>Configuration identity</dt><dd>{result.config.fingerprint}</dd></>}
    </dl></details>
  </div>;
}

export function CodeSessionPanel({ task, controller, sessions, workBusy }: {
  task: Task; controller: DesktopWorkspace; sessions: CodeSessions; workBusy: boolean;
}) {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const saved = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const profileId = controller.state.activeWorkProfile.id;
  const source = codeSource(task, controller.state);
  const [page, setPage] = useState<{ key: string; page: CodeRunPage }>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const key = JSON.stringify([profileId, task.id, task.assessmentTaskIds, saved.codeRevision, state.revision, controller.assessmentGeneration, cursor, attempt]);
  useEffect(() => {
    let disposed = false;
    setError('');
    void controller.flush().then(() => sessions.history(profileId, task.id, cursor)).then(page => {
      if (!disposed) setPage({ key, page });
    }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : 'Code history could not load.'); });
    return () => { disposed = true; };
  }, [key, controller, sessions]);
  const invoke = (operation: () => Promise<unknown>) => { void operation().catch(error => controller.report(error)); };
  const active = state.active?.profileId === profileId && (state.active.taskId === task.id || task.assessmentTaskIds?.includes(state.active.taskId)) ? state.active : null;
  const pending = saved.codePending.filter(run => run.workspaceGeneration === controller.assessmentGeneration && run.intent.profileId === profileId
    && (run.intent.input.taskId === task.id || task.assessmentTaskIds?.includes(run.intent.input.taskId)));
  const versions = page?.key === key ? page.page.runs : [];
  const result = versions.find(run => run.intent.runId === selected) ?? versions[0];
  return <section className="code-sessions" aria-label="Code sessions"><h3>Code sessions</h3>
    {!source && task.work && githubReference(task.work.url) && <p className="field-help">Source kind unknown: this saved issue-form link may identify a PR. Run now to collect its GitHub source before starting a code job. Nothing is fetched on selection.</p>}
    {source && <div className="button-row"><button className="secondary" disabled={state.busy || workBusy}
      onClick={() => invoke(() => sessions.start(task.id))}>{source.kind === 'pr' ? 'Review PR' : 'Assess implementation'}</button>
      {active && active.phase !== 'saving' && <button className="secondary" disabled={active.phase === 'cancelling'}
        onClick={() => invoke(() => sessions.cancel())}>Cancel code job</button>}
    </div>}
    {active && <p role="status">{active.phase === 'preparing' ? 'Saving start before contacting GitHub...' : active.phase === 'cancelling'
      ? 'Cancellation requested. Waiting for the actual outcome...' : active.phase === 'saving' ? 'Saving code result...'
      : 'Reading pinned code and running the agent (up to three minutes)...'}</p>}
    {state.busy && !active && <p role="status">Waiting for the previous code job to finish before starting another Copilot run...</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {!active && !result && !pending.length && !error && <p className="field-help">No saved code sessions. Only an explicit task action contacts GitHub and Copilot.</p>}
    {error && <><p role="alert">{error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry code history</button></>}
    {pending.map(value => <div key={value.intent.runId}>
      <p role="alert">{saved.codeError || (saved.codeSaving.includes(value.intent.runId) ? 'Saving code result...' : 'This result is not saved. Retry saving or export it.')}</p>
      <CodeRunResult controller={controller} run={{ generation: value.generation, intent: value.intent, outcome: value.outcome, sequence: 1, quarantined: false }} pending />
      <div className="button-row"><button className="secondary" disabled={saved.codeSaving.includes(value.intent.runId)}
        onClick={() => invoke(() => controller.retryCodeRun(value.intent.runId))}>Retry saving result</button>
        <button className="secondary" onClick={() => downloadBackup(JSON.stringify(value), 'code-result.json')}>Export this result</button></div>
    </div>)}
    {result && <><label>Code session version<select value={result.intent.runId} onChange={event => setSelected(event.target.value)}>
      {versions.map(run => <option key={run.intent.runId} value={run.intent.runId}>Version {run.sequence} - {labels[run.outcome.status]} - {new Date(run.intent.startedAt).toLocaleString()}</option>)}
    </select></label><CodeRunResult run={result} controller={controller} /></>}
    <div className="button-row">
      {cursor !== null && <button className="secondary" onClick={() => setCursor(null)}>Latest code sessions</button>}
      {page?.key === key && page.page.before !== null && <button className="secondary" onClick={() => setCursor(page.page.before)}>Older code sessions</button>}
    </div>
  </section>;
}
