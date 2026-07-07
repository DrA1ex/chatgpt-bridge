# Project Context

This file is intended as a high-signal orientation document for future agents and maintainers. Read it before making structural changes. `AGENT.MD` contains shorter operating instructions; this file explains the current architecture, important files, implementation constraints, and likely next steps.

## Project purpose

`chatgpt-browser-bridge-node` is a local Node.js bridge that lets local clients, an interactive CLI, and an IDE-like desktop app drive an already logged-in ChatGPT browser tab.

The project has evolved away from Playwright/CDP. The current design is:

```text
Client / CLI / IDE
  -> Express HTTP API / Codex-like RPC / interactive shell
  -> TampermonkeyHub
  -> Tampermonkey companion userscript inside chatgpt.com
  -> ChatGPT Web UI
```

The old CDP/Playwright mode was removed because browser debug sessions and DOM parsing from outside the page were too fragile. The browser-side companion is the source of truth for composer actions, visible thinking, visible answer text, session/model/effort UI, attachments, artifacts, and downloads.

## Current transport model

There are two Tampermonkey transports routed through the same `TampermonkeyHub`:

1. **HTTP long-polling** via `GM_xmlhttpRequest`, default and recommended.
2. **WebSocket**, optional/dev path.

HTTP polling was added because ChatGPT's Content Security Policy can block `ws://127.0.0.1:8080` from the userscript/page context. Do not assume WebSocket will work on chatgpt.com. Treat polling as the production path.

Relevant endpoints:

```text
POST /tm/hello              userscript registers/refreshes client state
GET  /tm/poll               userscript long-polls commands from server
POST /tm/events             userscript sends events/batches to server
GET  /tm/files/:id/download userscript downloads local attachment blobs by signed token
GET  /tm/clients            API client lists connected userscript clients
POST /tm/select             select an active browser tab when several are connected
DELETE /tm/select           clear active client selection
POST /tm/stop               cancel active generation
```

WebSocket remains at:

```text
ws://127.0.0.1:8080/tm/ws?token=<BRIDGE_TOKEN>
```

Both transports must use the same hub behavior; avoid duplicating command/event logic per transport.

## Setup and security model

`src/config.js` loads `.env`, then auto-generates missing values on startup. `.env` is intentionally ignored by git.

Generated or expected values include:

```env
HOST=127.0.0.1
PORT=8080
API_TOKEN=<generated>
BRIDGE_TOKEN=<generated>
PUBLIC_BASE_URL=http://127.0.0.1:8080
```

`API_TOKEN` protects HTTP API endpoints. `BRIDGE_TOKEN` authenticates the Tampermonkey browser companion. Keep them separate: the userscript token lives in the browser and should not grant full API privileges.

The setup UX is:

1. Start the bridge.
2. Open `http://127.0.0.1:8080/setup`.
3. Install/update `userscripts/chatgpt-bridge.user.js` from the setup page.
4. Open `https://chatgpt.com`.
5. Use the userscript floating Bridge panel to save server URL, Bridge token, and transport.

Do not reintroduce a workflow where the user must edit token constants inside the userscript source.

## Runtime data

Default data directory:

```text
.bridge-data/
```

Important subareas:

```text
.bridge-data/files/        local uploaded/input files
.bridge-data/artifacts/    downloaded output artifacts
.bridge-data/projects/     per-project state and snapshot metadata
.bridge-data/metadata.sqlite or metadata.json
```

Metadata storage uses `sqlite` + `sqlite3` with async/await. It no longer uses `node:sqlite` because that produced experimental warnings. If SQLite package loading fails, `MetadataStore` falls back to JSON storage.

## Main source files

```text
src/index.js
```

Application entrypoint. Creates `EventBus`, `TampermonkeyHub`, `FileStore`, `MetadataStore`, `TampermonkeyBridge`, `ProjectService`, `ResultResolver`, `JobManager`, `TurnManager`, and `CodexRpcServer`. Starts Express and attaches Tampermonkey + Codex-like WebSocket transports. Handles `--interact`, `--debug`, `--codex-stdio`, and `--project`.

