# Trusted desktop service

This backend implements manual GitHub notification operations and real Copilot SDK previews. It does not connect the browser prototype, change domain state, open old app data, or implement the native RPC host.

## Build and package

Use Bun **1.3.14**. Dependencies are pinned in this directory's manifest and lockfile.

```bash
cd service
bun install --frozen-lockfile
bun run typecheck
bun run build arm64
bun test
```

The standalone artifact is `service/dist/github-projects-service-aarch64-apple-darwin`. `bun run build x64` produces `github-projects-service-x86_64-apple-darwin`. Native integration should copy the matching artifact into `src-tauri/binaries/` and configure Tauri `bundle.externalBin` with the base path `binaries/github-projects-service` (without the target suffix). Sign the sidecar with the app's normal packaging process.

The executable embeds Bun and the SDK JavaScript. It runs outside the repository without Node, Bun, `node_modules`, or a companion JavaScript file. Compilation disables `.env` and `bunfig.toml` autoloading. The service only uses the SDK's external-CLI stdio transport; its optional in-process FFI/native runtime is not supported or selected.

**Runtime prerequisites:** installed executable `gh` and `copilot`, a supported GitHub CLI sign-in, and Copilot access for that GitHub account. Backend-only executable discovery uses absolute PATH directories and standard CLI install directories, including the current user's `.local/bin`. The renderer cannot choose executable paths or CLI arguments.

The SDK is `@github/copilot-sdk@1.0.13`, which speaks protocol 3 and was released against CLI 1.0.83. The packaged arm64 executable was exercised with the installed 1.0.84-1 CLI. Newer/older CLIs must pass the SDK handshake; failures remain explicit. The x64 build command is provided, but this implementation's real authentication/inference smoke ran on arm64.

## Native host contract

Start one service process **on demand**, with private piped stdin/stdout. There is no socket or HTTP server. Starting the process does not check connections, initialize the SDK, or fetch GitHub.

Write one UTF-8 JSON object followed by LF. Keep stdin open while awaiting replies. Correlate replies by `id`; concurrent replies may arrive out of order.

```json
{"v":1,"id":"refresh-1","op":"github.refresh","input":{}}
```

```json
{"v":1,"id":"refresh-1","ok":true,"result":{"batchId":"..."}}
```

The example result is abbreviated. Every complete result is validated against the operation's exported Zod schema.

```json
{"v":1,"id":"refresh-1","ok":false,"error":{"code":"access","message":"GitHub denied access. Check repository access and organization SSO authorization.","retryable":false}}
```

Malformed input has `id: null`. The host should treat protocol failures as service failures, not fabricate a successful operation. Stdout is protocol-only. Stderr contains fixed diagnostic codes, never raw CLI errors, credentials, prompts, or responses.

| Bound | Value |
| --- | --- |
| Request and response frame | 1 MiB each, excluding request LF |
| In-flight requests | 4; additional operations receive `busy` |
| Output backlog | 64 frames / 4 MiB; a stalled write fails after 2 seconds |
| Request IDs | Unique per process; 1-180 ASCII identity characters; 4,096 requests per process |
| Overall deadline | 120 seconds; cancellation propagates into gh/SDK cleanup |
| GitHub collection | 90-second budget; three concurrent enrichment workers, one refresh at a time |
| gh process | 20 seconds, 4 MiB combined stdout/stderr |
| Copilot concurrency/deadline | One operation, 90 seconds including setup/inference |
| Copilot payload/answer | 60,000 bytes each; at most one format correction within the same deadline |

Send `cancel` with `{ "requestId": "refresh-1" }` and a new envelope ID. Its result reports whether the target was active; the target receives its own cancelled result. Closing stdin, SIGINT, or SIGTERM cancels active work and closes owned resources. EOF is shutdown, not a flush-and-wait instruction. Native should allow bounded cleanup before forcibly terminating an unresponsive process.

Input cancellation and EOF cleanup do not wait for stdout progress. A broken output pipe is terminal: cancel all active operations rather than attempting another response. Native should continuously drain stdout/stderr and launch the sidecar in an owned process group. Neither the gh runner nor the SDK starts a detached process; group-level shutdown can escalate from SIGTERM to SIGKILL for the entire owned descendant tree.

