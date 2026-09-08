# Ultra theme — Dusk

Ultra Dusk · cast Lavender 281° · temperament Zen · roles spectrum · 389 tokens

## Where this goes

- **ultra-terminal-ide, theme-builder handoff** — use the `Theme Builder` export. It is a completed `ultra-dusk-response-template.jsonc`: all 83 required authored roles, the 44 optional `aiChat`/`conversation`/`ensemble` domain roles, a 41-rule TextMate set covering every family in `syntaxTokenCoverage`, and a `derivationReview` placing all 48 calculated roles in exactly one of `acceptedDefaults` (42) or `overrides` (6, each with an explicit colour and a stated reason). No unknown role IDs, no placeholders, no compatibility aliases. Save it as the response file, then run the validation pass in `README.md`.
- **ultra-terminal-ide, direct theme file** — use the `Ultra IDE` export. Drop it at `config/themes/ultra-dusk.json` (built-in) or `~/.ultra/terminal/themes/ultra-dusk.json` (user). It emits all 44 canonical authored roles from `src/services/theme/roles.ts`, the derived roles we intentionally override, the `aiChat.*` / `conversation.*` / `ensemble.*` domain roles, `terminal.ansi*`, the flat syntax roles and the `tokenColors` array. Built-ins must resolve without emergency fallback — validate with `bun run verify:themes`, then `bun run fixture:themes --launch`. Add the provenance entry in `config/theme-provenance.json`: this palette is original, generated in OKLCH, so record it as first-party rather than an upstream revision.
- **ultra-terminal** — use the `Ultra Terminal` export. It matches `ThemeSpec` in `crates/ultra-terminal-theme/src/lib.rs` exactly: `background`, `foreground`, `cursor`, `selection`, `ansi[8]`, `brights[8]` and the seven optional `syntax_*` fields. The `WorkbenchPalette` in that crate is derived, not authored — map `surface_base` → `neutral.base`, `surface_chrome` → `neutral.substrate`, `surface_panel` → `neutral.panel`, `surface_raised` → `neutral.ridge`, `surface_selected` → `neutral.crest`, `surface_hover` → `neutral.ridge`, `border_subtle` → `neutral.veil`, `border_strong` → `neutral.rim`, `text_primary/secondary/muted` → `neutral.text/subtext/muted`, and `accent_primary/success/warning/danger/info` → `role.*.fill`.
- **Codex App** — use the `Codex App` export. Paste the `codex-theme-v1:` config string into Settings → Appearance → Import Custom Theme. Two traps: the paste must contain the config string and nothing else, and `codeThemeId` must stay `"notion"` — it names one of Codex's built-in syntax themes, not ours, and an unknown value makes Import silently grey out. Codex exposes only `accent`, `surface`, `ink`, `contrast`, `opaqueWindows` and three semantic colours, and owns syntax highlighting itself, so this is a deliberately lossy projection — never the source of truth.
- **opencode** — use the `opencode` export. Save as `~/.config/opencode/themes/ultra-dusk.json` (user-wide) or `.opencode/themes/ultra-dusk.json` (per project), then pick it with `/theme`. It is pure JSON — no comments, since opencode parses it strictly. Ultra's own values live in `defs` under a `u` prefix so no def name can collide with a theme key, and every one of the 50 theme keys is a reference rather than a literal, which makes the file legible on camera and safe to retune from one place. Requires truecolor: `echo $COLORTERM` should print `truecolor`.
- **Ultra Studio (macOS)** — use the `Swift` export, or `JSON` if you generate your own asset catalog.
- **ultra.dev** — use `CSS` or `Tailwind`.
- **Video graphics** — the `broadcast.*` group only.

## Rules an implementer must follow

