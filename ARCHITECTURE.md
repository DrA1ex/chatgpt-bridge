# Canonical Browser Bridge Architecture

## Purpose

The project uses a single revisioned state architecture for browser observations, request lifecycle, typed effects, deadlines, workflows, and test waits. Protocol 3 and the Chrome/Chromium extension are the only supported browser contract.

The migration from distributed waits and duplicate lifecycle inference is complete at runtime. Remaining work is structural decomposition and live-browser evidence, not coexistence with an older architecture.

## Current runtime

```text
Chrome extension background
  -> authenticated /extension/ws connection
  -> BrowserExtensionHub
  -> BrowserBridge facade
       -> BrowserClientCoordinator
       -> BridgeClientEventRouter
       -> RequestLifecycleCoordinator
            -> canonical reducer
            -> revisioned EntityStore
            -> RequestDeadlineCoordinator
            -> EffectRunner
       -> BridgeOperations

Content script
  -> always-on TabObserver observations
  -> typed terminal snapshots / failures
  <- request-scoped commands and request.release
```

The content script observes and executes. The server reducer decides.

## Canonical request state

Request state is multidimensional rather than a single overloaded phase:

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
  revision
}
```

A committed revision contains the new snapshot and its transition record. Subscribers react to revisions; they do not reconstruct state from log strings.

### Terminal ownership

Only `RequestLifecycleCoordinator` may materialize a request terminal result. Content observations, effect failures, cancellations, and deadlines enter the reducer as events. The coordinator then:

1. commits the terminal revision;
2. materializes the public result/error;
3. stops deadlines and pending effects;
4. sends `request.release` to the source tab.

There is no second watchdog, content-side completion path, protocol downgrade, or rollback state machine.

## Observation ownership

`TabObserver` runs independently of active requests and publishes revisioned facts:

- URL and conversation identity;
- document/composer readiness;
- prompt submission evidence;
- generation state;
- assistant-turn/output state;
- blockers and explicit UI errors;
- artifact evidence.

Temporary DOM degradation is stabilized before publication. Unknown DOM structure is not automatically terminal; explicit invariant violations and durable request-owned failures are.

Observations include an observer epoch and monotonic revision. The hub rejects stale revisions within an epoch and accepts a restarted sequence only after the epoch changes.

## Typed effects

Request-scoped browser actions use `EffectRunner` and report:

```text
effect.started
effect.succeeded
effect.failed
effect.cancelled
```

Covered operations include page preparation, conversation switching, model/effort selection, attachment upload, prompt delivery, steer, resume, forced snapshot, artifact probe, cancellation, and release.

Effect failures preserve their original typed error code and enter the same reducer used by observations and deadlines.

## Deadline model

`RequestDeadlineCoordinator` owns independent deadlines for:

- meaningful progress;
- active generation liveness;
- post-generation finalization;
- source reconnect;
- forced snapshot response;
- required artifact probe and settle;
- hard request liveness.

Timer callbacks emit `deadline.reached`. The reducer decides whether to retry an effect, continue waiting, or terminate. Weak heartbeat noise does not extend meaningful-progress deadlines.

## Workflow model

Workflow state has independent dimensions:

```js
{
  watcher: { status },
  pipeline: { id, status, stage, outcome, failure },
  lastOutcome
}
```

Watcher lifetime is independent of pipeline success or failure. Pipeline state is committed before correlated events are published. Approval, rejection, remediation, recovery, apply, and rollback remain within one pipeline identity.

Old status-only persisted snapshots are rejected rather than inferred.

## Race-safe waits

All request and workflow waits follow this order:

1. subscribe;
2. read the current snapshot;
3. evaluate accept/reject predicates;
4. process later revisions.

Terminal states reject immediately when they cannot satisfy the requested condition. Timeouts remain only for genuine absence of progress or loss of liveness.

## Replay and diagnostics

Canonical request diagnostics include:

- current compact snapshot;
- revision and observer epoch;
- bounded transition history;
- active deadlines;
- active/recent effects;
- source client identity;
- sanitized replay trace.

Recurring failure classes must gain a replay fixture. E2E failures should persist a trace before assertions so the reducer path can be replayed without a live browser.

## Source layout

```text
src/
  browserBridge.js
  browserExtensionHub.js
  bridge/
    adapters/
    coordinator/
    deadlines/
    effects/
    replay/
    state/
    store/
  http/
  interactive/
  project/
  workflow/

