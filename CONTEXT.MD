# Project Context

This file is intended as a high-signal orientation document for future agents and maintainers. Read it before making structural changes. `AGENT.MD` contains shorter operating instructions; this file explains the current architecture, important files, implementation constraints, and likely next steps.

## Project purpose

`chatgpt-browser-bridge-node` is a local Node.js bridge that lets local clients, an interactive CLI, and an IDE-like desktop app drive an already logged-in ChatGPT browser tab.

The project has evolved away from Playwright/CDP. The current design is:

```text
Client / CLI / IDE
  -> Express HTTP API / Codex-like RPC / interactive shell
  -> browser companion hub (`TampermonkeyHub`, legacy name)
  -> Chrome/Chromium extension background WebSocket
  -> extension content script inside chatgpt.com
  -> ChatGPT Web UI
```

Tampermonkey remains as a fallback runtime, but it is no longer the preferred path.

The old CDP/Playwright mode was removed because browser debug sessions and DOM parsing from outside the page were too fragile. The browser-side companion is the source of truth for composer actions, visible thinking, visible answer text, session/model/effort UI, attachments, artifacts, and downloads.

## Current transport model

There are now three browser companion transports routed through the same legacy-named `TampermonkeyHub`:

1. **Extension WebSocket**, preferred. The extension background service worker owns `ws://127.0.0.1:8080/tm/ws` and is not blocked by ChatGPT page CSP.
2. **Tampermonkey HTTP exchange/polling**, fallback.
3. **Userscript page WebSocket**, optional/dev path and often blocked by ChatGPT CSP.

Polling was added because ChatGPT's Content Security Policy can block `ws://127.0.0.1:8080` from the userscript/page context. The extension runtime is the production-preferred path because it avoids both CSP-blocked page WebSocket and Tampermonkey request batching delays.

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

Polling command delivery is tracked separately from prompt acceptance. For prompts, the server emits/uses a `prompt.delivered` event when the queued `prompt.send` command is drained into a polling response. `prompt.accepted` is a best-effort lifecycle event only; it must not block prompt entry, create a fatal timeout, or cancel a request. Any later event for the same request (`status`, `session.snapshot`, deltas, `done`, or `error`) is treated as implicit acceptance. If a selected tab is present in the hub but no longer polling, failures should mention command delivery rather than misleadingly saying that the userscript did not accept the prompt.

Polling heartbeat pings are deliberately not queued. The hub may flush a `ping` into an already-open long poll, but when no poll is open it skips the ping so stale heartbeat commands do not accumulate ahead of real commands such as `prompt.send`.

Request timeout semantics: `ANSWER_TIMEOUT_MS` is an idle/activity timeout, not an absolute cap on generation time. The bridge keeps a pending request alive when it receives request-scoped events (`status`, snapshots, deltas, `done`, etc.) or client lifecycle activity from the same client reporting `activeRequest.requestId` equal to the pending request id. This is required for long tasks; if pongs continue and the prompt is still active in the browser, the server must not send `prompt.cancel` just because 120 seconds elapsed.

Each ChatGPT tab must have its own userscript client id. Do not store the userscript `clientId` in origin-wide `localStorage`; that makes several tabs look like one connection and causes commands/state to be routed unpredictably. The current userscript uses per-tab storage and reports visibility/focus so interactive mode can distinguish tabs. The userscript also must be top-frame-only (`@noframes` plus runtime guard), because ChatGPT internal frames such as sentinel frames can otherwise register as bridge clients and compete with the real tab. The userscript has an additional top-window singleton guard to reduce duplicate companion instances after updates or accidental double installation.

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
3. Load/update the Chrome extension from `tools/chrome-bridge-extension` or download its setup ZIP.
4. Open `https://chatgpt.com`.
5. Use the floating Bridge panel to save server URL, Bridge token, and select `Extension WebSocket`.
6. Use `userscripts/chatgpt-bridge.user.js` only as fallback.

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

The transport hub. The name is legacy: it now owns extension and Tampermonkey browser clients, active client selection, long-poll queues, WebSocket clients, token validation, debug events, and dispatch of incoming browser-companion messages. Business logic should not be duplicated in transport adapters.

```text
src/tampermonkeyBridge.js
```

High-level bridge between API/turns/jobs and the active browser client. Handles prompt lifecycle, request mutex, pending requests, append-only answer/thinking deltas, artifacts, cancellation, file attachment command shaping, and artifact chunk reassembly.

```text
tools/chrome-bridge-extension/
```

Preferred Chrome/Chromium extension runtime. `background.js` owns the localhost WebSocket and local fetches; `content.js` interacts with ChatGPT DOM and relays payloads through `chrome.runtime.Port`.

