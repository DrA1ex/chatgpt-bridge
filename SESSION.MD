# Current Session Handoff

## Current release

- Bridge package: `6.0.8`.
- Extension manifest: `2.0.8`.
- Content runtime: `4.0.8`.
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

## Verification completed locally

```text
npm run check                    # 373 JS files checked
npm test                         # 764 passed, 0 failed, 1 optional skip
npm run test:faults              # 90 passed, 0 failed
npm run test:workflow:coverage   # 98 passed; 85.53% lines, 69.32% branches
npm run test:e2e:local           # 67 passed, 0 failed
npm run test:workflow:multi-bridge  # 1 passed, 0 failed
```

The dedicated fault matrix injects persistence failures at every background state transition, covers browser and local effect result-commit boundaries, verifies pause/stop settlement and terminal absorption, table-tests effect-specific browser reconciliation, and exercises remote cursor redelivery plus strict download binding.

Core composition roots and stateful coordinators are enforced at 500 lines or fewer. The general production ceiling remains 1,000 lines for reviewed parser, UI, route, fixture, and script modules.

A clean installation from `package-lock.json` succeeded in an isolated copy without reusing the working `node_modules`: `npm ci --ignore-scripts --offline --no-audit --no-fund` installed 122 packages, `sqlite3` rebuilt from source against the current Node headers and system SQLite, the native module loaded, and `npm run check` plus the full 764-test suite passed.

## External verification

Authenticated real-browser verification was not executed in this environment. A logged-in browser must still run smoke, reasoning/public progress, steer, ZIP artifact, workflow presets, workflow multi-bridge, and reload-mid-request scenarios against extension `2.0.8` / content `4.0.8`.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged when present.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while registry URLs remain public.
- Keep all project Markdown in English.