1. Never ship a raw accent name. Product code names role, syntax, editor, chrome, state, diagnostic, vcs, agent or terminal tokens only.
2. Accents have two tiers. `accent.<name>` is the vivid value — use it on code surfaces (syntax, terminal, log levels) and for fills. `accent.<name>.text` is the darkened chrome tier — use it for UI label text, links and buttons, where it clears 4.5:1 on base and panel.
3. Colour on colour is always precomputed. Never draw `role.x.text` on `role.x.tint` — use `role.x.on-tint`. Never draw a raw accent on a fill — use `role.x.on-fill`.
4. `neutral.muted` is decorative only: placeholders, comments, timestamps, disabled text. Never section headings or interactive labels.
5. Broadcast tokens are for video only — chroma is clamped to 0.098 for encoders. Never use them in the UI, and never use UI tokens in video graphics.
6. Elevation runs bedrock → substrate → base → panel → ridge → crest. Hover is `state.surface.hover`, pressed is `state.surface.active`.
7. The generic groups below are the source of truth for values; the two native exports are projections of them. If a value must change, change it here and re-export — do not hand-edit a theme file.
8. Components must not carry local fallback colours. The IDE resolves every role once through `ThemeCatalog`; a component-level default silently defeats that policy.
9. **Saturation scales inversely with area.** A vivid accent is legitimate on a glyph, a 1–3px rule, a badge, a small icon or a text run. Anything that spans a full edge of the window — status bar, toolbar, sidebar, header, footer, tab strip, empty state — takes a neutral surface (`neutral.panel` or `neutral.substrate`) with a `*.border` hairline, and earns its identity from one small tinted item inside it. Persistent chrome must never be a full-bleed accent fill: it is the largest thing on screen and the least informative, so it dominates the interface it is supposed to frame and drags every eye off the code. When a large region genuinely must read as coloured, use the accent's tint (12–14% over base), never the fill.
10. Fills are for elements the user acts on right now — buttons, active toggles, selected rows, alert badges. If an element is not actionable and not transient, it does not get a fill.

## Construction

- Neutral hue 281° (Lavender), one hue for every surface and border.
- Temperament Zen: tinted ground, warm-neutral text.
- Role strategy `spectrum`: Every role owns a hue outright. Maximum legibility of intent, busiest surface.
- Accents are measured from Catppuccin Frappé in OKLCH, per hue — not generated from a single formula.

## Tokens

### Neutral

| token | value |
| --- | --- |
| `neutral.bedrock` | `#282935` |
| `neutral.substrate` | `#30313d` |
| `neutral.base` | `#393a47` |
| `neutral.panel` | `#464653` |
| `neutral.ridge` | `#51505d` |
| `neutral.crest` | `#5c5966` |
| `neutral.veil` | `#6c6673` |
| `neutral.rim` | `#7e7480` |
| `neutral.halo` | `#91848d` |
| `neutral.muted` | `#a7979c` |
| `neutral.subtext` | `#cabab7` |
| `neutral.text` | `#e6dbd1` |

### Accent

| token | value |
| --- | --- |
| `accent.ember` | `#ef8a8b` |
| `accent.ember.bright` | `#fd9f9f` |
| `accent.ember.text` | `#fd9b9b` |
| `accent.quartz` | `#f094a2` |
| `accent.quartz.bright` | `#fea9b6` |
| `accent.quartz.text` | `#f89caa` |
| `accent.copper` | `#fba37e` |
| `accent.copper.bright` | `#febda2` |
| `accent.copper.text` | `#fba37e` |
| `accent.brass` | `#eed198` |
| `accent.brass.bright` | `#fee4b0` |
| `accent.brass.text` | `#eed198` |
| `accent.fern` | `#add991` |
| `accent.fern.bright` | `#bded9f` |
| `accent.fern.text` | `#add991` |
| `accent.jade` | `#88d0c6` |
| `accent.jade.bright` | `#97e3d8` |
| `accent.jade.text` | `#88d0c6` |
| `accent.glacier` | `#92d3da` |
| `accent.glacier.bright` | `#a1e6ee` |
| `accent.glacier.text` | `#92d3da` |
| `accent.azure` | `#8ec8eb` |
| `accent.azure.bright` | `#a0dafe` |
| `accent.azure.text` | `#8ec8eb` |
| `accent.cobalt` | `#92b3f7` |
| `accent.cobalt.bright` | `#aac6fd` |
| `accent.cobalt.text` | `#96b7fb` |
| `accent.orchid` | `#c0abf5` |
| `accent.orchid.bright` | `#d0bffe` |
| `accent.orchid.text` | `#c0abf5` |
| `accent.blossom` | `#eba3d6` |
| `accent.blossom.bright` | `#feb5e8` |
| `accent.blossom.text` | `#eba3d6` |

