# Native integration contract

`native.ts` is the renderer's only native interface. It exports `nativePlatform`, `isDesktop`, runtime schemas, DTO types, and `NativePlatformError`. `createNativePlatform(transport)` supplies an injectable test boundary; the default transport refuses browser execution.

`index.html` and `desktop.tsx` start the ranked task interface through `DesktopWorkspace`, `WorkQueue`, and `TaskApp`. `ServiceWorkspace` and `DesktopApp` remain reachable for saved thread notes. Neither entry invokes the browser `useWorkspace` hook. Initial rendering waits for a validated SQLite read; it never seeds fixtures or a writable fallback on read failure.

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

The workspace object is a domain-owned JSON envelope (`version: 1`, `state.version: 3`, scroll offsets). State contains threads, thread-owned notes, tasks and a defaulted `work` object holding sources, instructions, ranking and collection cadence. Optional task `work` metadata stores identity, provenance, handled evidence and availability. Existing tasks retain their IDs, notes and completion. Integration validates before save and after load, including backups. Native validation requires a positive integer workspace version, format version 1, a JSON object, at most 8 MiB and depth 64. Version-3 snapshots must contain no native reminder schedules. Legacy reminders remain parseable for recovery. SQLite validates schema version and integrity; a checksum detects damaged JSON.

Version 3 also holds bounded `rules` and `inboxes` arrays (default empty for existing snapshots), plus optional per-thread `sourceState` and `terminal` checkpoints. Rules use stable inbox IDs and strict literal criteria; validation rejects invalid or dangling references, duplicate/reserved names and unknown selected inboxes. No new database or body storage is added. Placement is derived from manual Archive, terminal state, then first enabled rule, without mutating notification/read state, notes, Tasks or operation intents.

A save atomically commits the workspace and an empty schedule array. There is no separate registration command or raw SQL API. SQLite uses `synchronous=FULL`, macOS `fullfsync`, a rollback journal, and a cross-process exclusive lock. Local saves need no network. A second desktop process cannot write the same store.

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

