# Project Context

## Current system

This project exposes HTTP, OpenAI-compatible, RPC, workflow, and Terlio.js interfaces that drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension.

Current release contract:

- bridge package: `6.3.0`;
- extension: `2.3.0`;
- content runtime: `4.3.0`;
- extension protocol: `5` only;
- background runtime schema: `6` only;
- WebSocket endpoint: `/extension/ws`.

No polling, page-context WebSocket, userscript transport, protocol downgrade, alternate request lifecycle, job API, or alternate interactive runtime remains.

## Composition

```text
src/index.js
  -> BrowserExtensionHub
       -> authenticated clients / transport-only routing
  -> BrowserBridge facade
       -> BridgeCommandRegistry
       -> RequestSubmissionCoordinator
       -> BrowserClientCoordinator / BrowserTabCoordinator
       -> RequestLifecycleCoordinator
            -> RequestRecoveryCoordinator
            -> RequestResultMaterializer
       -> BridgeOperations
  -> TurnManager
  -> ResultResolver
  -> WorkflowManager facade
       -> RuntimeCoordinator
       -> WorkflowResponseProcessor
       -> AutomationController / AutomationRunExecutor
  -> ProjectService
  -> MetadataStore / FileStore / EventBus
```

`BrowserBridge` is a facade. `RequestLifecycleCoordinator` owns reducer commits and typed effect dispatch; `RequestRecoveryCoordinator` owns read-only reconciliation and deadlines; `RequestResultMaterializer` owns terminal result publication without deciding terminal state. `BridgeCommandRegistry` owns command correlation and waits for the terminal envelope appropriate to the command mode. The extension background owns physical release/quarantine. `BrowserExtensionHub` owns only authenticated connections, compatibility gating, and transport routing. The canonical request machine is a validation facade over separate lifecycle/deadline and effect/reconciliation transition families.

Protocol 5 uses one shared direction-aware manifest and validator for server and extension. The content command router derives its handler surface from one dependency registry and validates exact parity with that manifest during construction. Message meaning is never inferred from payload strings or ID presence. Result commands settle from explicit command terminal envelopes; effect-backed commands settle only from the linked physical BrowserEffect terminal; release settles only from `lease.released` or `lease.quarantined`. Diagnostics, observations, acceptance, progress, and effect-start messages are never terminal. Standalone commands deliberately omit the request envelope; request-scoped effects carry the complete immutable lease identity. Every command also declares an explicit manifest-owned `reloadRecovery` class, so reload handling cannot fall through to an implicit retry default. The exact `extension.reload` startup control is the sole compatibility exception used to reload an outdated unpacked bundle.

## Request lifecycle

The extension background owns localhost transport, persisted tab leases, standalone command records, the critical outbox, browser-effect records, and download-capture state. Content modules consume reducer-backed execution projections, own DOM observation and explicit UI actions, and are disposable across reload. The server owns request meaning.

```text
request.created
  -> source.bound
  -> page/model/files/prompt effects
  -> prompt.delivered / accepted
  -> revisioned tab observations
  -> canonical completion evidence, typed failure, cancellation, or deadline event
  -> canonical terminal revision
  -> public result/error
  -> request.release asks background to begin bounded cleanup
  -> background atomically emits lease.released or lease.quarantined
```

Request completion does not imply that the source tab is immediately reusable. Terminal materialization remains non-blocking. A releasing tab is unschedulable; a quarantined tab is excluded entirely so unrelated work can continue on another safe tab. Extension terminal envelopes preserve the immutable request/lease identity of the dispatched operation.

Required artifacts remain an independent state dimension. Text may be final while the request is still settling a required ZIP.

## Browser runtime

`content.js` is a manifest-loaded composition root. `content/transportRuntime.js` owns transport/reconnect and page-artifact handoff, while `content/featureRuntime.js` assembles parser and executor adapters. The DOM runtime is connection-gated: it starts only after canonical `server.hello` and fully detaches observation, navigation, foreground, polling, and panel hooks when the Bridge disconnects. The main-world artifact shim is dormant unless an exact capture is armed and never overrides `URL.revokeObjectURL`. One revisioned `TabObserver` owns DOM mutation scheduling; active-request monitoring and passive-turn journaling consume the same immutable snapshots, the same shared terminal-evidence classifier, and server-owned completion semantics. The content execution store contains only typed anchors, observation cursors, executor sequencing, and diagnostics. Direct field assignment and persisted output/lifecycle fragments are forbidden. An unexpected exception in an effect-backed content handler is closed at the router boundary by durably settling the exact current BrowserEffect as uncertainty; it cannot become an untracked dispatched write or a second command terminal.

