# Current Session Handoff

## Current release

- Bridge package: `6.3.0`.
- Extension manifest: `2.3.1`.
- Content runtime: `4.3.1`.
- Extension protocol: `5` only.
- Background persistence schema: `6` only.
- Workflow runtime schema: `3` only.
- Interactive dependency: exact `terlio.js@1.1.0`.
- `package-lock.json` references public npm registry URLs only.

## Canonical architecture

- The server request reducer is the only owner of request lifecycle, completion, errors, blockers, deadlines, and release intent.
- The extension background owns tab leases, the per-tab operation queue, command/effect ledgers, transport epochs/sequences/outbox, and download capture.
- Content owns one `TabObserver` parser pipeline and explicit DOM executor adapters. It does not materialize terminal request state.
- Active requests and passive workflows consume the same immutable `TabObservation` and response-epoch identities.
- Direct request-projection assignment is forbidden; content uses closed typed update groups.
- Only canonical request commands carry a request lease. Standalone commands are persisted and correlated without creating a `TabLease`; mutating standalone operations are exclusive and read-only diagnostics may coexist with an active request.
- Correctness-critical reducer transitions atomically append exact immutable outbox envelopes; server ACK removes only the exact `messageId`. Normal observations are replaceable and are not persisted.
- Result commands settle only from command terminal envelopes; effect-backed commands only from linked physical BrowserEffect terminals; release only from lease terminal envelopes. Acceptance and progress never settle correlation.
- Unconfirmed browser writes are not retried. Prompt submission is one attempt; ambiguity becomes a typed uncertain effect.
- Browser-effect reconciliation is kind-specific and read-only; prompt, steering, attachment, model/session, artifact, download, and cancel outcomes require exact evidence rather than phase inference.
- Download captures persist lease/effect/artifact identity. Indirect downloads require lease, artifact candidate, source turn, exact normalized name, and capture-window agreement; filename alone is insufficient.
- The per-tab queue has priority classes and reserved critical capacity while preserving source sequence inside one transport stream; it exposes cancellation, rejection, and high-water metrics.
- Physical BrowserEffect records contain full command/request/epoch/precondition/timestamp/reconciliation identity; dispatched cancellation requires proof that no write occurred.
- Background schema 6 atomically commits correctness-critical reducer state with its exact immutable terminal outbox envelope. Legacy v1-v5 namespaces are never adopted and are cleaned only after their records are confirmed idle.
- Active and passive completion consume one shared turn-evidence classifier.
- Every server-to-extension command carries a durable `commandId`. Effect-backed commands atomically create their dispatched BrowserEffect before content execution; content cannot invent or replace the physical effect identity.
- The floating page panel and DOM observation runtime mount only after canonical server handshake and detach fully while Bridge is disconnected.
- Pre-dispatch `command.rejected` may fail an operation. Once an effect-backed command is accepted, only its linked physical BrowserEffect terminal may settle request execution.

## 6.3.0 Protocol 5 atomic publication hard cut

- Protocol 5 replaces Protocol 4 completely. Server and extension import one shared direction-aware manifest and validator; payload-kind inference, prefix classifiers, and compatibility terminal mappings are removed.
- Effect-backed command acceptance atomically creates the command record, dispatched BrowserEffect, and exact `command.accepted` outbox entry before content executes. A physical BrowserEffect terminal atomically updates reducer state and appends exactly one immutable effect terminal envelope.
- Record-scanning terminal reporting, `reportedAt`, and terminal-envelope reconstruction are removed. ACK deletes only the exact persisted `messageId`; concurrent flushes rerun from persisted outbox state.
- Result commands, effect-backed commands, and release commands have disjoint terminal contracts. Telemetry cannot settle correlation, and one physical browser operation cannot produce competing command/effect terminal lifecycles.
- The extension background owns release completion. Content supplies only cleanup evidence. Proved cleanup creates `lease.released`; unresolved cleanup creates `lease.quarantined`, and quarantined tabs are excluded from scheduling so unrelated requests can continue.
- The canonical server reducer is the sole owner of `responseEpoch`. Background validates the dispatched epoch and reports effect evidence without independently advancing logical response state.
- Mutable coordinator lifecycle shadows (`accepted`, `promptSubmitted`, `currentGenerationActive`, `cancelRequested`, and `done`) were removed. Canonical lifecycle, disposable resources, and output accumulation are separate domains.
- Cross-layer Protocol 5 trace tests replay command acceptance, effect settlement, exact outbox ACK, release, quarantine, and concurrent outbox append. Source gates reject Protocol 4 files, classifiers, terminal content aliases, record reporters, and lifecycle shadow fields.

