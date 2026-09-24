import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Modal } from '../Modal.tsx';
import { githubIdentitySchema } from '../platform/native.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import type { RemoteWorkspace } from './remote-view.ts';
import type { Destination } from './view.ts';

export function DestinationPanel({ destination, controller, remote, close }: {
  destination: Destination; controller: DesktopWorkspace; remote: RemoteWorkspace; close: () => void;
}) {
  const [phase, setPhase] = useState<'ready' | 'pending' | 'requested' | 'error'>('ready');
  const [error, setError] = useState('');
  const [retryId, setRetryId] = useState(destination.retryId);
  const { row, kind, action } = destination;
  const isWrite = kind === 'notification';
  const title = isWrite ? action === 'done' ? 'Mark notification done on GitHub' : 'Unsubscribe on GitHub'
    : kind === 'github' ? 'Open on GitHub' : row.thread?.kind === 'pr' ? 'Review in Copilot' : 'Open in Copilot';
  async function confirm() {
    setPhase('pending'); setError('');
    const existingIds = new Set(controller.state.operations.map(operation => operation.id));
    try {
      if (isWrite) await remote.write({ ...destination, retryId });
      else {
        const thread = row.thread;
        if (!thread || thread.source !== 'github') throw new Error('This thread has no validated GitHub destination.');
        const [owner, repo, extra] = thread.repo.split('/');
        if (extra) throw new Error('The GitHub repository identity is invalid.');
        const identity = githubIdentitySchema.parse({ source: 'github', owner, repo, kind: thread.kind, number: thread.number });
        if (kind === 'github') await controller.platform.launchGitHub(identity);
        else await controller.platform.launchCopilot(identity);
      }
      setPhase('requested');
    } catch (error) {
      const created = controller.state.operations.find(operation => !existingIds.has(operation.id) && operation.threadId === row.thread?.id && operation.action === action);
      if (created) setRetryId(created.id);
      setError(error instanceof Error ? error.message : 'No successful operation was confirmed.');
      setPhase('error');
    }
  }
  return <Modal title={title} close={close}>
    <p className="dialog-item">{row.title}</p><p className="muted">{row.thread?.repo} #{row.thread?.number}</p>
    {phase === 'requested' ? <div className="outcome"><h3>{isWrite ? 'GitHub confirmed the change' : 'Launch requested, not completed'}</h3><p>{isWrite ? 'Your notes and tasks are unchanged.' : 'Dispatch does not prove a session or review exists. Your notes and tasks are unchanged.'}</p></div> : <>
      <p>{isWrite ? action === 'done' ? 'Mark this notification done on GitHub. Tasks and notes do not change. GitHub acknowledges the whole notification, not individual messages.'
        : 'Stop ordinary conversation notifications. Mentions and new review requests may still notify you. Tasks and notes do not change.'
        : kind === 'copilot' ? row.thread?.kind === 'pr' ? 'Copilot App asks for confirmation before opening an interactive review session. No notes enter the link.'
          : 'Open this issue in Copilot App. The repository may need to be configured there; Open on GitHub remains available.'
          : 'Open this validated GitHub source in your browser.'}</p>
      {isWrite && action === 'done' && <p className="field-help">I check for newer notification activity before sending. GitHub cannot make that check and write atomic; activity arriving between them may also be marked done there. New evidence already received here stays pending.</p>}
      {retryId && <p className="notice-inline warning">A prior attempt was not saved as confirmed. Retrying uses its original evidence, not newer requests.</p>}
      {isWrite && row.events.length > 200 && <p className="notice-inline">This operation records the 200 most recent pending events. Older local evidence remains unchanged.</p>}
      {phase === 'pending' && <p role="status">{isWrite ? 'Saving intent, then waiting for GitHub confirmation...' : 'Requesting native launch...'}</p>}
      {error && <p className="inline-error" role="alert">{error}{isWrite && ' An unconfirmed request may have reached GitHub. Tasks and notes are unchanged.'}</p>}
    </>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>{phase === 'requested' ? 'Return to workspace' : phase === 'pending' ? 'Close; request continues' : 'Cancel'}</button>
      {phase !== 'requested' && <button className="primary" disabled={phase === 'pending'} onClick={() => void confirm()}>{phase === 'error' ? 'Retry' : isWrite ? 'Confirm GitHub change' : 'Request launch'}<ArrowRight size={15} /></button>}
    </footer>
  </Modal>;
}
