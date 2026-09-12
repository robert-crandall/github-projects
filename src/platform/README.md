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

The workspace object is a domain-owned JSON envelope (`version: 1`, `state.version: 3`, scroll offsets). State contains threads, thread-owned notes and standalone tasks; no active action or routine scheduler remains. Integration validates it before save and after load, including backups. Native validation requires a positive integer workspace version, format version 1, a JSON object, at most 8 MiB and depth 64. Version-3 snapshots must contain no schedules. Legacy schedules remain parseable for recovery, with the original timestamp/timezone/identity bounds. SQLite validates schema version and integrity; a checksum detects damaged JSON.

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

Native clock ticks and their event subscription are retired with the scheduler. The initial read supplies the timezone and clock; subsequent local transitions take a current timestamp without a network request. The footer labels this as workspace time, not a continuously ticking clock.

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

The Rust host lazily starts only the fixed packaged `github-projects-service` executable beside the native executable. Tauri bundles/signs the matching arm64 or x64 binary. Its working directory is private app data, or a generated TEST directory during explicit smoke checks. No localhost service, caller-supplied executable, path, environment, model, or command is accepted.

Requests/replies are bounded to 1 MiB frames, four ordinary concurrent requests, a 150-second native timeout, and continuously drained bounded stderr. IDs correlate out-of-order replies; malformed or unknown responses stop the group. Quit, timeout, acknowledged active cancellation, and service-level cancelled/deadline results TERM then KILL the entire owned process group, including descendants. A no-op cancellation does not interrupt peers. Interrupted GitHub writes remain unconfirmed because they may have reached GitHub. The next request lazily starts a clean group.

Manual refresh maps stable raw evidence into the latest domain state, not the snapshot at request start. The domain retains omitted history but downgrades stale request eligibility, protects completed evidence, and orders subscription observations against write confirmation and refresh start. A later authoritative resubscription can supersede an older unsubscribe.

Writes require a numeric GitHub notification ID before creating or retrying an intent. Migrated capture placeholders retain source links, but not notification controls, until Refresh finds a notification. Promotion remaps notes, Tasks and existing operation references without replaying operations.

Write intents persist before dispatch; echoed context must match before confirmation persists. Each operation captures at most 200 pending events from the displayed row, separate from retained reader history. Later acknowledgements advance through remaining evidence; confirmation never handles events that arrived after its snapshot. Restart turns pending outcomes into uncertainty without replay. Capture and notes are strictly local; the workspace exposes no model interpretation or commitment-ranking controls. The existing restricted SDK service endpoints remain separate from this UI.
