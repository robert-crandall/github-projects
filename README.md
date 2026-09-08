# GitHub Projects

A local-first, GitHub-centric GTD app for macOS, built with Tauri 2, React, SQLite, and the GitHub Copilot SDK. The interface uses the supplied [Dusk theme](docs/theme.md).

## Run the desktop app

I use the existing GitHub CLI and Copilot sign-ins rather than an OAuth app registration.

Prerequisites:

- macOS with Xcode Command Line Tools and a current Rust toolchain.
- Bun 1.3.14 or later.
- GitHub CLI (`gh`) and Copilot CLI installed and signed in.

```bash
bun install --frozen-lockfile
bun run desktop
```

Open **Connections** to inspect executable paths and refresh GitHub. If Finder cannot locate a CLI, enter its absolute executable path there. Do not enter tokens or shell commands.

The app starts with an empty real workspace, not demo fixtures. Capture and manual edits work when GitHub or Copilot is unavailable. Failed connections remain visible.

## Build a local app

```bash
bun run desktop:build
```

The `.app` bundle is produced under `src-tauri/target/release/bundle/macos/`. Launch that bundle to enable and exercise macOS notifications; the unbundled development binary reports native reminders as unavailable.

To build and install the app in `/Applications/GitHub Projects.app`, quit GitHub Projects first, then run:

```bash
bun run install-app
```

This also updates an existing installation without changing the workspace stored in the macOS app-data directory.

The previous name was Follow through. The bundle identifier and browser storage key remain unchanged so existing work stays available. After installing GitHub Projects, the old `Follow through.app` copy can be moved to the Trash.

Signing and notarization are intentionally out of scope. Keep the installed GitHub and Copilot runtimes available; this is a personal local build, not a dependency-free distributable installer.

## How it works

- **Capture first:** original text reaches durable storage before Copilot receives it. Failed interpretation leaves the original and an editable task.
- **Now / Next / Later:** active work stays in place. Due routines remain visible; quick reviews get preference without a quota.
- **GitHub:** read-only discovery using the successful digest's direct requests, specific team requests, authored PRs, mentions, prior reviews, and assigned issues. Local decisions and notes survive refresh.
- **Copilot:** the Rust backend hosts the SDK. Typed proposals structure captures and help order up to 40 actionable items; the model does not own storage, clocks, or completion.
- **Routines:** ordered daily steps in an explicit timezone, with daylight-saving-aware calendar recurrence. Missed days become history around one outstanding occurrence, not catch-up flag increases.
- **Persistence:** SQLite in the macOS app-data directory. Writes use revision checks; failure never silently replaces existing data.
- **Recovery:** **Connections > Export backup** exports the current workspace, including pending in-memory work. Import requires no local captures, edits, or progress; automatically discovered GitHub work is retained.

No review, merge, Slack message, or flag change is performed by the app. **Open on GitHub** opens the real source in the browser; completion in GitHub Projects records a local decision.

### Reminders and app lifecycle

Closing the window keeps the app in the menu bar. Explicit **Quit** stops it and its reminders. Reopening reconciles missed time.

Enable notifications in **Connections**. The native scheduler does not depend on a visible window. It records delivery attempts separately from task completion and does not repeatedly nudge an outstanding routine.

macOS notification permissions, Focus settings, and sleep affect delivery. Due work stays in the app regardless. A previous day's completed step retains its timestamp; review the stale-progress warning before continuing a rollout.

### AI and data boundaries

Copilot receives captured text or bounded task evidence needed for a suggestion, not the full personal profile, credentials, scratch notes, or arbitrary repository files. SDK tools and permissions are restricted in the backend. **Connections > Cancel Copilot request** can stop an in-flight request without losing captured work.

Suggestions use the existing Copilot allowance. Candidate changes are debounced; note edits and idle clock ticks do not make another request. If Copilot fails, the UI says so and keeps default ordering available.

GitHub search limits and failed enrichment are surfaced. Absence from a search is not proof that a captured commitment is complete.

## Keep using the browser prototype

```bash
bun run dev
```

Open the Vite URL, normally `http://127.0.0.1:5173`. This mode retains the synthetic fixtures, simulated clock, and demo scenarios. It does not use live integrations.

Browser storage and desktop storage are separate. To move personal captures:

1. In the browser, open **Captures > Export captures for desktop**.
2. Before adding local captures or editing desktop work, open **Connections > Import backup or captures**. Automatic GitHub discovery does not block import.
3. Review the imported captures. Original text and notes remain; simulated obligations, schedules, completion, and undo history do not migrate as real work.

Keep the original browser data until the imported work is satisfactory. A complete desktop JSON backup retains desktop progress; the captures-only prototype export intentionally does not.

## Development

```bash
bun test
bun run build
bun run test:browser
cargo test --manifest-path src-tauri/Cargo.toml
```

Bun manages dependencies through `bun.lock` and runs the JavaScript tooling. `bun test` runs the unit tests in `src`; browser tests use the separate Playwright command.

Playwright covers the retained browser demo and the desktop renderer against a mock of the typed IPC contract. Rust tests cover native boundaries; a mock renderer test alone does not prove real GitHub, Copilot, or macOS notification delivery.

### Replacement boundaries

| Area | Location |
|---|---|
| React interface and semantic theme | `src/App.tsx`, `src/components/`, `src/theme.css` |
| Work transitions, undo, recurrence, merge, ranking | `src/domain/` |
| Durable write queue and integration coordination | `src/useWorkspace.ts` |
| Typed, narrow renderer/native commands | `src/desktop-contract.ts`, `src/desktop.ts` |
| Tauri host, SQLite, native scheduler, GitHub, SDK | `src-tauri/` |
| Product and interaction authority | `PRODUCT.md`, `docs/Design System.md`, `docs/theme.md` |

The browser-only [prototype prompt](docs/prototype-prompt.md) is historical scope for the demo. `PRODUCT.md` owns the live desktop requirements.
