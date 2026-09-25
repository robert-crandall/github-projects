import type { CodeBatch, CodeSessions } from './code-sessions.ts';
import type { DesktopWorkspace } from '../runtime/desktop-workspace.ts';

const labels = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  skipped: 'Skipped', 'not-inspected': 'No code inspected', 'not-started': 'Not started', 'save-pending': 'Result not saved',
};

export function CodeBatchProgress({ batch, sessions, controller, inspect }: {
  batch: CodeBatch; sessions: CodeSessions; controller: DesktopWorkspace; inspect: (id: string) => void;
}) {
  const counts = (status: keyof typeof labels) => batch.items.filter(item => item.status === status).length;
  const current = batch.items.find(item => item.status === 'running');
  return <section className="task-run code-batch" aria-label="Code batch">
    <div className="task-run-line"><strong>{batch.job === 'pr-review' ? 'PR review batch' : 'Implementation assessment batch'} · {batch.profileName}</strong>
      {batch.running && <button className="secondary" disabled={sessions.getSnapshot().active?.cancelRequested} onClick={() => {
        void sessions.stopBatch().catch(error => controller.report(error));
      }}>Stop batch</button>}
    </div>
    <p role="status">{batch.running ? batch.stopping ? 'Stopping; waiting for the current task outcome.' : `Current task: ${current?.title ?? 'Preparing...'}`
      : batch.reason ? 'Batch stopped.' : 'Batch finished.'}</p>
    <p className="field-help">Started with {batch.items.length} selected tasks. Navigation does not change this batch.</p>
    <p className="field-help">{counts('completed') > 0 && `${counts('completed')} completed · `}
      {counts('not-inspected') > 0 && `${counts('not-inspected')} not inspected · `}
      {counts('failed')} failed · {counts('cancelled')} cancelled · {counts('skipped')} skipped · {counts('not-started')} not started
      {counts('queued') > 0 && ` · ${counts('queued')} queued`}{counts('save-pending') > 0 && ` · ${counts('save-pending')} result not saved`}</p>
    {batch.reason && <p className="field-help">{batch.reason}</p>}
    <details className="task-run-details"><summary>Batch outcomes</summary><div className="task-run-ledger">
      <p className="field-help">{counts('completed') > 0 && 'Completed means a saved, partial inspection. '}
        Code jobs never approve or implement changes. Nothing resumes automatically.</p>
      <ul className="code-batch-items">{batch.items.map(item => <li key={item.taskId}>
        <span>{item.title} — {labels[item.status]}</span>
        {item.detail && <p className="field-help">{item.detail}</p>}
        {batch.profileId === controller.state.activeWorkProfile.id && batch.workspaceGeneration === controller.assessmentGeneration
          && controller.state.tasks.some(task => task.id === item.taskId) && <button className="text-button" onClick={() => inspect(item.taskId)}>Inspect task</button>}
      </li>)}</ul>
    </div></details>
  </section>;
}