The host must expose only these operation names through its native command, not a generic shell/HTTP interface. It must not accept renderer-supplied commands, paths, environment, model settings, tool names, or endpoint URLs. Disable external page access to the native bridge.

## Operation schemas

[`src/schema.ts`](src/schema.ts) is the authoritative DTO contract. Import `requestSchema`, `resultSchemas`, and the individual schemas; infer TypeScript types with `z.infer`. These service DTOs deliberately do not change the browser prototype's domain types.

| Operation | Input | Successful result |
| --- | --- | --- |
| `connection.check` | `{}` | Separate `github` and `copilot` availability, sanitized errors; GitHub viewer/scopes |
| `github.refresh` | `{}` | One batch with source threads, evidence, current state, and coverage diagnostics |
| `github.conversation` | `{reference, stream, page}` | One full-body message page, pagination metadata, fetched time and explicit partial/access error |
| `github.acknowledge` | `writeInputSchema` | Echoed context, `action: "acknowledge"`, `status: "confirmed"`, `confirmedAt` |
| `github.unsubscribe` | `writeInputSchema` | Echoed context, `action: "unsubscribe"`, `status: "confirmed"`, `confirmedAt` |
| `copilot.triage` | `triageInputSchema` | Evidence-grounded summaries, uncertainty, next-action previews, and proposed order |
| `copilot.interpretCapture` | `captureInputSchema` | An editable action/routine/unsupported proposal for that original capture |
| `copilot.reconsider` | `reconsiderInputSchema` | A complete permutation of selected item IDs with reasons |
| `cancel` | `{requestId}` | `{requestId, cancelled}` |

All objects are strict: unknown keys fail validation. Thread IDs are positive decimal strings. Repository references are `{repo: "owner/repo", number: positiveInteger, kind: "pr" | "issue"}`. Evidence/context IDs allow up to 500 characters. The service constructs all network endpoints itself.

### Refresh and reconciliation

`refreshSchema` contains `batchId`, `fetchedAt`, `viewer`, `status: complete | partial`, `threads`, `diagnostics`, and notification coverage. `coverage.missingMeansDone` is always `false`.

Each thread includes its notification ID, validated repository reference, current title/state/PR size, read/unread state, sticky reason, subscription observation, and evidence. Notification `updatedAt` and `reason` are context only; they never create request evidence.

Each evidence entry includes:

| Field | Meaning |
| --- | --- |
| `id`, `kind` | Immutable source identity and event type. IDs use repository, issue/PR number, event type, and GitHub event ID; node-only identities use a stable hash. |
| `at`, `actor` | Source event time and actor when provided, not notification update time |
| `recipient` | Direct user (`isViewer`) or specific team (`viewerMembership`), or none |
| `requestState` | `current`, `historical`, `uncertain`, or `not-request`; eligibility can change without rewriting identity/type |
| `text`, `textTruncated` | Bounded untrusted source text; it is not an instruction |

Only **current, unhandled** `review-request` evidence for the viewer or a confirmed viewer team can become a new review candidate. The caller compares stable IDs against locally persisted handled evidence. The service never receives or rewrites the entire handled history. A review completion, later cancellation, or source closure can change request eligibility while the original event remains review provenance.

Requests are recipient-specific. Another user/team's review or removal cannot suppress the viewer's request. A new request event has a new ID. Ordinary comments, literal mentions, commits, merge-queue events, and closure/merge remain updates, not proof of new review obligations. Literal mentions are messages to inspect; quoted/code mentions are not classified as definite reply requests.

### Coverage and limits

The service explicitly requests `GET /notifications?all=true`, including read and unread outstanding threads. It fetches at most two 50-thread pages, then enriches at most 50 distinct threads using three workers. The result preserves notification order regardless of worker completion order; only one refresh can run at a time.

A 90-second collection budget stops remaining reads before the outer 120-second transport deadline. Completed threads are returned in one partial batch with explicit time-limit diagnostics for interrupted and unstarted evidence. If current source data was acquired before a timeline or subscription read timed out, that usable thread is retained with unavailable/unknown coverage. Explicit user cancellation still fails the operation and awaits worker cleanup; it is not partial success.

