# Project Context

## Current system

This project exposes HTTP, OpenAI-compatible, RPC, workflow, and Terlio.js interfaces that drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension.

Current release contract:

- bridge package: `5.10.4`;
- extension: `1.0.19`;
- content runtime: `3.0.19`;
- extension protocol: `3` only;
- WebSocket endpoint: `/extension/ws`.

No polling, page-context WebSocket, userscript transport, protocol downgrade, alternate request lifecycle, job API, or alternate interactive runtime remains.

## Composition

```text
src/index.js
  -> BrowserExtensionHub
  -> BrowserBridge
       -> BrowserClientCoordinator
       -> BridgeClientEventRouter
       -> RequestLifecycleCoordinator
       -> BridgeOperations
  -> TurnManager
  -> ResultResolver
  -> WorkflowManager
  -> ProjectService
  -> MetadataStore / FileStore / EventBus
```

`BrowserBridge` is a facade. `RequestLifecycleCoordinator` owns reducer commits, typed effects, deadlines, terminal materialization, cancellation, and source release.

Command correlation is registered before transport delivery. Diagnostics and lifecycle telemetry may carry a command ID for tracing but cannot resolve the pending command. Startup extension reload is shared by interactive and real E2E, permits only the `extension.reload` compatibility bypass, and verifies the local manifest version after reconnect. Real E2E performs this against its token-bound isolated bootstrap tab before selecting the client or submitting a prompt.

## Request lifecycle

The extension background owns localhost transport. Content modules own DOM observation and explicit UI actions. The server owns request meaning.

```text
request.created
  -> source.bound
  -> page/model/files/prompt effects
  -> prompt.delivered / accepted
  -> revisioned tab observations
  -> terminal snapshot, failure, cancellation, or deadline event
  -> canonical terminal revision
  -> public result/error
  -> request.release
```

Required artifacts remain an independent state dimension. Text may be final while the request is still settling a required ZIP.

## Browser runtime

`content.js` is a manifest-loaded assembly and transport facade. Session, intelligence, composer, attachment, parser DOM, artifact transfer, turn snapshots, monitoring, telemetry, page status, setup UI, and command routing live in focused modules under `tools/chrome-bridge-extension/content/`.

Cross-module dependencies are passed explicitly. `test/extensionContentBootstrap.test.js` executes the complete manifest order and catches TDZ or missing dependency failures that syntax checks cannot detect.

## Request snapshot recovery

A submitted user turn may produce separate reasoning, final-text, and artifact-bearing assistant turn containers. The browser request monitor selects the latest meaningful assistant turn after the submitted user turn and can recover from recent visible request-owned turns or the last committed request output after React virtualization. The response action bar is optional high-confidence evidence; stable stopped output or a ready artifact may terminate with medium confidence. Missing assistant DOM is not a content-owned terminal error.

## Canonical state and diagnostics

Canonical state under `src/bridge/state/` and `src/bridge/store/` has orthogonal lifecycle, submission, generation, blocker, output, artifact, connection, effect, and terminal fields.

Diagnostics expose committed snapshots, transition history, deadlines, effects, source identity, and sanitized replay data through the diagnostics page, debug bundles, and `/diagnostics/request-state`. Real E2E always archives the complete parsed browser stream as `browser-debug.ndjson`; its terminal view is compact unless `--verbose` is requested, and the final ZIP is losslessly DEFLATE-compressed.


## Public progress and remote workflow integration

The turn SSE supports pre-subscription with `recent=0&wait=1`. Reasoning E2E validates real-time public `0%` through `100%` delivery, ordering before final/terminal events, and completion wrappers; `public-progress-events.json` stores the raw contract evidence.

A browser tab has one primary bridge owner. Independent workflow workers use `RemoteBrowserBridge` over authenticated sequenced observed-turn SSE, fetch artifacts from the primary API into their own `FileStore`, and keep their own workflow persistence. Deterministic two-process integration and a live `workflow-multi-bridge` scenario cover this topology.

## Workflows

`/workflow` is the single interactive entry point. It exposes three presets over one shared runner: Apply changes from ChatGPT, Fix the project until checks pass, and Work through a task. No background behavior starts from ordinary interactive mode. Wizard multi-selects accept the terminal's printable Space event, Esc or Alt+Left returns to the previous step without resetting the draft, and setup failures remain open with retry/edit actions. The bare command is the only initial `/workflow` completion and opens the wizard; `/workflow wizard` is an alias, while `/workflow ` exposes optional targeted views.

Internally, watcher and pipeline state remain independent and atomically persisted. Shared services own configuration, attention notifications, chat bootstrap and recovery, effective-project fingerprints, result validation and repair, safe application, checks, and workflow-owned Git commits. Terminal pipeline outcomes do not implicitly destroy a long-lived watcher, and status-only snapshots remain incompatible.

## Interactive runtime

There is one interactive runtime: exact `terlio.js@1.1.0`. Terminal lifecycle, fixed-frame rendering, normalized keyboard/pointer input, resize handling, state, command routing, progress, apply, presentation, and orchestration are split under `src/interactive/`. An Apply Changes live monitor consumes transient passive snapshots and updates stable transcript entries for direct-tab user prompts, complete reasoning, and full answers without retaining every streaming payload in the global event journal. The transcript and full-details pane use explicit sticky-tail scroll state with page, one-line, top/bottom, wheel/trackpad, and scrollbar click/drag navigation. Layout breakpoints are chat-only below 115 columns, left panel plus expanding chat from 115 through 169, and two panels with an expanding center chat from 170. The full-width header/editor/footer never follows the main-column breakpoints. Completion appears from the first `/`, provides contextual parameter/ID help, and temporarily reduces the transcript only while suggestion rows are visible. Ctrl+B uses one scrollable help column below 120 columns and two from 120. Assistant answer chunks update one stable streaming transcript entry in place. Transcript text supports multiline drag selection and short-click copy. The prompt editor expands to five rows, prioritizes multiline vertical movement over completion/history, persists history per project or directory, retains Esc-cancelled drafts, and compacts pasted blocks above 250 symbols without changing the submitted text. Terlio themes are persisted per interactive state. Ink and React are not dependencies and no compatibility runtime remains.

