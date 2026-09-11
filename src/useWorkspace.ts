import { useEffect, useRef, useState } from 'react';
import { getRow, initialState, transition } from './domain/engine.ts';
import type { Command } from './types.ts';
import { decodeWorkspace, downloadBackup, errorMessage, replaceWithBackup, saveWorkspace, STORAGE_KEY, withStorageEnabled, type SavedWorkspace } from './storage.ts';

function loadWorkspace() {
  const fallback: SavedWorkspace = {
    state: initialState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    scroll: {},
  };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    return { saved: raw ? decodeWorkspace(raw) : fallback, raw, error: '' };
  } catch (error) {
    return { saved: fallback, raw, error: errorMessage(error) };
  }
}

export function useWorkspace() {
  const [initial] = useState(loadWorkspace);
  const [saved, setSaved] = useState(initial.saved);
  const current = useRef(initial.saved);
  const expected = useRef(initial.raw);
  const blocked = useRef(!!initial.error);
  const [storageError, setStorageError] = useState(initial.error);
  const [operationError, setOperationError] = useState('');
  const [feedback, setFeedback] = useState('');

  function persist(next: SavedWorkspace): boolean {
    if (blocked.current) return false;
    try {
      expected.current = saveWorkspace(localStorage, next, expected.current);
      setStorageError('');
      return true;
    } catch (error) {
      setStorageError(errorMessage(error));
      return false;
    }
  }

  function dispatch(command: Command, message = ''): boolean {
    try {
      let nextState = transition(current.current.state, command);
      if ('key' in command && command.type !== 'select' && command.key === current.current.state.selectedKey) {
        const retained = getRow(nextState, command.key)?.action;
        if (retained) nextState = transition(nextState, { type: 'select', key: `a:${retained.id}` });
      }
      const next = { ...current.current, state: nextState };
      current.current = next;
      setSaved(next);
      setOperationError('');
      const stored = persist(next);
      if (message) setFeedback(stored ? message : `${message} Not saved yet.`);
      else if (command.type === 'refresh') setFeedback('');
      return true;
    } catch (error) {
      setOperationError(errorMessage(error));
      return false;
    }
  }

  function retryStorage(replace = false) {
    const next = { ...current.current, state: withStorageEnabled(current.current.state) };
    try {
      if (blocked.current && !replace) throw new Error('Back up the saved copy before replacing it with this workspace.');
      expected.current = replace
        ? replaceWithBackup(localStorage, next)
        : saveWorkspace(localStorage, next, expected.current);
      blocked.current = false;
      current.current = next;
      setSaved(next);
      setStorageError('');
      setFeedback(replace ? 'Previous copy backed up. This workspace is saved.' : 'Your pending changes are saved.');
    } catch (error) {
      setStorageError(errorMessage(error));
    }
  }

  function saveScroll(view: string, offset: number) {
    const next = { ...current.current, scroll: { ...current.current.scroll, [view]: offset } };
    current.current = next;
    persist(next);
  }

  function exportBackup(original = false) {
    try {
      downloadBackup(original && expected.current !== null ? expected.current : JSON.stringify(current.current, null, 2));
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  }

  useEffect(() => {
    if (initial.raw === null && !initial.error) persist(current.current);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue !== expected.current) {
        blocked.current = true;
        setStorageError('Another tab changed this workspace. Your pending work is retained here; export it or back up and replace the saved copy.');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 4500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  return {
    state: saved.state, scroll: current.current.scroll, dispatch, storageError, operationError,
    feedback, clearFeedback: () => setFeedback(''), retryStorage, saveScroll, exportBackup,
  };
}