## Workflow implementation

- `/workflow` is the single normal interactive entry point and no workflow starts from an ordinary prompt.
- The three presets share one workflow v3 reducer and one `nextAction` decision contract.
- Workflow-owned Git aggregation is part of canonical v3 state, so checkpoint SHAs, base SHA, owned paths, expected path states, and the final commit message survive restart.
- Passive observation is a subscription/capability, not a separate watcher lifecycle.
- Startup uses a hydration barrier before a workflow becomes routable.
- Stop and pause use settlement barriers and cannot advertise a terminal control state while dispatched or uncertain effects remain unresolved.
- Checks, verify, plan, apply, rollback, commit, squash, and starting-state restore use durable local-effect records with idempotency and precondition guards. Write recovery requires receipts or exact filesystem/Git evidence.
- Session handoff and queued passive turns are protected by binding epochs.
- The independent workflow worker persists upstream identity, stream epoch/cursor, last durably enqueued event, and connection/block state. A retained-history gap becomes a canonical resync/stop action.
- `bridge-result.json.files` is optional and advisory. Effective changes are derived from the transactional project diff; bridge control files are never written into the project.

## 6.2.6 terminal outbox correlation and silent test environments

- Durable reporting now treats only exact terminal command/effect envelopes as persisted results. A queued `command.accepted` or `request.effect.started` with the same identity can no longer suppress a later terminal release/effect result.
- Steering keeps a single submission attempt but waits up to 10 seconds for DOM proof, instead of inheriting the 4-second ordinary prompt acknowledgement window.
- Node unit tests suppress workflow bells and native desktop notifications through `NODE_TEST_CONTEXT`; real E2E bridge and worker processes set `BRIDGE_DISABLE_NOTIFICATIONS=1`.
- The conversation continuity E2E validates remembered prior output through a deterministic conditional token rather than asking the model to reproduce arbitrary text character-for-character.

## 6.2.5 disconnected-runtime inactivity and safe page hooks

- The content DOM runtime is inactive until a canonical `server.hello` arrives. Disconnect, authentication failure, or unreachable Bridge status removes the MutationObserver, polling, history/navigation hooks, foreground listeners, and floating panel.
- Main-world artifact capture installs anchor, Blob URL, and `window.open` interception only while an exact capture is armed. `URL.revokeObjectURL` is never replaced, preventing interference with ChatGPT voice recording and other page-owned media Blob lifecycles.
- Extension deployment compares full bundle fingerprints, preserves the stable unpacked-extension root directory, and reloads changed bytes even when extension/content version strings are unchanged.
- The durable terminal reporter coalesces concurrent triggers without losing a second pass, closing the release-report race observed in real E2E run `8cfc033cdcd0`.

## 6.2.4 cancel release settlement and workflow context ownership

- Raw `prompt.cancelled` content results are normalized into an explicit terminal `command.result` before background command reduction. A physically succeeded cancel therefore closes its durable command and allows an already-ready `request.release` to atomically remove the lease.
- Canonical cancellation still comes only from the persisted physical `prompt.cancel` BrowserEffect. Command settlement closes correlation and the release child barrier; it does not independently materialize request lifecycle.
- Startup and manual project-context synchronization acquire a short owned `context_sync` workflow run before creating `LocalEffect(PROJECT_SNAPSHOT)`. The local-effect precondition was not weakened and snapshots can no longer execute outside a run.
- Post-apply remote context recording now runs before the owning workflow reaches `RUN_COMPLETED`. It reuses the operation's run instead of starting a second maintenance run that could overwrite the user-visible terminal outcome and commit evidence.
- Regression coverage reproduces the `last-real-e2e(31)` chain: ambiguous steer, successful physical stop, unclosed cancel command, blocked release/cleanup, and startup context snapshots rejected for lacking a run.

## 6.2.3 steer settlement and epoch ownership

