import { useEffect, useState } from 'react';
import { identityDigest } from '../../service/src/work-assessment.ts';
import { semanticRankTask } from '../../service/src/work-rank-input.ts';
import type { WorkSettings } from '../../service/src/work-schema.ts';
import type { Task } from '../types.ts';
import { assessmentFreshness } from './assessments.ts';
import { rankTask } from './engine.ts';

function date(value: string) { return new Date(value).toLocaleString(); }

export function AssessmentHistory({ task, profileId, settings }: { task: Task; profileId: string; settings: WorkSettings }) {
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
        {index === 0 ? 'Latest' : `Version ${versions.length - index}`} - {date(version.evaluatedAt)}
      </option>)}
    </select></label>}
    <p className="field-help">Assessed {date(value.evaluatedAt)}. {value === latest ? 'Latest saved result.' : 'Historical result.'}</p>
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
