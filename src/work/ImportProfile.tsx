import { useRef, useState } from 'react';
import { Modal } from '../Modal.tsx';
import type { WorkQueue } from './controller.ts';
import { decodeProfileFile, MAX_PROFILE_FILE_BYTES, type ProfileFile } from './profile-files.ts';

export function ImportProfile({ queue, close, imported }: {
  queue: WorkQueue; close: () => void; imported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [profile, setProfile] = useState<ProfileFile>();
  const [name, setName] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  async function read(file: File | undefined) {
    const current = ++request.current;
    setProfile(undefined); setName(''); setError(''); setReading(!!file);
    if (!file) return;
    try {
      if (file.size > MAX_PROFILE_FILE_BYTES) throw new Error('Profile files must be 2 MiB or smaller.');
      const parsed = decodeProfileFile(await file.text());
      if (current !== request.current) return;
      setProfile(parsed); setName(parsed.name);
    } catch (error) {
      if (current === request.current) setError(error instanceof Error ? error.message : 'The file could not be read. Choose another profile file.');
    } finally {
      if (current === request.current) setReading(false);
    }
  }

  return <Modal title="Import work profile" close={close} initialFocus={input}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!profile || reading) return;
      try { queue.importProfile(profile, name); imported(); close(); }
      catch (error) { setError(error instanceof Error ? error.message : 'The work profile could not be imported.'); }
    }}>
      <label htmlFor="import-profile-file">Profile JSON file</label>
      <input id="import-profile-file" ref={input} type="file" accept=".json,application/json"
        aria-describedby="import-profile-help" onChange={event => void read(event.target.files?.[0])} />
      <p id="import-profile-help" className="field-help">Import settings into a new profile. Existing profiles, tasks and history stay unchanged.</p>
      {reading && <p role="status">Reading profile...</p>}
      {profile && <>
        <label htmlFor="import-profile-name">Profile name</label>
        <input id="import-profile-name" value={name} maxLength={80} required
          onChange={event => { setName(event.target.value); setError(''); }} />
        <p className="field-help">Includes agent instructions, models, work styles, sources and cadence. Automatic runs start off.</p>
        <p className="field-help">Review imported instructions and sources in Settings before running. Connections are not included.</p>
      </>}
      {error && <p className="task-error" role="alert">{error}</p>}
      <footer className="modal-footer"><button type="button" className="secondary" onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={!profile || reading || !name.trim()}>Import profile</button></footer>
    </form>
  </Modal>;
}
