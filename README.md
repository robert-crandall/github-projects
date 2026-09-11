# GitHub Projects

A browser prototype for GitHub notifications, local commitments, and a stable working context. Selecting an item inspects it; **Work on this** chooses it. New activity only arrives when you click **Refresh**.

## Run the prototype

Use [Bun](https://bun.sh/):

```bash
bun install --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:5173`. The app saves work in this browser using a new, isolated storage key. It does not read or migrate the previous app's data.

The prototype defaults to **GitHub dark**, using verified Copilot App UI colors from its bundled Primer tokens. Fox remains an alternative reference; this build does not include a theme switcher.

## Try the defining interaction

1. Choose a review with **Work on this** and leave a note.
2. Try **Review in Copilot**, then return and mark your action **Done**.
3. In **Demo scenarios**, stage **PR enters the merge queue**.
4. Click **Refresh**. The review remains finished.
5. Stage **Review is requested again** and refresh to see a genuinely new request.

Demo scenarios also cover Later reminders, missed routine days, sticky notification reasons, acknowledgement, unsubscribe, and failures. Capture arbitrary text first; interpretation is a separate, explicitly simulated step.

## Integration boundary

All repositories, people, notifications, and source events are synthetic. GitHub actions and Copilot handoffs open simulations; they never visit fixture URLs or execute external actions. The clock and reminder delivery are simulated too.

The browser build does not use the desktop backend, live GitHub authentication and notifications, Copilot SDK, native reminders, or real Copilot App launching.

The Copilot SDK remains required for the desktop app, including notification triage, capture interpretation, and prioritization. The prototype previews that assistance with deterministic sample rules. Handing a review to Copilot App is a separate capability.

The prototype reports storage errors and retains pending work in memory. Use the error banner to retry, export a copy, or back up the saved copy before replacing it. Local Undo never reverses a simulated GitHub write.

## Native foundation

The separate Tauri 2 shell provides SQLite persistence, validated GitHub/Copilot launching, a menu-bar lifecycle, and native local reminders. It starts empty. The approved workspace interface, GitHub service, and Copilot SDK are **not connected to this shell yet**; the browser prototype remains separate and runnable.

```bash
bun install --frozen-lockfile
bun run native:dev
bun run native:build
```

Native development uses `127.0.0.1:1420`, not the prototype's port. The macOS bundle is `src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app`, ad-hoc signed for local use (not notarized for distribution). Native notification permission checks require this bundle, not the standalone development binary. Nothing requests permission until **Enable reminders** is clicked.

The new identifier is `io.robertcrandall.github-projects-workspace`. SQLite and local backups live only in `~/Library/Application Support/io.robertcrandall.github-projects-workspace/`; the previous app's data and browser storage are never opened.

Closing hides the existing window and keeps the native clock running. **Show GitHub Projects** returns that window; **Quit GitHub Projects** stops the process. Saved schedules run in Rust even when the webview is hidden. Sleep, Focus, and denied permission can prevent presentation. A notification or external launch receipt confirms OS acceptance, not delivery or completion.

See [the native integration contract](src/platform/README.md) for versioned snapshots, revision conflicts, backups/recovery, reminder projection, errors, and remaining integration work.

## Development

```bash
bun run test
bun run build
bun run test:browser
bun run test:native
```

The browser suite requires Playwright's Chromium. If it is not installed, run `bunx playwright install chromium`.

The built application includes non-prompting smoke checks. Both create disposable isolated workspaces, never use saved user state, and make no GitHub calls:

```bash
"src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app/Contents/MacOS/github-projects-workspace" --native-smoke-check
"src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app/Contents/MacOS/github-projects-workspace" --native-ui-smoke-check
```

The first checks SQLite and actual macOS permission status. The second opens the foundation window, verifies renderer IPC, closes it, observes the hidden native clock, shows the same window, and quits. It does not request notification permission or dispatch a notification.

## Product and design

1. Read [PRODUCT.md](PRODUCT.md) for the approved behavior and acceptance scenarios.
2. Read [the prototype brief](docs/prototype-prompt.md) for the browser scope.
3. Use [DESIGN.md](DESIGN.md) for composition and [theme.md](docs/theme.md) for the Fox and GitHub theme references.

The domain engine, synthetic source events, storage adapter, and interface are separate. The old application and its database schema have not been restored.
