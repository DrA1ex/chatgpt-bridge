# Project Context

## Current system

This project exposes HTTP, OpenAI-compatible, RPC, workflow, and Ink interfaces that drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension.

Current release contract:

- bridge package: `5.4.3`;
- extension: `1.0.15`;
- content runtime: `3.0.15`;
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

Passive workflows persist independent watcher and pipeline state. Terminal pipeline outcomes do not stop the watcher. Approval, remediation, recovery, apply, and rollback remain within one pipeline ID. Status-only snapshots are incompatible.

## Interactive runtime

There is one interactive runtime: Ink/React. State, command routing, progress, apply, presentation, and orchestration are split under `src/interactive/`.

## E2E and captured DOM evidence

`scripts/e2e-real.js` is below 1,000 lines. Scenario groups and focused support code live under `scripts/e2e/`. Core scenario dependencies are assembled by a validated context factory before the bridge or browser is started, preventing late missing-binding failures after bootstrap.

Live E2E supports `--capture-dom-fixtures` and `--fixture-output-dir`. Capture mode writes sanitized assistant-turn HTML and semantic parser expectations. It writes `request-trace.json` only when canonical diagnostics contain a self-contained trace beginning with `request.created`; incomplete traces are skipped. `test/capturedDomFixtures.test.js` runs available HTML fixtures and traces through the real parser and reducer without Chrome.
Failed live E2E runs print a final deduplicated summary. Scenario and cleanup failures use `FAILED`; browser and canonical runtime diagnostics use `ERROR`, preserving the actual root cause separately from the HTTP or scenario wrapper error.
Failed scenarios are isolated: if the owned test tab remains busy, the runner reloads that tab and waits for an idle composer before continuing. Artifact assertions parse JSON and normalize line endings/trailing newlines for textual formats while retaining binary validation.

The fixture system is implemented, and the generated corpus was rebuilt on July 16, 2026 for `response-markdown` and `reasoning-lifecycle`. That corpus has 55 HTML/fixture pairs, but it still has no ZIP-artifact fixture and no self-contained canonical request trace. A complete live release-validation run is still required against the current deployed UI.

## Structural status

All production JavaScript files are at or below the 1,000-line ceiling. Twenty-five files remain above the 500-line target, including two files exactly at 1,000 lines; those files must be split before adding another substantial responsibility.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, nested archives, caches, build output, or generated E2E reports.
- Do not include `CHANGELOG.md`.
- Sanitize or omit `package-lock.json` if it contains non-public registry URLs.
- Keep all project Markdown in English.

## Current verification gaps

- `npm test` is not green: two tests fail because `package.json` exposes `bridge` but not the expected `chatgpt-bridge` bin alias.
- The current generated DOM corpus contains no `zip-artifact` fixture and no `request-trace.json`.
- The optional Chromium parser fixture remains unexecuted unless `CHROMIUM_BIN` is provided.
- The complete live browser matrix, live public-progress evidence, and live multi-bridge workflow scenario were not rerun as part of this archive audit.

## Known compatibility limits

- The OpenAI-compatible endpoint does not implement system-message semantics, tool calls, or structured-output schemas.
- The Codex-like app-server is an MVP and explicitly reports shell commands, approvals, worktrees, and sandbox capabilities as unsupported.

## Current reliability changes

- Startup reload compares extension and content-runtime versions; matching bundles do not prompt in `ask` mode. Updated content arms a MAIN-world page reload before extension teardown; legacy owned E2E tabs fall back to a safely token-validated replacement tab.
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

Workflow observer state is internal. Operators work with definitions and concrete runs, not watcher toggles. A fresh run binds the current/new/pinned ChatGPT session once and never inherits the previous run thread. `/session new` changes the next run only. Restored runs default to `Interrupted` and require explicit resume or discard. Interactive, one-shot, and long-lived headless modes share the same persisted manager state.
