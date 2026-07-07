# Agent Instructions

This project is a Node.js local bridge for driving a logged-in ChatGPT browser tab through a browser companion. The preferred runtime is now the Chrome/Chromium extension; the Tampermonkey userscript remains as fallback. Before making non-trivial changes, read `CONTEXT.MD` in this repository root. It describes architecture, transports, file layout, workflows, testing, and known fragile areas.

## Core architecture

Use the current architecture:

```text
Client / CLI / IDE
  -> Express HTTP API / Codex-like RPC / interactive shell
  -> TampermonkeyHub / browser companion hub
  -> Chrome extension background WebSocket + content script
  -> ChatGPT Web UI

Fallback:
  -> Tampermonkey userscript over polling/WebSocket
```

Do not reintroduce Playwright/CDP as the main transport. The preferred browser companion is the Chrome/Chromium extension, which keeps WebSocket in the extension background service worker. Keep Tampermonkey polling/WebSocket as fallback behind the same hub logic and avoid duplicated business logic.

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
3. Load/update the Chrome extension from `tools/chrome-bridge-extension` or use the setup ZIP.
4. Open ChatGPT.
5. Configure server URL/token in the floating Bridge panel and select `Extension WebSocket`.
6. Use the Tampermonkey userscript only as fallback.

`API_TOKEN` and `BRIDGE_TOKEN` are intentionally separate. The app generates them into `.env` if missing.

Interactive mode should clearly guide the user when no browser agent is connected. Avoid vague request timeouts without setup/debug hints.

Request timeouts are idle timeouts, not hard maximum generation durations. Do not cancel an in-progress prompt merely because it has been running for `ANSWER_TIMEOUT_MS`. Any request event with the request id, plus `pong` / `page.status` / `page.changed` activity from the selected client whose `activeRequest.requestId` matches the pending request, must re-arm the idle timer. Long project tasks may run for 30+ minutes while the browser tab stays alive.

When several ChatGPT tabs are open, every tab must appear as a separate Tampermonkey client. Do not use origin-wide `localStorage` for `clientId`; that collapses tabs into one logical connection and can route prompts to the wrong page. The userscript must not run inside ChatGPT iframes (`@noframes` plus a runtime `window.top !== window.self` guard), otherwise hidden internal frames can compete for polling and overwrite tab state. Interactive mode should allow selection by `/clients` index as well as full client id. The interactive prompt should reflect live client state while waiting for input (`bridge>`, `bridge:select-tab>`, `bridge:not-connected>`), not only after the next command.

## Transport constraints

Extension WebSocket is the preferred runtime because the background service worker is not blocked by ChatGPT page CSP. HTTP polling remains available in the Tampermonkey fallback because some users may not load the extension. Page WebSocket in a userscript may be blocked by CSP and must not be required.

For polling prompts, keep command delivery separate from prompt acceptance. A queued `prompt.send` is only delivered once it is drained into `/tm/poll`. Do not gate request execution or cancellation on `prompt.accepted`: the userscript sends it as a best-effort lifecycle event, but `status: sent` or any later request event is enough to prove the userscript is alive.

Polling heartbeat commands must not accumulate in a client queue. Only flush a `ping` into an already-open long-poll; if no poll is open, skip heartbeat ping rather than queueing it ahead of real commands.

For large data:

- input files should be passed to the browser companion as signed local URLs, not giant base64 WebSocket JSON;
- extension mode should fetch signed localhost file URLs in the background/content bridge and convert them into page `File` objects;
- artifacts with direct/blob URLs should be returned in chunks;
- artifacts that trigger a real browser download should be captured by the extension background via `chrome.downloads`, then imported by Node from the completed local path;
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

`/ask` and plain text are for lightweight conversation and should not attach the full project ZIP. Project ZIP workflows must be explicit through `/task <prompt>` and expect a ZIP artifact result.

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

## 2026-07-07 v4 latency fix notes

HTTP polling must not use a long-held `/tm/poll` request in Tampermonkey. In practice, long-polling can block or delay `/tm/events` POSTs in the userscript transport, causing local events to arrive 25-45 seconds late in one batch. The polling companion now requests short server polls with `timeoutMs` (default userscript `pollTimeoutMs=750`, `pollIdleDelayMs=50`). Keep this unless the transport is redesigned to a single duplex/piggyback channel or WebSocket is proven stable.

Do not let `readAssistantSnapshot()` fall back to the last pre-existing assistant message when `nodes.length <= baselineAssistantCount`. That caused new requests to complete with a stale answer before the new prompt was even sent. No new assistant node after the baseline means “no answer yet”.


## 2026-07-07 v5 transport correction

Do not treat short-polling alone as the latency fix. The current polling companion uses `POST /tm/exchange` as the primary polling channel: browser events are piggybacked in the exchange request, and server commands are returned in the same response. This avoids a separate `/tm/events` POST being blocked behind an already-open poll in Tampermonkey.

Keep `/tm/events` for backward compatibility, but do not rely on it for normal request lifecycle delivery in polling mode. Request events should enter the polling outbox and wake the exchange loop. The exchange loop should use a long idle timeout and a short active-request timeout.

ChatGPT CSP blocks ordinary `new WebSocket('ws://127.0.0.1:...')`. The repository includes a development-only unpacked Chrome extension at `tools/chrome-csp-dev-bypass` for manually removing CSP headers to test WebSocket behavior. Do not make that extension a required production setup step.


## 2026-07-07 extension migration notes

The project now includes `tools/chrome-bridge-extension` as the preferred browser companion. The extension content script performs DOM work; the background service worker owns the WebSocket to `/tm/ws` and relays server messages/payloads. This bypasses ChatGPT page CSP and Tampermonkey HTTP/polling delays. The server accepts local `chrome-extension://<id>` WebSocket origins only when the bridge token matches.

