# Build prompt: GitHub-centric GTD visual prototype

I want you to build a polished, clickable **browser prototype** of my personal GitHub-centric Getting Things Done app.

My goal is to evaluate the interface before wiring integrations. Build the interaction, not a static mockup, and not the eventual desktop backend.

## Read first

- `PRODUCT.md`: confirmed requirements and scope authority.
- `docs/Design System.md`: visual and interaction constraints.
- `docs/Cognitive Interface Model.md`: how the interface should support my attention.
- `docs/theme.md`: Dusk palette and semantic color roles.
- `docs/successful-prompt.md`: reference for GitHub signals only. **Do not execute its commands.**

Do not inherit the project-first landing page, notification routing engine, or broad feature checklist from `docs/old-prd.md`.

If this prompt is copied to another workspace, bring the files above. Do not silently substitute generic styling when the supplied theme or design constraints are missing.

## What I am trying to do

My GitHub digest is useful, but it misses work I capture myself:

- A drive-by request to review a PR.
- A routine: every day at 10am, alert Slack channels that I am increasing a feature flag, then increase it.

I need the app to collect those commitments, recommend one action, and preserve my place when I leave.

I favor quick reviews to close small loops. **Do not impose a review quota, cleanup timer, or forced switch to project work.**

I will reject an ugly interface, an unsorted task dump, or a screen where what matters now looks the same as what can wait.

## First screen and navigation

Build an application, not a landing page.

- **Now:** one dominant action with its source, short reason, and primary Start control. Once started, show the next concrete step and completion control.
- **Next:** a compact, ranked list of other available work. A "show all" control is fine; a processing cutoff is not.
- **Later:** collapsed, quieter, and clearly labeled. Keep future, deferred, and someday work discoverable.
- **Waiting:** preserve the distinction between someone else blocking me and my choosing to defer work.
- **Capture:** a visible, globally reachable control for freeform text and links. No mandatory classification form.
- **Projects:** optional context reachable without making the main screen a project dashboard. Support a lightweight name, notes, and associated actions.

Use hierarchy and landmarks, not a wall of cards. Keep the main workspace calm and let me drill into detail. Never make chat the only way to capture, complete, defer, or switch work.

## Working interactions

Implement these with real local state:

1. Capture arbitrary freeform text; save the original immediately.
2. Show a simulated structured interpretation for the supported review and daily-routine examples. Make it editable.
3. For unsupported input, retain a normal saved item and state the simulation's limitation. Do not discard it or fabricate interpretation.
4. Start an action and keep it in Now until I complete or explicitly switch, even when new work arrives.
5. Complete, undo, defer, restore, and mark work waiting with a reason.
6. Autosave scratch notes and checklist progress.
7. Track the routine's ordered "Announce change" and "Increase flag" steps. Do not imply either external action happened until I mark it done.
8. Simulate the due time, one reminder, snooze, skip, and completed occurrences.
9. Coalesce missed daily occurrences into one outstanding routine with history. Never present several flag increases as catch-up work.
10. Preserve partial progress and original timestamps when time advances. Do not relabel yesterday's completed step as today's.
11. Deduplicate a captured review against the same synthetic GitHub review obligation, retaining both sources.
12. Persist captures, notes, progress, active work, and decisions across reloads.

Completion is local prototype state, never proof of a GitHub review, Slack post, or flag change.

## Simulated prioritization

Use transparent deterministic logic for this prototype, not an LLM:

1. Keep an active action in Now.
2. If nothing is active, recommend a due routine first.
3. Otherwise, favor small reviews.
4. Order remaining actionable work consistently, using staleness as a tie-breaker.
5. Keep future, deferred, completed, and waiting work out of immediate recommendations.

Make a due routine visible without replacing another active action. Do not nag repeatedly.

Use believable fixture evidence for "small review," such as a small diff. Do not claim precise completion times. Show a concise reason for the recommendation, and let me choose something else.

## Sample data and demo controls

Seed a small but varied set of clearly synthetic work:

- A small PR review requested directly of me.
- A distinct team review request for `integrations/terraform-provider-core-maintainers`.
- An authored PR with failing CI.
- A mention that **may** need a reply, visibly weaker than an explicit request.
- A manually captured task without a GitHub link.
- The daily 10am feature-flag routine.
- A future/deferred action, a waiting action, and an optional project with notes.

Give fixture PRs stable synthetic identities so duplicate capture can be exercised. Do not present invented PRs or people as live GitHub data or link fictitious work to potentially real PR URLs.

Provide a small, secondary **Demo scenarios** control:

- Before 10am / routine due.
- New review arrives while I am active.
- Return after several missed days.
- No actionable work.
- Simulated sync or interpretation error.
- Reset sample data without silently deleting my captures.

Label simulated recommendations, data freshness, and notifications honestly. Keep the label unobtrusive, but never imply live GitHub, real Copilot reasoning, or OS notification delivery.

## Visual direction

Use my supplied Dusk theme and Design System. Do not conduct another brand workshop.

- Native system sans-serif, not webfonts or decorative typography.
- Neutral large surfaces; restrained semantic accents.
- Now earns attention through composition, spacing, type, and a single primary action.
- Next remains scannable. Later is quieter, not unreadable.
- Labels and hierarchy carry meaning alongside color.
- Short chunks and expandable detail; no dense explanatory paragraphs.
- Visible keyboard focus, accessible controls, and no geometry changes on hover or focus.
- Click-first discovery, with optional shortcuts.
- Clear, brief success feedback and recoverable local actions.
- No gamification, streaks, XP, guilt, compulsory reviews, or blocking onboarding tour.

Prioritize a desktop viewport, but keep the prototype usable when the browser window narrows. Do not add a separate mobile product.

## Technical boundaries

- Inspect the workspace first. Reuse an existing frontend stack when available; otherwise use a conventional lightweight TypeScript frontend.
- Use browser-local persistence appropriate to the prototype. Show storage failures rather than pretending a capture was saved.
- Keep state, ranking, simulated interpretation, and simulated clock separate enough to replace later. Do not build a generic integration platform.
- Use an injectable demo clock so time-based scenarios are reproducible. The prototype does not need to wait for real 10am.
- Do not call GitHub, Slack, feature-flag services, or the Copilot SDK. Do not request credentials.
- Do not install or initialize the SDK just to satisfy the future architecture.
- Do not add arbitrary command execution, agents with write access, or production automation.

The finished product will be a macOS app with the **GitHub Copilot SDK** in a trusted backend/application process. It will structure captures and help prioritize. Scheduling, storage, progress, and undo remain application logic.

Keep that replacement boundary clear, but do not implement it in this build.

## Completion criteria

I should be able to perform every prototype acceptance scenario in `PRODUCT.md`, especially:

- Recognize Now versus Next versus Later immediately.
- Capture the drive-by review and the daily routine without filling out a form.
- Complete or switch work without losing my place.
- Reload and recover notes and partial routine progress.
- See one outstanding routine after missed days, not a catch-up backlog.
- Distinguish a direct review request, team request, and uncertain mention.
- Explore empty and error states without confusing missing data with no work.

Use the project's existing checks where available. Inspect the rendered interface, not just its code, against the supplied visual constraints.

Deliver the working browser prototype with a concise description of how to run it and which integrations remain simulated. Do not expand into the real backend or desktop app.
