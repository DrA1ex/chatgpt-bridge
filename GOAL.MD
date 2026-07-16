# Current Engineering Goals

## Primary goal

Keep browser automation deterministic under changes in the live ChatGPT UI. Browser facts become revisioned observations, request-scoped actions become typed effects, and one canonical reducer makes all request decisions.

The architecture implementation is complete. Current work is release validation, fixture growth, and maintaining the established boundaries.

## Reliability goals

- Keep passive workflow completion semantics identical to active request completion.
- Bound every workflow E2E wait with both an absolute stage deadline and, once started, a no-progress deadline.
- Fail immediately on explicit request-owned terminal errors.
- Never wait for a timeout after an incompatible terminal revision is committed.
- Use deadlines only for absent progress, lost liveness, reconnect failure, or artifact materialization failure.
- Preserve final answer, reasoning, ordered response blocks, artifacts, and source identity without reconstructing lifecycle from logs.
- Keep stale observations, duplicate messages, and restarted observer epochs deterministic.
- Bind follow-ups, recovery, artifact actions, and release to the correct source tab.
- Treat required ZIP output separately from text completion.
- Catch content-runtime initialization and dependency-order failures before live browser testing.
- Prevent command telemetry from consuming command responses or confirming passive submission prematurely.
- In startup `ask` mode, skip reload when manifest and content-runtime versions already match; otherwise keep the confirmation visible, reload only after approval, and verify both reconnected versions.
- Recover a failed E2E source tab before allowing the next scenario to start.
- Treat reasoning attempts as independent retries and accept a later complete observation.
- Reject self-navigation links and unrelated fallback candidates during artifact discovery and ZIP selection.
- Prove public reasoning progress through a pre-subscribed SSE stream, including ordered live checkpoints and completion wrappers; DOM history alone is insufficient.
- Keep one primary browser owner per tab and support independent workflow workers only through authenticated sequenced observed-turn and artifact APIs.

## Architecture goals

- Maintain protocol 3 as the only extension contract.
- Keep the extension as observer/effect executor and the server as decision owner.
- Keep all production source files below 1,000 lines and target 500 lines.
- Keep `content.js` and `e2e-real.js` as thin composition/orchestration facades.
- Keep content-module dependencies explicit and manifest-order bootstrap-tested.
- Convert recurring live DOM and lifecycle failures into sanitized offline fixtures and reducer traces.
- Keep workflow watcher and pipeline state independent and atomically persisted.
- Keep watcher mechanics out of normal operator UX; expose one clear run lifecycle and valid next actions.
- Bind a fresh workflow run to one explicit session and never inherit a prior run thread or passive watcher session.
- Make interrupted-run recovery explicit by default and keep headless shutdown graceful and predictable.

## Release-validation goals

1. Reload extension `1.0.13` in a logged-in target browser profile.
2. Run the full real-browser E2E matrix.
3. Run `npm run test:e2e:reasoning-lifecycle` and inspect `public-progress-events.json`.
4. Run `npm run test:workflow:multi-bridge` and `npm run test:e2e:workflow-multi-bridge`.
5. Run `npm run test:e2e:capture-dom`.
6. Review and promote new sanitized fixtures for every meaningful DOM variant.
7. Rerun `npm run check` and `npm test`.

## Non-goals

- alternate browser transports;
- protocol downgrade support;
- multiple request state machines;
- page-context localhost transport;
- hidden CLI fallback runtimes;
- unbounded waits;
- automatic application of ambiguous or stale artifacts;
- arbitrary file splitting that creates circular dependencies;
- committing full ChatGPT pages or unreviewed browser data as fixtures.

## Request-finalization acceptance

- A submitted user turn may have separate reasoning, final, and artifact assistant turns; the latest meaningful request-owned turn must be used.
- Final output must complete without depending on response-action-bar visibility.
- Missing assistant DOM must remain recoverable until canonical forced-snapshot/deadline policy expires.
- Workflow source validation must ignore optional terminal newline differences.
