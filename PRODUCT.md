# GitHub Projects: product requirements

<!-- impeccable:product-schema 1 -->

**Status:** On September 11, 2026, I approved a greenfield replacement. These requirements describe the new app, not the existing implementation.

**Identity:** Keep the GitHub Projects name and supplied purple GitHub logo. Replace Dusk: my preferred visual references are the **Fox** and **GitHub** themes in Copilot App / GitHub App.

## Purpose

I want one trusted place to see what needs my attention, choose work, and keep my place. GitHub notifications tell me what changed. My commitments record what I intend to do. Neither incoming activity nor a recommendation gets to replace my chosen work.

The app helps me respond and follow through. It does not turn every notification into a task or make me maintain another inbox.

I also need freeform capture for requests outside GitHub and scheduled routines. Notifications are an input, not a complete record of my commitments.

## Platform and delivery

web

This identifies the interface platform. The first deliverable is a clickable browser prototype. The finished product is a local-first macOS desktop app.

- Use a fresh application model and fresh storage. There is no requirement to migrate or support the previous schema.
- Never open, overwrite, clear, or seed the previous app's storage. Use a distinct browser storage namespace and a distinct desktop data location.
- Retain Tauri, React, SQLite, and the GitHub Copilot SDK as the desktop baseline. Reusing suitable tooling does not require preserving old behavior.
- Evaluate the interaction with synthetic data before implementing live integrations. A prototype is not evidence of working GitHub sync, Copilot handoff, or native reminders.
- Keep credentials outside the renderer. Reuse supported existing CLI sign-ins where possible; surface missing authentication or scopes explicitly.

## Product principles

- **My choice wins.** Refresh, ranking, reminders, and incoming activity never replace work I chose.
- **Changes are not obligations.** Show what changed and distinguish an explicit request from an inference.
- **Finishing is final for that action.** A PR remaining open does not mean my review remains unfinished.
- **Capture first.** Save original text before interpretation or network work. Notes and progress autosave.
- **No maintenance ritual.** No mandatory projects, inbox clearing, weekly reviews, review quotas, or sorting chores.

## Workspace

Use a compact list and a persistent detail pane, not a large recommendation card or a dashboard of unrelated panels.

| Area | Meaning |
| --- | --- |
| **Working on** | The one action I explicitly chose. Its notes, next step, and progress survive navigation, refresh, handoff, and relaunch. |
| **Needs attention** | Requests, relevant updates, due commitments, and available captures. Group GitHub updates by issue or PR without treating the whole thread as one lifelong obligation. |
| **Later** | Work I deliberately retained for another time, with an optional reminder. |

History, routines, optional project context, and connection settings stay reachable without competing with the current detail. Capture is visible from every main view.

### Selection is not commitment

Selecting a row opens its details. **Work on this** explicitly makes an action my current work; inspecting another row does not switch it. A visible return control brings me back to Working on.

On a fresh workspace, show available work and an empty Working on state. Do not automatically promote the first recommendation to active work.

When I finish or switch, the previous action retains its notes and progress. Finishing clears Working on; it does not silently start another item.

### Item presentation

Each GitHub row exposes its title, repository and number, a short reason for appearing, and **Open on GitHub**. Every eligible PR also exposes **Review in Copilot**. These destinations must remain visible without expanding sources or opening a menu.

The detail pane leads with what changed and why it might need me. It then shows my action, notes, checklist, and relevant controls. Full source evidence and original captures remain available as supporting detail.

For issues, show **Open in Copilot** rather than a review action. A local task without a GitHub reference must not show a fabricated destination.

At narrow widths, use list-to-detail navigation with an explicit Back control. Preserve selection, scroll position, and my current work.

## Refresh and continuity

**GitHub refresh is manual only in this version.**

- Show a labeled **Refresh** button and the last successful refresh time in the main workspace, not only in settings.
- Do not fetch GitHub automatically on startup, window focus, network reconnection, or a timer. A fresh installation explains that Refresh loads GitHub activity.
- Treat refresh as one batch, including any requested enrichment and ordering. Do not publish an initial reorder followed by another delayed AI reorder.
- Preserve selected detail, keyboard focus, drafts, notes, and Working on during refresh. Retain existing row order; place newly discovered entries in a clearly labeled new-updates group.
- If refresh is partial or fails, retain saved data and show what is missing. No results is not the same as a successful empty result.

