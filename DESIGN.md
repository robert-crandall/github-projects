---
name: "GitHub Projects"
description: "A GitHub-dark, three-pane notification client with separate Inbox and Tasks."
---

# Design System: GitHub Projects

## Direction

**One primary thing. Calm surface.**

Preserve the incumbent GitHub-dark palette and native system typography. No new visual world, theme workshop, decorative typography, or greenfield replacement.

[PRODUCT.md](PRODUCT.md) owns behavior. The [Design System](docs/Design%20System.md) and [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md) provide reusable interaction constraints.

## Composition

The app works like an email client: inboxes on the left, a compact list in the middle, and the selected reader on the right.

**Inbox** lists GitHub issues and PRs, not generated commitments. **Tasks** lists standalone local captures, with completed tasks in a Done section. Capture remains visible in both. There is no Working on anchor or commitment-ranking control.

Selecting a row only opens it. Refresh must not move focus, replace local edits, select a task, or reorder existing rows. New source rows can append in a labeled group.

**Archive** is a peer location beside Inbox and Tasks, not a disclosure or second task system. It keeps conversations and notes reachable until new activity returns the same thread to Inbox. A migrated linked Task opens its thread notes in the correct location.

Named inboxes appear under Inbox. **Filtered** is a visible peer containing rule-excluded and terminal threads, with counts and the same reader/notes. Long inbox names wrap; navigation scrolls within its pane, horizontally on narrow windows.

| Surface | Behavior |
| --- | --- |
| Wide desktop | All three panes remain visible; reader text has a restrained measure. |
| Smaller desktop | Reduce gutters and navigation space before sacrificing readable titles. |
| Narrow window | List or reader, with explicit Back to list; retain notes, selection and per-inbox scroll. |

Use rows and hairline dividers, not a wall of cards. Long titles and destinations wrap. Independent list and reader scrolling keeps navigation stable.

## Palette and type

Use semantic tokens from `src/theme.css`; [theme.md](docs/theme.md) records their source. Large surfaces stay neutral. Color accompanies labels and icons, never replacing them.

Use the native system sans stack. No webfonts. Page headings, reader titles, row text and metadata supply a small hierarchy. Keep supporting text legible, focus visible and controls readable at rest.

Use monospace only for raw preserved records or other machine output. Display user-authored notes and captures as text with preserved whitespace.

## Reader and controls

Thread detail starts with the source title and visible GitHub/Copilot destinations. The desktop **Conversation** reader presents full Markdown messages in chronological groups, with author, time and source links. Inline replies stay with their discussion; missing opening context remains explicit. The isolated browser prototype retains its honestly labeled synthetic source summaries.

Keep readable body type, wrapping code and independently scrolling tables. Do not clip messages, render raw source HTML or automatically fetch remote images. Put cache/loading errors and explicit Load/Reload controls near the reader; page freshness and older-history controls use a compact disclosure. Preserve the current visible message anchor as pages arrive.

Thread notes are private, locally saved textareas. Migration may produce several separately labeled annotations. Preserve their source titles and inspectable original action history. Editing one must not overwrite another.

Task detail uses text, notes and a Done checkbox. No required project, priority, Working on, checklist ritual, or routine configuration. Original migrated progress remains read-only history, not executable steps.

Keep native input behavior, visible labels, keyboard focus and Command/Ctrl+K capture. Capture uses a focused dialog. **Archive thread** is an immediate primary action with inline copy naming its local and GitHub effects. Keep the selected reader open after its row leaves the list so notes, scroll and focus remain stable. **Restore to Inbox** reverses only local placement.

**Filtering rules** opens a focused editor without replacing the selected reader. Use labeled native inputs for exact repository, source type and literal title text; no query language. Show saved rules in explicit top-to-bottom order with enabled, edit, delete and up/down controls. Require **Preview matches** before saving a draft. Preview shows effective Archive/Filtered placement when it takes precedence over a rule. Named inbox management stays in a compact disclosure within the same editor. Escape returns focus to its opener.

The reader names the current location, winning rule or terminal reason, and saved source-state observation time. Unknown state uses a visible warning rather than a terminal badge. Filtered threads keep the ordinary reader and notes; filtering never looks like a confirmed GitHub write. Editing rules and refreshing preserve selection and read position even when the row moves.

Unsubscribe and explicit acknowledgement retries use confirmation dialogs. Show pending, unconfirmed and confirmed outcomes honestly; closing a pending dialog does not cancel its request. Connections exposes unconfirmed writes after navigation/relaunch. GitHub acknowledgement, unsubscribe and local task Done remain distinct; do not add a competing ordinary Done control beside Archive.

## Feedback and recovery

Save notes automatically and report pending or failed persistence honestly. A successful local action is not proof that its disk write finished. Keep retry, pending export and recovery visible on failure.

Refresh progress stays at its control. Offline and partial failures preserve the workspace. No automatic refresh on focus or reconnect.

External handoff feedback reports only a requested launch. GitHub write feedback requires matching confirmation. Undo affects task completion only; it cannot reverse a GitHub operation or overwrite a newer note.

Prototype labels and synthetic-data notices remain factual. Legacy routine records explain that reminders are retired; no permission or reminder controls remain.

## Boundaries

No Dusk palette, new brand, recommendation hero, dense project dashboard, decorative motion, hover lift, focus-driven layout shift, hidden destinations, or invented status.
