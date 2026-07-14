# Project Context

## Current system

This project exposes HTTP, OpenAI-compatible, RPC, workflow, and interactive interfaces that drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension.

The current release line is intentionally breaking:

- bridge package: `5.0.0`;
- extension: `1.0.0`;
- content runtime: `3.0.0`;
- extension protocol: `3` only;
- WebSocket endpoint: `/extension/ws`.

No polling, page-context WebSocket, userscript transport, protocol downgrade, or alternate interactive runtime remains.

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

`BrowserBridge` is a public facade, not a state machine. `RequestLifecycleCoordinator` owns canonical reducer commits, effects, deadlines, terminal materialization, and request release.

## Request lifecycle

The extension background owns localhost transport. The content script owns DOM observation and UI actions. The server owns request meaning.

A typical request is:

```text
request.created
  -> source.bound
  -> page/model/files/prompt typed effects
  -> prompt.delivered
  -> prompt.accepted
  -> tab observations and progress
  -> terminal snapshot or failure observation
  -> reducer terminal revision
  -> public result/error materialized
  -> request.release sent to source tab
```

Required artifacts remain a separate state dimension. A final answer may exist while the request remains in artifact settling.

## Canonical state and diagnostics

Canonical state lives under `src/bridge/state/` and `src/bridge/store/`. It includes orthogonal lifecycle, submission, generation, blocker, output, artifact, connection, effect, and terminal fields.

Diagnostics expose the committed snapshot and bounded transition history through the diagnostics page, debug bundles, and `/diagnostics/request-state`.

## Browser ownership

`BrowserExtensionHub`:

- accepts authenticated protocol-3 extension clients;
- records extension/content versions and compatibility;
- keeps incompatible clients visible but unselectable;
- owns latest revisioned tab observation per client;
- rejects stale observation revisions;
- tracks the active request reported by each tab.

`BrowserClientCoordinator`:

- resolves an explicit source client strictly;
- prefers an idle client already showing the requested session;
- requires confirmation before using a different idle tab interactively;
- optionally opens a new tab with an exact one-time launch token;
- keeps follow-ups bound to their source tab.

## Workflows

Passive workflows persist independent watcher and pipeline state. Terminal pipeline outcomes do not stop the watcher. Approval, remediation, recovery, apply, and rollback remain within one pipeline ID.

Workflow state is committed before correlated events are published. Old status-only snapshots are not inferred.

## Interactive runtime

There is one interactive UI: Ink/React.

The domain is split into:

- `src/interactive/state.js` — persisted scope and selected-result identity;
- `src/interactive/progress.js` — event rendering and progress reconciliation;
- `src/interactive/apply.js` — ZIP planning and application;
- `src/interactive/commandHandler.js` — slash-command routing;
- `src/interactive/controller.js` — task, request, resume, recovery, and artifact operations;
- `src/interactive/inkView.js` — pure presentation helpers;
- `src/interactiveInk.js` — UI runtime coordinator.

## Current structural status

Files now below the 1,000-line ceiling include the bridge facade, workflow manager, routes, interactive controller, Ink coordinator, extension `content.js`, and `domParserCore.js`.

`content.js` is a 987-line assembly/transport facade backed by focused modules under `tools/chrome-bridge-extension/content/`. Artifact parsing is isolated in `artifactParserCore.js`, leaving `domParserCore.js` at 922 lines.

The only remaining oversized production file is `scripts/e2e-real.js` at 2,353 lines. Reasoning validation, parser observation, and intelligence-selection helpers are already extracted under `scripts/e2e/`. Its target decomposition is documented in `ARCHITECTURE.md`.

## Testing status

The local unit/integration suite covers canonical transitions, deadlines, effect failures, client ownership, workflow state, HTTP surfaces, interactive behavior, artifact validation, and replay fixtures.

A live ChatGPT E2E run cannot be assumed from local tests. Before declaring selector/lifecycle work complete, run the real E2E scenarios with the unpacked extension reloaded.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, nested archives, or generated test output.
- Do not include `CHANGELOG.md`.
- Sanitize or omit `package-lock.json` if it contains non-public registry URLs.
- Keep project Markdown in English.
