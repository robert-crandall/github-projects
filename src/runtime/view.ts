import type { AppState, Command, Row } from '../types.ts';

export type Destination = { row: Row; kind: 'github' | 'copilot' | 'notification'; action?: 'done' | 'unsubscribe' };
export type WorkspaceView = {
  state: AppState; scroll: Record<string, number>;
  dispatch: (command: Command, message?: string) => boolean;
  storageError: string; operationError: string; feedback: string;
  clearFeedback: () => void; retryStorage: (replace?: boolean) => void;
  saveScroll: (view: string, offset: number) => void; exportBackup: (original?: boolean) => void;
  desktop?: {
    saving: boolean; refreshing: boolean; refresh: () => void;
    open: (destination: Destination) => void;
    triage: (kind: 'triage' | 'reconsider') => void;
    interpret: (row: Row) => void; routine: (row: Row) => void; connections: () => void;
  };
};
