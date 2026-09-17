# Trusted desktop service

This backend implements GitHub notification operations, the Waiting on me digest, workstream collection and ranking, Copilot SDK previews, and durable MCP task intake. The desktop owns workspace reconciliation and saving. The service does not mark local tasks done or implement the native RPC host.

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

**Runtime prerequisites:** installed executable `gh` and a supported GitHub CLI sign-in. Copilot previews additionally require `copilot` and Copilot access for that GitHub account; the Waiting on me digest does not. Backend-only executable discovery uses absolute PATH directories and standard CLI install directories, including the current user's `.local/bin`. The renderer cannot choose executable paths or CLI arguments.

The SDK is `@github/copilot-sdk@1.0.13`, which speaks protocol 3 and was released against CLI 1.0.83. The packaged arm64 executable was exercised with the installed 1.0.84-1 CLI; packaged ranking also succeeded with Homebrew 1.0.84-6 under a GUI-like PATH. Newer/older CLIs must pass the SDK handshake; failures remain explicit. An experimental MCP-start scratch probe is not a compatibility verdict for normal SDK inference, and successful ranking does not establish Slack authentication. Live Slack verification was skipped after OAuth timed out; no authentication success is assumed. The x64 build command is provided, but this implementation's real authentication/inference smoke ran on arm64.

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
| Overall deadline | 120 seconds; `work.collect` and `work.rank` get 300 seconds; cancellation propagates into gh/SDK cleanup |
| GitHub collection | 90-second budget; three concurrent enrichment workers, one refresh at a time |
| Waiting on me | Six sequential searches of at most 50 hits; at most 50 authored PR reads using three workers; 120-second overall deadline |
| gh process | 20 seconds, 4 MiB combined stdout/stderr |
| Copilot concurrency/deadline | One operation, 90 seconds including setup/inference; work ranking and each GitHub reply batch get 180 seconds |
| Copilot payload/answer | 60,000 bytes each; work ranking input allows 240,000 bytes; at most one format/reference correction within the same deadline |

Send `cancel` with `{ "requestId": "refresh-1" }` and a new envelope ID. Its result reports whether the target was active; the target receives its own cancelled result. Closing stdin, SIGINT, or SIGTERM cancels active work and closes owned resources. EOF is shutdown, not a flush-and-wait instruction. Native should allow bounded cleanup before forcibly terminating an unresponsive process.

Input cancellation and EOF cleanup do not wait for stdout progress. A broken output pipe is terminal: cancel all active operations rather than attempting another response. Native should continuously drain stdout/stderr and launch the sidecar in an owned process group. Neither the gh runner nor the SDK starts a detached process; group-level shutdown can escalate from SIGTERM to SIGKILL for the entire owned descendant tree.

The host must expose only these operation names through its native command, not a generic shell/HTTP interface. Workstream operations accept schema-validated saved queries, model names, server names, and explicitly selected read-tool names. They never accept renderer-supplied commands, configuration JSON, credential headers, environment, filesystem paths, or executable endpoints. Disable external page access to the native bridge.

## Operation schemas

[`src/schema.ts`](src/schema.ts) is the authoritative DTO contract. Import `requestSchema`, `resultSchemas`, and the individual schemas; infer TypeScript types with `z.infer`. These service DTOs deliberately do not change the browser prototype's domain types.

| Operation | Input | Successful result |
| --- | --- | --- |
| `connection.check` | `{}` | Separate `github` and `copilot` availability, sanitized errors; GitHub viewer/scopes |
| `github.refresh` | `{}` | One batch with source threads, evidence, current state, and coverage diagnostics |
| `github.waiting` | `{}` | `waitingSchema`: authenticated viewer, fetched time, nonempty ordered buckets, and capped-query IDs |
| `github.conversation` | `{reference, stream, page}` | One full-body message page, pagination metadata, fetched time and explicit partial/access error |
| `github.acknowledge` | `writeInputSchema` | Echoed context, `action: "acknowledge"`, `status: "confirmed"`, `confirmedAt` |
| `github.unsubscribe` | `writeInputSchema` | Echoed context, `action: "unsubscribe"`, `status: "confirmed"`, `confirmedAt` |
| `copilot.triage` | `triageInputSchema` | Evidence-grounded summaries, uncertainty, next-action previews, and proposed order |
| `copilot.interpretCapture` | `captureInputSchema` | An editable action/routine/unsupported proposal for that original capture |
| `copilot.reconsider` | `reconsiderInputSchema` | A complete permutation of selected item IDs with reasons |
| `work.collect` | `workCollectInputSchema` | Candidates with immutable evidence, current source observations, and bounded-coverage warnings |
| `work.rank` | `workRankInputSchema` | Exact permutation of the active queue and one reason per task |
| `work.connections` | `{}` | Configured MCP server/read-tool names and explicit setup instructions; no secrets |
| `work.intake` | `{}` | Up to 200 unconsumed durable push items and `hasMore`; reading never deletes |
| `work.ackIntake` | `{ids}` | The same acknowledgement, after the desktop has saved those items |
| `cancel` | `{requestId}` | `{requestId, cancelled}` |

