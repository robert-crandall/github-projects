# Native integration contract

`native.ts` is the renderer's only native interface. It exports `nativePlatform`, `isDesktop`, runtime schemas, DTO types, and `NativePlatformError`. `createNativePlatform(transport)` supplies an injectable test boundary; the default transport refuses browser execution.

`index.html` and `desktop.tsx` start the approved workspace through `DesktopWorkspace`, `ServiceWorkspace`, and `DesktopApp`. The shared `WorkspaceApp` never invokes the browser `useWorkspace` hook in this entry. Initial rendering waits for a validated SQLite read; it never seeds fixtures or a writable fallback on read failure.

`service.ts` validates operation-specific envelopes and results against the authoritative service schemas. It exposes only the restricted native JSONL host, not an HTTP client or SDK runtime. GitHub/SDK implementation code and credentials stay outside the renderer.

## Workspace transactions

```ts
type NativeSnapshot = {
  formatVersion: 1;
  workspace: { version: number; [key: string]: JsonValue };
  reminders: ReminderSchedule[];
};
type NativeWorkspace = {
  revision: string; // opaque UUID, including on an empty database
  snapshot: NativeSnapshot | null;
  savedAt: string | null; // RFC3339
};

nativePlatform.workspaceRead(): Promise<NativeWorkspace>;
nativePlatform.workspaceSave(expectedRevision: string, snapshot: NativeSnapshot): Promise<NativeWorkspace>;
```

The workspace object is a domain-owned JSON envelope. Integration validates it before save and after load, including loading backups. Native validation requires a positive integer workspace version, format version 1, a JSON object, at most 8 MiB, depth 64, at most 1,000 schedules, unique schedule IDs, valid timestamps and IANA timezones. SQLite validates its schema version and integrity; a checksum detects damaged snapshot JSON.

A save atomically commits the workspace and its projected reminder schedules. There is no separate schedule registration command and no raw SQL API. SQLite uses `synchronous=FULL`, macOS `fullfsync`, a rollback journal, and a cross-process exclusive lock. Local saves need no network. A second desktop process cannot write the same store.

Only a successful save response confirms persistence. `PersistenceQueue` retains pending state on errors, serializes saves, and adopts each returned revision in order. A newer pending generation prevents Saved feedback. `revision-conflict` means a stale writer must reload/reconcile, not retry with an invented revision. Recovery assigns a new UUID so old responses cannot become current again.

## Backups and explicit recovery

| Method | Result / effect |
| --- | --- |
| `storageStatus()` | `{recoveryToken, revision: string \| null, error}`; remains usable when SQLite is corrupt. |
| `createBackup(expectedRevision)` | A durable named backup `{id,createdAt}`; UUID ID, no caller path. |
| `listBackups()` / `readBackup(id)` | List backups / load a validated native envelope for domain validation before recovery. |
| `exportJson(expectedRevision)` | The saved native envelope as JSON for a renderer-managed user export. |
| `exportRaw()` | Preserves the current DB and journal files byte-for-byte under an isolated `exports/<uuid>/` directory; returns `{id,directory}`. |
| `recoverBackup(id, expectedRecoveryToken)` | Explicitly restores a validated local backup, preserves current raw files first, and returns a new workspace revision. |

Every save first makes a durable `latest` SQLite backup of the previous committed state; a backup failure blocks the save. Explicit UUID backups are retained without pruning. Raw exports remain local, are not sent anywhere, and need manual cleanup when no longer needed. SQLite schema versions newer/older than 1, malformed JSON, invalid checksums, and zero-byte databases are errors, never automatic reset/migration.

The recovery token rotates after save/recovery and is scoped to the native process. A successful raw export does not mean damaged content is valid. The renderer must distinguish saved JSON export from export of its own unsaved pending copy.

Recovery preserves newer reminder receipts so restoring an older backup does not replay prior notifications. When the current database is corrupt and delivery history cannot be trusted, SQLite retains a history-loss cutoff across saves, relaunches, and subsequent restores (including empty backups). Unknown delivery keys due at or before that cutoff are marked `uncertain`, requiring explicit retry. Genuinely future occurrences still dispatch normally. Original bytes remain in the raw export.

## Clock and reminder projection

```ts
type ReminderSchedule = {
  id: string;                 // stable action ID; one outstanding schedule per action
  occurrenceId: string;       // action ID + canonical ORIGINAL due instant
  dueAt: string;              // RFC3339 instant
  timeZone: string;           // preserved IANA timezone
  snoozedUntil?: string | null;
  daily?: { time: string; timeZone: string } | null; // HH:mm; matching zone
};
```

The domain owns calendar expansion, missed-day history, start/snooze/skip, checklist timestamps, and selection. Project `routine.dueAt` when an occurrence is outstanding, otherwise `routine.nextDueAt` so hidden webviews cannot prevent first delivery. Exclude reminders the domain has dismissed or completed. Include a new 30-minute `snoozedUntil` for a snooze without changing the original occurrence ID.

Native scheduling reads only persisted snapshots. It evaluates the later of `dueAt` and `snoozedUntil`, deduplicates the canonical instant plus action/occurrence IDs durably, and coalesces all missed time into that one outstanding occurrence. It never invents a daily backlog, modifies checklist steps, reorders rows, or selects work.

