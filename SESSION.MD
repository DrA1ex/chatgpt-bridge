# Current Session Handoff

## Current release

- Bridge package: `6.2.2`.
- Extension manifest: `2.2.2`.
- Content runtime: `4.2.2`.
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
- Only canonical request commands carry a request lease. Standalone commands are persisted and correlated without creating a `TabLease`; mutating standalone operations are exclusive and read-only diagnostics may coexist with an active request.
- Critical command/effect results and forced reconciliation observations are ACKed only after canonical handling commits; normal observations are replaceable and are not persisted in the outbox.
- `command.accepted` and `command.progress` never settle a command.
- Unconfirmed browser writes are not retried. Prompt submission is one attempt; ambiguity becomes a typed uncertain effect.
- Browser-effect reconciliation is kind-specific and read-only; prompt, steering, attachment, model/session, artifact, download, and cancel outcomes require exact evidence rather than phase inference.
- Download captures persist lease/effect/artifact identity. Indirect downloads require lease, artifact candidate, source turn, exact normalized name, and capture-window agreement; filename alone is insufficient.
- The per-tab queue has priority classes and reserved critical capacity while preserving source sequence inside one transport stream; it exposes cancellation, rejection, and high-water metrics.
- Physical BrowserEffect records contain full command/request/epoch/precondition/timestamp/reconciliation identity; dispatched cancellation requires proof that no write occurred.
- Background schema 5 transitions are fail-closed on `chrome.storage.session` errors; candidate revisions never authorize side effects before durable persistence, and legacy v1-v4 namespaces are cleaned only after current and legacy state is confirmed idle.
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

## 6.2.2 live E2E control and timeout hardening

- Active-request tab reload is a request-scoped reconciliation control carrying the exact canonical request, lease, owner, source client, and response epoch. Standalone reload remains a maintenance operation and cannot mutate a leased tab.
- `prompt.steer` and `prompt.cancel` are server-planned BrowserEffects with stable effect identity, idempotency key, preconditions hash, attempt, and retry policy. Content no longer fabricates descriptors for control writes.
- Cancellation becomes canonical only after the durable physical `prompt.cancel` result proves generation stopped. Command acceptance alone cannot materialize `cancelled`; delivery failure produces a typed recoverable failure when no physical effect record exists.
- Browser-effect success preserves its typed outcome message through the protocol adapter, so cancellation reason and reconciled outcome remain canonical evidence.
- Real E2E enables six-minute absolute prompt and asynchronous-turn limits by default. Explicit zero still disables either limit; `reload-mid-request` retains its independent ten-minute ceiling.
- Failed scenario recovery waits for a continuously idle canonical and physical release projection before reusing or reloading the tab. A failed reload can no longer leak an active request into response parsing or later artifact scenarios.
- Regression coverage reproduces the live `last-real-e2e(28)` failures: active leased reload, missing steer/cancel descriptors, cancellation settlement, cascading Markdown failure, and disabled default wall-clock limits.

## 6.1.0 final v3/v4 architecture hard cut

- Protocol 4 now has one observation message, `tab.observation`. The transitional `request.observation` alias and permissive unknown-payload fallback were removed; unsupported payload types fail immediately.
- Background runtime schema 5 starts a clean persisted namespace. Legacy v1-v4 records are never adopted and are deleted only after every legacy/current lease, command, effect, outbox entry, and download is proven idle.
- The physical BrowserEffect ledger is self-contained: command/causation identity, response epoch, preconditions hash, attempt, planned/dispatched/settled timestamps, reconciliation evidence, cancellation evidence, and report state are persisted together.
- A dispatched browser effect can be cancelled only with explicit `provenNotExecuted` evidence. Ambiguous interruption remains `uncertain` and cannot be silently converted into cancellation.
- The per-tab executor now has owner-invalidation, release, request, reconciliation, read-only, and maintenance priorities plus reserved critical capacity. Priority cannot reorder envelopes inside the same transport sequence.
- Normal observations are no longer placed in the durable outbox. Only command/effect results and explicitly forced reconciliation snapshots survive disconnect; normal state is refreshed from a new full observation after reconnect.
- Passive observed-turn deduplication and request reconnect/rehydration were split out of `BridgeClientEventRouter`. All source-tested composition roots and stateful coordinators are now enforced at 500 lines or fewer.
- Architecture tests reject legacy observation vocabulary, incomplete effect cancellation, unreserved release queues, premature queue completion, unsafe legacy-state cleanup, and reintroduction of transitional protocol aliases.

## 6.0.19 transport ownership, steer, and artifact isolation

