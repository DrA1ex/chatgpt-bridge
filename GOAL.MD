# Current Engineering Goals

## Primary goal

Keep browser automation deterministic under changes in the live ChatGPT UI. Browser facts become revisioned observations, request-scoped actions become typed effects, and one canonical reducer makes all request decisions.

The main architecture is implemented. Current work is release verification, closing the remaining capture/test gaps, and maintaining the established boundaries.

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
- Keep all production source files at or below 1,000 lines and target 500 lines.
- Keep `content.js` and `e2e-real.js` as thin composition/orchestration facades.
- Keep content-module dependencies explicit and manifest-order bootstrap-tested.
- Convert recurring live DOM and lifecycle failures into sanitized offline fixtures and reducer traces.
- Keep workflow watcher and pipeline state independent and atomically persisted.
- Keep watcher mechanics out of normal operator UX; expose one clear run lifecycle and valid next actions.
- Bind a fresh workflow run to one explicit session and never inherit a prior run thread or passive watcher session.
- Make interrupted-run recovery explicit by default and keep headless shutdown graceful and predictable.

## Verified in the current archive

- Package, extension, and content-runtime versions are aligned at `5.4.4`, `1.0.15`, and `3.0.15`.
- `package-lock.json` is present and uses public npm registry URLs.
- `npm run check` passes for 271 JavaScript files and enforces the 1,000-line ceiling.
- The generated DOM corpus was rebuilt on July 16, 2026 and contains 55 replayable HTML/fixture pairs for `response-markdown` and `reasoning-lifecycle`.
- `npm run test:e2e:local` passes all 57 parser/replay tests.
- `npm run test:workflow:multi-bridge` passes.
- `npm run test:parser-fixture` passes five deterministic tests; the optional Chromium test is skipped without `CHROMIUM_BIN`.

## Unfinished work

1. Restore the `chatgpt-bridge` npm bin alias or deliberately remove that compatibility contract from tests and documentation. The current `package.json` exposes only `bridge`, so `npm test` fails two tests.
2. Make `test:e2e:capture-dom` persist a replayable ZIP-artifact DOM fixture. The command runs the scenario, but the committed generated corpus currently contains no `zip-artifact` directory.
3. Persist at least one self-contained canonical `request-trace.json`. The current corpus contains no reducer trace because incomplete traces are correctly skipped.
4. Run the complete live real-browser E2E matrix against extension `1.0.15` / content runtime `3.0.15` and retain the result outside the repository.
5. Rerun live `reasoning-lifecycle`, inspect `public-progress-events.json`, and confirm the current deployed ChatGPT UI still satisfies the public SSE contract.
6. Rerun live `workflow-multi-bridge` and inspect remote-worker diagnostics.
7. Run the optional Chromium parser fixture with `CHROMIUM_BIN` when a compatible browser binary is available.
8. Continue splitting the 25 production JavaScript files above the 500-line target before adding substantial responsibilities; two files are currently exactly 1,000 lines.
9. The OpenAI-compatible surface still lacks system-message semantics, tool calls, and structured-output schemas. Implement these only if broader API compatibility becomes a product goal.
10. The Codex-like app-server surface remains an MVP: shell commands, approvals, worktrees, and sandbox capabilities are explicitly unsupported.

## Release-validation sequence

1. Fix the failing npm bin contract and obtain a green `npm test`.
2. Reload extension `1.0.15` in a logged-in target browser profile.
3. Run the full real-browser E2E matrix.
4. Run `npm run test:e2e:reasoning-lifecycle` and inspect `public-progress-events.json`.
5. Run `npm run test:e2e:workflow-multi-bridge`.
6. Run `npm run test:e2e:capture-dom` and confirm that the ZIP scenario and any replayable request traces were captured.
7. Review and promote new sanitized fixtures for every meaningful DOM variant.
8. Rerun `npm run check`, `npm test`, `npm run test:coverage`, `npm run test:e2e:local`, and `npm run test:workflow:multi-bridge`.

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
