import { invoke, isTauri } from '@tauri-apps/api/core';
import { z } from 'zod';
import { conversationCacheSchema, conversationPageSchema, referenceSchema, type ConversationPage, type Reference } from '../../service/src/schema.ts';

const instant = z.iso.datetime({ offset: true });
const revision = z.uuid();
const identifier = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const timeZone = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
});
export const nativeErrorSchema = z.object({
  code: z.string(), message: z.string(), retryable: z.boolean(),
});
export const reminderScheduleSchema = z.object({
  id: identifier,
  occurrenceId: identifier,
  dueAt: instant,
  timeZone,
  snoozedUntil: instant.nullish(),
  daily: z.object({
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timeZone,
  }).strict().nullish(),
}).strict().refine(value => !value.daily || value.daily.timeZone === value.timeZone);

export const snapshotSchema = z.object({
  formatVersion: z.literal(1),
  // Integration validates its domain schema before sending and after receiving this envelope.
  workspace: z.object({ version: z.number().int().positive() }).catchall(z.json()),
  reminders: z.array(reminderScheduleSchema).max(1000),
}).strict().refine(value => {
  const state = value.workspace.state;
  const current = state && typeof state === 'object' && !Array.isArray(state) && state.version === 3;
  return (!current || value.reminders.length === 0)
    && new Set(value.reminders.map(schedule => schedule.id)).size === value.reminders.length;
});
export const workspaceReadSchema = z.object({
  revision,
  snapshot: snapshotSchema.nullable(),
  savedAt: instant.nullable(),
}).strict();
export const clockSchema = z.object({
  now: instant,
  timeZone: timeZone.nullable(),
  error: nativeErrorSchema.nullable(),
}).strict();
export const githubIdentitySchema = z.object({
  source: z.literal('github'),
  owner: z.string().min(1).max(39).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
    .refine(value => !value.includes('--') && !['sample', 'fixture', 'synthetic'].includes(value.toLowerCase())),
  repo: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/).refine(value => !['.', '..'].includes(value)),
  kind: z.enum(['pr', 'issue']),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const launchResultSchema = z.object({ status: z.literal('dispatch-requested'), url: z.string() }).strict();
export const webUrlSchema = z.string().max(2_000).refine(value => {
  try {
    const url = new URL(value);
    return !/[\u0000-\u0020\u007f]/u.test(value) && ['https:', 'http:'].includes(url.protocol)
      && !url.username && !url.password;
  } catch { return false; }
});
const backupSchema = z.object({ id: z.string(), createdAt: instant }).strict();
const backupId = z.union([z.literal('latest'), z.uuid()]);

export type NativeSnapshot = z.infer<typeof snapshotSchema>;
export type NativeWorkspace = z.infer<typeof workspaceReadSchema>;
export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>;
export type NativeClock = z.infer<typeof clockSchema>;
export type GitHubIdentity = z.infer<typeof githubIdentitySchema>;
export type NativeFailure = z.infer<typeof nativeErrorSchema>;
export type NativeCommand =
  | 'workspace_read' | 'workspace_save' | 'workspace_storage_status'
  | 'workspace_create_backup' | 'workspace_list_backups' | 'workspace_read_backup'
  | 'workspace_export_json' | 'workspace_export_raw' | 'workspace_recover'
  | 'launch_github' | 'launch_copilot' | 'launch_web_url' | 'clock_now'
  | 'conversation_read' | 'conversation_merge' | 'conversation_reset';
export type NativeTransport = (command: NativeCommand, args?: Record<string, unknown>) => Promise<unknown>;

export class NativePlatformError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(failure: NativeFailure) {
    super(failure.message);
    this.name = 'NativePlatformError';
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

type Validator<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
function parse<T>(schema: Validator<T>, value: unknown, code = 'invalid-input'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NativePlatformError({
      code, retryable: false,
      message: code === 'invalid-input'
        ? 'The native request has an invalid or unsupported format.'
        : 'The native response has an unsupported format. No successful operation was confirmed.',
    });
  }
  return result.data;
}

const desktopTransport: NativeTransport = (command, args) => {
  if (!isTauri()) {
    return Promise.reject(new NativePlatformError({
      code: 'desktop-required', retryable: false,
      message: 'This operation requires the native desktop app. The browser demo cannot perform it.',
    }));
  }
  return invoke(command, args);
};

export function createNativePlatform(transport: NativeTransport = desktopTransport) {
  async function call<T>(command: NativeCommand, schema: Validator<T>, args?: Record<string, unknown>): Promise<T> {
    let response: unknown;
    try { response = await transport(command, args); }
    catch (error) {
      if (error instanceof NativePlatformError) throw error;
      const native = nativeErrorSchema.safeParse(error);
      throw new NativePlatformError(native.success ? native.data : {
        code: 'native-unavailable', retryable: true,
        message: 'The native operation failed without a recognized response. Your changes have not been confirmed.',
      });
    }
    return parse(schema, response, 'invalid-response');
  }
  return {
    workspaceRead: () => call('workspace_read', workspaceReadSchema),
    conversationRead: (reference: Reference) => call('conversation_read', conversationCacheSchema.nullable(), { reference: parse(referenceSchema, reference) }),
    conversationMerge: (page: ConversationPage) => {
      const valid = parse(conversationPageSchema, page);
      if (new TextEncoder().encode(JSON.stringify(valid)).length > 1_048_576) {
        throw new NativePlatformError({ code: 'conversation-limit', message: 'This conversation page exceeds the 1 MiB transport limit. No content was discarded.', retryable: false });
      }
      return call('conversation_merge', conversationCacheSchema, { page: valid });
    },
    conversationReset: () => call('conversation_reset', z.null()),
    workspaceSave: (expectedRevision: string, snapshot: NativeSnapshot) => {
      const valid = parse(snapshotSchema, snapshot);
      if (new TextEncoder().encode(JSON.stringify(valid)).length > 8 * 1024 * 1024) {
        throw new NativePlatformError({ code: 'snapshot-too-large', message: 'The workspace exceeds the 8 MiB native storage limit.', retryable: false });
      }
      return call('workspace_save', workspaceReadSchema, { expectedRevision: parse(revision, expectedRevision), snapshot: valid });
    },
    storageStatus: () => call('workspace_storage_status', z.object({
      recoveryToken: revision, revision: revision.nullable(), error: nativeErrorSchema.nullable(),
    }).strict()),
    createBackup: (expectedRevision: string) => call('workspace_create_backup', backupSchema, { expectedRevision: parse(revision, expectedRevision) }),
    listBackups: () => call('workspace_list_backups', z.array(backupSchema)),
    readBackup: (id: string) => call('workspace_read_backup', workspaceReadSchema, { backupId: parse(backupId, id) }),
    exportJson: (expectedRevision: string) => call('workspace_export_json', z.string(), { expectedRevision: parse(revision, expectedRevision) }),
    exportRaw: () => call('workspace_export_raw', z.object({ id: revision, directory: z.string() }).strict()),
    recoverBackup: (id: string, expectedRecoveryToken: string) => call('workspace_recover', workspaceReadSchema, {
      backupId: parse(backupId, id), expectedRecoveryToken: parse(revision, expectedRecoveryToken),
    }),
    launchGitHub: (identity: GitHubIdentity) => call('launch_github', launchResultSchema, { identity: parse(githubIdentitySchema, identity) }),
    launchCopilot: (identity: GitHubIdentity) => call('launch_copilot', launchResultSchema, { identity: parse(githubIdentitySchema, identity) }),
    launchWebUrl: (url: string) => call('launch_web_url', launchResultSchema, { url: parse(webUrlSchema, url) }),
    clockNow: () => call('clock_now', clockSchema),
  };
}

export const nativePlatform = createNativePlatform();
export const isDesktop = isTauri;