tools/chrome-bridge-extension/
  background.js
  content.js
  content/
  observation/
  artifactParserCore.js
  domParserCore.js
  responseParserCore.js

scripts/e2e/
```

## Migration phases and status

### Phase 0 — Structural rules

**Complete and ongoing.** Domain-oriented directories and the 500/1,000-line rules are documented in `AGENT.MD`. New oversized files are prohibited.

### Phase 1 — Canonical event and state vocabulary

**Complete.** Lifecycle, generation, blocker, output, artifact, connection, effect, and terminal dimensions are explicit.

### Phase 2 — Pure reducer and invariants

**Complete.** Reducer transitions are deterministic and free of DOM, transport, timer, and filesystem effects.

### Phase 3 — Revisioned store and waits

**Complete.** Atomic snapshots, transition journals, stale-event protection, and race-safe waits are in production.

### Phase 4 — Always-on tab observation

**Complete in code.** Observation runs independently of requests and uses epoch/revision ordering. Live-browser regression coverage must continue to grow.

### Phase 5 — Integration and parity

**Complete.** Browser observations feed the authoritative store directly. The former shadow runtime and divergence adapter were removed.

### Phase 6 — Typed effects

**Complete for request lifecycle.** Request-scoped browser operations and policy-triggered probes/snapshots report typed outcomes. Administrative operations remain bounded commands because they do not mutate lifecycle state.

### Phase 7 — Authoritative lifecycle cutover

**Complete.** Normal completion, failures, cancellation, artifact requirements, and source release are server-owned. The content script no longer finalizes requests.

### Phase 8 — Deadline consolidation

**Complete.** One deadline coordinator owns liveness and artifact timing. No duplicate watchdog or settle timers remain.

### Phase 9 — Workflow state separation

**Complete.** Watcher and pipeline are independent and persisted atomically. Status-only compatibility was removed.

### Phase 10 — Replay and E2E state waits

**Substantially complete.** E2E waits use canonical snapshots and terminal revisions. Replay fixtures cover known recurring lifecycle failures. Continue adding traces from live failures.

### Phase 11 — Structural decomposition

**Substantially complete.** Completed reductions include:

- `browserBridge.js`, `workflowManager.js`, and `routes.js` below 1,000 lines;
- `interactiveInk.js` and `interactive/controller.js` below 1,000 lines;
- interactive state, apply, formatting, progress, view, and command routing extracted into cohesive modules;
- `content.js` reduced to a 987-line manifest-loaded assembly and transport facade;
- browser-side session, intelligence, composer, attachments, response DOM, artifacts, snapshots, telemetry, status, setup UI, command routing, and request monitoring extracted into `content/` modules;
- `domParserCore.js` reduced to 922 lines;
- artifact-card, preview, materialization, and lifecycle parsing extracted into the 479-line `artifactParserCore.js`.

The remaining oversized production file is:

1. `scripts/e2e-real.js` (2,353 lines).

Its intended decomposition remains:

```text
scripts/e2e/
  runner.js
  environment.js
  browserSession.js
  scenarioRegistry.js
  scenarios/
  assertions/
  diagnostics/
```

Reasoning validation, live parser observation, and model/effort selection have already moved into focused `scripts/e2e/` modules. Keep `e2e-real.js` as a thin scenario launcher. Scenario-specific selectors, assertions, cleanup, diagnostics, and browser-session mechanics must live in focused modules rather than being added to the runner.

### Phase 12 — Compatibility removal

**Complete in version 5.0.0.** Removed:

- protocol 2;
- HTTP polling and page/userscript transport;
- alternate interactive readline runtime;
- status-only workflow persistence;
- request phase compatibility reducer/projection;
- deprecated transport settings and endpoints;
- historical runtime class names and `/tm/ws` path;
- CSP-bypass development extension.

Protocol 3 clients connect at `/extension/ws`. There are no aliases.

## Remaining completion criteria

The architectural transition is considered fully closed when:

- `e2e-real.js` is below the 1,000-line ceiling or is split into documented cohesive modules;
- a full live ChatGPT E2E run passes with extension 1.x/content 3.x;
- live E2E produces no lifecycle state reconstruction outside canonical snapshots;
- every recurring live failure has a sanitized replay fixture;
- source and docs contain no active references to removed transports, protocols, or APIs.

## Rollback policy

There is no runtime rollback switch. Emergency rollback means deploying a previous released build. Keeping two state machines or transports in one process is prohibited.
