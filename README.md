# GitHub Projects

A local-first macOS todo app. GitHub searches and notifications, Slack, manual capture and MCP intake feed **one ranked task list**. Each run uses the Copilot SDK to prioritize the whole list using your instructions.

The desktop keeps the native Mac shell, CLI authentication and revisioned SQLite storage. Existing tasks, completion and thread notes are retained.

**Sources and priorities → Appearance** offers all 57 themes from the Copilot App catalog, including GitHub and Fox, with Light, Dark and System modes. Changes apply immediately and persist across relaunch. GitHub dark remains the default. The reference workspace and browser prototype expose the same controls through **Appearance** in the sidebar.

Appearance stays separate from tasks and their backups. Desktop preferences use a local `appearance.json` file; the prototype uses browser storage. See [theme support](docs/theme.md) for palette sources and catalog updates.

## Work top to bottom

1. Open **Sources and priorities**. Configure GitHub queries and explicitly allowed MCP read tools. Paste priority instructions and roadmap context.
2. Choose **Run now**. The app collects requests, reconciles task identity and completion, and asks Copilot to order all actionable tasks with reasons.
3. Work down the list. **Done** is local; it does not submit a review, close an issue or acknowledge a notification.
4. Optionally enable a cadence. Runs continue while the app is running, including hidden in the menu bar. An overdue schedule catches up once after sleep or relaunch; quitting stops it.

Manual tasks save offline immediately and join the ranking on the next run. A failed model call preserves new discoveries and the previous order, with unranked tasks and the failure visible. Source failures never masquerade as successful empty results.

Each saved GitHub query collects up to **200 matches**, using pages of 100. Larger or incomplete searches show a coverage warning; missing matches never mark tasks Done. Reply extraction batches source comments, and ranking still considers the whole active queue together.

### Identity and Done

A GitHub task identifies **one issue or PR**, using its normalized URL, not its action, notification or search result. Assignment, follow-up, reply and review requests for the same source join one task, including requests discovered through Slack or MCP. All requests share one Done state. Non-GitHub sources still identify **source + action**; manually captured tasks remain separate.

Existing duplicates combine when the workspace loads, after a durable backup of the original snapshot. The first task keeps its ID and title; other titles, notes, evidence and handled evidence are retained. If any duplicate is unfinished, the combined task stays open. Otherwise it stays Done, retaining the latest completion boundary (or no automatic reopening if any completed task lacks a boundary).

Done records handled evidence and a completion boundary. A repeated search, an old newly discovered message, or an unrelated comment cannot reopen it. A fresh actionable request with a new source event after completion can. Current merge-queue, closed and merged state removes tasks from **To do** without marking them Done; they remain in **No action now**.

### GitHub notifications

In **Sources and priorities**, choose **Add GitHub notifications**, then **Save settings**. The source joins the same manual or scheduled run as saved searches. Use it instead of broad mentions searches; keep assigned-work, review-request and project backlog searches (such as Usersd) separately. Adding notifications does not rewrite or remove saved queries.

The first scan covers the last **30 days**. Later scans include both read and unread issue/PR notifications updated since the last successful run. Reading a notification elsewhere does not finish a task. Large backlogs advance oldest-first across runs, with the remaining history shown in the task list. The saved cursor advances only through successfully inspected history, never beyond the run's start, after collection, ranking and persistence succeed. Failures retain the previous boundary for retry.

Notifications identify conversations to inspect, not obligations. Actual source requests determine the action and retain their original event IDs and occurrence times. Notification reasons can remain `mention` after unrelated activity, so neither the reason nor the notification's update time can reopen Done. Requests already found through another source join the same issue or PR task.

**Unsubscribe on GitHub** appears in details for tasks discovered through notifications. Confirm it separately from Done. It stops following the conversation without closing the source, deleting the task or changing completion. Direct mentions, team mentions and review requests can still notify you again. The app saves the unsubscribe intent before sending it; unconfirmed writes stay visible for explicit retry and never replay automatically after relaunch.

### Slack and MCP

Slack uses a selected existing MCP server and explicitly named read tools. Connection credentials stay backend-only. Choose **Read MCP connections** for the available shared configuration and setup instructions. A connection saved only in Copilot app settings is not automatically available to this separate SDK runtime.

