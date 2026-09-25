# Trusted desktop service

This backend implements GitHub notification operations, workstream collection and ranking, Copilot SDK previews, and durable MCP task intake. The desktop owns workspace reconciliation and saving. The service does not mark local tasks done or implement the native RPC host.

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

**Runtime prerequisites:** installed executable `gh` and a supported GitHub CLI sign-in. Copilot previews additionally require `copilot` and Copilot access for that GitHub account. Backend-only executable discovery uses absolute PATH directories and standard CLI install directories, including the current user's `.local/bin`. The renderer cannot choose executable paths or CLI arguments.

The SDK is `@github/copilot-sdk@1.0.13`, which speaks protocol 3 and was released against CLI 1.0.83. The packaged arm64 executable was exercised with the installed 1.0.84-1 CLI; packaged ranking also succeeded with Homebrew 1.0.84-6 under a GUI-like PATH. Newer/older CLIs must pass the SDK handshake; failures remain explicit. An experimental MCP-start scratch probe is not a compatibility verdict for normal SDK inference, and successful ranking does not establish Slack authentication. Live Slack verification was skipped after OAuth timed out; no authentication success is assumed. The x64 build command is provided, but this implementation's real authentication/inference smoke ran on arm64.

## Code review backend and saved task sessions

The desktop exposes this capability only through explicit single-task actions and `work.reviewCode`. Its durable lifecycle is separate from task assessment/ranking history. Existing assessors and prioritizers still have no tools. Browser-safe run DTOs live in `src/code-runs.ts`; the [native storage boundary](../src/platform/README.md#code-run-lifecycle) persists their lifecycle independently of task snapshots, without starting SDK work.

Call the existing `CopilotService` instance's `reviewCode(input, signal)` method; do not create another service instance for each task. [`src/code-review-schema.ts`](src/code-review-schema.ts) contains the browser-safe schemas/types, re-exported by [`src/code-review.ts`](src/code-review.ts). The strict input contains only:

```ts
{
  taskId: 'saved-task-id',
  source: { repo: 'owner/repo', kind: 'issue', number: 123 },
  job: 'implementation-assessment',
  agent: { id: 'stable-agent-id', instructions: 'Owner judgment rules', model: '' },
}
```

`implementation-assessment` requires an issue; `pr-review` requires `kind: 'pr'`. An issue URL that actually identifies a PR returns `unsupported`; callers must select its canonical PR identity. Never include workspace notes, credentials or arbitrary URLs. Blank model means SDK default, not a claimed resolved model.

The validated `code-review-v1` result includes a discriminated `answer`, the task ID, service-observed source text/fingerprint, source update/observation times, a final `verifiedAt`, requested model/instructions and a semantic configuration fingerprint. Implementation answers contain findings and a recommended `nextStep`; they require at least one successful code read and validated code evidence in that next step. Source-only answers, including those after all attempted reads failed, return `copilot_output` after the existing correction attempt, never a successful implementation assessment. No answer marks a task done or submits a GitHub review. SDK sessions remain ephemeral. The desktop owns durable run IDs, status, history and saving results, including partial results and their warnings.

PR answers contain only `job`, grounded `findings` and a **service-owned `conclusion: {status, summary}`**. The model's summary and uncertainty are not returned or persisted. With no successful code reads, the conclusion is `not-inspected`: "No source-code lines were inspected. No code review or approval was completed." With actual reads, it is `partial-no-approval`: "Partial code inspection only. This is not an approval to merge." These exact status/notice pairs are enforced by the result schema, including agreement with recorded read evidence. The desktop persists and renders this conclusion as the primary review outcome, including the deterministic scope notice, alongside coverage and grounded findings. `not-inspected` is an incomplete inspection, not a completed code review. Empty findings after actual partial inspection remain valid, but never constitute approval.

Issue code is pinned to the recorded default-branch commit. PR results record `source.head` (head repository/commit/tree), `source.baseTip` (observed base branch SHA) and `source.base` (the selected repository's **merge-base** commit/tree). The `base` tool alias and deleted-line citations refer to that merge base, not the base branch tip. Renames use the previous path on the base side. Source metadata is rechecked after collection and after inference; issues also recheck the default branch at the end. A changed source/head/base rejects with a read-only `source_changed`, not a supposedly current result. For this first release, **any issue default-branch movement fails the run**, even if unrelated to the inspected files; there is no stale-success outcome. Later callers must still detect changes after `verifiedAt`.

Changes come from immutable `compare/{baseSHA}...{headSHA}?per_page=1`, never mutable PR file pages. The [GitHub compare contract](https://docs.github.com/en/rest/commits/commits#compare-two-commits) supports commit SHAs across repositories in the same fork network. It returns at most 300 files on the first page independently of commit pagination; this backend retains at most 100. Unavailable comparisons or deleted/inaccessible forks fail explicitly, without falling back to another repository or mutable refs.

Only `list_code` and `read_code` are available. Their host handlers validate arguments again (SDK 1.0.13 `defineTool` does not perform validation). They close over recorded repositories/tree/blob SHAs and accept only a revision alias, literal path/prefix and bounded offsets/line ranges. They cannot choose a repository, ref, host, URL, credential, shell command or write method. Blob bytes must match the tree's blob SHA. Repository content and owner instructions cannot change capabilities.

The dedicated `CodeGitHubApi` implements the existing request interface with fixed-host HTTPS GET routes, the operation's ephemeral credential and `redirect: 'error'` **before any redirect is followed**. It ignores API-supplied download, pagination and other URLs. The existing `GhApi` and collectors are unchanged. Other SDK restrictions, isolated HOME/config, unconditional permission denial and the service's single-client busy guard remain active; only these two validated read tools skip permission prompts.

| Code-job bound | Maximum |
| --- | --- |
| Entire operation, including authentication/source reads/inference | 180 seconds, plus bounded cleanup |
| GitHub requests / SDK tool calls | 40 / 24, including failed calls |
| HTTP response body / total HTTP body bytes | 2 MiB / 8 MiB, counted while streaming, including JSON whitespace |
| Emitted prompts, instructions, tool declarations/results | 180,000 serialized UTF-8 bytes in total, including the one correction prompt |
| Source body / retained patches | 32,000 / 60,000 UTF-8 bytes |
| Repository tree / file list page | 4,000 entries per revision / 100 entries per tool call |
| Regular UTF-8 file / read range | 128 KiB / 200 lines per call |
| Model output | 60,000 bytes per answer, at most one format/grounding correction |

Results always have `coverage.status: 'partial'`: bounded, selective inspection is not whole-repository verification. `coverage.changes` is complete only when every reported changed file has a complete patch and every changed line was returned by a read tool with matching patch text. `files` reports expected, compared, retained, omitted and incomplete-patch counts. `knownChangedLines` excludes unavailable patches; it is not a total when files/patches are missing. Evidence records preserve exact read ranges, text, blob and revision provenance. Findings must cite returned lines verbatim; PR locations must start on a matching changed line. Structural grounding is not proof that the model's reasoning is correct.

Missing/truncated patches, capped trees/files/source bodies, binary or non-UTF-8 files, symlinks, submodules, oversized files and inaccessible paths are explicit coverage warnings. Comments/reviews/checks and private task notes are not collected. Tools support listing and reading, not repository-wide text search or execution. Budget exhaustion, malformed output, cancellation and deadlines return `ServiceError`; fatal tool budgets abort inference even if the SDK swallows the tool error. Cancellation reaches HTTP and SDK abort/disconnect/delete/force-stop cleanup. No local repository checkout or repository code is executed.

`test/code-review.test.ts` uses stubbed GitHub/SDK dependencies, including real host-tool handlers. `test/protocol.test.ts` covers the public RPC. The preserved #47 source passed separately authorized, isolated live SDK 1.0.13 smokes for an implementation assessment of #46 and review of merged PR #48: actual read tools, grounded result persistence, partial notices and natural host exit succeeded. The implementation smoke required one format correction; these checks do not imply general model reliability. Final integration reuses that evidence without repeating paid calls.

An earlier authorized attempt rejected grounding and timed out; its model payload was not retained, so its grounding cause is unknown. It exposed an SDK 1.0.13 `sendAndWait` idle timer that survives disconnect/forceStop. `src/sdk-client.ts` now waits using public `send`/`on`, with a shared abort signal, final-assistant semantics, and deterministic timer/subscription cleanup. Installed-SDK tests use a synthetic stdio runtime (no model) for send rejection, error/idle-before-ack races, deadline and cancellation. Source/model text never enters diagnostics; grounding diagnostics identify fixed reason categories only.

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
| Overall deadline | 120 seconds; `work.collect`, `work.assess` and `work.rank` get 300 seconds; `work.reviewCode` gets 210 seconds; cancellation propagates into gh/SDK cleanup |
| GitHub collection | 90-second budget; three concurrent enrichment workers, one refresh at a time |
| gh process | 20 seconds, 4 MiB combined stdout/stderr |
| Copilot concurrency/deadline | One SDK operation, 90 seconds including setup/inference; each assessment/order pass and GitHub reply batch gets 180 seconds, with assessment plus ordering bounded to 300 seconds total |
| Copilot payload/answer | 60,000 bytes each; each work assessment/order input allows 240,000 bytes; at most one format/reference correction per pass within its deadline |

Send `cancel` with `{ "requestId": "refresh-1" }` and a new envelope ID. Its result reports whether the target was active; the target receives its own cancelled result. Closing stdin, SIGINT, or SIGTERM cancels active work and closes owned resources. EOF is shutdown, not a flush-and-wait instruction. Native should allow bounded cleanup before forcibly terminating an unresponsive process.

Input cancellation and EOF cleanup do not wait for stdout progress. A broken output pipe is terminal: cancel all active operations rather than attempting another response. Native should continuously drain stdout/stderr and launch the sidecar in an owned process group. Neither the gh runner nor the SDK starts a detached process; group-level shutdown can escalate from SIGTERM to SIGKILL for the entire owned descendant tree.

The host must expose only these operation names through its native command, not a generic shell/HTTP interface. Workstream operations accept schema-validated saved queries, model names, server names, and explicitly selected read-tool names. They never accept renderer-supplied commands, configuration JSON, credential headers, environment, filesystem paths, or executable endpoints. Disable external page access to the native bridge.

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
| `work.collect` | `workCollectInputSchema` | Candidates with immutable evidence, current source observations, and bounded-coverage warnings |
| `work.assess` | `workRankInputSchema` without `assessmentIds`, requiring `profileId` | A nonempty subset of at most 20 immutable assessments |
| `work.rank` | `workRankInputSchema`, requiring `profileId` and saved `assessmentIds` | Exact permutation of the active queue, one reason per task, and optional `evaluatedAt`/`expiresAt` |
| `work.reviewCode` | `codeReviewInputSchema` | `code-review-v1` with grounded answer, pinned source/config, partial coverage and read evidence |
| `work.connections` | `{}` | Configured MCP server/read-tool names and explicit setup instructions; no secrets |
| `work.intake` | `{}` | Up to 200 unconsumed durable push items and `hasMore`; reading never deletes |
| `work.ackIntake` | `{ids}` | The same acknowledgement, after the desktop has saved those items |
| `cancel` | `{requestId}` | `{requestId, cancelled}` |

All objects are strict: unknown keys fail validation. Thread IDs are positive decimal strings. Repository references are `{repo: "owner/repo", number: positiveInteger, kind: "pr" | "issue"}`. Evidence/context IDs allow up to 500 characters. The service constructs all network endpoints itself.

Code operations retain their 180-second overall deadline, including the single correction attempt, plus bounded cleanup. The JSONL watchdog allows 210 seconds and the native host 240 seconds. For code cancellation, an ACK is not a terminal outcome: native waits for the target's own response after SDK cleanup rather than killing the service on the ACK. Native timeout/quit still stops the owned process group.

### Workstreams

[`src/work-schema.ts`](src/work-schema.ts) defines the shared workstream DTOs. Run `work.collect` separately for each enabled stream, reconcile and save its results, then call `work.rank` once for the entire active queue. `createHandler` accepts an optional third `WorkService` dependency. The service does not schedule runs.

`work.collect` takes `{stream, model, since, knownUrls?, observeOnly?}`. `knownUrls` defaults to `[]` and accepts at most 100 tracked source URLs. Pass tracked GitHub issue/PR URLs even when they no longer match the saved query. For additional tracked-source batches, set `observeOnly: true` (default false) to read source state without repeating GitHub search or MCP extraction. Those reads yield `open`, `queued`, `closed`, `merged`, or explicit `unknown` observations. An absent search result is never evidence of completion. MCP pull also performs bounded actual GitHub state reads for linked targets and tracked URLs; it never invents their state from Slack text. Canonical `/issues/N` URLs for PRs are detected through the issue API's `pull_request` field and read as PRs, including current merge queue membership.

The desktop removes already-observed canonical URLs from later tracked-source batches in the same run, including `unknown` observations. Each stream still performs its own discovery. Failed operations do not count as observations, and the next run checks sources again. Authentication and rate-limit failures stop observation workers after at most the already in-flight reads instead of repeating the failed request for every remaining URL.

The desktop persists `work.collectionCursor` separately from `lastCompletedAt`. Collectors receive that cursor as `since`. A fully successful, durably saved run advances the cursor no later than its **start**, not its completion after ranking; events arriving during collection or ranking remain eligible for the next run. Notification collectors can return `coveredThrough` to checkpoint a smaller, oldest-first interval. The desktop takes the earliest returned boundary across sources, rejects nonprogressing or future boundaries, and shows remaining history across relaunch. `lastCompletedAt` still records actual completion for display and scheduling. Failed runs retain the prior cursor. Older saves default to a null cursor and safely rescan. Changing source streams or the collector model resets the cursor to null; an in-flight run cannot claim coverage for changed settings. Ranking instructions and cadence changes do not reset source coverage.

GitHub search streams (`kind: "github"`) use the saved expression, independently of notification streams (`kind: "github-notifications"`). Supported GitHub actions are `review`, `fix`, `reply`, `merge`, `implement`, `follow-up`, and `manual` (also exported as `githubWorkActionSchema`). The shared workstream schema rejects GitHub `review-result` at the action field, so invalid settings fail before any source request (`invalid_input` at the service boundary); MCP pull and push intake continue to support it. The backend replaces `@me` with the authenticated viewer and sends a single URL-encoded query to the search API with `is:open archived:false`. User text never becomes shell syntax. Search reads up to two 100-match pages, deduplicates overlapping results, and returns at most 200 candidates plus 300 observations. It warns only when matches remain or results are incomplete, not merely when an exact page or 200-match boundary is reached. Three workers enrich matched and tracked sources; GitHub collection including reply extraction has a 270-second deadline. PR reads include real `mergeQueueEntry`, head SHA, review decision, mergeability, and at most 100 checks. Timeline reads cover the first and latest 100-event pages. Intentional timeline gaps, unavailable original request ages and capped checks return neutral `coverageInfo`; incomplete searches and failed reads still return blocking `warnings`. Incomplete checks never establish merge readiness. Cached timelines retain their coverage notes across restart without preventing successful scan checkpoints.

Saved-search collection uses a private SQLite cache in `work-github-cache/cache.sqlite3` beneath the app data directory. Keys include the GitHub account ID/login, host, complete stream settings, model, and cache format version. Every run checks the account before reading the cache and again before committing/returning it. Every returned cached source receives a live authenticated root read; denied/deleted sources return `unknown` without cached content or candidates. Open PRs always fetch their current GraphQL checks, head, review decision and queue state, even when their issue timestamp and search membership did not change.

A complete baseline enables `updated:lower..scanStart` discovery, sorted oldest first. The lower bound is the earlier of the desktop cursor and successful backend scan, minus **five minutes** (`SEARCH_OVERLAP_MS`). A full search runs at least every **six hours** (`SEARCH_RECONCILE_MS`), recovering removed membership, newly accessible sources and delayed indexing. Cached members and tracked URLs still get state observations between full searches; absence never means closed. Timeline reuse requires an unchanged root (including `updated_at`) and PR head/review decision, with a six-hour maximum age. Reply extraction reuses only successful, warning-free results for identical model input/settings, including empty results. GitHub search is eventually consistent; overlap plus full reconciliation mitigates index lag rather than claiming a transactional snapshot.

Incremental composition is deliberately conservative. Only recognized conjunctive non-date qualifiers and simple terms accept an appended range. Existing date qualifiers (including absolute `updated:`/`created:`), relative expressions, Boolean/grouped expressions, saved sort qualifiers, malformed quotes and unknown syntax keep the original full query and report neutral `coverageInfo`. No existing qualifier is deleted or replaced. Initial capped, duplicate-page or incomplete searches never establish a baseline; incomplete later reads retain the prior successful boundary. Refining a query is necessary when its complete active set exceeds 200 sources. Cached membership, pending discoveries and tracked observations must fit existing response bounds; overflow is an explicit `limit`, never silently truncated progress.

Each SQLite transaction durably stores reusable timelines/extractions and unacknowledged candidates before returning a successful collection. Pending discoveries replay while `since` precedes their collection time, including after a crash, failed desktop save or failed ranking; replay first rechecks access and current state. The desktop's earlier run-start cursor can conservatively replay an extra batch, which immutable evidence deduplicates. Storage uses private permissions, WAL, full synchronization and compare-and-swap revisions. Corruption, concurrent writes and storage errors fail explicitly. Limits are 100 cache scopes, 16 MiB per scope, 128 MiB total payload, 1,000 pending candidate records, and the existing 1 MiB response frame; pending results never expire to make room. Tests inject isolated temporary cache paths; production paths are backend-only.

Successful source observations also carry optional `context: {revision, title, body, labels}` separately from immutable evidence. Titles/bodies are complete, labels sorted, and the SHA-256 revision hashes the exact semantic context, not fetch timestamps. PR bodies retain the full original text followed by delimited deterministic current-state JSON, including check names/status/conclusions; current state is model-visible, not merely an opaque invalidation hash. All context remains untrusted source data. Bounds are 2,000 title characters, 100,000 body characters and 100 labels of 200 characters; oversized context reports unknown/error instead of truncating. Tracked-only reads emit the same context. Context cannot change owner titles, notes or handled evidence; persistence/ranking consumption is independent of collection.

For `review`, a current direct viewer request or a current explicitly selected `team-review-requested:org/team` request is required. Evidence uses the real `review_requested` event ID and occurrence time. Commits, comments, source `updatedAt`, query names, and collection time never create fresh review evidence. If the original request is unavailable, a deterministic source/recipient identity uses source creation time and explicitly reports unknown request age. Fix and merge requests use actual head/check/review conditions. Reply extraction uses Copilot against bounded source comments, not notification reasons. It groups whole source contexts into batches within 60,000 UTF-8 bytes instead of starting one session per issue. The model selects message references; the backend attaches original event IDs, timestamps, and source links. Invalid or duplicated references get one correction attempt. Rejected batches leave other discoveries and source observations intact with an explicit warning. Oversized individual contexts are skipped with a warning, never split silently.

Collectors return source/action candidates so every request keeps its evidence. The desktop combines all actions targeting a recognized GitHub issue/PR into one task keyed by its normalized URL, including requests from Slack and MCP. Non-GitHub task identity remains source URL plus action. Only recognized GitHub issue/PR references and Slack message permalinks discard query/fragment tracking context; generic MCP URLs preserve their paths, queries and fragments because those can identify distinct tasks or application routes. Stored canonical identities allow 2,014 characters: a 2,000-character URL, the longest action name, and a separator. Evidence and ranking task IDs keep their separate 500-character limits. Evidence IDs do not depend on stream IDs or query names; `streamId` records provenance. A Slack evidence URL remains its original message permalink even when the candidate targets GitHub.

The desktop owns Done semantics and preserves handled evidence across all actions on a GitHub task. Workspace loading consolidates existing duplicates before ranking, with a durable backup before saving the reduced task list. It retains the first task's ID, title and action, combines other titles and notes, merges provenance and handled evidence, and remaps saved ranking and selection. Any unfinished duplicate keeps the task open; all-Done groups keep their latest completion boundary, unless one lacks a reliable boundary. New discoveries cannot overwrite the owner's title or notes. Metadata's optional `availabilityObservedAt` records the last accepted source observation; consolidation and reconciliation must retain the newest observation so an older open result cannot undo newer merge-queue suppression. Older saved metadata without this field remains valid.

Notification streams fetch `/notifications` with `all=true`, including notifications read elsewhere. A null `since` starts with 30 days of history. Large backlogs are split into bounded chronological intervals; a successful run saves progress before the next interval. Optional `coverageInfo` describes known exclusions and remaining history without treating them as failed reads; real `warnings` still prevent cursor advancement. Source events, not notification `updated_at` or sticky `reason`, determine actionable evidence and its age. The notification stream chooses actions from inspected requests rather than applying the stream's placeholder `action` to every result. Saved searches remain separate and unchanged.

Each notification collection uses at most 32 probes of 50 notifications, narrowing `before` until a complete interval contains at most 28 issue/PR sources (at most 196 source/action pairs). It avoids offset pagination over a changing inbox. `since` rounds down with a one-second overlap, and partial checkpoints use whole seconds. A single indivisible second exceeding these limits produces an explicit warning without advancing the cursor; it never skips the excess. Unsupported subject types and archived repositories are known exclusions, not failed reads.

Notification-backed candidates carry optional `notification: {threadId, reference, updatedAt}` metadata for the existing `github.unsubscribe` operation. The desktop validates that this reference belongs to the candidate source, retains its newest observed timestamp, and shares subscription state across actions on the same conversation. It persists an `unsubscribe` intent in task metadata before dispatch. The service still preflights the actual notification identity and confirms `ignored: true`; neither task Done nor collection sends notification writes. The desktop verifies every echoed context field and retains failed or interrupted writes for explicit retry only.

Source observations can add `context: {revision, title, body, labels}` independently of immutable evidence. `revision` is a 64-character lowercase SHA-256 digest; title, body and labels allow 2,000 characters, 100,000 characters and 100 strings of 200 characters respectively. New source context is never truncated to fit. The desktop retains the newest context separately from owner title/notes and Done, even on tracked-only observations. Optional `contextObservedAt` preserves the last successful content observation when a newer source check is unknown; duplicate consolidation keeps the newest known content. These additions remain optional for older saves and non-GitHub tasks. Ranking carries explicit `availability`/`availabilityReason`, with last-known context treated as uncertain when availability is unknown.

#### Durable assessments and ordering

`work.assess` and `work.rank` separate two no-tools SDK phases. Both accept explicit `profileId`, semantic task inputs, optional `agents` and `force`, and legacy `instructions`/`model`. `src/work-agents.ts` defines the supported jobs and strict agent registry. Profile settings materialize exactly one definition per job; absent definitions inherit legacy owner instructions/model (or useful defaults for empty instructions). Definition IDs are stable; names are display metadata, not model input. Each role uses only its own instructions/model. Collection keeps its separate model.

`work.assess` returns `{assessments: SavedAssessment[]}` for a nonempty subset of at most **20 tasks**. Reusable results are delivered first without model calls unless `force: true` requests new judgments; otherwise it assesses one batch of at most **240,000 UTF-8 bytes**. The caller validates each subset, commits it through native `assessment_append`, and removes returned task IDs before requesting the remaining subset. Empty, duplicate, invented or mismatched identities fail explicitly. A failed later call leaves earlier assessments locally readable and cached for retry after restart.

`SavedAssessment` in `src/work-assessment.ts` is a discriminated union retaining v2 history and new `work-assessment-v3` results. Both contain immutable `resultId`, original task `id`, `profileId`, `evaluatedAt`, requested `model`, semantic `fingerprint`, `instructionsFingerprint`, and typed `assessment`. V3 also requires `agent: {id, name, jobType, configurationFingerprint}` and impact/visibility/effort `{rating, rationale}` fields; ratings are `high | medium | low | unknown`. Importance, urgency, blockers, supporting evidence, uncertainty and `reevaluateAt` remain. Native validation agrees with both formats and never upgrades or deletes old rows. No raw source body, private thread note, credential or credential-scope hash is returned. A blank model means SDK default; the resolved model is not reported.

When attaching a new result, native SQLite assigns a durable logical `TaskAssessment.sequence`. Retries preserve the original sequence. History pages and duplicate consolidation use that sequence, never `evaluatedAt`, so a backwards clock cannot make a newer result look older.

`work.rank` requires `assessmentIds`, exactly the saved result IDs for the submitted tasks. It verifies IDs against the current credential/profile/assessor/input scope and expiry before ordering; it **never reassesses**, including direct SDK-service calls. Missing prerequisites return `assessment_required` with an assess-first instruction. `force: true` bypasses only order reuse. Ordering receives concise assessments and evaluation times, not full notes or source bodies. Both model phases validate exact task permutations and evidence references. Unknown availability requires nonempty uncertainty. Owner instructions guide only the selected role's judgment; source text and saved results remain untrusted. Neither role has tools, MCP, memory or access to other sessions.

Task fingerprints include effective title/notes, action, URL, creation time, evidence content/source/event time, current source content/revision and availability/reason. Assessor configuration identity hashes its ID, job type, instructions and model, excluding display name; prioritizer identity affects only order reuse. Evidence order, duplicate stream provenance, label order and observation timestamps do not invalidate them. Existing title/note bounds remain. Bump `ASSESSMENT_VERSION` for changed assessment meaning, canonical inputs or assessment prompt, and the separate order format for changed ordering semantics.

Each assessment is valid for at most **24 hours**. Both prompts receive an explicit UTC `evaluatedAt` (not part of the semantic fingerprint). Models must choose `reevaluateAt` between one minute and 24 hours after assessment, earlier for deadlines, aging commitments or uncertain blockers. Comparative ordering gets its own one-minute-to-**one-hour** reevaluation time, capped by the earliest assessment expiry. Expired ordering alone needs only the ordering pass. If no semantic input, queue membership or expiry changed, the service returns the stored order without starting the SDK, including after restart. A backwards clock invalidates future-dated judgments. Output already expired by completion fails explicitly rather than looping.

The cache is backend-owned SQLite at `sdk-sessions/work-assessments.sqlite3` beneath the private app data directory. Directories/files use modes 0700/0600 on creation; SQLite uses synchronous full commits and a bounded rollback journal. It stores derived assessments and one comparative order per scope, not raw task bodies or credentials. A domain-separated SHA-256 scope includes the ephemeral `gh` credential, profile ID, exact instructions, model and format version. No credential or scope digest reaches renderer results or logs. Each RPC pins its in-memory credential; if it changes between assessment and ordering, the supplied result IDs cannot match the new scope and ordering fails without reassessment. Credential rotation conservatively invalidates reuse; a cache hit does not claim fresh authentication or source access verification.

Assessment commits and delivery precede ordering, so a failed order does not discard successful task history. The reuse cache replaces each scoped task's prior assessment; permanent native `task_assessments` rows do not. History is outside the **8 MiB** snapshot limit. Cache limits remain **10,000 records / 32 MiB payload plus keys**, with a **64 MiB SQLite file ceiling**; capacity failure rolls back the write and returns `assessment_capacity`, never silently evicting entries. Corruption or unavailable storage returns `assessment_storage`, not an empty success. To reset a full or corrupt derived cache, export pending results first, quit the app, back up this specific file and remove it before relaunch; saved permanent history remains in workspace.sqlite3. The next run reassesses from saved inputs.

Every fresh pass retains the 240,000-byte input/60,000-byte answer limits, one correction attempt and 180-second SDK deadline; the complete operation stays within 300 seconds. An oversized individual task or whole-queue assessment input fails without truncation, partial ordering or heuristic fallback. Validated results retain the `orderedIds`/`reasons` contract, adding `evaluatedAt` and `expiresAt`; the desktop preserves the actual evaluation time on cache reuse. During an in-flight edit it excludes stale results for changed tasks, accepts harmless observation timestamp updates, and retains the existing safeguards for Done, captures and changed settings. Empty queues need no cache or SDK access.

`normalizeWorkUrl` applies the source-specific URL rules to service candidates and evidence identities as well as intake. In particular, generic `task?id=101` and `task?id=102` cannot share an evidence identity merely because their source event IDs match. Every collector reports `collectedAt` from the start of collection, not its completion, so the next successful watermark need not skip messages arriving while reads were in flight.

#### Existing Slack / MCP connections

Copilot App connections are **not automatically shared** with this service. Backend discovery reads only the supported Copilot CLI `~/.copilot/mcp-config.json`, or an absolute path explicitly provided through backend `COPILOT_MCP_CONFIG_PATH`. It never reads app databases, keychains, or renderer configuration. Use **Read MCP connections** to check whether the selected server is configured.

Use the [official Copilot CLI MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-server) with `/mcp add`, or explicitly export/copy an existing configuration into a private backend file. The official Slack endpoint is `https://mcp.slack.com/mcp`. Existing `oauthClientId` and `oauthPublicClient` fields are preserved from that backend configuration through SDK serialization; no organization-specific client ID is embedded in this repository.

Selected collector sessions use SDK `mode: "copilot-cli"` with `mcpOAuthTokenStorage: "persistent"`. Empty mode disables keychain access at process startup even when a session requests persistent OAuth, so it cannot reuse CLI keychain sign-in. Only selected MCP collectors use this mode and the existing user's HOME and CLI configuration directory (`~/.copilot` by default); backend `COPILOT_MCP_OAUTH_CONFIG_DIR` may name an explicit absolute shared CLI OAuth configuration directory. The working directory remains private. Explicit session restrictions still disable discovery, instructions, file hooks, plugins, memory, session-store access and all tools other than the selected MCP read tools; the environment-context prompt section is removed explicitly. Ranking and other no-tools operations retain empty mode and private HOME/configuration. The service itself never reads keychain tokens or imports app databases.

OAuth stays runtime-owned: collectors must not register `onMcpAuthRequest`, which opts into host-provided credentials instead of reusing runtime sign-in. A cancelling handler prevents an already authenticated CLI connection from working. Missing authentication still fails collection; it never becomes an empty successful scan.

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

`source` is `copilot` or `mcp`; `producer`, immutable external `eventId`, and actual `occurredAt` are required. A completed AI review supplies `review-result` evidence. When it targets a GitHub PR, the desktop combines it with other requests on that PR and applies the shared Done boundary; it does not create a separate review-result row. HTTPS source links cannot contain credentials; malformed, oversized or future-dated events are rejected. Do not generate event IDs from submission time when replaying the same event.

The database is private and independent of the repository: on macOS, `~/Library/Application Support/io.robertcrandall.github-projects-workspace/work-intake/intake.sqlite3`. Other platforms use the same app namespace under their user application-data directory. SQLite uses WAL, full synchronization, a five-second busy timeout, a private directory and `0600` database permissions. Producer/source/event identity makes retries idempotent. Conflicting reuse fails; consumed identities remain as replay tombstones. The store refuses more than 100,000 identities rather than silently expiring them.

The desktop must read `work.intake`, reconcile and successfully save the native workspace, **then** call `work.ackIntake` with only the saved item IDs. A crash before acknowledgement re-delivers the same IDs safely. ACK never completes a user's task. `hasMore` means read the next page after saving and acknowledging the current page.

The MCP adapter implements newline-delimited JSON-RPC `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. It negotiates `2025-11-25`, `2025-06-18`, `2025-03-26`, or `2024-11-05`; unknown versions receive the latest supported version. Frames are capped at 32 KiB; writes time out after two seconds. Stdout contains protocol frames only. EOF closes the database. The external caller—not the desktop—owns permission to invoke this write tool.

Workstream tests inject runners, SDK clients, configuration reads and store paths. They cover immutable request identities, source grounding, ranking permutations, authentication failure, durable replay/ACK, and packaged MCP-to-desktop round trips. A real CLI/SDK smoke with a synthetic read-only MCP server produced a validated review candidate and preserved its message permalink. This verifies the collector transport, not an unavailable real Slack connection. The fallback-freshness test was mutation-checked by replacing source creation time with run time: it failed, and the original logic was restored.

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

GitHub requests are not a transaction. Concurrent source changes may require a later manual refresh. Missing/failed source reads do not confirm terminal status; the client exposes saved coverage and fails open for suppression while preserving local checkpoints and manual Archive. Notification refresh does not search repositories, poll, auto-refresh, or asynchronously reorder after returning a batch.

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

For no-tools operations, the SDK receives a fresh private temporary HOME/config/working directory, `mode: "empty"`, disabled discovery/tools/MCP/skills/file hooks/custom instructions/extensions/plugins/memory/session store, and an unconditional permission rejection callback. No custom tools, hooks, question handlers, files, attachments, or remote sessions are configured. Selected MCP collectors use the explicitly restricted CLI-mode exception described above. Runtime credentials come from supported `gh auth token --hostname github.com`, passed only as ephemeral `gitHubToken`. Ambient credentials/config variables are not forwarded to the Copilot child. The service does not inspect/copy Copilot keychain or token files.

Empty mode disables keychain access; unsupported Copilot-only authentication cannot silently switch the service into a less isolated mode. Missing gh/CLI/auth/Copilot access is explicit. GitHub notifications need classic `notifications` or `repo` scope; private source enrichment needs `repo`, and team membership needs `read:org` (or its parent scopes). Connection check does not fetch notifications.

SDK 1.0.13 has no schema-constrained response option. The service requests the exact JSON schema and waits for completed assistant content. It accepts plain JSON or one exact whole-response `json` code fence, never prose/fragment extraction. Strict Zod validation still rejects extra fields, fabricated IDs, invalid actions, and incomplete/duplicate orderings. One corrective generation can repair JSON/schema format, within the same restricted session/deadline; grounding failures are rejected.

Model suggestions cannot start, finish, defer, acknowledge, unsubscribe, change handled state, or override request identities. A review suggestion requires cited current unhandled request evidence. Uncertain coverage requires explicit uncertainty. Captured daily routine time/timezone must match the supplied capture. All results are `previewOnly: true`; human application remains the caller's responsibility.

Sessions and temporary private state are deleted during cleanup. After session disconnect/delete, the service uses the public SDK `forceStop()` directly. SDK 1.0.13's graceful `stop()` drops its child handle before confirmed exit, making later kill escalation ineffective; that path is not used. A synthetic SIGTERM-resistant runtime test verifies actual process termination through the public SDK API. Cleanup failures emit fixed stderr diagnostics. The service is a single-user process with capability restrictions, **not an operating-system sandbox**. Forced termination or power loss can leave a temporary SDK directory; those files are not durable app storage.

## Validation

Tests use synthetic gh/API and SDK responses. They cover pagination, read/unread notifications, recipient-specific requests/removals/reviews, sticky reasons, merge queues, re-requests, scope/access failures, malicious URLs, exact write semantics, permission/input restrictions, structured previews, cancellation, and the compiled JSONL roundtrip.

The merge-queue regression was verified by temporarily classifying queue events as review requests: the test failed at that exact event kind. The correct classification was restored and the suite passed.

The compiled roundtrip test skips only when no artifact exists; build before running release tests. No automated test sends a GitHub write or uses a real model.

The explicit optional smoke below performs one tiny synthetic SDK inference (at most one corrective format retry), from a temporary non-repository cwd. It requires authorization because it consumes Copilot service access:

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
