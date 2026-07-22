# Canonical Browser Bridge Architecture

## Status and versions

The workflow v3 and Protocol 5 hard cut is implemented in the current tree. Protocol 4, payload-kind inference, record-scanning terminal reporters, and content-owned release completion are physically removed from production.

Current versions:

- bridge package: `6.3.0`;
- extension package: `2.3.1`;
- content runtime: `4.3.1`;
- extension protocol: `5` only;
- background runtime schema: `6` only;
- workflow runtime schema: `3` only.

Authenticated live-browser verification remains a release activity. A new ChatGPT DOM variant may require parser or executor adapter changes, but it must remain a local typed effect outcome and must not create another protocol classifier, lifecycle, terminal publisher, or release path.

## Ownership model

| State domain | Sole owner | Other participants |
|---|---|---|
| Request lifecycle, terminal outcome, errors, blockers, and deadlines | Server canonical request reducer | Extension sends observations and typed effect evidence |
| Canonical intent for the next request action | Server request coordinator | Background receives correlated commands |
| Tab lease and browser-executor readiness | Extension background reducer | Server issues lease identity; content receives a projection |
| Request-scoped browser-effect execution record | Extension background effect reducer | Content executes one typed adapter action |
| Command-scoped browser operation record | Extension background command reducer | Content/background executes the correlated command |
| Transport epochs, sequences, exact-message ACKs, and critical outbox | Extension background transport reducer | Server validates and ACKs only after canonical commit |
| Download capture and binding | Extension background download reducer | Content arms exact artifact identity; server receives the result |
| DOM, turn, composer, generation, and artifact facts | One content `TabObserver` pipeline | Active and passive selectors consume the same snapshot |
| Primary chat control scope | Content DOM adapters | Composer/model/effort/generation/artifact commands exclude the history sidebar and extension-owned panel; session commands alone may inspect sidebar history |
| Workflow lifecycle, `nextAction`, and workflow-owned Git aggregation | Workflow v3 reducer | Services execute effects without owning lifecycle or checkpoint-graph fields |
| Local project snapshots, checks, verification, apply, rollback, commit, squash, and starting-state restore execution | Workflow local-effect ledger | Local services execute guarded operations inside an owned workflow run |
| Primary Bridge to workflow-worker turn delivery | Observed-turn stream epoch/cursor contract | Worker durably advances its cursor after enqueue |

No participant may infer another owner's state from log text, visible labels, timeout side effects, or mutable payload merging.

Project-context synchronization never bypasses run ownership. Startup or manual refresh creates a short `context_sync` run when no user run exists; post-apply refresh executes before the owning run reaches its terminal transition, so it cannot overwrite the operation's `lastOutcome`.

Model/effort progress exposed to bridge clients is a server projection of canonical `model.apply` effect records. Content returns the normalized verified picker snapshot as the effect result and does not publish a parallel model lifecycle message.

## Topology

```text
ChatGPT DOM
  -> content TabObserver
       -> immutable revisioned TabObservation
       -> passive turn journal
       -> active request selector
  <- one typed DOM effect executor at a time

content runtime (dormant until canonical server handshake; page hooks detached offline)
  <-> extension background
       tab operation queue
       schema-6 atomic root transition
       focused TabLease / Command / BrowserEffect / Transport / Download reducers
       exact immutable critical outbox commit
       background-owned release and quarantine
  <-> Protocol 5 WebSocket
       shared direction-aware protocol manifest and validator
       BrowserExtensionHub (authenticated transport only)
       ProtocolV5Adapter
       BrowserBridge facade
         -> BridgeCommandRegistry
         -> RequestSubmissionCoordinator
         -> BrowserClientCoordinator + BrowserTabCoordinator
         -> RequestLifecycleCoordinator
              -> RequestRecoveryCoordinator
              -> RequestResultMaterializer
              -> canonical request reducer + output accumulator

WorkflowManager facade
  -> RuntimeCoordinator for serialized reducer/effect commits
  -> WorkflowResponseProcessor for response/package/apply flow
  -> AutomationController + AutomationRunExecutor
  -> browser effects through BrowserBridge
  -> local effects for checks/apply/commit/rollback
  -> optional remote observed-turn stream with epoch/cursor/gap detection
```

