# GitHub Projects

A local-first macOS GitHub notification client with separate **Inbox** and **Tasks**. Read threads and keep private thread notes; capture standalone tasks without a network round trip. GitHub activity arrives only when you click **Refresh**.

The desktop keeps the GitHub-dark three-pane interface, real GitHub evidence, CLI authentication and SQLite. The separate browser prototype remains runnable with synthetic data.

## Run the desktop

Build prerequisites: macOS 12 or later, Xcode Command Line Tools, a Rust toolchain, and [Bun 1.3.14](https://bun.sh/). Install both locked dependency sets:

```bash
bun install --frozen-lockfile
(cd service && bun install --frozen-lockfile)
bun run native:dev
```

Development uses `127.0.0.1:1420`. `bun run dev:desktop` alone is only the renderer; it cannot read SQLite without Tauri.

For the standalone app:

```bash
bun run native:build
open "src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app"
```

To build and install into `/Applications`, quit any running copy first:

```bash
bun run native:install
open "/Applications/GitHub Projects Workspace.app"
```

This replaces the installed app's bundle contents without touching local data. It requires write access to `/Applications`; it does not request administrator privileges.

The build compiles a target-specific standalone service and includes it inside the app. The app does not require Bun, Node, `node_modules`, or the repository at runtime. Apple Silicon and Intel service targets are supported; actual bundle/authentication validation ran on Apple Silicon.

The bundle is ad-hoc signed for local use, **not notarized for distribution**.

### Connections and authentication

Local capture, thread notes, task notes and Done work without authentication.

For GitHub, install `gh` and sign in with `gh auth login --hostname github.com`. The backend discovers CLIs through absolute PATH entries and standard install directories, including `~/.local/bin`. It never exposes tokens to the renderer. Copilot App handoffs require Copilot App; checking the retained service's SDK connection additionally requires `copilot` and an account with access.

GitHub notifications require classic `notifications` or `repo` scope. Private source evidence needs `repo`; confirmed team membership needs `read:org` or its parent scopes. Organization access may also require SSO authorization. Unsupported authentication, absent CLIs, missing scopes, SDK failures, and partial source coverage are explicit errors, not demo fallbacks.

Use **Connections → Check connections** to check prerequisites. It does not fetch notifications. Startup, focus, clock ticks, navigation, and reconnect do not call GitHub or the SDK.

### Daily use

1. Select a thread in **Inbox** to read its cached conversation and edit private notes. **Load conversation** explicitly fetches an uncached source. Selection never contacts GitHub or creates a task.
2. **Capture** (Command/Ctrl+K) saves exact text directly into **Tasks**. Links and daily phrasing remain ordinary text.
3. Edit task text or notes and check **Done**. GitHub activity never reopens completed tasks.
4. **Refresh** loads a bounded batch while preserving current notes, selection, row order and task completion.
5. **Archive thread** clears Inbox immediately and marks the notification done on GitHub after saving its intent. **Archive** keeps notes/history reachable. **Restore to Inbox** is local-only; **Unsubscribe on GitHub** remains a separate confirmed action.

Archive works offline: the local move stays saved while an unconfirmed GitHub write remains visible for explicit retry. A failed local save prevents dispatch. No write replays on reconnect or relaunch. Source placeholders without a notification ID archive only here, with an explicit explanation. New source notification activity returns the same thread with its notes; stale responses, read/unread changes, sticky reasons and older history do not.

Archive never closes a source or completes a Task. Unsubscribe does not archive locally; mentions and review requests can still notify. Restore cannot undo GitHub Done or unsubscribe. More than 200 pending evidence IDs require an explicit **Acknowledge remaining evidence** batch. Retries keep their original evidence and source timestamp; older intents without a timestamp require Refresh and confirmation of current evidence instead.

GitHub marks a whole notification done, not individual messages. The app refuses a clearly stale acknowledgement before writing, but GitHub cannot atomically check and delete: activity arriving between those requests may also be marked done there. Newer evidence already received locally always survives.

**Open on GitHub** and **Review in Copilot** / **Open in Copilot** remain visible on threads. Dispatch is not proof that a session exists or a review finished. Private notes never enter those links or external writes.

The reader shows real issue/PR descriptions, comments, reviews and grouped inline replies, with author, source time and source links. Markdown renders without executing HTML or automatically fetching images/embeds. Long bodies are not clipped. **Pages, freshness and older history** exposes page timestamps, partial errors, **Load older** and explicit page reloads for older edits. Each missing range has an explicit action that loads one page, including gaps left when newest messages jump ahead. Comments, reviews and inline discussions track their pages independently; failed or partial pages retain a reload action.

Refresh publishes notifications and the selected loaded conversation together. It updates the description and newest message pages, not every historical page. Cached older bodies may be stale; deleted messages can remain cached. Loading history never changes pending notification evidence or returns archived/terminal threads to Inbox.

### Filtering threads

Open **Filtering rules** to create named inboxes and saved rules. Match exact repository, PR/issue type, and/or literal title text; supplied criteria combine with AND, with case-insensitive repository/title matching. Preview matches before saving. The first enabled rule wins; use up/down to change order. Preview also explains when manual Archive or terminal state takes precedence.

Route matches to a named inbox or choose **Keep out of Inbox**, which leaves them reachable in **Filtered** with notes/history. Disable/delete rules to remove their effect. Inbox renaming preserves its identity; deletion is blocked until all referencing rules are edited or deleted. Built-in/duplicate/blank names and invalid criteria produce errors. Limits are 50 named inboxes and 100 rules.

Confirmed closed/merged sources and PRs currently in GitHub's merge queue stay in Filtered even when comments arrive. Queue membership uses GitHub's current GraphQL field, not an old queue event. Once open/out of queue, new activity resumes ordinary routing; old history does not. Missing/denied state checks fail open with a visible warning and retain their prior boundary for later reconciliation. The reader labels every saved observation with its check time; nothing polls.

**Filtering is local only.** It never invokes manual Archive's GitHub Done operation, unsubscribes or completes Tasks. Manual Archive stays in Archive through rule edits. Restore clears Archive locally; current filters still apply. Rules, inboxes and terminal checkpoints survive relaunch through the existing SQLite save.

## Local storage and recovery

The desktop starts empty after reading SQLite. It never opens browser storage, fixtures, or the previous app's database. Its identifier and data namespace are `io.robertcrandall.github-projects-workspace`:

```text
~/Library/Application Support/io.robertcrandall.github-projects-workspace/
```

SQLite saves the checksummed, revisioned workspace atomically. **Saved on this Mac** appears only after the newest queued changes persist. Conflicts and failed saves retain pending work rather than overwriting another revision. **Backups & recovery** provides pending-copy export, preservation of database files, and explicitly confirmed backup recovery. Recovery never silently resets corrupt data.

Current version-2 data converts to version 3 after a durable immutable backup succeeds. Linked action notes become separate thread annotations with original titles/history. Explicit captured tasks stay Tasks even when linked; **Open thread notes** leads back to the moved annotation. Their new task notes start empty. Standalone actions/routines become Tasks with preserved notes and history. Completed/removed tasks stay Done. No unrelated older application storage is inspected.

The migration retains capture text, progress, step timestamps, project/next-step text and routine history. The original backup also preserves the retired undo stack. Loading version 3 does not repeat the conversion. Existing retained threads move into Archive once; later local Restore remains effective across relaunch.

Unconfirmed GitHub writes remain visible and explicitly retryable after relaunch. They never replay automatically. A timeout or interrupted process may follow a successful remote write; check GitHub or retry explicitly rather than treating it as success.

Conversation bodies live in a separate checksummed SQLite cache in the same private app directory, outside workspace snapshots and their 8 MiB limit. A source means one repository + issue/PR type + number, independent of notification IDs. Limits are **4 MiB per source** and **64 MiB total**, measured as serialized UTF-8 data; each service page holds at most five messages within 1 MiB. Untransportable pages and full/corrupt caches produce explicit errors, never shortened bodies, silent eviction or lost notes.

**Discard conversation cache** requires confirmation and clears only cached source data. The native app preserves the discarded cache file locally; those recovery copies need manual cleanup. Notes, Tasks, pending notification evidence and workspace backups are unchanged. Navigation during discard remains usable afterward; pending reads cannot restore discarded content. Loading again requires a separate explicit action. Offline startup/navigation reads the remaining cache without contacting GitHub.

Routines and native reminder delivery are retired. New saves contain no schedules, and a legacy snapshot cannot notify while loading, after a failed migration, or after backup recovery. Closing still hides the existing window; **Show GitHub Projects** returns it and **Quit GitHub Projects** stops the owned service process group.

## Run the isolated browser prototype

```bash
bun run dev
```

Open `http://127.0.0.1:5173`. This entry uses the existing isolated browser storage key, synthetic source events, simulated GitHub/Copilot destinations, and a demo clock. It never calls the native backend. **Demo scenarios** includes comments, merge queue, re-requests, acknowledgement and simulated failures. Browser migration preserves a separate original before replacement.

## Validation

```bash
bun run test
bun run test:browser
bun run build
bun run build:desktop
bun run build:service
bun run test:native
(cd service && bun run typecheck && bun run build arm64 && bun test)
bun run native:build
codesign --verify --deep --strict \
  "src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app"
```

The browser suite covers both the prototype and the actual desktop entry with mocked Tauri IPC. If Chromium is missing, run `bunx playwright install chromium`. Tests never perform live GitHub writes or request reminder permission.

The packaged executable provides non-prompting native smoke checks:

```bash
app="$PWD/src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app/Contents/MacOS/github-projects-workspace"
"$app" --native-smoke-check
session=$(uuidgen)
"$app" --native-ui-smoke-check --integration-smoke-session "$session"
"$app" --native-ui-smoke-relaunch --integration-smoke-session "$session"
```

These use generated TEST directories, not app data. They check SQLite, renderer capture/notes/Done, full cached conversation rendering through real native IPC, Archive plus acknowledgement, identical refresh, loading old pages, new activity returning the same thread, rule preview and named routing, queue entry/exit without additional writes, cache-only discard, hiding/showing and a separate process relaunch retaining the rule/inbox. An explicit smoke-only native service fixture supplies source responses; unexpected service/model operations fail instead of reaching GitHub. The relaunch command removes that test session; a standalone UI smoke without a session flag cleans up after itself. Smoke failures exit nonzero.

`--integration-service-smoke-check` explicitly performs a tiny synthetic SDK inference and a bounded read-only GitHub refresh through the packaged native host. It consumes Copilot service access and must not run as an automatic test. `--integration-read-smoke-check` performs only the read-only refresh. Both use private TEST directories and report counts/status, never source bodies or tokens.

## Architecture and limits

- [PRODUCT.md](PRODUCT.md) defines behavior; [DESIGN.md](DESIGN.md) and [theme.md](docs/theme.md) define the approved interface.
- [Native integration contract](src/platform/README.md) documents SQLite revisions, recovery, retired schedules, destinations, and owned process hosting.
- [Service contract](service/README.md) documents auth, exact endpoints, source coverage, SDK isolation, and bounded JSONL transport.

GitHub refresh is a bounded view of notifications and REST timeline evidence, not full repository synchronization. Missing notifications prove nothing. Archive retains a monotonic source timestamp; without a notification baseline, activity must be newer than the local archive time. A newly discovered same-timestamp ID alone cannot prove new activity. The independent conversation reader fetches REST message pages, not every historical revision, file diff, resolved-review status or repository content. The service is capability-restricted but not an operating-system sandbox. External Copilot App launching is separate from SDK previews.