Keep userscript and extension DOM logic aligned. The current extension `content.js` is generated/copied from `userscripts/chatgpt-bridge.user.js` with an extension compatibility prelude and default `Extension WebSocket` transport. When changing DOM automation, update both runtimes.

The answer extractor should anchor each request to the submitted user turn and read the assistant turn after it. Do not return the last pre-existing assistant message as a fallback. If generation stops but no assistant turn appears after the submitted user turn, emit a clear diagnostic/error instead of hanging indefinitely.


## Extension file/artifact handling

The extension is the preferred runtime for file and artifact workflows. Keep these responsibilities separate:

- content script: DOM automation, composer file input, artifact link/button discovery, page `blob:` fetches when needed;
- background service worker: WebSocket to localhost, signed localhost HTTP fetches, and browser-download capture through `chrome.downloads`;
- Node server: local path imports, `DATA_DIR/files`, `DATA_DIR/artifacts`, and HTTP/API download responses.

For artifact action buttons that start a browser download without exposing a URL, arm the extension download capture before clicking the DOM button. The extension should return the completed download filename; Node should copy that path into `DATA_DIR/artifacts` rather than depending on the browser download folder path later.

## 2026-07-07 interactive v2 notes

The default CLI is now `bridge`, which starts the Ink/React interactive UI and the local server together. `bridge --legacy` starts the old readline shell. `bridge --server` starts only the HTTP/WebSocket server. Keep `npm start` mapped to server-only mode for service/daemon use.

Interactive v2 should keep the command surface small and user-facing:

```text
/tabs, /tab [n|auto]
/status, /connect
/sessions, /session [n|new]
/model, /effort
/file, /files
/artifacts, /download, /open
/project, /scan, /pack, /task, /result, /apply
/stop, /clear, /help, /quit
```

Legacy aliases such as `/clients`, `/select`, `/attachments`, `/detach`, `/diagnostics`, `/health`, and `/ask` should keep working but should not dominate help text. In the new Ink UI, ordinary text is always a normal ChatGPT prompt. Project tasks are explicit via `/task <prompt>`.

The Ink UI lives in `src/interactiveInk.js`; the old readline shell lives in `src/interactiveLegacy.js`; `src/interactive.js` is a small export shim. Keep command logic reusable and avoid duplicating business logic across UIs.


## 2026-07-07 interactive v3 rich terminal notes

`src/interactiveInk.js` now renders a richer Ink UI: bordered status header, transcript cards, a separate compact event strip, command suggestions, Tab completion for slash commands, ↑/↓ local history, Ctrl+L clear, and Ctrl+C cancel/exit behavior. Keep ordinary request lifecycle noise out of transcript cards; show it in the event strip according to `/events quiet|normal|verbose`.

Do not regress to plain `console.log`-style output in the default Ink UI. Command handlers may still be shared with legacy mode, but Ink should capture their console output and render it as a command card.

Recovery requirement: project tasks must be recoverable after bridge/CLI/server crashes or request timeouts. Keep `/recover` and `/result recover` working by asking the active extension/userscript companion for the latest visible assistant turn, registering returned artifacts with `TampermonkeyBridge`, resolving ZIP output through `ResultResolver`, and updating the last project turn so `/result apply` can use it. Do not rely only on in-memory pending request state.

Companion-side request maximums must not be hard caps for active thinking/generation. `REQUEST_MAX_TIMEOUT` should not finish active requests; at most it may emit a diagnostic warning. Server-side `ANSWER_TIMEOUT_MS` remains an idle timeout.

## 2026-07-07 v12 recovery/apply/UI notes

Recovery must support more than “latest assistant turn”. Keep `/recover list`, `/recover <n>`, `/result recover list`, and `/result recover <n>` working so users can choose among recent visible assistant responses after crashes/timeouts. `/recover --apply` and `/recover <n> --apply` should resolve project results from downloadable artifacts, extension-captured browser downloads, or fenced ` ```file:path/to/file` blocks in the answer.

`/apply /path/to/result.zip` and `/result apply /path/to/result.zip` must apply a user-supplied local ZIP through the same project safety path as normal result ZIPs. Do not bypass path validation, sync planning, ignored/internal file filters, or local-change checks.

The Ink UI should keep command suggestions stable: fixed three-row suggestion area, ↑/↓ selection, Tab/Enter completion, full-width bordered input, and a Ctrl+C prompt that lets the user cancel the active ChatGPT run or detach from it. Thinking/reasoning updates should be visible in the terminal, not silently ignored.

## 2026-07-07 v13 artifact recovery and terminal input notes

Recovery must treat ChatGPT inline artifact buttons as artifact candidates even when there is no `<a href>` download URL. Current ChatGPT markup can render downloadable artifacts as `button.behavior-btn` inside assistant markdown, for example a button labelled “скачать обновлённый ZIP”. The companion should return these as `kind: "action"` artifacts with ZIP mime hints where applicable; the extension background should arm `chrome.downloads` capture before clicking them.

Recovery scans must merge recent assistant turns, assistant message roots, and artifact-bearing markdown fallback nodes. Do not rely only on `section[data-testid^="conversation-turn"]`; ChatGPT virtualization can hide or detach turn sections while the assistant message/root or markdown remains visible.

Ink input is a real line editor: preserve cursor position, support Left/Right, Backspace/Delete at cursor, Ctrl+Left/Right for word jumps, Option+Left/Right via common ESC-b/ESC-f terminal sequences, and Home/End/Ctrl+A/Ctrl+E or Cmd-arrow terminal mappings for beginning/end of line. Keep the command suggestion area fixed-height and scrollable so the UI does not jump.
