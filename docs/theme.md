# Theme direction: Fox and GitHub

**Approved references:** the **Fox** and **GitHub** themes in Copilot App / GitHub App.

**Rejected:** Dusk. Its lavender surfaces, warm text, fern accent, and exported tokens are not requirements for the new app.

This document replaces the old Dusk export. It is a reference brief, not a verified token palette.

## What is settled

- Match the named app themes rather than inventing a new brand or another custom palette.
- Keep native system typography, a calm workspace, and one focal detail.
- Use theme roles for surfaces, text, borders, selection, focus, and semantic feedback.
- Keep colors independent of layout and work state so choosing a theme does not change behavior.

The references are the themes in the app, not an unrelated theme with the same name or an assumed copy of the GitHub website.

## What still needs a reference

An authoritative theme export is preferable. Screenshots of each theme's list/detail view and selected or focused controls can establish the visual direction when exports are unavailable.

| Decision | Status |
| --- | --- |
| Default theme | Not selected between Fox and GitHub. |
| Theme options | Offering both in the first version is not yet a requirement. |
| Light/dark variants | Not specified; do not invent required variants. |
| Exact colors and pairings | No verified export or screenshots have been supplied for either theme. |

Confirm these before treating the visual prototype as finished. A neutral wireframe can evaluate interaction first, but must not be presented as either theme.

## Applying the chosen theme

Map the reference into a small set of semantic roles:

| Role family | Required coverage |
| --- | --- |
| Surfaces | Workspace, navigation, detail, input, hover, pressed, selected. |
| Text | Primary, secondary, disabled, links, text on action fills. |
| Boundaries | Dividers, controls, selected state, keyboard focus. |
| Feedback | Success, warning, and error with readable foreground/background pairs. |

Use actual reference values when available. Do not fill missing values with old Dusk tokens or fabricated values labeled Fox/GitHub.

Check contrast on the real rendered pairings. Labels and interactive metadata must remain readable; selection and status cannot depend on hue alone. Focus must be visible without changing geometry.

## Authority

[`PRODUCT.md`](../PRODUCT.md) owns behavior. [`DESIGN.md`](../DESIGN.md) and the [Design System](Design%20System.md) retain the composition and accessibility constraints.

Old application CSS, generated design sidecars, screenshots of the previous prototype, and Dusk exports are historical material, not fallback theme sources.