### Role

| token | value |
| --- | --- |
| `role.primary.fill` | `#add991` |
| `role.primary.on-fill` | `#282935` |
| `role.primary.tint` | `#484f51` |
| `role.primary.tint-border` | `#607060` |
| `role.primary.on-tint` | `#add991` |
| `role.primary.outline` | `#758d6d` |
| `role.primary.text` | `#add991` |
| `role.confirm.fill` | `#add991` |
| `role.confirm.on-fill` | `#282935` |
| `role.confirm.tint` | `#484f51` |
| `role.confirm.tint-border` | `#607060` |
| `role.confirm.on-tint` | `#add991` |
| `role.confirm.outline` | `#758d6d` |
| `role.confirm.text` | `#add991` |
| `role.secondary.fill` | `#92b3f7` |
| `role.secondary.on-fill` | `#282935` |
| `role.secondary.tint` | `#454a5e` |
| `role.secondary.tint-border` | `#576383` |
| `role.secondary.on-tint` | `#a1befb` |
| `role.secondary.outline` | `#697ba5` |
| `role.secondary.text` | `#96b7fb` |
| `role.info.fill` | `#92d3da` |
| `role.info.on-fill` | `#282935` |
| `role.info.tint` | `#454e5a` |
| `role.info.tint-border` | `#576e79` |
| `role.info.on-tint` | `#92d3da` |
| `role.info.outline` | `#678a93` |
| `role.info.text` | `#92d3da` |
| `role.cancel.fill` | `#5c5966` |
| `role.cancel.on-fill` | `#e6dbd1` |
| `role.cancel.tint` | `#51505d` |
| `role.cancel.tint-border` | `#7e7480` |
| `role.cancel.on-tint` | `#cabab7` |
| `role.cancel.outline` | `#7e7480` |
| `role.cancel.text` | `#cabab7` |
| `role.danger.fill` | `#ef8a8b` |
| `role.danger.on-fill` | `#282935` |
| `role.danger.tint` | `#514450` |
| `role.danger.tint-border` | `#77555e` |
| `role.danger.on-tint` | `#fd9b9b` |
| `role.danger.outline` | `#9f6c73` |
| `role.danger.text` | `#fd9b9b` |
| `role.warn.fill` | `#eed198` |
| `role.warn.on-fill` | `#282935` |
| `role.warn.tint` | `#514e52` |
| `role.warn.tint-border` | `#776d63` |
| `role.warn.on-tint` | `#eed198` |
| `role.warn.outline` | `#978971` |
| `role.warn.text` | `#eed198` |
| `role.agent.fill` | `#c0abf5` |
| `role.agent.on-fill` | `#282935` |
| `role.agent.tint` | `#4b495e` |
| `role.agent.tint-border` | `#676082` |
| `role.agent.on-tint` | `#c6b3f6` |
| `role.agent.outline` | `#7f75a1` |
| `role.agent.text` | `#c0abf5` |
| `role.tool.fill` | `#8ec8eb` |
| `role.tool.on-fill` | `#282935` |
| `role.tool.tint` | `#444c5c` |
| `role.tool.tint-border` | `#566a7f` |
| `role.tool.on-tint` | `#8ec8eb` |
| `role.tool.outline` | `#65849c` |
| `role.tool.text` | `#8ec8eb` |

### Syntax

