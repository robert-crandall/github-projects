export type ItemKind = 'review' | 'fix' | 'mention' | 'task' | 'routine';
export type ItemStatus = 'available' | 'deferred' | 'waiting' | 'completed' | 'removed';

export interface Source {
  id: string;
  kind: 'github' | 'capture' | 'routine';
  label: string;
  reference?: string;
}

export interface Step {
  id: string;
  title: string;
  doneAt?: string;
}

export interface Occurrence {
  id: string;
  dueAt: string;
  status: 'outstanding' | 'completed' | 'skipped' | 'missed';
  steps: Step[];
  reminderAt?: string;
  reminderDismissed?: boolean;
  snoozedUntil?: string;
  finishedAt?: string;
}

export interface Routine {
  time: string;
  timeZone?: string;
  nextDueAt: string;
  occurrences: Occurrence[];
}

export interface WorkItem {
  id: string;
  title: string;
  kind: ItemKind;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  notes: string;
  steps: Step[];
  nextStep: string;
  projectId?: string;
  availableAt?: string;
  reason?: string;
  completedAt?: string;
  startedAt?: string;
  review?: {
    identity?: string;
    request: 'direct' | 'team' | 'manual';
    lines?: number;
    files?: number;
    team?: string;
  };
  evidence?: string;
  signalCurrent?: boolean;
  sleep?: { since: string; wakeOnPing: boolean };
  wake?: { at: string; reason: 'mention' | 'review-request' | 'time' | 'manual' };
  routine?: Routine;
}

export interface Capture {
  id: string;
  original: string;
  createdAt: string;
  itemId: string;
  interpretation: 'pending' | 'task' | 'review' | 'routine' | 'unsupported' | 'error';
  explanation?: string;
  timeZone?: string;
  actionEdited?: boolean;
}

export interface Project {
  id: string;
  name: string;
  notes: string;
}

export interface UndoEntry {
  id: string;
  label: string;
  itemsBefore: WorkItem[];
  itemsAfter: WorkItem[];
  activeBefore?: string;
  activeAfter?: string;
}

export interface AppState {
  version: 1;
  runtime?: 'desktop';
  clock: string;
  items: WorkItem[];
  captures: Capture[];
  projects: Project[];
  activeId?: string;
  draft: string;
  undo: UndoEntry[];
  sync: { status: 'ok' | 'error' | 'disconnected'; lastSuccessAt: string; login?: string; error?: string; warnings?: string[] };
  aiRanking?: { orderedIds: string[]; reasons: { id: string; reason: string }[]; summary: string; generatedAt: string };
  interpretationError: boolean;
}

export type Scenario = 'before' | 'due' | 'arrival' | 'missed' | 'empty' | 'sync-error' | 'interpretation-error' | 'recover' | 'reset';

export type Command =
  | { type: 'draft'; text: string }
  | { type: 'capture'; id: string; text: string }
  | { type: 'interpret'; captureId: string }
  | { type: 'github-sync'; snapshot: GitHubSnapshot }
  | { type: 'sync-error'; error: string }
  | { type: 'ai-interpret'; captureId: string; proposal: CaptureProposal }
  | { type: 'interpret-error'; captureId: string; error: string }
  | { type: 'ai-rank'; proposal: RankingProposal }
  | { type: 'clear-ai-rank' }
  | { type: 'start'; id: string }
  | { type: 'pause' }
  | { type: 'complete'; id: string }
  | { type: 'defer'; id: string; reason: string; until?: string }
  | { type: 'sleep'; id: string; reason?: string; until?: string; wakeOnPing: boolean }
  | { type: 'wait'; id: string; reason: string }
  | { type: 'restore'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'edit'; id: string; title: string; nextStep: string; projectId?: string; routineTime?: string; routineTimeZone?: string; routineSteps?: string[] }
  | { type: 'notes'; id: string; text: string }
  | { type: 'step'; id: string; stepId: string; done: boolean }
  | { type: 'snooze'; id: string; minutes: number }
  | { type: 'skip'; id: string }
  | { type: 'dismiss-reminder'; id: string }
  | { type: 'project'; id: string; name: string; notes: string }
  | { type: 'advance'; to: string }
  | { type: 'scenario'; scenario: Scenario }
  | { type: 'undo' };
import type { CaptureProposal, GitHubSnapshot, RankingProposal } from '../desktop-contract.ts';
