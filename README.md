# GitHub Projects

A local-first macOS workspace for GitHub notifications, local commitments, and a stable working context. Selecting an item inspects it; **Work on this** chooses it. New GitHub activity arrives only when you click **Refresh**.

The desktop uses the approved GitHub-dark interface, real GitHub evidence, restricted Copilot SDK previews, SQLite, and native reminders. The separate browser prototype remains runnable with synthetic data.

## Run the desktop

Build prerequisites: macOS 12 or later, Xcode Command Line Tools, a Rust toolchain, and [Bun 1.3.14](https://bun.sh/). Install both locked dependency sets:

```bash
bun install --frozen-lockfile
(cd service && bun install --frozen-lockfile)
bun run native:dev
```

Development uses `127.0.0.1:1420`. `bun run dev:desktop` alone is only the renderer; it cannot read SQLite without Tauri.

For the standalone app:

```bash
bun run native:build
open "src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app"
```

The build compiles a target-specific standalone service and includes it inside the app. The app does not require Bun, Node, `node_modules`, or the repository at runtime. Apple Silicon and Intel service targets are supported; actual bundle/authentication validation ran on Apple Silicon.

The bundle is ad-hoc signed for local use, **not notarized for distribution**. Native permission checks require the bundle rather than the standalone development executable.

### Connections and authentication

Local capture, notes, Later, routines, completion, and deterministic priority rules work without authentication.

For GitHub and SDK features, install executable `gh` and `copilot`, sign in with `gh auth login --hostname github.com`, and use an account with Copilot access. The backend discovers these CLIs through absolute PATH entries and standard install directories, including `~/.local/bin`. It never exposes tokens to the renderer.

GitHub notifications require classic `notifications` or `repo` scope. Private source evidence needs `repo`; confirmed team membership needs `read:org` or its parent scopes. Organization access may also require SSO authorization. Unsupported authentication, absent CLIs, missing scopes, SDK failures, and partial source coverage are explicit errors, not demo fallbacks.

Use **Connections → Check connections** to check prerequisites. It does not fetch notifications. Startup, focus, clock ticks, navigation, and reconnect do not call GitHub or the SDK.

### Daily use

1. **Capture** preserves the original text locally. Optional interpretation waits for a successful save, then opens an editable SDK proposal.
2. **Refresh** brings in one bounded batch without replacing notes, selection, Done, or Working on changed while the request was running.
3. **Triage with Copilot** and **Reconsider order** show suggestions before applying anything. The preview names its bounded scope. Omitted rows survive; local rules keep due commitments and confirmed requests ahead of informational activity.
4. **Done** completes only the local action. **Done on GitHub** and **Unsubscribe** require confirmation and a saved operation intent before dispatch.
5. **Review in Copilot** or **Open in Copilot** requests a typed native handoff. Dispatch is not proof that a session was created or work finished.

Only current, unhandled request evidence creates a new request candidate. Sticky notification reasons, new commits, comments, and merge-queue updates do not reopen a finished review. Partial or omitted history remains uncertain; missing notifications never delete retained work.

SDK triage sends bounded source evidence, not scratch notes or the workspace. Reconsider sends minimal titles/categories/evidence IDs. Capture interpretation sends the selected original text. No suggestion starts, completes, acknowledges, or unsubscribes work automatically. **Use local priority rules** remains an explicitly non-AI alternative.

## Local storage, recovery, and reminders

The desktop starts empty after reading SQLite. It never opens browser storage, fixtures, or the previous app's database. Its identifier and data namespace are `io.robertcrandall.github-projects-workspace`:

```text
~/Library/Application Support/io.robertcrandall.github-projects-workspace/
```

SQLite saves workspace state and derived reminder schedules atomically. **Saved on this Mac** appears only after the newest queued changes persist. Conflicts and failed saves retain pending work rather than overwriting another revision. **Backups & recovery** provides pending-copy export, preservation of database files, and explicitly confirmed backup recovery. Recovery never silently resets corrupt data.

Unconfirmed GitHub writes remain visible and explicitly retryable after relaunch. They never replay automatically. A timeout or interrupted process may follow a successful remote write; check GitHub or retry explicitly rather than treating it as success.

Closing hides the existing window and keeps the native clock and saved schedules running. **Show GitHub Projects** returns that window; **Quit GitHub Projects** stops scheduling and the owned service process group. No notification permission prompt appears until **Enable reminders** is clicked.

Native reminder delivery does not depend on a hidden webview timer. Routines reconcile the actual clock, preserve completed step timestamps, and coalesce missed days into one outstanding occurrence. Snooze preserves the original occurrence identity. Active work is excluded from reminders.

Sleep, Focus, denied permission, and macOS presentation settings can delay or suppress an alert. Uncertain delivery requires explicit retry, which may duplicate an alert. Reminders use generic text, never private notes or action titles.

## Run the isolated browser prototype

```bash
bun run dev
```

Open `http://127.0.0.1:5173`. This entry uses an isolated browser storage key, synthetic source events, simulated GitHub/Copilot destinations, and a demo clock. It never calls the native backend. **Demo scenarios** includes merge queue, re-request, Later, missed days, and simulated failures.

## Validation

```bash
bun run test
bun run test:browser
bun run build
bun run build:desktop
bun run test:native
(cd service && bun run typecheck && bun run build arm64 && bun test)
bun run native:build
codesign --verify --deep --strict \
  "src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app"
```

The browser suite covers both the prototype and the actual desktop entry with mocked Tauri IPC. If Chromium is missing, run `bunx playwright install chromium`. Tests never perform live GitHub writes or request reminder permission.

The packaged executable provides non-prompting native smoke checks:

```bash
app="$PWD/src-tauri/target/release/bundle/macos/GitHub Projects Workspace.app/Contents/MacOS/github-projects-workspace"
"$app" --native-smoke-check
session=$(uuidgen)
"$app" --native-ui-smoke-check --integration-smoke-session "$session"
"$app" --native-ui-smoke-relaunch --integration-smoke-session "$session"
```

These use generated TEST directories, not app data. They check SQLite, actual permission status, renderer capture/notes/Working on, hidden native ticks, Show, and a separate process relaunch. The relaunch command removes that test session; a standalone UI smoke without a session flag cleans up after itself.

`--integration-service-smoke-check` explicitly performs a tiny synthetic SDK inference and a bounded read-only GitHub refresh through the packaged native host. It consumes Copilot service access and must not run as an automatic test. `--integration-read-smoke-check` performs only the read-only refresh. Both use private TEST directories and report counts/status, never source bodies or tokens.

## Architecture and limits

- [PRODUCT.md](PRODUCT.md) defines behavior; [DESIGN.md](DESIGN.md) and [theme.md](docs/theme.md) define the approved interface.
- [Native integration contract](src/platform/README.md) documents SQLite revisions, recovery, reminders, destinations, and owned process hosting.
- [Service contract](service/README.md) documents auth, exact endpoints, source coverage, SDK isolation, and bounded JSONL transport.

GitHub refresh is a bounded view of notifications and REST timeline evidence, not full repository synchronization. Inline review threads and all historical revisions are not fetched. The service is capability-restricted but not an operating-system sandbox. External Copilot App launching is separate from SDK previews.
