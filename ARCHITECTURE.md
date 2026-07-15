# Canonical Browser Bridge Architecture

## Status

The architectural migration is complete in code. The bridge has one browser transport, one request state machine, one deadline owner, one workflow state model, and one public execution model. The old polling/userscript transport, protocol downgrade paths, content-owned completion, duplicate watchdogs, status-only workflow state, job API, and alternate interactive runtime have been removed.

The remaining release activity is operational verification against the live ChatGPT UI. Live E2E may discover new DOM variants, but those variants must be added as sanitized fixtures; they must not introduce another lifecycle implementation.

Current versions:

- bridge package: `5.1.0`;
- extension package: `1.0.1`;
- content runtime: `3.0.1`;
- extension protocol: `3`.

## System overview

```text
Chrome / Chromium
  extension background
    authenticated /extension/ws
      BrowserExtensionHub
        BrowserBridge facade
          BrowserClientCoordinator
          BridgeClientEventRouter
          RequestLifecycleCoordinator
            Request reducer
            EntityStore + transition journal
            RequestDeadlineCoordinator
            EffectRunner
          BridgeOperations

ChatGPT tab
  manifest-ordered content modules
    always-on TabObserver
    DOM/parser adapters
    browser command executors
    request telemetry
      observations / terminal snapshots / effect results
        -> server canonical request machine
      request-scoped commands / request.release
        <- server
```

The browser observes and executes. The server decides request state, completion, failure, cancellation, artifact policy, deadlines, and release.

## Composition roots and dependency direction

`src/index.js` is the server composition root. It creates stores, the extension hub, the bridge facade, HTTP/RPC surfaces, project services, turn management, and workflow management.

`tools/chrome-bridge-extension/content.js` is the content-runtime composition root. It wires manifest-loaded modules and transport only. DOM policy and command implementations live in `tools/chrome-bridge-extension/content/`.

Dependency direction is intentionally one-way:

```text
pure vocabulary / parser / reducer / policy
  <- stores and coordinators
  <- transport and UI adapters
  <- composition roots
```

Pure modules must not import browser DOM, timers, transport, or filesystem APIs. Browser modules receive cross-module dependencies explicitly from `content.js`; they must not rely on free identifiers from another manifest script.

## Browser transport

Protocol 3 over the extension background WebSocket is the only supported browser transport.

The extension handshake contains:

- `extensionVersion`;
- `clientVersion`;
- `extensionProtocolVersion`;
- source-tab identity and capabilities.

`BrowserExtensionHub` owns authenticated clients, compatibility gating, active selection, source ownership, and latest tab observations. Incompatible clients remain visible in diagnostics but cannot receive commands.

There are no transport aliases, polling endpoints, page-context userscripts, protocol downgrade adapters, or hidden fallbacks.

## Canonical request model

Request state is multidimensional:

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

A single overloaded phase string is not authoritative. Human-readable phase labels are projections of committed canonical state.

### Request event sources

The reducer accepts normalized events from four sources:

1. tab observations;
2. typed browser effects;
3. explicit user/bridge commands such as cancellation;
4. named deadline events.

All events are associated with one request identity and committed through the revisioned store.

### Terminal ownership

Only `RequestLifecycleCoordinator` may materialize a terminal request result.

The terminal path is:

1. normalize the event;
2. reduce and validate the transition;
3. atomically commit snapshot plus transition revision;
4. materialize the public result or typed error;
5. stop request deadlines and effects;
6. send `request.release` to the source tab.

The content runtime never independently resolves or rejects a bridge request.

## Always-on tab observation

`TabObserver` runs independently of active requests. It publishes facts about:

- URL and conversation identity;
- document, chat root, and composer readiness;
- prompt-submission evidence;
- generation state;
- assistant-turn state and visible output;
- blockers and explicit UI errors;
- artifact lifecycle evidence;
- currently bound request identity.

Each observer instance has an epoch identifier and monotonically increasing revision. The hub rejects stale observations within an epoch. A content-script restart begins a new epoch and may restart revisions from one.

