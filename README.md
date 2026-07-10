# ChatGPT Browser Bridge — Node.js + Browser Extension

Local HTTP/OpenAI-compatible bridge for a logged-in ChatGPT browser tab.

The supported browser runtime is the Chrome/Chromium extension. It keeps the localhost WebSocket in the extension background service worker, bypassing ChatGPT page CSP and avoiding the old Tampermonkey polling/userscript path. The old Playwright/CDP mode and the Tampermonkey userscript fallback are not supported. Some internal class and route names still contain `tm`/`Tampermonkey` for compatibility, but new work should target the extension runtime only.

```text
Client / CLI → Express API → browser companion hub → extension background WebSocket → content script → ChatGPT Web UI
```

## What is included

- Conversation/session API: `GET /sessions`, `POST /sessions/new`, `POST /sessions/select`, `POST /sessions/:id/messages`
- File upload API: `POST /files`, `POST /files/from-path`, `GET /files/:id/download`
- Output artifact API: `GET /artifacts`, `GET /artifacts/:id/download`
- Model/effort best-effort UI selection per prompt
- Model/effort option discovery from the ChatGPT UI when available
- Normalized chat event stream for prompt lifecycle, files, sessions, thinking, answer and artifacts
- `GET /health`, `GET /tm/clients`, `POST /tm/select`, `POST /tm/stop`, `GET /debug/events`
- `POST /chat`, `POST /v1/chat/completions`, and OpenAI-compatible streaming/non-streaming response shapes
- OpenAI-compatible multimodal-ish input parts for text, `file_id` and data-URL `image_url`
- SSE streaming for `/chat?stream=1`
- `bridge` interactive terminal UI (Ink/React), with `bridge --legacy` readline fallback and `bridge --server` server-only mode
- Session-aware automatic tab targeting, with confirmation before reusing an idle tab on another session
- Cancellation from HTTP disconnects, `/tm/stop`, interactive `/stop`, and Ctrl+C in interactive mode
- Sequential request lock so prompts do not overlap in one ChatGPT tab
- Chrome/Chromium extension companion with background WebSocket transport
- DOM streaming from inside the ChatGPT page
- Input file attachment through the ChatGPT composer file input
- Output artifact/image/file link discovery and browser-side download capture through the extension
- Structured Markdown extraction for paragraphs, headings, code blocks, lists, blockquotes and tables
- Diagnostic event buffer for troubleshooting
- Experimental network-stream hooks for explicit delta-style internal events
- systemd service for the Node bridge
- unit tests for payload parsing, request locking, protocol deltas, terminal input, recovery and interim answer detection

## Requirements

- Node.js 20+
- npm
- Chrome/Chromium browser for the extension runtime
- Logged-in ChatGPT session at `https://chatgpt.com`

Chromium remote debugging, Playwright, and Tampermonkey are no longer required.

## Install

```bash
mkdir -p ~/chatgpt-bridge-node
cd ~/chatgpt-bridge-node
npm install
# No .env file is required for first start; the bridge creates ~/.bridge-data/.env.
```

Start the server without interactive UI:

```bash
npm start
# or, after linking the CLI:
bridge --server
```

Default server:

```text
http://127.0.0.1:8080
```

The server loads `~/.bridge-data/.env` automatically by default. On first startup it creates `~/.bridge-data/.env` if needed and writes stable `API_TOKEN`, `BRIDGE_TOKEN`, `HOST`, `PORT`, `PUBLIC_BASE_URL`, and `DATA_DIR`. You can override the env file path with `ENV_FILE=/path/to/file`.

## Security defaults

The default bind host is now:

```env
HOST=127.0.0.1
```

Keep it that way unless you intentionally expose the bridge to a trusted LAN. If you set `HOST=0.0.0.0`, use a strong `API_TOKEN` and firewall the port.

When `API_TOKEN` is set, HTTP endpoints require:

```text
Authorization: Bearer <API_TOKEN>
```

The browser extension uses a separate `BRIDGE_TOKEN`. It is intentionally separate from `API_TOKEN`: the browser agent does not need full API access. Paste the Bridge token once into the floating Bridge panel on the ChatGPT page.

## Install and configure the browser companion

Start the bridge and open the setup page:

```text
http://127.0.0.1:8080/setup
```

Extension setup:

```text
chrome://extensions → Developer mode → Load unpacked → tools/chrome-bridge-extension
```

Alternatively download the extension ZIP from `/setup`, unzip it, and load the unpacked folder. Then open or reload:

```text
https://chatgpt.com/
```

A small `Bridge` tab appears near the bottom-right corner. Click it, paste the `BRIDGE_TOKEN` from `/setup`, keep `Extension WebSocket`, and press `Save & Connect`. In this mode the WebSocket is owned by the extension background worker, not by the ChatGPT page, so ChatGPT CSP does not block `ws://127.0.0.1`.

The extension also owns privileged browser operations that were unreliable or impossible in a userscript: fetching signed localhost file URLs outside page CSP, capturing browser downloads created by ChatGPT artifact buttons through `chrome.downloads`, and returning the completed local download path to the Node bridge so Node can import the file into `DATA_DIR/artifacts`.

Legacy userscript polling endpoints are intentionally disabled with HTTP 410. Keep using the Chrome/Chromium extension.

Check connection:

```bash
export API_TOKEN=some-long-random-local-api-token
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/health | jq
```

Expected shape when exactly one extension tab is connected:

```json
{
  "ok": true,
  "transport": "extension:extension",
  "clients": 1,
  "selectedClientId": "",
  "needsSelection": false,
  "activeClient": {
    "url": "https://chatgpt.com/"
  }
}
```

## Multiple ChatGPT tabs

