---
name: "GitHub Projects"
description: "The local prototype's semantic projection of supplied Ultra Dusk."
colors:
  substrate: "#30313d"
  base: "#393a47"
  panel: "#464653"
  hover: "#51505d"
  pressed: "#5c5966"
  selected: "#4d4b61"
  border: "#6c6673"
  input-border: "#8b828d"
  text: "#e6dbd1"
  subtext: "#cabab7"
  muted: "#a7979c"
  primary: "#add991"
  on-primary: "#282935"
  primary-tint: "#484f51"
  primary-on-tint: "#add991"
  secondary-text: "#96b7fb"
  danger: "#fd9b9b"
  danger-border: "#77555e"
  warn: "#eed198"
  warn-border: "#776d63"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  row-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "6px"
  container: "8px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "18": "18px"
  "24": "24px"
  "30": "30px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
  button-primary-active:
    backgroundColor: "{colors.primary-tint}"
    textColor: "{colors.primary-on-tint}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.subtext}"
    rounded: "{rounded.control}"
    padding: "7px 8px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.subtext}"
    rounded: "{rounded.control}"
    padding: "6px"
    width: "34px"
  button-disabled:
    backgroundColor: "{colors.substrate}"
    textColor: "{colors.subtext}"
  input:
    backgroundColor: "{colors.substrate}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.substrate}"
    textColor: "{colors.text}"
    rounded: "{rounded.container}"
  work-row:
    textColor: "{colors.text}"
    typography: "{typography.row-title}"
  disclosure:
    textColor: "{colors.text}"
---

# Design System: GitHub Projects

## Overview

**Creative North Star: "One primary thing. Calm surface."**

I document the implemented application's semantic projections, not a new visual identity. [Ultra Dusk](docs/theme.md), the supplied [Design System](docs/Design%20System.md), and [Cognitive Interface Model](docs/Cognitive%20Interface%20Model.md) remain the visual and interaction authorities. This document and its sidecar defer to them. The frontmatter records reusable implementation values; it does not replace, reinterpret, or extend the supplied Dusk palette.

I preserve the pinned world: lavender-cast neutral surfaces, warm text, native system sans, and fern on the primary control. Hierarchy comes from placement, space, type, and concise labels. Supporting information remains available without requiring attention at the same time.

**Key Characteristics:**
- One primary thing on a calm neutral surface.
- Native typography with scannable, short supporting text.
- Restrained semantic accents and precomputed foreground pairings.
- Visible, zero-offset focus and instant, non-moving control states.
- Optional drill-in detail with clear paths back.

I extracted these decisions from [theme tokens](src/theme.css), [styles](src/styles.css), [the app shell](src/App.tsx), and [work components](src/components/Work.tsx). [PRODUCT.md](PRODUCT.md) owns product behavior; the direction comment in [index.html](index.html) owns this prototype's composition. I did not reopen the pinned visual direction.

## Colors

I retain Dusk's lavender-cast neutrals and warm-neutral text, using the application's semantic names rather than raw accent names.

### Primary

- `primary` projects Dusk's primary fill/text and confirm text: primary controls, focus, small active markers, and success glyphs.
- `on-primary` projects `role.primary.on-fill`; it pairs with the primary fill.
- `primary-tint` and `primary-on-tint` project `role.primary.tint` and `role.primary.on-tint`; they form the pressed primary pair.

### Secondary

- `secondary-text` projects `role.secondary.text` for review glyphs and team context. It is not a large-area fill or a second primary action.

### Neutral

| Application token | Supplied Dusk source | Implemented role |
| --- | --- | --- |
| `substrate` | `neutral.substrate` | Navigation, inputs, capture/demo panels, feedback |
| `base` | `neutral.base` | Workspace and top bar |
| `panel` | `neutral.panel` | Focus and empty-state surfaces; secondary buttons |
| `hover` | `state.surface.hover` | Ordinary control hover |
| `pressed` | `state.surface.active` | Ordinary control active state |
| `selected` | `state.surface.selected` | Current navigation item |
| `border` | `neutral.veil` | Quiet dividers and surface boundaries |
| `input-border` | `control.input.border` / `control.button.border` | Fields and secondary controls |
| `text` | `neutral.text` | Primary reading and control labels |
| `subtext` | `neutral.subtext` | Supporting text and quiet actionable labels |
| `muted` | `neutral.muted` | Decorative separators and unavailable undo text |

### Semantic feedback

- `danger` projects `role.danger.text`; `danger-border` projects `role.danger.tint-border`. Error glyphs and relevant work-kind glyphs carry the accent; error panels retain a neutral ground.
- `warn` projects `role.warn.text`; `warn-border` projects `role.warn.tint-border`. Routine reminders and warnings use small accents and restrained boundaries, not large warning fills.

**The Neutral Area Rule.** Large surfaces stay neutral; small semantic accents identify actions and state. Color supplements labels, icons, and structure.

**The Paired Foreground Rule.** Use the supplied on-fill and on-tint pairings. Do not calculate new blends or add local fallback colors.

## Typography

**Display and body family:** the native system stack in the frontmatter. There is no separate display face, downloaded font, or monospace UI family.

I use an observed role ramp, not an invented ratio. `headline` describes default page headings; `title` describes section headings. `body` describes paragraphs at the root text size, not a universal line-height for controls. `row-title`, `label`, and `metadata` describe compact list titles, field help, and row metadata respectively.

The focused commitment has a deliberately larger title than ordinary section headings, with responsive sizing. Detail titles also have a local override. These are component treatments, not additional global typography tokens. Small prototype annotations do not establish a general-purpose body size.

Supporting paragraphs use short readable measures where needed; focus evidence caps at (65ch). Dates and counts use tabular numerals without changing font family. Sentence case and weight differentiate labels; monospace remains reserved for machine output under the supplied system.

