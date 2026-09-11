# Theme direction: GitHub and Fox

The browser prototype uses **GitHub dark**. I chose that default to proceed with the build; it is not a user-confirmed preference over Fox.

The values are verified against Copilot App's bundled **Primer 11.10.0** semantic tokens. The [public Primer package](https://www.npmjs.com/package/@primer/primitives/v/11.10.0) supplies the underlying palette. These are UI colors, not a terminal palette or a guessed GitHub look.

Exact parity with the user's installed app release is not established. The prototype implements a small semantic projection, not Copilot App's components.

## Implemented palette

[`src/theme.css`](../src/theme.css) is the implementation authority.

| Role | GitHub dark |
| --- | --- |
| Workspace / input | `#0d1117` |
| Sidebar / subtle surface | `#151b23` |
| Control / hover | `#212830` / `#262c36` |
| Primary / secondary text | `#f0f6fc` / `#9198a1` |
| Default / muted border | `#3d444d` / `#3d444db3` |
| Emphasized control boundary | `#656c76` |
| Link / focus | `#4493f8` |
| Primary action / foreground | `#1f6feb` / `#ffffff` |
| Selected row background | `#388bfd1a` |
| Text selection / foreground | `#1f6feb` / `#ffffff` |
| Success / warning / error text | `#3fb950` / `#d29922` / `#f85149` |

Preserve alpha in the muted border and selected-row values. Do not substitute an opaque approximation.

## Fox remains a preferred alternative

The user also likes Fox in Copilot App. Its app catalog and generated color roles were located during research, but this prototype does not implement a theme switcher or claim to render Fox.

A later Fox option should use those actual app roles, not an unrelated similarly named theme. Light, high-contrast, and other variants are not part of this first browser prototype.

## Invariants

- No Dusk tokens, lavender/fern fallback, or invented named-theme values.
- Theme roles stay independent of layout, stored commitments, and source activity.
- Check contrast on rendered foreground/background pairings, including alpha surfaces.
- Labels, icons, and structure accompany color. Focus remains visible without changing geometry.

[`PRODUCT.md`](../PRODUCT.md) owns behavior. [`DESIGN.md`](../DESIGN.md) and the [Design System](Design%20System.md) own composition and accessibility constraints. Old CSS and generated sidecars remain historical, not fallback sources.