| token | value |
| --- | --- |
| `syntax.comment` | `#a7979c` · italic |
| `syntax.comment.doc` | `#cabab7` · italic |
| `syntax.keyword` | `#c0abf5` |
| `syntax.keyword.control` | `#c0abf5` |
| `syntax.keyword.operator` | `#88d0c6` |
| `syntax.storage` | `#c0abf5` |
| `syntax.storage.modifier` | `#c0abf5` |
| `syntax.string` | `#add991` |
| `syntax.string.escape` | `#88d0c6` |
| `syntax.string.regex` | `#eba3d6` |
| `syntax.number` | `#fba37e` |
| `syntax.boolean` | `#fba37e` |
| `syntax.constant` | `#fba37e` |
| `syntax.constant.builtin` | `#fba37e` |
| `syntax.variable` | `#e6dbd1` |
| `syntax.variable.parameter` | `#eba3d6` · italic |
| `syntax.variable.property` | `#92d3da` |
| `syntax.variable.builtin` | `#f094a2` |
| `syntax.function` | `#8ec8eb` |
| `syntax.function.method` | `#8ec8eb` |
| `syntax.function.builtin` | `#8ec8eb` |
| `syntax.function.macro` | `#f094a2` |
| `syntax.type` | `#eed198` |
| `syntax.type.builtin` | `#eed198` |
| `syntax.class` | `#eed198` |
| `syntax.interface` | `#eed198` |
| `syntax.enum` | `#eed198` |
| `syntax.namespace` | `#92b3f7` |
| `syntax.decorator` | `#f094a2` |
| `syntax.tag` | `#92b3f7` |
| `syntax.tag.attribute` | `#eed198` |
| `syntax.punctuation` | `#cabab7` |
| `syntax.punctuation.bracket` | `#cabab7` |
| `syntax.punctuation.delimiter` | `#cabab7` |
| `syntax.operator` | `#88d0c6` |
| `syntax.invalid` | `#ef8a8b` · underline |
| `syntax.deprecated` | `#f094a2` · strikethrough |
| `syntax.markup.heading` | `#92b3f7` · bold |
| `syntax.markup.link` | `#92d3da` · underline |
| `syntax.markup.code` | `#add991` |
| `syntax.markup.quote` | `#cabab7` |

### Editor

| token | value |
| --- | --- |
| `editor.background` | `#393a47` |
| `editor.foreground` | `#e6dbd1` |
| `editor.cursor` | `#c0abf5` |
| `editor.cursor.secondary` | `#add991` |
| `editor.selection` | `#4d4b61` |
| `editor.selection.inactive` | `#51505d` |
| `editor.on-selection` | `#fbac8b` |
| `editor.line.highlight` | `#30313d` |
| `editor.line.number` | `#a7979c` |
| `editor.line.number.active` | `#c0abf5` |
| `editor.indent.guide` | `#6c6673` |
| `editor.indent.guide.active` | `#7e7480` |
| `editor.bracket.match` | `#91848d` |
| `editor.bracket.mismatch` | `#ef8a8b` |
| `editor.search.match` | `#615b59` |
| `editor.search.match.active` | `#7b5e5a` |
| `editor.word.highlight` | `#5c5966` |
| `editor.whitespace` | `#6c6673` |
| `editor.ruler` | `#6c6673` |
| `editor.fold.placeholder` | `#a7979c` |
| `editor.scrollbar.thumb` | `#7e7480` |
| `editor.scrollbar.thumb.hover` | `#91848d` |
| `editor.minimap.background` | `#30313d` |

### Chrome

