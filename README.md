# GitHub Projects

A local-first macOS todo app. GitHub searches and notifications, Slack, manual capture and MCP intake feed **a ranked task list for each work profile**. Copilot assesses changed tasks and prioritizes the selected profile's list using its instructions; unchanged runs reuse saved assessments and ordering.

The desktop keeps the native Mac shell, CLI authentication and revisioned SQLite storage. Existing tasks, completion and thread notes are retained.

**Settings → Appearance** offers all 57 themes from the Copilot App catalog, including GitHub and Fox, with Light, Dark and System modes. Changes apply immediately and persist across relaunch. GitHub dark remains the default.

Appearance stays separate from tasks and their backups. Desktop preferences use a local `appearance.json` file. See [theme support](docs/theme.md) for palette sources and catalog updates.

## Work top to bottom

1. Open **Settings**. Configure sources and the **Task assessor** and **Task prioritizer**, each with its own name, instructions and model.
2. Choose **Run now**. The app collects requests, reconciles task identity and completion, and asks Copilot to order all actionable tasks with reasons.
3. Work down the list. **Done** is local; it does not submit a review, close an issue or acknowledge a notification.
4. Optionally enable a cadence. Runs continue while the app is running, including hidden in the menu bar. An overdue schedule catches up once after sleep or relaunch; quitting stops it.

Manual tasks save offline immediately and join the ranking on the next run. A failed model call preserves new discoveries and the previous order, with unranked tasks visible. **Coverage and run details** holds source warnings and run failures without a duplicate error banner above the task list. Storage and local action failures stay visible separately. Source failures never masquerade as successful empty results.

**Run assessor** saves new judgments for all eligible active tasks without collecting sources or rearranging the list. **Run prioritizer** recomputes the whole eligible list from current saved assessments, regardless of source filters. It never silently reassesses: missing, outdated or expired assessments produce an assess-first message and keep the previous order. Neither separate action advances collection coverage or changes the schedule. **Run now** and the opted-in schedule keep the collect → assess → prioritize pipeline and reuse current results.

While a run is active, the summary beside **Run now** shows collections processed, done, failed and remaining, plus the active source and elapsed time. One collection is one enabled source, including its follow-up reads and saves; failed collections count as processed, not successful. These counts are not time estimates. Intake, ranking and saving have separate phase labels, and 100% collected does not mean the run has finished. Expand **Coverage and run details** for a scrollable source checklist and diagnostics, without duplicating source warnings. Sources skipped after a storage failure are labeled **Not run**. Local task edits stay available. The completed checklist remains for the current session until the next run or profile switch; saved run errors and the last successful run time remain available after relaunch.

### Filters

Choose **Filters** in the left menu to keep a source tree beside your tasks. Toggle an entire GitHub, Slack or MCP group, or individual configured sources. Manual tasks and external-agent intake have separate checkboxes. Tasks matching any checked source appear once, in the same order and with the same ranks as **Ranked Tasks**. Filtering applies to To do, Done and No action now; source counts follow the current tab and can overlap.

Selections and collapsed groups save automatically per work profile, including across relaunch and in backups. New profiles start with all sources selected. **Select all** / **Show all sources** also includes sources added later; a custom selection includes only the sources you checked. Selecting nothing shows an empty view, never deletes tasks. Disabled sources remain available for filtering saved tasks; removed sources use their saved source ID as a label. Tasks without saved provenance appear under **Other saved tasks**.
**Ranked Tasks** always shows the full list. Filters do not change source collection, schedules, ranking, Done or notes.
**Ranked Tasks** always shows the full list. Filters do not change source collection, schedules, ranking, Done or notes.

### Work profiles

Use **Work profile** above the task list to switch between named setups, such as regular work and on-call work. Your existing setup becomes **Default**, without changing its tasks or settings. **Add profile** creates and selects an empty task list, then opens its settings. Optionally copy the current profile's saved instructions, sources and model; automatic runs start off. Rename the selected profile in **Settings**.

Each profile keeps its own agents, sources, collection model, schedule, tasks, notes, Done history, ranking and notification cursor. Older settings initialize both agents with the saved owner instructions and model; sources and scheduling stay unchanged. Agent edits thereafter are independent. Display-name changes retain the stable agent identity and do not invalidate judgments. The same source can appear independently in different profiles; completing it in one does not complete it in another. Switching waits until a run or unsubscribe finishes.

