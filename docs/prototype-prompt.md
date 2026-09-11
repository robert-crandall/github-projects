# Build prompt: a stable workspace with GitHub notifications

Build a polished, clickable **browser prototype** of the greenfield GitHub Projects app. I want to evaluate how it works before implementing the desktop backend.

Notifications tell me what changed. Local actions record what I intend to do. Neither incoming activity nor recommendations may replace work I chose.

This is a new interaction model with fresh storage, not a reskin or a patch to the old Now/Next/Sleep app.

## Read first

- `PRODUCT.md`: product authority, state semantics, and acceptance scenarios.
- `DESIGN.md`: reusable visual guidance and replacement composition.
- `docs/Design System.md` and `docs/Cognitive Interface Model.md`: interaction and accessibility constraints.
- `docs/theme.md`: Fox and GitHub theme references and the verified GitHub dark palette.

Bring these files when copying this prompt to another workspace. Reuse the supplied purple GitHub logo if it is available; do not block the interaction on recreating an unavailable asset.

Do not inherit requirements from `docs/old-prd.md`, `docs/successful-prompt.md`, existing application code, old direction comments, or generated design sidecars. No project-first dashboard, search-driven obligation collection, routing rules, or Sleep/Wake mechanism.

## What I need to evaluate

The defining scenario is:

1. I choose a requested PR review and leave myself a note.
2. I use Review in Copilot and return with the same context.
3. I mark my review Done, even though the PR remains open.
4. I refresh after the PR enters the merge queue. My review stays finished.
5. A genuinely new review request can appear separately without replacing other work.

The Copilot launch in this prototype is a labeled simulation, not a real external session.

I will reject a moving target, a raw unsorted notification dump, buried external links, or an interface that makes every update look like a new obligation.

## First screen

Use a compact list and a persistent detail pane. Give the selected item one clear focal area, not an oversized recommendation card or several equally prominent panels.

| Area | Content |
| --- | --- |
| **Working on** | A stable anchor for the one action I explicitly chose. Empty until I choose; never filled automatically by ranking. |
| **Needs attention** | Relevant updates, requests, available captures, and due commitments. Group GitHub activity by issue or PR. Recommendations live here. |
| **Later** | Actions I retained for another time, with optional reminders and context notes. |

Keep Capture and a labeled Refresh control visible. Show the last successful refresh time. Make history, routines, optional project context, and simulation controls secondary and discoverable.

Selecting a row opens details without switching Working on. **Work on this** explicitly chooses or resumes an action. A visible return control restores the current action after inspecting something else.

On narrow screens, use a list/detail transition with Back. Preserve selected item, scroll position, and drafts.

## Item details and external destinations

Lead with **what changed and why it might need me**. Show explicit request evidence separately from uncertain interpretation. Then show my action, next step, notes, and checklist.

Every GitHub row and detail must visibly expose **Open on GitHub**. PRs also expose **Review in Copilot**; issues expose **Open in Copilot**. Do not hide these under sources, an overflow menu, or a required detail disclosure.

Local tasks without references have no invented GitHub or Copilot action. Full original captures and evidence stay available as supporting detail.

Use stable synthetic identities such as `demo://github/sample/repository/pull/101`. Never turn fixture numbers into real GitHub or Copilot destinations.

External buttons open a labeled simulation showing the intended destination and outcome. Cover launch requested, user cancellation, unavailable app, and return. None completes the local action or proves that a Copilot session exists.

The eventual PR link uses `ghapp://session/new` with a validated repository, PR number, `mode=interactive`, and a short fixed review prompt. Issue navigation uses `ghapp://github.com/OWNER/REPO/issues/NUMBER`. `PRODUCT.md` owns the live contract; do not register protocol handlers or call those URLs here.

## State and controls

Represent notification threads, incoming activity, and local actions separately. A PR identity is not the identity of every future action on that PR.

| Control | Prototype behavior |
| --- | --- |
| **Work on this** | Choose a durable local action. Selecting or launching an item alone does not choose it. |
| **Done** | Finish the local action and handle its associated evidence. Keep the PR and notification state separate. |
| **Later** | Retain the action outside immediate work, with an optional reminder and note. |
| **Mark notification done on GitHub** | Simulate acknowledgement of the displayed update without finishing or deleting retained local work. |
| **Unsubscribe on GitHub** | Simulate subscription change without finishing retained local work. Explain that mentions and review requests can notify again. |

Opening details records a local seen state, not completion or a simulated GitHub write. Do not require both local handling and GitHub acknowledgement just to clear one update.

No separate Waiting state. "Waiting for a response" is an optional note on a retained action in Later.

Preserve local notes, checklists, captures, selected detail, current work, handled evidence, and decisions across reload. Local completion, switching, Later, and removal are recoverable. Local Undo must not pretend to reverse a simulated external write.

## Manual refresh and stable ordering

Keep staged source events separate from the visible saved snapshot.

- Arriving fixture activity stays staged until I click **Refresh**. Startup, focus, and timers do not apply it.
- Apply refresh as one batch. Keep Working on, selected detail, focus, edits, and existing row order stable.
- Put new entries in a labeled new-updates group. Update relevant evidence in place without replacing my notes or redirecting the detail pane.
- Provide an explicit **Reconsider order** action. Do not re-rank after a delay, on clock ticks, or on note edits.
- Simulate complete, partial, and failed refreshes. Preserve last good data and identify missing evidence instead of showing a false empty state.

