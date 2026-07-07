# Agent Instructions

This project is a Node.js local bridge for driving a logged-in ChatGPT browser tab through a Tampermonkey companion. Before making non-trivial changes, read `CONTEXT.MD` in this repository root. It describes architecture, transports, file layout, workflows, testing, and known fragile areas.

## Core architecture

Use the current architecture:

```text
Client / CLI / IDE
  -> Express HTTP API / Codex-like RPC / interactive shell
  -> TampermonkeyHub
  -> Tampermonkey companion userscript
  -> ChatGPT Web UI
```

Do not reintroduce Playwright/CDP as the main transport. The current browser companion uses HTTP polling by default and WebSocket as an optional fallback/dev transport. Keep both transports behind shared hub logic and avoid duplicated business logic.

## Naming direction

For new IDE-facing or agent-facing features, use the Codex-like model:

```text
thread = working conversation / project session
turn   = one user request / agent run
item   = message, reasoning, assistant output, artifact, etc.
```

Legacy `/jobs` endpoints still exist, but new work should prefer `thread / turn / item` concepts unless explicitly maintaining compatibility.

## Important files

- `src/index.js` wires the server, hub, bridge, stores, managers, project service, and RPC server.
- `src/config.js` loads and auto-generates `.env` values; it has import-time side effects by design.
- `src/routes.js` contains setup, diagnostics, API, project, jobs, turns, files, artifacts, and ChatGPT routes.
- `src/tampermonkeyHub.js` owns browser clients, polling queues, WebSocket clients, active selection, and token checks.
- `src/tampermonkeyBridge.js` owns prompt lifecycle, mutex, pending requests, deltas, cancellation, and artifact handling.
- `userscripts/chatgpt-bridge.user.js` is the ChatGPT-side companion and is the most DOM-fragile component.
- `src/projectService.js` scans/packs projects and builds `PROJECT_CONTEXT.md`/snapshot ZIPs.
- `src/projectApply.js` safely applies result ZIPs back to a project.
- `src/metadataStore.js` persists jobs/threads/turns/items/events/downloads using `sqlite` + `sqlite3` with JSON fallback.
- `CONTEXT.MD` has the full project context.

## User experience constraints

Do not make the user edit constants inside the userscript. The intended setup path is:

1. Run the server.
2. Open `/setup`.
3. Install/update the userscript.
4. Open ChatGPT.
5. Configure server URL/token in the floating Bridge panel.

`API_TOKEN` and `BRIDGE_TOKEN` are intentionally separate. The app generates them into `.env` if missing.

Interactive mode should clearly guide the user when no browser agent is connected. Avoid vague request timeouts without setup/debug hints.

## Transport constraints

HTTP polling is the default because ChatGPT CSP can block localhost WebSocket connections. WebSocket should remain available, but do not make it required.

For large data:

- input files should be passed to the userscript as signed local URLs, not giant base64 WebSocket JSON;
- artifacts should be returned in chunks;
- avoid one huge JSON payload for project ZIPs or output artifacts.

## Project task workflow

Project mode packs selected project files into a ZIP with:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

The scanner respects `.gitignore`, `.ignore`, `.bridgeignore`, and default excludes. Never include obvious secrets, `.git`, `node_modules`, build output, caches, DB dumps, env files, or archives unless there is an explicit, reviewed reason.

`/ask` is for lightweight conversation and should not attach the full project ZIP. `/task` or normal text in project interactive mode runs a project task and expects a ZIP artifact result.

## Applying result ZIPs

When applying ZIP output, preserve safety:

- validate ZIP structure and paths;
- do not allow path traversal, absolute paths, or symlink entries;
- create/update files from ZIP;
- delete only files that were present in the original snapshot and missing from the result ZIP;
- never touch ignored or not-sent files;
- detect local changes after snapshot using hashes;
- ask for confirmation unless forced by a reviewed caller.

Default `/result apply` should ask one overall confirmation. Use `--interactive` only for per-change decisions.

## Testing requirements

Run before handing off changes:

```bash
npm run check
npm test
npm run test:coverage
```

The current coverage target is 70% line coverage for `src/**/*.js`. Prefer blackbox/API tests for routes and workflows. Add targeted unit tests for pure helpers. Be especially careful with inline HTML/JS in setup/diagnostics pages; test that inline scripts parse correctly.

## Development style

- Keep normal interactive output readable; put noisy diagnostics in debug streams/pages.
- Emit explicit diagnostics for ChatGPT DOM/UI selector failures.
- Treat model/effort selection as best-effort unless strict mode is requested.
- Preserve backwards compatibility where reasonable, but do not let legacy `/jobs` shape block the `thread/turn/item` direction.
- Keep security defaults local: `HOST=127.0.0.1` unless explicitly changed.
- Do not commit generated `.env` or `.bridge-data` contents.
