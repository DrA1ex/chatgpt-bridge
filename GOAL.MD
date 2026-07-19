# Current Engineering Goals

## Primary goal

Keep browser automation deterministic and recoverable under changes in the live ChatGPT UI. Parsing and transport are expected to be fragile at their boundaries, so failures must remain typed, localized, replay-safe, and unable to create a second lifecycle owner.

The v3 workflow and v4 extension hard cut is implemented. Core composition roots and stateful coordinators now meet the enforced 500-line boundary. Current work is live release verification, captured-fixture expansion, and reviewed decomposition of large pure parser/UI/script modules only when a real owner boundary appears.

## Reliability goals

- Keep protocol 4 as the only extension contract.
- Keep one current content/background owner per browser tab, independent of client ID changes.
- Give every correlated command a request or command-scoped lease and persist it before dispatch.
- Keep one serialized browser operation queue per tab.
- Keep the server canonical request reducer as the only owner of request completion, errors, blockers, deadlines, and release intent.
- Keep content disposable: it emits immutable `TabObservation` facts and typed effect results, but no terminal outcomes.
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

- Versions are bridge `6.0.13`, extension `2.0.13`, content runtime `4.0.13`, protocol `4`, and workflow schema `3`.
- Direct content request-projection mutation is source-tested and rejected at runtime.
- Fragmented content terminal/answer/thinking/artifact lifecycle messages are absent.
- Unconfirmed prompt submission is attempted once and becomes `uncertain`; it is never automatically resubmitted.
- Generic browser commands receive command-scoped leases and durable command records.
- Workflow local effects, hydration, cancellation settlement, retry policy, stream epoch/cursor, gap handling, and persisted workflow-owned Git aggregation are implemented.
- Background state transitions fail closed on `chrome.storage.session` errors; legacy v1-v3 state is cleaned only after confirmed v4 idle.
- Active and passive turn completion consume one shared terminal-evidence classifier.
- The local verification contract is `npm run check`, `npm test`, `npm run test:faults`, `npm run test:workflow:coverage`, `npm run test:e2e:local`, and `npm run test:workflow:multi-bridge`.

## Remaining release work

1. Reload extension `2.0.13` in a logged-in target browser profile.
2. Run authenticated smoke, reasoning/public-progress, steer, ZIP artifact, workflow preset, workflow multi-bridge, and reload-mid-request scenarios.
3. Capture sanitized fixtures for any new DOM variant; the offline corpus already includes a required-ZIP fixture paired with a self-contained canonical request trace.
4. Run the optional Chromium parser fixture when `CHROMIUM_BIN` is available.
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