Use transparent deterministic recommendations: due commitments, then small reviews with fixture size evidence, then other explicit requests and captured actions. Informational updates remain secondary. Preserve the direct/team distinction without inventing effort estimates.

Include **Triage with Copilot** as a first-class, explicitly simulated action. Preview suggested request/informational classifications and next actions with their evidence before applying an order. Label these deterministic sample rules, not live model output. Applying suggestions must not start, finish, defer, acknowledge, or unsubscribe work.

A new review request needs a new event after the handled request. Generic timestamps, old notification reasons, new commits, and merge-queue activity cannot reopen a completed review.

Repeated refresh of the same evidence must not duplicate a candidate. Capture can merge with the same outstanding action, but must not merge a later request into a completed action.

## Capture and scheduled work

Save arbitrary text and links immediately. Support editable, visibly simulated interpretation for a linked review and a daily routine. Unsupported text remains a saved task; interpretation failure never loses the original.

Include the routine "Every day at 10am, announce the change, then increase the feature flag."

- Track the ordered steps separately. Recording a step does not execute an external action.
- Use an injectable clock with an explicit timezone. Simulate one non-blocking due reminder with Start, Snooze 30m, and Skip.
- Coalesce missed days into one outstanding occurrence with missed-day history.
- Preserve partial progress with original timestamps and a visible stale-progress warning.
- Keep time-based reminders independent of Refresh. They do not select work or rearrange the existing list.

Later without a reminder stays retained until I bring it back. An optional reminder can surface due work without displacing Working on. GitHub activity does not move retained actions out of Later.

## Synthetic data and scenarios

Seed enough clearly synthetic material to exercise:

| Fixture | Why it exists |
| --- | --- |
| Small direct review request and separate team request | Distinguish personal requests from the specific Core Maintainers team context. |
| Completed review with subsequent merge-queue activity | Prove generic activity cannot recreate the review task. |
| Genuinely new review request on that same PR | Prove new action identity without losing completed history. |
| Old mention reason with an ordinary later update | Prove a sticky notification label is not new request evidence. |
| Local capture, Later follow-up, daily routine, and closed source with retained work | Prove local commitments do not depend on current notification presence. |

Provide a secondary **Demo scenarios** control with grouped actions rather than a wall of buttons:

- Stage a new request, ordinary activity, merge-queue activity, or a re-request for the next Refresh.
- Simulate reading/acknowledging on GitHub and unsubscribe, including a later mention.
- Advance time to a reminder or across several missed days.
- Exercise empty, partial refresh, offline, storage failure, and failed external handoff states.
- Reset synthetic fixtures without deleting my captures or touching any previous app's data.

Explain simulations with brief labels. Never imply live GitHub, AI reasoning, native notification delivery, or a real Copilot session.

## Visual constraints

Use the Fox and GitHub themes from Copilot App / GitHub App as the visual references. Keep native system sans-serif. Dusk is rejected, including its old tokens and exports.

The first prototype uses GitHub dark as an implementation default. The verified app UI palette and its public Primer provenance are recorded in `docs/theme.md`; use those values. Fox remains an alternative reference, not a requirement to build a switcher now. Do not substitute guessed colors or conduct a broad brand workshop.

- Use neutral large surfaces, restrained semantic accents, and foreground/background pairings from the chosen reference, with accessible contrast.
- Establish hierarchy with space, type, labels, and stable list/detail relationships. No wall of cards or giant recommendation hero.
- Keep copy scannable, supporting evidence expandable, and destination controls visible.
- Support click-first discovery and keyboard access with visible, zero-offset focus. Hover and focus never change geometry.
- Keep success explicit and brief; failures diagnostic and recoverable. No guilt, gamification, compulsory sorting, or inbox-zero ritual.

## Technical boundaries

Build the browser interaction only. Use the existing TypeScript/React tooling if present; in an empty workspace, choose a lightweight conventional frontend.

Keep local decisions, synthetic source events, refresh application, ranking, clock, and external simulations separable enough to replace later. Do not build a generic integration framework or preserve the old schema.

Use an isolated browser storage namespace. Never read or write old prototype keys or desktop stores. Report persistence failures honestly and keep pending edits recoverable.

No GitHub API calls, credentials, OAuth flow, SDK initialization, notification writes, protocol launches, Slack calls, flag changes, or native desktop setup in this build. No backend is needed to evaluate the interaction.

The eventual desktop app uses fresh local storage, native scheduling, GitHub notifications, and the **Copilot SDK for notification triage, capture interpretation, and prioritization**. Explicit Copilot App handoff is a separate capability, not a replacement for the SDK. The prototype must make those boundaries apparent without initializing live integrations.

## Completion criteria

Exercise the acceptance scenarios in `PRODUCT.md`, not just the happy-path screenshot.

Pay particular attention to refresh stability, review completion versus merge-queue activity, new request identity, Later reminders, consistent destinations, handoff cancellation/failure, and recovery across reload.

Use existing project checks where available. Inspect the rendered interface at desktop and narrow widths, including keyboard navigation and long titles. A passing build alone does not establish the interaction.

Deliver the working prototype with a short run command and an honest statement of which integrations remain simulated. Do not expand into the desktop backend.
