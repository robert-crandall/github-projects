import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Modal } from '../Modal.tsx';
import type { DesktopWorkspace } from './desktop-workspace.ts';
import { downloadBackup } from '../storage.ts';

export function RecoveryPanel({ controller, close }: { controller: DesktopWorkspace; close: () => void }) {
  const [backups, setBackups] = useState<{ id: string; createdAt: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [imported, setImported] = useState('');
  async function run(operation: () => Promise<void>) {
    setPending(true); setError('');
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Recovery could not finish. The saved copy was not confirmed.'); }
    finally { setPending(false); }
  }
  useEffect(() => { void run(async () => setBackups(await controller.platform.listBackups())); }, [controller]);
  return <Modal title="Recover saved work" close={close}>
    <p>Recovery is explicit. Export pending edits first; restoring a backup replaces the loaded workspace, not GitHub state.</p>
    <div className="button-row">
      <button className="secondary" disabled={pending || !controller.getSnapshot().workspace} onClick={() => void run(async () => {
        downloadBackup(await controller.fullPendingJson(), 'github-projects-pending.json');
      })}><Download size={15} />Export pending copy</button>
      {controller.getSnapshot().assessmentPending.length > 0 && <button className="secondary" onClick={() => {
        downloadBackup(controller.pendingAssessmentsJson(), 'github-projects-pending-assessments.json');
      }}>Export pending assessments</button>}
      <button className="secondary" disabled={pending} onClick={() => void run(async () => {
        const result = await controller.platform.exportRaw();
        setNotice(`Original database files preserved locally: ${result.directory}`);
      })}>Preserve database files</button>
    </div>
    <label>Saved backup<select value={selected} onChange={event => { setSelected(event.target.value); setImported(''); setConfirm(false); }}>
      <option value="">Choose a backup</option>{backups.map(backup => <option key={backup.id} value={backup.id}>{backup.createdAt} · {backup.id === 'latest' ? 'Previous save' : backup.id}</option>)}
    </select></label>
    <label>Import a workspace JSON export<input type="file" accept=".json,application/json" disabled={pending}
      onChange={event => {
        const file = event.target.files?.[0];
        setImported(''); setConfirm(false);
        if (file) void run(async () => {
          if (file.size > 64 * 1024 * 1024) throw new Error('JSON import exceeds 64 MiB. Restore a database backup instead.');
          setImported(await file.text()); setSelected('');
        });
      }} /></label>
    {!backups.length && <p className="muted">No backup is available. Preserve the original database files before further repair.</p>}
    <label className="checkbox-label"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />I exported pending edits and assessments. Replace this workspace and its assessment history with the selected backup or import.</label>
    {notice && <p className="notice-inline" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={pending || (!selected && !imported) || !confirm} onClick={() => void run(async () => {
      if (imported) await controller.importJson(imported);
      else await controller.recoverBackup(selected);
      if (controller.getSnapshot().loadError) throw new Error(controller.getSnapshot().loadError);
      close();
    })}>{imported ? 'Import workspace' : 'Restore selected backup'}</button></footer>
  </Modal>;
}

export function ConnectionsPanel({ controller, checking, diagnostics, check, recover, retryOperation, close }: {
  controller: DesktopWorkspace; checking: boolean; diagnostics: string[]; check: () => void;
  recover: () => void; retryOperation: (id: string) => void; close: () => void;
}) {
  return <Modal title="Connections" close={close}>
    <section className="demo-section"><h3>GitHub and Copilot</h3><p>Local work needs no sign-in. Check connections only when you choose.</p>
      <button className="secondary" disabled={checking} onClick={check}><RefreshCw size={15} />{checking ? 'Checking connections...' : 'Check connections'}</button>
      {diagnostics.map((diagnostic, index) => <p className="notice-inline" key={index}>{diagnostic}</p>)}
      {!diagnostics.length && <p className="muted">Not checked. Install GitHub CLI and sign in with <code>gh auth login</code>. Copilot requires an account with access.</p>}
    </section>
    <section className="demo-section"><h3>GitHub operations</h3>
      {controller.state.operations.filter(operation => operation.status !== 'confirmed').map(operation => <div className="source-event" key={operation.id}>
        <span>{operation.action === 'done' ? 'Acknowledge notification' : 'Unsubscribe'} · {operation.status}</span><small>{operation.message}</small>
        <button className="text-button" disabled={operation.status === 'pending'} onClick={() => retryOperation(operation.id)}>Review and retry</button>
      </div>)}
      {!controller.state.operations.some(operation => operation.status !== 'confirmed') && <p className="muted">No pending or failed GitHub operations.</p>}
    </section>
    <footer className="modal-footer"><button className="text-button" onClick={recover}>Backups & recovery</button><button className="primary" onClick={close}>Back to workspace</button></footer>
  </Modal>;
}