Cross-module dependencies are passed explicitly. `test/extensionContentBootstrap.test.js` executes the complete manifest order and catches TDZ or missing dependency failures that syntax checks cannot detect. Exact HTTPS artifact anchors are started through a persisted background download reducer and bound to the already-armed capture, so materialization cannot navigate the source ChatGPT tab away from its conversation.

## Stateful module layout

The public state roots remain stable facades while implementation families are separated by owner: background schema-6 lease, command, effect, transport/outbox, and download reducers; content prompt/resume/reconciliation command modules; request lifecycle/effect transition modules; workflow model/reducer modules; and a turn queue coordinator separated from its recovery/resume service and shared streamed-item helpers. Source checks enforce a 500-line ceiling across the server and extension composition roots, BrowserExtensionHub, workflow manager, bridge coordinators, and focused background coordinators, plus one-way dependencies, runtime manifest/handler parity, and executor-only browser writes.

## Browser recovery

Background state schema 6 is persisted under its own `chrome.storage.session` namespace. Correctness-critical transitions atomically persist the next reducer state and exact immutable outbox envelope before becoming authoritative. Legacy v1-v5 namespaces are never adopted and are removed only after their records are proven idle. A dedicated fault-injection gate verifies every persisted background transition, effect-result commit boundaries, terminal absorption, pause/stop barriers, kind-specific browser reconciliation, local-effect recovery, remote cursor redelivery, and strict download identity. A new content epoch restores an existing lease as `reconciling`, recreates read-only observers, and reports every dispatched-but-unconfirmed write effect as uncertain. Persisted recovery is a lease/effect journal rather than a serialized content object, so `content/requestState.js` hydrates the same complete projection used for fresh requests before the replacement epoch builds its protocol hello. Recovery failure is included in a degraded hello and cannot make a connected WebSocket disappear before registration. The canonical server requests a reconciliation snapshot and either continues from evidence or finishes with a typed recoverable failure; it never blindly repeats browser writes.

## Standalone command recovery

Standalone browser writes are persisted as command records and reconciled by their physical evidence. A record saved before dispatch is recovered as `proved_not_started`. Passive prompt submit uses the exact observed prompt/user turn; session select uses conversation identity; session delete requires explicit target absence and never infers success from navigation; tab reload uses a changed persisted content epoch; intelligence apply and attachment clear use read probes; artifact fetch uses `DownloadCapture`; extension reload uses its maintenance epoch and acknowledgement barrier. Session creation and tab open/close remain non-reconcilable after ambiguous dispatch and become typed uncertainty without replay. Read-only commands may repeat while their source and preconditions match, but an unsafe write may repeat only after a kind-specific `proved_not_started` result.

## Request snapshot recovery

A submitted user turn may produce separate reasoning, final-text, and artifact-bearing assistant turn containers. The browser request monitor selects the latest meaningful assistant turn after the submitted user turn and can recover from recent visible request-owned turns or the last committed request output after React virtualization. The response action bar is optional high-confidence evidence; stable stopped output or a ready artifact may terminate with medium confidence. Missing assistant DOM is not a content-owned terminal error.

## Canonical state and diagnostics

Canonical state under `src/bridge/state/` and `src/bridge/store/` has orthogonal lifecycle, submission, generation, blocker, output, artifact, connection, effect, and terminal fields.

Diagnostics expose committed snapshots, transition history, deadlines, effects, source identity, and sanitized replay data through the diagnostics page, debug bundles, and `/diagnostics/request-state`. Real E2E always archives the complete parsed browser stream as `browser-debug.ndjson`; its terminal view is compact unless `--verbose` is requested, and the final ZIP is losslessly DEFLATE-compressed.


## Public progress and remote workflow integration

