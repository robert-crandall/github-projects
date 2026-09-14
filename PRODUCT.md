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

**Archive** moves a thread out of Inbox immediately and marks its notification done on GitHub. Save local placement, the source boundary and the acknowledgement intent in one snapshot before dispatch. A local save failure prevents the request. Offline or unconfirmed writes leave the local archive in place with visible status and explicit retry; they never replay on startup or reconnect. A source placeholder archives locally without an invalid notification intent, with an explanation that no GitHub write ran.

**Archive** is a clear location beside Inbox and Tasks. Notes and the independent conversation cache remain attached to the same source. Previously retained threads move into Archive once when loaded; explicit Restore remains in Inbox across relaunch, even when GitHub still says Done. Restore never reverses a remote write or resubscribes.

New activity returns the same thread to Inbox. Persist the greatest actual notification `updatedAt` observed and capture it at Archive. A newer notification timestamp can return a thread even with unchanged timeline IDs. Newly fetched source evidence can also return it only when its identity is new and its timestamp exceeds the archive time and retained evidence horizon. Old pages, metadata hydration, sticky reasons, read/unread changes, repeated responses and missing results cannot do so. Without a notification baseline, initial old hydration stays archived; source activity must exceed the local archive time. Uncertain same-timestamp discoveries alone do not prove new activity.

Read/unread is separate from local placement. Archive never closes an issue/PR, unsubscribes, completes a Task or deletes notes. **Unsubscribe on GitHub** remains a separate confirmed action; it changes subscription, not Inbox/Archive placement. Mentions and review requests can still notify.

Verify each write response against its persisted intent, including the captured notification timestamp. Handle only its displayed pending evidence IDs, at most 200 per operation; **Acknowledge remaining evidence** explicitly advances later batches. Retry retains the original context. Older intents without a saved timestamp remain inspectable but cannot safely acknowledge: refresh and explicitly confirm current evidence instead.

GitHub Done uses a whole-notification DELETE. Preflight refuses clearly newer notification activity, but GitHub cannot make GET and DELETE atomic. Activity arriving between them may also be marked done remotely. Never claim event-scoped remote acknowledgement; newer local evidence survives regardless. Unconfirmed writes remain visible on the thread and in Connections.

## Filtering and terminal state

**Filtering rules** organizes GitHub threads only, never Tasks. A rule matches an exact `owner/repo`, source type (PR or issue), and/or literal title substring. All supplied criteria must match; at least one is required. Repository and title comparisons ignore case. No regular expressions, scripts, model calls or network requests run when matching.

Saved rules can be created, edited, disabled, deleted and moved up/down. The **first enabled match wins**. Preview lists matching saved threads, all enabled matches in order, and the effective location before saving. Changes to criteria, destinations or source placement require preview again. The preview is not a new GitHub fetch.

Actions route to a named inbox or keep a thread out of Inbox in **Filtered**. Named inboxes have stable identities separate from names; names cannot be blank, duplicate or built-in locations. Deleting an inbox requires explicitly editing or deleting every referencing rule, including disabled rules. Rule changes re-evaluate placement without deleting notes/history or moving manually archived threads. Rules and inboxes share the existing local save/recovery contract.

Manual Archive takes precedence over filtering. Otherwise confirmed merged PRs, closed issues/PRs, and PRs **currently in GitHub's merge queue** stay in Filtered ahead of ordinary routing. Each thread shows its placement reason and source observation time. Suppression is local: it never acknowledges, unsubscribes, closes a source or completes a Task.

Current queue membership comes only from GitHub GraphQL `PullRequest.mergeQueueEntry`, not historical timeline entries, auto-merge, mergeability or CI. A successful null means not currently queued; denied, unsupported, malformed or partial state results remain unknown. Source-state freshness is independent of notification timestamps and historical messages.

Terminal checkpoints preserve the notification/evidence boundary. New activity while confirmed terminal advances that boundary but does not return the thread. After a confirmed exit/reopen, genuinely newer activity resumes normal routing; old-history hydration does not. Unknown/failed/missing state checks fail open with a warning, while retaining checkpoint provenance so later old history cannot become new activity. Manual Archive is not cleared by an unknown check. Saved observations survive relaunch; only explicit Refresh checks them again.

## Refresh and saves

GitHub refresh stays explicit. Startup, focus, clocks, edits and navigation do not fetch notifications or initialize model requests.

Refresh applies one bounded response to the latest local state. Preserve edits, selection, task completion and existing row order while a request is running. Failed, partial and empty results are distinct; none silently destroys saved history. Missing source evidence remains uncertain.

The normal notification batch cap and bounded older history are coverage limits, not refresh failures. A successful bounded read advances freshness without an error banner. Keep notification coverage visible as a neutral note and timeline coverage in source history. Genuine failed reads and malformed evidence remain explicit.

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
