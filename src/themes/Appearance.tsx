import { useId, useSyncExternalStore } from 'react';
import { catalog, type Mode } from './controller.ts';
import { themes } from './browser.ts';

export function Appearance() {
  const id = useId();
  const { preferences, tone, pending, storageError } = useSyncExternalStore(themes.subscribe, themes.getSnapshot);
  const theme = catalog.find(theme => theme.name === preferences.name)!;
  return <section className="appearance" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Appearance</h2>
    <p>Choose a Copilot App theme. Changes apply immediately across the app.</p>
    <div className="appearance-fields">
      <label htmlFor={`${id}-theme`}>Theme
        <select id={`${id}-theme`} value={preferences.name} onChange={event => void themes.select({ ...preferences, name: event.target.value })}>
          {catalog.map(theme => <option key={theme.name} value={theme.name}>{theme.name}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-mode`}>Color mode
        <select id={`${id}-mode`} value={preferences.mode} onChange={event => void themes.select({ ...preferences, mode: event.target.value as Mode })}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
    </div>
    <p className="field-help" role="status">{pending ? 'Saving appearance...' : storageError ? 'Appearance not saved.' : 'Changes save automatically on this device.'}
      {preferences.mode === 'system' && ` System is using ${tone} mode.`}
      {(!theme.light || !theme.dark) && ` ${theme.name} only provides a ${tone} palette.`}
    </p>
  </section>;
}

export function AppearanceNotice() {
  const { storageError, appearanceError } = useSyncExternalStore(themes.subscribe, themes.getSnapshot);
  if (!storageError && !appearanceError) return null;
  return <div className="appearance-error" role="alert">
    {storageError && <p>{storageError}</p>}
    {appearanceError && <p>{appearanceError}</p>}
    <button className="secondary" onClick={() => void themes.retry()}>Retry appearance</button>
  </div>;
}
