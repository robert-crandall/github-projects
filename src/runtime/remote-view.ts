import type { Destination } from './view.ts';
import type { ConversationWorkspace } from './conversation-workspace.ts';
import type { Row } from '../types.ts';
import type { WaitingDigest } from '../../service/src/schema.ts';

export type WaitingStatus = { running: boolean; error: string; result?: WaitingDigest };
export type RemoteStatus = { refreshing: boolean; checking: boolean; diagnostics: string[]; waiting: WaitingStatus };
export interface RemoteWorkspace {
  conversation: ConversationWorkspace;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteStatus;
  refresh(): Promise<void>;
  generateWaiting(): Promise<void>;
  check(): Promise<void>;
  write(destination: Destination): Promise<void>;
  archive(row: Row): Promise<void>;
}