All objects are strict: unknown keys fail validation. Thread IDs are positive decimal strings. Repository references are `{repo: "owner/repo", number: positiveInteger, kind: "pr" | "issue"}`. Evidence/context IDs allow up to 500 characters. The service constructs all network endpoints itself.

### Workstreams

[`src/work-schema.ts`](src/work-schema.ts) defines the shared workstream DTOs. Run `work.collect` separately for each enabled stream, reconcile and save its results, then call `work.rank` once for the entire active queue. `createHandler` accepts an optional fourth `WorkService` dependency. The service does not schedule runs.

`work.collect` takes `{stream, model, since, knownUrls?, observeOnly?}`. `knownUrls` defaults to `[]` and accepts at most 100 tracked source URLs. Pass tracked GitHub issue/PR URLs even when they no longer match the saved query. For additional tracked-source batches, set `observeOnly: true` (default false) to read source state without repeating GitHub search or MCP extraction. Those reads yield `open`, `queued`, `closed`, `merged`, or explicit `unknown` observations. An absent search result is never evidence of completion. MCP pull also performs bounded actual GitHub state reads for linked targets and tracked URLs; it never invents their state from Slack text. Canonical `/issues/N` URLs for PRs are detected through the issue API's `pull_request` field and read as PRs, including current merge queue membership.

The desktop persists `work.collectionCursor` separately from `lastCompletedAt`. Collectors receive that cursor as `since`. A fully successful, durably saved run advances the cursor no later than its **start**, not its completion after ranking; events arriving during collection or ranking remain eligible for the next run. Notification collectors can return `coveredThrough` to checkpoint a smaller, oldest-first interval. The desktop takes the earliest returned boundary across sources, rejects nonprogressing or future boundaries, and shows remaining history across relaunch. `lastCompletedAt` still records actual completion for display and scheduling. Failed runs retain the prior cursor. Older saves default to a null cursor and safely rescan. Changing source streams or the collector model resets the cursor to null; an in-flight run cannot claim coverage for changed settings. Ranking instructions and cadence changes do not reset source coverage.

GitHub search streams (`kind: "github"`) use the saved expression, independently of notification streams (`kind: "github-notifications"`). Supported GitHub actions are `review`, `fix`, `reply`, `merge`, `implement`, `follow-up`, and `manual` (also exported as `githubWorkActionSchema`). The shared workstream schema rejects GitHub `review-result` at the action field, so invalid settings fail before any source request (`invalid_input` at the service boundary); MCP pull and push intake continue to support it. The backend replaces `@me` with the authenticated viewer and sends a single URL-encoded query to the search API with `is:open archived:false`. User text never becomes shell syntax. Search reads up to two 100-match pages, deduplicates overlapping results, and returns at most 200 candidates plus 300 observations. It warns only when matches remain or results are incomplete, not merely when an exact page or 200-match boundary is reached. Three workers enrich matched and tracked sources; GitHub collection including reply extraction has a 270-second deadline. PR reads include real `mergeQueueEntry`, head SHA, review decision, mergeability, and at most 100 checks. Timeline reads cover the first and latest 100-event pages; skipped history and incomplete searches produce warnings.

For `review`, a current direct viewer request or a current explicitly selected `team-review-requested:org/team` request is required. Evidence uses the real `review_requested` event ID and occurrence time. Commits, comments, source `updatedAt`, query names, and collection time never create fresh review evidence. If the original request is unavailable, a deterministic source/recipient identity uses source creation time and explicitly reports unknown request age. Fix and merge requests use actual head/check/review conditions. Reply extraction uses Copilot against bounded source comments, not notification reasons. It groups whole source contexts into batches within 60,000 UTF-8 bytes instead of starting one session per issue. The model selects message references; the backend attaches original event IDs, timestamps, and source links. Invalid or duplicated references get one correction attempt. Rejected batches leave other discoveries and source observations intact with an explicit warning. Oversized individual contexts are skipped with a warning, never split silently.

