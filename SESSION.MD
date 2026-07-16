# Current Session Handoff

## Current release

- Bridge package: `5.4.1`.
- Extension manifest: `1.0.13`.
- Content runtime: `3.0.13`.
- Extension protocol: `3` only.
- `package-lock.json` is included and references public npm registry URLs.

## Implemented

- One canonical request reducer owns completion, failure, cancellation, deadlines, artifact settling, and source release.
- The extension is an observation/effect runtime; it does not independently finalize requests.
- Public turn SSE supports pre-subscription and ordered reasoning/progress completion events.
- One primary bridge owns a browser tab; independent workflow workers consume authenticated sequenced observed turns and import artifacts through the primary HTTP API.
- Workflow UX is definition/run oriented, with explicit session binding and `ask`, `auto`, and `discard` restart policies.
- Workflow CLI supports `init`, `validate`, one-shot `run`, `resume`, `discard`, and long-lived `serve` with the legacy `watch` alias.
- Passive and active paths share terminal snapshot semantics and do not require the response action bar.
- DOM capture and browser-free replay are integrated through `test:e2e:capture-dom` and `test:e2e:local`.
- Real E2E diagnostics preserve the complete parsed browser stream and use lossless DEFLATE ZIP output.
- Production JavaScript files remain at or below the 1,000-line ceiling.

## Audit results on July 16, 2026

Passed:

```text
npm run check
npm run test:e2e:local
npm run test:workflow:multi-bridge
npm run test:parser-fixture
```

Observed results:

- `npm run check`: 271 JavaScript files passed; 25 production files remain above the 500-line target.
- `npm run test:e2e:local`: 57 tests passed.
- `npm run test:workflow:multi-bridge`: 1 test passed.
- `npm run test:parser-fixture`: 5 passed, 1 optional Chromium test skipped.
- The generated corpus contains 55 HTML/fixture pairs for `response-markdown` and `reasoning-lifecycle`.

Not green:

- `npm test`: 545 passed, 2 failed, 1 skipped. Both failures are caused by the missing `chatgpt-bridge` npm bin alias: tests expect both `bridge` and `chatgpt-bridge`, while `package.json` currently exposes only `bridge`.
- `npm run test:coverage` reports approximately 73.31% aggregate line coverage, but the command fails because it executes the same two failing tests.

## Remaining work

- Restore the `chatgpt-bridge` bin alias or intentionally revise the compatibility contract and its tests.
- Capture a real offline `zip-artifact` DOM fixture; the current generated corpus has no ZIP scenario directory.
- Capture a self-contained `request-trace.json`; the current corpus has no reducer traces.
- Run the complete live browser E2E matrix against the current deployed ChatGPT UI.
- Rerun and inspect live `reasoning-lifecycle` public SSE diagnostics.
- Rerun live `workflow-multi-bridge` and inspect remote-worker diagnostics.
- Run the optional Chromium parser fixture with `CHROMIUM_BIN` when available.
- Split files at or near 1,000 lines before adding substantial responsibilities.
- OpenAI-compatible system-message semantics, tool calls, and structured-output schemas remain unsupported.
- The Codex-like app-server remains partial; shell commands, approvals, worktrees, and sandbox capabilities are explicitly disabled.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while all registry URLs remain public.
- Keep all project Markdown in English.
