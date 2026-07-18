# Canonical Browser Bridge Architecture

## Status

The architectural migration is complete in code. The bridge has one browser transport, one request state machine, one deadline owner, one workflow state model, and one public execution model. The old polling/userscript transport, protocol downgrade paths, content-owned completion, duplicate watchdogs, status-only workflow state, job API, and alternate interactive runtime have been removed.

The remaining release activity is operational verification against the live ChatGPT UI. Live E2E may discover new DOM variants, but those variants must be added as sanitized fixtures; they must not introduce another lifecycle implementation.

Current versions:

- bridge package: `6.0.0`;
- extension package: `2.0.0`;
- content runtime: `4.0.0`;
- extension protocol: `4`.

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

Protocol 4 over the extension background WebSocket is the only supported browser transport. Every message has an id, typed kind, server/background/content epochs, monotonic source sequence, optional request lease, command/effect correlation, and an immutable payload. Critical observations and results are persisted in the background outbox until the server acknowledges them after canonical commit.

The extension handshake contains:

- `extensionVersion`;
- `clientVersion`;
- `extensionProtocolVersion`;
- source-tab identity and capabilities.

`BrowserExtensionHub` owns authenticated clients, compatibility gating, active selection, source ownership, and latest tab observations. Incompatible clients remain visible in diagnostics but cannot receive commands.

There are no transport aliases, polling endpoints, page-context userscripts, protocol downgrade adapters, compatibility bypass commands, or hidden fallbacks. Raw and older-protocol messages are rejected at the WebSocket boundary.

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

`TabObserver` is the only DOM mutation scheduler and runs independently of active requests. Active-request and passive-turn consumers subscribe to the same committed observations. It publishes facts about:

- URL and conversation identity;
- document, chat root, and composer readiness;
- prompt-submission evidence;
- generation state;
- assistant-turn state and visible output;
- blockers and explicit UI errors;
- artifact lifecycle evidence;
- currently bound request identity.

Each observer instance has an epoch identifier and monotonically increasing revision. The hub rejects stale observations within an epoch. A content-script restart begins a new epoch, restores the persisted background lease as `reconciling`, and may restart observation revisions from one; stale events from the previous epoch cannot mutate the lease.

Temporary React DOM replacement is stabilized before a degraded observation is published. Unknown or degraded DOM is not automatically terminal. A single submitted user turn may be followed by separate reasoning, final-text, and artifact-bearing assistant turn containers, so request scoping always selects the latest meaningful assistant turn after the submitted user turn. If React virtualizes that turn, recovery may use a later visible request-owned turn or the last committed request output. Durable request-owned invariant violations and explicit failures are terminal. Missing assistant DOM by itself is not a browser-owned failure; forced snapshots and canonical deadlines remain server-owned.

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
  requestSnapshotPolicy.js
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

A manifest-order bootstrap test executes the complete content runtime in a VM and fails on temporal-dead-zone or missing cross-module dependency errors. Domain factories validate critical injected dependencies during assembly, so missing functions fail at bootstrap instead of during a later DOM mutation or request. This test is mandatory because syntax-only tests cannot detect initialization-order failures.

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

Visible active generation is positive liveness evidence. Weak heartbeat noise does not extend meaningful-progress deadlines. The response action bar is strong completion evidence but is not a required invariant: stopped generation plus stable request-owned final output or a ready artifact may produce a medium-confidence terminal observation after the settle window.

## Revisioned store and waits

`EntityStore` atomically stores the current snapshot and bounded transition journal. Consumers wait through a race-safe sequence:

1. subscribe;
2. read the current snapshot;
3. evaluate accept/reject predicates;
4. process later revisions.

A terminal state rejects immediately when it cannot satisfy the requested condition. Timeouts are reserved for genuine absence of progress or liveness.

Production code and E2E scenarios must not reconstruct lifecycle state from log text, visible buttons, legacy phase strings, or local fatal-event lists.

Real-E2E scenario groups receive their shared dependencies through validated context factories. Static dependencies are checked before the isolated bridge or browser tab starts; request-bound values such as session and source client are checked before scenario registration. A scenario module must not rely on ad-hoc object assembly at its call site.

