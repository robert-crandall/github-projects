import { useEffect, useState, useSyncExternalStore } from 'react';
import { identityDigest, type TaskAssessment } from '../../service/src/work-assessment.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import type { WorkSettings } from '../../service/src/work-schema.ts';
import type { Task } from '../types.ts';
import { assessmentFreshness } from './assessments.ts';
import { rankTask } from './engine.ts';

function date(value: string) { return new Date(value).toLocaleString(); }

export function TaskAssessmentHistory({ task, controller }: { task: Task; controller: DesktopWorkspace }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const profileId = controller.state.activeWorkProfile.id;
  const [page, setPage] = useState<{ key: string; values: TaskAssessment[]; before: number | null; latest: string }>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const key = JSON.stringify([profileId, task.id, task.assessmentTaskIds, snapshot.assessmentRevision, cursor, attempt]);
  useEffect(() => {
    let cancelled = false;
    setError('');
    void controller.flush().then(() => controller.platform.assessmentRead(profileId, task.id, cursor)).then(result => {
      if (!cancelled) setPage(previous => ({
        key, values: [...result.assessments].reverse(), before: result.before,
        latest: cursor === null ? result.assessments[0]?.resultId ?? '' : previous?.latest ?? '',
      }));
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : 'Assessment history could not load.'); });
    return () => { cancelled = true; };
  }, [controller, key]);
  const pending = snapshot.assessmentPending.filter(value => value.profileId === profileId
    && (value.id === task.id || task.assessmentTaskIds?.includes(value.id)));
  return <>
    {pending.length > 0 && <section aria-label="Unsaved assessments">
      <h3>Unsaved assessments</h3><p role="alert">{snapshot.assessmentError || 'Saving assessment history...'}</p>
      <p>Task edits save separately. These results remain available for retry or export.</p>
      {pending.map(value => <details key={value.resultId}><summary>{new Date(value.evaluatedAt).toLocaleString()}</summary>
        <p>{value.assessment.importance}</p><p>{value.assessment.urgency}</p><p>{value.assessment.blockers}</p>
        <p>{value.assessment.uncertainty}</p>
        <ul>{value.assessment.supportingEvidence.map((item, index) => <li key={index}>{item.summary} ({item.reference})</li>)}</ul>
      </details>)}
      <button className="secondary" disabled={snapshot.assessmentSaving} onClick={() => {
        void controller.retryAssessments().catch(error => controller.report(error));
      }}>Retry assessment save</button>
    </section>}
    {error ? <section aria-label="Assessment"><h3>Assessment</h3><p role="alert">{error}</p>
      <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry history</button></section>
      : page?.key === key ? <>
        <AssessmentHistory key={key} task={{ ...task, assessments: page.values }} profileId={profileId}
          settings={controller.state.work.settings} latestResultId={page.latest} />
        <div className="button-row">
          {cursor !== null && <button className="secondary" onClick={() => setCursor(null)}>Latest assessments</button>}
          {page.before !== null && <button className="secondary" onClick={() => setCursor(page.before)}>Older assessments</button>}
        </div>
      </> : <section aria-label="Assessment"><h3>Assessment</h3><p role="status">Reading saved assessments...</p></section>}
  </>;
}

export function AssessmentHistory({ task, profileId, settings, latestResultId }: {
  task: Task; profileId: string; settings: WorkSettings; latestResultId?: string;
}) {
  const [selected, setSelected] = useState('');
  const [, updateClock] = useState(0);
  const [identity, setIdentity] = useState<{ key: string; fingerprint: string; instructionsFingerprint: string }>();
  const [error, setError] = useState('');
  const semantic = semanticRankTask(rankTask(task));
  const key = JSON.stringify([semantic, settings.instructions]);
  useEffect(() => {
    let disposed = false;
    setError('');
    void Promise.all([identityDigest(semantic), identityDigest(settings.instructions)]).then(([fingerprint, instructionsFingerprint]) => {
      if (!disposed) setIdentity({ key, fingerprint, instructionsFingerprint });
    }).catch(error => {
      if (!disposed) setError(`Freshness could not be checked: ${error instanceof Error ? error.message : 'input hashing failed'}`);
    });
    return () => { disposed = true; };
  }, [key]);
  useEffect(() => {
    const timer = window.setInterval(() => updateClock(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const versions = task.assessments ?? [];
  const latest = versions.at(-1);
  const value = versions.find(value => value.resultId === selected) ?? latest;
  if (!value) return <section aria-label="Assessment"><h3>Assessment</h3>
    <p>No saved assessment yet. Run now assesses active tasks; earlier cache results are not task history.</p>
  </section>;
  const freshness = identity?.key === key
    ? assessmentFreshness(value, { ...identity, profileId, model: settings.model }, Date.now())
    : 'Checking saved input identity...';
  return <section className="task-assessment" aria-label="Assessment">
    <h3>Assessment</h3>
    {versions.length > 1 && <label>Assessment version<select value={value.resultId} onChange={event => setSelected(event.target.value)}>
      {[...versions].reverse().map((version, index) => <option key={version.resultId} value={version.resultId}>
        {version.resultId === (latestResultId ?? latest?.resultId) ? 'Latest' : `Version ${version.sequence ?? versions.length - index}`} - {date(version.evaluatedAt)}
      </option>)}
    </select></label>}
    <p className="field-help">Assessed {date(value.evaluatedAt)}. {value.resultId === (latestResultId ?? latest?.resultId) ? 'Latest saved result.' : 'Historical result.'}</p>
    {error ? <p role="alert">{error}</p> : <p role="status">{freshness}</p>}
    <dl>
      <dt>Importance</dt><dd>{value.assessment.importance}</dd>
      <dt>Urgency</dt><dd>{value.assessment.urgency}</dd>
      <dt>Blockers</dt><dd>{value.assessment.blockers}</dd>
      <dt>Uncertainty</dt><dd>{value.assessment.uncertainty || 'None recorded.'}</dd>
    </dl>
    <h4>Supporting evidence</h4>
    <ul>{value.assessment.supportingEvidence.map((item, index) => <li key={index}>
      {item.summary} <span className="field-help">({item.reference})</span>
    </li>)}</ul>
    <p className="field-help">Reassessment due {date(value.assessment.reevaluateAt)}. Expiry does not remove this result.</p>
    <details><summary>Assessment provenance</summary><dl>
      <dt>Model requested</dt><dd>{value.model || 'SDK default (resolved model not reported)'}</dd>
      <dt>Assessment format</dt><dd>{value.assessmentVersion}</dd>
      <dt>Profile ID</dt><dd>{value.profileId}</dd>
      <dt>Original task ID</dt><dd>{value.id}</dd>
      <dt>Result ID</dt><dd>{value.resultId}</dd>
      <dt>Input identity</dt><dd>{value.fingerprint}</dd>
      <dt>Instruction identity</dt><dd>{value.instructionsFingerprint}</dd>
    </dl></details>
  </section>;
}
