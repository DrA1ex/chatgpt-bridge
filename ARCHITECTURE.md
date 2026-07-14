# Request State Architecture Migration

## Purpose

This document defines the staged migration from distributed polling and implicit request phases to an explicit, revisioned state architecture.

The goal is not to remove every timeout. The goal is to stop using timeouts to discover state changes that have already happened. Known incompatible states must reject an operation immediately. Timeouts remain only for genuine absence of observations, stalled effects, dead transports, and bounded UI operations.

The migration must preserve the extension WebSocket runtime, source-tab binding, artifact safety, apply containment, passive workflows, recovery, and existing public APIs. The behavioral cutover is complete: protocol compatibility is now an input adapter to one canonical machine rather than a second production lifecycle.

## Current structural baseline

The migration started from mixed ownership across the content script, server bridge, workflow manager, and E2E runner. That behavioral duplication has now been removed: request lifecycle decisions pass through one canonical reducer. The remaining baseline problem is structural concentration in several large coordinators, especially the extension content script, interactive command layer, and real-browser E2E runner.

### Structural refactor completed so far

The bridge has been separated into domain modules and explicit coordinators. `src/tampermonkeyBridge.js` is now an 856-line compatibility-facing facade rather than the owner of tab selection, event routing, deadlines, effects, and terminal materialization. Public exports remain compatible.

### Implementation status — 2026-07-14

The canonical request architecture is authoritative for request completion, failure, cancellation, required-artifact settling, release, and liveness deadlines. Legacy request fields remain only as compatibility projections, and protocol 2 messages are normalized as observations before entering the same reducer. There is no runtime switch back to a second request state machine.

Implemented request-state layout:

```text
src/bridge/
  adapters/
    hubObservationAdapter.js
    legacyProgressAdapter.js
    tabObservationAdapter.js
  coordinator/
    requestLifecycleCoordinator.js
    browserClientCoordinator.js
    bridgeClientEventRouter.js
    bridgeOperations.js
  deadlines/
    requestDeadlineCoordinator.js
    requestDeadlinePolicy.js
  effects/
    effectRunner.js
  replay/
    requestTrace.js
  state/
    requestEvents.js
    requestFailure.js
    requestInvariants.js
    requestMachine.js
    requestPolicy.js
    requestProjection.js
    requestRuntime.js
    requestTransitions.js
  store/
    entityStore.js
    transitionJournal.js
    waitForState.js
```

Implemented behavior:

- one always-on observer runs per content-script instance, independent of active request execution, and emits normalized tab facts with `observerId`, monotonically increasing `revision`, and bounded degraded-DOM stabilization;
- the hub stores the latest observation even when no request is active, rejects duplicate/stale revisions within one observer epoch, and accepts revision reset only after a new observer epoch;
- request adaptation scopes generation/output/blocker/artifact facts only after prompt binding or when an observation explicitly belongs to the request, preventing historical page state from advancing a new request;
- lifecycle, submission, generation, blocker, output, artifact, effect, source, completion, and terminal state are stored independently;
- all accepted transitions commit a monotonically increasing request revision before subscribers are notified;
- canonical state now owns normal completion, explicit failures, cancellation, required ZIP settling, source reconnect failure, meaningful-progress liveness, hard liveness, forced-snapshot scheduling, and artifact probe/settle deadlines;
- one revision-aware deadline coordinator schedules named deadlines, supersedes obsolete timers, and sends `deadline.reached` events to the reducer; timer callbacks never finalize requests directly;
- forced snapshots and artifact probes are typed effects requested by policy rather than direct watchdog side effects;
- request preparation, session/model selection, attachment upload, prompt submission, steering, resume, forced snapshots, and artifact probes emit typed effect lifecycle events; non-retryable effect failures reach canonical terminal state immediately;
- content protocol 3 emits terminal observations but never declares request success/failure or releases ownership; the server reducer decides the outcome and returns an explicit `request.release` command;
- protocol 2 `done`/`error` input remains accepted for compatibility, but is treated as normalized evidence and cannot activate an alternate finalization path;
- canonical snapshots, active deadlines, bounded transition histories, rejected events, and compatibility divergences are exposed through `requestStateDiagnostics()`, `/diagnostics/request-state`, the diagnostics page, and compact/full debug bundles;
- E2E request waits consume canonical snapshots first, fail on the terminal transition that made success impossible, and write sanitized replayable traces on failure or liveness timeout;
- request replay fixtures cover explicit UI error, required ZIP settling, stale observations, and bound-conversation replacement.