## Protocol 5

Protocol 5 is the only extension contract. Server and extension import the same manifest and validator from `tools/chrome-bridge-extension/shared/protocolV5Manifest.js`. Every envelope has one explicit `messageType`; its direction, owner, criticality, terminality, correlation kind, and required immutable identity are fixed by that manifest.

The protocol never infers meaning from `body.type`, a string prefix, the presence of `commandId`, or legacy payload vocabulary. Unsupported, wrong-direction, incomplete, or identity-inconsistent envelopes fail at the boundary before routing. The content router builds its handler table from one dependency registry and validates exact bidirectional parity with the shared command manifest at construction, before any command can be accepted.

Command contracts are disjoint:

- result commands use `command.execute -> command.accepted -> command.result | command.rejected`;
- effect-backed commands use `command.execute -> command.accepted`, while the linked physical BrowserEffect provides the only terminal outcome through `effect.succeeded | effect.failed | effect.uncertain | effect.cancelled`;
- release commands settle only from `lease.released` or `lease.quarantined`;
- observations, diagnostics, acceptance, progress, and effect-start messages never settle a command.

On receipt of an effect-backed command, the background atomically persists the command record, the dispatched BrowserEffect record, and the exact `command.accepted` outbox envelope before content may execute the DOM adapter. The terminal BrowserEffect reducer transition atomically persists the effect/derived command state and one exact immutable terminal outbox envelope. No terminal message is reconstructed later from records, and there is no parallel `reportedAt` lifecycle. If an effect-backed content handler throws outside its normal typed adapter result, the router durably settles that exact current effect as `uncertain`; it never leaves the dispatched record hanging and never emits a competing command terminal.

Critical outbox ACK uses exact `messageId`. Normal `tab.observation` messages are replaceable telemetry and are not persisted. Concurrent flush requests rerun against persisted outbox state; they do not scan or synthesize command/effect results. Large read-only diagnostic results, such as sanitized page layout capture, travel as bounded non-terminal `command.progress` chunks; only compact completion metadata enters the durable terminal outbox, and the server rejects missing or length-mismatched chunks explicitly.

Schema-6 tab runtime persistence is byte-bounded before every `chrome.storage.session` write. Compaction removes only old terminal history and summarizes oversized terminal diagnostics; the active lease, planned/dispatched/uncertain commands and effects, recovery evidence, download captures, and every record referenced by the critical outbox remain exact. A quota failure triggers one more aggressive compaction attempt before the transition is rejected. Once a terminal reducer transition and its exact outbox envelope are durably committed, a later WebSocket flush or resequencing failure cannot roll that commit back or be reported as effect-persistence failure; replay is deferred from the persisted envelope.

The background owns physical lease completion. Content may return typed cleanup evidence, but it cannot declare a lease released. When all children and cleanup are proved settled, the background atomically clears the lease and appends `lease.released`. If cleanup cannot be proved within the bounded release policy, the tab becomes `quarantined`, emits `lease.quarantined`, and is excluded from future scheduling.

Background schema 6 has a clean `chrome.storage.session` namespace. Legacy v1-v5 records are never adopted and are removed only after their state is proven idle.

## Shared command manifest and standalone recovery

`tools/chrome-bridge-extension/shared/commandManifest.js` is the closed contract for every content/background command. Each command declares its owner, execution mode, read/write class, request scope, retry policy, and an explicit `reloadRecovery` class. A command missing any of those fields is rejected before durable registration. The background never falls through to a generic retry policy.

Standalone writes use command records rather than request `BrowserEffect` ownership, but they follow the same evidence-before-retry rule. Their configured recovery is executed by `background/standaloneCommandRecovery.js`:

- a durably registered command with no dispatched epoch is recovered as `proved_not_started`; it may be retried by the caller with the same logical identity and current preconditions;
- passive prompt submission is reconciled from the exact prompt and user-turn observation;
- session selection is reconciled from the current conversation identity;
- session deletion requires explicit proof that the target conversation is absent; navigation to another conversation is not proof and therefore remains typed uncertainty;
- tab reload is proved only by a changed persisted content epoch;
- model/effort application is reconciled by a read probe of the current selection;
- attachment clearing is reconciled only from a known composer root with an empty attachment set;
- artifact fetch is reconciled from the persisted `DownloadCapture`;
- extension reload is reconciled by the maintenance-operation epoch and terminal-ACK barrier;
- session creation and browser tab open/close remain non-reconcilable after ambiguous dispatch and settle as typed uncertainty without a second write.

Read-only commands may be repeated only while their source and preconditions remain valid. A dispatched or uncertain write may be retried only after a kind-specific reconciler returns `proved_not_started`; an idempotency key alone is not proof. Unknown or legacy commands cannot reach the executor.

## Physical BrowserEffect records

The background `BrowserEffect` ledger is self-contained. Every record stores command and causation identity, immutable request/lease/owner identity, response epoch, idempotency key, normalized preconditions and their hash, retry policy, attempt, separate planned/dispatched/settled timestamps, typed result or error, reconciliation evidence, and cancellation evidence.

The state machine is:

```text
planned -> dispatched -> succeeded | failed | uncertain | cancelled-with-proof
planned -> cancelled | failed | uncertain
```

A dispatched effect cannot become `cancelled` from an abort signal alone. The executor must explicitly prove that it did not begin the browser write; otherwise interruption becomes `uncertain` and is reconciled by evidence.

## Tab ownership and serialization

Browser ownership is tab-scoped. A newly accepted handshake for a browser tab atomically replaces the previous content owner regardless of client ID. An older content or background epoch cannot mutate the current tab after replacement.

Each tab has one serialized operation queue. The following sequence is one linear operation:

```text
validate command scope and source
  -> validate/claim TabLease only for request scope
  -> enforce standalone read/write exclusivity without creating a lease
  -> atomically persist command plus dispatched BrowserEffect and acceptance envelope
  -> dispatch the one typed content/background executor
  -> atomically persist the physical outcome and exact terminal envelope
  -> retain that envelope until exact-message ACK
```

Separate async handlers must not interleave two browser writes between those boundaries. The queue reserves capacity for owner invalidation, release, and recovery controls; priority may overtake unrelated queued work but never reorders envelopes from the same transport sequence. Planned undispatched operations may be cancelled. A dispatched write must settle as `succeeded`, `failed`, `uncertain`, or as `cancelled` only when the executor proves that no browser write occurred; it cannot be erased by stop or release.

## Content runtime

`tools/chrome-bridge-extension/content.js` is a composition root. `content/transportRuntime.js` owns extension transport, reconnect, and page-artifact handoff, while `content/featureRuntime.js` assembles parser and executor adapters. None of these modules owns request meaning or terminal policy.

The content request object is a minimal executor projection containing only:

- immutable lease and request identity;
- prompt/turn anchors and response epoch;
- observation cursor;
- the single server-planned semantic effect descriptor currently being executed;
- bounded diagnostics;
- disposable DOM resources and timers outside the persisted projection.

Output fragments, terminal candidates, generation lifecycle, artifacts, and cached answer/reasoning are not persisted in this projection. Direct `request.field = value` mutation is forbidden. Updates must use one of the closed typed update groups in `content/executionState.js`. Unknown fields are rejected.

Content may report browser facts such as:

- current conversation and URL;
- composer and chat-root readiness;
- submitted user-turn and assistant-turn anchors;
- visible reasoning, answer, progress, and artifacts;
- generation controls and explicit UI errors;
- observation stability milestones;
- typed browser-effect outcomes.

Content must not:

