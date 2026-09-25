# GitHub Projects: product requirements

<!-- impeccable:product-schema 1 -->

## Purpose

A local-first, prioritized todo app. Bring work from GitHub searches, Slack, manual capture and MCP ingestion into a ranked task list for each named work profile.

Each work profile owns its priority instructions, sources, model, schedule, tasks, Done history and run history. Only the selected profile collects and ranks work; external-agent intake goes into that profile on its next run. Existing work becomes the Default profile. Thread notes, connections, appearance and backups remain shared.

Each profile has one named Task assessor and one named Task prioritizer with editable instructions and model. Code fixes their capabilities and result formats; prompts cannot grant tools or new actions. Existing settings initialize both roles from the saved owner instructions and model without discarding sources or schedules. The collection model remains separate. Display names do not change semantic identity.

Each profile also has one Implementation assessor and one PR reviewer. Run these only from explicit single-task actions inside task details. Save start intent before network access and retain immutable versions with source/configuration provenance, partial code evidence, results and errors outside task snapshots. Implementation results recommend a grounded next step, not completed implementation. PR results always show the service-owned no-approval conclusion; no successful code reads means not inspected. Never execute source, edit code, submit a review, mark Done, or automatically replay interrupted jobs. Cancellation waits for the actual outcome, and persistence retries never rerun a model. Database restore separates late results into a durable, exportable quarantine.

Keep the native Tauri shell, CLI authentication and current SQLite namespace. Preserve existing tasks, completion, annotations, backups and recovery while retiring the separate notification workspace.

## Ranked tasks

**To do** is the home screen. Each task shows its rank, concrete action, source and a short explanation of its priority. Details expose notes and the actual requests that created the task. **Done** and **No action now** are separate lists, not inboxes.

**Run now** and the opt-in schedule use one pipeline: collect from enabled sources, reconcile against the latest local tasks, then use the Copilot SDK to rank every actionable task. Owner-authored priority instructions and roadmap text guide ranking. Task notes may inform ranking; unrelated private thread notes never do. Source content remains untrusted data, not instructions to execute.

**Run assessor** explicitly creates fresh assessment versions without collecting or changing order. **Run prioritizer** explicitly recomputes the complete eligible list using current saved assessments and its own instructions, without reassessment. Missing or stale prerequisites give an assess-first message and retain the previous order. Filters never narrow either operation. Separate runs do not advance collection coverage or scheduling timestamps; Run now and scheduled pipelines keep existing reuse policies.

Assessments include impact, visibility and effort, each high/medium/low/unknown with a short rationale, alongside importance, urgency, blockers, evidence and uncertainty. Missing evidence remains unknown, never an invented effort estimate. Prioritizer edits invalidate only order reuse; assessor edits invalidate its judgments and dependent order. Earlier v2 history remains readable without fabricated ratings.

GitHub discovery combines saved backlog queries with an opt-in notification source. Notifications identify conversations to inspect, never obligations by themselves. Inspect actual requests before choosing an action; deduplicate them with requests found through saved searches. Preserve project backlog queries separately from activity discovery. Slack and generic MCP sources use a selected connection with explicitly named read tools. The SDK extracts actionable requests from the source evidence. Do not silently enable broader tools, scrape credentials or pretend an unavailable connection works.

The notification source initially inspects 30 days of issue/PR activity, then changes since the last successful run. Fetch read and unread notifications: reading elsewhere is not Done. Process large backlogs oldest-first across bounded runs and show when history remains, including after relaunch. Advance the saved collection cursor only after successful collection, ranking and durable saving, through inspected history and never past the run's start. Repeated notification reasons and notification timestamps are discovery metadata, not fresh request evidence.

Manual capture saves immediately without a network round trip. Other apps can submit tasks through a durable local MCP intake. A completed Copilot review creates a `review-result` action only when the producer submits it; launching Copilot does not prove review completion.

GitHub task identity is the canonical issue/PR URL, regardless of action. Repository casing, alternate issue/PR links and URL fragments must not duplicate a task. Assignment, follow-up, reply and review requests for the same issue or PR share one task and Done state, retaining evidence from every source. Non-GitHub identity remains canonical source plus action; manual captures stay separate. Consolidate existing duplicates on load after backing up the saved workspace, preserving notes, evidence, completion and ranking. Keep the task open if any duplicate is unfinished.

**Done** records handled evidence and a completion time. Only an unseen actionable request whose source event is newer than completion can reopen the task. Repeated queries, old messages discovered later, general updates and model decisions cannot undo Done. Current merge-queue, closed or merged state suppresses action without falsely completing tasks.

**Unsubscribe on GitHub** is a separate confirmed action in notification-backed task details. It stops following the conversation without closing the source, changing Done or deleting tasks and notes. Mentions, team mentions and review requests can still notify again. Save the captured source and write intent before dispatch, verify the matching response, and retain unconfirmed writes for explicit retry. Never replay writes on launch, reconnect or collection.

Each run applies results to the latest state so concurrent captures, notes and Done survive. Invalid rankings, source failures and save failures remain explicit. Preserve discoveries and the prior order when ranking fails. Missing query results do not prove completion.