Version-2 conversion first creates a durable immutable backup at the current revision. A failed backup blocks conversion. The [migration mapping](../../PRODUCT.md#current-format-migration) preserves each annotation separately, keeps explicit captures as Tasks, and retains original progress/history. Subsequent saves cannot rotate away the immutable original. Restoring version 2 invokes the same conversion; loading version 3 never duplicates annotations.

Recovery still preserves historical reminder receipts and any history-loss cutoff for data integrity, but neither recovered schedules nor receipts can resume notification delivery. Original bytes remain in raw exports.

## Independent conversation cache

`conversationRead(reference)` reads saved messages only. `conversationMerge(page)` atomically merges a validated service page into the native cache. `conversationReset()` explicitly preserves and discards only the conversation cache; the reader asks for confirmation, and a subsequent load is a separate action. These commands cannot accept filesystem paths, endpoints, notification IDs or private workspace content.

The cache uses a separate checksummed SQLite file in the existing private app directory. Identity is lowercased repository + source type (`pr`/`issue`) + number, so notification placeholder promotion cannot detach messages. Messages merge by stable identity and update timestamp; failed pages retain cached bodies and explicit failure metadata. Page identity is stream + page number, with its own observation time.

Limits are 4 MiB per issue/PR source and 64 MiB total serialized UTF-8 content, at most 5,000 messages and 2,000 page records per source, and 1 MiB per incoming page. Limit failures preserve old cached content. Cache corruption cannot block reading/saving notes and Tasks; no automatic reset or eviction runs. Explicit discarded-cache recovery copies are retained separately and require manual cleanup.

Conversation bodies are excluded from workspace snapshots, revisions, backup rotation and note edits. `ConversationWorkspace` holds only the selected source in renderer memory. Selection/startup/focus/reconnect read no network. An explicit notification Refresh waits for selected cached conversation reads before publishing, keeps successful notification results if the reader fails, and ignores selected-reader results from an older navigation generation. Old history never enters notification evidence.

Markdown uses React Markdown and GFM without raw HTML execution. Image elements become inert text and optional explicit external links; rendering cannot fetch remote content. `launchWebUrl(url)` dispatches only validated HTTP(S) URLs through the fixed native opener; credentials, control characters and non-web protocols are rejected. The webview still denies external navigation/new windows.

## Clock and retired reminders

`clockNow()` returns `{now,timeZone,error}` from the actual clock and detected local zone. If detection fails, `timeZone` is null and the error is explicit.

The native process emits `work-tick` every 30 seconds, including while the window is hidden. `WorkQueue.tick` checks the persisted opt-in cadence and last run boundary. It starts at most one overdue run and never overlaps an active run. The frontend also checks once after loading saved state. With cadence disabled these checks do not contact sources or Copilot. The window has only listen/unlisten event capabilities, not permission to emit native events.

The native app no longer dispatches reminders, requests notification permission or exposes reminder retry controls. Delivery is disabled even before the frontend loads, after a failed migration save, and after restoring an older backup. The schedule array stays in the native envelope solely to read and preserve current-format legacy data safely.

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

Tauri capabilities grant the local `main` window only bounded app commands. Navigation remains local; new windows are denied. Production CSP disallows network connections except Tauri IPC. No shell, HTTP, SQL, filesystem, notification, or opener plugin is exposed to the renderer.

Errors use `{code,message,retryable}` and become `NativePlatformError` in TypeScript. Unexpected transport output is replaced with a generic error, not forwarded as credential-bearing diagnostics. Known storage/OS failures never log SQL, workspace content, subprocess output, or secrets.

## Owned service and async reconciliation

The Rust host lazily starts only the fixed packaged `github-projects-service` executable beside the native executable. Tauri bundles/signs the matching arm64 or x64 binary. Its working directory is private app data, or a generated TEST directory during explicit smoke checks. No localhost service or caller-supplied executable, path, environment or shell command is accepted. The work operations accept the saved query, selected model, allowed source connection and bounded task data through strict service schemas.

`work.collect`, `work.assess`, `work.rank`, `work.connections`, `work.intake` and `work.ackIntake` are explicit host operations. Collection applies evidence to the latest local state before assessment. Each nonempty assessment subset is validated, attached to its task/profile and flushed before requesting more or ordering. `work.rank` requires those saved result IDs and cannot reassess. Intake reads are nondestructive; the controller acknowledges producer events only after workspace persistence. A failed save prevents acknowledgement and further model work; pending history remains visible/exportable through the recovery queue. Optional `Task.assessments` versions persist in active and inactive profile snapshots, including Done, backup and export. No history is pruned to fit the existing 8 MiB limit. Task Done never uses a GitHub notification write.

Requests/replies are bounded to 1 MiB frames, four ordinary concurrent requests, a 150-second native timeout (330 seconds for `work.collect`, `work.assess` and `work.rank`), and continuously drained bounded stderr. The work timeout leaves cleanup time after the service's 300-second deadline. IDs correlate out-of-order replies; malformed or unknown responses stop the group. Quit, timeout, acknowledged active cancellation, and service-level cancelled/deadline results TERM then KILL the entire owned process group, including descendants. A no-op cancellation does not interrupt peers. Interrupted GitHub writes remain unconfirmed because they may have reached GitHub; work collection/assessment/ranking failures are read-only. The next request lazily starts a clean group.

Manual refresh maps stable raw evidence into the latest domain state, not the snapshot at request start. The domain retains omitted history but downgrades stale request eligibility, protects completed evidence, and orders subscription observations against write confirmation and refresh start. A later authoritative resubscription can supersede an older unsubscribe.

Writes require a numeric GitHub notification ID before creating or retrying an intent. Migrated capture placeholders retain source links and local Archive/Restore, but cannot create or send a notification write until Refresh finds a notification. Promotion remaps notes, Tasks and existing operation references without replaying operations.

Archive atomically saves local placement, its source boundary and a GitHub Done intent before dispatch. Offline/failed writes retain local Archive; local save failure prevents network dispatch. Restoring moves only local placement, including while acknowledgement is pending. Read state and subscription do not select a local location.

`thread.notificationUpdatedAt` is monotonic source notification time. `thread.archive` is either an explicit `null` (Inbox) or the archive time, captured notification timestamp and retained evidence horizon. Absence identifies a pre-archive snapshot and converts retained threads once; no version-2 backup or annotations are discarded. New source notification time can resurface even with identical timeline IDs. Newly discovered evidence alone must be newer than the archive time/horizon; cached conversation pages never enter this calculation.

Notification listing metadata and timeline enrichment have independent freshness. Genuinely new evidence invalidates a previous Done status even when its accompanying listing is stale, so it remains pending for the next acknowledgement. After local Restore clears Archive placement, the existing acknowledgement intent supplies that freshness boundary. Old history alone cannot reopen Done; stale hydration also preserves existing read/unread state.

Source state has its own observation time and source update time. `sourceThread` uses only the service's authoritative `sourceState`, never the last timeline event, for current queue membership. Reconciliation rejects older state observations/source versions independently from notification timestamp monotonicity. Activity newer than a state check fails open with a source-changed warning.

`thread.terminal` is a local checkpoint, not `thread.archive`. It retains the terminal reason and the existing archive-style activity boundary. Confirmed terminal refreshes advance that boundary without acknowledgement or handled IDs. On a confirmed open source, notification time or retained source evidence must exceed the greatest checkpoint time (observation, evidence and notification). Evidence learned during an unknown check still counts after recovery or relaunch; delayed listing catch-up and old-history hydration do not. This comparison is separate from manual Archive's handling of in-flight activity. Failed/omitted/unknown state temporarily stops suppression but retains checkpoint provenance. Explicit Restore of a nonterminal source clears its old local terminal hold; user rules still apply. Unknown state never clears manual Archive.

Rule editing uses the latest state during refresh and never calls `ServiceWorkspace.archive` or any write/model endpoint. The selected reader remains mounted when effective placement changes; named inboxes use stable per-inbox scroll keys. Preview consumes saved metadata only and is invalidated by changed criteria, rules, destinations or source placement.

Echoed write context must match before confirmation persists. Each operation captures at most 200 pending events and the displayed notification timestamp, separate from retained reader history. Later explicit acknowledgements advance through remaining evidence; confirmation never handles events that arrived after its snapshot or rearchives a restored/resurfaced thread. A pending operation prevents concurrent dispatch for the same notification, but local Archive remains usable: it saves a separate unconfirmed acknowledgement with a not-sent explanation and explicit retry, even when the pending write is unsubscribe.

Restart turns pending outcomes into uncertainty without replay. Earlier operations lacking a captured timestamp remain readable; acknowledgement requires a fresh explicitly confirmed context rather than inventing a boundary. The service preflight rejects clearly stale acknowledgement, but GitHub's GET/DELETE cannot be atomic. Capture and notes are strictly local; the workspace exposes no model interpretation or commitment-ranking controls. The existing restricted SDK service endpoints remain separate from this UI.