- materialize request completion or terminal failure;
- send fragmented terminal/answer/thinking/artifact lifecycle messages;
- free a request because of a local timeout;
- retry a prompt, steer, attachment, session/model change, or artifact click after an ambiguous write boundary;
- replay cached output fragments after reload.

## One observation pipeline

Mutation observers, navigation hooks, foreground events, and bounded polling only mark the page dirty. Composer-only and extension-panel mutations are discarded before scheduling; mutations inside assistant turns remain observable even when they contain editable widgets. One scheduler performs one stabilized parser pass and publishes an immutable `TabObservation` with an observer epoch and monotonic revision. The normal path parses only the latest relevant turn, while historic artifact scans and sanitized source-HTML capture are explicit recovery/diagnostic operations. Stability milestones use dedicated timers, so fallback polling does not determine completion latency.

Active requests and passive workflows use one shared `classifyTurnObservation` evidence classifier and the same:

- parser result;
- user and assistant turn identity;
- prompt boundary;
- response epoch;
- artifact identity;
- browser completion evidence;
- stability milestones.

Passive mode may maintain a bounded dedupe journal, but it may not implement a second parser, generation state, terminal timer, or completion policy. The first visible pair after binding is baseline evidence; only later request-owned observations can become workflow input.

Browser completion evidence is not a terminal decision. The server reducer decides whether stopped generation, stable output, blockers, required artifacts, and deadlines are sufficient to complete or fail the request.

## Canonical request lifecycle

The request reducer owns orthogonal dimensions rather than one overloaded phase string:

```js
{
  lifecycle,
  submission,
  generation,
  blocker,
  output,
  artifact,
  connection,
  effect,
  terminal,
  outcome,
  responseEpoch,
  revision
}
```

Normalized request events come only from:

1. revisioned `TabObservation` evidence;
2. typed browser-effect results;
3. explicit commands such as cancel, steer, and release;
4. named server deadline events.

`RequestLifecycleCoordinator` owns canonical event commits and typed effect dispatch. `RequestRecoveryCoordinator` owns read-only reconciliation and deadline policy. `RequestResultMaterializer` is the only terminal materializer: it stores the exact output snapshot accepted by the reducer, resolves the public result/error, and sends a correlated `request.release` command. `BridgeCommandRegistry` correlates the release request until the background emits `lease.released` or `lease.quarantined`. Materialization never makes a terminal decision itself and does not wait for cleanup. A released tab becomes schedulable; a quarantined tab remains isolated and the scheduler selects another safe tab.

Public answer, reasoning, progress, and artifact events are server projections of committed observations. They are not independent extension lifecycle messages and cannot complete a request.

Canonical request state keeps independent effect domains for server coordination and physical browser execution. A coordinator effect such as steer planning, release, or recovery may overlap the one browser effect it caused, but two effects in the same domain remain serialized. Physical `effect.result` events can never settle or conflict with a coordinator record merely because their IDs are both active.

### Steering and response epochs

A steer keeps the request ID. Only the canonical server reducer increments `responseEpoch` after accepting proved new-turn evidence. Before dispatch, the server proves from canonical request state that prompt submission completed and generation is still active; disposable content flags are not readiness authority. The new user-turn boundary and assistant anchor belong to the new epoch. Evidence, artifacts, and terminal candidates from an older response epoch cannot settle the current request.

## Browser effects and retry policy

Request-scoped browser writes are planned in the background effect ledger before the content adapter runs. Each effect stores:

- `effectId` and idempotency key;
- effect kind;
- request/lease identity;
- preconditions such as conversation, turn, session, model, or artifact identity;
- retry policy;
- `planned | dispatched | succeeded | failed | uncertain | cancelled-with-proof`;
- typed result/error and reconciliation/cancellation evidence.

The default for browser writes is no speculative retry. A prompt submission is attempted once. If the DOM does not prove whether it happened, the effect becomes `uncertain`. Absence of evidence is never treated as proof that a click did not occur.

