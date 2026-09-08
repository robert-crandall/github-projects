import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { applyCommand } from './domain/engine.ts';
import { createInitialState } from './domain/fixtures.ts';
import { createDesktopState } from './domain/live.ts';
import { rankedItems } from './domain/ranking.ts';
import type { AppState, Command } from './domain/types.ts';
import type { ConnectionStatus, RankingInput } from './desktop-contract.ts';
import { desktop, desktopCommand, errorText } from './desktop.ts';
import { isAppState, loadState, preserveBackup, saveState } from './storage.ts';
import { prepareWorkspaceImport } from './export.ts';

function readInitial() {
  if (desktop) return { state: createDesktopState(), error: '', blocked: false };
  try {
    const saved = loadState();
    const state = saved ?? createInitialState();
    if (!saved) saveState(state);
    return { state, error: '', blocked: false };
  } catch (error) {
    return { state: createInitialState(), error: storageMessage(error), blocked: true };
  }
}

function storageMessage(error: unknown) {
  return `Local storage failed. ${errorText(error)} Changes are not saved.`;
}

function rankingInput(state: AppState): RankingInput {
  return {
    clock: state.clock,
    activeId: state.activeId,
    items: rankedItems(state).slice(0, 40).map(({ id, title, kind, nextStep, evidence, review, updatedAt }) =>
      ({ id, title, kind, nextStep, evidence, review, updatedAt })),
  };
}

function rankingKey(state: AppState): string {
  // Notes, clock ticks, and focus changes do not spend another model request.
  return JSON.stringify(rankingInput(state).items.map(({ updatedAt: _updatedAt, ...item }) => item)
    .sort((a, b) => a.id.localeCompare(b.id)));
}