## Turn and result model

Threads, turns, and items are the only durable execution model. `TurnManager` owns turn/item convergence. Streaming answer callbacks are serialized through one per-turn writer before touching metadata, so concurrent partial snapshots update one `agent_message` rather than creating multiple records. `ResultResolver` owns artifact selection, download, ZIP validation, and result events.

The removed job API and job event journal must not be reintroduced. Parser and result diagnostics are correlated directly with their turn and request identities.

## Public turn progress stream

The public turn event stream is part of the execution contract, not merely a diagnostic projection. Consumers may subscribe before a turn is created:

```text
GET /turns/:id/events?stream=1&recent=0&wait=1
```

The stream emits `ready` immediately, then committed turn/item events in persistence order. Visible reasoning and progress snapshots expose stable public fields such as `logicalId`, `kind`, `text`, `revision`, `state`, `active`, and `visible`. Completion wrappers retain the same logical identity.

The real reasoning E2E opens this SSE connection before `POST /turns`, then proves that:

1. `0%` through `100%` arrive as ordered live updates rather than one terminal replay batch;
2. the first and last checkpoints have meaningful wall-clock separation and multiple receive timestamps;
3. `100%` arrives before the final agent message and terminal turn event;
4. every published progress/reasoning logical item receives a completion wrapper;
5. the exact public records and validation result are saved in `public-progress-events.json`.

DOM timelines remain parser evidence, but they cannot satisfy the public streaming contract by themselves.

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

### Workflow presets and UX model

The normal interactive surface begins with `/workflow`. It maps three user goals onto one shared workflow runner:

```text
Apply changes from ChatGPT
Fix the project until checks pass
Work through a task
```

No workflow state is created by ordinary prompts alone. The context-sensitive wizard starts a workflow in at most five normal decisions, reopens pending attention directly, and keeps pause, resume, stop, settings, and completion actions in one place. Existing slash commands and headless `bridge workflow run` / `bridge workflow serve` remain advanced compatibility surfaces over the same manager.

Wizard screens form a reversible navigation history. Space toggles multi-select values, while Esc or Alt+Left restores the previous screen and its selected row without rebuilding or clearing the draft. A setup exception remains inside the wizard as a retry, edit-summary, or close decision. Slash completion treats bare `/workflow` as `open wizard`; typing the argument separator exposes optional `open`, `new`, `active`, `attention`, and `settings` targets.

Global defaults and saved profiles live in formatted JSON under `~/.bridge-data/workflows/config.json`. Known fields are validated with exact JSON paths, unknown fields are preserved, and profile values are resolved over global defaults before a preset configuration is created. Per-workflow changes update both the live runtime and its persisted profile.

The runner composes shared services rather than separate preset engines:

```text
wizard and status projection
configuration and overrides
attention and notification delivery
chat bootstrap and session recovery
project fingerprint and context refresh
result protocol validation and repair
transactional application
check execution and no-progress detection
workflow-owned commit tracking and squash
```

New or recovered chats receive a fresh project archive and a separate workflow instruction attachment. Existing chats may quietly reuse their current context. Before each workflow request, Bridge compares the effective local project fingerprint with the snapshot recorded for the bound chat; unchanged projects are not uploaded again, while changed projects replace the remote snapshot with an explicit obsolete-context instruction.

Automatically applicable result archives require `bridge-result.json`. The manifest `files` field is optional and advisory: the effective create/update/delete plan is derived from the transactional project diff, listed unchanged files are ignored, and undeclared real changes remain visible in reconciliation diagnostics. Workflow control files are excluded from both preview and extraction. Recoverable validation failures enter bounded automatic repair; retry exhaustion becomes a persistent attention decision. Repair responses are consumed once across the direct request path and passive observer path, and workflow-owned service prompts inherit configured intelligence instead of hard-coding `instant`.

Git ownership is path- and content-specific. Bridge captures the initial worktree, the exact paths applied by the workflow, and their post-apply hashes. Commit approval, asynchronous commit-message generation, final-only commits, and squash all revalidate those states before staging only the workflow-owned paths. Unrelated local work is preserved; overlapping later edits become an attention conflict.