`clockNow()` returns `{now,timeZone,error}` using the actual clock and detected local zone. If zone detection fails, `timeZone` is null and the error is explicit; persisted schedule zones remain unchanged.

`listenNativeTicks(onTick,onError)` returns an unlisten function. `workspace://tick` events contain `{clock,reminders,error}` every approximately 15 seconds and after save, window show/focus, or permission/retry changes. The backend continues while hidden; an activity assertion prevents App Nap when schedules are registered but allows system sleep. The controller reconciles the first clock read and every tick without GitHub calls or selection changes. Clock-only changes do not save, preventing save-to-tick loops; durable routine reconciliation does save.

| Method | Purpose |
| --- | --- |
| `reminderStatus()` | Current revision, permission, receipts for current schedules, and a limitation message. |
| `requestReminderPermission()` | Explicit user-triggered authorization only. Never call on startup or during tests. |
| `retryReminder(deliveryKey, expectedRevision)` | Explicit retry for a failed/uncertain dispatch; rejects stale revisions and unrelated keys. |

Permission is `{state,alertsEnabled}` with `not-determined`, `denied`, `granted`, `provisional`, `unsupported`, or `unavailable`. The macOS implementation queries UserNotifications directly; the development executable reports `notification-unavailable` instead of impersonating another app. Provisional authorization can accept a quiet notification while alerts are disabled.

Receipts contain `{deliveryKey,scheduleId,occurrenceId,eligibleAt,status,attemptedAt,errorCode}`. Status is `blocked`, `requested`, `failed`, `uncertain`, or `retry`. A durable claim precedes macOS dispatch. A crash or callback timeout yields uncertainty, not automatic retry or false success. Explicit retry of uncertain dispatch can duplicate an alert; explain that in the UI.

Native notifications use fixed generic text, never private notes or action titles. They do not post to Slack, change flags, complete work, or open an action automatically. The UI supplies start/snooze/skip. Accepted notifications may be suppressed by foreground presentation rules, Focus, sleep, or system settings. Explicit Quit stops future native scheduling.

## Destinations and permissions

```ts
type GitHubIdentity = {
  source: 'github';
  owner: string;
  repo: string;
  kind: 'pr' | 'issue';
  number: number; // positive safe integer
};
nativePlatform.launchGitHub(identity);
nativePlatform.launchCopilot(identity);
```

Both methods return `{status:'dispatch-requested',url}`. They reject invalid owners/repositories, injected URL fragments, unsupported fields, and known `sample`/`fixture`/`synthetic` identities. The source discriminator is not proof of a network fetch; integration must never relabel fixtures as real GitHub data.

PR handoff is exactly `ghapp://session/new?repo=OWNER%2FREPO&pr=123&mode=interactive&prompt=Review%20this%20PR`. Issue handoff is `ghapp://github.com/OWNER/REPO/issues/123`. Browser URLs always use `https://github.com/.../pull/123` or `/issues/123`. Native code invokes only `/usr/bin/open` with the generated URL, never a shell or caller-supplied executable. Success says nothing about Copilot confirmation, session creation, review completion, or return.

Tauri capabilities grant the local `main` window only bounded app commands and event listen/unlisten. Navigation remains local; new windows are denied. Production CSP disallows network connections except Tauri IPC. No shell, HTTP, SQL, filesystem, notification, or opener plugin is exposed to the renderer.

Errors use `{code,message,retryable}` and become `NativePlatformError` in TypeScript. Unexpected transport output is replaced with a generic error, not forwarded as credential-bearing diagnostics. Known storage/OS failures never log SQL, workspace content, subprocess output, or secrets.

## Owned service and async reconciliation

The Rust host lazily starts only the fixed packaged `github-projects-service` executable beside the native executable. Tauri bundles/signs the matching arm64 or x64 binary. Its working directory is private app data, or a generated TEST directory during explicit smoke checks. No localhost service, caller-supplied executable, path, environment, model, or command is accepted.

Requests/replies are bounded to 1 MiB frames, four ordinary concurrent requests, a 150-second native timeout, and continuously drained bounded stderr. IDs correlate out-of-order replies; malformed or unknown responses stop the group. Quit, timeout, acknowledged active cancellation, and service-level cancelled/deadline results TERM then KILL the entire owned process group, including descendants. A no-op cancellation does not interrupt peers. Interrupted GitHub writes remain unconfirmed because they may have reached GitHub. The next request lazily starts a clean group.

Manual refresh maps stable raw evidence into the latest domain state, not the snapshot at request start. The domain retains omitted history but downgrades stale request eligibility, protects completed evidence, and orders subscription observations against write confirmation and refresh start. A later authoritative resubscription can supersede an older unsubscribe.

Write intents persist before dispatch; echoed context must match before confirmation persists. Restart turns pending outcomes into uncertainty without replay. Capture text persists before SDK interpretation. A generation registered before persistence prevents a closed preview from dispatching later. Preview fingerprints reject changed candidates, evidence, or target actions; bounded selected-scope orders compose into a full permutation only on explicit Apply.