A genuinely successful empty notification listing is distinct from a failed/nonempty listing with no usable threads: the latter is an error. Unsupported subjects, denied access, malformed responses, truncation, rate limits, and the response-size cap remain visible. Saved local work must survive all missing/partial/error results. The budget does not schedule another refresh or publish intermediate batches.

Timeline discovery reads page 1 and, when necessary, the last page (100 events each). For exactly two pages, both are contiguous. With more pages, only the newest page is eligible evidence; disconnected page-1 history is discarded, and coverage remains partial. `coverage.newestPage`, `fetchedPages`, and `observedAt` describe the batch, not a durable server cursor. Malformed/identity-less events or incomplete newest coverage prevent definite promotion. Team membership is bounded to 200 teams; unavailable membership becomes unknown, never assumed membership.

Timeline comments and review summaries are included as bounded notification evidence. The independent `github.conversation` operation reads full bodies; it never changes the timeline evidence contract or notification state. `timeline: complete` means the fetched REST timeline listing was complete, not that every possible GitHub source is available. The notification service itself has retention/settings limits. Neither complete coverage nor an absent notification finishes a local commitment.

GitHub requests are not a transaction. Concurrent source changes may require a later manual refresh. This version does not search repositories, poll, auto-refresh, or asynchronously reorder after returning a batch.

### Conversation pages

`stream` is `description`, `comments`, `reviews` or `inline`; issues support only the first two. `page: null` requests the newest page, and a positive page explicitly revisits history. Only these reconstructed GET routes are added: issue/PR roots, `/issues/{number}/comments`, `/pulls/{number}/reviews` and `/pulls/{number}/comments`. Lists use `per_page=5`. Newest discovery probes page 1 and optionally the last page: at most two reads per stream, or seven reads for a PR's initial/latest conversation (three for an issue). Older/reload actions read one page. They never request notification state or use a model.

Messages include the untruncated body, author, created/edited times and a validated GitHub source URL. IDs contain repository, source type/number, message type and GitHub ID. Inline replies retain `in_reply_to_id` independently of the review ID, so replies from different reviews stay with their original discussion even across pages. Missing/deleted parent context remains unknown. File paths and line numbers provide context; this is not a file diff or resolved-thread mirror.

The serialized UTF-8 page must fit below the 1 MiB response limit (4 KiB reserved for the envelope). An oversized page returns a limit error with no clipped bodies; it does not silently advance. Malformed messages preserve valid siblings with a partial-page error. Authentication, access, rate limits and offline errors remain explicit. Full lists are not transactional snapshots: page boundaries can shift after deletions, so cached deleted content can remain until explicit cache discard. Reloading an older page re-observes edits by stable identity.

These DTOs live in a separate native cache, never in task/note snapshots, `Row.events`, or model payloads. Cache limits/recovery are documented in the [native contract](../src/platform/README.md). The reader refreshes only the selected cached source's newest pages; every saved older page exposes its own timestamp and explicit reload action.

### Explicit writes

`writeInputSchema` is `{operationId, threadId, reference, displayedEvidenceIds}`. Persist this operation context before dispatch so failures can be retried explicitly. Before writing, the backend gets the thread and checks that it matches the supplied repository reference.

**Done on GitHub uses `DELETE /notifications/threads/{id}` and requires HTTP 204.** `PATCH` means read, not done, and is not exposed. Unsubscribe uses `PUT /notifications/threads/{id}/subscription` with `{"ignored":true}` and requires HTTP 200 with `ignored:true`. This suppresses ordinary conversation updates even for watched repositories; future mentions, participation, or review requests may generate new notifications.

Confirmed operation IDs are deduplicated within a service process. Reusing an ID with different context fails. Native persistence must avoid resending already-confirmed operations after a restart. GitHub does not accept these app operation IDs as transactional idempotency keys. Cancellation/timeouts may occur after GitHub accepted a write: retain an uncertain/failed operation, never claim success. A retry returning inaccessible/not-found is not confirmation.