External-agent intake goes into whichever profile runs next, and is acknowledged only after saving. Saved thread notes, connections, appearance and backups remain shared. Backups include every profile, and the selected profile survives relaunch.

Copilot saves importance, urgency, blockers, evidence and uncertainty alongside **impact**, **visibility** and **effort** ratings. Each rating is high, medium, low or unknown with a short rationale; missing implementation evidence is not an effort estimate. In ordinary pipeline runs, only new, changed or expired tasks send full evidence again, in batches of up to 20 tasks and 240,000 UTF-8 bytes. Each batch saves before the next starts. Task changes or assessor instructions/model/format invalidate assessment reuse; prioritizer instructions/model invalidate only ordering. Collection timestamps and duplicate stream provenance do not.

Assessments expire within **24 hours**, earlier for time-sensitive work. Comparative ordering expires within **1 hour**, or sooner when an assessment expires or priorities may cross over. An unchanged run before expiry makes no ranking model calls, including after relaunch. Order expiry alone reorders cached assessments without rereading full evidence. Valid assessments survive a failed order attempt. The private local cache is credential-scoped; switching accounts or rotating credentials starts fresh. Cache hits do not verify current account access, and collection still runs normally.

**Task details → Assessment** keeps the latest result and a version selector for earlier results. Evidence, evaluation time, reassessment due time and provenance remain readable after expiry, edits, Done or relaunch. “Outdated” means the task content or assessment settings changed; “Expired” means the saved reevaluation time passed. These are judgments of the saved inputs, not fresh source checks. Blank model selection is identified as SDK default, not a guessed resolved model.

New v3 results identify the agent and its configuration fingerprint. Earlier v2 history stays readable; absent ratings are labeled **Not recorded**, not invented. Changing an agent never rewrites its historical judgments. Roles and result formats are code-defined, with exactly one definition per supported role; instructions cannot grant tools, source access, delegation or GitHub writes.

Assessment history belongs to the task, including manual tasks, in separate rows of the same local SQLite database. Details read 20 versions at a time; **Older assessments** reads the next page. Logical append order identifies the latest result even if the clock moves backwards. Each subset saves before further assessment or ordering; retries do not duplicate versions. History does not count toward the **8 MiB** task snapshot limit and never prunes itself.

Assessment save failures retain visible pending results with separate retry/export controls; notes, Done and capture can still save. Retry or export pending results before quitting. Database backups, raw preservation and restoration include all history. **Backups & recovery** also exports complete JSON copies up to **64 MiB**; larger histories use database backups/raw preservation. Restoring an older database backup replaces its task state and history together, preserving the pre-restore database first. Results arriving from the previous workspace stay in a separate export-only quarantine with their original revision and generation; they never block new runs or attach to restored tasks. Export quarantined results before quitting. Old replaceable cache entries are not imported as history.

Each saved GitHub query collects up to **200 matches**, using pages of 100. Larger or incomplete searches show a coverage warning; missing matches never mark tasks Done. Reply extraction batches source comments, and ranking still considers the whole active queue together.

Saved searches cache timelines and reply extraction across restarts. After a complete baseline, safe queries fetch issues **updated** since the saved scan boundary, with a five-minute overlap and full reconciliation every six hours. Every cached source still receives a live permission/state check, and PR checks and merge queues stay live. Later streams do not repeat tracked-only checks for sources already observed in the same run. Relative or complex queries keep full searches; failed or unsaved runs retain discoveries for replay.

Timeline gaps, unknown request ages and the 100-check limit remain visible as coverage notes, not failed reads that block a completed scan. Incomplete checks still prevent a PR from being declared ready to merge. Authentication and rate-limit failures stop the remaining reads in that GitHub operation; saved tasks remain intact.

### Identity and Done

A GitHub task identifies **one issue or PR**, using its normalized URL, not its action, notification or search result. Assignment, follow-up, reply and review requests for the same source join one task, including requests discovered through Slack or MCP. All requests share one Done state. Non-GitHub sources still identify **source + action**; manually captured tasks remain separate.