- Content telemetry, diagnostics, and `request.effect.*` messages no longer settle a correlated browser command. Only an explicit terminal `command.result`, typed command result such as `prompt.steered`, or `command.error` may complete correlation.
- `prompt.steer` keeps the current response epoch until a new submitted user turn is proved. A successful steer advances the background `TabLease` epoch and canonical server response epoch exactly once from `N` to `N+1`.
- Ambiguous steer submission persists `BrowserEffect.uncertain` under the original epoch. Its command error preserves typed recoverability, allowing canonical reconciliation and later cancel/release to use the unchanged lease identity instead of creating an epoch mismatch.
- Steer submission without a visible send button prefers the React keyboard Enter path. It remains a single attempt; absence of a new user turn becomes uncertainty rather than a form resubmission or guessed success.
- Server-planned prompt continuation steps now send a dedicated `prompt.execution.step.completed` terminal result after durable physical settlement. Progress diagnostics and effect-start telemetry cannot accidentally complete those commands.
- Regression coverage reproduces the `last-real-e2e(30)` failure chain: premature steer success from telemetry, response-epoch divergence, rejected uncertain effect, failed cleanup cancellation, and a lease that remained attached to the interrupted request.

## 6.2.2 live E2E control and timeout hardening

- Active-request tab reload is a request-scoped reconciliation control carrying the exact canonical request, lease, owner, source client, and response epoch. Standalone reload remains a maintenance operation and cannot mutate a leased tab.
- `prompt.steer` and `prompt.cancel` are server-planned BrowserEffects with stable effect identity, idempotency key, preconditions hash, attempt, and retry policy. Content no longer fabricates descriptors for control writes.
- Cancellation becomes canonical only after the durable physical `prompt.cancel` result proves generation stopped. Command acceptance alone cannot materialize `cancelled`; delivery failure produces a typed recoverable failure when no physical effect record exists.
- Browser-effect success preserves its typed outcome message through the protocol adapter, so cancellation reason and reconciled outcome remain canonical evidence.
- Real E2E enables six-minute absolute prompt and asynchronous-turn limits by default. Explicit zero still disables either limit; `reload-mid-request` retains its independent ten-minute ceiling.
- Failed scenario recovery waits for a continuously idle canonical and physical release projection before reusing or reloading the tab. A failed reload can no longer leak an active request into response parsing or later artifact scenarios.
- Regression coverage reproduces the live `last-real-e2e(28)` failures: active leased reload, missing steer/cancel descriptors, cancellation settlement, cascading Markdown failure, and disabled default wall-clock limits.

## 6.1.0 final v3/v4 architecture hard cut

- Protocol 4 now has one observation message, `tab.observation`. The transitional `request.observation` alias and permissive unknown-payload fallback were removed; unsupported payload types fail immediately.
- Background runtime schema 5 starts a clean persisted namespace. Legacy v1-v4 records are never adopted and are deleted only after every legacy/current lease, command, effect, outbox entry, and download is proven idle.
- The physical BrowserEffect ledger is self-contained: command/causation identity, response epoch, preconditions hash, attempt, planned/dispatched/settled timestamps, reconciliation evidence, cancellation evidence, and report state are persisted together.
- A dispatched browser effect can be cancelled only with explicit `provenNotExecuted` evidence. Ambiguous interruption remains `uncertain` and cannot be silently converted into cancellation.
- The per-tab executor now has owner-invalidation, release, request, reconciliation, read-only, and maintenance priorities plus reserved critical capacity. Priority cannot reorder envelopes inside the same transport sequence.
- Normal observations are no longer placed in the durable outbox. Only command/effect results and explicitly forced reconciliation snapshots survive disconnect; normal state is refreshed from a new full observation after reconnect.
- Passive observed-turn deduplication and request reconnect/rehydration were split out of `BridgeClientEventRouter`. All source-tested composition roots and stateful coordinators are now enforced at 500 lines or fewer.
- Architecture tests reject legacy observation vocabulary, incomplete effect cancellation, unreserved release queues, premature queue completion, unsafe legacy-state cleanup, and reintroduction of transitional protocol aliases.

## 6.0.19 transport ownership, steer, and artifact isolation

