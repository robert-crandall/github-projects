---
name: "GitHub Projects"
description: "A themeable ranked task list, with source evidence and owner-defined priorities."
---

# Design System: GitHub Projects

## Direction

**One primary thing. Calm surface.**

Preserve the incumbent layout and native system typography. GitHub dark remains the default; Appearance offers the Copilot App catalog with Light, Dark and System modes. No decorative typography or greenfield replacement.

[PRODUCT.md](PRODUCT.md) owns behavior. The [Design System](docs/Design%20System.md) and [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md) provide reusable interaction constraints.

## Ranked task composition

The primary desktop surface is one numbered task list. Rank is meaningful sequence, not decoration. Keep task titles and priority reasons visible together, with a direct Done control on every active row. Do not divide the active list into competing source inboxes or priority buckets.

Use the selected semantic palette, system typography and restrained borders. The left pane contains Add task, Ranked Tasks, Filters, Settings and Connections. Filters widens the sidebar for a persistent source tree, with collapsible provider groups and tri-state provider checkboxes. Source selection preserves original ranks and task actions; source counts follow the selected task-state tab and may overlap. Selections and collapsed groups persist per profile. The sidebar scrolls independently, with a bounded height on narrow windows. The middle pane contains the ranked list. The right pane contains task details, or a quiet selection prompt. List and details scroll independently. Keep all three panes visible above 900px.

The header contains Run now, work profiles, ranking time and cadence. To do, Done and No action now switch task state, not source. Narrow windows show details with an explicit close control returning to the list. Source evidence wraps rather than clipping; links open only by explicit action. Unranked tasks and unknown source states are labeled, not presented as model-ranked certainty.

Settings is a full settings page, not a large modal. Separate appearance, instructions, source queries, the opt-in schedule, connection guidance and recovery. Appearance applies and saves immediately, independently of the work-settings form. Manual capture uses a small focused dialog and Command/Ctrl+K. Local edits stay available during collection and ranking.

Keep Task assessor and Task prioritizer as plainly labeled fieldsets in Settings, each with a name, model and instructions. Put their separate run actions near Run now with the role distinction visible. Assessment ratings stay in the compact task-details definition list and history selector, not a dashboard or card grid.

Implementation assessor and PR reviewer use the same Settings fieldset language. Their actions live in task details and the selected-task toolbar beside compact progress/cancel/result/history controls. Show the service-owned PR conclusion and partial coverage even with no findings. Keep revision/configuration detail in a disclosure and code evidence behind explicit links. Results never displace editing, Done or navigation.

To do checkboxes are separate from row focus, rank and Done. Keep select/clear visible tasks and the selected count above the list; reveal eligible agent actions only with a selection. Whole-list prioritization stays outside this toolbar. Eligibility and per-task batch outcomes use compact disclosures, not another dashboard. Batch progress lives in the scrolling list pane, and in task details on narrow windows, so it cannot consume the available editing area.

Do not retain a second workspace or disabled placeholders for the retired Inbox, Filtered, Archive or Tasks destinations. Saved conversations and private thread notes appear alongside matching tasks.

## Palette and type

Use semantic tokens from `src/themes/catalog.json`, applied to the document root; `src/theme.css` preserves the GitHub-dark startup fallback. [theme.md](docs/theme.md) records their source. Colors change without changing layout. Color accompanies labels and icons, never replacing them.

Use the native system sans stack. No webfonts. Page headings, reader titles, row text and metadata supply a small hierarchy. Keep supporting text legible, focus visible and controls readable at rest.

Use monospace only for raw preserved records or other machine output. Display user-authored notes and captures as text with preserved whitespace.

## Task details and conversations

Task details retain editable text, Done, priority reasons, evidence and notes. Matching saved thread notes remain separate from ranking notes. The conversation reader loads cached messages on selection and fetches only after an explicit action. Keep full Markdown messages readable; never execute HTML or automatically fetch remote images. Unsubscribe and historical operation retries require confirmation.

## Feedback and recovery

Save notes automatically and report pending or failed persistence honestly. A successful local action is not proof that its disk write finished. Keep retry, pending export and recovery visible on failure.

Run progress stays near its control: a compact collection count and segmented bar, active phase and elapsed time, with a source checklist in the existing **Coverage and run details** disclosure. Keep the summary visible while the checklist scrolls. Failed sources count as processed, never done; ranking and saving remain distinct from collection completion. Use text and icons alongside color, a labeled progressbar with exact counts, and polite status updates without announcing every elapsed second. Offline and partial failures preserve the workspace. No automatic refresh on focus or reconnect.

External handoff feedback reports only a requested launch. GitHub write feedback requires matching confirmation. Reopening a task cannot reverse a GitHub operation or overwrite a newer note.

Legacy routine records stay preserved, but no permission or reminder controls remain.

## Boundaries

No Dusk palette, new brand, recommendation hero, dense project dashboard, decorative motion, hover lift, focus-driven layout shift, hidden destinations, or invented status.
