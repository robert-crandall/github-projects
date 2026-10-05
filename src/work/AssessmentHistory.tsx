import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { identityDigest, type SavedAssessment, type TaskAssessment } from '../../service/src/work-assessment.ts';
import { taskAgent } from '../../service/src/work-agents.ts';
import { assessmentIdentity } from '../../service/src/work-styles.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import type { WorkSettings } from '../../service/src/work-schema.ts';
import type { Task } from '../types.ts';
import { assessmentFreshness } from './assessments.ts';
import { rankTask } from './engine.ts';

function date(value: string) { return new Date(value).toLocaleString(); }
const ratingFields = ['impact', 'visibility', 'effort'] as const;
function label(field: string) { return field[0]!.toUpperCase() + field.slice(1); }
export type ReasoningView = 'overview' | 'assessment' | 'history';

function AssessmentRatings({ value }: { value: SavedAssessment }) {
  return <>{ratingFields.map(field => <div key={field}>
    <dt>{label(field)}</dt>
    <dd>{value.assessmentVersion !== 'work-assessment-v2'
      ? `${value.assessment[field].rating} - ${value.assessment[field].rationale}`
      : 'Not recorded in this assessment format.'}</dd>
  </div>)}</>;
}

export function TaskAssessmentHistory({ task, controller, view, overview, overviewStyles, controls }: {
  task: Task; controller: DesktopWorkspace; view: ReasoningView;
  overview: ReactNode; overviewStyles: ReactNode; controls: ReactNode;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const profileId = controller.state.activeWorkProfile.id;
  const [page, setPage] = useState<{ key: string; values: TaskAssessment[]; before: number | null; latest: string }>();
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const cursor = view === 'history' ? historyCursor : null;
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const key = JSON.stringify([profileId, task.id, task.assessmentTaskIds, controller.assessmentGeneration, snapshot.assessmentRevision, cursor, attempt]);
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
  const latest = page?.key === key ? page.values.at(-1) : undefined;
  return <>
    {pending.length > 0 && <section aria-label="Unsaved assessments">
      <h3>Unsaved assessments</h3><p role="alert">{snapshot.assessmentError || 'Saving assessment history...'}</p>
      <p>Task edits save separately. These results remain available for retry or export.</p>
      {pending.map(value => <details key={value.resultId}><summary>{date(value.evaluatedAt)}</summary>
        <dl><AssessmentRatings value={value} /></dl>
        <p>{value.assessment.importance}</p><p>{value.assessment.urgency}</p><p>{value.assessment.blockers}</p>
        <p>{value.assessment.uncertainty}</p>
        <ul>{value.assessment.supportingEvidence.map((item, index) => <li key={index}>{item.summary} ({item.reference})</li>)}</ul>
      </details>)}
      <button className="secondary" disabled={snapshot.assessmentSaving} onClick={() => {
        void controller.retryAssessments().catch(error => controller.report(error));
      }}>Retry assessment save</button>
    </section>}
    {view === 'overview' && overview}
    {error ? <section aria-label="Assessment"><p role="alert">{error}</p>
      <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry history</button></section>
      : page?.key === key ? view === 'overview' ? <>
        <div className="work-style-pills assessment-pills" aria-label="Latest assessment ratings and work styles">
          {latest && ratingFields.map(field => <span className="work-style-pill" key={field}>
            <span>{label(field)}</span> {latest.assessmentVersion === 'work-assessment-v2' ? 'Not recorded' : latest.assessment[field].rating}
          </span>)}
          {overviewStyles}
        </div>
        {latest ? <p className="field-help">Assessed {date(latest.evaluatedAt)}. Latest saved result.</p> : <p className="field-help">No saved assessment yet. Use Assessment to assess this task.</p>}
        <p className="field-help">Assessment contains the underlying judgments. History preserves earlier versions.</p>
      </> : <>
        {view === 'history' && <p className="field-help">Assessment history only. Current ranking remains separate.</p>}
        <AssessmentHistory key={key} task={{ ...task, assessments: page.values }} profileId={profileId}
          settings={controller.state.work.settings} latestResultId={page.latest} mode={view} />
        {view === 'history' && <div className="button-row">
          {cursor !== null && <button className="secondary" onClick={() => setHistoryCursor(null)}>Latest assessments</button>}
          {page.before !== null && <button className="secondary" onClick={() => setHistoryCursor(page.before)}>Older assessments</button>}
        </div>}
      </> : <p role="status">Reading saved assessments...</p>}
    {view === 'assessment' && controls}
  </>;
}

export function AssessmentHistory({ task, profileId, settings, latestResultId, mode = 'history' }: {
  task: Task & { assessments: TaskAssessment[] }; profileId: string; settings: WorkSettings; latestResultId?: string;
  mode?: 'assessment' | 'history';
}) {
  const [selected, setSelected] = useState('');
  const [, updateClock] = useState(0);
  const [identity, setIdentity] = useState<{ key: string; fingerprint: string; instructionsFingerprint: string; configurationFingerprint: string }>();
  const [error, setError] = useState('');
  const semantic = semanticRankTask(rankTask(task));
  const agent = taskAgent(settings, 'task-assessment');
  const key = JSON.stringify([semantic, assessmentIdentity(settings)]);
  useEffect(() => {
    let disposed = false;
    setError('');
    void Promise.all([identityDigest(semantic), identityDigest(agent.instructions), identityDigest(assessmentIdentity(settings))])
      .then(([fingerprint, instructionsFingerprint, configurationFingerprint]) => {
      if (!disposed) setIdentity({ key, fingerprint, instructionsFingerprint, configurationFingerprint });
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
  const value = mode === 'assessment' ? latest : versions.find(value => value.resultId === selected) ?? latest;
  if (!value) return <section aria-label="Assessment"><h3>Assessment</h3>
    <p>No saved assessment yet. Use Assess task, Run assessor or Run now; earlier cache results are not task history.</p>
  </section>;
  const freshness = identity?.key === key
    ? assessmentFreshness(value, { ...identity, profileId, model: agent.model }, Date.now())
    : 'Checking saved input identity...';
  return <section className="task-assessment" aria-label="Assessment">
    <h3>{mode === 'assessment' ? 'Latest saved assessment' : 'Assessment history'}</h3>
    {mode === 'history' && <label>Assessment version<select value={value.resultId} onChange={event => setSelected(event.target.value)}>
      {[...versions].reverse().map((version, index) => <option key={version.resultId} value={version.resultId}>
        {version.resultId === (latestResultId ?? latest?.resultId) ? 'Latest' : `Version ${version.sequence ?? versions.length - index}`} - {date(version.evaluatedAt)}
      </option>)}
    </select></label>}
    <p className="field-help">Assessed {date(value.evaluatedAt)}. {value.resultId === (latestResultId ?? latest?.resultId) ? 'Latest saved result.' : 'Historical result.'}</p>
    <p className="field-help">Urgency and blockers are historical judgments, not live source status.</p>
    {error ? <p role="alert">{error}</p> : <p role="status">{freshness}</p>}
    <dl>
      {mode === 'history' && <>
        <AssessmentRatings value={value} />
        <dt>Work styles when assessed</dt><dd>{value.assessmentVersion === 'work-assessment-v4'
          ? value.workStyles.filter(style => value.assessment.workStyleIds.includes(style.id)).map(style => `${style.name}: ${style.description}`).join('; ') || 'No matching styles.'
          : 'Not recorded in this assessment format.'}</dd>
      </>}
      <dt>Importance</dt><dd>{value.assessment.importance}</dd>
      <dt>Urgency when assessed</dt><dd>{value.assessment.urgency}</dd>
      <dt>Blockers when assessed</dt><dd>{value.assessment.blockers}</dd>
    </dl>
    {mode === 'assessment' && ratingFields.map(field => <details className="assessment-rating" key={field}>
      <summary>{label(field)} - {value.assessmentVersion === 'work-assessment-v2' ? 'Not recorded' : value.assessment[field].rating}</summary>
      <p>{value.assessmentVersion === 'work-assessment-v2' ? 'Not recorded in this assessment format.' : value.assessment[field].rationale}</p>
    </details>)}
    <h4>Uncertainty</h4><p>{value.assessment.uncertainty || 'None recorded.'}</p>
    <h4>Supporting evidence</h4>
    <ul>{value.assessment.supportingEvidence.map((item, index) => <li key={index}>
      {item.summary} <span className="field-help">({item.reference})</span>
    </li>)}</ul>
    <p className="field-help">Original reevaluation suggestion: {date(value.assessment.reevaluateAt)}.
      {' '}This saved judgment remains usable. Assess task explicitly when its scope needs a new judgment.</p>
    {mode === 'history' && <details><summary>Assessment provenance</summary><dl>
      <dt>Agent</dt><dd>{value.assessmentVersion !== 'work-assessment-v2' ? `${value.agent.name} (${value.agent.id})` : 'Legacy task assessor'}</dd>
      {value.assessmentVersion !== 'work-assessment-v2' && <>
        <dt>Agent configuration identity</dt><dd>{value.agent.configurationFingerprint}</dd>
      </>}
      <dt>Model requested</dt><dd>{value.model || 'SDK default (resolved model not reported)'}</dd>
      <dt>Assessment format</dt><dd>{value.assessmentVersion}</dd>
      <dt>Profile ID</dt><dd>{value.profileId}</dd>
      <dt>Original task ID</dt><dd>{value.id}</dd>
      <dt>Result ID</dt><dd>{value.resultId}</dd>
      <dt>Input identity</dt><dd>{value.fingerprint}</dd>
      <dt>Instruction identity</dt><dd>{value.instructionsFingerprint}</dd>
    </dl></details>}
  </section>;
}