For a prompt with a known ChatGPT session, the bridge first chooses an idle connected tab already on that session. If no such tab exists, interactive mode may offer an idle fallback tab and asks before switching it to the requested session. Busy tabs are never reused. If several idle fallback tabs are available, select one explicitly.

List clients:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/tm/clients | jq
```

Select a tab:

```bash
curl -X POST http://127.0.0.1:8080/tm/select \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"tm-..."}'
```

Clear explicit selection:

```bash
curl -X DELETE http://127.0.0.1:8080/tm/select \
  -H "Authorization: Bearer $API_TOKEN"
```

You can also set a persistent default in `.env`:

```env
ACTIVE_CLIENT_ID=tm-...
```

Usually it is better to leave `ACTIVE_CLIENT_ID` empty. For a prompt with a known session, the bridge first chooses an idle tab already on that session. If it must reuse and switch another idle tab, interactive mode asks for confirmation. Busy tabs are never reused. Client ids are browser-profile local and may change if extension/site data is cleared.

## CLI and interactive mode

The package exposes a `bridge` CLI. The default mode is the new Ink/React interactive terminal UI:

```bash
npm run interact
# after linking/installing the command:
bridge
```

The old readline shell is still available when needed:

```bash
bridge --legacy
# or from the checkout:
npm run interact:legacy
```

Run only the local HTTP/WebSocket server, without terminal UI:

```bash
bridge --server
# or:
npm start
```

This mirrors the common CLI split used by agent tools: `bridge` is the operator UI, while `bridge --server` is the daemon/server process. Interactive mode still starts the local HTTP server internally because the extension background worker connects to its localhost HTTP/WebSocket endpoints.

### Installing the `bridge` command locally

For normal development from a checkout, use `npm link`. This does not require publishing the package to npm:

```bash
cd /path/to/chatgpt-browser-bridge-node
npm install
npm link
bridge
bridge --legacy
bridge --server
```

This creates a global symlink from the `bridge` command to the local checkout. Changes to files in the checkout are picked up immediately on the next run.

To remove the development command later:

```bash
npm unlink -g chatgpt-browser-bridge-node
```

Alternative without global linking:

```bash
npm run interact
npm run interact:legacy
npm run server
```

If you install from a local folder into another project instead of using `npm link`, use:

```bash
npm install -g /path/to/chatgpt-browser-bridge-node
bridge
```

### Interactive UI

The new UI is an Ink/React terminal app rather than a plain readline prompt. It keeps an append-only transcript for prompts, answers, and compact task milestones. Current activity/thinking/progress/answer output is rendered in one terminal-height-bounded live panel so spinner updates do not redraw old scrollback. Raw lifecycle events are hidden unless verbose debug mode is enabled. Ordinary text is sent as a normal ChatGPT prompt; slash commands control the shell.

Keyboard controls:

```text
Enter       submit the current line
Tab         autocomplete slash commands
↑ / ↓       browse local command/message history
Ctrl+C      cancel active request; press again when idle to exit
Ctrl+L      clear the transcript
```

The input box shows command suggestions only after the input has been edited or the cursor moved; browsing a slash command from history does not activate completion, so ↑/↓ continues through history. `/events normal` keeps compact user-facing milestones in the live panel/transcript, while `/events verbose` additionally shows the raw debug event strip. Raw browser/page diagnostics remain available through `/diag`.

Common flow:

```text
> /tabs
> /tab 2
> /sessions
> /session 3
> /model list
> /model 1
> /effort high
> /file ./report.pdf
> Analyze this file and create a result file
> /artifacts
> /download 1 ./result.xlsx
> /open 1
```

Primary commands:

```text
Messages:
  <text>                 send a normal ChatGPT prompt
  /task <text>           run a project task with project ZIP context
  /resume                attach to a prompt already running in the active tab
  /stop                  cancel active request

Connection:
  /status                bridge status
  /connect               setup URL, token and diagnostics
  /tabs                  list connected browser tabs
  /tab [n|auto]          show/select current tab

Session:
  /sessions              list visible ChatGPT sessions
  /session [n|new]       show/select/create session

Model:
  /model [n|name|default|list]
  /effort [value|default|list]
  /events [quiet|normal|verbose]

Files:
  /file [path]           show queued files or attach a path
  /file clear            clear queued files
  /file remove <n|id>    remove queued file
  /files                 list local stored files

Artifacts:
  /artifacts             list known artifacts
  /download <n|id> [path]
  /open <n|id>

Project:
  /project [path]        show or open project
  /scan                  scan project
  /pack                  create/reuse project snapshot
  /result                show last project result
  /apply [--plan|--force|--interactive]

System:
  /setup                 setup URL
  /diag                  diagnostics URL
  /clear                 clear terminal log
  /help                  compact help
  /quit                  exit
```

Hidden compatibility aliases still work: `/ask`, `/clients`, `/select`, `/attachments`, `/detach`, `/diagnostics`, `/health`. They are intentionally omitted from the main help so the day-to-day command surface stays small.

During an active answer, press Ctrl+C or use `/stop` to cancel the current request. Press Ctrl+C again when no request is active to leave interactive mode.

Use `/events quiet` when you only want answers, `/events normal` for compact user-facing milestones, and `/events verbose` to additionally show the bounded debug event strip.

## HTTP API

Simple chat endpoint:

```bash
curl -X POST http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

Response:

```json
{
  "response": "..."
}
```

Streaming chat endpoint:

```bash
curl -N -X POST 'http://127.0.0.1:8080/chat?stream=1' \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

The stream uses named SSE events:

```text
event: thinking
event: message
event: artifacts
event: done
event: error
```

`message` and `thinking` events are append-only deltas when possible. The `done` event carries the authoritative full final response. Replacement-style DOM rewrites are intentionally not emitted as stream chunks.

If the HTTP/SSE client disconnects, the bridge sends `prompt.cancel` to the source extension tab and tries to press ChatGPT's stop button.

## Conversation/session API

The bridge treats each connected ChatGPT browser tab as a client and ChatGPT conversations as sessions. Sessions are discovered from the current page and visible sidebar links that the extension content script can read.

List sessions:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/sessions | jq
```