- `BrowserExtensionHub` is now a transport-only connection/router surface. It no longer creates, caches, validates, or releases request leases and has no release registry. Immutable request identity comes only from canonical request state; background is the sole `TabLease` owner.
- Protocol commands have two explicit scopes. Request commands carry the canonical request envelope. Standalone diagnostics, artifact fetches, session administration, and maintenance carry no request envelope even when their payload includes a request ID for correlation.
- Read-only standalone commands may run under an active request lease. Mutating standalone commands are serialized independently and are rejected while a request or another standalone write owns execution. They can no longer appear as `activeRequest` after reconnect or poison later prompts.
- `BridgeCommandRegistry` owns command correlation and the source release barrier. Timeout or abort first sends `command.cancel` and waits for its physical settlement; rejected transport delivery immediately settles the pending command.
- Canonical coordinator effects and physical browser effects use independent reducer domains. A steer coordinator effect may overlap the browser effect it dispatches without triggering a false parallel-effect conflict.
- Steering waits for canonical prompt submission plus active generation before dispatch. It no longer relies on disposable content phase flags or races a response that has already completed.
- Reasoning result validation accepts locale grouping separators while still requiring the exact integer value.
- Regression coverage reproduces the live failure chain from `last-real-e2e(27)`: formatted reasoning result, in-flight steer, timed-out artifact materialization, cancellation settlement, next prompt acceptance, and cleanup without a resurrected command request.

## 6.0.18 reload-boundary and graceful-E2E hardening

- The proved submitted user-turn boundary is persisted in canonical request state. A content reload may restore only the physical lease; missing or stale content anchor fields can no longer override the server-owned response boundary or keep a completed answer permanently `generation.active`.
- `client.ready` reattaches the canonical request and sends a typed `request.resume` projection containing response epoch, submitted user turn, and assistant turn anchors. Content applies that projection through its closed `request.anchor_updated` event and immediately emits one fresh normalized observation.
- The reload recovery regression reproduces the live sequence from E2E run `b1f057cbb8ef`: prompt submitted, active response observed, content reloaded to a lease-only projection, final stopped response observed, and the same request completed without resubmission.
- Real E2E reload waits now have a ten-minute wall-clock ceiling when the global absolute timeout is disabled. Repeated liveness/deadline events cannot keep the scenario alive forever.
- The E2E-owned server runs in a separate POSIX process group. One terminal Ctrl+C belongs to the parent runner; an immediate duplicate signal is ignored, while a deliberate later Ctrl+C still forces exit. Graceful cleanup can therefore interrupt canonical work, settle release barriers, write diagnostics, and stop the child in order.

## 6.0.17 observation performance hardening

- Composer-only and extension-panel mutations are filtered before the shared observation scheduler, so ordinary typing does not start a response-parser pass. Contenteditable nodes inside assistant turns remain observable.
- The normal latest-turn path performs one document-ordered turn query and parses only the requested recent assistant turn. Historic artifact recovery scans remain available only to explicit recovery commands.
- Normal observations no longer clone and sanitize final response DOM into `parserAudit.sourceHtml`; source capture occurs only when DOM timeline/fixture capture is explicitly enabled.
- Fallback polling is reduced from one second to five seconds. The 750 ms and 2,000 ms stability milestones use dedicated timers, preserving canonical completion timing without repeated idle DOM scans.
- A tab-observer performance ledger exposes collect counts, ignored mutation batches, and slow-pass diagnostics. Regression tests prove composer typing performs zero parser reads while turn/reasoning mutations remain urgent.

## 6.0.16 durable transport and E2E recovery hardening

- Remote workflow cursor state is published only after its candidate snapshot has been durably committed. A listener-accepted turn can no longer appear acknowledged in `health()` while the cursor file still contains the previous sequence.
- Assistant turns retain streaming state when the DOM still contains `.streaming-animation`, even if a hidden or background tab no longer exposes the stop button. Streaming evidence now propagates through `TabObservation`, request terminal policy, and the shared active/passive evidence classifier.
- Accepted canonical browser-effect transitions are exposed to public turn-event consumers exactly once. `prompt.submit` success emits a canonical `prompt.sent`, so reload tests wait for proved submission rather than diagnostic telemetry.
- Failed E2E scenarios stop and interrupt canonical work, wait for both request settlement and physical lease release, and only then reload a stale browser projection. Final conversation cleanup applies the same barrier after a lease conflict.
- Regression coverage includes delayed cursor persistence, hidden-tab streaming output, duplicate effect delivery, release-pending scenario recovery, and cleanup lease conflicts.

## 6.0.15 state-ownership hardening

