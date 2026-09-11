import type { Row } from '../types.ts';
import type { CaptureProposal } from '../domain/live.ts';
import type { Destination } from './view.ts';

export type OrderPreview = {
  fingerprint: string; keys: string[]; order: string[]; scope: string;
  suggestions: { key: string; summary: string; uncertainty: string; nextStep: string; evidence: string[] }[];
};
export type CapturePreview = { key: string; fingerprint: string; proposal: CaptureProposal };
export type RemoteStatus = { refreshing: boolean; checking: boolean; diagnostics: string[] };
export interface RemoteWorkspace {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteStatus;
  refresh(): Promise<void>;
  check(): Promise<void>;
  triage(mode: 'triage' | 'reconsider'): Promise<OrderPreview>;
  interpret(row: Row): Promise<CapturePreview>;
  write(destination: Destination): Promise<void>;
  cancelPreview(): Promise<void>;
}
