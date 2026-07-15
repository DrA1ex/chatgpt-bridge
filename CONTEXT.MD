# Project Context

## Current system

This project exposes HTTP, OpenAI-compatible, RPC, workflow, and Ink interfaces that drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension.

Current release contract:

- bridge package: `5.1.2`;
- extension: `1.0.2`;
- content runtime: `3.0.2`;
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

## Canonical state and diagnostics

Canonical state under `src/bridge/state/` and `src/bridge/store/` has orthogonal lifecycle, submission, generation, blocker, output, artifact, connection, effect, and terminal fields.

Diagnostics expose committed snapshots, transition history, deadlines, effects, source identity, and sanitized replay data through the diagnostics page, debug bundles, and `/diagnostics/request-state`.

## Workflows

Passive workflows persist independent watcher and pipeline state. Terminal pipeline outcomes do not stop the watcher. Approval, remediation, recovery, apply, and rollback remain within one pipeline ID. Status-only snapshots are incompatible.

## Interactive runtime

There is one interactive runtime: Ink/React. State, command routing, progress, apply, presentation, and orchestration are split under `src/interactive/`.

## E2E and captured DOM evidence

`scripts/e2e-real.js` is below 1,000 lines. Scenario groups and focused support code live under `scripts/e2e/`. Core scenario dependencies are assembled by a validated context factory before the bridge or browser is started, preventing late missing-binding failures after bootstrap.

Live E2E supports `--capture-dom-fixtures` and `--fixture-output-dir`. Capture mode writes only sanitized assistant-turn HTML, semantic parser expectations, and canonical request traces. `test/capturedDomFixtures.test.js` runs those fixtures through the real parser and reducer without Chrome.
Failed live E2E runs print a final deduplicated summary. Scenario and cleanup failures use `FAILED`; browser and canonical runtime diagnostics use `ERROR`, preserving the actual root cause separately from the HTTP or scenario wrapper error.

The fixture system is implemented, but a live ChatGPT run is still required to collect evidence from the current deployed UI.

## Structural status

All production JavaScript files are below the 1,000-line ceiling. Files close to the ceiling must be split before adding another substantial responsibility.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, nested archives, caches, build output, or generated E2E reports.
- Do not include `CHANGELOG.md`.
- Sanitize or omit `package-lock.json` if it contains non-public registry URLs.
- Keep all project Markdown in English.