Session recovery follows global or per-workflow policy. Explicit exhaustion signals and the configured maximum workflow-turn count can start a fresh chat automatically, ask the user, or stop. Automatic recovery uploads the latest project and instructions, sends a concise handoff, updates the bound session, and resumes the same runner state.

Apply Changes adds a read-only live transcript path beside the terminal result pipeline. The extension emits deduplicated transient snapshots for newly observed user turns and assistant progress, keyed by the originating user turn so separate reasoning and final-answer containers remain one transcript group. `BridgeClientEventRouter` publishes these through the non-retained event channel; `ApplyWorkflowLiveMonitor` updates stable user, reasoning, and answer entries only for the bound Apply Changes workflow. Terminal observed turns still follow the normal validated workflow pipeline, so streaming text cannot apply files or settle workflow state.

Interactive startup resolves its project root from an explicit CLI project, the selected persisted workflow, or the process launch directory in that order, and opens the saved workflow continuation view after runtime initialization. Model/effort synchronization uses bounded individual browser commands but retries indefinitely while the workflow-owned client remains connected. Passive artifact materialization timeouts transition the current pipeline to a deferred terminal state, clear stale error attention, and leave the watcher active for the next result. The apply path policy protects the project-root `.gitignore` from sync deletion even when it is absent from a returned archive. Shutdown detaches preserved workflow queues, bounds server draining, force-closes lingering HTTP connections, and reports each phase after the TUI restores the normal screen.

The interactive presentation uses explicit scroll state for the transcript and full-details pane. View preparation computes wrapped rows and visible-row metrics, applies sticky-tail autoscroll only while the user remains at the bottom, and returns committed metrics to the runtime. Plain arrow keys first move within multiline/wrapped editor content, then navigate active completion, and use project/directory-scoped persistent history only from an empty editor or unchanged recalled entry. Page keys, Shift/Option+arrow, Ctrl+Home/End, mouse wheel/trackpad input, and scrollbar click/drag navigate the pane under control. Responsive layout has three explicit modes: full-width chat below 115 columns, left sidebar plus expanding chat from 115 through 169 columns, and two sidebars with an expanding center chat from 170 columns. Header, editor, contextual completion, and footer always span the viewport. Completion contributes rows only while visible and temporarily reduces the transcript viewport; no empty suggestion capacity is reserved. The key sidebar is hidden when vertical space cannot show it meaningfully; the footer then exposes only essential shortcuts, while Ctrl+B and `/help` retain the full reference. Ctrl+B uses one scrollable column below 120 columns and two from 120 columns. Slash completion is contextual: command help appears from the first `/`, no-argument variants are selectable, then the surface switches to subcommand, flag, value, numbered tab/session selectors, and optional full runtime-ID matches. Theme selection previews Terlio presets without mutating persisted state until confirmation. The runtime delegates SGR pointer decoding, pointer-region dispatch, wheel events, and pointer-capture lifecycle to `terlio.js@1.1.0`; bridge code only maps those semantic events into its shared scroll state. Assistant answer chunks update one stable transcript entry in place until completion. The transcript uses Terlio SelectableText for multiline drag selection and short-click copy. The prompt editor grows to five rows, enables bracketed paste, and wraps Terlio InputEditor with compact atomic display spans for pasted text above 250 symbols while preserving exact submission bytes and history serialization.

### Multi-process workflow topology

A ChatGPT tab has exactly one browser-lifecycle owner: the primary bridge connected to the extension WebSocket. Two bridge processes must never compete for direct ownership of the same tab.

Independent workflow processes integrate through the primary bridge's authenticated observed-turn API:

```text
primary BrowserBridge
  terminal observed-turn sequence journal
    GET /browser/observed-turns
    GET /browser/observed-turns/stream
      independent workflow-worker
        RemoteBrowserBridge
        own FileStore and WorkflowManager state
        artifact download through primary HTTP API
        verify / approve / apply / remediate locally
```