Other apps can submit tasks through the packaged service's `--mcp` stdio entry. For a completed Copilot review, submit a `review-result` task with the PR URL, a stable event ID and the source event time. The producer must call the tool; installing the server does not itself install an automatic review-completion hook. Intake is durable even while the desktop is closed, and is acknowledged only after the task reaches the workspace's durable save.

See the [service contract](service/README.md) for source configuration, intake arguments, bounds and authentication. The app does not embed Slack credentials or silently reuse unrelated tools.

### Saved reference material

**Sources and priorities → Open saved thread notes** opens the previous conversation workspace. Its notification controls, fixed Waiting on me digest and filtering rules remain available as reference tools, not the task discovery or ranking pipeline. The older browser prototype is also separate from the desktop task list.

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
open "src-tauri/target/release/bundle/macos/GitHub Projects.app"
```

The release profile preserves metadata in build-time dependencies to avoid Rust's `E0463` procedural-macro errors on macOS. No environment override is needed.

To build and install into `/Applications`, quit any running copy first:

```bash
bun run install_app
open "/Applications/GitHub Projects.app"
```

This replaces the installed app's bundle contents without touching local data. It requires write access to `/Applications`; it does not request administrator privileges.

The build compiles a target-specific standalone service and includes it inside the app. The app does not require Bun, Node, `node_modules`, or the repository at runtime. Apple Silicon and Intel service targets are supported; actual bundle/authentication validation ran on Apple Silicon.

The bundle is ad-hoc signed for local use, **not notarized for distribution**.

The app icon source is `src-tauri/icons/source.png`. Its PNG and ICNS variants are generated with Tauri's icon command.

### Connections and authentication

Local capture, thread notes, task notes and Done work without authentication.

For GitHub, install `gh` and sign in with `gh auth login --hostname github.com`. The backend discovers CLIs through absolute PATH entries and standard install directories, including `~/.local/bin`. It never exposes tokens to the renderer. Copilot App handoffs require Copilot App; checking the retained service's SDK connection additionally requires `copilot` and an account with access.

GitHub notifications require classic `notifications` or `repo` scope. Private source evidence needs `repo`; confirmed team membership needs `read:org` or its parent scopes. Organization access may also require SSO authorization. Unsupported authentication, absent CLIs, missing scopes, SDK failures, and partial source coverage are explicit errors, not demo fallbacks.

Use **Connections → Check connections** to check prerequisites. It does not fetch notifications. With scheduled runs disabled, startup, focus, navigation and reconnect do not call GitHub or the SDK. Enabled schedules explicitly opt into collection and ranking while the app is running.

### Reference workspace controls

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

Normal refresh loads up to 50 recent threads and bounded recent timeline history. Reaching those built-in limits is not an error: the refresh timestamp advances, and a neutral note beside **Refresh** identifies the limited notification batch. Saved source history retains its timeline coverage details. Actual failures keep a compact summary above the workspace; **Refresh details** lists each distinct warning once. Saved notes and tasks remain available; use **Refresh** to retry failed reads.

### Reference workspace: Waiting on me

Open **Waiting on me**, then choose **Generate digest** for a read-only checklist across GitHub, including sources outside your saved Inbox. Opening the panel, ordinary Refresh, startup, focus and reconnect never generate it. **Regenerate digest** is the only way to update the snapshot.

All six searches exclude archived repositories before applying their result limits. This does not exclude threads merely placed in this app's **Archive**; repository archival and local thread placement are separate.

The digest uses fixed rules, not Copilot, so there is no model call or model selector. It uses the account signed into `gh` on github.com, not a hardcoded personal login. Generating it never merges, reviews, comments, changes notifications, creates Tasks, or sends local notes to a model.

Items appear once, in the first matching group below. Oldest updates come first within each group.

| Group | Included items |
| --- | --- |
| Review requested of me | Non-draft PRs from `user-review-requested:@me`. Team requests do not count as direct requests. |
| Team review requested | Non-draft PRs requested of **integrations/terraform-provider-core-maintainers** only. No other team is queried. |
| My PR - ready to merge | Authored non-drafts with APPROVED reviews, MERGEABLE status, and passing checks or no checks. |
| My PR - needs my fix | Authored non-drafts with changes requested, conflicts, or failing CI. Every applicable cause is shown. |
| Mentioned - may owe a reply | PRs mentioning me, authored by someone else and updated within 3 days. This does not prove a reply is owed. |
| PR I reviewed - recent activity | PRs I reviewed, authored by someone else and updated within 2 days. This is a light re-review signal. |
| Assigned issue | Open issues assigned to me and updated within 30 days. |

An empty review decision is not a fix blocker; unknown mergeability is not a known conflict. Neither is enough to label a PR ready to merge. Draft authored PRs are skipped. Each search returns at most 50 results; the report names searches that reach the cap rather than claiming complete coverage. Any failed search or authored-PR enrichment stops the new digest and leaves the previous result visible with its timestamp.

Check items, then choose **Add checked items to Tasks** at the bottom. Each checked item becomes an open local Task with its source title, suggested action and GitHub URL in notes, including any fix causes or uncertainty. The batch preserves your unfinished capture and current reader. Checkmarks clear after adding, preventing a repeated click from adding the same selection twice. Saves use the normal local recovery controls; a failed save keeps the Tasks pending for **Retry storage**. **Open Tasks** takes you to them.

Checking alone never creates or completes Tasks or changes GitHub. Checkmarks survive closing the panel, but reset after a successful regeneration or app restart. Added Tasks persist independently and never complete themselves from GitHub activity. **Copy Markdown** copies the dated checklist with its current checkmarks; **Open on GitHub** opens the source without acting on it. The browser prototype offers **Generate sample** instead and adds sample Tasks only in its isolated local workspace.

### Reference workspace: filtering threads

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

Legacy routines and native reminder delivery are retired. The native reminder array remains empty; the new collection cadence lives separately in task settings. A legacy snapshot cannot notify while loading, after a failed migration, or after backup recovery. Closing hides the existing window; **Show GitHub Projects** returns it and **Quit GitHub Projects** stops the owned service process group.

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
  "src-tauri/target/release/bundle/macos/GitHub Projects.app"
```