Workflow state is also explicit and persisted:

```text
src/workflow/
  context/
  recovery/
  state/
    workflowProjection.js
    workflowState.js
  support/
```

- long-lived watcher state is independent from one pipeline execution;
- pipeline stages explicitly represent observation, download, verification, planning, approval, apply, remediation, recovery, rollback, completion, failure, and rejection;
- state is committed before approval/failure/completion events are published;
- remediation continues the same pipeline identity instead of creating an implicit second pipeline;
- `GET /workflows/:id` exposes the committed watcher/pipeline snapshot;
- workflow E2E waits use pipeline state plus correlated events rather than per-wait fatal-event lists.

The behavioral transition is complete. Remaining work is structural and parity-oriented: gather live-browser replay evidence, continue moving non-request administrative browser commands behind typed operation boundaries where useful, and decompose the remaining oversized coordinators without reintroducing lifecycle ownership outside the reducer.

## Architectural principles

### One authoritative state transition path

Every request state change must pass through one reducer or transition service. Components may publish observations and effect results, but they must not independently mutate canonical lifecycle state.

### Observations are facts, not decisions

The browser observer reports what is visible: document readiness, composer readiness, submitted user turns, assistant activity, blockers, errors, artifacts, URL, and connection health. It does not decide whether a project task is complete or whether an artifact contract is satisfied.

### State and effects are separate

A transition may request an effect such as submitting a prompt, clicking Continue, fetching an artifact, or taking a forced snapshot. An effect runner executes that action and reports a typed result back to the machine.

### Orthogonal dimensions remain orthogonal

A single `phase` string must not mix lifecycle, generation, blockers, output, connection, and artifact readiness. These dimensions are stored independently and exposed through compatibility projections when old callers still need a phase string.

### Revisions make ordering explicit

Every accepted transition increments an entity revision. Browser observation streams also carry a source sequence. Duplicate, stale, and out-of-order events are rejected or recorded diagnostically rather than silently overwriting newer state.

### Unknown observations are not automatically fatal

React DOM replacement can create short-lived incomplete snapshots. Unknown or degraded observations receive a bounded stabilization policy. A stable invariant violation or an explicitly incompatible state becomes fatal immediately.

### Deadlines are events

Deadlines are scheduled by policy and delivered to the machine as events. Reducers do not call timers directly. Cancellation, completion, replacement, or progress invalidates obsolete deadlines.

## Target domain layout

The exact names may evolve during implementation, but dependency direction should follow this shape:

```text
src/
  bridge/
    coordinator/
      requestLifecycleCoordinator.js
    browserClientCoordinator.js
    bridgeClientEventRouter.js
    bridgeOperations.js
      requestCoordinator.js
      sourceBinding.js
    deadlines/
      requestDeadlineCoordinator.js
      requestDeadlinePolicy.js
    state/
      requestEvents.js
      requestMachine.js
      requestPolicy.js
      requestProjection.js
      requestInvariants.js
    store/
      entityStore.js
      transitionJournal.js
      waitForState.js
    effects/
      effectRunner.js
      promptEffects.js
      artifactEffects.js
      browserControlEffects.js
    replay/
      requestTrace.js
    adapters/
      hubObservationAdapter.js
      legacyProgressAdapter.js
      tabObservationAdapter.js
    browserDownloads.js
    clientSelection.js
    externalBrowser.js

  workflow/
    context/
    recovery/
    state/
      workflowState.js
      workflowProjection.js
    support/

tools/chrome-bridge-extension/
  content/
    bootstrap.js
    transport.js
    tabObserver.js
    observationNormalizer.js
    requestEffects.js
    composer/
    sessions/
    intelligence/
    response/
    artifacts/
  content.js
```

`content.js` should eventually become a thin bootstrap and compatibility facade. It should load modules, construct dependencies, register transport handlers, and expose version/diagnostic metadata.

## Canonical request model

The initial canonical snapshot should be explicit and serializable:

```js
{
  requestId: '...',
  revision: 42,
  lifecycle: 'generating',
  source: {
    clientId: '...',
    connection: 'connected',
    conversationId: '...',
    url: '...',
    observationSequence: 184
  },
  submission: 'accepted',
  generation: 'active',
  blocker: 'none',
  output: 'streaming',
  artifact: {
    expectation: 'zip',
    required: true,
    status: 'pending'
  },
  effect: {
    activeId: null,
    activeType: null
  },
  terminal: null,
  timestamps: {
    createdAt: 0,
    transitionedAt: 0,
    meaningfulProgressAt: 0,
    heartbeatAt: 0
  }
}
```

