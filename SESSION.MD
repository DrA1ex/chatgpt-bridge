# Current Session Handoff

## Current release

- Bridge package: `5.8.0`.
- Extension manifest: `1.0.15`.
- Content runtime: `3.0.15`.
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
- Extension startup reload now uses a page-owned MAIN-world timer, with a safe owned-tab replacement fallback for the first upgrade from legacy content.
- Replacement tabs use the stable `bridge-recovery-*` ownership namespace; the reserved `bridge-reload-*` namespace remains temporary and is intentionally omitted from extension handshakes.
- The interactive terminal is fully migrated from Ink/React to exact `terlio.js@1.0.1`; the old runtime, components, line editor, dependencies, and compatibility path are removed.
- The Terlio runtime preserves input history, bracketed paste, macOS Option/Cmd editing sequences, sticky-tail transcript scrolling, resize handling, and graceful Ctrl+C behavior. It uses three explicit layouts: full-width chat, left panel plus expanding chat, and—at 196 columns or more—two panels around an expanding center chat. Header, command editor, fixed upward suggestion dock, and footer remain full width.
- The sidebar key panel is shown only when it can fit; otherwise the footer exposes a compact essential hint. `/help` and Ctrl+B always contain the complete key reference.
- Slash completion opens on the first `/`, shows inline command help, exposes explicit no-argument variants, then offers contextual parameters, flags, theme names, numbered session/tab choices with full-ID aliases, model choices, workflow options, and artifact/response IDs.
- Terlio theme suggestions preview palettes while navigating; cancellation restores the saved theme and confirmation persists it across interactive launches.
- Header status is edge-aligned, while its metadata row selects long, short, or omitted optional fields to fit the current viewport without overflow. Command transcript output uses semantic colors for numbered choices and important values.

- Mouse-wheel, trackpad, click, and draggable scrollbar support are deferred because exact `terlio.js@1.0.1` has no mouse reporting, pointer decoding, or hit-testing API; keyboard scrolling and a visual scrollbar are implemented.

## Audit results on July 16, 2026

Passed:

```text
npm run check
npm run test:e2e:local
npm run test:parser-fixture
npm test
npm run test:workflow:multi-bridge
```

Observed results:

- `npm run check`: 277 JavaScript files passed; all production files remain within the 1,000-line ceiling and 25 remain above the 500-line target.
- `npm run test:e2e:local`: 61 tests passed across 59 captured DOM fixtures and the canonical trace-replay surface.
- `npm run test:parser-fixture`: 5 tests passed and 1 optional Chromium test was skipped because `CHROMIUM_BIN` is not available.
- `npm test`: 577 passed, 0 failed, 1 skipped.
- `npm run test:workflow:multi-bridge`: 1 integration test passed.
- Focused extension reload, ownership, content-bootstrap, and MAIN-world page-reload checks: 69 passed.
- Focused Terlio runtime, input, responsive layout, completion, theme-preview, scrolling, dependency-removal, and graceful-shutdown checks: 37 passed.
- A pseudo-TTY launch rendered the responsive Terlio dashboard, accepted PgUp and Ctrl+B, restored the normal screen/cursor after Ctrl+C, and exited with code 0.
- Local global-link installation exposed both `bridge` and `chatgpt-bridge` as executable mode-755 binaries reporting version `5.8.0`.
- A real browser E2E run was not executed in the sandbox because an authenticated Chrome profile is unavailable.

## Remaining work

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
