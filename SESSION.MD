# Current Session Handoff

## Completed

- Package version moved to `5.1.0`.
- Extension version moved to `1.0.1`; content runtime moved to `3.0.1`.
- Fixed content-runtime TDZ failures involving `publicRequestStatus`, `snapshotTerminalForRequest`, `domPathForNode`, and `conversationIdFromUrl` by making genuine assembly cycles lazy.
- Added `test/extensionContentBootstrap.test.js`, which executes the full manifest content-script order and catches initialization-order failures.
- Fixed missing explicit dependencies in extracted `turnSnapshots.js` and local artifact turn-key handling in `artifactDom.js`.
- Added opt-in live DOM capture:
  - `--capture-dom-fixtures`;
  - `--fixture-output-dir`;
  - `npm run test:e2e:capture-dom`.
- Capture output contains sanitized assistant-turn HTML, semantic parser expectations, and canonical request traces.
- Added browser-free captured-DOM parser tests and canonical trace replay tests.
- Split real E2E scenarios into `scripts/e2e/scenarios/core.js` and `workflows-projects.js`.
- Extracted final E2E diagnostics into `scripts/e2e/diagnostics.js`.
- `scripts/e2e-real.js` is now 995 lines.
- All production JavaScript files are below 1,000 lines.
- Updated `ARCHITECTURE.md`, `AGENT.MD`, `README.md`, `CONTEXT.MD`, and `GOAL.MD` to the current architecture and fixture workflow.

## Validation completed locally

```bash
npm run check
npm test
```

The manifest bootstrap, capture writer, offline parser fixtures, reducer replay, E2E surface, and scenario registry tests are included in the normal test suite.

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
