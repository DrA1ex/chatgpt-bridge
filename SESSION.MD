# Current Session Handoff

## Completed

- Bridge package moved to `5.4.1`; extension moved to `1.0.13`, content runtime moved to `3.0.13`, and protocol remains `3`.
- Integrated the deterministic DOM-capture workflow: `test:e2e:capture-dom` rebuilds the generated sanitized corpus, and `test:e2e:local` replays it without Chrome.
- Reworked workflow UX around explicit definitions and runs: `/workflow` is now a compact dashboard with human stages and context-sensitive actions; watcher controls are hidden as compatibility-only internals.
- Added immutable per-run session binding with `current`, `new`, and `pinned` policies. Fresh runs never inherit the previous thread/session, and `/session new` affects only the next run.
- Added `restartPolicy` (`ask`, `auto`, `discard`); `ask` is the default and restores active automation as `Interrupted` until explicit resume or discard.
- Added `bridge workflow init`, `validate`, one-shot `run`, `resume`, `discard`, and long-lived `serve`/legacy `watch` alias.
- Added workflow-aware Ctrl+C behavior: confirm only during local blocking effects, exit directly while idle, preserve remotely waiting runs/prompts for explicit resume, and force exit on a second interrupt.
- Added executable `bin/bridge.js` aliases for `bridge` and `chatgpt-bridge`, fixing Unix `npm link` permission failures.
- Split user-facing workflow views, automation session/recovery policy, status panels, and CLI runtime into dedicated modules while keeping production files within the 1,000-line ceiling.
- Active-turn steer submission now falls back to the native `HTMLFormElement.requestSubmit()` algorithm when ChatGPT exposes no usable send button; synthetic keyboard input remains only the final compatibility fallback.
- Artifact materialization resolves its source turn by the persisted `(sourceTurnKey, sourceTurnIndex)` pair and chooses the newest matching turn when ChatGPT reuses a React key.
- Extension reload keeps the original one-time launch identity in session storage while applying only the temporary bridge server URL, so token-bound E2E cleanup can still close the exact launched tab.
- Real E2E diagnostic ZIPs now use lossless DEFLATE compression. The complete parsed browser stream is retained in `browser-debug.ndjson`, while high-frequency live console lines require `--verbose`.
- Visible progress logical IDs can no longer change kind when ChatGPT reuses a React DOM slot for a different phase.
- Passive prompt observation keeps rescanning the assistant turn after the submitted user boundary until it becomes terminal, even when no matching final DOM mutation arrives.
- `AGENT.MD` documents the restricted-sandbox `sqlite3` install using local Node headers and system SQLite.

- Cumulative reasoning blocks remain visible when ChatGPT nests a transient shimmer label inside the same DOM wrapper.
- Persisted reasoning items retain their exact visible DOM logical IDs, while the public SSE may keep a stable fallback alias such as `snapshot-thinking` until the matching completion wrapper is published.
- Passive workflow observation records the submitted user-turn boundary together with the exact pre-submit assistant-turn baseline, so a temporarily reordered old React turn cannot be emitted as a new workflow result.
- A workflow pipeline awaiting approval cannot be replaced by another observed turn. Later turns are deduplicated, bounded, and processed only after the active pipeline reaches a terminal decision.
- Passive observer terminal detection now delegates to the shared DOM completed-snapshot policy and no longer requires the response action bar for a ready ZIP or stable final answer.
- Explicit passive prompts hard-baseline all pre-existing assistant turns before submission.
- Workflow E2E waits now default to a 120-second absolute stage timeout and a 60-second started-pipeline idle timeout, with typed failures and recent-event diagnostics.
- Interrupted E2E runs print a deduplicated failure summary before writing terminal diagnostics.
- Bridge package moved to `5.3.1`; extension moved to `1.0.12`, content runtime moved to `3.0.12`, and protocol remains `3`.
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

The first four commands are browser-independent. The final two require the authorized Chrome profile and extension `1.0.13` / content runtime `3.0.13`.

## Architectural constraints

- Public reasoning progress must be proven through a pre-subscribed SSE connection, not reconstructed only from final DOM snapshots or event history.
- One primary bridge owns one browser tab. Remote workflow workers must never create a second extension/browser lifecycle for that tab.
- Observed-turn workers must use authenticated sequence-resumable SSE and import upstream artifacts into their own store before verification/apply.
- Keep `.bridge/PROJECT_ID.json` unchanged.
- Return no `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- `package-lock.json` may reference only public registries.
- Keep all project Markdown in English.
