import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { nativePlatform, NativePlatformError, type NativeClock } from './native.ts';
import '../theme.css';
import './foundation.css';

function Foundation() {
  const [storage, setStorage] = useState('Reading the isolated desktop workspace...');
  const [permission, setPermission] = useState('Checking reminder permission...');
  const [clock, setClock] = useState<NativeClock>();
  const [error, setError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  function report(error: unknown) {
    setError(error instanceof NativePlatformError ? error.message : 'Native status is unavailable. No operation was confirmed.');
  }
  useEffect(() => {
    void nativePlatform.workspaceRead().then(saved => {
      setStorage(saved.snapshot ? 'A saved desktop workspace is available.' : 'No desktop workspace has been saved.');
    }).catch(report);
    void nativePlatform.clockNow().then(setClock).catch(report);
    void nativePlatform.reminderStatus().then(status => {
      setPermission(`Permission: ${status.permission.state}. Alerts ${status.permission.alertsEnabled ? 'enabled' : 'disabled'}.`);
    }).catch(report);
  }, []);
  async function enableReminders() {
    setRequesting(true);
    try {
      const result = await nativePlatform.requestReminderPermission();
      setPermission(`Permission: ${result.state}. Alerts ${result.alertsEnabled ? 'enabled' : 'disabled'}.`);
    } catch (error) { report(error); }
    finally { setRequesting(false); }
  }
  return <main className="native-foundation">
    <aside>
      <h1>GitHub Projects</h1>
      <p>Native foundation</p>
      <p>Working on</p>
      <small>No action selected</small>
    </aside>
    <section>
      <h2>Your desktop workspace starts empty</h2>
      <p>{storage}</p>
      <p>The approved workspace interface and live integrations will connect in the integration build. This shell does not load the browser demo or contact GitHub.</p>
      <h3>Local reminders</h3>
      <p>{permission}</p>
      <button disabled={requesting} onClick={() => void enableReminders()}>{requesting ? 'Waiting for macOS...' : 'Enable reminders'}</button>
      <p>Closing this window keeps the app in the menu bar. Show returns here; Quit stops reminders.</p>
      <p>Sleep, Focus, and notification settings can prevent presentation. OS acceptance never proves delivery.</p>
      {clock && <p>Local timezone: {clock.timeZone ?? 'Unavailable'}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Foundation />);
