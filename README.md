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

The desktop backend, live GitHub authentication and notifications, Copilot SDK, native reminders, and real Copilot App launching are not part of this browser build.

The Copilot SDK remains required for the desktop app, including notification triage, capture interpretation, and prioritization. The prototype previews that assistance with deterministic sample rules. Handing a review to Copilot App is a separate capability.

The prototype reports storage errors and retains pending work in memory. Use the error banner to retry, export a copy, or back up the saved copy before replacing it. Local Undo never reverses a simulated GitHub write.

## Development

```bash
bun run test
bun run build
bun run test:browser
```

The browser suite requires Playwright's Chromium. If it is not installed, run `bunx playwright install chromium`.

## Product and design

1. Read [PRODUCT.md](PRODUCT.md) for the approved behavior and acceptance scenarios.
2. Read [the prototype brief](docs/prototype-prompt.md) for the browser scope.
3. Use [DESIGN.md](DESIGN.md) for composition and [theme.md](docs/theme.md) for the Fox and GitHub theme references.

The domain engine, synthetic source events, storage adapter, and interface are separate. The old application and its database schema have not been restored.
