# Current Session Handoff

## Completed

- Cumulative reasoning blocks remain visible when ChatGPT nests a transient shimmer label inside the same DOM wrapper.
- Persisted reasoning items retain their exact visible DOM logical IDs, while the public SSE may keep a stable fallback alias such as `snapshot-thinking` until the matching completion wrapper is published.
- Passive workflow observation records the submitted user-turn boundary together with the exact pre-submit assistant-turn baseline, so a temporarily reordered old React turn cannot be emitted as a new workflow result.
- A workflow pipeline awaiting approval cannot be replaced by another observed turn. Later turns are deduplicated, bounded, and processed only after the active pipeline reaches a terminal decision.
- Passive observer terminal detection now delegates to the shared DOM completed-snapshot policy and no longer requires the response action bar for a ready ZIP or stable final answer.
- Explicit passive prompts hard-baseline all pre-existing assistant turns before submission.
- Workflow E2E waits now default to a 120-second absolute stage timeout and a 60-second started-pipeline idle timeout, with typed failures and recent-event diagnostics.
- Interrupted E2E runs print a deduplicated failure summary before writing terminal diagnostics.
- Bridge package moved to `5.2.2`; extension moved to `1.0.9`, content runtime moved to `3.0.9`, and protocol remains `3`.
- Public turn SSE can be opened before a turn exists with `?stream=1&recent=0&wait=1`; it emits `ready` and then committed live item/turn events.
- Public progress snapshots now expose stable logical IDs, text, revision, state, activity, and visibility fields. Matching completion events preserve the same identity.
- The real `reasoning-lifecycle` scenario opens the public SSE before creating the turn and requires ordered live `0%` through `100%`, meaningful receive-time separation, `100%` before final/terminal events, and completion wrappers.
- Reasoning diagnostics now write `public-progress-events.json` with raw SSE records and validation results. DOM history alone cannot satisfy the scenario.
- `BrowserBridge` now publishes terminal observed turns through a bounded monotonic sequence journal.
- Added authenticated `GET /browser/observed-turns` and `GET /browser/observed-turns/stream`, with replay through `Last-Event-ID` or `after`.
- Added `RemoteBrowserBridge` and `scripts/workflow-worker.js`. A worker has its own `FileStore` and `WorkflowManager`, consumes the primary bridge's observed turns, and imports artifacts through the primary HTTP API.
- Added deterministic `test/workflowMultiBridge.integration.test.js`, which starts separate primary and worker Node processes and verifies observe/download/verify/apply.
- Added live `workflow-multi-bridge`, where the normal isolated bridge remains the sole owner of the real ChatGPT tab and an independent child worker applies the generated ZIP.
- Updated `ARCHITECTURE.md`, `AGENT.MD`, `README.md`, `CONTEXT.MD`, and `GOAL.MD` with the current public-stream and multi-process workflow contracts.

## Validation

Run locally:

```text
npm ci
npm run check
npm test
npm run test:workflow:multi-bridge
npm run test:e2e:reasoning-lifecycle
npm run test:e2e:workflow-multi-bridge
```

The first four commands are browser-independent. The final two require the authorized Chrome profile and extension `1.0.9` / content runtime `3.0.9`.

## Architectural constraints

- Public reasoning progress must be proven through a pre-subscribed SSE connection, not reconstructed only from final DOM snapshots or event history.
- One primary bridge owns one browser tab. Remote workflow workers must never create a second extension/browser lifecycle for that tab.
- Observed-turn workers must use authenticated sequence-resumable SSE and import upstream artifacts into their own store before verification/apply.
- Keep `.bridge/PROJECT_ID.json` unchanged.
- Return no `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- `package-lock.json` may reference only public registries.
- Keep all project Markdown in English.
