# Agent Instructions

This repository is a Node.js local bridge for controlling a logged-in ChatGPT browser tab through a Chrome/Chromium extension companion. The extension WebSocket runtime is the supported path. The old userscript/HTTP-polling runtime is intentionally unsupported, although some files and route names still contain `tampermonkey` for compatibility.

Before non-trivial changes, read `CONTEXT.MD`. It is the current architecture and workflow handoff. `GOAL.MD` is the roadmap/status document and preserves the agreed future reliability phases. It is current through Phase 6 plus the v53-v72 DOM, artifact-download, compatibility, watchdog, thinking-reconciliation, apply-containment, and interactive reconnect UX reviews; do not start Phase 7+ without an explicit request. Before changing ChatGPT selectors, turn parsing, completion detection, or model/effort selection, read `docs/CHATGPT_DOM_PARSER.md`. Before changing input/output file discovery, generated-file readiness, code-block parsing, or artifact materialization, also read `docs/CHATGPT_FILES_CODE_DOM.md`.

## Operating rules

- Keep the extension runtime as the primary target. Do not revive Playwright/CDP or userscript polling as production transport.
- Use the Codex-like model for new workflow work: `thread` = project conversation, `turn` = one user request/run, `item` = message/reasoning/artifact/event.
- Project tasks must use `/task <prompt>` or the project task API. `/ask` and plain chat should not attach full project ZIPs.
- Keep request identity stable: one project task should be one local `turnId` and one bridge `requestId`.
- Existing request follow-ups must stay bound to their source browser client/tab. New prompts with a known session should prefer an idle tab already on that session, and only use another idle tab after explicit interactive confirmation.
- Automatic tab opening is opt-in (`--auto-open-tab`, `AUTO_OPEN_TAB=1`, or per-request `autoOpenTab`). It must identify the created tab by an exact one-time launch token, never by counting newly connected tabs. The live E2E runner uses a separate loopback port and passes that per-tab server URL in launch metadata. An exact token recovered from the launch URL is an allowed compatibility fallback when a stale handshake omits the field; unrelated URL/focus/timing signals are not identity. Explicit `sourceClientId` remains strict, and an actively used requested session must not be duplicated automatically.
- A required ZIP result must not complete from a stale partial answer, an unrelated READY file, or a text-only forced snapshot. Keep server-side artifact settle as a second guard even when the content script also waits for generated files; probe with bounded backoff and stop after 30 seconds post-generation.
- Keep timeout domains separate: active ChatGPT generation may be long-lived, result inactivity uses a long progress-aware watchdog, post-generation pipeline/UI waits are short and bounded, and artifact materialization has its own limit. Never reuse the short HTTP control timeout as the request lifecycle timeout.
- Generic controls such as code-block Copy buttons must never become artifact lifecycle records merely because they expose `data-state="closed"` or sit near file-like text. State-only artifacts require explicit lifecycle evidence such as `aria-busy`, `role=progressbar`, loading/spinner metadata, or generating/error semantics.
- Artifact download automation must keep direct browser/page capture as the primary path for ZIP, binary, and large files. Text-like and table artifacts may open a delayed preview. Bind the preview through exact filename identity, filename stem plus a format label, or an exact-action/unique-format proof before using any container-scoped localized aria-label fallback. Never search globally by translated action text.
- `/apply` must apply only the current selected ZIP result for the current project/session scope. Never silently reuse an older ZIP.
- `/recover <n>` treats `n` as the browser-visible candidate index printed by `/recover list`, not as a local turn id or visual ChatGPT turn number.
- Keep local security defaults: `HOST=127.0.0.1`; do not commit `.env`, `.bridge-data`, secrets, generated data, `node_modules`, or archives.
- Do not include or recreate `docs/FUNCTION_INVENTORY.MD` in handoff archives. Keep generated inventories out unless explicitly requested.

## Extension compatibility and versioning

The extension manifest version is a compatibility promise, not a build counter:

- increment patch (`0.0.x`, for example `0.2.10 -> 0.2.11`) when the new extension remains broadly compatible with the existing bridge protocol and configuration;
- increment minor (`0.x.x`, for example `0.2.x -> 0.3.0`) when compatibility is conditional, older bridge/extension combinations may misbehave, or users should update both sides together;
- increment major (`x.x.x`, for example `0.x -> 1.0.0`) when the extension/bridge contract is intentionally incompatible.

For every extension release:

- update `tools/chrome-bridge-extension/manifest.json` and the content runtime version together;
- update `src/extensionCompatibility.js` only when the minimum/recommended compatible extension or protocol changes;
- keep the handshake fields (`extensionVersion`, `clientVersion`, `extensionProtocolVersion`) and compatibility tests current;
- incompatible clients must remain visible in diagnostics but must not receive prompts or be selectable;
- use an explicit user-facing “extension update required” or “bridge update required” error instead of silently reconnecting forever.

## Important files

- `src/index.js` wires the server, hub, bridge, stores, managers, project service, and RPC server.
- `src/routes.js` contains API route wiring; diagnostics page helpers are in `src/http/diagnostics.js`.
- `src/tampermonkeyHub.js` owns connected browser clients, compatibility gating, and active selection. The name is legacy.
- `src/extensionCompatibility.js` defines bridge/extension protocol and minimum/recommended version policy.
- `src/tampermonkeyBridge.js` owns prompt lifecycle, pending requests, deltas, cancellation, artifact fetch, and source-client routing.
- `tools/chrome-bridge-extension/content.js` is the ChatGPT DOM automation layer and is the most fragile component.
- `tools/chrome-bridge-extension/domParserCore.js` contains DOM-independent lifecycle/signature helpers loaded before `content.js`.
- `docs/CHATGPT_DOM_PARSER.md` records the current observed ChatGPT turn/lifecycle DOM contract and required fallbacks. It also defines lossless leaf ownership, explicit `unknown` blocks, code-widget boundaries, and the live E2E parser transcript.
- `docs/CHATGPT_FILES_CODE_DOM.md` records the observed file, generated-artifact, and code-block DOM contract.
- `tools/chrome-bridge-extension/artifactCaptureMain.js` captures page-created Blob/data/URL download candidates in the page MAIN world.
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
For DOM-parser changes, update/add sanitized fixtures under `test/fixtures/chat-dom/`; do not “fix” a selector without preserving the semantic invariant it represents.