- `BrowserExtensionHub` is now a transport-only connection/router surface. It no longer creates, caches, validates, or releases request leases and has no release registry. Immutable request identity comes only from canonical request state; background is the sole `TabLease` owner.
- Protocol commands have two explicit scopes. Request commands carry the canonical request envelope. Standalone diagnostics, artifact fetches, session administration, and maintenance carry no request envelope even when their payload includes a request ID for correlation.
- Read-only standalone commands may run under an active request lease. Mutating standalone commands are serialized independently and are rejected while a request or another standalone write owns execution. They can no longer appear as `activeRequest` after reconnect or poison later prompts.
- `BridgeCommandRegistry` owns command correlation and the source release barrier. Timeout or abort first sends `command.cancel` and waits for its physical settlement; rejected transport delivery immediately settles the pending command.
- Canonical coordinator effects and physical browser effects use independent reducer domains. A steer coordinator effect may overlap the browser effect it dispatches without triggering a false parallel-effect conflict.
- Steering waits for canonical prompt submission plus active generation before dispatch. It no longer relies on disposable content phase flags or races a response that has already completed.
- Reasoning result validation accepts locale grouping separators while still requiring the exact integer value.
- Regression coverage reproduces the live failure chain from `last-real-e2e(27)`: formatted reasoning result, in-flight steer, timed-out artifact materialization, cancellation settlement, next prompt acceptance, and cleanup without a resurrected command request.

## 6.0.18 reload-boundary and graceful-E2E hardening

- The proved submitted user-turn boundary is persisted in canonical request state. A content reload may restore only the physical lease; missing or stale content anchor fields can no longer override the server-owned response boundary or keep a completed answer permanently `generation.active`.
- `client.ready` reattaches the canonical request and sends a typed `request.resume` projection containing response epoch, submitted user turn, and assistant turn anchors. Content applies that projection through its closed `request.anchor_updated` event and immediately emits one fresh normalized observation.
- The reload recovery regression reproduces the live sequence from E2E run `b1f057cbb8ef`: prompt submitted, active response observed, content reloaded to a lease-only projection, final stopped response observed, and the same request completed without resubmission.
- Real E2E reload waits now have a ten-minute wall-clock ceiling when the global absolute timeout is disabled. Repeated liveness/deadline events cannot keep the scenario alive forever.
- The E2E-owned server runs in a separate POSIX process group. One terminal Ctrl+C belongs to the parent runner; an immediate duplicate signal is ignored, while a deliberate later Ctrl+C still forces exit. Graceful cleanup can therefore interrupt canonical work, settle release barriers, write diagnostics, and stop the child in order.

## 6.0.17 observation performance hardening

- Composer-only and extension-panel mutations are filtered before the shared observation scheduler, so ordinary typing does not start a response-parser pass. Contenteditable nodes inside assistant turns remain observable.
- The normal latest-turn path performs one document-ordered turn query and parses only the requested recent assistant turn. Historic artifact recovery scans remain available only to explicit recovery commands.
- Normal observations no longer clone and sanitize final response DOM into `parserAudit.sourceHtml`; source capture occurs only when DOM timeline/fixture capture is explicitly enabled.
- Fallback polling is reduced from one second to five seconds. The 750 ms and 2,000 ms stability milestones use dedicated timers, preserving canonical completion timing without repeated idle DOM scans.
- A tab-observer performance ledger exposes collect counts, ignored mutation batches, and slow-pass diagnostics. Regression tests prove composer typing performs zero parser reads while turn/reasoning mutations remain urgent.

## 6.0.16 durable transport and E2E recovery hardening

- Remote workflow cursor state is published only after its candidate snapshot has been durably committed. A listener-accepted turn can no longer appear acknowledged in `health()` while the cursor file still contains the previous sequence.
- Assistant turns retain streaming state when the DOM still contains `.streaming-animation`, even if a hidden or background tab no longer exposes the stop button. Streaming evidence now propagates through `TabObservation`, request terminal policy, and the shared active/passive evidence classifier.
- Accepted canonical browser-effect transitions are exposed to public turn-event consumers exactly once. `prompt.submit` success emits a canonical `prompt.sent`, so reload tests wait for proved submission rather than diagnostic telemetry.
- Failed E2E scenarios stop and interrupt canonical work, wait for both request settlement and physical lease release, and only then reload a stale browser projection. Final conversation cleanup applies the same barrier after a lease conflict.
- Regression coverage includes delayed cursor persistence, hidden-tab streaming output, duplicate effect delivery, release-pending scenario recovery, and cleanup lease conflicts.

## 6.0.15 state-ownership hardening