Open a new session:

```bash
curl -X POST http://127.0.0.1:8080/sessions/new \
  -H "Authorization: Bearer $API_TOKEN"
```

Select an existing session by id:

```bash
curl -X POST http://127.0.0.1:8080/sessions/select \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<chatgpt-conversation-id>"}'
```

Send a message to a session:

```bash
curl -X POST http://127.0.0.1:8080/sessions/<chatgpt-conversation-id>/messages \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Continue from here"}'
```

You can also pass session options directly to `/chat`:

```json
{
  "newSession": true,
  "message": "Start a new chat and answer briefly"
}
```

or:

```json
{
  "sessionId": "<chatgpt-conversation-id>",
  "message": "Continue this chat"
}
```

## Model and effort selection

Per request, the bridge can try to select a model and effort/reasoning mode in the ChatGPT UI before sending the prompt. The interactive shell can also ask the active tab for visible model/effort options with `/model list` and `/effort list`. HTTP clients can call `GET /models` and `GET /efforts`.

```bash
curl -X POST http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"GPT-5.5 Thinking",
    "effort":"high",
    "message":"Solve this carefully"
  }'
```

Accepted effort values are free-form, but these are normalized in the extension content script: `auto`, `instant`, `low`, `medium`, `high`, `xhigh`, `thinking`.

This is intentionally best-effort because ChatGPT model-picker markup changes. The content script opens `[data-testid="composer-intelligence-picker-content"]`, reads effort choices from its visible `menuitemradio` entries, opens the nested model submenu, and reads models separately. `aria-checked`/`data-state` identify the selected values; model annotations are preserved in `rawText`/`annotation`. If this semantic structure disappears, the command returns `DOM_SCHEMA_CHANGED` rather than guessing from the composer button label. Prompt submission remains non-blocking unless strict model selection was explicitly requested.

## Files and input attachments

The main file flow is:

```text
POST /files → receive file.id → pass file id in /chat attachments → extension attaches the file in ChatGPT composer → prompt sends
```

Upload a small/medium file as JSON:

```bash
base64 -i report.pdf | tr -d '\n' > /tmp/report.b64
curl -X POST http://127.0.0.1:8080/files \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "name":"report.pdf",
  "mime":"application/pdf",
  "contentBase64":"$(cat /tmp/report.b64)"
}
JSON
```

Import a file from a local server path:

```bash
curl -X POST http://127.0.0.1:8080/files/from-path \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"/Users/me/report.pdf","mime":"application/pdf"}'
```

Send a prompt with attachments:

```bash
curl -X POST http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message":"Summarize this file and list any risks",
    "attachments":["file_..."]
  }'
```

You can also pass inline attachments:

```json
{
  "message": "Analyze this CSV",
  "attachments": [
    {
      "name": "data.csv",
      "mime": "text/csv",
      "contentBase64": "..."
    }
  ]
}
```

OpenAI-compatible input supports `file_id` and base64 data-URL images in content parts:

```json
{
  "model": "chatgpt",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

## Output artifacts, files and images

The browser companion inspects the final assistant message for file links, download links, large images and canvas/artifact actions. With the extension runtime, artifact buttons that trigger a real browser download are captured through `chrome.downloads`; the extension reports the completed local path back to Node, and Node imports the file under `DATA_DIR/artifacts`. `/chat` responses include an `artifacts` array:

```json
{
  "response": "...",
  "artifacts": [
    {
      "id": "artifact_...",
      "kind": "image",
      "name": "image",
      "mime": "image/png",
      "downloadUrl": "blob:https://chatgpt.com/..."
    }
  ]
}
```

List known artifacts:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/artifacts | jq
```

Download an artifact through the active ChatGPT tab:

```bash
curl -L http://127.0.0.1:8080/artifacts/artifact_.../download \
  -H "Authorization: Bearer $API_TOKEN" \
  -o artifact.bin
```

The download is browser-side. Node asks the extension content script to fetch direct URLs or click artifact actions. Direct `blob:`/authenticated URLs are returned as chunked base64; browser downloads are captured by the extension background worker and returned as a completed local file path, which Node copies into `DATA_DIR/artifacts`. In interactive mode, `/open <index|artifactId>` downloads the artifact if needed and opens it with the OS default app (`open`, `xdg-open`, or Windows `start`).

## Normalized event model

`/chat?stream=1` now emits both compatibility events and normalized lifecycle events.

Compatibility events:

```text
event: thinking   # visible thinking/reasoning delta
event: message    # assistant answer delta
event: artifacts  # latest artifact list
event: done       # authoritative final response object
event: error
```

Normalized event frames use `event: event` and carry a typed payload:

```json
{
  "type": "files.attach.started",
  "requestId": "...",
  "time": "...",
  "count": 1
}
```

Common normalized event types:

```text
request.started
prompt.accepted
session.snapshot
session.select.started
session.select.done
model.apply.started
model.apply.done
files.attach.started
files.attach.changed
files.attach.done
prompt.sent
generation.started
generation.stopped
thinking.snapshot
answer.snapshot
artifact.snapshot
request.done
request.error
```

Manual stop endpoint:

```bash
curl -X POST http://127.0.0.1:8080/tm/stop \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual stop"}'
```

## OpenAI-compatible endpoint

Non-streaming:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"chatgpt",
    "messages":[
      {"role":"user","content":"Hello"}
    ]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"chatgpt",
    "stream":true,
    "messages":[
      {"role":"user","content":"Hello"}
    ]
  }'
