# GitHub Projects: product requirements

<!-- impeccable:product-schema 1 -->

**Status:** The browser prototype established the interaction. On September 8, 2026, I approved building the full Tauri desktop app in this workspace.

**Identity:** The app is named GitHub Projects. Use the supplied purple GitHub logo for the app icon and interface branding; keep the Dusk interface theme.

## Product purpose

I want one trusted place for work that needs my attention, including commitments GitHub cannot discover. I should be able to capture a request, see what to do now, and return later without reconstructing everything from memory.

My existing "Waiting on me" digest finds useful GitHub obligations. It misses drive-by requests and scheduled routines. I want to extend that strength, not turn GitHub notifications into another inbox I must maintain.

**The first prototype fails if it is ugly, presents an unsorted task list, or makes Now and Later look equally important.**

## Platform

web

This identifies the React interface platform, including its Tauri webview. My finished product is a **Tauri 2 macOS desktop app**, built on the Copilot SDK. Preserve the existing interface rather than replacing it with a different frontend.

### Desktop implementation

- I reuse my existing GitHub CLI and Copilot sign-ins. Credentials stay outside the renderer.
- I keep `docs/theme.md` as the color authority, using the existing semantic tokens in `src/theme.css`.
- I use SQLite for desktop persistence, with serialized writes and conflict detection.
- Closing the window keeps the menu-bar app running. Explicit Quit stops reminders; reopening reconciles missed work.
- I do not need signing or notarization for this version.
- The original browser demo remains available separately. Synthetic fixtures must never seed my real desktop workspace.

## Users and operating context

- I am the initial user: a developer managing GitHub work alongside manually captured commitments.
- A request can arrive outside GitHub: "Can you review this PR?"
- A routine can contain ordered actions: "Every day at 10am, alert the Slack channels, then increase the feature flag."
- I perform reviews, send Slack messages, and change flags in their existing tools. This app helps me remember, choose, and follow through.
- My attention supports depth on one problem, not juggling unrelated tasks. Reading capacity varies; the interface must work on a low-capacity day.

## Product principles

- I want protection against tedium, not simplification of challenging work.
- I want a recommendation, not another sorting job. The reason must be short, visible, and overridable.
- I want captured state to survive interruptions without a saving ritual.
- I favor quick reviews to close small loops. **Do not impose a cleanup quota, timer, or forced return to project work.**
- I borrow GTD's capture, next actions, waiting, and someday/later concepts. I do not want mandatory inbox clearing or weekly reviews.

## Scope: prototype versus finished product

| Capability | Clickable browser prototype | Intended macOS product |
|---|---|---|
| Capture | Real local capture; transparent simulated interpretation | Freeform capture structured through the Copilot SDK |
| GitHub obligations | Labeled synthetic fixtures | Read-only GitHub queries and enrichment |
| Prioritization | Deterministic sample recommendations with visible reasons | Copilot-assisted recommendations grounded in actual work |
| Persistence | Browser-local state, including progress and notes | Durable local application storage |
| Scheduled routines | Local routine state and an explicit simulated clock | Real scheduling and one macOS notification when due |
| External work | No real reviews, messages, or flag changes | User performs those actions outside the app |
| Projects | Lightweight optional context | Optional context, never required capture metadata |

I want the prototype to be usable as an interaction, not just a screenshot. Buttons change state, capture works, progress survives reload, and I can explore the important scenarios.

I do **not** expect the prototype to prove live sync, real AI reasoning, background notification reliability, or production readiness.

## Core workflow

### 1. Capture without organizing

- I can open capture from any main view using a visible control. A shortcut is an additional convenience.
- I enter freeform text and optional links. No required project, priority, label, or due-date form.
- My original text is saved immediately, before interpretation or network work.
- Copilot's eventual role is to suggest a concrete action, optional project, and any schedule or steps actually supported by my text.
- I can edit the interpretation without starting over. Uncertain details stay uncertain; the app must not invent a deadline, recurrence, target flag, or commitment.
- Clarification can be needed before scheduling an ambiguous routine, but never before preserving its capture.