Temporary React DOM replacement is stabilized before a degraded observation is published. Unknown or degraded DOM is not automatically terminal. Durable request-owned invariant violations and explicit failures are terminal.

## Content-runtime modules

The content runtime is loaded in manifest order. The current domain modules include:

```text
tools/chrome-bridge-extension/content/
  runtimeConfig.js
  sessionCommands.js
  intelligenceCommands.js
  composerCommands.js
  attachmentCommands.js
  requestPreparation.js
  requestMonitor.js
  requestTelemetry.js
  responseRecovery.js
  responseDom.js
  artifactDom.js
  artifactTransfer.js
  turnSnapshots.js
  pageStatus.js
  setupPanel.js
  commandRouter.js
```

Pure parser cores remain separate from DOM command modules:

```text
artifactParserCore.js
responseParserCore.js
domParserCore.js
requestLifecycleCore.js
observation/tabObservationCore.js
```

A manifest-order bootstrap test executes the complete content runtime in a VM and fails on temporal-dead-zone or missing cross-module dependency errors. This test is mandatory because syntax-only tests cannot detect initialization-order failures.

## Typed effects

Request-scoped browser actions run through `EffectRunner` and emit:

```text
effect.started
effect.succeeded
effect.failed
effect.cancelled
```

Typed effects cover:

- page preparation;
- conversation switching;
- model and effort selection;
- attachment upload;
- prompt delivery;
- steering;
- resume and recovery snapshots;
- forced snapshots;
- artifact probes;
- cancellation;
- source release.

Effect failures preserve the original error code and enter the same reducer as observations and deadlines. A general catch block must not create a second terminal path.

## Deadlines and liveness

`RequestDeadlineCoordinator` is the only request deadline owner. It manages independent policies for:

- meaningful result progress;
- active generation liveness;
- post-generation processing;
- source reconnect;
- forced-snapshot response;
- required artifact probe and settle;
- optional hard request lifetime.

Timer callbacks emit `deadline.reached`; they do not directly complete requests. The reducer decides whether to continue, request an effect, or terminate.

Visible active generation is positive liveness evidence. Weak heartbeat noise does not extend meaningful-progress deadlines.

## Revisioned store and waits

`EntityStore` atomically stores the current snapshot and bounded transition journal. Consumers wait through a race-safe sequence:

1. subscribe;
2. read the current snapshot;
3. evaluate accept/reject predicates;
4. process later revisions.

A terminal state rejects immediately when it cannot satisfy the requested condition. Timeouts are reserved for genuine absence of progress or liveness.

Production code and E2E scenarios must not reconstruct lifecycle state from log text, visible buttons, legacy phase strings, or local fatal-event lists.

## Turn and result model

Threads, turns, and items are the only durable execution model. `TurnManager` owns turn/item convergence. `ResultResolver` owns artifact selection, download, ZIP validation, and result events.

The removed job API and job event journal must not be reintroduced. Parser and result diagnostics are correlated directly with their turn and request identities.

## Workflow model

Workflow state has independent watcher and pipeline dimensions:

```js
{
  watcher: { status },
  pipeline: {
    id,
    status,
    stage,
    outcome,
    failure
  },
  lastOutcome
}
```

The watcher may remain running while a pipeline is awaiting approval, completed, rejected, or failed. Pipeline state is committed before correlated events are published. Download, verification, approval, apply, remediation, recovery, rollback, and terminal outcome remain under one pipeline identity.

Status-only persisted snapshots are incompatible and rejected rather than inferred.

## DOM evidence and replay pipeline

Live E2E can capture real ChatGPT markup for deterministic offline tests.

Enable it with:

```bash
npm run test:e2e:capture-dom
```

or:

```bash
npm run test:e2e:real -- \
  --scenario response-markdown \
  --capture-dom-fixtures \
  --fixture-output-dir test/fixtures/chat-dom/captured/<capture-name>
```

For each request, capture mode stores:

```text
<scenario>/<request>/
  NN-<phase>-<hash>.html
  NN-<phase>-<hash>.fixture.json
  request-trace.json
index.json
```

The captured HTML is only the scoped assistant turn, not the complete ChatGPT page. Before writing, the capture layer removes or replaces URLs, tokens, account/message identifiers, emails, run markers, and other dynamic identity data.

The fixture JSON stores the semantic parser expectation observed during the live run. `test/capturedDomFixtures.test.js` then:

1. loads the sanitized HTML without Chrome;
2. runs the real artifact/response/turn parser modules;
3. compares semantic blocks, code, artifacts, and coverage;
4. replays the canonical request trace through the reducer.

Captured expectations are evidence from the live parser, not permanent truth by themselves. Before promoting a new fixture, review the sanitized HTML and expectation for sensitive data and verify that the expected semantics are correct.

Recurring DOM or lifecycle failures must be converted into fixtures. Fixing only the live E2E wait or selector without adding deterministic evidence is incomplete.

## E2E architecture

`scripts/e2e-real.js` is a launcher and shared orchestration facade below the 1,000-line ceiling. Scenario logic lives in:

```text
scripts/e2e/
  cli.js
  diagnostics.js
  dom-fixture-capture.js
  workflow-runtime.js
  request-state-wait.js
  request-state-trace.js
  reasoning-support.js
  parser-observation.js
  intelligence-selection.js
  scenarios/
    core.js
    workflows-projects.js
```

Scenarios use public bridge APIs and committed canonical snapshots. Scenario modules may make DOM-specific assertions from captured parser output, but they may not infer request lifecycle independently.

## Diagnostics

Request diagnostics include:

- compact canonical snapshot;
- request revision and observer epoch;
- bounded transition history;
- active deadlines;
- active and recent effects;
- source client identity;
- sanitized replay trace.

E2E writes partial diagnostics before the first real prompt and final JSON, NDJSON, Markdown, and ZIP outputs at completion or interruption.

## Source layout and size policy

```text
src/
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

scripts/e2e/
tools/chrome-bridge-extension/content/
tools/chrome-bridge-extension/observation/
test/fixtures/chat-dom/captured/
```

The target source-file size is 500 lines. A cohesive module may approach 1,000 lines, but no production source file may exceed 1,000 lines. Composition roots and coordinators must remain thin.

At version 5.1.0 all production JavaScript files are below the 1,000-line ceiling. Files close to the ceiling must be split when their next substantial responsibility is added; they must not grow beyond the limit.

## Architectural invariants

The following are release-blocking invariants:

- one extension WebSocket transport and protocol 3;
- one canonical request reducer;
- one terminal materialization path;
- one request deadline coordinator;
- no content-owned request completion;
- no lifecycle inference in E2E or HTTP consumers;
- watcher and workflow pipeline remain independent;
- all content-runtime cross-module dependencies are explicit;
- manifest-order content bootstrap passes;
- real DOM parser changes have sanitized deterministic fixtures;
- production source files remain below 1,000 lines;
- no runtime rollback switch that restores a second architecture.

## Verification status

Completed in code:

- canonical state/reducer/store/effects/deadlines;
- always-on observations;
- server-owned terminal lifecycle;
- workflow state separation;
- legacy removal;
- content/parser/interactive/server decomposition;
- E2E scenario decomposition;
- manifest-order bootstrap regression;
- optional live DOM and canonical trace capture;
- offline parser and reducer replay tests.

Required before declaring a specific release verified against the current ChatGPT deployment:

1. reload extension `1.0.1` in the target browser profile;
2. run the full live E2E matrix;
3. run the DOM-capture scenario set;
4. review and promote any new sanitized fixtures;
5. rerun `npm run check` and `npm test`.

This is release validation, not an unfinished alternative architecture.

## Rollback policy

There is no runtime architecture rollback switch. Emergency rollback means deploying a previous release. Two state machines, two transports, or two terminal paths must never coexist in one process.
