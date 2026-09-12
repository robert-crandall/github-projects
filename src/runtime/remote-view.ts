import type { Destination } from './view.ts';

export type RemoteStatus = { refreshing: boolean; checking: boolean; diagnostics: string[] };
export interface RemoteWorkspace {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteStatus;
  refresh(): Promise<void>;
  check(): Promise<void>;
  write(destination: Destination): Promise<void>;
}