The turn SSE supports pre-subscription with `recent=0&wait=1`. Reasoning E2E validates real-time public `0%` through `100%` delivery, ordering before final/terminal events, and completion wrappers; `public-progress-events.json` stores the raw contract evidence. Rapid answer snapshots are serialized through one durable `agent_message`, so partial stream prefixes cannot survive as competing final-message records.

A browser tab has one primary bridge owner. Independent workflow workers use `RemoteBrowserBridge` over authenticated sequenced observed-turn SSE, fetch artifacts from the primary API into their own `FileStore`, and keep their own workflow persistence. Deterministic two-process integration and a live `workflow-multi-bridge` scenario cover this topology.

## Workflows

`/workflow` is the single interactive entry point. It exposes three presets over one shared runner: Apply changes from ChatGPT, Fix the project until checks pass, and Work through a task. No background behavior starts from ordinary interactive mode. Wizard multi-selects accept the terminal's printable Space event, Esc or Alt+Left returns to the previous step without resetting the draft, and setup failures remain open with retry/edit actions. The bare command is the only initial `/workflow` completion and opens the wizard; `/workflow wizard` is an alias, while `/workflow ` exposes optional targeted views.

Internally, one workflow v3 reducer owns lifecycle, active-run phase, the sole `nextAction` decision contract, effect references, retries, outcomes, canonical session/source binding, and workflow-owned Git aggregation required to resume checkpoint/squash policy after restart. Passive observation is a persisted subscription plus binding epoch, not an independent watcher state. Inputs arriving during hydration are durably staged in the workflow store and are removed only after canonical enqueue/processing succeeds; stale configured or runtime binding mirrors cannot override restored `workflowState.binding`. `RuntimeCoordinator` serializes reducer/effect commits, `WorkflowResponseProcessor` owns response/package/verification/application flow, and `AutomationRunExecutor` performs advanced preset check/repair cycles without owning start, pause, resume, stop, recovery, or terminal state. Shared services own configuration, attention notifications, chat bootstrap and recovery, effective-project fingerprints, result validation and repair, safe application, checks, and workflow-owned Git commits. Interactive startup prefers an explicit project, then the selected persisted workflow root, then the launch directory; it immediately offers the persisted workflow for continuation instead of reopening a stale temporary directory. Retryable artifact-materialization failures remain typed effects and return the canonical workflow to `ready` or `waiting_action` according to reducer policy.

## Interactive runtime

There is one interactive runtime: exact `terlio.js@1.1.0`. Terminal lifecycle, fixed-frame rendering, normalized keyboard/pointer input, resize handling, state, command routing, progress, apply, presentation, and orchestration are split under `src/interactive/`. Active workflow intelligence discovery retries while the bound browser client remains connected instead of converting a model/effort command timeout into a workflow failure. Interactive shutdown restores the terminal first, then logs bounded workflow, bridge, and HTTP-server cleanup so a lingering resource is visible and cannot require an unexplained second Ctrl+C. An Apply Changes live monitor consumes transient passive snapshots and updates stable transcript entries for direct-tab user prompts, complete reasoning, and full answers without retaining every streaming payload in the global event journal. The transcript and full-details pane use explicit sticky-tail scroll state with page, one-line, top/bottom, wheel/trackpad, and scrollbar click/drag navigation. Layout breakpoints are chat-only below 115 columns, left panel plus expanding chat from 115 through 169, and two panels with an expanding center chat from 170. The full-width header/editor/footer never follows the main-column breakpoints. Completion appears from the first `/`, provides contextual parameter/ID help, and temporarily reduces the transcript only while suggestion rows are visible. Ctrl+B uses one scrollable help column below 120 columns and two from 120. Assistant answer chunks update one stable streaming transcript entry in place. Transcript text supports multiline drag selection and short-click copy. The prompt editor expands to five rows, prioritizes multiline vertical movement over completion/history, persists history per project or directory, retains Esc-cancelled drafts, and compacts pasted blocks above 250 symbols without changing the submitted text. Terlio themes are persisted per interactive state. Ink and React are not dependencies and no compatibility runtime remains.

## E2E and captured DOM evidence

`scripts/e2e-real.js` is below 1,000 lines. Scenario groups and focused support code live under `scripts/e2e/`. Core scenario dependencies are assembled by a validated context factory before the bridge or browser is started, preventing late missing-binding failures after bootstrap.