Candidate identity belongs to source URL plus action. Canonical GitHub targets let the desktop deduplicate GitHub and Slack requests for the same action. Only recognized GitHub issue/PR references and Slack message permalinks discard query/fragment tracking context; generic MCP URLs preserve their paths, queries and fragments because those can identify distinct tasks or application routes. Stored canonical identities allow 2,014 characters: a 2,000-character URL, the longest action name, and a separator. Evidence and ranking task IDs keep their separate 500-character limits. Evidence IDs do not depend on stream IDs or query names; `streamId` records provenance. A Slack evidence URL remains its original message permalink even when the candidate targets GitHub. The desktop owns source/action Done semantics and must preserve handled evidence. Metadata's optional `availabilityObservedAt` records the last accepted source observation; reconciliation must ignore older observations so a delayed open result cannot undo newer merge-queue suppression. Older saved metadata without this field remains valid.

Notification streams fetch `/notifications` with `all=true`, including notifications read elsewhere. A null `since` starts with 30 days of history. Large backlogs are split into bounded chronological intervals; a successful run saves progress before the next interval. Optional `coverageInfo` describes known exclusions and remaining history without treating them as failed reads; real `warnings` still prevent cursor advancement. Source events, not notification `updated_at` or sticky `reason`, determine actionable evidence and its age. The notification stream chooses actions from inspected requests rather than applying the stream's placeholder `action` to every result. Saved searches remain separate and unchanged.

Each notification collection uses at most 32 probes of 50 notifications, narrowing `before` until a complete interval contains at most 28 issue/PR sources (at most 196 source/action pairs). It avoids offset pagination over a changing inbox. `since` rounds down with a one-second overlap, and partial checkpoints use whole seconds. A single indivisible second exceeding these limits produces an explicit warning without advancing the cursor; it never skips the excess. Unsupported subject types and archived repositories are known exclusions, not failed reads.

Notification-backed candidates carry optional `notification: {threadId, reference, updatedAt}` metadata for the existing `github.unsubscribe` operation. The desktop validates that this reference belongs to the candidate source, retains its newest observed timestamp, and shares subscription state across actions on the same conversation. It persists an `unsubscribe` intent in task metadata before dispatch. The service still preflights the actual notification identity and confirms `ignored: true`; neither task Done nor collection sends notification writes. The desktop verifies every echoed context field and retains failed or interrupted writes for explicit retry only.

Ranking is a separate no-tools SDK session. Owner instructions apply only to prioritization; source titles, notes, queries and tool results remain untrusted data. The selected model is optional. The service sends every task with a short temporary reference and requests one ordered list with a concise reason per task (at most 240 characters). It validates an exact reference permutation before mapping back to persistent IDs and the existing `orderedIds`/`reasons` contract. Authentication, malformed output, source failure, and model payload limits remain explicit errors—there is no demo or heuristic ranking fallback. SDK ranking input is bounded to 240,000 bytes and output to 60,000 bytes, with one format/reference correction and a 180-second total deadline. Oversized queues fail explicitly rather than being silently ranked in partial batches; task notes and evidence are not shortened to fit.

`normalizeWorkUrl` applies the source-specific URL rules to service candidates and evidence identities as well as intake. In particular, generic `task?id=101` and `task?id=102` cannot share an evidence identity merely because their source event IDs match. Every collector reports `collectedAt` from the start of collection, not its completion, so the next successful watermark need not skip messages arriving while reads were in flight.

#### Existing Slack / MCP connections

Copilot App connections are **not automatically shared** with this service. Backend discovery reads only the supported Copilot CLI `~/.copilot/mcp-config.json`, or an absolute path explicitly provided through backend `COPILOT_MCP_CONFIG_PATH`. It never reads app databases, keychains, or renderer configuration. Use **Read MCP connections** to check whether the selected server is configured.

