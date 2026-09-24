import type { Destination } from './view.ts';
import type { ConversationWorkspace } from './conversation-workspace.ts';
import type { Row } from '../types.ts';

export type RemoteStatus = { refreshing: boolean; checking: boolean; diagnostics: string[] };
export interface RemoteWorkspace {
  conversation: ConversationWorkspace;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteStatus;
  refresh(): Promise<void>;
  check(): Promise<void>;
  write(destination: Destination): Promise<void>;
  archive(row: Row): Promise<void>;
}
