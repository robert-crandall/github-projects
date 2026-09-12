# GitHub Projects: product requirements

<!-- impeccable:product-schema 1 -->

## Purpose

A local-first, email-like GitHub notification client with standalone task capture. The left pane holds inboxes, the middle lists threads or tasks, and the right reads the selection.

Keep the existing GitHub-dark interface, native Tauri shell, CLI authentication and current SQLite namespace. This is an evolution of the current app, not another greenfield rewrite.

## Inbox and Tasks

**Inbox** contains GitHub threads, grouped by issue or PR. Selecting a thread reads it; it never creates, chooses, or completes a task. Source activity does not imply a personal commitment. Keep request evidence and uncertainty visible without turning the reader into a task-management form.

Notes belong to their thread. They save locally on edit and survive navigation, refresh and relaunch. Multiple annotations stay separate and editable; one must never overwrite another. Notes and local history never enter a GitHub write, Copilot handoff, or model payload.

**Tasks** contains standalone captures. Capture is available from either inbox, including with Command/Ctrl+K. Save arbitrary text immediately, without a network or model round trip. Links and daily phrasing remain text; they do not automatically link a task, interpret a routine, or schedule anything.

Tasks have text, notes and Done. Completed tasks remain visible in a Done section. Only an explicit user change reopens a task. Comments, review requests, merges, closure and merge-queue activity cannot do so.

Working on, Later, routines, mandatory steps, project grouping and commitment ranking are no longer core controls. Retired routines cannot deliver invisible native reminders.

## Reading and external operations

The desktop reader shows real issue/PR descriptions, comments, reviews and inline discussions with stable reply grouping, author, time and source links. Markdown is untrusted: do not execute source HTML or automatically load external images/embeds. Keep long messages readable without clipping.

Selection reads only the separate local conversation cache. **Load conversation**, **Load older** and page reloads are explicit network actions. Keep bounded pagination, page freshness, inaccessible/partial results and missing reply context visible. Stable IDs deduplicate repeated pages and retain edits; discovered history never becomes new notification evidence.

Conversation bodies never enter the workspace snapshot, note saves or model requests. The independent cache is limited to 4 MiB per source (repository + type + number) and 64 MiB total. Full/corrupt caches offer explicit cache-only discard, preserving the old cache file and all notes/Tasks. No silent eviction or reset.

Keep **Open on GitHub** and **Review in Copilot** / **Open in Copilot** visible on eligible thread rows and in the reader. Native launches accept validated GitHub identities, not arbitrary URLs or private notes. A successful launch request does not prove a session exists or a review finished.

Existing **Mark notification done on GitHub** and **Unsubscribe on GitHub** remain explicit, confirmed operations. Save the operation intent before dispatch. Verify the response against that intent; handle only its displayed evidence, not newer events that arrived concurrently. Failed or interrupted operations remain visible and explicitly retryable after relaunch, never automatically replayed.

A compact **Earlier threads** disclosure keeps retained acknowledged or unsubscribed conversations and notes reachable. These are retained conversations, not pending obligations. This is not a new archive model; archive/resurface behavior follows in [#10](https://github.com/robert-crandall/github-projects/issues/10).

Filtering and terminal suppression follow in [#11](https://github.com/robert-crandall/github-projects/issues/11). Future terminal semantics mean confirmed merged, closed, or **currently in GitHub's merge queue**, not release/deployment tracking. Do not implement those future features here.

## Refresh and saves

GitHub refresh stays explicit. Startup, focus, clocks, edits and navigation do not fetch notifications or initialize model requests.

Refresh applies one bounded response to the latest local state. Preserve edits, selection, task completion and existing row order while a request is running. Failed, partial and empty results are distinct; none silently destroys saved history. Missing source evidence remains uncertain.

When the selected conversation is cached, Refresh updates its description and newest pages alongside notifications and publishes the result together. Successful notifications survive reader failures with explicit partial errors. Older saved pages are not implicitly refreshed; their timestamps and explicit reload controls remain available. Preserve reader anchors and per-source scroll positions, and ignore stale selected-conversation responses after navigation.

Local saves use the existing checksummed, revisioned SQLite snapshot and serialized write queue. Saved feedback appears only when the latest changes persist. Errors leave pending edits available with retry and export controls. Conflict recovery backs up the other saved copy before replacing it. Corrupt data never becomes an automatic empty workspace.

## Current-format migration

Migrate the current version-2 workspace to version 3 only after preserving a durable, recoverable original. Never read or import the unrelated older app database or browser namespace.

| Existing record | New home |
| --- | --- |
| Generated action linked to a thread | A separate thread note, with original authored title and preserved action history. Not a Task. |
| Explicit capture linked to a thread | A Task retaining title, exact captures, completion, progress and history. Its annotation moves to a distinct thread note. The Task opens those notes directly. |
| Standalone action or routine | A Task retaining its notes and original history. Routine schedules are retired. |
| Completed or removed action converted to a Task | Remains Done; the original status and any completion time remain in its history. |
| Later action converted to a Task | Open, with the previous reminder and waiting context preserved as history, not a live schedule. |

Action notes are never flattened into a single overwritable string. The original capture text, project text, next step, recorded step times, routine occurrences and previous status remain inspectable. The immutable original also retains the retired undo stack and exact pre-conversion document. Repeated version-3 loads do not migrate or duplicate annotations.

New snapshots contain no reminder schedules. Native delivery must also be disabled before the frontend loads, including after restoring a legacy backup or failing a migration save.

## Prototype and desktop boundaries

The browser prototype uses synthetic data, staged activity, simulated external outcomes and its existing isolated local-storage key. It never calls the native backend. The desktop starts from its validated SQLite snapshot or a genuinely empty database, never browser fixtures.

Both entries share Inbox, Tasks, thread notes and the same domain transitions. Capture, notes and completion work offline. Preserve native packaging, bounded service transport, CLI authentication and recovery safeguards.

## References

[DESIGN.md](DESIGN.md) owns composition and reusable visual constraints. [README.md](README.md) describes operation and recovery. [Native contract](src/platform/README.md) and [service contract](service/README.md) describe integration boundaries. [The prototype brief](docs/prototype-prompt.md) describes browser evaluation. [The old PRD](docs/old-prd.md) is historical, not additional requirements.