Use the [official Copilot CLI MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-server) with `/mcp add`, or explicitly export/copy an existing configuration into a private backend file. The official Slack endpoint is `https://mcp.slack.com/mcp`. Existing `oauthClientId` and `oauthPublicClient` fields are preserved from that backend configuration through SDK serialization; no organization-specific client ID is embedded in this repository.

Selected collector sessions enable the SDK's supported `mcpOAuthTokenStorage: "persistent"` option. Only those sessions use the existing user's HOME and CLI configuration directory (`~/.copilot` by default); backend `COPILOT_MCP_OAUTH_CONFIG_DIR` may name an explicit absolute shared CLI OAuth configuration directory. The runtime can therefore reuse its supported persistent OAuth store across collection runs instead of losing state in a fresh temporary configuration. The working directory remains private, and discovery, instructions, hooks, memory, session-store access, and all tools other than the selected MCP read tools remain disabled. The service itself never reads keychain tokens or imports app databases.

Complete any required OAuth sign-in once through supported CLI MCP setup using the same configuration directory. App sign-in is not guaranteed to be shared with the CLI. If the SDK requests a new host-supplied OAuth token, background collection cancels that request and returns an explicit authentication/setup error rather than opening an unattended sign-in flow. Ranking and legacy preview sessions retain fully private HOME/configuration directories and in-memory-only token storage, including after an MCP collection. Environment references of the form `${NAME}` in configured arguments, headers, URLs and environment values resolve only in the backend. Missing values fail explicitly. Never paste tokens or configuration JSON into the desktop.

`work.connections` lists configured server names and explicit configured tool names. It does not launch servers or claim live discovery. A wildcard configuration produces an empty displayed tool list; supply the exact known read-tool names in the stream. The SDK receives only that server and those selected names. Its permission callback additionally requires a matching server, matching tool, and `readOnly: true`. All shell, filesystem, network, write-tool and unknown permission requests are denied. Servers that do not declare read-only tools need configuration/provider changes; the service does not silently approve them.

Collectors search/read full relevant threads under a 20-call / 240,000-byte tool-output budget. Structured source records must include an immutable message ID, original creation time, and source permalink. The validator binds those fields within one record, rejects edited timestamps as freshness, and rejects invented GitHub targets. It recognizes inline Markdown destinations and Slack angle links without consuming their closing delimiters; balanced or escaped parentheses within real URLs remain intact. Bare generic URL parentheses, queries and fragments are not stripped. Slack message `ts` must match the permalink's message identity. Unstructured prose without verifiable source fields is not accepted as evidence. Tool/authentication failures return `mcp_unavailable`; absent or incompatible configuration returns `mcp_configuration`.

#### Durable push intake (`--mcp`)

The packaged executable also runs as a real stdio MCP server. An external integration can call `add_task` while the desktop is closed. Add this server to that integration's supported MCP configuration, using the installed executable's absolute path:

```json
{
  "mcpServers": {
    "work-intake": {
      "type": "stdio",
      "command": "/absolute/path/github-projects-service-aarch64-apple-darwin",
      "args": ["--mcp"],
      "tools": ["add_task"]
    }
  }
}
```

The x64 binary uses the corresponding `x86_64-apple-darwin` filename. No Copilot App automatic review-completion hook is assumed or installed. A producer must explicitly call the tool after its integration detects a real event.

Minimal `add_task` arguments:

```json
{
  "source": "copilot",
  "producer": "my-review-integration",
  "eventId": "review-run-123",
  "occurredAt": "2026-09-16T12:00:00Z",
  "action": "review-result",
  "title": "Read the completed AI review",
  "url": "https://github.com/octo/repo/pull/12",
  "summary": "The AI review is ready for my attention."
}
```

`source` is `copilot` or `mcp`; `producer`, immutable external `eventId`, and actual `occurredAt` are required. A completed AI review creates `review-result`, separate from a human `review` task. It remains pending until the user chooses Done. HTTPS source links cannot contain credentials; malformed, oversized or future-dated events are rejected. Do not generate event IDs from submission time when replaying the same event.

The database is private and independent of the repository: on macOS, `~/Library/Application Support/io.robertcrandall.github-projects-workspace/work-intake/intake.sqlite3`. Other platforms use the same app namespace under their user application-data directory. SQLite uses WAL, full synchronization, a five-second busy timeout, a private directory and `0600` database permissions. Producer/source/event identity makes retries idempotent. Conflicting reuse fails; consumed identities remain as replay tombstones. The store refuses more than 100,000 identities rather than silently expiring them.

