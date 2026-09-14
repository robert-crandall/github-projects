import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Modal, WorkspaceApp } from '../App.tsx';
import { getRow } from '../domain/engine.ts';
import { githubIdentitySchema } from '../platform/native.ts';
import { downloadBackup } from '../storage.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { ConnectionsPanel, RecoveryPanel } from './NativePanels.tsx';
import type { RemoteWorkspace } from './remote-view.ts';
import type { Destination, WorkspaceView } from './view.ts';
import { ConversationReader } from './ConversationReader.tsx';
import { conversationKey } from '../../service/src/schema.ts';

function DestinationPanel({ destination, controller, remote, close }: {
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
      <p>{isWrite ? action === 'done' ? 'Mark this notification done on GitHub. Inbox and Archive here do not change. GitHub acknowledges the whole notification, not individual messages.'
        : 'Stop ordinary conversation notifications. Mentions and new review requests may still notify you. Inbox, Archive and your notes here do not change.'
        : kind === 'copilot' ? row.thread?.kind === 'pr' ? 'Copilot App asks for confirmation before opening an interactive review session. No notes enter the link.'
          : 'Open this issue in Copilot App. The repository may need to be configured there; Open on GitHub remains available.'
          : 'Open this validated GitHub source in your browser.'}</p>
      {isWrite && action === 'done' && <p className="field-help">I check for newer notification activity before sending. GitHub cannot make that check and write atomic; activity arriving between them may also be marked done there. New evidence already received here stays pending.</p>}
      {retryId && <p className="notice-inline warning">A prior attempt was not saved as confirmed. Retrying uses its original evidence, not newer requests.</p>}
      {isWrite && row.events.length > 200 && <p className="notice-inline">This operation records the 200 most recent pending events. Older local evidence remains unchanged.</p>}
      {phase === 'pending' && <p role="status">{isWrite ? 'Saving intent, then waiting for GitHub confirmation...' : 'Requesting native launch...'}</p>}
      {error && <p className="inline-error" role="alert">{error}{isWrite && ' An unconfirmed request may have reached GitHub. Local notes and Archive are unchanged.'}</p>}
    </>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>{phase === 'requested' ? 'Return to workspace' : phase === 'pending' ? 'Close; request continues' : 'Cancel'}</button>
      {phase !== 'requested' && <button className="primary" disabled={phase === 'pending'} onClick={() => void confirm()}>{phase === 'error' ? 'Retry' : isWrite ? 'Confirm GitHub change' : 'Request launch'}<ArrowRight size={15} /></button>}
    </footer>
  </Modal>;
}

export function DesktopApp({ controller, remote }: { controller: DesktopWorkspace; remote: RemoteWorkspace }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const network = useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  const conversation = useSyncExternalStore(remote.conversation.subscribe, remote.conversation.getSnapshot);
  const [connections, setConnections] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [destination, setDestination] = useState<Destination>();
  useEffect(() => {
    void controller.load();
  }, [controller]);
  const selection = status.workspace?.state.selectedKey;
  useEffect(() => {
    if (!selection?.startsWith('t:')) void remote.conversation.select(null);
  }, [remote, selection]);
  const run = (operation: () => Promise<void>) => { void operation().catch(error => controller.report(error)); };
  if (!status.workspace) return <main className="desktop-loading">
    <h1>GitHub Projects</h1><h2>{status.loading ? 'Reading saved work...' : 'Saved work could not load'}</h2>
    <p>No GitHub request runs on startup. No browser demo data is loaded.</p>
    {status.loadError && <p className="inline-error" role="alert">{status.loadError}</p>}
    {!status.loading && <div className="button-row"><button className="secondary" onClick={() => run(() => controller.reload())}><RefreshCw size={15} />Retry reading saved work</button><button className="secondary" onClick={() => setRecovery(true)}>Backups & recovery</button></div>}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
  </main>;
  const timeZone = status.workspace.state.timeZone;
  const workspace: WorkspaceView = {
    state: status.workspace.state, scroll: status.workspace.scroll, dispatch: controller.dispatch,
    storageError: status.persistence.error, operationError: status.operationError,
    feedback: status.feedback, clearFeedback: controller.clearFeedback,
    retryStorage: replace => run(() => controller.retryStorage(replace)), saveScroll: controller.saveScroll,
    exportBackup: original => run(async () => downloadBackup(original ? await controller.savedJson() : controller.pendingJson(), original ? 'github-projects-saved.json' : 'github-projects-pending.json')),
    desktop: {
      saving: status.persistence.pending, refreshing: network.refreshing, refresh: () => run(() => remote.refresh()),
      open: setDestination, archive: row => run(() => remote.archive(row)), connections: () => setConnections(true),
      waiting: network.waiting, generateWaiting: () => run(() => remote.generateWaiting()),
      openWaiting: async reference => {
        const [owner, repo] = reference.repo.split('/');
        await controller.platform.launchGitHub(githubIdentitySchema.parse({
          source: 'github', owner, repo, kind: reference.kind, number: reference.number,
        }));
      },
      conversation: reference => <ConversationReader reference={reference} controller={remote.conversation}
        platform={controller.platform} refreshing={network.refreshing} timeZone={timeZone} />,
      readerReady: reference => !conversation.reading && !!conversation.reference
        && conversationKey(reference) === conversationKey(conversation.reference),
    },
  };
  return <WorkspaceApp workspace={workspace}>
    {connections && <ConnectionsPanel controller={controller} checking={network.checking} diagnostics={network.diagnostics} check={() => run(() => remote.check())}
      recover={() => { setConnections(false); setRecovery(true); }} close={() => setConnections(false)} retryOperation={id => {
        const operation = controller.state.operations.find(operation => operation.id === id);
        const row = operation && getRow(controller.state, `t:${operation.threadId}`);
        if (row && operation) { setConnections(false); setDestination({ row, kind: 'notification', action: operation.action, retryId: id }); }
      }} />}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
    {destination && <DestinationPanel key={destination.retryId ?? `${destination.row.key}:${destination.kind}:${destination.action}`} destination={destination} controller={controller} remote={remote} close={() => setDestination(undefined)} />}
  </WorkspaceApp>;
}