The first implementation should avoid overfitting this exact shape. The important constraint is that lifecycle, observation facts, blocker state, effect execution, and terminal outcome are not collapsed into one string.

## Event envelope

All transition inputs should use a common envelope:

```js
{
  eventId: '...',
  type: 'observation.updated',
  entityType: 'request',
  entityId: '...',
  source: 'extension',
  sourceSequence: 184,
  causationId: '...',
  correlationId: '...',
  occurredAt: 0,
  receivedAt: 0,
  data: {}
}
```

The store commits the accepted event and resulting snapshot atomically from the perspective of subscribers. Subscribers must never observe a new event with an old snapshot.

## Transition outcomes

A reducer returns data only:

```js
{
  accepted: true,
  state: nextState,
  effects: [
    { id: 'effect-...', type: 'artifact.probe.requested', data: {} }
  ],
  deadlines: [
    { id: 'deadline-...', type: 'liveness', dueAt: 0 }
  ],
  diagnostics: []
}
```

Forbidden transitions produce a typed terminal outcome or a diagnostic rejection according to policy. They do not leave the caller waiting for a generic timeout.

## Phased implementation plan

### Phase 0 — Structural preparation

Status: substantially completed. Bridge helpers, canonical request domains, request lifecycle/client/event coordinators, workflow context/recovery/support modules, HTTP route groups, and E2E state helpers have been extracted. `tampermonkeyBridge.js`, `workflowManager.js`, and `routes.js` are below the 1,000-line ceiling. The extension content script, interactive command layer, and real-browser E2E runner remain migration targets.

Objectives:

- establish domain-oriented directories;
- reduce coordinator files without changing behavior;
- document size and ownership rules;
- record current oversized files and intended extraction boundaries.

Work:

- keep the completed `src/bridge/` helper extraction;
- add dependency comments or small module-level documentation where ownership is unclear;
- inventory imports and responsibilities of the largest files;
- do not combine structural movement with lifecycle behavior changes.

Primary decomposition targets:

1. `tools/chrome-bridge-extension/content.js`
   - bootstrap and transport;
   - request effect execution;
   - tab observation;
   - response/turn parsing orchestration;
   - artifact discovery and materialization;
   - session controls;
   - model/effort controls;
   - passive turn observation.
2. `scripts/e2e-real.js`
   - runner bootstrap;
   - bridge process management;
   - generic state waits;
   - diagnostics writers;
   - workflow scenarios;
   - parser scenarios;
   - artifact scenarios.
3. `src/interactiveLegacy.js`
   - command parsing;
   - task orchestration;
   - result selection;
   - recovery;
   - apply workflow;
   - rendering/presentation.
4. `src/tampermonkeyBridge.js`
   - source binding;
   - request coordinator;
   - progress adapter;
   - watchdog/deadline policy;
   - artifact command coordination;
   - finalization compatibility facade.
5. `src/routes.js` and `src/interactiveInk.js`
   - split by endpoint/UI domain rather than by helper type.

Exit criteria:

- no public behavior changes;
- all existing imports remain compatible;
- `npm run check` and the full unit/integration suite pass;
- no new source file exceeds 1,000 lines.

### Phase 1 — State vocabulary and contracts

Status: completed and authoritative.

Objectives:

- define typed event names and canonical state dimensions;
- document invariants and terminal outcomes;
- preserve existing `phase` as a derived compatibility projection.

Work:

- create `src/bridge/state/requestEvents.js`;
- create `requestProjection.js` that maps canonical state to current API/diagnostic fields;
- define lifecycle states and orthogonal enums;
- define terminal codes such as explicit UI error, source lost, conversation changed, request replaced, effect failed, invalid transition, cancelled, and completed;
- map every current extension phase and watchdog condition into the new vocabulary;
- identify observations that are transient/degraded rather than fatal.

Tests:

- table-driven mapping tests for all existing phase strings;
- invariant tests for terminal and non-terminal combinations;
- compatibility snapshot tests for current API responses.

Exit criteria:

- every existing progress phase has an explicit mapping;
- no production path uses the new model yet;
- unknown mappings are visible in diagnostics.

### Phase 2 — Pure request reducer

Status: completed for the pure reducer and synthetic transition coverage.