An explicit **Reconsider order** action may re-rank available work. It never changes Working on. Choosing work, finishing, or moving an item to Later takes effect immediately without a GitHub refresh.

Local clocks and scheduled reminders continue independently of GitHub refresh. A due reminder appears without selecting an item or moving the current row.

Hourly GitHub refresh is a possible later feature, not a hidden default or a setting to build now. It must preserve the same continuity guarantees.

## Notifications and commitments

Keep three concepts separate:

| Concept | What it records |
| --- | --- |
| **GitHub thread** | The issue or PR and its notification/subscription state. |
| **Incoming update** | Activity I have not yet handled, with the evidence available for this refresh. It may be informational. |
| **Local action** | A commitment I chose or captured, with its own completion, notes, and progress. |

A single PR can have a completed review and a later, genuinely new review request. Keep them associated without reopening or overwriting the completed action.

Deduplicate repeated fetches of an update. A captured review and an outstanding request for that same review should retain both sources, not compete as separate actions. Do not merge a new request into a completed review simply because the PR URL matches.

### GitHub discovery

Use GitHub notifications as the primary discovery input. Do not restore the old search-driven collection of every recently reviewed PR or recently updated mention.

- Include read as well as unread outstanding notifications. Reading a thread in GitHub must not make a retained commitment disappear.
- Enrich threads with the activity and current issue/PR state needed to describe them honestly. A generic `updated_at` timestamp or notification `reason` is not proof of a fresh request.
- Distinguish direct requests from team requests. Preserve the specific `integrations/terraform-provider-core-maintainers` team context; do not describe every team request as personally assigned.
- Show uncertain activity as an update to inspect, not a definite review or reply obligation. Informational changes should not outrank explicit requests.
- Make pagination, access failures, stale evidence, and incomplete event coverage visible. A missing thread does not prove completion.

GitHub's notification `reason` is thread-level and can retain `mention` after the original mention. Likewise, `review_requested` does not by itself distinguish a new direct request from an old or team request. Establish new requests from activity after the previously handled evidence, not these labels alone.

Notification availability depends on GitHub settings and retention. Persist captured and chosen commitments locally; do not use notification history as durable task storage.

### What can create a new action

A new review request or a new message asking something of me can surface as a new candidate. Show its actor, time, and source when available. Uncertain messages remain uncertain until I choose to act.

Ordinary comments, CI updates, new commits, merge-queue activity, and merged/closed state do not automatically reopen completed work. A new commit is not a new review request.

Refreshing the same evidence repeatedly must not regenerate a handled candidate. If I finish a review locally, treat its existing request as handled even if GitHub still returns that request.

New activity on work in Later may appear as an update in Needs attention. It must not move the retained action out of Later or override its reminder. There is no event-triggered Sleep/Wake mechanism.

## Actions and their effects

Keep labels explicit about whether an action affects my work or GitHub.

| Control | Effect |
| --- | --- |
| **Work on this** | Choose or resume a local action as Working on. Does not mark a notification done or submit anything externally. |
| **Done** | Finish my local action and handle the evidence associated with it. Does not close the issue/PR, submit a review, unsubscribe, or mark the GitHub notification done. |
| **Later** | Retain my intended action outside immediate work, optionally with a reminder. Does not change GitHub state. |
| **Mark notification done on GitHub** | Explicitly acknowledge the notification on GitHub. Does not finish, delete, or forget a retained local action. |
| **Unsubscribe on GitHub** | Explicitly change the thread subscription. Does not finish a local action or erase its notes. |

Opening details records that I saw the update locally; it does not silently write GitHub read state. Reading is not completing. GitHub's notification-done control also handles the displayed update locally after confirmed success, without requiring a second inbox-clearing step.

Notification acknowledgement and unsubscribe are the only GitHub write operations in the initial desktop scope. Keep them separate from local Done, but readily available when inspecting a notification.

GitHub unsubscribe suppresses ordinary conversation updates, not every future notification: direct mentions, team mentions, or review requests can bring notifications back. State that limit plainly. Do not recreate unsubscribed work through the old discovery searches.

Persist failures and provide explicit retry for external actions. Do not claim an acknowledgement or unsubscribe succeeded because a request was queued. Local completion must remain possible without GitHub connectivity.

Local completion, Later, removal, and switching are recoverable. Restoring a local action does not undo a GitHub acknowledgement or subscription change. Do not imply an external action can be undone unless that reversal actually succeeds.

### No separate Waiting state

