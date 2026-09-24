import type { AppState, Command, Row } from '../types.ts';
import type { ReactNode } from 'react';
import type { Reference } from '../../service/src/schema.ts';

export type Destination = { row: Row; kind: 'github' | 'copilot' | 'notification'; action?: 'done' | 'unsubscribe'; retryId?: string };
export type WorkspaceView = {
  state: AppState; scroll: Record<string, number>;
  dispatch: (command: Command, message?: string) => boolean;
  storageError: string; operationError: string; feedback: string;
  clearFeedback: () => void; retryStorage: (replace?: boolean) => void;
  saveScroll: (view: string, offset: number) => void; exportBackup: (original?: boolean) => void;
  desktop?: {
    saving: boolean; refreshing: boolean; refresh: () => void;
    open: (destination: Destination) => void;
    archive: (row: Row) => void;
    connections: () => void;
    conversation: (reference: Reference) => ReactNode;
    readerReady: (reference: Reference) => boolean;
  };
};
