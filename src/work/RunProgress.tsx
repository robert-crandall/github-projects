import { useEffect, useState } from 'react';
import { ArrowRight, Check, Circle, CircleAlert, Minus } from 'lucide-react';
import type { CollectionProgress, WorkQueueSnapshot } from './controller.ts';

const sourceLabels: Record<CollectionProgress['state'], string> = {
  waiting: 'Waiting', collecting: 'Collecting', done: 'Done', failed: 'Failed', 'not-run': 'Not run',
};
const sourceIcons = { waiting: Circle, collecting: ArrowRight, done: Check, failed: CircleAlert, 'not-run': Minus };
const phases: Record<WorkQueueSnapshot['phase'], string> = {
  preparing: 'Saving pending changes', intake: 'Reading task intake', collecting: 'Collecting sources',
  'checking-assessments': 'Checking saved assessments',
  assessing: 'Assessing tasks', ranking: 'Ranking tasks', saving: 'Saving results', idle: 'Run complete', error: 'Run incomplete',
  cancelling: 'Cancelling assessment · Waiting for the active request to stop',
  cancelled: 'Assessment cancelled · Saved batches kept · Order unchanged',
};

export function RunProgress({ run, details, cancelAssessor }: {
  run: WorkQueueSnapshot; details: string[]; cancelAssessor: () => void;
}) {
  const { progress } = run;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!run.running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.running, progress?.startedAt]);

  const sources = progress?.sources ?? [];
  const pipeline = !progress?.kind || progress.kind === 'pipeline';
  const done = sources.filter(source => source.state === 'done').length;
  const failed = sources.filter(source => source.state === 'failed').length;
  const processed = done + failed;
  const remaining = sources.length - processed;
  const active = sources.find(source => source.state === 'collecting');
  const sourceDetails = new Set(sources.flatMap(source => source.diagnostics));
  const diagnostics = [...new Set(details)].filter(detail => !sourceDetails.has(detail));
  const detailCount = new Set([...sourceDetails, ...diagnostics]).size;
  const seconds = progress ? Math.max(0, Math.floor(((progress.finishedAt ?? now) - progress.startedAt) / 1000)) : 0;
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const remainingLabel = !run.running && remaining > 0 ? 'not run' : 'remaining';
  const counts = `${done} done, ${failed} failed, ${remaining} ${remainingLabel}`;
  const assessment = progress?.assessment;
  const assessmentCounts = assessment && `${assessment.saved} of ${assessment.total} assessments saved`;
  const canCancel = run.running && (run.phase === 'assessing' || run.phase === 'checking-assessments' || run.phase === 'cancelling'
    || run.phase === 'preparing' && progress?.kind === 'assess');
  const phase = run.running
    ? `${active ? `Now: ${active.name}` : phases[run.phase]}${pipeline && ['preparing', 'intake', 'collecting'].includes(run.phase) ? ' · Ranking follows' : ''}`
    : `${phases[run.phase]}${failed ? ' · Partial coverage' : detailCount && !run.error ? ' · Coverage notes' : ''}`;

  if (!progress && !details.length) return null;
  return <section className="task-run" aria-label="Run progress">
    {progress && <>
      <div className="task-run-line" role="status" aria-atomic="true">
        <strong>{!pipeline ? progress.kind === 'assess' ? 'Assessor only · Order unchanged' : 'Prioritizer only · Whole eligible list'
          : sources.length ? `Collections · ${processed} of ${sources.length} processed` : 'No enabled collections'}</strong>
        {!!sources.length && <span>{done} done · <span className={failed ? 'task-run-warning' : undefined}>{failed} failed</span> · {remaining} {remainingLabel}</span>}
      </div>
      {!!sources.length && <div className="task-run-track" role="progressbar" aria-label="Collections processed"
        aria-valuemin={0} aria-valuemax={sources.length} aria-valuenow={processed} aria-valuetext={counts}>
        <span className="task-run-done" style={{ width: `${done / sources.length * 100}%` }} />
        <span className="task-run-failed" style={{ width: `${failed / sources.length * 100}%` }} />
      </div>}
      {assessment && <div className="task-run-assessment">
        <div className="task-run-line" role="status" aria-atomic="true">
          <strong>{assessment.total ? `Assessments · ${assessment.saved} of ${assessment.total} saved` : 'No tasks to assess in this run'}</strong>
          {assessment.total > 0 && <span>{assessment.batches} {assessment.batches === 1 ? 'batch' : 'batches'} saved
            {' · '}{assessment.total - assessment.saved} {run.running ? 'remaining' : 'not assessed'}</span>}
        </div>
        {assessment.total > 0 && <div className="task-run-track" role="progressbar" aria-label="Assessments saved"
          aria-valuemin={0} aria-valuemax={assessment.total} aria-valuenow={assessment.saved} aria-valuetext={assessmentCounts}>
          <span className="task-run-done" style={{ width: `${assessment.saved / assessment.total * 100}%` }} />
        </div>}
      </div>}
      <div className="task-run-now"><span role="status">{phase}</span><span>Elapsed {elapsed}</span></div>
      {canCancel && <button className="secondary task-run-cancel" disabled={run.cancelRequested}
        onClick={cancelAssessor}>{run.cancelRequested ? 'Cancelling...' : 'Cancel assessment'}</button>}
    </>}
    {(sources.length > 0 || detailCount > 0) && <details className="task-run-details">
      <summary>Coverage and run details{detailCount > 0 ? ` (${detailCount})` : ''}
        {failed > 0 && <span className="task-run-warning">{' '}{failed} source{failed === 1 ? '' : 's'} failed</span>}
      </summary>
      <div className="task-run-ledger">
        {sources.length > 0 && <ul className="task-run-sources" aria-label="Collection sources">
          {sources.map(source => {
            const Icon = sourceIcons[source.state];
            return <li className={`task-run-source task-run-source-${source.state}`} key={source.id}>
              <Icon size={15} aria-hidden="true" />
              <div><span>{source.name}</span>{source.diagnostics.map(detail => <p className="task-run-diagnostic" key={detail}>{detail}</p>)}</div>
              <span className="task-run-source-state">{sourceLabels[source.state]}</span>
            </li>;
          })}
        </ul>}
        {diagnostics.length > 0 && <ul className="task-run-diagnostics">{diagnostics.map(detail => <li key={detail}>{detail}</li>)}</ul>}
      </div>
    </details>}
  </section>;
}