Safe read-only effects may be repeated with the same idempotency key. A write may be repeated only when an effect-specific reconciler proves that it did not start and all original preconditions still match. Otherwise canonical recovery returns a typed recoverable failure or `nextAction`.

Direct DOM writes are confined to explicit executor adapter modules. Composition roots, observers, parsers, routers, and lifecycle coordinators may not click, submit, navigate, attach, or start downloads directly.

## Reload and recovery

On content reload:

1. content receives a new epoch;
2. background restores the schema-6 lease, command/effect ledgers, exact-message outbox, quarantine state, and download captures from `chrome.storage.session`;
3. an active lease enters `reconciling`;
4. content creates fresh observers and emits a new complete observation;
5. safe unstarted/read-only work may resume with the same identity;
6. unconfirmed writes become `uncertain` and are not replayed;
7. the server uses effect-specific evidence and a recovery deadline to continue or fail recoverably.

A malformed content recovery projection degrades the hello with a recovery error but does not suppress protocol registration. The server can then diagnose the tab instead of observing an unexplained socket.

A full browser restart does not promise transparent continuation. If ownership or write outcome cannot be proved, canonical recovery ends in a typed recoverable failure.

## Downloads and artifacts

Download capture is a separate persisted reducer. A capture stores:

- capture ID;
- request/lease/effect identity;
- artifact requirement and candidate identity;
- expected exact names and metadata;
- Chrome download ID when bound;
- `planned | armed | bound | completed | failed | released`.

A Chrome download binds only to the armed capture for the same lease and expected artifact identity. Exact filename matching is a fallback only when no download ID is known; fuzzy filename matching is forbidden. Capture state is committed before content/server notification. Content disconnect alone does not erase a persisted capture.

Artifact selection and ZIP/result validation remain server policies. A valid capture does not prove that the selected file is semantically the required artifact.

## Deadlines and liveness

`RequestDeadlineCoordinator` is the only request deadline owner. It manages independent deadlines for meaningful progress, active generation, post-generation processing, source recovery, forced read-only snapshot response, required artifact settling, and optional hard lifetime.

A forced snapshot is read-only evidence. It cannot terminalize a request by itself and cannot resend a write. Deadline callbacks emit canonical events; they never resolve/reject a request directly.

## Workflow v3

Workflow schema 3 has one lifecycle:

```text
stopped | ready | running | waiting_action | recovering | paused
```

An active run has one phase, one identity, one input queue, one browser-effect ledger, one local-effect ledger, one `nextAction`, and one `lastOutcome`. Passive observation is a subscription/capability, not another watcher lifecycle. Legacy `watcher`, `pipeline`, `automation`, and `pending*` runtime snapshots are not reconstructed. The retained `automation` directory and configuration term describe an advanced preset/check executor only; they do not own workflow lifecycle, pause, stop, recovery, or terminal state.

All decisions use `nextAction` with an action ID, allowed choices, reason, references, expiry, and safe continuation. Stale or duplicate actions are rejected without mutation.

### Workflow startup and binding

Workflow restoration has a hydration barrier:

```text
unloaded -> hydrating -> recovering -> routable
```

Observed inputs received during hydration cannot start a false fresh run. They are durably committed to the workflow store before acknowledgement, retain their workflow/session binding epoch, and drain exactly once after restoration. Processing failure leaves the input persisted for deterministic restart recovery. A session handoff increments the binding epoch; stale queued turns from a previous binding cannot enter the new chat silently. `workflowState.binding` is the only runtime binding source; loaded configuration initializes policy but cannot override restored canonical binding.

### Workflow browser and local effects

Browser work uses the BrowserBridge contracts above. Local filesystem/process operations use `localEffects` with the same write-ahead rules:

- checks, verification, and planning are safe effects with bounded retry;
- apply, rollback, commit, squash, starting-state restore, and extension deployment are guarded write effects;
- extension deployment has its own `EXTENSION_DEPLOY` kind and writes an atomic completion receipt only after the installed manifest and reload step succeed;
- each effect stores idempotency/precondition hashes plus process or transaction identity;
- restart either proves completion/not-started, retries an allowed safe effect, or creates `nextAction`;
- a dispatched or uncertain unsafe effect cannot return to `planned` without `proved_not_started` evidence;
- partial apply/commit/deployment state is never guessed from phase labels.