## Layout

I record the existing desktop-first workspace, not a generic dashboard template. Its narrow navigation column frames a broad Now surface, compact ranked Next rows, and collapsed Later. Capture remains visibly reachable from every main view; demo controls remain secondary. Projects are optional drill-in context, not the landing composition.

The desktop shell pairs navigation (224px) with a flexible workspace. The centered main region caps at (1060px), including padding under the global border-box sizing rule. Rows and hairline dividers carry secondary work without repeating prominent cards. The spacing entries in the frontmatter are recurring observed steps, not a new CSS variable scale.

| Existing media condition | Layout behavior |
| --- | --- |
| At least (1500px) | More space above the main content and inside the focus surface |
| At most (1100px) | Navigation narrows to (194px); content gutters tighten |
| At most (760px) | Single-column shell; navigation becomes a horizontal scrolling row; Capture stays in the header |
| At most (460px) | Smaller gutters; secondary icons recede; metadata and control groups stack where needed |

Disclosures keep provenance, editing, ranking explanations, and later work available on demand. Work detail provides an explicit route back. These are ways to expose depth on the current problem, not reasons to add unrelated panels.

## Elevation & Depth

I use tonal layering and reserved borders for persistent depth. The substrate frames the base workspace; the focus surface sits on the panel tone. Persistent surfaces have no drop shadow. Transient feedback currently has a local shadow, but I do not promote that single recipe into a reusable elevation scale.

Primary-button hover adds an inset contrast stroke, not lift. Focus adds a visible ring without changing geometry. The sidecar preserves these component treatments rather than inventing shadow or motion tokens.

## Shapes

I retain gently rounded rectangular controls and containers. The recurring control and container radii appear in the frontmatter. Other component-specific corners do not constitute a broader radius scale.

Boundaries generally reserve a one-pixel stroke. Ordinary buttons reserve a transparent border before interaction; fields and secondary buttons show their boundary at rest. Small circular state markers support nearby text rather than becoming standalone status signals. Lists rely on separators instead of pill-shaped tiles or decorative card grids.

## Components

### Buttons

I keep primary, secondary, quiet, and icon controls visually related.

- **Primary:** fern fill with its on-fill text, stronger weight (650), and a minimum height (43px). Hover keeps the fill and adds an inset contrast stroke. Active uses the supplied tint/on-tint pair.
- **Secondary:** neutral panel fill and the stronger input border. Ordinary hover and active use the shared surface-state tokens.
- **Quiet:** supporting-text color on a transparent ground, becoming primary text on hover. Lower prominence does not remove click discovery.
- **Icon:** compact fixed-width controls with descriptive accessible names. They share the same color-only state vocabulary.
- **Disabled:** unavailable controls use neutral treatment and a not-allowed cursor. I do not derive a new accent or opacity scale.

**The In-Place State Rule.** Control states are instant: no hover translation, scaling, padding change, or newly introduced layout border.

### Inputs / Fields

I retain native input, textarea, select, and checkbox behavior. Fields use a substrate ground, primary text, visible input borders, and the shared control radius. Labels stay visible; helper text sits below. Freeform scratch notes and capture use textareas rather than decorative editors.

Keyboard focus uses a primary-colored outline (2px) with zero offset. Fields also change their border to primary. Other interactive elements receive the same visible zero-offset focus treatment. I preserve a visible replacement rather than suppressing focus.

### Navigation

I use quiet native-text buttons on the neutral sidebar. Selection combines the selected surface, primary text, a small fern glyph/marker, and `aria-current`; it never depends on hue alone. Narrow layouts preserve the labels and allow horizontal navigation scrolling.

### Containers and focused work

I keep capture, demo, and supporting panels neutral with reserved borders. The focused commitment uses the lighter panel tone and more internal space; its title and primary action establish dominance rather than an accent wash.

The focused work component presents a title, provenance, a short recommendation or active-state reason, and the relevant primary action. Active work exposes its concrete next step or ordered checklist and scratch notes. Details and sources remain a quieter drill-in action. This describes the implemented signature component, not a mandatory card template for every surface.

### Work rows and disclosures

I keep queue rows compact: a work-kind glyph, a readable title, short source/reason metadata, and a quiet explicit action. Text identifies the signal independently of glyph color. Titles wrap within the compact preview; drill-in detail retains access to the full content.

Native disclosure controls reveal supporting material without opening a competing workspace. Later starts collapsed. Disclosure state may change layout because the user explicitly requested more content; hover and focus do not.

### Feedback

I use brief, explicit success feedback with a checkmark and Undo where available. Failure regions retain neutral surfaces while presenting diagnostic text and recovery controls. Prototype and simulated-data labels remain factual; they are not decorative status badges.

## Do's and Don'ts

### Do:

- **Do** defer to the supplied Dusk theme and interaction documents before extending this application projection.
- **Do** keep large surfaces neutral and use semantic foreground pairings.
- **Do** build hierarchy with native typography, spacing, labels, and restrained emphasis.
- **Do** keep focus visible at zero offset and preserve control geometry across states.
- **Do** keep supporting detail optional and provide a clear path back.
- **Do** keep success brief and explicit, and failures diagnostic.

### Don't:

- **Don't** replace the pinned world with a new brand, webfont, or monospace interface.
- **Don't** turn the focus workspace into a dense multipanel project dashboard.
- **Don't** use full-window accent fills or color as the only state signal.
- **Don't** add decorative motion, hover lift, or scaling.
- **Don't** turn incidental measurements, unused tokens, or implementation defects into design rules.
- **Don't** invent tonal ramps, service status, or external execution that the prototype does not supply.