Observed turns receive monotonic sequence numbers. The SSE transport supports replay from `Last-Event-ID` or `after`, so reconnect does not require a second browser observer. The worker imports upstream artifacts into its own artifact store before verification and application.

This topology is covered twice: a deterministic multi-process integration test starts a primary API process plus a separate worker process, and the real-browser `workflow-multi-bridge` scenario uses the actual primary bridge/tab while a child worker observes and applies the generated ZIP.

### Passive terminal observation and bounded workflow waits

Passive workflow observation uses the same completed-snapshot policy as active request monitoring. A stable request-owned final answer or ready artifact may be terminal after generation quiescence even when ChatGPT has not mounted the response action bar. The passive path must not keep a separate, stricter terminal rule.

Immediately before an explicit passive prompt is submitted, every assistant turn already present in that conversation is hard-baselined. The workflow can therefore accept only a terminal assistant turn created after the newly captured user-turn anchor; a completed turn from the previous workflow scenario cannot be re-observed as new work.

Real workflow E2E has two independent liveness bounds:

- `--workflow-wait-timeout-ms` is the absolute limit for each workflow wait stage and defaults to 120 seconds;
- `--pipeline-idle-timeout-ms` defaults to 60 seconds and applies after a pipeline has started but no committed workflow progress occurs.

Timeouts produce typed `WorkflowWaitTimeoutError` or `WorkflowWaitIdleTimeoutError` failures with the current pipeline status and recent events. Manual interruption marks the active scenario as interrupted, prints the final deduplicated failure summary, and writes terminal diagnostics.


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

## Command correlation and transport telemetry

Browser commands have a request/response correlation contract independent from request lifecycle telemetry. A command is registered in the pending-command map before bytes are sent to the extension, so a synchronous response cannot be lost. Messages that carry the same `commandId` but represent diagnostics, progress, snapshots, status, or typed-effect telemetry never resolve the command. Only an explicit response payload or `command.error` may settle it.

This distinction is release-blocking for passive prompts: `passive.prompt.submit.started` diagnostics may precede `passive.prompt.submitted`, but only the latter confirms the submitted user turn. Command telemetry must continue through the normal event/diagnostic path without consuming the command response slot.

## Startup extension reload

Interactive mode and real E2E share `src/extensionStartup.js`. At startup they read the bundled `manifest.json` and `CONTENT_SCRIPT_VERSION`, apply the `ask|always|never` policy, and compare both values with a compatible connected client. `ask` skips without prompting when both versions match. A mismatch may send `extension.reload` with structured version, source-tab, launch-token, and temporary-server fields, then waits for the exact local package/content versions. An older-protocol client must be updated manually or through the installer before startup continues.

There is no compatibility bypass and no encoded legacy reload wire. The bridge does not claim to change Chrome's unpacked-extension path: Chrome must already point to the checkout's extension directory.

Extension restart recovery does not depend on a new service worker receiving a particular lifecycle event. Before `chrome.runtime.reload()`, the content runtime asks the MAIN-world bridge to arm a page-owned delayed navigation. The background persists a bounded one-shot handoff in `chrome.storage.local`, while active tab leases, effects, critical outbox entries, and download captures use the v4 `chrome.storage.session` namespace. Synthetic `bridge-reload-*` markers can carry a temporary connection only; they can never authorize tab cleanup.

## Scenario isolation and artifact assertions

A failed real-E2E scenario must not contaminate later scenarios. When the isolated source tab remains busy, the runner reloads that exact tab and waits for page/composer readiness and no active generation before continuing. Recovery is recorded in the report.

Generated text artifacts are compared semantically at their format boundary: JSON is parsed and normalized; source text and CSV normalize line endings and optional trailing newlines. Workflow apply assertions use the same normalization and do not reject an otherwise exact source file only because its final newline is absent. Binary artifacts continue to require byte-level signature and archive validation.

Artifact identity is fail-closed. Current-conversation navigation URLs are excluded from direct file discovery. Exact HTTPS artifact anchors are handed to the background service worker with the already-armed capture ID, which starts `chrome.downloads.download` without navigating the ChatGPT tab. Button-only and preview actions still execute as scoped DOM actions. Typed artifact selection never falls back to the first unrelated candidate, and ZIP intent may come from filename, MIME, action label, block text, or explicit format metadata. Materialization paths validate bytes before becoming the winning source.