| token | value |
| --- | --- |
| `chrome.panel.background` | `#464653` |
| `chrome.panel.border` | `#6c6673` |
| `chrome.sidebar.background` | `#30313d` |
| `chrome.sidebar.foreground` | `#cabab7` |
| `chrome.tab.active.background` | `#393a47` |
| `chrome.tab.active.foreground` | `#e6dbd1` |
| `chrome.tab.active.border` | `#c0abf5` |
| `chrome.tab.inactive.background` | `#30313d` |
| `chrome.tab.inactive.foreground` | `#a7979c` |
| `chrome.tab.modified` | `#eed198` |
| `chrome.statusbar.background` | `#464653` |
| `chrome.statusbar.foreground` | `#cabab7` |
| `chrome.statusbar.border` | `#a19aa2` |
| `chrome.statusbar.item-hover-background` | `#51505d` |
| `chrome.statusbar.item-hover-foreground` | `#e6dbd1` |
| `chrome.statusbar.mode-background` | `#49485c` |
| `chrome.statusbar.mode-foreground` | `#c6b3f6` |
| `chrome.statusbar.mode-border` | `#9b97ad` |
| `chrome.titlebar.background` | `#464653` |
| `chrome.breadcrumb.foreground` | `#a7979c` |
| `chrome.breadcrumb.active` | `#e6dbd1` |
| `chrome.overlay.scrim` | `rgba(0,0,0,0.55)` |
| `chrome.scrollbar.track` | `#30313d` |
| `chrome.scrollbar.thumb` | `#8b828d` |
| `chrome.scrollbar.thumb-hover` | `#91848d` |
| `chrome.scrollbar.thumb-active` | `#cabab7` |
| `chrome.pane.background` | `#464653` |
| `chrome.pane.background-focused` | `#393a47` |
| `chrome.pane.border` | `#a19aa2` |
| `chrome.pane.divider` | `#a19aa2` |
| `chrome.pane.divider-hover` | `#afa5ab` |
| `chrome.pane.divider-active` | `#c0abf5` |
| `chrome.drawer.background` | `#282935` |
| `chrome.drawer.foreground` | `#e6dbd1` |
| `chrome.drawer.border` | `#7e7480` |
| `chrome.menu.background` | `#282935` |
| `chrome.menu.foreground` | `#e6dbd1` |
| `chrome.menu.border` | `#7e7480` |
| `chrome.menu.separator` | `#7b7581` |
| `chrome.menu.item-hover-background` | `#51505d` |
| `chrome.menu.item-hover-foreground` | `#e6dbd1` |
| `chrome.menu.item-hover-meta` | `#cfc1be` |
| `chrome.menu.item-meta` | `#cabab7` |
| `chrome.menu.item-selected-meta` | `#cabab7` |
| `chrome.menu.item-selected-background` | `#49485c` |
| `chrome.menu.item-selected-foreground` | `#c6b3f6` |
| `chrome.menu.item-disabled-foreground` | `#837679` |
| `chrome.popover.background` | `#282935` |
| `chrome.popover.foreground` | `#e6dbd1` |
| `chrome.popover.border` | `#7e7480` |
| `chrome.tooltip.background` | `#5c5966` |
| `chrome.tooltip.foreground` | `#e6dbd1` |
| `chrome.tooltip.border` | `#b3adb3` |
| `chrome.dialog.background` | `#464653` |
| `chrome.dialog.foreground` | `#e6dbd1` |
| `chrome.dialog.border` | `#a19aa2` |
| `chrome.toast.background` | `#5c5966` |
| `chrome.toast.foreground` | `#e6dbd1` |
| `chrome.toast.secondary-foreground` | `#dcd2d0` |
| `chrome.toast.border` | `#b3adb3` |
| `chrome.shadow.drawer` | `rgba(0,0,0,0.42)` |
| `chrome.shadow.popover` | `rgba(0,0,0,0.5)` |
| `chrome.shadow.dialog` | `rgba(0,0,0,0.62)` |
| `chrome.shadow.toast` | `rgba(0,0,0,0.48)` |
| `chrome.shadow.tooltip` | `rgba(0,0,0,0.38)` |
| `chrome.tab.hover.background` | `#51505d` |
| `chrome.tab.pressed.background` | `#5c5966` |
| `chrome.tab.focus.border` | `#c0abf5` |
| `chrome.tab.drop-indicator` | `#c0abf5` |
| `chrome.tab.drag-preview.background` | `#464653` |
| `chrome.tab.drag-preview.border` | `#9c9098` |

### Control