Objectives:

- implement deterministic transitions without timers, DOM, transport, filesystem, or callbacks;
- make invalid transitions immediately observable.

Work:

- create `requestMachine.js`, `requestPolicy.js`, and `requestInvariants.js`;
- process command, observation, effect-result, connection, cancellation, and deadline events;
- return effects and deadline requests as data;
- define stale and duplicate source-sequence handling;
- define stabilization rules for degraded observations;
- define artifact-contract completion independently from visible answer completion.

Tests:

- exhaustive transition tables for normal request flow;
- unexpected confirmation/error/conversation-change cases;
- duplicate and out-of-order events;
- long active generation with continued liveness;
- post-generation stall;
- required ZIP appearing after answer completion;
- cancellation and source disconnect races.

Exit criteria:

- reducer tests do not instantiate the bridge or extension;
- every terminal result has a typed cause and evidence;
- no reducer branch reads current time directly.

### Phase 3 — Revisioned entity store and state-aware waits

Status: completed.

Objectives:

- create one authoritative snapshot per request;
- eliminate read/subscribe races;
- allow tests and production callers to reject immediately on incompatible terminal state.

Work:

- implement `entityStore.js` with atomic transition publication;
- assign monotonically increasing revisions;
- implement `waitForState()` with subscribe-first, snapshot-second semantics;
- support accept predicates, terminal rejection policy, abort signals, and liveness deadlines;
- expose transition history for diagnostics and replay.

The generic wait contract should resemble:

```js
await store.waitFor(requestId, {
  accept: (state) => state.lifecycle === 'completed',
  reject: (state) => Boolean(state.terminal),
  signal,
  deadline
});
```

Tests:

- transition between subscription and initial snapshot read;
- immediate success from an already-completed snapshot;
- immediate rejection from an already-failed snapshot;
- cancellation and deadline cleanup;
- revision ordering and duplicate publication prevention.

Exit criteria:

- E2E helpers can wait on one store API in a test-only adapter;
- wait failures include last snapshot, terminal cause, and recent transitions.

### Phase 4 — Always-on tab observer

Status: implementation completed; live real-browser parity and overhead validation remain part of Phase 5 validation.

Objectives:

- separate continuous browser observation from active request execution;
- produce normalized facts independent of what a caller currently expects.

Work:

- extract DOM observation scheduling from the active request object;
- run one observer per content-script instance while the page is active;
- emit tab-level observation revisions even when there is no active request;
- normalize URL, conversation, document, composer, turn, generation, blocker, error, and artifact facts;
- preserve passive turn observation while removing duplicate scans where possible;
- keep short stabilization for DOM replacement and foreground resync.

The observer must not:

- finalize a bridge request;
- decide whether an artifact satisfies a project contract;
- invoke workflow actions;
- infer server-side request ownership from DOM alone.

Tests:

- sanitized DOM fixture sequences rather than isolated snapshots only;
- navigation and conversation replacement;
- temporary missing composer during React replacement;
- confirmation, explicit error, generation stop, and late artifact appearance;
- observer continuity without an active request.

Exit criteria:

- extension diagnostics expose current normalized tab observation;
- current request handling still uses legacy logic;
- observer overhead remains bounded and deduplicated.

### Phase 5 — Observation and compatibility adapters

Status: implementation completed; representative real-browser divergence analysis and replay fixtures remain pending.

Objectives:

- feed real extension/server events into the canonical machine through explicit adapters;
- preserve diagnostic comparison during rollout without retaining a second decision path.

Work:

- create `hubObservationAdapter.js` and `legacyProgressAdapter.js`;
- construct canonical events from current messages;
- initially run the reducer/store beside existing `activeRequest` and bridge pending state, then retain the old inputs only as compatibility adapters after cutover;
- record divergence events with old phase, new state, evidence, and revision history;
- add a diagnostic endpoint and E2E report section for divergences.

Safety during rollout:

- the parallel diagnostic model did not click, cancel, finish, download, or apply anything before authority was switched to the canonical runtime;
- divergence logging must be bounded and redact attachment content/secrets;
- rollback during this phase meant disabling only the diagnostic adapter; after Phase 7, rollback uses a previous release rather than a second runtime machine.

Exit criteria:

- representative E2E scenarios complete with no unexplained terminal divergence;
- known differences are classified as legacy bugs or new-machine gaps;
- real failed-run logs can be replayed into the reducer.

### Phase 6 — Effect runner and typed browser actions

