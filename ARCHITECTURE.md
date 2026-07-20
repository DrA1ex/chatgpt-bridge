# Canonical Browser Bridge Architecture

## Status and versions

The v3 workflow and v4 extension hard cut is implemented in the current tree. The architecture has one owner for each durable state domain and does not support protocol downgrade or legacy request paths.

Current versions:

- bridge package: `6.2.2`;
- extension package: `2.2.2`;
- content runtime: `4.2.2`;
- extension protocol: `4` only;
- workflow runtime schema: `3` only.

Authenticated live-browser verification is still a release activity. A new ChatGPT DOM variant may require parser or executor adapter changes, but it must not create another request lifecycle, observation pipeline, retry loop, or transport path.

## Ownership model

| State domain | Sole owner | Other participants |
|---|---|---|
| Request lifecycle, terminal outcome, errors, blockers, and deadlines | Server canonical request reducer | Extension sends observations and typed effect evidence |
| Canonical intent for the next request action | Server request coordinator | Background receives correlated commands |
| Tab lease and browser-executor readiness | Extension background reducer | Server issues lease identity; content receives a projection |
| Request-scoped browser-effect execution record | Extension background effect reducer | Content executes one typed adapter action |
| Command-scoped browser operation record | Extension background command reducer | Content/background executes the correlated command |
| Transport epochs, sequences, ACK cursor, and critical outbox | Extension background transport reducer | Server validates and ACKs only after canonical commit |
| Download capture and binding | Extension background download reducer | Content arms exact artifact identity; server receives the result |
| DOM, turn, composer, generation, and artifact facts | One content `TabObserver` pipeline | Active and passive selectors consume the same snapshot |
| Primary chat control scope | Content DOM adapters | Composer/model/effort/generation/artifact commands exclude the history sidebar and extension-owned panel; session commands alone may inspect sidebar history |
| Workflow lifecycle, decisions, and workflow-owned Git aggregation | Workflow v3 reducer | Services execute effects without owning lifecycle or checkpoint-graph fields |
| Local checks, apply, rollback, commit, squash, and starting-state restore execution | Workflow local-effect ledger | Local services execute guarded operations |
| Primary Bridge to workflow-worker turn delivery | Observed-turn stream epoch/cursor contract | Worker durably advances its cursor after enqueue |

No participant may infer another owner's state from log text, visible labels, timeout side effects, or mutable payload merging.

Model/effort progress exposed to bridge clients is a server projection of canonical `model.apply` effect records. Content returns the normalized verified picker snapshot as the effect result and does not publish a parallel model lifecycle message.

## Topology

```text
ChatGPT DOM
  -> content TabObserver
       -> immutable revisioned TabObservation
       -> passive turn journal
       -> active request selector
  <- typed DOM executor adapters

content runtime
  <-> extension background
       tab operation queue
       TabLease reducer
       Command ledger
       BrowserEffect ledger
       TransportSession reducer + critical outbox
       DownloadCapture reducer
  <-> Protocol 4 WebSocket
       BrowserExtensionHub
         -> authenticated connection registry + transport-only routing
       ProtocolV4Adapter
       BrowserBridge facade
         -> BridgeCommandRegistry
         -> RequestSubmissionCoordinator
         -> BrowserClientCoordinator + BrowserTabCoordinator
         -> RequestLifecycleCoordinator
              -> RequestRecoveryCoordinator
              -> RequestResultMaterializer
              -> canonical request reducer + result accumulator

WorkflowManager facade
  -> RuntimeCoordinator for serialized reducer/effect commits
  -> WorkflowResponseProcessor for response/package/apply flow
  -> AutomationController + AutomationRunExecutor
  -> browser effects through BrowserBridge
  -> local effects for checks/apply/commit/rollback
  -> optional remote observed-turn stream with epoch/cursor/gap detection
```

## Protocol 4

Protocol 4 is the only extension contract. Every envelope contains:

- `protocolVersion`;
- `messageId`;
- typed `kind`;
- immutable source identity with browser tab, background epoch, content epoch, and monotonic sequence;
- optional request lease;
- optional command, effect, and causation identities;
- immutable payload.

The server validates the complete envelope before routing its payload. Duplicate message IDs, stale sequences, stale content/background epochs, wrong tab ownership, and lease mismatches are rejected without canonical mutation and remain bounded diagnostics.

Correlated commands have two explicit scopes:

- request commands carry the immutable canonical `requestId`, `leaseId`, owner, and response epoch; only these commands may claim or mutate a `TabLease`;
- standalone commands carry no request envelope, even when their payload contains a request ID used only for diagnostics or correlation;
- read-only standalone commands may execute while a request owns the tab because they cannot mutate ChatGPT state;
- mutating standalone commands are serialized as exclusive background command records and are rejected while a request lease or another standalone write is active;
- command correlation is registered before transport delivery, and delivery rejection settles it immediately;
- `command.accepted` and `command.progress` are telemetry only;
- only `command.result`, `command.rejected`, or `command.error` settle a command;
- a timed-out or aborted standalone command first receives a correlated `command.cancel`; the caller is released only after cancellation settles or reaches its own typed timeout.

A persisted background command record stores scope, idempotency key, preconditions, retry policy, status, causation identity, optional request lease, and typed outcome. A content reload changes an unconfirmed dispatched command to `uncertain`; it is not silently replayed. The Hub owns no lease map, release registry, command lifecycle, or fallback request identity.

Command/effect results and explicitly forced reconciliation observations are kept in the background outbox until server ACK. Normal full `tab.observation` snapshots are replaceable telemetry: they are not persisted and a fresh snapshot is produced after reconnect. Command results, effect results, and download outcomes are never coalesced or evicted as replaceable telemetry. Every background reducer transition is fail-closed: the candidate snapshot must be written to `chrome.storage.session` before it becomes the committed in-memory state or permits command acceptance, effect dispatch, result publication, or release. A storage failure leaves the prior revision authoritative and surfaces a typed persistence failure. Background runtime schema 5 uses its own namespace; legacy v1-v4 records are ignored and removed only after every current and legacy lease/effect/command/download record is proven idle.

## Physical BrowserEffect records

The background `BrowserEffect` ledger is self-contained. Every record stores command and causation identity, immutable request/lease/owner identity, response epoch, idempotency key, normalized preconditions and their hash, retry policy, attempt, separate planned/dispatched/settled timestamps, typed result or error, reconciliation evidence, cancellation evidence, and report status.

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
  -> persist command or effect intent
  -> acknowledge acceptance
  -> dispatch to content/background executor
  -> persist typed result
  -> publish the correlated result