| token | value |
| --- | --- |
| `control.input.background` | `#30313d` |
| `control.input.foreground` | `#e6dbd1` |
| `control.input.placeholder` | `#a7979c` |
| `control.input.icon` | `#cabab7` |
| `control.input.border` | `#8b828d` |
| `control.input.border-hover` | `#91848d` |
| `control.input.border-focused` | `#c0abf5` |
| `control.input.disabled-background` | `#353642` |
| `control.input.disabled-foreground` | `#8e8084` |
| `control.input.disabled-border` | `#6c6673` |
| `control.button.background` | `#464653` |
| `control.button.foreground` | `#e6dbd1` |
| `control.button.border` | `#8b828d` |
| `control.button.hover-background` | `#51505d` |
| `control.button.hover-border` | `#afa5ab` |
| `control.button.pressed-background` | `#5c5966` |
| `control.button.pressed-border` | `#b7aeb3` |
| `control.button.selected-background` | `#49485c` |
| `control.button.selected-foreground` | `#c6b3f6` |
| `control.button.selected-border` | `#908ba4` |
| `control.button.disabled-background` | `#40414e` |
| `control.button.disabled-foreground` | `#9a8b90` |
| `control.button.disabled-border` | `#6c6673` |
| `control.segmented.track-background` | `#30313d` |
| `control.segmented.track-border` | `#8b828d` |
| `control.segmented.inactive-background` | `rgba(0,0,0,0)` |
| `control.segmented.inactive-foreground` | `#cabab7` |
| `control.segmented.inactive-border` | `rgba(0,0,0,0)` |
| `control.segmented.active-background` | `#49485c` |
| `control.segmented.active-foreground` | `#c6b3f6` |
| `control.segmented.active-border` | `#847e9a` |
| `control.segmented.hover-background` | `#51505d` |
| `control.segmented.hover-foreground` | `#cfc1be` |
| `control.segmented.disabled-foreground` | `#837679` |

### State

| token | value |
| --- | --- |
| `state.surface.hover` | `#51505d` |
| `state.surface.active` | `#5c5966` |
| `state.surface.selected` | `#4d4b61` |
| `state.on-surface-hover` | `#e6dbd1` |
| `state.on-surface-hover-meta` | `#cfc1be` |
| `state.on-surface-active` | `#e6dbd1` |
| `state.on-surface-active-meta` | `#dcd2d0` |
| `state.on-surface-selected` | `#e6dbd1` |
| `state.on-surface-selected-meta` | `#cfc1be` |
| `state.border.default` | `#7e7480` |
| `state.border.strong` | `#91848d` |
| `state.focus.ring` | `#91848d` |
| `state.focus.halo` | `#57536d` |
| `state.disabled.foreground` | `#a7979c` |
| `state.disabled.background` | `#30313d` |
| `state.disabled.border` | `#6c6673` |
| `state.link` | `#92d3da` |
| `state.link.hover` | `#92d3da` |
| `state.text-selection` | `#5c5774` |
| `state.text-on-selection` | `#e6dbd1` |

### Diagnostic

| token | value |
| --- | --- |
| `diagnostic.error.foreground` | `#fd9b9b` |
| `diagnostic.error.background` | `#514450` |
| `diagnostic.error.squiggle` | `#ef8a8b` |
| `diagnostic.warning.foreground` | `#eed198` |
| `diagnostic.warning.background` | `#514e52` |
| `diagnostic.warning.squiggle` | `#eed198` |
| `diagnostic.info.foreground` | `#92d3da` |
| `diagnostic.info.background` | `#454e5a` |
| `diagnostic.info.squiggle` | `#92d3da` |
| `diagnostic.hint.foreground` | `#88d0c6` |
| `diagnostic.hint.background` | `#434e58` |
| `diagnostic.hint.squiggle` | `#88d0c6` |

### Version control

| token | value |
| --- | --- |
| `vcs.added.foreground` | `#add991` |
| `vcs.added.background` | `#4c5353` |
| `vcs.added.gutter` | `#add991` |
| `vcs.removed.foreground` | `#f3aaaa` |
| `vcs.removed.background` | `#564752` |
| `vcs.removed.gutter` | `#ef8a8b` |
| `vcs.modified.foreground` | `#eed198` |
| `vcs.modified.background` | `#545153` |
| `vcs.modified.gutter` | `#eed198` |
| `vcs.conflict.foreground` | `#c0abf5` |
| `vcs.conflict.background` | `#4c4a5f` |
| `vcs.staged` | `#add991` |
| `vcs.untracked` | `#92d3da` |
| `vcs.ignored` | `#a7979c` |
| `vcs.renamed` | `#92b3f7` |
| `vcs.stash` | `#c0abf5` |

