# Agent Instructions

This repository is a Node.js local bridge for controlling a logged-in ChatGPT browser tab through a Chrome/Chromium extension companion. The extension WebSocket runtime is the supported path. The old userscript/HTTP-polling runtime is intentionally unsupported, although some files and route names still contain `tampermonkey` for compatibility.

Before non-trivial changes, read `CONTEXT.MD`. It is the current architecture and workflow handoff. `GOAL.MD` is the roadmap/status document and preserves the agreed future reliability phases. It is current through Phase 6 plus the v52 reliability/interactive UX review; do not start Phase 7+ without an explicit request.

## Operating rules

- Keep the extension runtime as the primary target. Do not revive Playwright/CDP or userscript polling as production transport.
- Use the Codex-like model for new workflow work: `thread` = project conversation, `turn` = one user request/run, `item` = message/reasoning/artifact/event.
- Project tasks must use `/task <prompt>` or the project task API. `/ask` and plain chat should not attach full project ZIPs.
- Keep request identity stable: one project task should be one local `turnId` and one bridge `requestId`.
- Existing request follow-ups must stay bound to their source browser client/tab. New prompts with a known session should prefer an idle tab already on that session, and only use another idle tab after explicit interactive confirmation.
- `/apply` must apply only the current selected ZIP result for the current project/session scope. Never silently reuse an older ZIP.
- `/recover <n>` treats `n` as the browser-visible candidate index printed by `/recover list`, not as a local turn id or visual ChatGPT turn number.
- Keep local security defaults: `HOST=127.0.0.1`; do not commit `.env`, `.bridge-data`, secrets, generated data, `node_modules`, or archives.
- Do not include or recreate `docs/FUNCTION_INVENTORY.MD` in handoff archives. Keep generated inventories out unless explicitly requested.

## Important files

- `src/index.js` wires the server, hub, bridge, stores, managers, project service, and RPC server.
- `src/routes.js` contains API route wiring; diagnostics page helpers are in `src/http/diagnostics.js`.
- `src/tampermonkeyHub.js` owns connected browser clients and active selection. The name is legacy.
- `src/tampermonkeyBridge.js` owns prompt lifecycle, pending requests, deltas, cancellation, artifact fetch, and source-client routing.
- `tools/chrome-bridge-extension/content.js` is the ChatGPT DOM automation layer and is the most fragile component.
- `tools/chrome-bridge-extension/background.js` owns extension WebSocket relay, signed localhost fetches, and browser-download capture.
- `src/turnManager.js` owns threads/turns/items and normal result pipeline convergence.
- `src/resultResolver.js` selects/downloads/validates ZIP results and emits result events.
- `src/interactiveLegacy.js` owns project interactive commands, selected result state, recovery, and apply orchestration. Ink calls into this layer.
- `src/projectService.js` scans/packs project snapshots. Helpers live under `src/project/service/`.
- `src/project/apply/` contains apply path policy, reference normalization, safety, planning, and execution.
- `src/metadataStore.js` persists jobs/threads/turns/items/events/downloads using SQLite with JSON fallback.

## Project ZIP contract

Input project snapshots are sent as:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

Returned ZIP artifacts must put project files at the archive root, for example `package.json` and `src/index.js`, not `project/package.json`. The apply fallback may treat a single `project/` folder as the returned root, but metadata/protected paths such as `.bridge`, `.git`, `node_modules`, build output, caches, env files, databases, and archives must not be applied.

## Apply safety

Preserve these checks:

- validate ZIP paths and reject traversal, absolute paths, and symlink entries;
- write only allowed project files;
- sync-delete only files present in the original snapshot and missing from the result ZIP;
- never touch ignored/internal/not-sent files;
- detect local changes after snapshot;
- ask for confirmation unless a caller explicitly uses a safe auto-apply path or `--force`.

`lastAppliedTurnId` and `lastAppliedFileId` are only logging/cleanup hints. They must not skip fresh planning.

## Tests before handoff

Run at least:

```bash
npm install
npm run check
npm test
```

`npm run test:coverage` currently reports line coverage below the configured 70% threshold because large interactive/RPC surfaces are undercovered. Run it when changing coverage-sensitive areas, but do not claim it passes unless it has been verified in the current tree.

Add regression tests for any bug fixed. Prefer blackbox/API tests for routes and workflow behavior, and targeted unit tests for pure helpers.