Live E2E supports `--capture-dom-fixtures` and `--fixture-output-dir`. Capture mode writes sanitized assistant-turn HTML and semantic parser expectations. It writes `request-trace.json` only when canonical diagnostics contain a self-contained trace beginning with `request.created`; incomplete traces are skipped. `test/capturedDomFixtures.test.js` runs available HTML fixtures and traces through the real parser and reducer without Chrome. The separate opt-in `--capture-page-layout` flag records deduplicated sanitized structural snapshots at startup and scenario boundaries, preserving selector/geometry evidence while redacting messages, conversations, account data, inputs, media URLs, and unstable identifiers. Layout capture is diagnostic only and reuses an active request lease rather than competing with it.
Failed live E2E runs print a final deduplicated summary. Scenario and cleanup failures use `FAILED`; browser and canonical runtime diagnostics use `ERROR`, preserving the actual root cause separately from the HTTP or scenario wrapper error.
Failed scenarios are isolated through stable owned-tab identity (`browserTabId` plus launch token), not the ephemeral content client ID. A reload requested during an active turn carries that turn's request identity and reuses its durable tab lease. After reload the runner waits for a replacement protocol hello and adopts that content epoch. If the owned tab cannot recover, one browser-infrastructure root failure is recorded and later dependent scenarios are marked `blocked` without running. If the tab remains connected but busy, the runner reloads it and waits for an idle composer before continuing. Artifact assertions parse JSON and normalize line endings/trailing newlines for textual formats while retaining binary validation.

The fixture system is implemented, and the generated corpus includes `response-markdown`, `reasoning-lifecycle`, focused parser variants, and a required-ZIP scenario paired with a self-contained canonical request trace. `test/capturedDomFixtures.test.js` requires both the ZIP parser fixture and sibling reducer trace. A complete live release-validation run is still required against the current deployed UI.

## Structural status

All production JavaScript files are at or below the 1,000-line ceiling. Core composition roots and stateful coordinators are source-tested at 500 lines or fewer. Reviewed parser, UI, route, fixture, and script modules may remain above 500 lines, but they cannot acquire another unrelated responsibility.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, nested archives, caches, build output, or generated E2E reports.
- Do not include `CHANGELOG.md`.
- Sanitize or omit `package-lock.json` if it contains non-public registry URLs.
- Keep all project Markdown in English.

## Current verification gaps

- The generated DOM corpus contains no `request-trace.json`; a separate sanitized direct-download fixture covers a signed ZIP artifact anchor.
- The Chromium parser fixture now auto-detects common browser binaries and first performs a headless capability probe. A present but sandbox-blocked browser is reported as an explicit skip; a fixture timeout after a successful probe remains a failure.
- Browser-fixture results are exported as base64 UTF-8 payloads instead of raw JSON text nodes, avoiding truncated or entity-corrupted `--dump-dom` output on desktop Chrome.
- Sanitized layout captures use non-terminal progress chunks and a compact durable terminal record; incomplete chunk sets fail with `BROWSER_LAYOUT_CAPTURE_INCOMPLETE` instead of poisoning later tab operations.
- Extension maintenance waits for the exact terminal `command.result` ACK before restarting the background runtime. `--reload-extension` is conditional; only `--force-reload-extension` restarts an already-current bundle.
- `npm run verify:release:local` produces JSON and Markdown release reports and includes atomic extension deployment plus a production dependency audit. The evidence directory contains each gate log and can be packaged separately from the source archive.
- The complete authenticated live-browser matrix and live public-progress evidence still require a logged-in desktop browser profile; run them with `npm run verify:release:live -- --reload-extension`; use `--force-reload-extension` only for deliberate restart testing.

## Known compatibility limits

- The OpenAI-compatible endpoint does not implement system-message semantics, tool calls, or structured-output schemas.
- The Codex-like app-server is an MVP and explicitly reports shell commands, approvals, worktrees, and sandbox capabilities as unsupported.

## Current reliability changes