The desktop must read `work.intake`, reconcile and successfully save the native workspace, **then** call `work.ackIntake` with only the saved item IDs. A crash before acknowledgement re-delivers the same IDs safely. ACK never completes a user's task. `hasMore` means read the next page after saving and acknowledging the current page.

The MCP adapter implements newline-delimited JSON-RPC `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. It negotiates `2025-11-25`, `2025-06-18`, `2025-03-26`, or `2024-11-05`; unknown versions receive the latest supported version. Frames are capped at 32 KiB; writes time out after two seconds. Stdout contains protocol frames only. EOF closes the database. The external caller—not the desktop—owns permission to invoke this write tool.

Workstream tests inject runners, SDK clients, configuration reads and store paths. They cover immutable request identities, source grounding, ranking permutations, authentication failure, durable replay/ACK, and packaged MCP-to-desktop round trips. A real CLI/SDK smoke with a synthetic read-only MCP server produced a validated review candidate and preserved its message permalink. This verifies the collector transport, not an unavailable real Slack connection. The fallback-freshness test was mutation-checked by replacing source creation time with run time: it failed, and the original logic was restored.

### Waiting on me: manual-only rules

Send `{"v":1,"id":"waiting-1","op":"github.waiting","input":{}}` only after an explicit user request. This is a separate, read-only digest, not an automation to execute. It does not schedule, poll, auto-refresh, request a model, initialize Copilot, modify notifications, apply inbox filters, archive items, or fetch source bodies. No model selector is needed. A later manual run repeats the reads; there is no digest cache in the service.

`waitingSchema` exports the renderer-safe `WaitingDigest`, `WaitingItem` and `WaitingBucket` types from `src/schema.ts`. The result is:

```json
{
  "fetchedAt": "2026-09-14T12:00:00.000Z",
  "viewer": "viewer",
  "buckets": [{
    "id": "needs-fix",
    "items": [{
      "reference": {"repo": "octo/project", "kind": "pr", "number": 12},
      "title": "Example pull request",
      "author": "viewer",
      "updatedAt": "2026-09-13T12:00:00Z",
      "reasons": ["changes-requested", "conflicts", "ci"]
    }]
  }],
  "limitedQueries": []
}
```

Titles are at most 500 characters. Author is a validated login or `null`; deleted authors with an empty login normalize to `null`. Authored results use the authenticated viewer. All timestamps are ISO instants. Only nonempty buckets are returned, in this first-match priority order:

| Bucket | Eligibility |
| --- | --- |
| `direct-review` | Open non-draft PRs from `user-review-requested:@me` |
| `team-review` | Open non-draft PRs from `team-review-requested:integrations/terraform-provider-core-maintainers`, and no other team |
| `ready-to-merge` | Authored non-draft PRs with `APPROVED`, `MERGEABLE`, and passing CI or no checks |
| `needs-fix` | Authored non-draft PRs with `CHANGES_REQUESTED`, `CONFLICTING`, or failing CI; every applicable reason is included |
| `mentioned` | Mentioned open PRs updated within three days, with a known author other than the viewer |
| `reviewed` | Previously reviewed open PRs updated within two days, with a known author other than the viewer; a light signal |
| `assigned` | Assigned open issues updated within 30 days |

Each identity is case-insensitive `owner/repo#number`, shared across all buckets. First eligible match wins. Each bucket sorts oldest update first, then by that identity. Day windows include both their exact lower boundary and the captured request time; future timestamps are excluded. Mentions and reviewed results may be drafts. Unknown/deleted authors are conservatively excluded from those two weak-signal buckets because the service cannot establish that the viewer did not author them. Other buckets retain unknown authors as `null`.

The service resolves `gh` itself and first reads `GET /user`. It then executes exactly these searches, sequentially, stopping at the first failure:

```text
gh search prs user-review-requested:@me --archived=false --state=open --limit 50 --json number,title,repository,author,updatedAt,isDraft
gh search prs team-review-requested:integrations/terraform-provider-core-maintainers --archived=false --state=open --limit 50 --json number,title,repository,author,updatedAt,isDraft
gh search prs --author=@me --archived=false --state=open --limit 50 --json number,title,repository,isDraft,updatedAt
gh search prs --mentions=@me --archived=false --state=open --limit 50 --json number,title,repository,author,updatedAt
gh search prs --reviewed-by=@me --archived=false --state=open --limit 50 --json number,title,repository,author,updatedAt
gh search issues --assignee=@me --archived=false --state=open --limit 50 --json number,title,repository,author,updatedAt
```