### Stop and cancellation

Stop first records `stopRequested`, forbids new effects, and cancels only effects proved not started or explicitly cancellable. The workflow does not become `stopped` while a dispatched or uncertain browser/local write remains unresolved. Non-cancellable critical sections settle or rollback before the terminal stop transition.

## Independent workflow worker

A workflow worker does not connect to the extension WebSocket. It consumes the primary Bridge observed-turn stream with:

- upstream server/stream epoch;
- monotonic sequence;
- retained-from sequence;
- persisted worker cursor;
- explicit `stream.gap` detection.

The worker advances its cursor only after durable enqueue into workflow state. A primary restart changes the stream epoch, allowing sequence restart without silently ignoring new turns. If the requested cursor is older than retained history, the worker receives a typed gap and must resynchronize or request user action.

## Stateful module boundaries

The atomic state roots remain stable public APIs, but transition families are physically separated so ownership is visible and source-tested:

- `background/stateV6.js` is a thin facade over core validation, the atomic root reducer/store, and focused lease, command, browser-effect, transport/outbox, and download-capture reducers;
- `content/requestCommands.js` is a thin facade over prompt preparation/submission, resume/steer/cancel, shared support, and effect reconciliation;
- `src/bridge/state/requestMachine.js` validates and dispatches to lifecycle/deadline and effect/reconciliation transition families;
- `src/workflow/state/workflowState.js` is a public facade over the normalized workflow model and the workflow reducer;
- `src/turnManager.js` owns the turn queue and delegates recovery/resume execution to `src/turn/turnRecoveryService.js`, while shared normalization and streamed-item writing live in `src/turn/turnManagerSupport.js`.

Composition roots and stateful coordinators in this layout have an enforced 500-line ceiling, including the server composition root, BrowserExtensionHub, workflow manager, extension entry points, background envelope/reload/download coordinators, and every bridge coordinator. The architecture tests build the local import graph to reject reverse dependencies from reducers into coordinators, services, HTTP, or executors; they also restrict physical DOM writes to the reviewed content executor adapters, enforce shared-manifest command coverage and manifest-driven reload recovery, and reject hard-coded fallback command classification. Pure parser/UI/script modules remain under the reviewed general ceiling and are split only when a distinct owner boundary exists.

## Testing invariants

Architecture tests must prove behavior, not only class presence:

- tab-scoped owner replacement rejects older epochs;
- all correlated commands have a persisted command/lease record before dispatch;
- result commands settle only from terminal command envelopes, effect-backed commands only from their linked physical BrowserEffect, and release only from lease terminal envelopes;
- active and passive modes produce equivalent identities from one fixture;
- content cannot mutate request projections directly or emit terminal lifecycle messages;
- prompt ambiguity never causes an automatic resubmit;
- writes cannot occur after release/stop;
- durable-registration failure prevents physical dispatch, registered-but-undispatched commands recover as `proved_not_started`, and dispatched/browser-action-complete/report boundaries yield proved continuation or `uncertain`;
- download capture survives content reload and binds by strict identity;
- workflow hydration, cancellation, local effects, stream epoch, cursor, and gap recovery are covered;
- critical duplicate delivery is logically applied once;
- every physical BrowserEffect creates at most one logical terminal outbox envelope;
- an unexpected effect-backed handler exception durably settles the exact current effect as uncertainty without a second command terminal;
- terminal reducer state and its exact outbox envelope are committed atomically;
- a quarantined tab cannot be selected for unrelated work.
- effect executors preserve a dispatched recovery boundary when terminal result persistence fails after the physical action;
- kind-specific browser reconciliation is table-tested for page, session, model, attachment, prompt, cancel, artifact, and download evidence;
- remote cursor advancement is tested against listener failure, redelivery, upstream epoch change, and retained-history gaps.