```

Visible thinking text is sent as:

```json
{"delta":{"reasoning_content":"..."}}
```

The assistant answer is sent as:

```json
{"delta":{"content":"..."}}
```

The OpenAI-compatible stream is append-only and ends with:

```text
data: [DONE]
```

If ChatGPT rewrites already-rendered DOM text, the bridge keeps the final text internally but does not emit a replacement chunk in the OpenAI stream. This avoids breaking parsers that expect append-only SSE.

## Events and diagnostics

For browser-extension diagnostics, open:

```text
http://127.0.0.1:8080/diagnostics
```

This page is localhost-only and does not require the API token. It shows setup/client state and a live debug stream, which is useful while pressing `Test` or `Save & Connect` in the extension Bridge panel.

The server also has two API SSE streams. `/events/stream` is the normalized product event stream, suitable for another UI or a lightweight monitor:

```bash
curl -N -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/events/stream
```

`/debug/stream` is for protocol and extension/content-script diagnostics:

```bash
npm run debug
# or raw JSON
npm run debug -- --raw
```

You can also watch normalized events in a second terminal:

```bash
npm run debug:events
```

Recent debug events are kept in a ring buffer:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/debug/events | jq
```

Interactive mode has a snapshot command too:

```text
/debug
/debug 50
```

Normalized user events include:

```text
request.started
prompt.accepted
session.snapshot
model.apply.started
model.apply.done
files.attach.started
files.attach.done
generation.started
generation.stopped
thinking.snapshot
answer.snapshot
artifact.snapshot
artifact.download.started
artifact.download.done
request.done
request.error
```

Debug events include lower-level protocol and extension/content-script diagnostics such as:

```text
composer.found
composer.not_found
send_button.found
send_button.not_found_keyboard_fallback
network.parser.matched
protocol.out.prompt.send
```

Debug output is intentionally truncated. It is meant to show where a request failed without dumping full private prompts, full answers, base64 files, or large DOM snapshots into logs.

## How the browser companion works

The supported companion is split between the extension background worker and the ChatGPT-page content script:

1. The background worker owns the authenticated localhost WebSocket, reconnects it, fetches signed localhost attachment URLs, and captures completed browser downloads.
2. The content script receives `prompt.send`, switches to the requested ChatGPT session when needed, drives the composer, and observes the current request DOM.
3. The background worker relays commands and events between the source tab and the Node bridge. Follow-up operations remain bound to the request's source client/tab.

There are two observation layers.

The authoritative layer is DOM-based. A `MutationObserver` is scoped to `main`/`[role=main]` and rereads normalized state after each coalesced mutation. The parser anchors the submitted user turn to the following assistant turn, treats visible reasoning/tool/status blocks separately, and extracts the final answer only from `[data-message-author-role="assistant"]`. This prevents persistent Python/tool output siblings from being mixed into final Markdown.

Completion is not inferred from quiet text or a network stream ending. The final author node must exist, Stop must be absent, the response action bar must be visible, the structural signature must remain stable for at least 1500 ms, no tool/Continue/confirmation/error state may be active, and the conversation id must still match the requested session. Transient reasoning summaries are streamed before React replaces them and are cleared from the live UI while retained in response history.

The observed DOM contract and parser invariants are documented in `docs/CHATGPT_DOM_PARSER.md`. Selector changes should be accompanied by sanitized phase fixtures under `test/fixtures/chat-dom/`.

An experimental page-context network hook may emit conservative delta candidates from response streams. DOM snapshots remain the source of truth for the final answer and artifact list.

Hidden internal reasoning that is not visible in the ChatGPT page is not exposed.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind host |
| `PORT` | `8080` | HTTP/WebSocket port |
| `API_TOKEN` | empty | If set, required for all HTTP API/debug endpoints |
| `ACTIVE_CLIENT_ID` | empty | Optional fixed browser-extension client/tab id |
| `BRIDGE_TOKEN` | generated into `.env` on first startup | Token required by the browser extension companion |
| `TM_TRANSPORT` | compatibility-only | Legacy userscript setting; the supported runtime is the extension background WebSocket |
| `TM_POLL_TIMEOUT_MS` | `25000` | Legacy disabled-polling compatibility setting; not used by the supported extension runtime |
| `ALLOWED_ORIGINS` | `https://chatgpt.com,https://chat.openai.com,null` | Accepted WebSocket origins when WS transport is used |
| `PAYLOAD_DEBUG` | `0` | Enable `/v1/chat/completions` payload dump |
| `PAYLOAD_DEBUG_FILE` | `./last_openclaw_payload.json` | Debug dump path when `PAYLOAD_DEBUG=1` |
| `ANSWER_TIMEOUT_MS` | `120000` | Compatibility/default meaningful-progress timeout used when `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` is not set. Weak heartbeat does not reset it. |
| `ANSWER_SETTLE_MS` | `1500` | How long answer text must stay stable before done |
| `ANSWER_DONE_SETTLE_MS` | `600` | Shorter settle window after generation appears idle |
| `PROMPT_ACCEPTED_TIMEOUT_MS` | `10000` | Max wait for the extension content script to accept a prompt command |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Server ping interval for connected extension tabs; heartbeat is hard liveness, not meaningful request progress |
| `CLIENT_STALE_MS` | `30000` | Disconnect stale browser companion clients |
| `REQUEST_WATCHDOG_INTERVAL_MS` | `5000` | Interval between pending-request watchdog checks |
| `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` | `120000` | Fail/recover a non-generating request after no meaningful progress; heartbeat alone does not reset this |
| `REQUEST_HARD_LIVENESS_TIMEOUT_MS` | derived | Detect source tab/content-script disconnection from heartbeat age |
| `REQUEST_GENERATION_ACTIVITY_GRACE_MS` | `30000` | Short grace after the last current generation signal; historical `sawGenerating` is not enough |
| `FORCED_SNAPSHOT_AFTER_MS` | `90000` | Request a source-bound assistant snapshot after stalled meaningful progress |
| `FORCED_SNAPSHOT_COOLDOWN_MS` | `60000` | Minimum delay between automatic forced snapshots |
| `FORCED_SNAPSHOT_TIMEOUT_MS` | `30000` | Timeout for one source-bound forced snapshot command |
| `DEBUG_EVENTS_LIMIT` | `250` | In-memory diagnostic event buffer size |
| `JSON_BODY_LIMIT` | `50mb` | Express JSON body size limit for prompts and base64 file uploads |
| `DATA_DIR` | `~/.bridge-data` | Local storage for uploaded files, downloaded artifacts, metadata, config, and interactive state |

