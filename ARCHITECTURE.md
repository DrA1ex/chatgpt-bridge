# Canonical Browser Bridge Architecture

## Status and versions

The v3 workflow and v4 extension hard cut is implemented in the current tree. The architecture has one owner for each durable state domain and does not support protocol downgrade or legacy request paths.

Current versions:

- bridge package: `6.0.10`;
- extension package: `2.0.10`;
- content runtime: `4.0.10`;
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
| Workflow lifecycle, decisions, and workflow-owned Git aggregation | Workflow v3 reducer | Services execute effects without owning lifecycle or checkpoint-graph fields |
| Local checks, apply, rollback, commit, squash, and starting-state restore execution | Workflow local-effect ledger | Local services execute guarded operations |
| Primary Bridge to workflow-worker turn delivery | Observed-turn stream epoch/cursor contract | Worker durably advances its cursor after enqueue |

No participant may infer another owner's state from log text, visible labels, timeout side effects, or mutable payload merging.

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
         -> client projection + message router + release registry
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

Every correlated command receives a lease:

- request-bound commands use the request lease;
- administrative, artifact, session, model, and maintenance commands receive a synthetic command-scoped lease;
- command correlation is persisted before dispatch;
- `command.accepted` and `command.progress` are telemetry only;
- only `command.result`, `command.rejected`, or `command.error` settle a command;
- command-scoped leases are released only after the durable result transition.

A command record stores its idempotency key, preconditions, retry policy, status, causation identity, lease, and typed outcome. A content reload changes an unconfirmed dispatched command to `uncertain`; it is not silently replayed.

Critical observations and command/effect results are kept in the background outbox until server ACK. Full revisioned observations may coalesce by lease and content epoch. Command results, effect results, and download outcomes are never coalesced or evicted as replaceable telemetry. Every background reducer transition is fail-closed: the candidate snapshot must be written to `chrome.storage.session` before it becomes the committed in-memory state or permits command acceptance, effect dispatch, result publication, or release. A storage failure leaves the prior revision authoritative and surfaces a typed persistence failure. Legacy v1-v3 background namespaces are removed only after the current v4 state is proven idle.

## Tab ownership and serialization

Browser ownership is tab-scoped. A newly accepted handshake for a browser tab atomically replaces the previous content owner regardless of client ID. An older content or background epoch cannot mutate the current tab after replacement.

Each tab has one serialized operation queue. The following sequence is one linear operation:

```text
validate command
  -> validate/claim lease
  -> persist command or effect intent
  -> acknowledge acceptance
  -> dispatch to content/background executor
  -> persist typed result
  -> publish result
  -> release command-scoped lease when applicable
```

Separate async handlers must not interleave two browser writes between those boundaries. Cancellation and release prevent planning new writes. A dispatched write must settle as `succeeded`, `failed`, or `uncertain`; it cannot be erased by stop or release.

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

Mutation observers, navigation hooks, foreground events, and bounded polling only mark the page dirty. One scheduler performs one stabilized parser pass and publishes an immutable `TabObservation` with an observer epoch and monotonic revision.

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

`RequestLifecycleCoordinator` owns canonical event commits and typed effect dispatch. `RequestRecoveryCoordinator` owns read-only reconciliation and deadline policy. `RequestResultMaterializer` is the only terminal materializer: it stores the exact output snapshot accepted by the reducer, resolves the public result/error, registers a release barrier, and sends a correlated `request.release` command. Materialization never makes a terminal decision itself and does not wait for cleanup, but the tab remains unschedulable until the release result is accepted.

Public answer, reasoning, progress, and artifact events are server projections of committed observations. They are not independent extension lifecycle messages and cannot complete a request.

### Steering and response epochs

A steer keeps the request ID and increments `responseEpoch`. The new user-turn boundary and assistant anchor belong to the new epoch. Evidence, artifacts, and terminal candidates from an older response epoch cannot settle the current request.

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

Observed inputs received during hydration cannot start a false fresh run. They are queued and bound to the workflow/session binding epoch. A session handoff increments that epoch; stale queued turns from a previous binding cannot enter the new chat silently.

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

## Structural policy

Core composition roots and stateful coordinators are source-tested at 500 lines or fewer. The general production ceiling remains 1,000 lines for reviewed pure parser, UI, route, fixture, and script modules. A reviewed module above 500 lines may not gain another unrelated responsibility; it must be split when a new owner boundary appears.
