import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Modal, WorkspaceApp } from '../App.tsx';
import { getRow } from '../domain/engine.ts';
import { applyCaptureProposal, applyScopedSuggestedOrder, type CaptureProposal } from '../domain/live.ts';
import { githubIdentitySchema, listenNativeTicks } from '../platform/native.ts';
import { downloadBackup } from '../storage.ts';
import type { Row } from '../types.ts';
import { DesktopWorkspace } from './desktop-workspace.ts';
import { ConnectionsPanel, RecoveryPanel, RoutinePanel } from './NativePanels.tsx';
import type { CapturePreview, OrderPreview, RemoteWorkspace } from './remote-view.ts';
import type { Destination, WorkspaceView } from './view.ts';

function DestinationPanel({ destination, controller, remote, close }: {
  destination: Destination; controller: DesktopWorkspace; remote: RemoteWorkspace; close: () => void;
}) {
  const [phase, setPhase] = useState<'ready' | 'pending' | 'requested' | 'error'>('ready');
  const [error, setError] = useState('');
  const { row, kind, action } = destination;
  const isWrite = kind === 'notification';
  const title = isWrite ? action === 'done' ? 'Mark notification done on GitHub' : 'Unsubscribe on GitHub'
    : kind === 'github' ? 'Open on GitHub' : row.thread?.kind === 'pr' ? 'Review in Copilot' : 'Open in Copilot';
  async function confirm() {
    setPhase('pending'); setError('');
    try {
      if (isWrite) await remote.write(destination);
      else {
        const thread = row.thread;
        if (!thread || thread.source !== 'github') throw new Error('This action has no validated GitHub destination.');
        const [owner, repo, extra] = thread.repo.split('/');
        if (extra) throw new Error('The GitHub repository identity is invalid.');
        const identity = githubIdentitySchema.parse({ source: 'github', owner, repo, kind: thread.kind, number: thread.number });
        if (kind === 'github') await controller.platform.launchGitHub(identity);
        else await controller.platform.launchCopilot(identity);
      }
      setPhase('requested');
    } catch (error) { setError(error instanceof Error ? error.message : 'No successful operation was confirmed.'); setPhase('error'); }
  }
  return <Modal title={title} close={close}>
    <p className="dialog-item">{row.title}</p><p className="muted">{row.thread?.repo} #{row.thread?.number}</p>
    {phase === 'requested' ? <div className="outcome"><h3>{isWrite ? 'GitHub confirmed the change' : 'Launch requested, not completed'}</h3><p>{isWrite ? 'Your retained local action and notes are unchanged.' : 'Dispatch does not prove a session or review exists. Your local work stays unfinished.'}</p></div> : <>
      <p>{isWrite ? action === 'done' ? 'Handle the displayed notification evidence on GitHub. Your local action remains a separate commitment.'
        : 'Stop ordinary conversation notifications. Direct mentions, team mentions and new review requests may still notify you.'
        : kind === 'copilot' ? row.thread?.kind === 'pr' ? 'Copilot App asks for confirmation before opening an interactive review session. No notes enter the link.'
          : 'Open this issue in Copilot App. The repository may need to be configured there; Open on GitHub remains available.'
          : 'Open this validated GitHub source in your browser.'}</p>
      {destination.retryId && <p className="notice-inline warning">A prior attempt was not saved as confirmed. Retrying uses its original evidence, not newer requests.</p>}
      {phase === 'pending' && <p role="status">{isWrite ? 'Saving intent, then waiting for GitHub confirmation...' : 'Requesting native launch...'}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>{phase === 'requested' ? 'Return to workspace' : 'Cancel'}</button>
      {phase !== 'requested' && <button className="primary" disabled={phase === 'pending'} onClick={() => void confirm()}>{phase === 'error' ? 'Retry' : isWrite ? 'Confirm GitHub change' : 'Request launch'}<ArrowRight size={15} /></button>}
    </footer>
  </Modal>;
}

function OrderPanel({ preview, pending, error, retry, controller, close }: {
  preview?: OrderPreview; pending: boolean; error: string; retry: () => void; controller: DesktopWorkspace; close: () => void;
}) {
  const [applyError, setApplyError] = useState('');
  return <Modal title="Triage with Copilot" close={close} className="triage-modal">
    <p>Suggestions do not choose or finish work. Private scratch notes are not sent to Copilot.</p>
    {pending && <p role="status">Waiting for a restricted Copilot SDK preview...</p>}
    {preview && <><p className="notice-inline">{preview.scope}</p><ul className="triage-suggestions">{preview.suggestions.map(suggestion => <li key={suggestion.key}>
      <strong>{getRow(controller.state, suggestion.key)?.title ?? 'Previously selected notification'}</strong>
      <p>{suggestion.summary}</p><span className="field-help">{suggestion.uncertainty}</span><p>Suggested next step: {suggestion.nextStep}</p>
      <details className="sources"><summary>Evidence considered</summary>{suggestion.evidence.map((text, index) => <p key={index}>{text}</p>)}</details>
    </li>)}</ul></>}
    {(error || applyError) && <p className="inline-error" role="alert">{applyError || error}</p>}
    {error && <button className="secondary" disabled={pending} onClick={retry}>Retry Copilot preview</button>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>Keep current order</button>
      <button className="text-button" disabled={pending} onClick={() => { controller.dispatch({ type: 'reconsider' }, 'Local priority rules applied. No AI request.'); close(); }}>Use local priority rules</button>
      <button className="primary" disabled={pending || !preview} onClick={() => {
        try { controller.update(state => applyScopedSuggestedOrder(state, preview!.fingerprint, preview!.keys, preview!.order)); close(); }
        catch (error) { setApplyError(error instanceof Error ? error.message : 'No suggested order was applied.'); }
      }}>Apply suggested order</button>
    </footer>
  </Modal>;
}

function CapturePanel({ preview, pending, error, retry, controller, close }: {
  preview?: CapturePreview; pending: boolean; error: string; retry: () => void; controller: DesktopWorkspace; close: () => void;
}) {
  const [proposal, setProposal] = useState<CaptureProposal>();
  const [applyError, setApplyError] = useState('');
  useEffect(() => { setProposal(preview?.proposal); }, [preview]);
  return <Modal title="Interpret capture with Copilot" close={close}>
    <p>The original capture remains saved. Edit this proposal before applying it.</p>
    {pending && <p role="status">Saving the original, then requesting a restricted SDK preview...</p>}
    {proposal && <>
      <label>Proposed action<input value={proposal.title} onChange={event => setProposal({ ...proposal, title: event.target.value })} /></label>
      <label>Kind<select value={proposal.kind} onChange={event => setProposal({ ...proposal, kind: event.target.value as CaptureProposal['kind'] })}><option value="action">Local action</option><option value="routine">Daily routine</option><option value="unsupported">Keep as an ordinary capture</option></select></label>
      <label>Steps, one per line<textarea rows={4} value={proposal.steps.join('\n')} onChange={event => setProposal({ ...proposal, steps: event.target.value.split('\n') })} /></label>
      {proposal.kind === 'routine' && <><label>Daily time<input type="time" value={proposal.dailyAt ?? ''} onChange={event => setProposal({ ...proposal, dailyAt: event.target.value })} /></label><label>Timezone<input value={proposal.timeZone} onChange={event => setProposal({ ...proposal, timeZone: event.target.value })} /></label></>}
      <p className="notice-inline">{proposal.uncertainty}</p>
    </>}
    {(error || applyError) && <p className="inline-error" role="alert">{applyError || error}</p>}
    {error && <button className="secondary" onClick={retry}>Retry interpretation</button>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>Keep original</button><button className="primary" disabled={!preview || !proposal || pending} onClick={() => {
      try {
        controller.update(state => applyCaptureProposal(state, preview!.key, preview!.fingerprint, { ...proposal!, steps: proposal!.steps.map(step => step.trim()).filter(Boolean) }));
        close();
      } catch (error) { setApplyError(error instanceof Error ? error.message : 'The capture proposal was not applied.'); }
    }}>Apply proposal</button></footer>
  </Modal>;
}

export function DesktopApp({ controller, remote }: { controller: DesktopWorkspace; remote: RemoteWorkspace }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const network = useSyncExternalStore(remote.subscribe, remote.getSnapshot);
  const [connections, setConnections] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [routine, setRoutine] = useState<Row>();
  const [destination, setDestination] = useState<Destination>();
  const [previewMode, setPreviewMode] = useState<'triage' | 'reconsider' | Row>();
  const [order, setOrder] = useState<OrderPreview>();
  const [capture, setCapture] = useState<CapturePreview>();
  const [pending, setPending] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewGeneration = useRef(0);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenNativeTicks(tick => controller.clock(tick), error => controller.report(error)).then(stop => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(error => controller.report(error));
    void controller.load();
    return () => { disposed = true; unlisten?.(); };
  }, [controller]);
  const run = (operation: () => Promise<void>) => { void operation().catch(error => controller.report(error)); };
  async function preview(mode: 'triage' | 'reconsider' | Row) {
    const generation = ++previewGeneration.current;
    setPreviewMode(mode); setOrder(undefined); setCapture(undefined); setPreviewError(''); setPending(true);
    try {
      if (typeof mode === 'string') {
        const result = await remote.triage(mode);
        if (generation === previewGeneration.current) setOrder(result);
      } else {
        const result = await remote.interpret(mode);
        if (generation === previewGeneration.current) setCapture(result);
      }
    } catch (error) { if (generation === previewGeneration.current) setPreviewError(error instanceof Error ? error.message : 'Copilot returned no valid preview.'); }
    finally { if (generation === previewGeneration.current) setPending(false); }
  }
  const closePreview = () => { previewGeneration.current += 1; setPreviewMode(undefined); run(() => remote.cancelPreview()); };
  if (!status.workspace) return <main className="desktop-loading">
    <h1>GitHub Projects</h1><h2>{status.loading ? 'Reading saved work...' : 'Saved work could not load'}</h2>
    <p>No GitHub request runs on startup. No browser demo data is loaded.</p>
    {status.loadError && <p className="inline-error" role="alert">{status.loadError}</p>}
    {!status.loading && <div className="button-row"><button className="secondary" onClick={() => run(() => controller.reload())}><RefreshCw size={15} />Retry reading saved work</button><button className="secondary" onClick={() => setRecovery(true)}>Backups & recovery</button></div>}
    {recovery && <RecoveryPanel controller={controller} close={() => setRecovery(false)} />}
  </main>;
  const workspace: WorkspaceView = {
    state: status.workspace.state, scroll: status.workspace.scroll, dispatch: controller.dispatch,
    storageError: status.persistence.error, operationError: status.operationError,
    feedback: status.feedback, clearFeedback: controller.clearFeedback,
    retryStorage: replace => run(() => controller.retryStorage(replace)), saveScroll: controller.saveScroll,
    exportBackup: original => run(async () => downloadBackup(original ? await controller.savedJson() : controller.pendingJson(), original ? 'github-projects-saved.json' : 'github-projects-pending.json')),
    desktop: {
      saving: status.persistence.pending, refreshing: network.refreshing, refresh: () => run(() => remote.refresh()),
      open: setDestination, connections: () => setConnections(true), routine: setRoutine,
      triage: mode => { void preview(mode); }, interpret: row => { void preview(row); },
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
    {routine && <RoutinePanel controller={controller} row={routine} close={() => setRoutine(undefined)} />}
    {destination && <DestinationPanel key={destination.retryId ?? `${destination.row.key}:${destination.kind}:${destination.action}`} destination={destination} controller={controller} remote={remote} close={() => setDestination(undefined)} />}
    {previewMode && typeof previewMode === 'string' && <OrderPanel preview={order} pending={pending} error={previewError} retry={() => void preview(previewMode)} controller={controller} close={closePreview} />}
    {previewMode && typeof previewMode !== 'string' && <CapturePanel preview={capture} pending={pending} error={previewError} retry={() => void preview(previewMode)} controller={controller} close={closePreview} />}
  </WorkspaceApp>;
}