## systemd

Assuming the project is located at `~/chatgpt-bridge-node`:

```bash
sudo cp systemd/chatgpt-bridge-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chatgpt-bridge-node
sudo systemctl start chatgpt-bridge-node
journalctl -u chatgpt-bridge-node -f
```

Open `/setup` and paste the displayed `BRIDGE_TOKEN` into the extension Bridge panel. Keep `API_TOKEN` stable for clients that call the HTTP API.

## Troubleshooting

If `/health` says no client is connected:

- Reload `https://chatgpt.com/`.
- Check that the unpacked Chrome/Chromium extension is enabled.
- Check that `CONFIG.wsUrl` points to the right port.
- Open the floating `◈ Bridge` panel and check status.
- Make sure Server URL points to `http://127.0.0.1:8080`.
- Make sure the Bridge token matches `/setup`.
- Keep `Extension WebSocket` selected; the background worker owns localhost WebSocket transport and is not blocked by page CSP.
- Check `/debug/events` for `hello`, `page.status`, and diagnostic entries.

If `/health` says `needsSelection: true`:

- Run `/clients` in interactive mode, or call `GET /tm/clients`.
- Select the intended tab with `/select <clientId>` or `POST /tm/select`.

If the bridge rejects HTTP requests:

- Check the `Authorization: Bearer <API_TOKEN>` header.
- Check that your shell exported the same `API_TOKEN` as `.env`.

If the bridge rejects the extension connection:

- Check that the Bridge token in the floating panel matches `BRIDGE_TOKEN` from `/setup`.
- Check that Server URL points to the same host and port as the running bridge.
- Reload the extension and ChatGPT tab after changing extension files.
- Check `/diagnostics` or `/debug/events` for authentication, WebSocket, and `client.ready` errors.

If a manually attached file chip remains in the composer:

- Use `/attachments clear-ui` in interactive mode, or call `POST /composer/attachments/clear`.
- This is best-effort: it clicks visible remove/close buttons inside the composer area and avoids deleting local bridge files.

If prompt insertion fails:

- Make sure you are logged in.
- Make sure the ChatGPT composer is visible and not blocked by a modal, CAPTCHA, or interstitial.
- Try clicking the ChatGPT tab once and then retrying.
- Check `/debug/events` for `composer.not_found`, `send_button.found`, or `send_button.not_found_keyboard_fallback`.

If stream output misses part of the answer:

- `/chat?stream=1` still sends the authoritative full final answer in the `done` event.
- `interactive` prints a clean `Final answer` block when live output drifted.
- OpenAI-compatible streams are append-only by design, so they do not send replacement chunks.

## Test coverage

Run the blackbox and unit test suite:

```bash
npm test
```

Run coverage with the current core/API threshold:

```bash
npm run test:coverage
```

The coverage script uses Node's built-in test runner with `--experimental-test-coverage` and enforces `--test-coverage-lines=70` for `src/**/*.js`. The current tree's functional tests pass, but aggregate line coverage remains below that threshold; coverage of the large interactive/RPC surfaces is tracked as explicit test debt rather than hidden as a passing check.

## Notes and limitations

The bridge automates the ChatGPT Web UI, so it can still break if ChatGPT changes the page structure. The extension background/content-script architecture avoids fragile Chromium debug sessions and page-CSP WebSocket failures, but it is not equivalent to the official OpenAI API.

The OpenAI-compatible endpoint still forwards the last user message as the main prompt, but it now also extracts file ids and data-URL images from modern multimodal content parts. System messages, tool calls and structured output schemas are not implemented.

## Job API for desktop automation

For desktop clients, prefer the job API over a long blocking `/chat` request. A job is durable metadata around a ChatGPT request: input files, session/model/effort, normalized events, artifacts, result resolution, and final status.

The metadata store uses the async `sqlite` + `sqlite3` packages and creates `DATA_DIR/metadata.sqlite`. If the SQLite package cannot be loaded in the current runtime, the bridge falls back to `metadata.json` so the API still starts. File and artifact bytes still live in the existing `DATA_DIR/files` and `DATA_DIR/artifacts` directories.

### Generic jobs

Create a queued job:

```bash
curl -X POST http://127.0.0.1:8080/jobs \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: desktop-task-123" \
  -d '{
    "message": "Analyze the attached archive and return a zip artifact with changes.",
    "attachments": ["file_..."],
    "model": "GPT-5.5 Thinking",
    "effort": "high",
    "sessionPolicy": "new_per_job",
    "output": { "expected": "zip", "required": true }
  }'
```

The response is immediate:

```json
{
  "ok": true,
  "job": { "id": "job_...", "status": "queued" },
  "eventsUrl": "/jobs/job_.../events",
  "resultUrl": "/jobs/job_.../result"
}
```

Use `Idempotency-Key` when a desktop client may retry after a local/network failure. If a job with the same key already exists, the bridge returns the original job instead of submitting the same prompt twice.

Useful endpoints:

```text
GET  /jobs
POST /jobs
GET  /jobs/:id
GET  /jobs/:id/events
GET  /jobs/:id/events?stream=1
POST /jobs/:id/cancel
GET  /jobs/:id/result
GET  /jobs/:id/artifacts
GET  /jobs/:id/result/download
```