Existing duplicates combine when the workspace loads, after a durable backup of the original snapshot. The first task keeps its ID and title; other titles, notes, evidence and handled evidence are retained. If any duplicate is unfinished, the combined task stays open. Otherwise it stays Done, retaining the latest completion boundary (or no automatic reopening if any completed task lacks a boundary).

Done records handled evidence and a completion boundary. A repeated search, an old newly discovered message, or an unrelated comment cannot reopen it. A fresh actionable request with a new source event after completion can. Current merge-queue, closed and merged state removes tasks from **To do** without marking them Done; they remain in **No action now**.

### GitHub notifications

In **Settings**, choose **Add GitHub notifications**, then **Save settings**. The source joins the same manual or scheduled run as saved searches. Use it instead of broad mentions searches; keep assigned-work, review-request and project backlog searches separately. Adding notifications does not rewrite or remove saved queries.

The first scan covers the last **30 days**. Later scans include both read and unread issue/PR notifications updated since the last successful run. Reading a notification elsewhere does not finish a task. Large backlogs advance oldest-first across runs, with the remaining history shown in the task list. The saved cursor advances only through successfully inspected history, never beyond the run's start, after collection, ranking and persistence succeed. Failures retain the previous boundary for retry.

Notifications identify conversations to inspect, not obligations. Actual source requests determine the action and retain their original event IDs and occurrence times. Notification reasons can remain `mention` after unrelated activity, so neither the reason nor the notification's update time can reopen Done. Requests already found through another source join the same issue or PR task.

**Unsubscribe on GitHub** appears in details for tasks discovered through notifications. Confirm it separately from Done. It stops following the conversation without closing the source, deleting the task or changing completion. Direct mentions, team mentions and review requests can still notify you again. The app saves the unsubscribe intent before sending it; unconfirmed writes stay visible for explicit retry and never replay automatically after relaunch.

### Slack and MCP

Slack uses a selected existing MCP server and explicitly named read tools. Connection credentials stay backend-only. Choose **Read MCP connections** for the available shared configuration and setup instructions. A connection saved only in Copilot app settings is not automatically available to this separate SDK runtime.

New Slack sources prefill **Allowed read tools** with `slack_search_public_and_private, slack_read_thread`. Selecting Slack for a source with an empty tool list fills the same defaults. Saved settings and custom tool lists stay unchanged. Choose the server, review the tools and enable the source before saving; new sources start disabled.

Server and tool names must match exactly, including case. For public-only Slack searches, replace `slack_search_public_and_private` with `slack_search_public`. A configured wildcard does not approve all tools in this app; select the read tools explicitly.

Other apps can submit tasks through the packaged service's `--mcp` stdio entry. For a completed Copilot review, submit a `review-result` task with the PR URL, a stable event ID and the source event time. The producer must call the tool; installing the server does not itself install an automatic review-completion hook. Intake is durable even while the desktop is closed, and is acknowledged only after the task reaches the workspace's durable save.

See the [service contract](service/README.md) for source configuration, intake arguments, bounds and authentication. The app does not embed Slack credentials or silently reuse unrelated tools.

### One workspace

Ranked Tasks uses three panels: navigation, the ranked list and task details. Filters adds a locally filtered view of the same tasks with a scrollable, collapsible source tree. Settings replaces Appearance in the sidebar and includes themes, sources, priorities and scheduling. On narrow windows, task details replace the list until closed.

The old Inbox, Filtered, Archive, Tasks and saved-reference views are retired. Waiting on me and filtering rules are removed, including their logic. Source queries control discovery. Saved thread notes remain private and editable beside matching tasks; backups retain all notes and conversations. Existing saved filtering rules and named inboxes are retired only after an original backup succeeds.

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

## Local storage and recovery

The desktop starts empty after reading SQLite. It never opens browser storage, fixtures, or the previous app's database. Its identifier and data namespace are `io.robertcrandall.github-projects-workspace`:

```text
~/Library/Application Support/io.robertcrandall.github-projects-workspace/
```

SQLite saves the checksummed, revisioned workspace atomically. **Saved on this Mac** appears only after the newest queued changes persist. Conflicts and failed saves retain pending work rather than overwriting another revision. **Backups & recovery** provides pending-copy export, preservation of database files, and explicitly confirmed backup recovery. Recovery never silently resets corrupt data.

