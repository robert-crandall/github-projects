import { useEffect, useState } from 'react';
import { Clock3, Download, RefreshCw } from 'lucide-react';
import { Modal } from '../App.tsx';
import type { Row } from '../types.ts';
import type { DesktopWorkspace } from './desktop-workspace.ts';
import { downloadBackup } from '../storage.ts';

export function RoutinePanel({ controller, row, close }: { controller: DesktopWorkspace; row: Row; close: () => void }) {
  const [time, setTime] = useState('10:00');
  const [zone, setZone] = useState(controller.state.timeZone);
  const [steps, setSteps] = useState('');
  const [error, setError] = useState('');
  return <Modal title="Set up a daily routine" close={close}>
    <p>{row.title}</p><p className="muted">One step per line. I record these after doing them in my existing tools.</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (controller.dispatch({ type: 'routine', key: row.key, time, timeZone: zone, steps: steps.split('\n').map(step => step.trim()).filter(Boolean) })) close();
      else setError(controller.getSnapshot().operationError);
    }}>
      <label>Daily time<input type="time" value={time} onChange={event => setTime(event.target.value)} required /></label>
      <label>Timezone<input value={zone} onChange={event => setZone(event.target.value)} required /></label>
      <label>Ordered steps<textarea autoFocus rows={5} value={steps} onChange={event => setSteps(event.target.value)} required /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary"><Clock3 size={15} />Save routine</button></footer>
    </form>
  </Modal>;
}

export function RecoveryPanel({ controller, close }: { controller: DesktopWorkspace; close: () => void }) {
  const [backups, setBackups] = useState<{ id: string; createdAt: string }[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
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
      <button className="secondary" disabled={!controller.getSnapshot().workspace} onClick={() => {
        try { downloadBackup(controller.pendingJson(), 'github-projects-pending.json'); }
        catch (error) { setError(error instanceof Error ? error.message : 'Pending export failed.'); }
      }}><Download size={15} />Export pending copy</button>
      <button className="secondary" disabled={pending} onClick={() => void run(async () => {
        const result = await controller.platform.exportRaw();
        setNotice(`Original database files preserved locally: ${result.directory}`);
      })}>Preserve database files</button>
    </div>
    <label>Saved backup<select value={selected} onChange={event => { setSelected(event.target.value); setConfirm(false); }}>
      <option value="">Choose a backup</option>{backups.map(backup => <option key={backup.id} value={backup.id}>{backup.createdAt} · {backup.id === 'latest' ? 'Previous save' : backup.id}</option>)}
    </select></label>
    {!backups.length && <p className="muted">No backup is available. Preserve the original database files before further repair.</p>}
    <label className="checkbox-label"><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />I exported any pending edits I need. Replace this workspace with the selected backup.</label>
    {notice && <p className="notice-inline" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <footer className="modal-footer"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={pending || !selected || !confirm} onClick={() => void run(async () => {
      await controller.recoverBackup(selected);
      if (controller.getSnapshot().loadError) throw new Error(controller.getSnapshot().loadError);
      close();
    })}>Restore selected backup</button></footer>
  </Modal>;
}

export function ConnectionsPanel({ controller, checking, diagnostics, check, recover, retryOperation, close }: {
  controller: DesktopWorkspace; checking: boolean; diagnostics: string[]; check: () => void;
  recover: () => void; retryOperation: (id: string) => void; close: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const status = controller.getSnapshot();
  async function run(operation: () => Promise<void>) {
    setPending(true); setError('');
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : 'The native operation could not finish.'); }
    finally { setPending(false); }
  }
  useEffect(() => { void controller.readReminderStatus(); }, [controller]);
  return <Modal title="Connections" close={close}>
    <section className="demo-section"><h3>GitHub and Copilot</h3><p>Local work needs no sign-in. Check connections only when you choose; Refresh is always manual.</p>
      <button className="secondary" disabled={checking} onClick={check}><RefreshCw size={15} />{checking ? 'Checking connections...' : 'Check connections'}</button>
      {diagnostics.map((diagnostic, index) => <p className="notice-inline" key={index}>{diagnostic}</p>)}
      {!diagnostics.length && <p className="muted">Not checked. Install GitHub CLI and sign in with <code>gh auth login</code>. Copilot requires an account with access.</p>}
    </section>
    <section className="demo-section"><h3>Local reminders</h3>
      <p>{status.reminders ? `Permission: ${status.reminders.permission.state}. Alerts ${status.reminders.permission.alertsEnabled ? 'enabled' : 'disabled'}.` : 'Permission status unavailable.'}</p>
      <div className="button-row"><button className="secondary" disabled={pending} onClick={() => void run(() => controller.enableReminders())}>Enable reminders</button><button className="text-button" disabled={pending} onClick={() => void run(() => controller.readReminderStatus())}>Read permission status</button></div>
      <p className="muted">{status.reminders?.limitations ?? 'Closing the window keeps reminders in the menu bar. Quit stops them. Sleep, Focus and macOS settings may delay or suppress alerts.'}</p>
      {status.reminders?.deliveries.filter(delivery => delivery.status === 'failed' || delivery.status === 'uncertain').map(delivery => <div key={delivery.deliveryKey} className="source-event">
        <span>{delivery.status === 'uncertain' ? 'Delivery outcome is uncertain. Retrying may duplicate an alert.' : 'The native reminder request failed.'}</span>
        <button className="text-button" disabled={pending} onClick={() => void run(() => controller.retryReminder(delivery.deliveryKey))}>Retry reminder delivery</button>
      </div>)}
      {(status.reminderError || error) && <p className="inline-error" role="alert">{error || status.reminderError}</p>}
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