export function useWorkspace() {
  const [initial] = useState(readInitial);
  const [state, setState] = useState(initial.state);
  const latest = useRef(state);
  const durable = useRef(state);
  const revision = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const failed = useRef(!!initial.error);
  const loadingRef = useRef(desktop);
  const [loading, setLoading] = useState(desktop);
  const [storageError, setStorageError] = useState(initial.error);
  const [blocked, setBlocked] = useState(initial.blocked);
  const [actionError, setActionError] = useState('');
  const commandError = useRef('');
  const [feedback, setFeedback] = useState('');
  const [feedbackUndoId, setFeedbackUndoId] = useState<string>();
  const [savedTick, setSavedTick] = useState(0);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [connections, setConnections] = useState<ConnectionStatus>();
  const [connectionError, setConnectionError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const aiRanking = useRef(false);
  const aiQueue = useRef<Promise<void>>(Promise.resolve());
  const aiGeneration = useRef(0);
  const rankedKey = useRef('');
  const interpreting = useRef(new Set<string>());
  const [interpretCount, setInterpretCount] = useState(0);
  const [nativeError, setNativeError] = useState('');
  const restoredDraft = useRef<string | undefined>(undefined);

  const runAi = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const generation = aiGeneration.current;
    const result = aiQueue.current.then(() => {
      if (generation !== aiGeneration.current) throw new Error('Copilot request cancelled. Your capture is still saved.');
      return operation();
    });
    // A failed request must not poison the queue; its caller still receives the error.
    aiQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const persist = useCallback(async (next: AppState) => {
    if (desktop) {
      revision.current = await desktopCommand('workspace_save', { state: next, expectedRevision: revision.current });
    } else saveState(next);
    durable.current = next;
    setSavedTick(tick => tick + 1);
  }, []);

  const commit = useCallback(async (command: Command, message = ''): Promise<boolean> => {
    if (loadingRef.current || blocked) {
      setActionError('The workspace is not available yet. Retry storage before making changes.');
      return false;
    }
    if (failed.current) {
      setActionError('Save the pending changes with Retry storage before making another decision.');
      return false;
    }
    let next: AppState;
    try {
      const current = desktop && command.type !== 'advance'
        ? applyCommand(latest.current, { type: 'advance', to: new Date().toISOString() })
        : latest.current;
      next = applyCommand(current, command);
    } catch (error) {
      commandError.current = errorText(error);
      setActionError(commandError.current);
      return false;
    }
    const undoId = next.undo.at(-1)?.id;
    const newUndo = undoId !== latest.current.undo.at(-1)?.id && command.type !== 'undo';
    // Rendering is immediate; acknowledgement and AI wait for the durable write.
    latest.current = next;
    setState(next);
    setPendingSaves(count => count + 1);
    const saved = queue.current.then(async () => {
      if (failed.current) return false;
      try {
        await persist(next);
        setStorageError('');
        setActionError('');
        if (message) {
          setFeedback(message);
          setFeedbackUndoId(newUndo ? undoId : undefined);
        }
        return true;
      } catch (error) {
        failed.current = true;
        if (command.type === 'capture' && !latest.current.draft) {
          restoredDraft.current = command.text;
          latest.current = { ...latest.current, draft: command.text };
          setState(latest.current);
        }
        setStorageError(storageMessage(error));
        return false;
      }
    });
    queue.current = saved;
    try { return await saved; } finally { setPendingSaves(count => count - 1); }
  }, [blocked, persist]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    async function load() {
      try {
        const stored = await desktopCommand('workspace_load', {});
        if (cancelled) return;
        if (stored.state !== null && (!isAppState(stored.state) || stored.state.runtime !== 'desktop')) {
          throw new Error('The desktop workspace has an unsupported format. It has not been overwritten.');
        }
        revision.current = stored.revision;
        const next = applyCommand(stored.state ?? createDesktopState(), { type: 'advance', to: new Date().toISOString() });
        await persist(next);
        if (cancelled) return;
        latest.current = next;
        setState(next);
        failed.current = false;
        setStorageError('');
      } catch (error) {
        if (cancelled) return;
        failed.current = true;
        setBlocked(true);
        setStorageError(storageMessage(error));
      } finally {
        if (!cancelled) { loadingRef.current = false; setLoading(false); }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [persist]);

  const interpretCapture = useCallback(async (captureId: string) => {
    if (interpreting.current.has(captureId)) return false;
    const capture = durable.current.captures.find(entry => entry.id === captureId);
    if (!capture) { setAiError('Save the original capture before asking Copilot to interpret it.'); return false; }
    interpreting.current.add(captureId);
    setInterpretCount(interpreting.current.size);
    try {
      const proposal = await runAi(() => desktopCommand('interpret_capture', {
        text: capture.original, clock: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      const saved = await commit({ type: 'ai-interpret', captureId, proposal });
      if (saved) setAiError('');
      else if (!failed.current) {
        const error = commandError.current || 'Copilot returned a proposal that could not be applied.';
        setAiError(error);
        await commit({ type: 'interpret-error', captureId, error });
      }
      return saved;
    } catch (error) {
      const message = errorText(error);
      setAiError(message);
      await commit({ type: 'interpret-error', captureId, error: message });
      return false;
    } finally { interpreting.current.delete(captureId); setInterpretCount(interpreting.current.size); }
  }, [commit, runAi]);

  useEffect(() => {
    if (loading || blocked || storageError) return;
    for (const capture of durable.current.captures) {
      if (capture.interpretation !== 'pending') continue;
      if (desktop) void interpretCapture(capture.id);
      else void commit({ type: 'interpret', captureId: capture.id });
    }
  }, [savedTick, loading, blocked, storageError, commit, interpretCapture]);

  const checkConnections = useCallback(async () => {
    if (!desktop) return;
    try {
      setConnections(await desktopCommand('connection_status', {}));
      setConnectionError('');
    } catch (error) { setConnectionError(errorText(error)); }
  }, []);

  const syncGitHub = useCallback(async () => {
    if (!desktop || syncingRef.current || loadingRef.current || failed.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const snapshot = await desktopCommand('github_sync', {});
      if (!await commit({ type: 'github-sync', snapshot }) && !failed.current) {
        await commit({ type: 'sync-error', error: commandError.current || 'GitHub returned data that could not be applied. Previous work is retained.' });
      }
    } catch (error) {
      await commit({ type: 'sync-error', error: errorText(error) });
    } finally { syncingRef.current = false; setSyncing(false); }
  }, [commit]);

  const prioritize = useCallback(async (force = true) => {
    if (!desktop || aiRanking.current || interpreting.current.size || failed.current || loadingRef.current) return;
    await queue.current;
    const input = rankingInput(durable.current);
    const key = rankingKey(durable.current);
    if (input.items.length === 0 || (!force && key === rankedKey.current)) return;
    aiRanking.current = true;
    rankedKey.current = key;
    setAiBusy(true);
    try {
      const proposal = await runAi(() => desktopCommand('prioritize_work', { input }));
      if (rankingKey(latest.current) !== key) return;
      if (await commit({ type: 'ai-rank', proposal })) setAiError('');
      else if (!failed.current) setAiError(commandError.current || 'Copilot returned a ranking that could not be applied.');
    } catch (error) { setAiError(errorText(error)); }
    finally { aiRanking.current = false; setAiBusy(false); }
  }, [commit, runAi]);

  const currentRankingKey = rankingKey(state);
  useEffect(() => {
    if (!desktop || loading || blocked || storageError || aiBusy || interpretCount) return;
    const timer = window.setTimeout(() => void prioritize(false), 5000);
    return () => window.clearTimeout(timer);
  }, [currentRankingKey, loading, blocked, storageError, aiBusy, interpretCount, prioritize]);

  useEffect(() => {
    if (!desktop || loading || blocked) return;
    void checkConnections();
    void syncGitHub();
    const syncTimer = window.setInterval(() => void syncGitHub(), 5 * 60_000);
    const tick = () => {
      if (Date.now() - Date.parse(latest.current.clock) >= 15_000) {
        void commit({ type: 'advance', to: new Date().toISOString() });
      }
    };
    const resume = () => {
      tick();
      if (!latest.current.sync.login || Date.now() - Date.parse(latest.current.sync.lastSuccessAt) >= 5 * 60_000) {
        void syncGitHub();
      }
    };
    const clockTimer = window.setInterval(tick, 30_000);
    window.addEventListener('focus', resume);
    let disposed = false;
    const unlisten: (() => void)[] = [];
    async function subscribe() {
      try {
        for (const [event, handler] of [
          ['desktop-clock', () => tick()],
          ['desktop-error', (payload: unknown) => setNativeError(String(payload))],
        ] as const) {
          const stop = await listen(event, event => handler(event.payload));
          if (disposed) stop(); else unlisten.push(stop);
        }
      } catch (error) { setNativeError(`Desktop events unavailable: ${errorText(error)}`); }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten.forEach(stop => stop());
      clearInterval(syncTimer);
      clearInterval(clockTimer);
      window.removeEventListener('focus', resume);
    };
  }, [loading, blocked, commit, checkConnections, syncGitHub]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 5500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function retryStorage(reset = false) {
    loadingRef.current = true;
    await queue.current;
    try {
      if (desktop) {
        const stored = await desktopCommand('workspace_load', {});
        if (stored.revision !== revision.current && !blocked) {
          throw new Error('Storage changed in another process. Export your unsaved work before restarting; it was not overwritten.');
        }
        if (blocked) {
          if (stored.state !== null && (!isAppState(stored.state) || stored.state.runtime !== 'desktop')) {
            throw new Error('The saved desktop workspace is damaged. Restore a backup before retrying.');
          }
          revision.current = stored.revision;
          latest.current = stored.state ?? createDesktopState();
        }
      } else {
        if (reset) preserveBackup();
        latest.current = reset ? createInitialState() : blocked ? loadState() ?? latest.current : latest.current;
      }
      const next = restoredDraft.current && latest.current.draft === restoredDraft.current
        ? { ...latest.current, draft: '' } : latest.current;
      await persist(next);
      latest.current = next;
      restoredDraft.current = undefined;
      setState(latest.current);
      failed.current = false;
      setBlocked(false);
      setStorageError('');
      setActionError('');
      setFeedback(reset ? 'Original storage backed up. Fresh workspace saved.' : 'Local changes saved.');
    } catch (error) { setStorageError(storageMessage(error)); }
    finally { loadingRef.current = false; }
  }

  async function importWorkspace(text: string) {
    loadingRef.current = true;
    await queue.current;
    try {
      if (failed.current || blocked) throw new Error('Recover storage before importing a workspace.');
      const parsed: unknown = JSON.parse(text);
      if (!isAppState(parsed)) throw new Error('This file is not a supported GitHub Projects workspace.');
      const next = prepareWorkspaceImport(latest.current, parsed);
      await persist(next);
      latest.current = next;
      setState(next);
      setFeedback('Workspace imported. The original file is unchanged.');
      return true;
    } catch (error) { setActionError(errorText(error)); return false; }
    finally { loadingRef.current = false; }
  }

  async function cancelCopilot() {
    aiGeneration.current += 1;
    rankedKey.current = rankingKey(latest.current);
    try {
      await desktopCommand('cancel_copilot', {});
      setFeedback('Copilot request cancelled. Your captured work is retained.');
    } catch (error) { setAiError(errorText(error)); }
  }

  return {
    state, commit, feedback, feedbackUndoId, setFeedback, storageError, blocked, actionError, retryStorage,
    loading, pendingSaves, connections, connectionError, checkConnections, syncing, syncGitHub,
    aiBusy: aiBusy || interpretCount > 0, aiError, prioritize, interpretCapture, nativeError, setNativeError, importWorkspace, cancelCopilot,
  };
}