- This release introduced a transitional Hub-side mitigation for stale diagnostic request IDs and release barriers. Version 6.1.0 removes that transitional lease/release ownership from Hub entirely; standalone commands now have no request envelope and the command registry owns release correlation.
- The workflow hydration inbox is durable in the v3 workflow store. Inputs received while a persisted workflow is restoring survive process restart, retain binding epoch identity, drain exactly once, and remain persisted when processing fails.
- `workflowState.binding` is the only runtime workflow binding source. Workflow services no longer mutate `config.watch`, `config.automation.session`, or independent `boundSessionId` / `boundSourceClientId` mirrors.
- The content execution projection no longer uses a mutable `Proxy`. Callers receive a frozen getter view and may change state only through closed typed `update()` events.
- Regression coverage reproduces the real E2E sequence: terminal release, stale layout capture, command-scoped diagnostic settlement, and acceptance of the next prompt. Source checks prevent binding mirrors and mutable content projections from returning.

## Previous reload recovery and layout diagnostics

- General composer, generation, model, effort, and artifact selectors reject the ChatGPT history sidebar, message-level model controls, and the extension-owned panel. Session discovery/change/delete commands retain intentional sidebar access.
- `model.apply` returns the internally verified picker snapshot through its typed effect result. The canonical server router projects deduplicated `model.apply.started` and `model.apply.done` public events.
- The real `reload-mid-request` failure from run `34c4c2ec6091` was a lease-identity bug: the E2E control command created a synthetic command request while the tab belonged to the active turn. The scenario now sends its exact turn request ID, and the bridge falls back to the live active-request identity when callers omit it.
- Fault-injection reload remains request-scoped when recovering an active request. Sanitized layout capture is now a read-only standalone command with no request envelope; version 6.1.0 supersedes the former active-lease reuse workaround.
- The opt-in `--capture-page-layout` / `--capture-layout` flag records deduplicated sanitized structural snapshots after startup, before/after each scenario, at the failure boundary, and during finalization. Captures preserve selector, ARIA, visibility, display/position, and geometry evidence while redacting messages, conversation/account data, inputs, media URLs, query strings, and unstable identifiers.
- Layout-capture failures are indexed but never replace the original scenario error. The API route, manifest-order content module, sanitizer, archive writer, scenario hooks, deduplication, and standalone read-only behavior are covered locally.

## Verification completed locally

```text
npm run check                    # 391 JS files checked
npm test                         # 826 passed, 0 failed, 1 optional skip
npm run test:faults              # 170 passed, 0 failed
npm run test:workflow:coverage   # 102 passed; 85.50% lines, 68.71% branches
npm run test:e2e:local           # 67 passed, 0 failed
npm run test:workflow:multi-bridge  # 1 passed, 0 failed
```

A live smoke debug archive exposed and now covers two startup regressions: initial `prompt.send` lacked a command identity and the floating panel was mounted only after a later navigation/focus event. Regression tests execute manifest-order content startup, assert panel synchronization, verify prompt command identity round-trip, and require canonical fast failure for command rejection.

A later smoke archive exposed two cross-scenario races that are now covered without live E2E: standalone control calls wait for the previous canonical request release barrier, and current-session deletion survives a content reload by reconciling its persisted standalone command from the next `TabObservation`. The correlated command registry waits and resumes after durable release settlement, while background rejects mutating standalone dispatch under an active request lease.

The dedicated fault matrix injects persistence failures at every background state transition, covers browser and local effect result-commit boundaries, verifies pause/stop settlement and terminal absorption, table-tests effect-specific browser reconciliation, and exercises remote cursor redelivery plus strict download binding.

Core composition roots and stateful coordinators are enforced at 500 lines or fewer. The general production ceiling remains 1,000 lines for reviewed parser, UI, route, fixture, and script modules.

A clean installation from `package-lock.json` succeeded with `npm ci --ignore-scripts`, installing 122 packages. `npm run check`, the full 826-pass suite, the 170-case fault matrix, workflow coverage, captured-DOM replay, and multi-bridge integration all passed.

## External verification

Authenticated real-browser verification was not executed in this environment. A logged-in browser must still run smoke, reasoning/public progress, steer, ZIP artifact, workflow presets, workflow multi-bridge, and reload-mid-request scenarios against extension `2.2.2` / content `4.2.2`. Run the next full suite with `--capture-page-layout` so page-structure evidence is present in the diagnostic ZIP if another selector or dialog variant fails.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged when present.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while registry URLs remain public.
- Keep all project Markdown in English.

## 6.2.2 reload boundary recovery and semantic E2E deadlines

- Reload recovery now validates the canonical submitted user-turn boundary against the restored DOM before accepting any assistant turn.
- A changed DOM key may be rebound only when the exact normalized submitted prompt text matches; a missing boundary becomes typed `recovery_uncertain` without prompt resubmission.
- The content request monitor cannot attach an assistant turn from an older user boundary after reload.
- The real E2E reload scenario waits for a stable canonical boundary and active generation before reloading.
- E2E idle deadlines now advance only on semantic lifecycle/output changes; heartbeat, revision and repeated deadline events cannot postpone timeout indefinitely.