```text
userscripts/chatgpt-bridge.user.js
```

Tampermonkey fallback companion. It provides the floating Bridge panel, runtime settings via Tampermonkey storage, HTTP-poll/WebSocket transports, composer interaction, attachment upload, model/effort selection, visible thinking/answer extraction, artifact detection, chunked artifact download, and local diagnostics.

The userscript is the most fragile part because it depends on ChatGPT UI/DOM. Keep its behavior observable and add diagnostics for selector failures.

```text
src/fileStore.js
```

Local input file/artifact storage. Supports uploads, from-path imports, artifact-from-path imports used by extension download capture, downloads, and local file metadata.

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

Interactive tab management supports `/clients`, `/select <index|clientId|clear|auto>`, `/client current`, `/client select <index|clientId>`, and `/client drop <index|clientId>`. Use indexes from `/clients` for normal manual control; use `drop` only to clear a stale/unused connection from the local hub. While readline is waiting for input, interactive mode subscribes to browser-client lifecycle events and rewrites the prompt from `bridge:not-connected>` to `bridge>` or `bridge:select-tab>` as soon as client state changes.

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
- Extension background fetch/capture for file and artifact workflows.
- Chunked artifact download back to Node for direct URLs/blob URLs.
- Browser-download artifact capture via extension `chrome.downloads`, returning the completed filename for Node import.
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
- Continue hardening artifact action-card handling for generated files that are not direct links; extension download capture now covers browser-download actions, but DOM selector drift is still possible.
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

## 2026-07-07 v4 latency fix notes

HTTP polling must not use a long-held `/tm/poll` request in Tampermonkey. In practice, long-polling can block or delay `/tm/events` POSTs in the userscript transport, causing local events to arrive 25-45 seconds late in one batch. The polling companion now requests short server polls with `timeoutMs` (default userscript `pollTimeoutMs=750`, `pollIdleDelayMs=50`). Keep this unless the transport is redesigned to a single duplex/piggyback channel or WebSocket is proven stable.

Do not let `readAssistantSnapshot()` fall back to the last pre-existing assistant message when `nodes.length <= baselineAssistantCount`. That caused new requests to complete with a stale answer before the new prompt was even sent. No new assistant node after the baseline means “no answer yet”.


## 2026-07-07 v5 polling transport note

The v4 short-poll workaround was not sufficient. In Tampermonkey/ChatGPT, a separate `/tm/events` POST can still be delayed behind the currently open polling request, causing request lifecycle events to arrive in 30-second batches even on localhost.

Polling mode now uses a single bidirectional exchange loop:

- userscript sends pending browser events in the body of `POST /tm/exchange`;
- the server processes those events immediately;
- the same response returns queued server commands;
- idle exchange may wait like long-poll, but active request exchange uses a short timeout so answer/status/done events are flushed promptly;
- queued browser events wake/abort the current exchange so a new exchange can send them immediately.

Do not reintroduce a general polling outbox that flushes through a separate `/tm/events` request as the primary delivery mechanism. `/tm/events` remains for compatibility, but the exchange channel is the default polling path.

WebSocket remains optional because ChatGPT CSP blocks `ws://127.0.0.1` by default. A development-only Chrome extension is included in `tools/chrome-csp-dev-bypass` to remove CSP headers locally and test WebSocket transport. It must not be treated as a normal user requirement.


## 2026-07-07 extension migration

The preferred browser runtime is now `tools/chrome-bridge-extension`. It is an MV3 extension with:

```text
manifest.json
background.js   WebSocket to the local bridge and local HTTP/fetch helper
content.js      ChatGPT DOM automation and floating Bridge panel
```

The server allows `chrome-extension://<id>` origins for `/tm/ws` only from local clients and only with a valid `BRIDGE_TOKEN`. `/setup` exposes an extension ZIP endpoint at `/extensions/chrome-bridge-extension.zip`.

Do not require the CSP-bypass extension for production. The extension background WebSocket replaces that workaround. The older `tools/chrome-csp-dev-bypass` remains only for experiments.

The current DOM extraction fix anchors each request to the submitted user turn (`data-turn-id` / `conversation-turn-*`) and reads the assistant turn after it. This is necessary because ChatGPT can virtualize or reorder thread text; `document.body.innerText` tail growth and assistant-node counts are not reliable.

## 2026-07-07 interactive v2 / CLI entrypoint

The CLI now behaves like an agent operator tool:

```text
bridge             starts the Ink/React interactive UI and local server
bridge --legacy    starts the old readline shell
bridge --server    starts only the HTTP/WebSocket server
```