After confirmed acknowledgement, integration may handle only the displayed evidence IDs locally. Retained actions/notes survive. Local Done, selection, navigation, and Undo never invoke these endpoints.

### Copilot previews and privacy

Triage accepts up to ten selected items, each with up to twenty evidence entries, size/coverage, and handled IDs **restricted to that selected evidence**. Capture interpretation accepts one already-saved original capture, its ID, and timezone (8,000 characters maximum). Reconsider accepts up to thirty selected available items with minimal category/size/evidence IDs. Never send private scratch notes or the persisted workspace.

The SDK receives a fresh private temporary HOME/config/working directory, `mode: "empty"`, disabled discovery/tools/MCP/skills/file hooks/custom instructions/extensions/plugins/memory/session store, and an unconditional permission rejection callback. No custom tools, hooks, question handlers, files, attachments, or remote sessions are configured. Runtime credentials come from supported `gh auth token --hostname github.com`, passed only as ephemeral `gitHubToken`. Ambient credentials/config variables are not forwarded to the Copilot child. The service does not inspect/copy Copilot keychain or token files.

Empty mode disables keychain access; unsupported Copilot-only authentication cannot silently switch the service into a less isolated mode. Missing gh/CLI/auth/Copilot access is explicit. GitHub notifications need classic `notifications` or `repo` scope; private source enrichment needs `repo`, and team membership needs `read:org` (or its parent scopes). Connection check does not fetch notifications.

SDK 1.0.13 has no schema-constrained response option. The service requests the exact JSON schema and waits for completed assistant content. It accepts plain JSON or one exact whole-response `json` code fence, never prose/fragment extraction. Strict Zod validation still rejects extra fields, fabricated IDs, invalid actions, and incomplete/duplicate orderings. One corrective generation can repair JSON/schema format, within the same restricted session/deadline; grounding failures are rejected.

Model suggestions cannot start, finish, defer, acknowledge, unsubscribe, change handled state, or override request identities. A review suggestion requires cited current unhandled request evidence. Uncertain coverage requires explicit uncertainty. Captured daily routine time/timezone must match the supplied capture. All results are `previewOnly: true`; human application remains the caller's responsibility.

Sessions and temporary private state are deleted during cleanup. After session disconnect/delete, the service uses the public SDK `forceStop()` directly. SDK 1.0.13's graceful `stop()` drops its child handle before confirmed exit, making later kill escalation ineffective; that path is not used. A synthetic SIGTERM-resistant runtime test verifies actual process termination through the public SDK API. Cleanup failures emit fixed stderr diagnostics. The service is a single-user process with capability restrictions, **not an operating-system sandbox**. Forced termination or power loss can leave a temporary SDK directory; those files are not durable app storage.

## Validation

Tests use synthetic gh/API and SDK responses. They cover pagination, read/unread notifications, recipient-specific requests/removals/reviews, sticky reasons, merge queues, re-requests, scope/access failures, malicious URLs, exact write semantics, permission/input restrictions, structured previews, cancellation, and the compiled JSONL roundtrip.

The merge-queue regression was verified by temporarily classifying queue events as review requests: the test failed at that exact event kind. The correct classification was restored and the suite passed.

The compiled roundtrip test skips only when no artifact exists; build before running release tests. No automated test sends a GitHub write or uses a real model. The explicit optional smoke below performs one tiny synthetic SDK inference (at most one corrective format retry), from a temporary non-repository cwd. It requires authorization because it consumes Copilot service access:

```bash
bun scripts/smoke.ts
```

The real arm64 smoke verified supported gh authentication, isolated SDK startup, and a fully validated editable capture preview. Its output used exactly one JSON fence; no correction was needed after accepting that whole wrapper. No credentials or model response bodies were logged.

## Official references

- [GitHub notification endpoints and read/done semantics](https://docs.github.com/en/rest/activity/notifications)
- [Copilot SDK 1.0.13 client/session types](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/types.ts)
- [SDK initialization, auth, empty-mode defaults, and transport](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/client.ts)
- [SDK completed-response and session lifecycle APIs](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/session.ts)
- [Bun standalone executable configuration](https://bun.com/docs/bundler/executables)
