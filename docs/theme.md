# Theme support

**Settings → Appearance** offers all 57 named themes in the Copilot App catalog inspected on September 17, 2026. GitHub and Fox are included. Open **Settings** from the sidebar.

Theme and color mode are independent. **Light** and **Dark** select that palette; **System** follows the operating system while the app is open. A theme with only one palette uses its available palette and labels that limitation. GitHub dark remains the default for existing behavior.

Changes apply immediately, without submitting or discarding unsaved source settings. The task list, details, dialogs, reader, inputs, selection colors and native window appearance use the same selection. The saved palette is applied before React mounts.

## Palette sources

[`src/themes/catalog.json`](../src/themes/catalog.json) is a generated, compact projection of Copilot App's named themes into this app's semantic roles. It contains colors, not Copilot App components or runtime code.

- **GitHub:** [Primer primitives 11.10.0](https://www.npmjs.com/package/@primer/primitives/v/11.10.0) light and dark semantic tokens. The dark projection preserves every existing value in `src/theme.css`, including alpha values.
- **Other themes:** the catalog's background, foreground and ANSI seeds, with Copilot App's default 12-step Lab/ease-in-out ramps and 18% blue tint for neutral controls, generated using [Rampa SDK 5.0.0](https://www.npmjs.com/package/@basiclines/rampa-sdk/v/5.0.0).

This is not pixel-for-pixel parity with every Copilot App surface. The projection uses this app's controls and roles. External palettes adjust low-contrast foregrounds and control surfaces to keep text at 4.5:1 and input boundaries at 3:1. GitHub light slightly darkens warning and success text on selected surfaces; GitHub dark preserves the incumbent palette, including its existing lower-contrast danger controls. Primary actions keep a stable background on hover; external-theme text selection uses the readable foreground over the theme background in reverse. Copilot App's dim, high-contrast and colorblind variants are not included.

Regenerate from a local Copilot App checkout:

```bash
bun run themes:import ~/repos/copilot-app/src/lib/themes/themes.json
```

The importer validates its source and uses pinned development dependencies. Normal builds and the installed app need neither that checkout nor a color-generation engine. Review the generated catalog diff when importing a later catalog.

## Persistence and recovery

Desktop preferences live in `appearance.json` inside the app data directory. Native writes are atomic and serialized; the desktop never reads browser storage.

Preferences stay separate from workspace snapshots, task settings, credentials, source collection and backups. Theme changes never contact GitHub or Copilot.

An unreadable preference or an unavailable theme leaves the app usable in GitHub dark and shows an error without overwriting the original selection. **Retry appearance** rereads it. Selecting a theme explicitly replaces it. Failed writes leave the new theme visible but explicitly unsaved, with a retry. Native appearance errors are reported separately from persistence errors.

## Invariants

- Use semantic roles rather than hardcoded component colors.
- Apply the saved choice before rendering app content.
- System changes must not rewrite the saved preference or pin the native window to an explicit mode.
- A slow save must never overwrite a newer selection.
- Keep focus visible, native controls readable, and layouts unchanged across themes.
- Labels and icons accompany status colors.
