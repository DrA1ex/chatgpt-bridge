# Current Session Handoff

## Current release

- Bridge package: `6.0.13`.
- Extension manifest: `2.0.13`.
- Content runtime: `4.0.13`.
- Extension protocol: `4` only.
- Workflow runtime schema: `3` only.
- Interactive dependency: exact `terlio.js@1.1.0`.
- `package-lock.json` references public npm registry URLs only.

## Canonical architecture

- The server request reducer is the only owner of request lifecycle, completion, errors, blockers, deadlines, and release intent.
- The extension background owns tab leases, the per-tab operation queue, command/effect ledgers, transport epochs/sequences/outbox, and download capture.
- Content owns one `TabObserver` parser pipeline and explicit DOM executor adapters. It does not materialize terminal request state.
- Active requests and passive workflows consume the same immutable `TabObservation` and response-epoch identities.
- Direct request-projection assignment is forbidden; content uses closed typed update groups.
- Every correlated command has a request or synthetic command-scoped lease and is registered before dispatch.
- Critical extension input is ACKed only after canonical handling commits; negative ACKs keep the exact envelope in the background outbox for retry.
- `command.accepted` and `command.progress` never settle a command.
- Unconfirmed browser writes are not retried. Prompt submission is one attempt; ambiguity becomes a typed uncertain effect.
- Browser-effect reconciliation is kind-specific and read-only; prompt, steering, attachment, model/session, artifact, download, and cancel outcomes require exact evidence rather than phase inference.
- Download captures persist lease/effect/artifact identity. Indirect downloads require lease, artifact candidate, source turn, exact normalized name, and capture-window agreement; filename alone is insufficient.
- Bounded queues expose coalescing, rejection, and high-water metrics through transport health projections.
- Background reducer transitions are fail-closed on `chrome.storage.session` errors; candidate revisions never authorize side effects before durable persistence, and legacy v1-v3 namespaces are cleaned only after confirmed idle.
- Active and passive completion consume one shared turn-evidence classifier.
- Every server-to-extension command, including request-scoped `prompt.send`, carries a durable `commandId`; content echoes it in the first typed result and background rejects commandless delivery.
- The floating page panel mounts during initial content startup, remounts on foreground/navigation, and is attached to `document.body` when available.
- Request-scoped `command.error`/`command.rejected` messages fail the canonical request immediately instead of being ignored until disconnect.

## Workflow implementation

- `/workflow` is the single normal interactive entry point and no workflow starts from an ordinary prompt.
- The three presets share one workflow v3 reducer and one `nextAction` decision contract.
- Workflow-owned Git aggregation is part of canonical v3 state, so checkpoint SHAs, base SHA, owned paths, expected path states, and the final commit message survive restart.
- Passive observation is a subscription/capability, not a separate watcher lifecycle.
- Startup uses a hydration barrier before a workflow becomes routable.
- Stop and pause use settlement barriers and cannot advertise a terminal control state while dispatched or uncertain effects remain unresolved.
- Checks, verify, plan, apply, rollback, commit, squash, and starting-state restore use durable local-effect records with idempotency and precondition guards. Write recovery requires receipts or exact filesystem/Git evidence.
- Session handoff and queued passive turns are protected by binding epochs.
- The independent workflow worker persists upstream identity, stream epoch/cursor, last durably enqueued event, and connection/block state. A retained-history gap becomes a canonical resync/stop action.
- `bridge-result.json.files` is optional and advisory. Effective changes are derived from the transactional project diff; bridge control files are never written into the project.

## 6.0.13 reload recovery and layout diagnostics

- General composer, generation, model, effort, and artifact selectors reject the ChatGPT history sidebar, message-level model controls, and the extension-owned panel. Session discovery/change/delete commands retain intentional sidebar access.
- `model.apply` returns the internally verified picker snapshot through its typed effect result. The canonical server router projects deduplicated `model.apply.started` and `model.apply.done` public events.
- The real `reload-mid-request` failure from run `34c4c2ec6091` was a lease-identity bug: the E2E control command created a synthetic command request while the tab belonged to the active turn. The scenario now sends its exact turn request ID, and the bridge falls back to the live active-request identity when callers omit it.
- Reload and sanitized layout-capture commands reuse the existing active request lease. Regression tests inspect the protocol envelope and verify that no `leaseScope: command` is introduced.
- The opt-in `--capture-page-layout` / `--capture-layout` flag records deduplicated sanitized structural snapshots after startup, before/after each scenario, at the failure boundary, and during finalization. Captures preserve selector, ARIA, visibility, display/position, and geometry evidence while redacting messages, conversation/account data, inputs, media URLs, query strings, and unstable identifiers.
- Layout-capture failures are indexed but never replace the original scenario error. The API route, manifest-order content module, sanitizer, archive writer, scenario hooks, deduplication, and active-lease behavior are covered locally.

## Verification completed locally

```text
npm run check                    # 380 JS files checked
npm test                         # 787 passed, 0 failed, 1 optional skip
npm run test:faults              # 114 passed, 0 failed
npm run test:workflow:coverage   # 98 passed; 85.53% lines, 69.32% branches
npm run test:e2e:local           # 67 passed, 0 failed
npm run test:workflow:multi-bridge  # 1 passed, 0 failed
```

A live smoke debug archive exposed and now covers two startup regressions: initial `prompt.send` lacked a command identity and the floating panel was mounted only after a later navigation/focus event. Regression tests execute manifest-order content startup, assert panel synchronization, verify prompt command identity round-trip, and require canonical fast failure for command rejection.

A later smoke archive exposed two cross-scenario races that are now covered without live E2E: command-scoped control calls wait for the previous canonical request release barrier, and current-session deletion survives a content reload by reconciling the persisted command from the next `TabObservation`. Direct dispatch during release is rejected with `BROWSER_RELEASE_PENDING`, while the correlated command registry waits and resumes after durable release settlement.

The dedicated fault matrix injects persistence failures at every background state transition, covers browser and local effect result-commit boundaries, verifies pause/stop settlement and terminal absorption, table-tests effect-specific browser reconciliation, and exercises remote cursor redelivery plus strict download binding.

Core composition roots and stateful coordinators are enforced at 500 lines or fewer. The general production ceiling remains 1,000 lines for reviewed parser, UI, route, fixture, and script modules.

A clean installation from `package-lock.json` succeeded in an isolated copy without reusing the working `node_modules`: `npm ci --ignore-scripts --offline --no-audit --no-fund` installed 122 packages, `sqlite3` rebuilt from source against the current Node headers and system SQLite, the native module loaded, and `npm run check` plus the full 787-pass suite passed.

## External verification

Authenticated real-browser verification was not executed in this environment. A logged-in browser must still run smoke, reasoning/public progress, steer, ZIP artifact, workflow presets, workflow multi-bridge, and reload-mid-request scenarios against extension `2.0.13` / content `4.0.13`. Run the next full suite with `--capture-page-layout` so page-structure evidence is present in the diagnostic ZIP if another selector or dialog variant fails.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged when present.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while registry URLs remain public.
- Keep all project Markdown in English.
