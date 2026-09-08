import type { AppState, WorkItem } from './domain/types.ts';

export interface StoredWorkspace {
  revision: number;
  state: AppState | null;
}

export interface ToolStatus {
  path?: string;
  available: boolean;
  authenticated?: boolean;
  login?: string;
  error?: string;
}

export interface ConnectionStatus {
  github: ToolStatus;
  copilot: ToolStatus;
  databasePath: string;
}

export interface NotificationStatus {
  permission: 'granted' | 'denied' | 'prompt' | 'unavailable';
  error?: string;
}

export interface GitHubSnapshot {
  fetchedAt: string;
  login: string;
  items: WorkItem[];
  warnings: string[];
}

export interface CaptureProposal {
  kind: 'task' | 'review' | 'routine';
  title: string;
  nextStep: string;
  explanation: string;
  reviewUrl?: string;
  dailyTime?: string;
  steps?: string[];
}

export interface RankingProposal {
  orderedIds: string[];
  reasons: { id: string; reason: string }[];
  summary: string;
}

export interface RankingInput {
  clock: string;
  activeId?: string;
  items: Pick<WorkItem, 'id' | 'title' | 'kind' | 'nextStep' | 'evidence' | 'review' | 'updatedAt'>[];
}

// Rust owns persistence, credentials, external processes, and OS notifications.
// Names and camelCase arguments here are the renderer's entire IPC surface.
export interface DesktopCommands {
  workspace_load: { args: Record<string, never>; result: StoredWorkspace };
  workspace_save: { args: { state: AppState; expectedRevision: number }; result: number };
  workspace_export: { args: { state: AppState }; result: boolean };
  connection_status: { args: Record<string, never>; result: ConnectionStatus };
  configure_tools: { args: { ghPath: string; copilotPath: string }; result: ConnectionStatus };
  github_sync: { args: Record<string, never>; result: GitHubSnapshot };
  interpret_capture: { args: { text: string; clock: string; timeZone: string }; result: CaptureProposal };
  prioritize_work: { args: { input: RankingInput }; result: RankingProposal };
  open_github: { args: { url: string }; result: null };
  notification_status: { args: Record<string, never>; result: NotificationStatus };
  request_notification_permission: { args: Record<string, never>; result: NotificationStatus };
  notification_test: { args: Record<string, never>; result: null };
  cancel_copilot: { args: Record<string, never>; result: null };
}