If I retain a follow-up, I can leave a note such as "Waiting for a response" and optionally set a reminder in Later. I do not have to choose between two nearly identical lifecycle controls.

If I reviewed a PR and owe nothing else, I am done. I am not waiting for its author to merge it.

## Capture, recommendations, and routines

### Capture

Save arbitrary freeform text and optional links immediately. No required project, priority, label, or date form. Interpretation can propose an editable action or routine, but cannot discard the original or invent commitments.

Unsupported text remains a normal saved action. Interpretation failure leaves it usable. Optional project context must never become a prerequisite for capture or a notification-routing chore.

### Recommendations

Recommend available work inside Needs attention, with a short visible reason. Recommendations never occupy Working on without my choice.

Prefer due scheduled commitments, then small reviews with real size evidence, then other explicit requests and captured actions. Keep informational or uncertain updates secondary. Direct and team requests remain distinguishable.

No cleanup quota, time budget, or forced switch away from reviews. Preserve ordering between explicit refresh/reconsider batches. Captures appear immediately without reordering the rest.

In the desktop product, the Copilot SDK may structure captures and suggest ordering from bounded relevant evidence. The app owns state transitions, clocks, storage, and completion. Basic controls work without the model; unavailable suggestions are identified rather than invented.

### Routines

Retain ordered scheduled routines, including "Every day at 10am, announce the change, then increase the feature flag."

- Record each step separately. The app does not post to Slack or change flags; I record actions performed in their existing tools.
- Show one non-blocking reminder per due occurrence. I can start, snooze for 30 minutes, or skip it. Starting does not mean completing.
- Coalesce missed days into one outstanding occurrence with missed-day history, not a backlog of flag increases.
- Preserve partial progress and its original timestamps. Yesterday's announcement never silently becomes today's.
- Use an explicit timezone for daily schedules, initially my local timezone. Keep that choice when I travel; show permission or delivery limitations.

In the desktop product, closing the window keeps reminders running in the menu bar; explicit Quit stops them. Reopening reconciles missed time without automatically fetching GitHub. Sleeping Macs and denied permissions cannot be promised on-time delivery.

## Copilot App handoff

Make external handoff part of the workflow, not a second embedded coding agent.

For a PR, **Review in Copilot** uses the documented session link:

```text
ghapp://session/new?repo=OWNER%2FREPO&pr=123&mode=interactive&prompt=Review%20this%20PR
```

The Copilot App asks for confirmation before creating a session. Launching or cancelling that dialog does not finish, switch, or lose the local action. Returning to GitHub Projects restores my place.

For an issue, **Open in Copilot** opens the issue, not a fictitious PR session:

```text
ghapp://github.com/OWNER/REPO/issues/123
```

Issue navigation depends on the repository being configured in Copilot App. Keep Open on GitHub available if setup is needed.

- Build links from validated GitHub repository identities and positive issue/PR numbers. Encode parameter values; do not concatenate untrusted query fragments.
- Use the official `ghapp://` scheme for native handoff. Where a web launcher is needed, encode the full app link in `https://github.com/copilot/app/launch?open=ENCODED_APP_LINK`.
- Use a short fixed kickoff prompt. Never place scratch notes, credentials, private message bodies, or other sensitive content in URLs.
- Surface launch failures and retain Open on GitHub as a fallback. Successful OS dispatch proves only that the handoff was requested.
- Do not claim the session started, the review finished, or a prior session can be resumed. Session tracking, callbacks, and automatic completion require a separate future integration.

The browser prototype demonstrates this interaction with a labeled simulation. Never launch synthetic fixture identities in GitHub or Copilot.

## Appearance and accessibility

Use the [Fox and GitHub theme references](docs/theme.md), the reusable constraints in [Design System](docs/Design%20System.md), and the [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md). Dusk is no longer an approved palette.

- Use native system sans-serif, neutral large surfaces, and restrained semantic accents. Match the named app themes rather than inventing another palette.
- Establish one focal detail using hierarchy and spacing. Compact lists provide orientation; they must not become a dense multi-panel dashboard.
- Use short labels and scannable evidence. Supporting provenance can be expandable; external destinations cannot be buried there.
- Make core controls discoverable by clicking and accessible by keyboard. Preserve visible focus and stable geometry on hover, selection, and focus.
- Show brief explicit success and useful failure diagnostics. No gamification, guilt, compulsory onboarding tour, or mandatory inbox-zero ritual.