Status: completed for request-scoped lifecycle actions. Page readiness, session/model/effort application, attachment upload, prompt submission, steering, resume, forced response snapshots, and required-artifact probes report typed effect outcomes. Cancellation is a canonical command with best-effort UI execution. Administrative artifact-download and tab-management commands remain bounded command handlers because they are not request-state transitions.

Objectives:

- move imperative operations behind explicit effects;
- make every failure a machine event rather than an exception hidden inside a wait loop.

Work:

- introduce effect IDs and idempotency rules;
- wrap prompt submission, attachment upload, session switching, model/effort selection, Continue/Stop actions, forced snapshots, artifact fetch, and browser tab controls;
- return `effect.succeeded`, `effect.failed`, or `effect.cancelled` with typed codes and evidence;
- keep operation-local timeouts for UI controls;
- prevent stale effect results from mutating a newer request revision.

Tests:

- duplicate effect delivery;
- late success after cancellation;
- effect timeout followed by DOM evidence that the action actually succeeded;
- source-tab reconnect during an effect;
- retry policy only for explicitly retryable effects.

Exit criteria:

- the reducer can drive a complete synthetic request using fake effects;
- browser action errors reach terminal state immediately when non-retryable.

### Phase 7 — Production request lifecycle cutover

Status: completed for supported request flows. Canonical state owns normal completion, failure, cancellation, required-artifact completion, release, liveness, steering, and resume outcomes. Content protocol 3 reports facts and executes effects but cannot finalize a request. Compatibility projections preserve existing API fields.

Objectives:

- make canonical request state authoritative for completion, failure, cancellation, and progress;
- retain compatibility APIs through projections.

Work:

- route new requests through coordinator → store → reducer → effect runner;
- use canonical terminal state to call existing callbacks and complete turns;
- replace bridge-local phase mutation with projections;
- replace request-level polling waits with `waitForState()`;
- preserve source-client binding and reconnect/resume semantics.

Cutover order:

1. new requests in tests only;
2. synchronous `/ask` and API chat paths;
3. project turns;
4. resume/recovery paths;
5. passive workflow-originated requests.

Exit criteria:

- known incompatible states reject without waiting for the watchdog;
- active generation remains long-lived while observations show activity;
- no stale partial answer can complete a required-artifact request;
- compatibility endpoints return equivalent or more precise diagnostics.

### Phase 8 — Deadline and watchdog consolidation

Status: completed. The compatibility watchdog and rollback configuration were removed; live long-running ChatGPT validation remains required for parity evidence and additional replay fixtures.

Objectives:

- retain liveness protection without duplicate timer policy;
- convert watchdog decisions into explicit deadline events.

Work:

- centralize meaningful-progress, hard-liveness, post-generation, forced-snapshot, and artifact-settle policy;
- schedule named deadlines associated with request revision and purpose;
- invalidate deadlines on state transitions;
- distinguish effect timeout from request liveness timeout;
- keep forced snapshots as an effect requested by policy, not a direct watchdog side effect.

Exit criteria:

- one component owns request deadline policy;
- timer callbacks never finalize a request directly;
- diagnostics show why each deadline was scheduled and whether it was superseded.

### Phase 9 — Workflow state separation

Status: implementation completed for persisted passive workflows. Live workflow E2E validation remains required before removing all legacy status-only assumptions.

Objectives:

- separate long-lived workflow watcher state from one pipeline execution;
- stop reconstructing workflow stage from loosely related events.

Target shape:

```js
{
  watcher: { status: 'running' },
  pipeline: {
    id: '...',
    status: 'awaiting_approval',
    revision: 12,
    terminal: null
  },
  lastOutcome: null
}
```

Work:

- implement a workflow watcher machine and a pipeline machine;
- commit state before publishing approval/failure/completion events;
- represent download, verification, approval, apply, rollback, remediation, and completion explicitly;
- make workflow tests wait on pipeline state rather than custom fatal-event lists.

Exit criteria:

- a failed pipeline can coexist unambiguously with a running watcher;
- approval state is atomically visible with its event;
- repeated observed turns remain serialized and project-scoped.

### Phase 10 — E2E and replay migration

Status: substantially completed in code and deterministic tests. Real-browser runs must still contribute additional sanitized replay fixtures for newly observed failure classes.

Objectives:

- make failures deterministic and immediately diagnostic;
- stop rebuilding lifecycle independently in `scripts/e2e-real.js`.

Work:

- replace `turnWaitStage()` inference with canonical state snapshots;
- move common state waits and diagnostics into `scripts/e2e/` modules;
- persist bounded observation/transition timelines for failed runs;
- add replay fixtures generated from sanitized failed E2E traces;
- assert terminal cause and transition path, not only timeout text.

Exit criteria:

- an unexpected state fails the test on the transition that made success impossible;
- timeout failures are limited to actual silence/stall cases;
- replay tests cover every previously recurring lifecycle bug category.

### Phase 11 — Legacy removal and structural completion

Status: behaviorally completed and structurally in progress. Regex phase inference, content-side request finalization, duplicate artifact/watchdog timers, rollback state-machine flags, test-only request-stage reconstruction, and per-wait workflow fatal lists are removed. Request lifecycle, browser-client selection, client-event routing, bridge operations, reducer transitions, workflow presentation/recovery/context logic, HTTP workflow routes/SSE streams, and E2E state helpers have been extracted. `tampermonkeyBridge.js` is now an 856-line facade; `workflowManager.js` and `routes.js` are also below 1,000 lines. The remaining oversized coordinators are primarily `content.js`, `interactiveLegacy.js`, `interactiveInk.js`, `domParserCore.js`, and `e2e-real.js`.

Objectives:

- remove duplicate lifecycle inference after parity is proven;
- complete decomposition of oversized coordinators.

Remove or reduce:

Completed behavioral removals:

- server regex-based phase inference that duplicated canonical events;
- content-script request finalization decisions;
- per-wait fatal event lists;
- duplicate settle/watchdog timers and lifecycle rollback flags;
- test-only request-stage reconstruction.

Remaining structural/compatibility cleanup:

- decompose the large content, interactive, parser, and E2E coordinators;
- retire protocol 2 and compatibility fields only in a future explicit breaking release after supported clients have migrated.

Final size goals:

- ordinary domain modules: 100–500 lines;
- cohesive coordinators/adapters: preferably below 750 lines;
- hard exception ceiling: 1,000 lines with a documented reason;
- bootstrap files should normally remain below 300 lines.

Exit criteria:

- no production source file above 1,000 lines without an explicit documented exception;
- `content.js`, `tampermonkeyBridge.js`, `interactiveLegacy.js`, and `e2e-real.js` are coordinators rather than mixed-responsibility implementations;
- full tests, real E2E smoke, project ZIP, artifact, recovery, and workflow scenarios pass.

## Immediate-failure policy

An operation should reject immediately when the canonical state proves that its target is unreachable, including:

- explicit ChatGPT error;
- conversation changed away from the bound conversation;
- source request replaced by another request;
- source tab closed or definitively disconnected without a resumable owner;
- non-retryable effect failure;
- forbidden state transition;
- terminal assistant outcome incompatible with the required output contract;
- cancellation.

An operation should not reject immediately for:

- one incomplete DOM snapshot;
- temporary composer removal during navigation or React replacement;
- long generation that continues to produce generation/liveness evidence;
- an answer becoming terminal while a separately bounded required-artifact settle window is active;
- a retryable UI effect that still has an explicit retry budget.

## Diagnostics requirements

Every terminal failure should expose:

- canonical terminal code and message;
- request revision;
- source client and conversation identity;
- last normalized browser observation;
- active or most recent effect;
- relevant deadlines;
- recent transition list;
- compatibility phase projection;
- whether the failure came from explicit evidence or absence of liveness.

Do not log attachment bodies, secrets, bridge tokens, or unbounded DOM HTML.

## Rollout and rollback

Behavioral rollout flags were temporary and have now been removed. Production has one request state machine. Backward compatibility is one-way: older protocol messages are adapted into canonical events, while they cannot select a legacy lifecycle. Emergency rollback should use a previous released build rather than keeping two state machines active in one runtime.

Database or persisted-state migrations must be additive until cutover. New fields must tolerate old rows. Replaying old events through a new reducer must use an explicit schema version.

## Definition of done

The migration is complete when:

- request state is continuously updated from observations regardless of which caller is waiting;
- one reducer owns canonical request transitions;
- subscribers react to committed revisions rather than polling independent interpretations;
- known incompatible states fail immediately;
- timeouts represent actual silence, effect bounds, or liveness loss;
- workflow watcher and pipeline states are separate;
- E2E failures contain the transition and evidence that made the scenario fail;
- oversized legacy files have been decomposed into cohesive domain modules.