Project-aware clients can also ask the bridge to apply a ZIP file to a project folder:

```text
POST /projects/apply-zip
```

Payload:

```json
{
  "cwd": "/path/to/project",
  "fileId": "file_or_artifact_id",
  "dryRun": true,
  "sync": true,
  "referenceManifest": {
    "files": [{ "path": "src/index.js" }, { "path": "package.json" }]
  }
}
```

Use `dryRun: true` or `applyMode: "plan"` to get the git safety report and the full synchronization plan: files to create, update, delete, leave unchanged, and skip. With `sync: true`, files that existed in the original snapshot manifest but are absent from the result ZIP are deleted. Files that were ignored or never sent are not touched. A normal update is not treated as a conflict. A conflict means the local file changed after the snapshot was sent, detected by comparing the current file hash with `referenceManifest.files[].sha256`. Without `force: true`, the endpoint returns `409 requiresConfirmation` when there are git safety warnings or local changes after snapshot. With `force: true`, it validates and applies the ZIP. For preview/selection UIs, pass `selectedWritePaths` and `selectedDeletePaths` to apply only selected updates/deletes.

Job status values:

```text
queued
running
done
failed
cancelled
```

The job runner is single-lane by design because one ChatGPT tab can reliably run one generation at a time. New jobs are queued and executed in order.

### Project zip jobs

`/project-jobs` is the high-level endpoint intended for a desktop “small Codex” workflow:

1. desktop client zips the selected project files;
2. desktop client uploads the zip through `/files` or `/files/from-path`;
3. desktop client creates a `/project-jobs` task;
4. bridge sends the zip to ChatGPT and asks for a downloadable zip artifact;
5. bridge downloads and validates the resulting zip;
6. desktop client downloads `/jobs/:id/result/download` and applies it to the project folder.

Example:

```bash
curl -X POST http://127.0.0.1:8080/project-jobs \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-app-dnd-001" \
  -d '{
    "projectName": "my-app",
    "inputFileId": "file_project_zip",
    "message": "Add drag-and-drop support and update tests.",
    "model": "GPT-5.5 Thinking",
    "effort": "high",
    "sessionPolicy": "new_per_job",
    "result": { "format": "zip", "required": true }
  }'
```

The bridge generates a strict project prompt internally. It tells ChatGPT to inspect the attached project archive, preserve the project structure, exclude `node_modules`, `.git`, `dist`, build caches and unrelated generated files, and return a downloadable ZIP artifact.

### Zip result resolver

When a job requests `output.expected = "zip"`, the bridge does not treat a text answer as success. It waits for a downloadable zip artifact, downloads it through the source extension tab/background worker, validates it, stores it, and exposes it as the job result.

Validation currently checks:

```text
ZIP local header and central directory exist
entry count within ZIP_MAX_ENTRIES
uncompressed size within ZIP_MAX_UNCOMPRESSED_SIZE
no absolute paths
no ../ path traversal
no symlink entries
```

Environment limits:

```env
ZIP_MAX_ENTRIES=5000
ZIP_MAX_UNCOMPRESSED_SIZE=524288000
```

A successful result looks like:

```json
{
  "type": "zip",
  "status": "ready",
  "downloadId": "dl_job_...",
  "fileId": "artifact_...",
  "downloadUrl": "/jobs/job_.../result/download",
  "sha256": "...",
  "manifest": [
    { "path": "src/index.js", "directory": false, "compressedSize": 100, "uncompressedSize": 220 }
  ]
}
```

If no downloadable zip is exposed by ChatGPT, the job fails with:

```text
EXPECTED_ZIP_ARTIFACT_NOT_FOUND
```

The fallback mode that reconstructs a zip from `file:path` blocks or diffs is intentionally not implemented in this pass.

### Job events

`GET /jobs/:id/events?stream=1` returns SSE events for a specific job. These are the public events that a desktop client should consume, rather than the raw debug stream.

Typical events:

```text
job.created
job.started
request.started
files.attach.started
files.attach.done
prompt.sent
generation.started
thinking.snapshot
answer.snapshot
artifact.snapshot
result.resolving
artifact.downloading
result.validating
result.ready
job.done
job.failed
job.cancelled
```

The global `/events/stream` and `/debug/stream` endpoints still exist. Use job-specific events for app workflows and debug stream only for diagnostics.

## Codex-like app-server mode

The bridge now uses Codex-inspired names for the automation core:

```text
thread  = long-lived work session / conversation
turn    = one user request and one ChatGPT execution
item    = user message, reasoning, assistant message, artifact, etc.
```

The older `/jobs` endpoints are still available for compatibility, but new IDE integrations should prefer the `thread / turn / item` API or the Codex-like JSON-RPC transport.

### REST endpoints

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
POST /turns/:id/interrupt
```

Example turn:

```bash
curl -X POST http://127.0.0.1:8080/turns \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-ide-turn-001" \
  -d '{
    "threadId": "thread_...",
    "input": [{ "type": "text", "text": "Review this project." }],
    "model": "GPT-5.5 Thinking",
    "effort": "high",
    "attachments": ["file_project_zip"],
    "output": { "expected": "zip", "required": true }
  }'