The browser suite covers both the prototype and the actual desktop entry with mocked Tauri IPC. If Chromium is missing, run `bunx playwright install chromium`. Tests never perform live GitHub writes or request reminder permission.

The packaged executable provides non-prompting native smoke checks:

```bash
app="$PWD/src-tauri/target/release/bundle/macos/GitHub Projects.app/Contents/MacOS/github-projects-workspace"
"$app" --native-smoke-check
session=$(uuidgen)
"$app" --native-ui-smoke-check --integration-smoke-session "$session"
"$app" --native-ui-smoke-relaunch --integration-smoke-session "$session"
```

These use generated TEST directories, not app data. They check the ranked task home, persistent Done, and scheduled ranking while the window is hidden. They also cover SQLite, reference notes and cached conversations through native IPC, Archive plus acknowledgement, identical refresh, old history, new activity, filtering rules, queue entry/exit, cache-only discard, and a separate process relaunch retaining tasks and rules. An explicit smoke-only service fixture supplies responses; unexpected service/model operations fail instead of reaching GitHub. The relaunch command removes that test session; a standalone UI smoke without a session flag cleans up after itself. Smoke failures exit nonzero.

`--integration-service-smoke-check` explicitly performs a tiny synthetic SDK inference and a bounded read-only GitHub refresh through the packaged native host. It consumes Copilot service access and must not run as an automatic test. `--integration-read-smoke-check` performs only the read-only refresh. Both use private TEST directories and report counts/status, never source bodies or tokens.

## Architecture and limits

- [PRODUCT.md](PRODUCT.md) defines behavior; [DESIGN.md](DESIGN.md) and [theme.md](docs/theme.md) define the approved interface.
- [Native integration contract](src/platform/README.md) documents SQLite revisions, recovery, retired schedules, destinations, and owned process hosting.
- [Service contract](service/README.md) documents auth, exact endpoints, source coverage, SDK isolation, and bounded JSONL transport.

GitHub refresh is a bounded view of notifications and REST timeline evidence, not full repository synchronization. Missing notifications prove nothing. Archive retains a monotonic source timestamp; without a notification baseline, activity must be newer than the local archive time. A newly discovered same-timestamp ID alone cannot prove new activity. The independent conversation reader fetches REST message pages, not every historical revision, file diff, resolved-review status or repository content. The service is capability-restricted but not an operating-system sandbox. External Copilot App launching is separate from SDK previews.