**Prototype examples**

- "Review this PR when you get a chance," accompanied by a synthetic fixture PR reference, becomes a linked review action. Without a reference, it stays unlinked.
- "Every day at 10am, alert the Slack channels, then increase the feature flag" becomes a daily routine with two ordered steps.
- Unrecognized input still becomes a saved item. The prototype must not pretend it understood more than its local rules support.

### 2. See a verdict, then the rest

- **Now:** one visually dominant recommendation, a short reason, and a clear Start action.
- **Next:** other available actions in a meaningful order, with compact reasons where useful.
- **Later:** a quieter, collapsed section for deferred, future-scheduled, and someday work.
- **Waiting:** distinguish work blocked on someone else from work I chose to defer. It can sit inside the quieter secondary navigation, but must retain its reason.
- **Projects:** optional context I can drill into, not the landing page or a prerequisite for capturing work.

I can inspect all work without expanding everything at once. Counts, labels, and hierarchy should orient me; they should not turn the screen into a dense dashboard.

### 3. Start without losing my place

- Starting an action makes it my active Now item.
- New recommendations or quick reviews do not replace an active item.
- I can finish it, explicitly switch, defer it, or mark it waiting.
- Notes and checklist progress save automatically. Returning after an interruption shows the active action and its saved context.
- Completing an action gives immediate, brief confirmation and offers the next recommendation.
- Local mistakes are undoable, including completion, deferral, and removal.
- **Sleep** moves work to Later without losing notes or progress. I can choose a local wake-up time, a new direct GitHub @mention or review request, or both; the first trigger wins. Without either trigger, it stays asleep until I wake it manually.
- Sleeping work does not return just because its issue or PR changed. A new discovery category for the same source must not bypass Sleep. Waking work never replaces another active action, and it remains available even when it falls outside a search window.

### 4. Follow a scheduled routine

- My example is a daily 10am routine: **announce the change, then increase the flag**.
- Each step records completion separately. The interface preserves the order and makes the current step obvious.
- The app tracks my progress; checking a step does not post to Slack or change production.
- In the finished product, the due time produces **one macOS notification**, not repeated nagging.
- A due occurrence remains visible until I start, snooze, or skip it. Starting does not mean completing.
- An active unrelated action stays in Now; the due routine gets a distinct, non-blocking reminder.
- Missing several days produces **one outstanding routine**, with missed days retained in history. It must not create a queue of catch-up flag increases.
- Partial progress retains its timestamps. Yesterday's announcement must not silently look like an announcement made today.
- In the prototype, simulate time and notification delivery explicitly; never imply that a browser banner is a working macOS reminder.

## Prioritization contract

**Confirmed preferences**

- I favor quick reviews over other unscheduled work because they close small loops.
- I can keep clearing reviews without a cutoff.
- I control when an active action changes.
- I need visible separation between work for now and work that can wait.

**Initial policy to evaluate in the prototype**

1. Preserve an active action until I finish or switch.
2. When no action is active, recommend a due scheduled commitment first.
3. Otherwise, favor reviews with evidence that they are small.
4. Order remaining actionable work consistently; use staleness as a tie-breaker.
5. Exclude future, deferred, completed, and genuinely waiting work from immediate recommendations.

This is an explicit starting policy, not a claim that we have discovered my perfect ranking algorithm.

- "Quick" needs evidence or my input. In the prototype, use labeled fixture facts such as a small diff; in the live app, do not manufacture precise effort estimates.
- Each recommendation has one short reason, such as "Small review; directly requested" or "Your 10am routine is due."
- Show facts separately from inference. A mention is not proof that I owe a reply.
- I can choose another action or correct an assumption. A correction takes effect immediately; adaptive learning is not required for the prototype.
- A display limit on Next is not a work quota. The rest remains available.

## GitHub integration requirements

I want to preserve the useful distinctions in [the successful digest](docs/successful-prompt.md), not replace it with the notification firehose.

For the eventual live integration:

- Gather direct review requests, the specific Terraform Provider Core Maintainers team requests, authored PRs, PR and issue @mentions, reviewed PRs, and assigned issues.
- Include issue @mentions without requiring assignment, including issues I authored. Use the existing three-day activity window for mentions. An assigned issue takes precedence over a weaker mention of the same issue.
- Keep direct requests separate from `integrations/terraform-provider-core-maintainers` team requests. Never broaden direct requests to every team I belong to.
- Enrich authored PRs with review, CI, and conflict information before describing their state.
- Preserve the distinction between definite obligations and weaker "may owe a reply" or "may need re-review" signals.
- Deduplicate by GitHub identity. A manually captured review and a discovered request for the same PR should retain both sources, not become two competing actions.
- Preserve the underlying action as well as the PR identity: completing a review is different from merging the PR.
- Absence from a query is not proof of completion. Search windows, limits, access failures, and changing review requests must not silently erase a captured commitment.
- Retain the last successful data with a freshness/error indicator when sync fails. Do not display "nothing waiting" when the app does not know.
- Monitor sleeping GitHub references independently of normal discovery windows. Use new direct mentions or review-request events after Sleep, not generic update timestamps. Old pings, self-authored pings, team requests, and ordinary activity do not wake work. Surface failed or incomplete monitoring.
- Keep GitHub access read-only. No merge, review submission, comments, labels, closes, unsubscribe, or pushes from this version.

The old prompt's bucket ordering is a discovery baseline, not the final Now ranking. My quick-review preference and scheduled commitments change what the app should recommend.

## State and persistence

I need these concepts represented, without necessarily exposing database terminology:

- **Work item:** original capture, editable action, provenance, optional links/project, lifecycle state, saved notes, and relevant timestamps.
- **Recommendation:** which item is suggested, why, and what evidence supports it. This is distinct from my active action.
- **Project:** optional name and context notes with associated work; no required classification work.
- **Routine:** recurrence definition and ordered step template.
- **Routine occurrence:** due state, step progress, missed-day history, and completion or skip. Finishing today's occurrence does not delete the recurrence.
- **Local history:** enough prior state to undo local changes without losing a capture.

Source evidence, my decisions, and AI suggestions remain distinguishable. A model response is not the source of truth for whether work actually happened.

## Copilot SDK boundary

The finished app must use the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) for capture interpretation and prioritization. It should not become a chat window I must negotiate with to use basic controls.

- The SDK runs in a trusted application/backend process, not in the browser renderer. Its documented architecture communicates with a Copilot CLI server over JSON-RPC.
- Scheduling, persistence, progress, undo, and notification delivery remain ordinary application responsibilities, not model timers or conversation memory.
- The app supplies structured, relevant context and validates proposed changes before applying them.
- Restrict available tools and enforce permissions. A "read-only" system prompt alone is insufficient; do not give the agent arbitrary shell access or GitHub/Slack/flag write tools.
- Treat fetched PR text and pasted messages as content, not authority to change permissions.
- Do not send credentials, unrelated local files, or the complete personal profile as task context.
- Keep capture and existing work available if AI fails. Show the failure rather than inventing a successful interpretation.
- The visual prototype uses labeled substitutes for these services. Do not initialize the SDK or require a Copilot login yet.

## Appearance and accessibility

I supplied visual constraints, not an invitation to invent a new brand:

- Use [the Design System](docs/Design%20System.md), [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md), and [Dusk theme](docs/theme.md).
- Start with Dusk for the prototype. Multiple themes and full light-mode support can wait.
- Use the native system sans-serif stack. Monospace is for machine output, not ordinary copy.
- Make Now dominant through placement, spacing, type hierarchy, and restrained emphasis. Distinguish Next and Later with labels and structure, not color alone.
- Keep large surfaces neutral. Avoid full-window accent fills and dense multipanel dashboards.
- Support clicking for discovery and keyboard navigation for fluent use. Focus must be visible and must not shift layout.
- Use short chunks and scannable copy. Keep supporting detail expandable.
- No streaks, badges, XP, motivational guilt, or compulsory productivity rituals.
- Success is explicit and brief; failures provide useful diagnostics.