```

`GET /turns/:id/events?stream=1` emits Codex-like event names such as:

```text
turn/queued
turn/started
item/started
item/reasoning/delta
item/agentMessage/delta
item/artifact/created
item/reasoning/completed
item/agentMessage/completed
turn/completed
turn/failed
turn/interrupted
```

### JSON-RPC over WebSocket

A Codex-like JSON-RPC endpoint is available at:

```text
ws://127.0.0.1:8080/codex/ws?token=$API_TOKEN
```

Supported MVP methods:

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

`project/scan` and `project/pack` are implemented. They use the same project scanner/packer as interactive mode.

Example:

```json
{"id":1,"method":"initialize","params":{}}
{"id":2,"method":"thread/create","params":{"title":"my-app","cwd":"/Users/me/code/my-app"}}
{"id":3,"method":"turn/start","params":{"threadId":"thread_...","input":"Fix the login bug","output":{"expected":"zip","required":true}}}
```

The server sends notifications on the same socket:

```json
{"method":"turn/started","params":{"turnId":"turn_..."}}
{"method":"item/agentMessage/delta","params":{"turnId":"turn_...","itemId":"item_...","text":"..."}}
{"method":"item/artifact/created","params":{"turnId":"turn_...","artifact":{"id":"artifact_..."}}}
{"method":"turn/completed","params":{"turnId":"turn_..."}}
```

### JSON-RPC over stdio

For IDEs that expect a subprocess-style app server, run:

```bash
npm run codex:stdio
```

This starts the normal HTTP/WebSocket server for the browser extension at the configured `PORT`, then reads JSON-RPC lines from stdin and writes JSON-RPC responses to stdout. Logs are disabled on stdout in this mode so they do not corrupt the protocol stream.

The capability response intentionally reports unsupported features explicitly:

```json
{
  "capabilities": {
    "threads": true,
    "turns": true,
    "items": true,
    "streamingItems": true,
    "artifacts": true,
    "projectPackaging": true,
    "fileEdits": "zip-artifact",
    "shellCommands": false,
    "approvals": false,
    "worktrees": false,
    "sandbox": false
  }
}
```

This is not a full Codex app-server implementation yet. The goal of this layer is API shape compatibility for an IDE integration that can later swap between a real Codex app-server and this ChatGPT browser bridge.

## Project-aware interactive MVP

The interactive client can now be started with a project root:

```bash
npm run interact -- --project /path/to/project
```

When a project is open, plain text input is treated as a project task. The bridge scans the project, respects `.gitignore`, `.ignore`, and `.bridgeignore`, applies built-in excludes when no ignore file covers a path, creates a snapshot ZIP, attaches it to the ChatGPT prompt, and expects a ZIP artifact back.

Use `/ask` when you want a lightweight question without attaching the project ZIP:

```text
bridge> /ask What is the purpose of AGENT.md in this project?
```

`/ask` includes only lightweight agent/skill context. It does not upload the full project archive.

Project commands:

```text
/project
/project open <path>
/project scan
/project pack
/project sync
/project sessions
/project session new
/project session use <id|index>
/skills
/skills enable <name...>
/skills disable <name...>
/agent
/task <prompt>
/resume
/ask <prompt>
/result
/result recover [--force|--apply]
/recover [--force|--apply]
/result download [path]
/result apply [--plan|--interactive|--force]
```

Typical flow:

```text
bridge> /project session new
bridge> /skills enable nodejs tests
bridge> Fix the failing login test and return an updated project ZIP
...
[result] ready updated-project.zip
bridge> /result apply
Safety warnings are shown if the project is not a git repository, if the git worktree has uncommitted/untracked files, or if a file changed locally after the snapshot was sent. Default `/result apply` asks once for the whole sync plan. It does not ask for every ordinary changed file. Use `/result apply --interactive` when you want to choose individual updates/deletes. The ZIP stays available and can be applied later with `/result apply`.