Current version-2 data converts to version 3 after a durable immutable backup succeeds. Linked action notes become separate thread annotations with original titles/history. Explicit captured tasks stay tasks even when linked; their thread annotations appear in task details. Their new task notes start empty. Standalone actions/routines become tasks with preserved notes and history. Completed/removed tasks stay Done. No unrelated older application storage is inspected.

The migration retains capture text, progress, step timestamps, project/next-step text and routine history in saved records. The original backup also preserves the retired undo stack. Loading version 3 does not repeat the conversion.

Unconfirmed GitHub writes remain visible and explicitly retryable after relaunch. They never replay automatically. A timeout or interrupted process may follow a successful remote write; check GitHub or retry explicitly rather than treating it as success.

Conversation bodies live in a separate checksummed SQLite cache in the same private app directory, outside workspace snapshots and their 8 MiB limit. A source means one repository + issue/PR type + number, independent of notification IDs. Limits are **4 MiB per source** and **64 MiB total**, measured as serialized UTF-8 data; each service page holds at most five messages within 1 MiB. Untransportable pages and full/corrupt caches produce explicit errors, never shortened bodies, silent eviction or lost notes.

**Discard conversation cache** requires confirmation and clears only cached source data. The native app preserves the discarded cache file locally; those recovery copies need manual cleanup. Notes, Tasks, pending notification evidence and workspace backups are unchanged. Navigation during discard remains usable afterward; pending reads cannot restore discarded content. Loading again requires a separate explicit action. Offline startup/navigation reads the remaining cache without contacting GitHub.

Legacy routines and native reminder delivery are retired. The native reminder array remains empty; the new collection cadence lives separately in task settings. A legacy snapshot cannot notify while loading, after a failed migration, or after backup recovery. Closing hides the existing window; **Show GitHub Projects** returns it and **Quit GitHub Projects** stops the owned service process group.

## Renderer development

Both Vite entries render the same desktop workspace. They require native IPC for task storage; the separate synthetic browser prototype is retired. Browser tests provide mocked IPC without touching live data.

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

The browser suite covers the unified workspace through both renderer entries with mocked Tauri IPC. If Chromium is missing, run `bunx playwright install chromium`. Tests never perform live GitHub writes or request reminder permission.

The packaged executable provides non-prompting native smoke checks:

```bash
app="$PWD/src-tauri/target/release/bundle/macos/GitHub Projects.app/Contents/MacOS/github-projects-workspace"
"$app" --native-smoke-check
session=$(uuidgen)
"$app" --native-ui-smoke-check --integration-smoke-session "$session"
"$app" --native-ui-smoke-relaunch --integration-smoke-session "$session"
```

These use generated TEST directories, not app data. They check the ranked task home, persistent Done, and scheduled ranking while the window is hidden. An explicit smoke-only service fixture supplies responses; unexpected service/model operations fail instead of reaching GitHub. The relaunch command removes that test session; a standalone UI smoke without a session flag cleans up after itself. Smoke failures exit nonzero.

`--integration-service-smoke-check` explicitly performs a tiny synthetic SDK inference and a bounded read-only GitHub refresh through the packaged native host. It consumes Copilot service access and must not run as an automatic test. `--integration-read-smoke-check` performs only the read-only refresh. Both use private TEST directories and report counts/status, never source bodies or tokens.

## Architecture and limits

- [PRODUCT.md](PRODUCT.md) defines behavior; [DESIGN.md](DESIGN.md) and [theme.md](docs/theme.md) define the approved interface.
- [Native integration contract](src/platform/README.md) documents SQLite revisions, recovery, retired schedules, destinations, and owned process hosting.
- [Service contract](service/README.md) documents auth, exact endpoints, source coverage, SDK isolation, and bounded JSONL transport.

GitHub refresh is a bounded view of notifications and REST timeline evidence, not full repository synchronization. Missing notifications prove nothing. Archive retains a monotonic source timestamp; without a notification baseline, activity must be newer than the local archive time. A newly discovered same-timestamp ID alone cannot prove new activity. The independent conversation reader fetches REST message pages, not every historical revision, file diff, resolved-review status or repository content. The service is capability-restricted but not an operating-system sandbox. External Copilot App launching is separate from SDK previews.