`--archived=false` excludes archived repositories in GitHub's search, before the 50-result cap. The app's local Archive location does not affect this filter. `user-review-requested` is deliberately not the broader `review-requested` qualifier. Team membership is never queried or expanded. Search repository identity comes from `repository.nameWithOwner`, not REST's `full_name`. Every authored search result that is not a draft gets one bounded read:

```text
gh pr view <number> --repo <owner/repo> --json number,reviewDecision,mergeable,isDraft,statusCheckRollup
```

The number must match, and PRs that became drafts are skipped. The service validates every enrichment field and check entry before classification. It uses a check's nonempty `conclusion`, falling back to `state`, then empty. Any `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED` or `ERROR` makes CI failing, even alongside pending checks. Otherwise, any empty/null value, `PENDING`, `IN_PROGRESS`, `QUEUED` or `EXPECTED` makes CI pending. With checks and neither condition, CI passes; an empty or null rollup means no checks. A CheckRun's `status` is lifecycle metadata, not a conclusion: an empty conclusion without a state remains pending even when status is `IN_PROGRESS` or `COMPLETED`. Unrecognized/malformed fields fail the operation, never become passing CI. `STALE` and `STARTUP_FAILURE` follow the requested non-failing/non-pending rule; this digest is not a substitute for GitHub's merge protections.

An empty `reviewDecision` means no review requirement, not a needs-fix reason. `UNKNOWN` mergeability is not a conflict. Neither broadens ready-to-merge: that bucket still requires exactly `APPROVED` and `MERGEABLE`.

`limitedQueries` contains any of `direct-review`, `team-review`, `authored`, `mentioned`, `reviewed`, `assigned` whose search returned exactly 50 hits, before filtering or deduplication. It means more results may exist, not that the query failed. Each bucket holds at most 50 items; the entire digest holds at most 300. A successful empty digest has `buckets: []`, without special report text.

All reads share a 120-second deadline and cancellation signal; authored enrichment uses at most three workers. The existing shell-free runner limits each process to 20 seconds and 4 MiB. Any authentication, query, enrichment, malformed-output, or unexpected bound failure rejects the whole digest with a sanitized error. In-flight peers are cancelled and awaited after an enrichment failure. No partial/empty success replaces a failed read. Timeout and cancellation errors explicitly describe a read-only operation. CLI exit 4 reports authentication; other nonzero search/view exits report unavailable without exposing private stderr. These reads are not transactional, and capped results do not prove that all work was found.

`WaitingService` accepts backend-only `runner`, `resolve`, `now`, and bounded `deadlineMs` test dependencies. `createHandler(github, copilot, waiting)` accepts it as the optional third parameter. Renderers should import only `src/schema.ts`, never service implementation or process modules.

### Refresh and reconciliation

`refreshSchema` contains `batchId`, `fetchedAt`, `viewer`, `status: complete | partial`, `threads`, `diagnostics`, and notification coverage. `coverage.missingMeansDone` is always `false`.

`status` reports whether the bounded collection succeeded, not whether it contains all GitHub history. The notification batch cap and intentional older-timeline gaps remain explicit in `coverage`, but do not generate error diagnostics or make a successful refresh partial. Failed reads, malformed evidence, deadlines and unexpected response-size limits still do.

Each thread includes its notification ID, validated repository reference, current title/state/PR size, read/unread state, sticky reason, subscription observation, and evidence. Notification `updatedAt` is the actual notification's `updated_at`, not a reader-cache or enrichment time. The client uses it for archive boundaries and acknowledgement preflight; it never fabricates a review request from that timestamp or a sticky reason.

`sourceState` is `{state: open | closed | merged | queued | unknown, observedAt, updatedAt, error}`. `observedAt` records the beginning of its current source read; `updatedAt` is the source object's timestamp, separate from notification time. Unknown requires an explicit error. Current REST issue/PR roots confirm closure/merge. An open PR additionally reads the fixed, service-owned GraphQL query for `PullRequest.state`, `updatedAt`, and `mergeQueueEntry { id }`. A successful non-null entry confirms current queue membership; successful null confirms not queued. Later GraphQL merged/closed state overrides the earlier REST open read.

