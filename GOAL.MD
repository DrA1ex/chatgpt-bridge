# Current Engineering Goals

## Primary goal

Keep browser automation deterministic and recoverable under changes in the live ChatGPT UI. Parsing and transport are expected to be fragile at their boundaries, so failures must remain typed, localized, replay-safe, and unable to create a second lifecycle owner.

The workflow v3 and Protocol 5 atomic-publication hard cut is implemented. Core composition roots and stateful coordinators now meet the enforced 500-line boundary. Current work is live release verification, captured-fixture expansion, and reviewed decomposition of large pure parser/UI/script modules only when a real owner boundary appears.

## Reliability goals

- Keep Protocol 5 and its shared manifest as the only extension contract; never restore payload-kind inference or Protocol 4 compatibility routing.
- Keep one current content/background owner per browser tab, independent of client ID changes.
- Give only canonical request commands a TabLease. Persist standalone command records without creating a request owner, serialize mutating standalone operations independently, and require an explicit manifest-owned reload/reconciliation class for every command.
- Keep one serialized browser operation queue per tab.
- Keep the server canonical request reducer as the only owner of request completion, errors, blockers, deadlines, and release intent.
- Keep content disposable: it emits immutable `TabObservation` facts and typed effect results, but no terminal outcomes.
- Persist response boundaries in canonical server state and rehydrate disposable content projections after reload; never require content memory to interpret a current answer.
- Keep active request and passive workflow observation on one parser pass, one turn identity model, one response epoch, and one browser-evidence policy.
- Never repeat an unconfirmed browser write. Ambiguous prompt, steer, attachment, model/session, artifact, or download boundaries become `uncertain` and enter canonical reconciliation.
- Preserve exact command, effect, observation, turn, response-epoch, artifact, capture, and stream identities across physical redelivery.
- Keep required artifacts independent from text completion.
- Keep download captures persisted and bound by lease plus artifact identity rather than fuzzy filename matching.
- Keep workflow startup behind a hydration barrier and workflow stop behind a cancellation-settlement barrier.
- Keep checks, apply, rollback, commit, and squash in the durable local-effect ledger.
- Keep independent workflow workers on the authenticated observed-turn stream with epoch, cursor, and explicit gap detection.

## Workflow UX goals

- Keep `/workflow` as the single normal interactive entry point.
- Present exactly three user-facing presets over one workflow v3 reducer and shared services.
- Treat passive observation as a subscription, not as a second watcher lifecycle.
- Keep every required decision in one persisted `nextAction` contract.
- Reuse unchanged project context and increment the binding epoch when a workflow moves to another chat.
- Require safe machine-applicable result metadata while deriving the effective changed-file set from the transactional project diff.
- Commit only workflow-owned file states and preserve unrelated work.
- Stop or ask after no progress, conflict, retry exhaustion, ambiguous recovery, or exhausted session policy.

## Architecture goals

- Do not add alternate transports, downgrade adapters, fragmented request messages, local terminal timers, speculative resend paths, or mutable request-state merging.
- Keep direct DOM writes inside explicit executor adapters. Observers, parsers, routers, coordinators, and composition roots must remain read-only with respect to the page.
- Keep the source-tested core composition roots and stateful coordinators at 500 lines or fewer; retain the 1,000-line general ceiling for reviewed pure parser/UI/script modules.
- Convert recurring live DOM failures into sanitized parser fixtures and reducer/event traces.
- Keep public answer/reasoning/progress events as server projections of committed observations.
- Keep command progress as telemetry; only explicit terminal command result types settle correlation.

## Verified in the current tree

- Versions are bridge `6.3.0`, extension `2.3.0`, content runtime `4.3.0`, protocol `5`, and workflow schema `3`.
- Protocol 5 has one shared manifest/validator and no payload-kind inference or Protocol 4 compatibility routing.
- Effect-backed commands have one physical terminal lifecycle, and terminal state plus exact outbox envelope commit atomically.
- Background owns release; unproved cleanup quarantines the tab instead of blocking unrelated work.
- A disconnected content runtime is dormant: no DOM observer, polling, history/navigation hook, floating page panel, or page-world media/download interception remains active. Artifact page hooks are temporary and exact-capture scoped.
- Direct content request-projection mutation is source-tested and rejected at runtime.
- Fragmented content terminal/answer/thinking/artifact lifecycle messages are absent.
- Unconfirmed prompt submission is attempted once and becomes `uncertain`; it is never automatically resubmitted.
- Standalone browser commands receive durable command records without a request lease; only canonical request commands can claim `TabLease`. Every standalone write has a tested reload policy: registered-but-undispatched becomes `proved_not_started`; dispatched work requires proof from observation, read probe, content epoch, download capture, or maintenance state, otherwise typed uncertainty without replay.
- Unsafe browser or local writes may return to `planned` only after a kind-specific reconciler proves the previous attempt did not start. An idempotency key or unchanged preconditions alone never authorize retry.
- Workflow local effects, owned project-context snapshots, hydration, cancellation settlement, retry policy, stream epoch/cursor, gap handling, and persisted workflow-owned Git aggregation are implemented.
- Background schema 6 atomically commits correctness-critical reducer state with the exact immutable outbox message; legacy v1-v5 state is never adopted and is cleaned only after every legacy record is confirmed idle.
- Active and passive turn completion consume one shared terminal-evidence classifier.
- Background, content command handling, the canonical request machine, and workflow state are decomposed into focused transition families behind stable thin facades, with architecture checks enforcing the module boundaries.
- The local verification contract is available as `npm run verify:release:local`; it runs static/package checks, the full suite, fault matrices, workflow coverage, captured fixtures, multi-bridge integration, the optional Chromium capability fixture, atomic extension deployment verification, and a production dependency audit.

## Remaining release work

1. Reload extension `2.3.0` in a logged-in target browser profile.
2. Run `npm run test:parser-fixture` and `npm run verify:release:live -- --reload-extension --capture-page-layout` to execute the authenticated Chromium parser/smoke/reasoning/steer/reload/ZIP/layout/workflow/quarantine matrix and retain its release report.
3. Capture sanitized fixtures for any new DOM variant; the offline corpus already includes a required-ZIP fixture paired with a self-contained canonical request trace.
4. Run `npm run verify:release -- --reload-extension --capture-page-layout` in a networked release environment to prove clean `npm ci`, all local gates, zero production audit findings, and the live browser matrix in one invocation.
5. Split a reviewed parser/UI/script module only when new work reveals a distinct owner boundary; do not mechanically fragment files.

## Non-goals

- alternate browser transports or protocol downgrade support;
- transparent recovery when a browser/write outcome cannot be proved;
- automatic application of ambiguous or stale artifacts;
- inferring lifecycle from logs or localized UI text;
- universal retries for browser writes;
- commits outside an explicitly started workflow;
- system-message, tool-call, or structured-output semantics in the OpenAI-compatible API;
- arbitrary mechanical file splitting that introduces circular dependencies.