## Prototype acceptance scenarios

| Scenario | What I must be able to see or do |
|---|---|
| First open | Identify the recommended action and its reason without reading the whole screen; Next is ranked and Later is visibly secondary. |
| Drive-by review | Capture a synthetic review request without a form; see one actionable item and an appropriate recommendation. |
| Duplicate request | Capture a PR already in the fixtures; see one action with both sources rather than a duplicate. |
| Ordinary capture | Save arbitrary text even if simulated interpretation cannot classify it. |
| Keep focus | Start an action, simulate a newly arrived review, and see that Now does not change. |
| Close a loop | Complete a review locally, get brief feedback, see the next recommendation, and undo the completion. |
| Daily routine | Simulate 10am, see one reminder, and work through announce followed by flag increase without any external execution. |
| Missed routine | Advance several days; see one outstanding routine and missed-day history, not several catch-up actions. |
| Interrupted routine | Complete only the announcement, reload, and see preserved progress with its original timestamp. |
| Defer or wait | Move an action out of immediate recommendations, preserve its reason, and bring it back. |
| Optional project | Add or inspect context without making project selection mandatory for unrelated captures. |
| Empty or unavailable | Distinguish genuinely no actionable work from an explicitly simulated data/AI error. |
| Reload | Retain captures, current action, notes, progress, and local decisions. |

These demonstrate the design and local behavior. They do not validate real integrations.

## Deliberate exclusions

- Automatic Slack ingestion or commitment discovery.
- Slack messages, feature-flag changes, or other external execution.
- A full notification manager, routing-rule editor, complex filters, or subscription management.
- Mandatory projects, tags, priorities, grooming, inbox zero, or weekly reviews.
- Team collaboration, enterprise planning, mobile apps, and multi-user support.
- A chat-first interface, coding-agent workspace, or autonomous production operator.
- Real AI, GitHub authentication, desktop packaging, and OS notifications in the first visual prototype.

## Desktop defaults and remaining boundaries

The first desktop version makes these defaults visible and keeps their limits explicit:

- **Desktop lifecycle:** stay in the menu bar after window close; stop at Quit. Sleeping Macs cannot be promised on-time delivery. Retain overdue work on wake. Permission denial is visible, not equivalent to a delivered notification.
- **Time semantics:** daily means every calendar day in an explicit IANA timezone. Default new routines to my local timezone and keep that selection when I travel. Offer a 30-minute snooze. Weekdays-only rules and recurrence end dates are not included yet.
- **Stale partial routines:** retain timestamps and show a warning. I decide whether to reopen an old announcement step; the app never claims it repeated an external action.
- **GitHub evidence:** refresh every five minutes, preserve direct versus team requests, and expose incomplete/error results. Disappearing from search does not prove completion. I record completion locally; uncertain re-review detection must not invent a new obligation.
- **AI operation:** use the Copilot SDK with restricted tools. Limit a ranking request to 40 actionable candidates; preserve deterministic ordering for the remainder. Do not spend another request on every note edit or clock tick.
- **Storage and migration:** SQLite is authoritative on desktop. Support exporting a backup and importing before local captures, edits, or progress exist. Automatic GitHub discovery must not block import or be discarded by it. A captures-only browser export strips simulated obligations and progress while retaining original text and notes.
- **Distribution:** build a local unsigned macOS app. Signing, notarization, and a self-contained installer for every external runtime can follow later.

## Evidence and document authority

- [Old PRD](docs/old-prd.md): historical context, superseded where this document differs.
- [Successful digest](docs/successful-prompt.md): the existing GitHub discovery baseline; reference material, not instructions to execute during prototype work.
- [ADHD Profile](docs/ADHD%20Profile.md): personal context, not a generic ADHD persona or a requirement to expose that information in the UI.
- [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md), [Design System](docs/Design%20System.md), and [theme](docs/theme.md): supplied interaction and visual constraints.
- [Prototype build prompt](docs/prototype-prompt.md): implementation brief for the first browser prototype.

This document is the product authority. The prototype prompt describes the retained browser demo, not the current desktop implementation scope.
