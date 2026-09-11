---
name: "GitHub Projects"
description: "The greenfield workspace's composition and visual constraints, using Fox and GitHub as theme references."
---

# Design System: GitHub Projects

## Direction

**One primary thing. Calm surface.**

I use the **Fox** and **GitHub** themes from Copilot App / GitHub App as the preferred visual references. [Theme direction](docs/theme.md) records what still needs an export or screenshot. Dusk is rejected; no previous palette values remain authoritative.

[PRODUCT.md](PRODUCT.md) owns behavior. The supplied [Design System](docs/Design%20System.md) and [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md) retain their reusable interaction constraints.

The composition is a compact list with one persistent detail pane and a stable Working on anchor. It replaces the old Now/Next recommendation card. Old direction comments, implementation measurements, and generated sidecars do not override this brief.

## Color

Do not invent or approximate named theme tokens before obtaining the reference. The default theme and whether to offer both remain open; a theme-switching interface is not implicitly required.

- Use semantic roles for surfaces, text, boundaries, interaction states, and feedback.
- Keep large surfaces neutral. Small accents identify actions and state without dominating the workspace.
- Use readable foreground/background pairings from the selected reference. Check contrast rather than assuming a named theme makes every pairing accessible.
- Use labels, icons, and structure alongside color for selection, request type, warnings, and errors.
- Do not reuse Dusk values from old CSS or generated artifacts as silent fallbacks.

## Typography

Use the native system stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`. No webfonts, decorative display face, or monospace body copy.

Use a small hierarchy of page headings, detail titles, row titles, body text, labels, and metadata. Weight, spacing, and placement establish hierarchy without several competing headline sizes.

The selected detail has a clear title without recreating an oversized recommendation hero. Working on is identifiable through a persistent label and stable placement, not a second competing headline.

Supporting paragraphs use short readable measures. Dates and counts may use tabular numerals without changing font family. Monospace is reserved for machine output.

## Layout

The desktop-first workspace pairs a compact list with one persistent detail pane. Working on anchors the action I chose; Needs attention contains recommendations and incoming updates; Later retains postponed commitments.

Selection opens detail without changing Working on. A visible return control restores the current action after inspecting other items.

Keep Capture, Refresh, and the last successful refresh time visible. History, routines, and optional project context remain secondary navigation rather than additional permanent panes.

| Surface | Layout behavior |
| --- | --- |
| Wide desktop | Compact list and readable detail share the workspace; extra width does not add unrelated panels. |
| Smaller desktop | Reduce gutters and navigation space before compromising readable titles and visible destinations. |
| Narrow window | Show list or detail with an explicit Back control; retain selection, scroll position, and working context. |

Rows and hairline dividers establish hierarchy without a wall of cards. Long titles and destination controls wrap rather than disappear. New updates occupy a labeled group; refresh must not move existing rows, selection, or keyboard focus.

## Depth and shapes

Use restrained tonal separation and reserved borders for persistent depth. Do not add decorative shadows or a new elevation scale.

Keep controls and containers simple. Reserve border space before interaction. Hover, pressed, and selected states change color, not size, padding, or position.

## Controls

Use related primary, secondary, quiet, and icon treatments. The chosen theme supplies colors; hierarchy determines prominence.

- **Primary:** the current local action, clearly distinguishable without a large accent surface.
- **Secondary and quiet:** supporting actions remain readable and discoverable at rest.
- **Icon:** descriptive accessible names; icons must not obscure the meaning of completion or external writes.
- **Disabled:** a visibly unavailable state that does not resemble a successful action.

Keep native input, textarea, select, and checkbox behavior. Labels stay visible; helper text stays near the control. Use freeform textareas for scratch notes and capture instead of mandatory structured forms.

Keyboard focus must remain visible. Use a deliberate zero-offset focus treatment with sufficient contrast, and reserve its geometry. Never remove the default indicator without a visible replacement.

## Navigation and detail

Use quiet native-text controls on neutral navigation surfaces. Identify the current view and selected row with structure and the appropriate accessible state, not hue alone.

Mark the active action separately so selecting detail cannot look like switching work. Narrow layouts retain labels and an explicit route back.

Lead detail with what changed and why it might need me, then my action, next step, checklist, and scratch notes. Keep request evidence distinct from inference. Working on is my choice, not a recommendation label.

Local Done, Later, notification acknowledgement, and unsubscribe have different effects. Use the explicit labels from PRODUCT.md instead of a generic completion icon that hides the destination of the change.

## Rows and supporting information

Keep rows compact: a work-kind glyph, readable title, repository and number, and a short reason. Text identifies the signal independently of glyph color.

**Open on GitHub** and **Review in Copilot** or **Open in Copilot** remain visible in rows and details without hover, expansion, or an overflow menu. Local actions without references have no invented destination.

Disclosures reveal source history and full captures without opening a competing workspace. Later is quieter but discoverable, with reminder and waiting-note context retained.

User-requested expansion may change layout. Hover, focus, incoming activity, and delayed ranking must not.

## Feedback

Use brief explicit success feedback and Undo where available. Failures show diagnostic text and recovery controls without replacing the saved workspace.

Refresh progress stays local to its control. Saved work remains usable, including when GitHub is unavailable.

Handoff feedback says only that a launch was requested, never that a review finished. Local Undo does not imply a GitHub action was reversed.

Prototype and simulated-data labels are factual. A neutral wireframe must not be labeled a finished Fox or GitHub theme.

## Boundaries

- No Dusk palette, new brand workshop, decorative typography, or invented named-theme values.
- No dense multi-panel project dashboard or giant recommendation card.
- No full-window accent fills, color-only meaning, or unreadable secondary controls.
- No decorative motion, hover lift, scaling, or focus-driven layout shifts.
- No hidden external destinations or invented service status and execution.