`npm start` intentionally maps to `node src/index.js --server`. `npm run bridge` starts the default Ink UI from a checkout. `npm run interact:legacy` starts the legacy shell.

Relevant files:

```text
src/index.js              CLI/server entrypoint and mode selection
src/interactive.js        export shim
src/interactiveInk.js     default Ink/React terminal UI
src/interactiveLegacy.js  previous readline implementation and shared command handlers
```

Interactive v2 normalizes user-facing command names before calling legacy handlers. Prefer `/tabs` and `/tab` in docs/UI, but keep `/clients` and `/select` as hidden compatibility aliases. Prefer `/file` over `/attach`/`/attachments`, `/diag` over `/diagnostics`, and `/status` over `/health`.

In the new UI, plain text is always a normal ChatGPT prompt even when a project is open. Project ZIP workflows are explicit through `/task <prompt>`. This prevents accidental large project-task submissions when the user only wanted a quick chat.

The package exposes a `bridge` binary through `package.json#bin`. For local development without publishing to npm, use `npm link` from the checkout; README documents both `npm link` and `npm install -g /path/to/checkout`.


## 2026-07-07 interactive v3 rich terminal

The default `bridge` UI is now more than a readline replacement. It uses Ink panels/cards:

- bordered status header with connection state, transport, tabs, active tab, session, model, effort, files, project, and event verbosity;
- transcript cards for system/user/assistant/command/error/artifact entries;
- separate event strip for compact request lifecycle lines;
- dedicated streaming assistant panel while an answer is being produced;
- command suggestions for slash commands, Tab completion, ↑/↓ local history, Ctrl+L clear, and Ctrl+C cancel/exit.

Keep noisy diagnostics in `/diag` and debug pages. The main UI should remain readable while still showing enough request progress to understand what is happening.

Recovery flow (v11): `/recover` and `/result recover` recover from crashes/timeouts where ChatGPT completed after local state failed. The bridge sends `response.recover.latest` to the active companion; the companion reads the latest visible assistant turn, returns answer/thinking/artifacts/session; `TampermonkeyBridge.recoverLatestResponse()` stores artifacts in the artifact registry; `TurnManager.recoverTurnFromLatestResponse()` resolves ZIP artifacts through `ResultResolver`, marks the last project turn completed, and makes `/result apply` work. This is intentionally independent from pending request state.

Companion timeout note: extension/userscript no longer use `maxRequestTimeoutMs` as a hard request cap. Long Thinking / generation may run beyond the old 180s limit. Diagnostics may warn, but active requests should end only on done, explicit cancel, real client error, or server idle timeout without activity.

## v12 recovery and terminal UI notes

The recovery path can now scan recent assistant turns. The browser companion accepts `response.recover.list` and `response.recover.latest` with an `index`, returning turn keys/indexes, answer/thinking text, artifacts, and previews. The bridge exposes this as `/recover list`, `/recover <n>`, `/result recover list`, and `/result recover <n>`.

Project result recovery is intentionally broader than downloadable artifacts. `ResultResolver.resolveZip()` first tries ZIP artifacts, then reconstructs a ZIP from fenced `file:path` blocks if no ZIP artifact is available. This supports model responses that return changed files as markdown blocks instead of a browser artifact.

Manual apply is available through `/apply /path/to/result.zip` and `/result apply /path/to/result.zip`. This routes through `planZipApply()` and `applyZipToProject()` just like normal project result apply.

The rich Ink UI keeps a fixed-height command suggestion area and supports arrow-key command selection, Tab/Enter completion, full-width input, a Ctrl+C cancel/detach dialog, and a dedicated Thinking panel fed by `onThinkingUpdate`.

## v13 artifact recovery and Ink line editing notes

Artifact recovery now handles inline ChatGPT artifact buttons, not only links. Some generated ZIPs appear in assistant markdown as a normal button such as “скачать обновлённый ZIP” (`behavior-btn`) without an `href`. `collectArtifactsFromNode()` detects these buttons as action artifacts, marks ZIP/архив labels as `application/zip`, stores source turn metadata, and `artifact.fetch` clicks the matching button while extension `chrome.downloads` capture is armed.

Recent recovery candidates now merge assistant turns, assistant message roots, and artifact-bearing markdown fallback nodes. This is needed because ChatGPT virtualizes the thread and sometimes the useful downloadable action is present outside the turn list used by baseline/turn-based extraction.

The Ink UI input supports cursor editing and word/line navigation. Left/Right move one character; Ctrl+Left/Right move by word; Option+Left/Right is supported when the terminal sends ESC-b/ESC-f; Home/End, Ctrl+A/Ctrl+E, and common Cmd-arrow terminal mappings jump to start/end. Command suggestions remain a fixed three-row scroll window.