```text
src/config.js
```

Loads/generates `.env`; parses env config. Be careful here because import-time side effects write `.env` and set process env values. This is intentional.

```text
src/server.js
src/routes.js
```

Express app and all HTTP endpoints. Public setup/diagnostics/userscript endpoints are before API auth. API endpoints are protected by `API_TOKEN`. Recent bug: `/diagnostics` contained an inline script escaping issue; any inline JS should be tested/escaped carefully.

```text
src/tampermonkeyHub.js
```

The transport hub. Owns connected browser clients, active client selection, long-poll queues, WebSocket clients, token validation, debug events, and dispatch of incoming userscript messages. Business logic should not be duplicated in transport adapters.

```text
src/tampermonkeyBridge.js
```

High-level bridge between API/turns/jobs and the active browser client. Handles prompt lifecycle, request mutex, pending requests, append-only answer/thinking deltas, artifacts, cancellation, file attachment command shaping, and artifact chunk reassembly.

```text
userscripts/chatgpt-bridge.user.js
```

Tampermonkey companion. It provides the floating Bridge panel, runtime settings via Tampermonkey storage, HTTP-poll/WebSocket transports, composer interaction, attachment upload, model/effort selection, visible thinking/answer extraction, artifact detection, chunked artifact download, and local diagnostics.

The userscript is the most fragile part because it depends on ChatGPT UI/DOM. Keep its behavior observable and add diagnostics for selector failures.

```text
src/fileStore.js
```

Local input file/artifact storage. Supports uploads, from-path imports, downloads, and local file metadata.

```text
src/metadataStore.js
```

Persistent metadata for jobs, job events, downloads, threads, turns, items, and turn events. Uses SQLite async package with JSON fallback.

```text
src/eventBus.js
```

In-memory ring buffer and event stream used by diagnostics, interactive, and debug clients.

```text
src/openaiPayload.js
```

Parses OpenAI-compatible payloads and maps modern content parts (`text`, `file_id`, data URL images) into bridge requests.

```text
src/jobManager.js
src/resultResolver.js
```

Legacy/high-level job workflow. Jobs are queued, idempotent, and can require a ZIP artifact result. `ResultResolver` finds/downloads/validates output ZIP artifacts.

```text
src/turnManager.js
src/codexRpcServer.js
```

Codex-like architecture. New integrations should prefer `thread / turn / item` naming. Jobs are older REST compatibility; new IDE-facing logic should be framed as turns and items.

```text
src/projectService.js
src/zipWriter.js
```

Project-aware packaging. Scans project roots with `.gitignore`, `.ignore`, `.bridgeignore`, and default excludes. Builds lightweight project context with tree and symbol index, discovers `AGENT.md`/`AGENTS.md`, includes enabled skills, writes snapshot ZIPs, and tracks snapshot upload cache.

```text
src/projectApply.js
src/zipUtils.js
```

Safe application of ZIP results back into a project. Supports sync semantics: create/update/delete only files that were in the original snapshot; never touch ignored or not-sent files. Detects local changes after snapshot using hashes. Guards against path traversal, absolute paths, symlinks, oversized ZIPs, and unsafe folders.

```text
src/interactive.js
```

Interactive shell. Supports ordinary chat, project-aware task mode, `/ask`, `/task`, sessions, model/effort, file attach/download, artifacts, result apply/sync, diagnostics/setup commands, and project commands.

```text
src/debugClient.js
```

Separate debug/event viewer process. Keep noisy debug information out of the normal interactive terminal.

## Major HTTP APIs

Setup and diagnostics:

```text
GET /setup
GET /setup/status
GET /diagnostics
GET /userscripts/chatgpt-bridge.user.js
GET /setup/debug/stream
GET /debug/events
GET /events/stream
GET /debug/stream
```

Core browser and chat:

```text
GET  /health
GET  /tm/clients
POST /tm/select
DELETE /tm/select
POST /tm/stop
GET  /models
GET  /efforts
POST /composer/attachments/clear
POST /chat
POST /v1/chat/completions
```