GitHub dotcom exposes `PullRequest.mergeQueueEntry` as a nullable `MergeQueueEntry` (verified by live read-only schema inspection). The existing repository token successfully read a merged PR with `state: MERGED` and `mergeQueueEntry: null`. Public access follows GitHub's token policy; private repositories need repository access and any required SSO. Permission denial, unsupported fields, malformed output and GraphQL partial errors yield unknown with a `source-state` diagnostic, not a fabricated null/queued result. Positive queue membership and denial shapes are exercised with representative fixtures, not live writes.

The only added transport is `POST /graphql` with exactly `{query: fixedReadQuery}`, accepted only when the query reconstructs from a validated repository/number. GitHub's GET route returns schema introspection rather than executing this query; the POST read was verified through the real `GhApi` transport. No renderer-supplied query, general GraphQL endpoint or mutation is exposed. Timeline queue events, auto-merge, mergeability and CI do not determine current state. A terminal or rule decision is client-local and never calls the notification write APIs.

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

The service explicitly requests `GET /notifications?all=true`, including read and unread outstanding threads. It fetches at most two 50-thread pages, then enriches at most 50 distinct threads using three workers. Each open PR adds at most one current-state GraphQL read within the same budget. The result preserves notification order regardless of worker completion order; only one refresh can run at a time.

A 90-second collection budget stops remaining reads before the outer 120-second transport deadline. Completed threads are returned in one partial batch with explicit time-limit diagnostics for interrupted and unstarted evidence. If current source data was acquired before a timeline or subscription read timed out, that usable thread is retained with unavailable/unknown coverage. Explicit user cancellation still fails the operation and awaits worker cleanup; it is not partial success.

A genuinely successful empty notification listing is distinct from a failed/nonempty listing with no usable threads: the latter is an error. Unsupported subjects, denied access, malformed responses, truncation, rate limits, and the response-size cap remain visible. Saved local work must survive all missing/partial/error results. The budget does not schedule another refresh or publish intermediate batches.

Timeline discovery reads page 1 and, when necessary, the last page (100 events each). For exactly two pages, both are contiguous. With more pages, only the newest page is eligible evidence; disconnected page-1 history is discarded, and coverage remains partial. `coverage.newestPage`, `fetchedPages`, and `observedAt` describe the batch, not a durable server cursor. Malformed/identity-less events or incomplete newest coverage prevent definite promotion. Team membership is bounded to 200 teams; unavailable membership becomes unknown, never assumed membership.

Pagination accepts GitHub's canonical `/repositories/{id}/...` links only for the same source number and resource. It extracts the bounded page number and reconstructs the request using the original repository; it never follows the supplied URL. This applies to timelines and conversation pages. REST cross-references without event IDs use a stable hash of the originating issue ID and occurrence time. Missing or malformed identities still make coverage partial and produce an unreadable-event diagnostic; intentional older-history gaps only affect coverage.

Timeline comments and review summaries are included as bounded notification evidence. The independent `github.conversation` operation reads full bodies; it never changes the timeline evidence contract or notification state. `timeline: complete` means the fetched REST timeline listing was complete, not that every possible GitHub source is available. The notification service itself has retention/settings limits. Neither complete coverage nor an absent notification finishes a local commitment.

GitHub requests are not a transaction. Concurrent source changes may require a later manual refresh. Missing/failed source reads do not confirm terminal status; the client exposes saved coverage and fails open for suppression while preserving local checkpoints and manual Archive. Notification refresh does not search repositories, poll, auto-refresh, or asynchronously reorder after returning a batch. The independent Waiting on me operation uses only the fixed searches documented above.

### Conversation pages

`stream` is `description`, `comments`, `reviews` or `inline`; issues support only the first two. `page: null` requests the newest page, and a positive page explicitly revisits history. Only these reconstructed GET routes are added: issue/PR roots, `/issues/{number}/comments`, `/pulls/{number}/reviews` and `/pulls/{number}/comments`. Lists use `per_page=5`. Newest discovery probes page 1 and optionally the last page: at most two reads per stream, or seven reads for a PR's initial/latest conversation (three for an issue). Older/reload actions read one page. They never request notification state or use a model.