Successful assessments are permanent versions on each task, including manual tasks, in its work profile. Save each assessed subset before ordering or assessing more tasks. Task details show the latest result, evidence, evaluation time and provenance, with earlier versions available in a compact selector. Distinguish changed task content or assessment settings from time expiry; neither removes history. Done, restore, reconciliation, duplicate consolidation, profile switching and backups retain versions. Retries reuse immutable result IDs without duplicating history. Concurrent edits retain their text and leave the submitted assessment historical, not current. Old replaceable cache entries do not become invented history.

Keep permanent assessment rows separately paged in the existing local SQLite database, outside the bounded task snapshot. Read versions by logical append order, not wall-clock timestamps. History growth or a failed history append must not exhaust snapshot capacity or block ordinary notes, Done and capture saves. Keep failed append results visible for explicit retry/export. Database backups and bounded JSON export include complete history and profile/task associations; restoring a database backup replaces state and history together, never mixes unrelated rows. Prior-workspace results remain separately exportable without blocking new runs. Each historical task ID belongs to exactly one task per profile, including after consolidation.

Scheduling is disabled until explicitly enabled. While the Mac app runs, including hidden, a native clock triggers due checks. Catch up once after sleep or relaunch; do not overlap or replay every missed interval. Quitting stops runs. Legacy reminder schedules never resume.

## Unified workspace

Ranked Tasks and Filters share the same task workspace. Filters selects configured sources, manual tasks and external-agent intake locally, matching any contributing evidence source without duplicating tasks or changing order. Preserve selections and collapsed providers per profile. An empty selection shows no tasks; Ranked Tasks always shows all sources. Filtering never changes collection, ranking or task data. Use navigation, the ranked list and task details as three independently scrolling panes. Settings contains appearance, sources, priorities and scheduling. Remove the old Inbox, Filtered, Archive and Tasks views; hide their menu entries until replacement destinations exist. Waiting on me and filtering rules, including their service and routing logic, are retired. Saved source queries determine discovery.

Saved thread notes stay private and editable beside matching ranked tasks. Preserve all original notes and conversations in snapshots and backups, without turning saved threads into new tasks.

## Reading and external operations

The desktop reader shows real issue/PR descriptions, comments, reviews and inline discussions with stable reply grouping, author, time and source links. Markdown is untrusted: do not execute source HTML or automatically load external images/embeds. Keep long messages readable without clipping.

Selection reads only the separate local conversation cache. **Load conversation**, **Load older** and page reloads are explicit network actions. Keep bounded pagination, page freshness, inaccessible/partial results and missing reply context visible. Stable IDs deduplicate repeated pages and retain edits; discovered history never becomes new notification evidence.

Conversation bodies never enter the workspace snapshot, note saves or model requests. The independent cache is limited to 4 MiB per source (repository + type + number) and 64 MiB total. Full/corrupt caches offer explicit cache-only discard, preserving the old cache file and all notes/Tasks. No silent eviction or reset.

Keep **Open source** visible in task details. Source links and conversation links open only after an explicit action. Private notes never enter external links.

## Saves

Local saves use the existing checksummed, revisioned SQLite snapshot and serialized write queue. Saved feedback appears only when the latest changes persist. Errors leave pending edits available with retry and export controls. Corrupt data never becomes an automatic empty workspace. Unconfirmed historical GitHub operations remain inspectable and explicitly retryable through Connections.

Retiring saved filtering rules and named inboxes requires a durable original backup before saving the converted workspace. Those retired fields no longer affect discovery or ranking.

## Current-format migration

Migrate the current version-2 workspace to version 3 only after preserving a durable, recoverable original. Never read or import the unrelated older app database or browser namespace.

| Existing record | New home |
| --- | --- |
| Generated action linked to a thread | A separate thread note, with original authored title and preserved action history. Not a Task. |
| Explicit capture linked to a thread | A Task retaining title, exact captures, completion, progress and history. Its annotation moves to a distinct thread note. The Task opens those notes directly. |
| Standalone action or routine | A Task retaining its notes and original history. Routine schedules are retired. |
| Completed or removed action converted to a Task | Remains Done; the original status and any completion time remain in its history. |
| Later action converted to a Task | Open, with the previous reminder and waiting context preserved as history, not a live schedule. |

Action notes are never flattened into a single overwritable string. The original capture text, project text, next step, recorded step times, routine occurrences and previous status remain in saved records and backups. The immutable original also retains the retired undo stack and exact pre-conversion document. Repeated version-3 loads do not migrate or duplicate annotations.

New snapshots contain no reminder schedules. Native delivery must also be disabled before the frontend loads, including after restoring a legacy backup or failing a migration save.

## Renderer boundaries

Both renderer entries use the same ranked workspace and native backend. The separate synthetic browser prototype is retired. Browser tests mock native IPC; production uses SQLite, never demo fixtures. Capture, notes and completion work offline.

## References

[DESIGN.md](DESIGN.md) owns composition and reusable visual constraints. [README.md](README.md) describes operation and recovery. [Native contract](src/platform/README.md) and [service contract](service/README.md) describe integration boundaries. The [prototype brief](docs/prototype-prompt.md) and [old PRD](docs/old-prd.md) are historical, not additional requirements.
