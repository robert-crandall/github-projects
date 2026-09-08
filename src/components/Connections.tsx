import { useEffect, useState } from 'react';
import { AlertCircle, Bell, Check, Download, RefreshCw, Upload } from 'lucide-react';
import type { useWorkspace } from '../useWorkspace.ts';
import type { NotificationStatus } from '../desktop-contract.ts';
import { desktopCommand, errorText } from '../desktop.ts';

export function Connections({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { connections, connectionError, checkConnections, syncing, syncGitHub, aiBusy, prioritize } = workspace;
  const [ghPath, setGhPath] = useState('');
  const [copilotPath, setCopilotPath] = useState('');
  const [permission, setPermission] = useState<NotificationStatus>({ permission: 'prompt' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setGhPath(connections?.github.path ?? '');
    setCopilotPath(connections?.copilot.path ?? '');
  }, [connections]);
  useEffect(() => {
    desktopCommand('notification_status', {}).then(setPermission)
      .catch(error => setError(`Notification permission could not be read: ${errorText(error)}`));
  }, []);

  async function notifications(test = false) {
    try {
      const current = await desktopCommand('notification_status', {});
      const status = current.permission === 'prompt'
        ? await desktopCommand('request_notification_permission', {}) : current;
      setPermission(status);
      if (status.permission === 'unavailable') throw new Error(status.error || 'Native reminders require the built .app. Build and launch the local app bundle to enable reminders.');
      if (status.permission !== 'granted') throw new Error('Notifications are not allowed. Enable GitHub Projects in macOS System Settings > Notifications. Due work remains visible in the app.');
      if (test) {
        await desktopCommand('notification_test', {});
        setNotice('Test notification requested. Focus settings may silence it.');
      } else setNotice('Notifications enabled. Each routine sends one reminder.');
      setError('');
      workspace.setNativeError('');
    } catch (error) { setError(errorText(error)); }
  }

  async function exportWorkspace() {
    try {
      if (!await desktopCommand('workspace_export', { state: workspace.state })) return;
      setNotice('Workspace backup exported.');
      setError('');
    } catch (error) { setError(errorText(error)); }
  }

  return <>
    <div className="page-heading"><h1>Connections</h1><p>Your work stays local. GitHub is read-only; Copilot receives only the context needed for suggestions.</p></div>
    {(error || connectionError) && <div className="error-panel" role="alert"><AlertCircle size={18} /><p>{error || connectionError}</p></div>}
    {notice && <p className="notice-inline" role="status"><Check size={15} /> {notice}</p>}
    <section className="connection-section">
      <div className="section-heading"><h2>GitHub</h2><button className="quiet" onClick={() => void checkConnections()}><RefreshCw size={15} />Check connections</button></div>
      <p>{connections?.github.authenticated ? `Signed in as ${connections.github.login}.` : connections?.github.error || 'Checking your GitHub CLI sign-in...'}</p>
      {!connections?.github.authenticated && <p className="field-help">Sign in from a terminal with <code>gh auth login</code>, then check connections again. Private organizations may require SSO authorization.</p>}
      <button className="secondary" disabled={syncing} onClick={() => void syncGitHub()}><RefreshCw size={15} />{syncing ? 'Refreshing GitHub...' : 'Refresh GitHub now'}</button>
      <p className="field-help">Refreshes every five minutes while the app is running. Direct requests and Terraform Provider Core Maintainers team requests remain distinct.</p>
    </section>
    <section className="connection-section">
      <h2>Copilot</h2>
      <p>{connections?.copilot.error || (connections?.copilot.authenticated ? `Signed in to Copilot${connections.copilot.login ? ` as ${connections.copilot.login}` : ''}.` : connections?.copilot.available ? 'Copilot runtime available. Check your sign-in before requesting suggestions.' : 'Copilot runtime has not been found.')}</p>
      <p className="field-help">Use your existing Copilot CLI sign-in. Suggestions use your Copilot allowance. No shell, file-editing, or production tools are available to the model.</p>
      <button className="secondary" disabled={aiBusy} onClick={() => void prioritize()}>{aiBusy ? 'Considering your work...' : 'Reconsider priorities'}</button>
      {aiBusy && <button className="quiet" onClick={() => void workspace.cancelCopilot()}>Cancel Copilot request</button>}
      <p className="field-help">I consider up to 40 actionable items at a time. Notes and idle clock ticks do not trigger another request. Active work stays in place.</p>
    </section>
    <section className="connection-section">
      <h2>Reminders</h2>
      <p>{permission.permission === 'granted' ? 'macOS notifications are allowed.' : permission.error || 'Allow notifications to receive routine reminders outside the app.'}</p>
      <div className="button-row"><button className="secondary" onClick={() => void notifications()}><Bell size={15} />Enable reminders</button><button className="quiet" onClick={() => void notifications(true)}>Send test reminder</button></div>
      <p className="field-help">Closing the window keeps the menu-bar app running. Quit stops reminders. Reopening preserves missed days without catch-up increases.</p>
    </section>
    <details className="disclosure">
      <summary>Executable paths</summary>
      <form className="edit-form disclosure-body" onSubmit={async event => {
        event.preventDefault();
        setSaving(true);
        try {
          await desktopCommand('configure_tools', { ghPath: ghPath.trim(), copilotPath: copilotPath.trim() });
          await checkConnections();
          setError('');
          setNotice('Executable paths saved.');
        } catch (error) { setError(errorText(error)); }
        finally { setSaving(false); }
      }}>
        <p className="field-help">Finder does not always inherit your terminal PATH. Use the full path to each installed executable, not a command or token.</p>
        <label>GitHub CLI<input value={ghPath} onChange={event => setGhPath(event.target.value)} placeholder="/opt/homebrew/bin/gh" /></label>
        <label>Copilot CLI<input value={copilotPath} onChange={event => setCopilotPath(event.target.value)} placeholder="/Users/you/.local/bin/copilot" /></label>
        <button className="secondary" disabled={saving}>{saving ? 'Saving...' : 'Save paths'}</button>
      </form>
    </details>
    <section className="connection-section">
      <h2>Local workspace</h2>
      <p className="field-help storage-path">{connections?.databasePath || 'Stored in the app data directory.'}</p>
      <div className="button-row">
        <button className="secondary" onClick={() => void exportWorkspace()}><Download size={15} />Export backup</button>
        <label className="import-control"><Upload size={15} />Import backup or captures<input type="file" accept=".json,application/json" onChange={async event => {
          const file = event.target.files?.[0];
          if (!file) return;
          try { await workspace.importWorkspace(await file.text()); }
          catch (error) { setError(errorText(error)); }
          event.target.value = '';
        }} /></label>
      </div>
      <p className="field-help">Import requires no local captures, edits, or progress. Automatically discovered GitHub work is kept. Browser prototype data requires a captures-only export, so synthetic fixtures do not become real work.</p>
    </section>
  </>;
}
