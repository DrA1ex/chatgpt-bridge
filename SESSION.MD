# Current Session Handoff

## Completed

- Package version moved to `5.1.2`.
- Extension version moved to `1.0.2`; content runtime moved to `3.0.2`.
- Fixed missing `setRequestPhase` and `collectArtifactsFromNode` dependencies in `turnSnapshots.js`.
- Fixed the real missing `effortFor` binding between `e2e-real.js` and core scenarios. The previous module-only guard did not verify launcher wiring.
- Added `scripts/e2e/core-scenario-context.js`: static scenario dependencies are validated before bridge/browser startup, and request-bound session/client values are validated before scenario registration.
- Added a launcher-wiring regression that verifies the validated context is assembled before `startBridgeIfNeeded`, includes `effortFor`, and is used by `runCoreScenarios`.
- Analyzed `smoke(2).zip`: bootstrap, canonical completion, request release, and cleanup were successful; the only failing cause was the omitted launcher binding.
- Replaced request-command TDZ access with explicit lazy proxies backed by the initialized request-command API.
- Added critical dependency validation for turn snapshots and executable context regression tests.
- Added a final deduplicated real-E2E failure summary: `FAILED` for scenario/cleanup failures and `ERROR` for underlying browser/runtime diagnostics.
- Fixed content-runtime TDZ failures involving `publicRequestStatus`, `snapshotTerminalForRequest`, `domPathForNode`, and `conversationIdFromUrl` by making genuine assembly cycles lazy.
- Added `test/extensionContentBootstrap.test.js`, which executes the full manifest content-script order and catches initialization-order failures.
- Fixed local artifact turn-key handling in `artifactDom.js`.
- Added opt-in live DOM capture:
  - `--capture-dom-fixtures`;
  - `--fixture-output-dir`;
  - `npm run test:e2e:capture-dom`.
- Capture output contains sanitized assistant-turn HTML, semantic parser expectations, and canonical request traces.
- Added browser-free captured-DOM parser tests and canonical trace replay tests.
- Split real E2E scenarios into `scripts/e2e/scenarios/core.js` and `workflows-projects.js`.
- Extracted final E2E diagnostics into `scripts/e2e/diagnostics.js`.
- `scripts/e2e-real.js` is now 999 lines.
- All production JavaScript files are below 1,000 lines.
- Updated `ARCHITECTURE.md`, `AGENT.MD`, `README.md`, `CONTEXT.MD`, and `GOAL.MD` to the current architecture and fixture workflow.

## Validation completed locally

```bash
npm run check
npm test
```

The manifest bootstrap, dependency contracts, capture writer, offline parser fixtures, reducer replay, E2E failure summary, E2E surface, and scenario registry tests are included in the normal test suite. The final local run completed 380 tests: 379 passed and one real-browser fixture was skipped as expected. `npm run check` passed for 220 JavaScript files.

## External validation still required

This environment does not have the user's logged-in live ChatGPT browser session. Before release verification:

1. reload the unpacked extension;
2. run the complete real-browser E2E matrix;
3. run the capture scenario set;
4. review and promote any new sanitized fixtures;
5. rerun local checks.

## Handoff checks

- `.bridge/PROJECT_ID.json` must remain unchanged.
- `package-lock.json` must contain only public registry URLs.
- Final archives must exclude `node_modules`, `.git`, `.env`, logs, databases, caches, build output, generated E2E reports, nested archives, and `CHANGELOG.md`.