```

Separate async handlers must not interleave two browser writes between those boundaries. The queue reserves capacity for owner invalidation, release, and recovery controls; priority may overtake unrelated queued work but never reorders envelopes from the same transport sequence. Planned undispatched operations may be cancelled. A dispatched write must settle as `succeeded`, `failed`, `uncertain`, or as `cancelled` only when the executor proves that no browser write occurred; it cannot be erased by stop or release.

## Content runtime

`tools/chrome-bridge-extension/content.js` is a composition root. `content/transportRuntime.js` owns extension transport, reconnect, and page-artifact handoff, while `content/featureRuntime.js` assembles parser and executor adapters. None of these modules owns request meaning or terminal policy.

The content request object is a minimal executor projection containing only:

- immutable lease and request identity;
- prompt/turn anchors and response epoch;
- observation cursor;
- executor phase needed to sequence local adapters;
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

`RequestLifecycleCoordinator` owns canonical event commits and typed effect dispatch. `RequestRecoveryCoordinator` owns read-only reconciliation and deadline policy. `RequestResultMaterializer` is the only terminal materializer: it stores the exact output snapshot accepted by the reducer, resolves the public result/error, and sends a correlated `request.release` command. `BridgeCommandRegistry` owns the source-scoped release barrier until the physical release result settles. Materialization never makes a terminal decision itself and does not wait for cleanup, but the tab remains unschedulable until that barrier is cleared.

Public answer, reasoning, progress, and artifact events are server projections of committed observations. They are not independent extension lifecycle messages and cannot complete a request.

Canonical request state keeps independent effect domains for server coordination and physical browser execution. A coordinator effect such as steer planning, release, or recovery may overlap the one browser effect it caused, but two effects in the same domain remain serialized. Physical `effect.result` events can never settle or conflict with a coordinator record merely because their IDs are both active.

### Steering and response epochs

A steer keeps the request ID and increments `responseEpoch`. Before dispatch, the server proves from canonical request state that prompt submission completed and generation is still active; disposable content flags are not readiness authority. The new user-turn boundary and assistant anchor belong to the new epoch. Evidence, artifacts, and terminal candidates from an older response epoch cannot settle the current request.

## Browser effects and retry policy

Request-scoped browser writes are planned in the background effect ledger before the content adapter runs. Each effect stores:

- `effectId` and idempotency key;
- effect kind;
- request/lease identity;
- preconditions such as conversation, turn, session, model, or artifact identity;
- retry policy;
- `planned | dispatched | succeeded | failed | uncertain`;
- typed result/error and report status.

The default for browser writes is no speculative retry. A prompt submission is attempted once. If the DOM does not prove whether it happened, the effect becomes `uncertain`. Absence of evidence is never treated as proof that a click did not occur.

Safe read-only effects may be repeated with the same idempotency key. A write may be repeated only when an effect-specific reconciler proves that it did not start and all original preconditions still match. Otherwise canonical recovery returns a typed recoverable failure or `nextAction`.

Direct DOM writes are confined to explicit executor adapter modules. Composition roots, observers, parsers, routers, and lifecycle coordinators may not click, submit, navigate, attach, or start downloads directly.

## Reload and recovery

On content reload:

1. content receives a new epoch;
2. background restores the lease, command/effect ledgers, transport state, outbox, and download captures from `chrome.storage.session`;
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

An active run has one phase, one identity, one input queue, one browser-effect ledger, one local-effect ledger, one `nextAction`, and one `lastOutcome`. Passive observation is a subscription/capability, not another watcher lifecycle. Legacy `watcher`, `pipeline`, `automation`, and `pending*` runtime snapshots are not reconstructed.

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
- apply, rollback, commit, squash, and starting-state restore are guarded write effects;
- each effect stores idempotency/precondition hashes plus process or transaction identity;
- restart either proves completion/not-started, retries an allowed safe effect, or creates `nextAction`;
- partial apply/commit state is never guessed from phase labels.

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

## Testing invariants

Architecture tests must prove behavior, not only class presence:

- tab-scoped owner replacement rejects older epochs;
- all correlated commands have a persisted command/lease record before dispatch;
- only terminal command result types settle correlation;
- active and passive modes produce equivalent identities from one fixture;
- content cannot mutate request projections directly or emit terminal lifecycle messages;
- prompt ambiguity never causes an automatic resubmit;
- writes cannot occur after release/stop;
- reload at planned, dispatched, browser-action-complete, and report boundaries yields proved continuation or `uncertain`;
- download capture survives content reload and binds by strict identity;
- workflow hydration, cancellation, local effects, stream epoch, cursor, and gap recovery are covered;
- critical duplicate delivery is logically applied once.
- effect executors preserve a dispatched recovery boundary when terminal result persistence fails after the physical action;
- kind-specific browser reconciliation is table-tested for page, session, model, attachment, prompt, cancel, artifact, and download evidence;
- remote cursor advancement is tested against listener failure, redelivery, upstream epoch change, and retained-history gaps.

The local verification contract is:

```text
npm run check
npm test
npm run test:faults
npm run test:workflow:coverage
npm run test:e2e:local
npm run test:workflow:multi-bridge
```

Authenticated smoke, reasoning/public progress, steer, ZIP artifact, workflow presets, multi-bridge, and reload-mid-request remain release verification against the live ChatGPT UI.

The live runner may enable `--capture-page-layout` for selector and geometry diagnosis. Content produces a sanitized structural snapshot through a typed read-only standalone command; the server stores deduplicated snapshots plus `page-layout/index.json` in the diagnostic report. The capture retains structural attributes and rectangles but removes conversation text, account data, input values, media sources, query strings, and unstable identifiers. Because standalone diagnostics never carry a request envelope, stale correlation IDs cannot resurrect or compete with a released request lease. Fault-injection reload remains request-scoped only when it is explicitly recovering an active canonical request.

The packaged extension is deployed atomically to one stable install directory before startup reload. Reload success is accepted only when the reconnected extension and content-runtime versions match the deployed bundle; a profile still registered to another unpacked directory produces a typed path-mismatch error. Request observations become canonical response evidence only after the active request's submitted user-turn key matches the observed assistant turn boundary. Observation semantic signatures exclude parser timings and seen-at timestamps, so polling cannot perpetually renew liveness deadlines. If content reload interrupts a proved pre-submit preparation effect, canonical recovery resumes only the remaining preparation stages from the persisted prompt payload; it never repeats a proved stage or a submitted prompt.

## Structural policy

Core composition roots and stateful coordinators are source-tested at 500 lines or fewer. The general production ceiling remains 1,000 lines for reviewed pure parser, UI, route, fixture, and script modules. A reviewed module above 500 lines may not gain another unrelated responsibility; it must be split when a new owner boundary appears.