- Hub lease ownership has been removed completely. Canonical request commands alone carry immutable request identity; standalone diagnostics, artifact materialization, session administration, and maintenance are persisted background commands with no request envelope and cannot become `activeRequest` accidentally.
- Canonical coordinator effects and physical browser effects use independent reducer domains. Steering readiness is proved from canonical submission and generation state, so an in-flight steer cannot collide with its own browser effect or wait on disposable content state.
- Standalone command timeout/abort sends a correlated `command.cancel` and waits for physical cancellation settlement before releasing the caller. Transport delivery rejection also settles correlation immediately instead of leaving a command pending forever.
- Reasoning arithmetic assertions normalize locale grouping separators before exact numeric validation; formatting such as `25,502,500` or `25 502 500` is equivalent to `25502500` without weakening the expected result.
- Artifact discovery excludes unrelated controls inside `cot-v5` reasoning rows unless the control itself or a stable file/artifact container provides intrinsic materialization evidence. ZIP selection no longer treats ambient reasoning `blockText` as artifact identity. A sanitized regression fixture reproduces the localized `Ответить сейчас` false positive from the July 17 project-context E2E run.
- Streaming Markdown anchors with an empty/current-page `href` are not artifacts. ChatGPT may grow the download label token-by-token and later replace the anchor with the real file button; publishing the transient anchor creates stale artifact IDs. Turn-level E2E selection prefers the artifact already validated into `turn.output`.
- Startup update atomically deploys the bundled extension into one stable install directory before comparing extension and content-runtime versions. Matching bundles do not prompt in `ask` mode. Reload must reconnect with both deployed versions; a browser profile registered to another unpacked directory produces `EXTENSION_LOADED_PATH_MISMATCH` with the exact one-time Load unpacked path. Updated content arms a MAIN-world page reload before extension teardown; owned E2E tabs fall back to a safely token-validated replacement tab using a stable `bridge-recovery-*` ownership token.
- Request output is ignored until the submitted user-turn boundary matches the observed assistant turn. Parser timestamps and performance timings are excluded from the semantic observation signature, preventing poll-only revisions from renewing canonical deadlines. A reload during a proved pre-submit preparation effect resumes the remaining pipeline from persisted prompt intent without repeating the proved stage or resubmitting an already committed prompt.
- Real E2E treats the first SIGINT/SIGTERM as a cooperative cancellation barrier: active waits abort, browser requests and running turns are cancelled, normal session/tab cleanup and final diagnostic bundling run, and `RUNNING.json` is removed. A second signal is the explicit forced-exit path.
- Real E2E defers child/live diagnostic output until startup confirmation completes.
- Reasoning retry validation selects a later complete attempt instead of failing because an earlier attempt was partial.
- Artifact discovery rejects current-conversation URLs, ZIP selection is metadata-aware and fail-closed, and direct bytes remain signature-validated. Exact HTTPS download anchors are delegated to the background download API instead of being clicked in the ChatGPT tab; non-URL buttons and preview controls remain scoped DOM actions.

## Latest workflow reliability changes

- Thinking/progress logical IDs keep an immutable kind even when React reuses one DOM node for a different visible phase.
- Passive workflow prompt boundaries continue scanning post-submit observations until the server publishes one stable canonical turn, rather than relying on a final DOM mutation.
- Passive workflow observation now shares terminal completion policy with active requests; ready ZIP output does not require a response action bar.
- Explicit passive prompts hard-baseline every pre-existing assistant turn before submission.
- Real workflow E2E uses a 120-second absolute wait-stage deadline and a 60-second started-pipeline idle deadline by default.
- SIGINT/SIGTERM marks the active E2E scenario interrupted and writes the normal final failure summary plus diagnostics.

## Workflow operator model

Ordinary users work through `/workflow` and choose a goal rather than an internal definition. Setup selects the current tab, a new chat, or another open tab; confirms the project and checks; then starts one shared runner. Pending decisions reopen directly, and pause, resume, stop, settings, and completion actions stay inside the same wizard.

New and recovered chats receive a fresh effective-project archive plus a separate instruction file. Existing chats default to using their current context. The runner stores a per-chat project fingerprint, refreshes only when included local content changed, requires `bridge-result.json` for automatic application while treating its optional `files` list as advisory and deriving effective changes from the transactional diff, and tracks exact workflow-owned file states before any commit. Advanced one-shot and long-lived headless modes share the persisted manager but do not define the normal interactive UX.