## E2E and captured DOM evidence

`scripts/e2e-real.js` is below 1,000 lines. Scenario groups and focused support code live under `scripts/e2e/`. Core scenario dependencies are assembled by a validated context factory before the bridge or browser is started, preventing late missing-binding failures after bootstrap.

Live E2E supports `--capture-dom-fixtures` and `--fixture-output-dir`. Capture mode writes sanitized assistant-turn HTML and semantic parser expectations. It writes `request-trace.json` only when canonical diagnostics contain a self-contained trace beginning with `request.created`; incomplete traces are skipped. `test/capturedDomFixtures.test.js` runs available HTML fixtures and traces through the real parser and reducer without Chrome.
Failed live E2E runs print a final deduplicated summary. Scenario and cleanup failures use `FAILED`; browser and canonical runtime diagnostics use `ERROR`, preserving the actual root cause separately from the HTTP or scenario wrapper error.
Failed scenarios are isolated: if the owned test tab remains busy, the runner reloads that tab and waits for an idle composer before continuing. Artifact assertions parse JSON and normalize line endings/trailing newlines for textual formats while retaining binary validation.

The fixture system is implemented, and the generated corpus was rebuilt on July 16, 2026 for `response-markdown` and `reasoning-lifecycle`. That corpus has 59 HTML/fixture pairs, but it still has no ZIP-artifact fixture and no self-contained canonical request trace. A complete live release-validation run is still required against the current deployed UI.

## Structural status

All production JavaScript files are at or below the 1,000-line ceiling. Twenty-six files remain above the 500-line target, including two files exactly at 1,000 lines; those files must be split before adding another substantial responsibility.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, nested archives, caches, build output, or generated E2E reports.
- Do not include `CHANGELOG.md`.
- Sanitize or omit `package-lock.json` if it contains non-public registry URLs.
- Keep all project Markdown in English.

## Current verification gaps

- The current generated DOM corpus contains no `zip-artifact` fixture and no `request-trace.json`.
- The optional Chromium parser fixture remains unexecuted unless `CHROMIUM_BIN` is provided.
- The complete live browser matrix, live public-progress evidence, and live multi-bridge workflow scenario were not rerun as part of this archive audit.

## Known compatibility limits

- The OpenAI-compatible endpoint does not implement system-message semantics, tool calls, or structured-output schemas.
- The Codex-like app-server is an MVP and explicitly reports shell commands, approvals, worktrees, and sandbox capabilities as unsupported.

## Current reliability changes

- Artifact discovery excludes unrelated controls inside `cot-v5` reasoning rows unless the control itself or a stable file/artifact container provides intrinsic materialization evidence. ZIP selection no longer treats ambient reasoning `blockText` as artifact identity. A sanitized regression fixture reproduces the localized `Ответить сейчас` false positive from the July 17 project-context E2E run.
- Streaming Markdown anchors with an empty/current-page `href` are not artifacts. ChatGPT may grow the download label token-by-token and later replace the anchor with the real file button; publishing the transient anchor creates stale artifact IDs. Turn-level E2E selection prefers the artifact already validated into `turn.output`.
- Startup reload compares extension and content-runtime versions; matching bundles do not prompt in `ask` mode. Updated content arms a MAIN-world page reload before extension teardown; legacy owned E2E tabs fall back to a safely token-validated replacement tab using a stable `bridge-recovery-*` ownership token.
- Real E2E defers child/live diagnostic output until startup confirmation completes.
- Reasoning retry validation selects a later complete attempt instead of failing because an earlier attempt was partial.
- Artifact discovery rejects current-conversation URLs, action artifacts are clicked, ZIP selection is metadata-aware and fail-closed, and direct bytes remain signature-validated.

## Latest workflow reliability changes

- Thinking/progress logical IDs keep an immutable kind even when React reuses one DOM node for a different visible phase.
- Passive workflow prompt boundaries actively rescan their post-submit assistant turn until a stable terminal snapshot is published, rather than relying on a final DOM mutation.
- Passive workflow observation now shares terminal completion policy with active requests; ready ZIP output does not require a response action bar.
- Explicit passive prompts hard-baseline every pre-existing assistant turn before submission.
- Real workflow E2E uses a 120-second absolute wait-stage deadline and a 60-second started-pipeline idle deadline by default.
- SIGINT/SIGTERM marks the active E2E scenario interrupted and writes the normal final failure summary plus diagnostics.

## Workflow operator model

Ordinary users work through `/workflow` and choose a goal rather than an internal definition. Setup selects the current tab, a new chat, or another open tab; confirms the project and checks; then starts one shared runner. Pending decisions reopen directly, and pause, resume, stop, settings, and completion actions stay inside the same wizard.

New and recovered chats receive a fresh effective-project archive plus a separate instruction file. Existing chats default to using their current context. The runner stores a per-chat project fingerprint, refreshes only when included local content changed, requires an exact `bridge-result.json` allow-list for automatic application, and tracks exact workflow-owned file states before any commit. Advanced one-shot and long-lived headless modes share the persisted manager but do not define the normal interactive UX.
