# Agent Instructions

This repository drives a logged-in ChatGPT tab through a Chrome/Chromium extension. Protocol 5 over the extension background WebSocket is the only browser transport.

Before non-trivial changes, read `CONTEXT.MD` and `ARCHITECTURE.md`. For ChatGPT DOM, selectors, turn parsing, model/effort controls, artifacts, or code-block parsing, also read `docs/CHATGPT_DOM_PARSER.md` and `docs/CHATGPT_FILES_CODE_DOM.md`.

## Engineering direction

- Model the concrete product problem we have today. Do not generalize a special case into a framework until several real cases share the same abstraction.
- Keep responsibilities narrow and ownership obvious. Every important mutable state should have one authoritative owner.
- Keep product policy visible in the main control flow. Helpers may hide mechanics, but not the decisions that determine behavior.
- Prefer explicit data flow: input -> decision -> effect -> observed result -> published state. Avoid hidden synchronization and overlapping mutable representations.
- Re-observe external reality when it is cheap to query instead of maintaining another long-lived copy of it.
- Keep recovery specific to a known failure and a known useful response. Do not turn one workaround into a generic retry/escalation framework.
- Implement sensitive lifecycle sequences once and call them through one semantic path so their invariants cannot drift.
- Prefer a direct helper, small data structure, or concrete primitive over a new manager/controller/engine layer unless the new abstraction owns cohesive state or a real invariant.
- Preserve external behavior during refactoring. If behavior must change, keep that change explicit rather than mixing it invisibly into structural cleanup.
- Optimize for local mental models and boring code: a maintainer should be able to understand one piece without reconstructing the whole system.

## Maintainability and file size

- Handwritten production JavaScript should stay at or below 800 lines. Files from 801 through 1,200 lines produce a code-quality warning; files above 1,200 lines fail the code-quality check.
- Generated JavaScript is excluded from file-size checks. Mark it explicitly (for example `@generated`, `auto-generated`, or `do not edit`) or place it under a clearly generated path / filename.
- File-size limits are maintainability signals, not formatting targets. Never code-golf, collapse unrelated statements, remove useful whitespace, or otherwise reduce readability to satisfy them.
- When a handwritten file grows too large, refactor responsibility: extract cohesive state and behavior, remove duplication, simplify control flow, or introduce a clearer module boundary. Moving arbitrary line ranges elsewhere is not a refactor.
- Format code around meaning. Keep related statements compact when clear, separate distinct steps visually, and avoid broad formatting churn that obscures functional changes.
- Avoid generic `utils` dumping grounds. Keep helpers near the domain that owns them.

## Testing direction

- Protect behavior and contracts, not current source layout. Prefer executable tests for lifecycle, state transitions, recovery, persistence, protocol behavior, and public effects.
- Do not add source-inspection mirror tests that assert literal implementation fragments, symbol names, line order, or absence of old text. If behavior matters, exercise it through a realistic harness.
- For risky structural changes, establish a green baseline, add any missing behavioral coverage, refactor, then run the full suite again.
- DOM/selector/parser changes require reviewed sanitized fixtures with semantic expectations. Never persist raw full-page ChatGPT DOM or unrelated user/account content.

## Bridge invariants

- Protocol 5 is mandatory. Message meaning comes from the shared Protocol 5/command manifests, never from payload-string inference or legacy Protocol 4 compatibility paths.
- The canonical server request reducer is the sole owner of request lifecycle, terminal outcome, deadlines, and `responseEpoch`. Extension content reports observations and typed effect results; it does not independently finalize requests.
- The extension background is the sole owner of physical tab lease release. Unproved cleanup must quarantine rather than silently reuse the tab.
- Request-scoped browser writes use typed BrowserEffects. Never retry an unconfirmed browser write; repeat it only after effect-specific proof that the previous action did not start.
- Command correlation must be registered before execution. Result commands settle through their result/rejection path; effect-backed commands settle through the linked physical effect outcome. Diagnostics, progress, and acceptance are not terminal evidence.
- Exactly one primary bridge owns a browser tab. Additional workflow processes consume authenticated observed turns and artifacts from that primary bridge; they must not attach a second browser lifecycle to the same tab.
- Keep physical tab identity stable across reload/navigation. Follow-ups stay bound to the source tab. Automatic tab opening is opt-in and uses an exact one-time launch token.
- Artifact identity must be explicit. Conversation/navigation URLs and generic Copy controls are not artifact sources. Required ZIP results complete only after the intended artifact is materialized and verified.
- Manifest-loaded content modules communicate through explicit factory dependencies or documented module globals. Do not rely on free identifiers or initialization-order accidents in `content.js`.
- Missing or virtualized DOM is degraded observation, not by itself a terminal request failure. Active and passive observation must use the same canonical `TabObservation` facts; the response action bar is evidence, not the sole completion condition.
- Keep `HOST=127.0.0.1` as the security default. Never commit or return secrets, `.env`, `.bridge-data`, generated databases, logs, `node_modules`, build output, caches, or nested archives.

## Workflow and apply safety

- Workflows are project-scoped and serialized. A workflow must not push Git commits; automatic local commits are allowed only under the configured commit policy.
- Automatically applicable ZIP results use `.zipflow/result.json`. Validate control metadata, but the actual transactional diff is authoritative.
- Apply must reject traversal, absolute paths, symlink entries, protected paths, and unsafe local-state changes. Never delete ignored or unsent files, and always re-plan against current project state before applying.
- Remote workflow workers must import artifacts into their own `FileStore` before verification or apply.

## Protocol and release changes

- For extension changes, update manifest version, content runtime version, compatibility policy, and related tests together.
- Use patch for compatible fixes, minor when both sides should update together while remaining broadly compatible, and major for intentionally incompatible contracts.
- Incompatible clients remain visible diagnostically but cannot receive ordinary commands. The exact startup `extension.reload` control path is the only compatibility bypass.

## Handoff

Run at least:

```bash
npm ci
npm run check
npm run check:quality
npm test
```

Run focused tests for the contracts you changed before the full suite. If ordinary `npm ci` fails in a restricted sandbox because `sqlite3` cannot download binaries or headers, do not keep retrying the same network-dependent install; use the available local Node headers/system SQLite build path instead.

All project Markdown documentation must be written in English. Use `CONTEXT.MD` and `ARCHITECTURE.md` for the detailed file map and subsystem-specific contracts instead of duplicating them here.