- This release introduced a transitional Hub-side mitigation for stale diagnostic request IDs and release barriers. Version 6.1.0 removes that transitional lease/release ownership from Hub entirely; standalone commands now have no request envelope and the command registry owns release correlation.
- The workflow hydration inbox is durable in the v3 workflow store. Inputs received while a persisted workflow is restoring survive process restart, retain binding epoch identity, drain exactly once, and remain persisted when processing fails.
- `workflowState.binding` is the only runtime workflow binding source. Workflow services no longer mutate `config.watch`, `config.automation.session`, or independent `boundSessionId` / `boundSourceClientId` mirrors.
- The content execution projection no longer uses a mutable `Proxy`. Callers receive a frozen getter view and may change state only through closed typed `update()` events.
- Regression coverage reproduces the real E2E sequence: terminal release, stale layout capture, command-scoped diagnostic settlement, and acceptance of the next prompt. Source checks prevent binding mirrors and mutable content projections from returning.

## Previous reload recovery and layout diagnostics

- General composer, generation, model, effort, and artifact selectors reject the ChatGPT history sidebar, message-level model controls, and the extension-owned panel. Session discovery/change/delete commands retain intentional sidebar access.
- `model.apply` returns the internally verified picker snapshot through its typed effect result. The canonical server router projects deduplicated `model.apply.started` and `model.apply.done` public events.
- The real `reload-mid-request` failure from run `34c4c2ec6091` was a lease-identity bug: the E2E control command created a synthetic command request while the tab belonged to the active turn. The scenario now sends its exact turn request ID, and the bridge falls back to the live active-request identity when callers omit it.
- Fault-injection reload remains request-scoped when recovering an active request. Sanitized layout capture is now a read-only standalone command with no request envelope; version 6.1.0 supersedes the former active-lease reuse workaround.
- The opt-in `--capture-page-layout` / `--capture-layout` flag records deduplicated sanitized structural snapshots after startup, before/after each scenario, at the failure boundary, and during finalization. Captures preserve selector, ARIA, visibility, display/position, and geometry evidence while redacting messages, conversation/account data, inputs, media URLs, query strings, and unstable identifiers.
- Layout-capture failures are indexed but never replace the original scenario error. The API route, manifest-order content module, sanitizer, archive writer, scenario hooks, deduplication, and standalone read-only behavior are covered locally.

## Verification completed locally

The P1 release runner is now the canonical deterministic gate:

```text
npm run verify:release:local
```

The current run passed static/package checks, the complete test suite, the fault matrix, workflow coverage, captured-DOM replay, local multi-bridge integration, parser fixtures, atomic extension deployment verification, and `npm audit --omit=dev --audit-level=low`.

`sqlite3` was upgraded from `5.1.7` to `6.0.1`. A clean `npm ci` was also verified in an isolated copy by building the native addon from source against local Node headers; an in-memory SQLite create/insert/select probe passed and the audit reported zero vulnerabilities.

The optional Chromium fixture now auto-detects common browser binaries and runs a capability probe first. In the current restricted Linux sandbox `/usr/bin/chromium` exists but cannot start headlessly, so the browser fixture is reported as one explicit environment skip while all DOM fixtures pass. A fixture timeout after a successful capability probe remains a test failure.

The extension deployment verifier proves first install, stale-file cleanup during an update, exact source/target fingerprints, manifest version preservation, and unchanged redeployment.

## External verification

The authenticated release runner was started successfully, including an isolated bridge backed by the native SQLite store, but this environment has no connected logged-in extension client. It stopped at the browser-control preflight with the typed error `No connected extension client supports browser tab control`; no ChatGPT scenario was executed.

A logged-in desktop browser must still run:

```bash
npm run verify:release:live -- --reload-extension --capture-page-layout
```

That command executes the fixed smoke/parser/reasoning/steer/reload/ZIP/workflow matrix and stores E2E diagnostics under the release-report directory.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged when present.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while registry URLs remain public.
- Keep all project Markdown in English.

## 6.2.2 reload boundary recovery and semantic E2E deadlines

- Reload recovery now validates the canonical submitted user-turn boundary against the restored DOM before accepting any assistant turn.
- A changed DOM key may be rebound only when the exact normalized submitted prompt text matches; a missing boundary becomes typed `recovery_uncertain` without prompt resubmission.
- The content request monitor cannot attach an assistant turn from an older user boundary after reload.
- The real E2E reload scenario waits for a stable canonical boundary and active generation before reloading.
- E2E idle deadlines now advance only on semantic lifecycle/output changes; heartbeat, revision and repeated deadline events cannot postpone timeout indefinitely.

