# Current Engineering Goals

## Primary goal

Keep browser automation deterministic under changes in the live ChatGPT UI. Browser facts become revisioned observations, request-scoped actions become typed effects, and one canonical reducer makes all request decisions.

The architecture implementation is complete. Current work is release validation, fixture growth, and maintaining the established boundaries.

## Reliability goals

- Fail immediately on explicit request-owned terminal errors.
- Never wait for a timeout after an incompatible terminal revision is committed.
- Use deadlines only for absent progress, lost liveness, reconnect failure, or artifact materialization failure.
- Preserve final answer, reasoning, ordered response blocks, artifacts, and source identity without reconstructing lifecycle from logs.
- Keep stale observations, duplicate messages, and restarted observer epochs deterministic.
- Bind follow-ups, recovery, artifact actions, and release to the correct source tab.
- Treat required ZIP output separately from text completion.
- Catch content-runtime initialization and dependency-order failures before live browser testing.

## Architecture goals

- Maintain protocol 3 as the only extension contract.
- Keep the extension as observer/effect executor and the server as decision owner.
- Keep all production source files below 1,000 lines and target 500 lines.
- Keep `content.js` and `e2e-real.js` as thin composition/orchestration facades.
- Keep content-module dependencies explicit and manifest-order bootstrap-tested.
- Convert recurring live DOM and lifecycle failures into sanitized offline fixtures and reducer traces.
- Keep workflow watcher and pipeline state independent and atomically persisted.

## Release-validation goals

1. Reload extension `1.0.2` in a logged-in target browser profile.
2. Run the full real-browser E2E matrix.
3. Run `npm run test:e2e:capture-dom`.
4. Review and promote new sanitized fixtures for every meaningful DOM variant.
5. Rerun `npm run check` and `npm test`.

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