Files and artifacts:

```text
GET    /files
POST   /files
POST   /files/from-path
GET    /files/:id/download
DELETE /files/:id
GET    /artifacts
GET    /artifacts/:id/download
```

Sessions / legacy conversation API:

```text
GET  /sessions
POST /sessions/new
POST /sessions/select
POST /sessions/:sessionId/messages
```

Project API:

```text
POST /projects/open
POST /projects/scan
POST /projects/pack
POST /projects/apply-zip
```

Codex-like architecture:

```text
GET  /threads
POST /threads
GET  /threads/:id
GET  /turns
POST /turns
GET  /turns/:id
GET  /turns/:id/items
GET  /turns/:id/events
GET  /turns/:id/events?stream=1
GET  /turns/:id/result/download
POST /turns/:id/interrupt
```

Legacy jobs API:

```text
GET  /jobs
POST /jobs
POST /project-jobs
GET  /jobs/:id
GET  /jobs/:id/events
GET  /jobs/:id/events?stream=1
POST /jobs/:id/cancel
GET  /jobs/:id/result
GET  /jobs/:id/artifacts
GET  /jobs/:id/result/download
```

## Codex-like protocol direction

The intended long-term integration target is an IDE that can replace or imitate Codex app-server behavior. Use compatible-ish names and architecture now:

```text
thread = conversation / project working session
turn   = one user request / agent run
item   = user message, reasoning, assistant message, artifact, etc.
```

Codex-like RPC is available at:

```text
ws://127.0.0.1:8080/codex/ws?token=<API_TOKEN>
npm run codex:stdio
```

MVP methods include:

```text
initialize
thread/list
thread/create
thread/get
thread/archive
thread/delete
turn/start
turn/get
turn/list
turn/interrupt
models/list
efforts/list
file/upload
artifact/download
project/open
project/scan
project/pack
```

Prefer extending `thread/turn/item` rather than adding new job-only concepts. Keep capabilities honest: the bridge does not run local shell commands or apply real-time file patches like Codex; its primary project-edit mechanism is ZIP-in / ZIP-out.

## Project workflow

Interactive project mode:

```bash
npm run interact -- --project /path/to/project
```

Primary user flows:

```text
/ask <question>
```

Sends a lightweight question without uploading the full project ZIP. It can include agent/skills context.

```text
/task <prompt>
```

Scans/packs project, uploads snapshot ZIP when needed, sends project task, waits for ZIP artifact result.

A normal line without `/` is treated as a project task if a project is open.

Project packaging includes:

```text
project/... original included files
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

`PROJECT_CONTEXT.md` contains file tree and lightweight regex-based symbol index with line ranges. It is intentionally approximate, not AST-perfect.

Ignore behavior:

- Load `.gitignore`, `.ignore`, `.bridgeignore` when present.
- Always apply default excludes for risky/generated content such as `.git`, `node_modules`, `dist`, `build`, caches, virtualenvs, `.env`, archives, db files, secrets-like keys.
- Respect project limits from config.

Snapshot cache:

- If the same snapshot was already uploaded in the same local thread, the next task should reuse it instead of uploading the same ZIP again.
- `/project sync` forces repack/reupload.

## Applying ZIP results

`/result apply` performs safe sync apply:

- create files present in ZIP but not local project;
- update files present in ZIP;
- delete files that were in the original snapshot but are missing from result ZIP;
- never touch ignored or not-sent files;
- never touch `.git`, `.bridge`, `node_modules` and other explicitly protected paths;
- detect local changes after snapshot using reference manifest hashes;
- ask one overall confirmation by default;
- use `/result apply --interactive` for per-file update/delete choices;
- use `/result apply --plan` to preview;
- use `/result apply --force` only after caller already reviewed risks.

The desktop/IDE client should ideally show a richer diff/preview before applying ZIPs. The bridge currently provides plan-level safety, not full patch review UI.

## Userscript constraints and known fragility

The companion runs inside ChatGPT and depends on current ChatGPT DOM and UI conventions. Important safeguards already added:

- HTTP polling default to avoid CSP-blocked localhost WebSocket.
- Floating setup/status panel with close button, loaders, status dot, and local log.
- Runtime config via Tampermonkey storage; no manual source edits.
- Event outbox batching/retry for polling events.
- Immediate/priority event path for critical events such as `prompt.accepted`.
- File attachment by signed localhost URL, not base64 in WebSocket payload.
- Chunked artifact download back to Node.
- Upload completion detection before sending prompt.
- Composer text insertion verification.
- Scoped model/effort picker search within open menu/dialog.
- Optional network hook protected by nonce and disabled by default.

Potential weak areas:

- ChatGPT DOM/selectors can change.
- Model/effort selection is best-effort and should emit clear diagnostics when not applied.
- File upload detection can still be fooled if ChatGPT changes attachment UI.
- Artifact action cards sometimes require clicking buttons to reveal actual download URLs.
- Polling can be delayed if the browser throttles background tabs; userscript should keep events observable.

## Diagnostics

Setup page:

```text
GET /setup
```

Live diagnostics page:

```text
GET /diagnostics
```

Local userscript panel contains its own recent request log. Use both the page and the panel when debugging transport problems.

Interactive commands:

```text
/setup
/diagnostics
/debug
/health
/clients
```

If no userscript tab is connected, interactive prompt should show `bridge:not-connected>` and explain setup steps rather than failing with a vague timeout.

## Testing

Run:

```bash
npm run check
npm test
npm run test:coverage
```

Coverage threshold is currently 70% line coverage for `src/**/*.js`; userscript is excluded from coverage, but userscript reliability is partly covered by behavior/string tests.

Current tests include:

- OpenAI payload parsing
- mutex
- answer state/deltas
- protocol helpers
- ZIP validation/extraction
- thread store
- project scan/pack
- safe project apply/sync semantics
- API blackbox tests
- event bus
- Tampermonkey reliability checks

Prefer blackbox/API tests for new behavior when possible, especially for routes, project packaging/apply, jobs/turns, and transport protocol. Add targeted unit tests for pure helpers.

## Important implementation principles

1. **Do not bring back Playwright/CDP as the main transport.** It was removed for reliability reasons.
2. **Keep polling and WebSocket behind the same hub.** Avoid duplicate business logic per transport.
3. **Prefer `thread / turn / item` for new work.** Keep `/jobs` mostly as compatibility/legacy REST.
4. **Do not require editing userscript source for config.** Use setup page + floating panel + GM storage.
5. **Do not send large files as one base64 JSON payload.** Use signed URLs and chunks.
6. **Keep API token and bridge token separate.** They have different trust scopes.
7. **Never apply ZIP output blindly.** Preserve ignored/not-sent files, detect local changes after snapshot, validate paths and sizes.
8. **Keep debug noise out of normal interactive output.** Use separate debug streams/pages.
9. **When changing inline HTML/JS pages, test script parsing.** A prior `/diagnostics` issue was caused by an unescaped newline in inline JS.
10. **Treat ChatGPT UI automation as best effort.** Add diagnostics rather than silently guessing.

## Likely next steps

High-priority possible improvements:

- Add a pairing flow so userscript can obtain `BRIDGE_TOKEN` with a short setup code instead of paste-copying token.
- Add richer `/diagnostics` details for active polling requests, last command, outbox length, and selector failures.
- Refactor userscript into smaller source modules and bundle it, so selector/composer/artifact extraction can have real unit tests.
- Improve model/effort discovery/verification and make strict model selection available for IDE tasks.
- Add stronger artifact action-card handling for generated files that are not direct links.
- Add optional delta snapshot uploads for project tasks instead of full ZIP reupload on every change.
- Add project result diff/manifest endpoint for IDE preview before apply.
- Expand Codex-like protocol compatibility and schemas around `thread/turn/item` events.
- Add persistent task/session summaries for IDE sidebar/history.

## Common commands

```bash
npm install
npm start
npm run interact
npm run interact -- --project /path/to/project
npm run debug
npm run codex:stdio
npm run check
npm test
npm run test:coverage
```