The deterministic release contract is:

```text
npm run verify:release:local
```

It runs syntax/package checks, the full suite, fault matrices, workflow coverage, captured fixtures, the complete registered E2E matrix against the deterministic Protocol 5 mock ChatGPT runtime, local multi-bridge integration, parser fixtures, atomic extension deployment verification, and a production dependency audit. Gates run sequentially as isolated asynchronous child process groups, write separate logs, and have a bounded timeout with whole-group termination so one leaked child cannot hang release verification. `npm run verify:release` adds a clean `npm ci` and the authenticated live matrix. Release reports are written as JSON and Markdown; the live runner stores its E2E diagnostics beneath the same report directory.

The same smoke, reasoning/public progress, steer, ZIP artifact, workflow presets, multi-bridge, two-tab quarantine isolation, layout capture, and reload-mid-request scenarios now run locally through the mock Protocol 5 participant. Local verification deliberately has two layers: the mock participant exercises the real server/reducer/workflow/transport contracts, while generated ChatGPT-shaped HTML is replayed through the production offline DOM parser and selector fixtures. The mock does not become a second canonical lifecycle owner and does not pretend to emulate Chrome platform behavior. Authenticated Chrome remains release verification for current ChatGPT DOM/product compatibility, browser permissions/service-worker behavior, and native download-manager integration and is run with `npm run verify:release:live -- --reload-extension --capture-page-layout`; this reloads only when the deployed bundle differs.


The deterministic mock is not a second lifecycle owner. `scripts/e2e/mock-chatgpt/extension-client.js` consumes the shared command manifest, emits Protocol 5 command/effect/lease envelopes, and publishes immutable `TabObservation` records. The mock state machine owns only external-product simulation: conversations, rendered turns, intelligence controls, reasoning timing, and artifact bytes. The canonical server reducers, workflow reducers, transport correlation, release barriers, and artifact materialization remain production code. `test/mockChatGptContract.test.js` enforces command-manifest parity, while layout and scenario-contract tests prove parser-compatible markup and deterministic output/artifact semantics.

The live runner may enable `--capture-page-layout` for selector and geometry diagnosis. Content produces a sanitized structural snapshot through a typed read-only standalone command; the server stores deduplicated snapshots plus `page-layout/index.json` in the diagnostic report. The capture retains structural attributes and rectangles but removes conversation text, account data, input values, media sources, query strings, and unstable identifiers. Because standalone diagnostics never carry a request envelope, stale correlation IDs cannot resurrect or compete with a released request lease. Fault-injection reload remains request-scoped only when it is explicitly recovering an active canonical request.

The packaged extension is deployed atomically to one stable install directory before startup reload. `--reload-extension` reloads only when deployed bytes or reported versions differ; `--force-reload-extension` is the explicit always-reload mode. The background persists reload intent, publishes the exact terminal command result, and calls `chrome.runtime.reload()` only after that envelope is ACKed by the server. Reload success is accepted only when the reconnected extension and content-runtime versions match the deployed bundle; a profile still registered to another unpacked directory produces a typed path-mismatch error. Request observations become canonical response evidence only after the active request's submitted user-turn key matches the observed assistant turn boundary. Observation semantic signatures exclude parser timings and seen-at timestamps, so polling cannot perpetually renew liveness deadlines. If content reload interrupts a proved pre-submit preparation effect, canonical recovery resumes only the remaining preparation stages from the persisted prompt payload; it never repeats a proved stage or a submitted prompt.

## Structural policy

Core composition roots and stateful coordinators are discovered by structural filename role and source-tested at 500 lines or fewer. `src/interactive/terlioRuntime.js` is the explicit reviewed UI-runtime exception because it owns terminal rendering rather than canonical request/workflow state. The general production ceiling remains 1,000 lines for reviewed pure parser, UI, route, fixture, and script modules. A reviewed module above 500 lines may not gain another unrelated responsibility; it must be split when a new owner boundary appears.