Reasoning retries are isolated observations. Validation selects a complete successful attempt; an earlier partial attempt is retained for diagnostics but cannot invalidate a later complete retry.

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
  public-turn-stream.js
  reasoning-support.js
  multi-bridge-workflow.js
  parser-observation.js
  intelligence-selection.js
  scenarios/
    core.js
    workflows-projects.js
```

`scripts/workflow-worker.js` is the standalone remote workflow-process entry point. It uses `RemoteBrowserBridge` rather than opening another extension connection.

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

E2E writes partial diagnostics before the first real prompt and final JSON, NDJSON, Markdown, and ZIP outputs at completion or interruption. A failed run also prints one final deduplicated summary: `FAILED` entries identify failed scenarios or cleanup, while `ERROR` entries expose the underlying browser/runtime diagnostics that caused or accompanied the failure.

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

At version 6.0.0 all production JavaScript files are below the 1,000-line ceiling. Files close to the ceiling must be split when their next substantial responsibility is added; they must not grow beyond the limit.

## Architectural invariants

The following are release-blocking invariants:

- one extension WebSocket transport and protocol 4;
- one persisted tab lease and serialized background queue per tab;
- critical protocol events replay safely until acknowledged after canonical commit;
- one DOM observation scheduler shared by active and passive consumers;
- command correlation is registered before send and cannot be settled by telemetry;
- startup reload verifies the exact local manifest version after reconnect;
- one canonical request reducer;
- one terminal materialization path;
- one request deadline coordinator;
- no content-owned request completion or missing-response failure;
- the latest meaningful assistant turn after the submitted user turn is authoritative for browser snapshots;
- the response action bar is optional evidence, never a terminal prerequisite;
- no lifecycle inference in E2E or HTTP consumers;
- public reasoning progress is validated through a pre-subscribed turn SSE stream, not inferred only from final DOM history;
- one primary bridge owns each browser tab; remote workflow workers consume sequenced observed turns and never open a competing browser lifecycle;
- watcher and workflow pipeline remain independent;
- all content-runtime cross-module dependencies are explicit;
- manifest-order content bootstrap passes;
- failed E2E runs end with a consolidated `FAILED`/`ERROR` summary;
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
- offline parser and reducer replay tests;
- public live progress SSE validation;
- sequenced remote observed-turn transport and deterministic multi-process workflow integration.

Current archive evidence:

- `npm run check`, `npm run test:e2e:local`, `npm run test:workflow:multi-bridge`, and the deterministic portion of `npm run test:parser-fixture` pass;
- the July 16, 2026 generated corpus contains 59 HTML/fixture pairs for `response-markdown` and `reasoning-lifecycle`;
- separate sanitized fixtures cover a signed ZIP-download anchor, reasoning controls, and transient streaming anchors, while no self-contained `request-trace.json` exists yet;
- `npm test` currently fails two npm-bin contract tests because `chatgpt-bridge` is missing from `package.json.bin`.

Required before declaring a specific release verified against the current ChatGPT deployment:

1. restore or deliberately revise the `chatgpt-bridge` bin compatibility contract and obtain a green `npm test`;
2. reload extension `1.0.15` in the target browser profile;
3. run the full live E2E matrix, including `reasoning-lifecycle` and `workflow-multi-bridge`;
4. inspect `public-progress-events.json` and the remote-worker diagnostics;
5. rerun the DOM-capture scenario set and verify that the ZIP scenario and any available complete traces are represented;
6. review and promote any new sanitized fixtures;
7. rerun `npm run check`, `npm test`, `npm run test:coverage`, and `npm run test:workflow:multi-bridge`.

This is release validation and known test debt, not an unfinished alternative architecture.

## Rollback policy

There is no runtime architecture rollback switch. Emergency rollback means deploying a previous release. Two state machines, two transports, or two terminal paths must never coexist in one process.