### Agent

| token | value |
| --- | --- |
| `agent.thinking.background` | `#434254` |
| `agent.thinking.border` | `#57536d` |
| `agent.thinking.foreground` | `#c8b7c5` |
| `agent.thinking.label` | `#c0abf5` |
| `agent.message.user.background` | `#464653` |
| `agent.message.user.foreground` | `#e6dbd1` |
| `agent.message.assistant.foreground` | `#e6dbd1` |
| `agent.message.assistant.label` | `#c0abf5` |
| `agent.tool.background` | `#3f4452` |
| `agent.tool.border` | `#4d5c6e` |
| `agent.tool.name` | `#8ec8eb` |
| `agent.tool.result` | `#cabab7` |
| `agent.gate.background` | `#4d4b50` |
| `agent.gate.border` | `#6f675f` |
| `agent.gate.label` | `#eed198` |
| `agent.gate.path` | `#fbac8b` |
| `agent.plan.done` | `#add991` |
| `agent.plan.active` | `#8ec8eb` |
| `agent.plan.blocked` | `#eed198` |
| `agent.plan.queued` | `#a7979c` |
| `agent.meter.thinking` | `#c0abf5` |
| `agent.meter.tool` | `#8ec8eb` |
| `agent.meter.message` | `#add991` |

### Terminal

| token | value |
| --- | --- |
| `terminal.background` | `#393a47` |
| `terminal.foreground` | `#e6dbd1` |
| `terminal.cursor` | `#c0abf5` |
| `terminal.selection` | `#4d4b61` |
| `terminal.ansi.black` | `#5c5966` |
| `terminal.ansi.red` | `#ef8a8b` |
| `terminal.ansi.green` | `#add991` |
| `terminal.ansi.yellow` | `#eed198` |
| `terminal.ansi.blue` | `#8ec8eb` |
| `terminal.ansi.magenta` | `#c0abf5` |
| `terminal.ansi.cyan` | `#92d3da` |
| `terminal.ansi.white` | `#cabab7` |
| `terminal.ansi.bright-black` | `#91848d` |
| `terminal.ansi.bright-red` | `#fd9f9f` |
| `terminal.ansi.bright-green` | `#bded9f` |
| `terminal.ansi.bright-yellow` | `#fee4b0` |
| `terminal.ansi.bright-blue` | `#a0dafe` |
| `terminal.ansi.bright-magenta` | `#d0bffe` |
| `terminal.ansi.bright-cyan` | `#a1e6ee` |
| `terminal.ansi.bright-white` | `#e6dbd1` |

### Broadcast

| token | value |
| --- | --- |
| `broadcast.background` | `#0b0c18` |
| `broadcast.foreground` | `#f1f2ff` |
| `broadcast.subtext` | `#babcd1` |
| `broadcast.muted` | `#8e90a6` |
| `broadcast.scrim` | `rgba(0,0,0,0.62)` |
| `broadcast.brand` | `#c9b6fa` |
| `broadcast.brand.secondary` | `#b9e2a0` |
| `broadcast.danger` | `#ed9b9b` |
| `broadcast.on-danger` | `#0b0b0b` |
| `broadcast.on-brand` | `#0b0b0b` |
| `broadcast.accent.ember` | `#ed9b9b` |
| `broadcast.accent.quartz` | `#f4a2ae` |
| `broadcast.accent.copper` | `#fcb192` |
| `broadcast.accent.brass` | `#f5dba6` |
| `broadcast.accent.fern` | `#b9e2a0` |
| `broadcast.accent.jade` | `#97d9cf` |
| `broadcast.accent.glacier` | `#a0dbe2` |
| `broadcast.accent.azure` | `#9cd1f2` |
| `broadcast.accent.cobalt` | `#9ebdfc` |
| `broadcast.accent.orchid` | `#c9b6fa` |
| `broadcast.accent.blossom` | `#f1afdd` |