The default theme, whether the first version offers both, and exact color values remain open. Obtain a theme export or screenshots of the named themes before locking visual styling. Do not infer those decisions from the previous Dusk implementation or turn this into a broad brand workshop.

## Acceptance scenarios

### Choosing and keeping work

| Scenario | Required result |
| --- | --- |
| First open | Saved work loads without a GitHub request. Refresh is visible. Working on is not an automatic recommendation. |
| Choose an action | Work on this establishes the current action. Selecting another row only inspects it. |
| New request during work | Nothing changes until Refresh. After refresh, new updates are distinct; the selected detail, existing row order, and current work stay in place. |
| Finish or switch | Notes and progress remain. Finishing does not automatically start the next recommendation. |
| Return after handoff or reload | The selected detail and Working on survive with saved notes and progress. |

### Handling GitHub activity

| Scenario | Required result |
| --- | --- |
| Review finished, PR queued to merge | Finish the review, then refresh merge-queue activity. The review remains finished; no new review action is invented. |
| Review requested again | A genuinely new request appears with new evidence, associated with the same PR but distinct from the completed action. |
| Sticky notification reason | An old `mention` or `review_requested` label on a routine update does not masquerade as a fresh request. |
| Read, notification done, unsubscribe | Demonstrate their different effects without completing or losing a retained local action. Simulate failures without false success. |
| Closed, missing, or repeatedly fetched thread | Current source state is visible; retained work survives. Old evidence does not regenerate handled candidates. |

### Local work and destinations

| Scenario | Required result |
| --- | --- |
| Capture arbitrary text or an existing review | Preserve the original; merge only the same outstanding action, not a later request into a completed review. |
| Later with waiting note | Retain context with or without a reminder. Ordinary GitHub activity does not move it; a due reminder never steals focus. |
| Missed or partial routine | One outstanding occurrence; original step timestamps and missed-day history remain visible. |
| GitHub and Copilot destinations | Every eligible list row and detail exposes the correct destination. Handoff, cancellation, unavailable app, and return leave the task unfinished. |
| Empty, offline, partial, or storage failure | Distinguish these states, retain saved data, and expose recovery. Do not claim unsaved edits are durable. |

## Prototype and desktop boundaries

| Capability | Browser prototype | Desktop product |
| --- | --- | --- |
| Notifications | Synthetic threads and activity, staged until manual Refresh | GitHub Notifications API and relevant source enrichment |
| Capture and ordering | Transparent deterministic interpretation and recommendations | Restricted Copilot SDK assistance with ordinary controls still available |
| Persistence | Isolated browser-local state; never reuse the old key | Fresh SQLite store; never reuse the old app-data location |
| Reminders | Explicit simulated clock and delivery | Native scheduling with visible permission/delivery status |
| External controls | Labeled GitHub/Copilot outcome simulations | Explicit notification writes and validated native launch links |

No real credentials, network integration, SDK initialization, GitHub writes, or native reminders belong in the prototype. No synthetic data belongs in a real desktop workspace.

The desktop app must keep local work usable during outages. Durable writes, input validation, native launching, scheduling, and narrow permissions are application responsibilities, not promises delegated to a model prompt.

## Deliberate exclusions

- Migration, compatibility with old storage, or automatic import of the previous app.
- Search-driven obligation discovery, a project-first dashboard, routing rules, broad filter builders, and notification-triggered Sleep/Wake.
- Background GitHub polling, automatic reprioritization, and automatic task completion from generic source activity.
- GitHub writes beyond explicit notification acknowledgement and unsubscribe; no review submission, merge, comments, labels, close, or push from this app.
- Copilot session tracking or callbacks, embedded coding agents, team planning, mobile apps, and mandatory productivity rituals.

## Document authority

This file is the product authority. [The prototype prompt](docs/prototype-prompt.md) specifies how to evaluate it with a clickable prototype. [DESIGN.md](DESIGN.md) supplies the reusable visual guidance and approved composition; [theme.md](docs/theme.md) records the preferred theme references and remaining palette decisions.

[The old PRD](docs/old-prd.md) is historical context, not an additional source of requirements. The previous application and search digest have been removed; do not restore their behavior from repository history or execute the old digest as part of prototype work.

Integration references: [GitHub notifications REST API](https://docs.github.com/en/rest/activity/notifications), [GitHub inbox semantics](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox), and [Copilot App deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links). Confirm current endpoint and authentication behavior before implementing the desktop integration.