If the CLI disconnects while ChatGPT is still generating, use `/resume` after reconnecting to the same ChatGPT tab to attach to the active prompt and keep streaming through the normal pipeline. If the bridge process, CLI, browser companion, or request lifecycle fails while ChatGPT continues and eventually finishes the answer, use `/recover` after reconnecting to the same ChatGPT tab. Recovery asks the companion to read the latest visible assistant message, re-registers its artifacts, and resolves the ZIP result into the last project turn. Use `/recover --apply` to recover and immediately run the normal safe apply flow, or `/result recover --force` to overwrite an already completed local turn with the latest visible answer.
```

`/result apply` synchronizes the last ZIP result back into the opened project. It validates the archive before extraction, strips a common top-level folder such as `project/`, skips `.git`, `.bridge`, and `node_modules` entries, creates new files, updates changed files, and deletes files that were part of the original project snapshot but are absent from the result ZIP. Ignored files and files that were never sent in the original snapshot are not deleted. Ordinary updates are applied after one common confirmation. Locally changed files after snapshot are highlighted as conflicts. `/result apply --plan` prints the plan without writing, `/result apply --interactive` asks per update/delete, and `/result apply --force` applies without confirmation.

Project snapshots are cached by content hash. If the same snapshot was already uploaded in the same local thread, the next task reuses that context and does not attach the ZIP again. Use `/project sync` to force a fresh package.

### Project package format

The generated ZIP contains:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

`PROJECT_CONTEXT.md` includes a file tree and a lightweight symbol index with line ranges. The symbol scanner is deliberately simple and fast; it recognizes common functions/classes in JS/TS, Python, Go, Rust, PHP, Java-like languages, and similar source files.

`AGENT_EFFECTIVE.md` is composed from built-in bridge rules, the project agent file, and enabled skills.

Agent file discovery order:

```text
AGENTS.md
AGENT.md
agent.md
.bridge/AGENT.md
```

Skill discovery locations:

```text
.bridge/skills/*.md
~/.chatgpt-bridge/skills/*.md
```

### Project REST API

```text
POST /projects/open
POST /projects/scan
POST /projects/pack
```

Examples:

```bash
curl -X POST http://127.0.0.1:8080/projects/scan \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/path/to/project"}'
```

```bash
curl -X POST http://127.0.0.1:8080/turns \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "threadId":"thread_...",
    "cwd":"/path/to/project",
    "message":"Fix the bug and return a ZIP",
    "project":{"mode":"package","skills":["nodejs"],"snapshotPolicy":"reuse-if-unchanged"},
    "output":{"expected":"zip","required":true}
  }'
```

The corresponding Codex-like JSON-RPC methods are also implemented:

```text
project/open
project/scan
project/pack
turn/start
```

`initialize` now reports `projectPackaging: true`.

### Project packaging settings

```env
PROJECT_MAX_FILES=2000
PROJECT_MAX_ZIP_BYTES=52428800
PROJECT_MAX_SINGLE_FILE_BYTES=1048576
PROJECT_CONTEXT_MAX_SYMBOLS=2000
PROJECT_TREE_LIMIT=500
```

Built-in excludes cover common dependency folders, build outputs, IDE metadata, caches, virtual environments, logs, archives, and secret-looking files such as `.env` / `.env.*`. `.gitignore`, `.ignore`, and `.bridgeignore` are also applied.


## Extension reliability notes

The supported extension path avoids large inline command payloads and keeps privileged browser operations outside the ChatGPT page context.

For input attachments, stored bridge files are normally exposed through short-lived signed localhost URLs. The extension background worker fetches them outside page CSP and the content script attaches the resulting `File` objects to the ChatGPT composer.

For output artifacts, the content script can return a small artifact inline or stream larger data in protocol chunks:

```text
artifact.data.started
artifact.data.chunk
artifact.data.done
```

When an artifact action starts a normal browser download, the background worker captures the completed download and returns its local path. Node imports the result into `DATA_DIR/artifacts` and validates ZIP outputs before selection/apply.

Reliability rules:

- each running request is bound to its source client/tab and requested ChatGPT session;
- a busy tab is never reused for a new prompt;
- switching a fallback idle tab to another session requires interactive confirmation;
- full-page session navigation safely resends the same request id after reconnect, and content-script delivery is idempotent;
- weak heartbeat tracks tab/script liveness but does not count as meaningful request progress;
- stalled requests use a source-bound forced snapshot rather than a global latest response;
- extension reconnect status reports active request identity and owner server instance when available.

Relevant settings:

```env
ATTACHMENT_TRANSPORT=url
PUBLIC_BASE_URL=http://127.0.0.1:8080
ARTIFACT_CHUNK_TIMEOUT_MS=120000
```

`tools/chrome-csp-dev-bypass` is a legacy development utility from the former page-WebSocket experiment. It is not required or used by the supported extension runtime.

## Recovery and apply improvements

If the bridge process, terminal UI, or local server exits while ChatGPT is still working, the browser tab may still finish successfully. The interactive UI can recover from the visible ChatGPT DOM after restart:

```bash
bridge
/recover list
/recover 1
/recover 2 --apply
/result recover list
/result recover 2 --apply
```

`/recover list` scans the recent visible assistant turns in the selected ChatGPT tab and prints candidates with indexes, previews, answer lengths, and artifact counts. Use `/recover <n>` to choose the exact assistant response to attach to the last project turn. This is useful when the latest visible response is not the one you want.

Recovery is not limited to a downloadable ZIP artifact. For project tasks expecting a ZIP result, the resolver tries, in order:

1. a downloadable `.zip` artifact exposed by ChatGPT;
2. a browser-download artifact captured by the extension;
3. fenced file blocks in the answer, such as:

````text
```file:src/app.js
console.log('updated');
```
````

When file blocks are used, the bridge reconstructs a ZIP result locally and then applies it through the same safe project-apply path.

You can also apply a ZIP that you downloaded manually:

```bash
/apply /path/to/result.zip
/result apply /path/to/result.zip
```

The command still uses the normal project apply safety checks, `.bridge`/ignored-file protection, conflict detection, and optional `--plan`, `--interactive`, or `--force` flags.

## Terminal UI details

The default `bridge` Ink UI supports a richer command input:

- type `/` to show command suggestions;
- use ↑/↓ to move through suggestions;
- press `Tab` or `Enter` to complete the highlighted command;
- the suggestion box keeps a stable three-row height and scrolls internally;
- while a request is running, `Ctrl+C` asks whether to cancel the ChatGPT prompt or detach/exit and leave it running in the browser;
- Thinking/reasoning text from ChatGPT is displayed in a separate `Thinking` panel while the answer is streaming.

### v13 recovery notes: inline artifact buttons

ChatGPT can render a downloadable result as an inline markdown button rather than an `<a href>` link. A common example is a button labelled “скачать обновлённый ZIP”. In extension mode, `/recover list` and `/recover <n>` now scan recent assistant turns, assistant message roots, and artifact-bearing markdown fallback nodes. Such buttons are returned as action artifacts, and `/recover <n> --apply` can click the matching button with `chrome.downloads` capture armed, import the completed local download into `DATA_DIR/artifacts`, and run the normal safe project apply flow.

Manual ZIP apply is still available when you downloaded the result yourself:

```bash
/apply /path/to/result.zip
/result apply /path/to/result.zip --plan
/result apply /path/to/result.zip --interactive
```

### v13 terminal input navigation

The Ink UI input behaves like a line editor:

- `Left` / `Right`: move by character.
- `Backspace` / `Delete`: edit at the cursor.
- `Ctrl+Left` / `Ctrl+Right`: move by word on PC/Linux terminals.
- `Option+Left` / `Option+Right`: move by word on macOS when the terminal sends `Esc-b` / `Esc-f` or common CSI modifier sequences.
- `Home` / `End`, `Ctrl+A` / `Ctrl+E`, and common Cmd-arrow terminal mappings: jump to the beginning/end of the line.
- `Backspace` is handled through both terminal key metadata and raw `\x7f` / `\x08`, so it should not insert visible control characters.

Command suggestions remain a fixed three-row scroll window, so the terminal layout should not jump when the number of suggestions changes.