Messages include the untruncated body, author, created/edited times and a validated GitHub source URL. IDs contain repository, source type/number, message type and GitHub ID. Inline replies retain `in_reply_to_id` independently of the review ID, so replies from different reviews stay with their original discussion even across pages. Missing/deleted parent context remains unknown. File paths and line numbers provide context; this is not a file diff or resolved-thread mirror.

The serialized UTF-8 page must fit below the 1 MiB response limit (4 KiB reserved for the envelope). An oversized page returns a limit error with no clipped bodies; it does not silently advance. Malformed messages preserve valid siblings with a partial-page error. Authentication, access, rate limits and offline errors remain explicit. Full lists are not transactional snapshots: page boundaries can shift after deletions, so cached deleted content can remain until explicit cache discard. Reloading an older page re-observes edits by stable identity.

These DTOs live in a separate native cache, never in task/note snapshots, `Row.events`, or model payloads. Cache limits/recovery are documented in the [native contract](../src/platform/README.md). The reader refreshes only the selected cached source's newest pages; every saved older page exposes its own timestamp and explicit reload action.

### Explicit writes

`writeInputSchema` is `{operationId, threadId, reference, displayedEvidenceIds, notificationUpdatedAt?}`. Archive persists this context together with local placement before dispatch. Before writing, the backend gets the thread and checks its repository reference. For acknowledgement, a newer source timestamp returns `source_changed` without DELETE. Responses echo the captured timestamp as well as evidence IDs; retry never substitutes a newer timestamp.

The optional timestamp field retains protocol compatibility with earlier callers and saved operations. The desktop refuses acknowledgement of an older intent without a timestamp; it preserves that history and directs the user to Refresh and confirm current evidence instead. Unsubscribe does not depend on an activity cutoff.

**Done on GitHub uses `DELETE /notifications/threads/{id}` and requires HTTP 204.** `PATCH` means read, not done, and is not exposed. Unsubscribe uses `PUT /notifications/threads/{id}/subscription` with `{"ignored":true}` and requires HTTP 200 with `ignored:true`. This suppresses ordinary conversation updates even for watched repositories; future mentions, participation, or review requests may generate new notifications.

Confirmed operation IDs are deduplicated within a service process. Reusing an ID with different context fails. Native persistence must avoid resending already-confirmed operations after a restart. GitHub does not accept these app operation IDs as transactional idempotency keys. Cancellation/timeouts may occur after GitHub accepted a write: retain an uncertain/failed operation, never claim success. A retry returning inaccessible/not-found is not confirmation.

GitHub does not offer an atomic comparison-and-delete or event-scoped acknowledgement. A notification arriving between the preflight GET and DELETE may also be marked done remotely. Confirmation permits handling only the displayed evidence IDs locally, never concurrent newer evidence. Notes and Tasks survive. Local Restore, task Done, selection, navigation and Undo never invoke these endpoints.

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

The compiled roundtrip test skips only when no artifact exists; build before running release tests. No automated test sends a GitHub write or uses a real model. `test/waiting.test.ts` covers exact search/view arguments and fixed-team scope, bucket priority and case-insensitive deduplication, draft/author rules, inclusive time boundaries, ordering, CI states and failure precedence, all reasons, limits, all-or-nothing validation/errors, three-worker cleanup, deadlines, cancellation, strict JSONL, and absence of Copilot calls. Its clock and runner are synthetic.

The explicit optional smoke below performs one tiny synthetic SDK inference (at most one corrective format retry), from a temporary non-repository cwd. It is unrelated to Waiting on me and requires authorization because it consumes Copilot service access:

```bash
bun scripts/smoke.ts
```

The real arm64 smoke verified supported gh authentication, isolated SDK startup, and a fully validated editable capture preview. Its output used exactly one JSON fence; no correction was needed after accepting that whole wrapper. No credentials or model response bodies were logged.

## Official references

- [GitHub notification endpoints and read/done semantics](https://docs.github.com/en/rest/activity/notifications)
- [GitHub GraphQL PullRequest fields, including mergeQueueEntry](https://docs.github.com/en/graphql/reference/objects#pullrequest)
- [Copilot SDK 1.0.13 client/session types](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/types.ts)
- [SDK initialization, auth, empty-mode defaults, and transport](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/client.ts)
- [SDK completed-response and session lifecycle APIs](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/session.ts)
- [Bun standalone executable configuration](https://bun.com/docs/bundler/executables)
