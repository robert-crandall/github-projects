# Browser prototype: Inbox and Tasks

Use [PRODUCT.md](../PRODUCT.md) as the behavior authority and [DESIGN.md](../DESIGN.md) for the existing GitHub-dark interface. This prototype shares its product model with the real desktop entry. It is not a greenfield design exercise.

## Composition

Inboxes on the left, list in the middle, reader on the right. **Inbox** contains threads grouped by issue or PR; **Tasks** contains standalone captures. Selecting a thread never creates or chooses a task. A compact **Earlier threads** disclosure retains conversations and notes after acknowledgement/unsubscribe.

Capture and manual Refresh remain visible. On narrow windows, use an explicit Back to list control. Preserve selection, text edits, keyboard focus and per-view scroll.

## Local behavior

Thread notes save immediately and persist across refresh/reload. Several existing annotations on one thread remain separate; preserve their titles and original histories.

Capture arbitrary text from either view into Tasks without interpretation. Links and daily phrasing stay text. Tasks have text, notes and Done, with completed tasks retained. GitHub activity never reopens them.

Working on, Later, routines and commitment ranking are retired. Existing routine content remains inspectable history, not a live schedule. Convert current browser data only after backing up the original; never inspect unrelated storage.

## Synthetic source activity

Stage comments, mentions, direct/team requests, merge-queue activity, closure, read, acknowledgement and new threads. Apply them only on explicit Refresh. Partial/offline failures keep saved context.

Keep both external destinations visible on eligible rows and in the reader. Clearly label all launch/write outcomes as simulations. Cancellation, failure and launch requests never complete Tasks or send private notes.

The initial reader uses bounded source summaries and labels them accordingly. Full reading, archive/resurface behavior and filters are separate follow-up issues.

## Evaluation

Verify thread selection without tasks, multiple independent thread notes, immediate capture from both inboxes, Done across refresh/reload, and earlier-thread note access. Exercise storage failure/retry, backup before migration, keyboard focus, narrow navigation, safe simulated destinations and refresh races.

No credentials, SDK initialization, live GitHub calls, or native reminders belong in the browser prototype.
