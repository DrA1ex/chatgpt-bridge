# ChatGPT Browser Bridge — Node.js + Tampermonkey

Local HTTP/OpenAI-compatible bridge for a logged-in ChatGPT browser tab.

This version uses a Tampermonkey companion script inside the ChatGPT page. The recommended browser transport is HTTP long-polling through `GM_xmlhttpRequest`, because ChatGPT Content Security Policy can block direct `ws://127.0.0.1` connections from page/userscript context. WebSocket remains available as an optional transport. The old Playwright/CDP mode was removed because it was too fragile against normal browser sessions and ChatGPT UI changes.

```text
Client / CLI → Express API → Tampermonkey transport hub → Tampermonkey companion → ChatGPT Web UI
                         ├─ HTTP polling, default
                         └─ WebSocket, optional
```

## What is included

- Conversation/session API: `GET /sessions`, `POST /sessions/new`, `POST /sessions/select`, `POST /sessions/:id/messages`
- File upload API: `POST /files`, `POST /files/from-path`, `GET /files/:id/download`
- Output artifact API: `GET /artifacts`, `GET /artifacts/:id/download`
- Model/effort best-effort UI selection per prompt
- Model/effort option discovery from the ChatGPT UI when available
- Normalized chat event stream for prompt lifecycle, files, sessions, thinking, answer and artifacts
- `GET /health`
- `GET /tm/clients`
- `GET /models` and `GET /efforts`
- `POST /composer/attachments/clear`
- `POST /tm/select`
- `POST /tm/stop`
- `GET /debug/events`
- `POST /chat`
- `POST /v1/chat/completions`
- OpenAI-compatible non-streaming response shape
- OpenAI-compatible streaming response shape for `stream: true`
- OpenAI-compatible multimodal-ish input parts for text, `file_id` and data-URL `image_url`
- SSE streaming for `/chat?stream=1`
- `npm run interact` terminal mode
- Explicit tab selection when more than one ChatGPT tab is connected
- Cancellation from HTTP disconnects, `/tm/stop`, interactive `/stop`, and Ctrl+C in interactive mode
- Sequential request lock so prompts do not overlap in one ChatGPT tab
- Tampermonkey userscript companion with floating setup/status panel
- DOM streaming from inside the ChatGPT page
- Input file attachment through the ChatGPT composer file input
- Output artifact/image/file link discovery and browser-side download
- Structured Markdown extraction for paragraphs, headings, code blocks, lists, blockquotes and tables
- Diagnostic event buffer for troubleshooting
- Experimental network-stream hooks for explicit delta-style internal events
- systemd service for the Node bridge
- unit tests for payload parsing, request locking, protocol deltas and interim answer detection

## Requirements

- Node.js 20+
- npm
- A browser with Tampermonkey installed
- Logged-in ChatGPT session at `https://chatgpt.com`

Chromium remote debugging and Playwright are no longer required.

## Install

```bash
mkdir -p ~/chatgpt-bridge-node
cd ~/chatgpt-bridge-node
npm install
cp .env.example .env  # optional; npm start can create .env automatically
```

Start the bridge:

```bash
npm start
```

Default server:

```text
http://127.0.0.1:8080
```

The server loads `.env` automatically. On first startup it creates `.env` if needed and writes stable `API_TOKEN`, `BRIDGE_TOKEN`, `HOST`, `PORT`, and `PUBLIC_BASE_URL`. You can override the env file path with `ENV_FILE=/path/to/file`.

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

The Tampermonkey browser companion uses a separate `BRIDGE_TOKEN`. It is intentionally separate from `API_TOKEN`: the browser agent does not need full API access. You no longer edit the userscript source; paste the Bridge token once into the floating Bridge panel on the ChatGPT page.

## Install and configure the Tampermonkey companion

Start the bridge and open the setup page:

```text
http://127.0.0.1:8080/setup
```

Install or update the userscript from the setup page link, or paste this file into Tampermonkey:

```text
userscripts/chatgpt-bridge.user.js
```

Then open or reload:

```text
https://chatgpt.com/
```

A small `◈ Bridge` tab appears in the bottom-right corner. It briefly peeks out on page load. Click it, paste the `BRIDGE_TOKEN` from `/setup`, leave transport as `HTTP polling`, and press `Save & Connect`. The tab includes a status dot: green means connected, red means disconnected/error, and pulsing white means not configured yet. The settings panel has a close button, loaders for `Test` and `Save & Connect`, and a local request log so you can see whether polling requests are actually moving. WebSocket can be selected for development, but HTTP polling is the recommended default because it bypasses ChatGPT CSP restrictions on localhost WebSocket connections.

Check connection:

```bash
export API_TOKEN=some-long-random-local-api-token
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/health | jq
```

Expected shape when exactly one userscript tab is connected:

```json
{
  "ok": true,
  "transport": "tampermonkey:polling",
  "clients": 1,
  "selectedClientId": "",
  "needsSelection": false,
  "activeClient": {
    "url": "https://chatgpt.com/"
  }
}
```

## Multiple ChatGPT tabs

If one ChatGPT tab is connected, the bridge uses it automatically. If multiple tabs are connected, the bridge will not guess. Select one explicitly.

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

Usually it is better to leave `ACTIVE_CLIENT_ID` empty and select from interactive mode, because userscript client ids are browser-profile local and may change if site data is cleared.

## Interactive mode

Run:

```bash
npm run interact
```

Interactive mode still starts the local HTTP server, because the Tampermonkey companion needs `/tm/poll`, `/tm/events`, and `/tm/files/...` endpoints. WebSocket is optional.

Inside interactive mode, any line that does not start with `/` is sent as a ChatGPT message:

```text
bridge> hello
```

The interactive shell keeps its own working state: selected session, model, effort, event display level, queued input attachments, last visible sessions, and last output artifacts. Persistent fields are saved to `DATA_DIR/interactive-state.json` and restored on the next `npm run interact` start. The common flow is:

```text
bridge> /sessions
bridge> /session select 2
bridge> /model list
bridge> /model 1
bridge> /effort high
bridge> /attach ./report.pdf ./screenshot.png
bridge> Analyze these files and create a result file
bridge> /artifacts
bridge> /download 1 ./result.xlsx
bridge> /open 1
```

Commands:

```text
/help
/health
/clients
/select <clientId|clear>
/stop
/reset
/events [quiet|normal|verbose]

/sessions
/session new
/session current
/session refresh
/session select <id|index>

/model
/model list
/model <name|index>
/effort
/effort list
/effort <auto|instant|low|medium|high|xhigh>
/mode

/attach <path> [path...]
/attachments
/detach <index|fileId|all>
/attachments clear-ui
/files
/file add <path>
/file remove <fileId>

/artifacts
/download <index|artifactId> [path]
/open <index|artifactId>
/state
/debug [n]
/exit
/quit
```

During an active answer, press Ctrl+C to cancel the current request. Press Ctrl+C again when no request is active to leave interactive mode.

The CLI shows compact normalized events such as file attachment, model selection, prompt sent, generation started, artifact discovered, and done. It streams visible `Thinking` text separately from the assistant answer. At the end it compares the streamed answer with the final text from the page. If the stream missed or drifted, it prints a clean `Final answer` block instead of trying to rewrite terminal history.

Use `/events quiet` when you only want answers, `/events normal` for the default compact status lines, and `/events verbose` when you want more event names without switching to raw debug output.

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

If the HTTP/SSE client disconnects, the bridge sends `prompt.cancel` to the Tampermonkey companion and tries to press ChatGPT's stop button.

## Conversation/session API

The bridge treats a ChatGPT browser tab as the active client, and ChatGPT conversations as sessions. Sessions are discovered from the current page/sidebar links that the userscript can see.

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

Accepted effort values are free-form, but these are normalized in the userscript: `auto`, `instant`, `low`, `medium`, `high`, `xhigh`, `thinking`.

This is intentionally best-effort because ChatGPT model-picker markup changes. The option list is discovered from visible menu/button text, so it may be incomplete if the UI changes, the picker is hidden behind a modal, or the account does not expose the same controls. The userscript emits `model.apply.started`, `model.apply.done`, `model.option_clicked`, `effort.option_clicked`, or warning events through `/debug/events` and `/chat?stream=1` `event:` frames. If selection cannot be confirmed, the prompt still sends instead of blocking the main workflow.

## Files and input attachments

The main file flow is:

```text
POST /files → receive file.id → pass file id in /chat attachments → Tampermonkey attaches the file in ChatGPT composer → prompt sends
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

The userscript inspects the final assistant message for file links, download links, large images and canvas/artifact actions. `/chat` responses include an `artifacts` array:

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

The download is browser-side: Node asks the Tampermonkey tab to fetch the artifact URL with the page's ChatGPT credentials, receives base64 data, stores it under `DATA_DIR`, and streams it back to the HTTP client. This is the most reliable way to download `blob:` URLs or authenticated ChatGPT file links. In interactive mode, `/open <index|artifactId>` downloads the artifact if needed and opens it with the OS default app (`open`, `xdg-open`, or Windows `start`).

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

For browser/userscript diagnostics, open:

```text
http://127.0.0.1:8080/diagnostics
```

This page is localhost-only and does not require the API token. It shows `/setup/status` and a live debug stream, which is useful while pressing `Test` / `Save & Connect` in the floating userscript panel.

The server also has two API SSE streams. `/events/stream` is the normalized product event stream, suitable for another UI or a lightweight monitor:

```bash
curl -N -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/events/stream
```

`/debug/stream` is for protocol and userscript diagnostics:

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

Debug events include lower-level protocol and userscript diagnostics such as:

```text
composer.found
composer.not_found
send_button.found
send_button.not_found_keyboard_fallback
network.parser.matched
protocol.out.prompt.send
```

Debug output is intentionally truncated. It is meant to show where a request failed without dumping full private prompts, full answers, base64 files, or large DOM snapshots into logs.

## How the companion works

The Tampermonkey script does three things from inside the ChatGPT page:

1. Connects to the bridge using the selected transport. HTTP polling via `/tm/hello`, `/tm/poll`, and `/tm/events` is the default because it works around ChatGPT CSP restrictions. WebSocket at `/tm/ws` remains available as an optional development transport.
2. Receives `prompt.send` commands, inserts text into the ChatGPT composer, and presses Send.
3. Streams visible thinking/answer changes back to the Node bridge.

There are two observation layers.

The reliable layer is DOM-based. A `MutationObserver` watches the last assistant message, visible thinking/reasoning blocks, and the stop-generation button. This is the authoritative source for final text.

The DOM extractor preserves more Markdown structure than plain `innerText`: paragraphs, headings, fenced code blocks, lists, blockquotes and tables are converted into Markdown-like text before being returned through the API.

The experimental layer is network-based. The script injects a small page-context hook that watches `fetch` response streams and WebSocket messages for explicit delta-style events. It only emits conservative delta candidates, while DOM snapshots remain the final source of truth.

Hidden internal reasoning that is not visible to the ChatGPT web page is not exposed.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind host |
| `PORT` | `8080` | HTTP/WebSocket port |
| `API_TOKEN` | empty | If set, required for all HTTP API/debug endpoints |
| `ACTIVE_CLIENT_ID` | empty | Optional fixed Tampermonkey tab id |
| `BRIDGE_TOKEN` | generated into `.env` on first startup | Token required by the Tampermonkey browser companion |
| `TM_TRANSPORT` | `polling` | Recommended userscript transport. `websocket` remains optional |
| `TM_POLL_TIMEOUT_MS` | `25000` | Long-poll timeout for `/tm/poll` |
| `ALLOWED_ORIGINS` | `https://chatgpt.com,https://chat.openai.com,null` | Accepted WebSocket origins when WS transport is used |
| `PAYLOAD_DEBUG` | `0` | Enable `/v1/chat/completions` payload dump |
| `PAYLOAD_DEBUG_FILE` | `./last_openclaw_payload.json` | Debug dump path when `PAYLOAD_DEBUG=1` |
| `ANSWER_TIMEOUT_MS` | `120000` | Max answer wait time |
| `ANSWER_SETTLE_MS` | `1500` | How long answer text must stay stable before done |
| `ANSWER_DONE_SETTLE_MS` | `600` | Shorter settle window after generation appears idle |
| `PROMPT_ACCEPTED_TIMEOUT_MS` | `10000` | Max wait for userscript to accept a prompt command |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Server ping interval for userscript clients |
| `CLIENT_STALE_MS` | `30000` | Disconnect stale userscript clients |
| `DEBUG_EVENTS_LIMIT` | `250` | In-memory diagnostic event buffer size |
| `JSON_BODY_LIMIT` | `50mb` | Express JSON body size limit for prompts and base64 file uploads |
| `DATA_DIR` | `./.bridge-data` | Local storage for uploaded files, downloaded artifacts, and interactive state |

## systemd

Assuming the project is located at `~/chatgpt-bridge-node`:

```bash
sudo cp systemd/chatgpt-bridge-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chatgpt-bridge-node
sudo systemctl start chatgpt-bridge-node
journalctl -u chatgpt-bridge-node -f
```

Open `/setup` and paste the displayed `BRIDGE_TOKEN` into the floating userscript panel. Keep `API_TOKEN` stable for clients that call the HTTP API.

## Troubleshooting

If `/health` says no client is connected:

- Reload `https://chatgpt.com/`.
- Check that Tampermonkey is enabled for the page.
- Check that `CONFIG.wsUrl` points to the right port.
- Open the floating `◈ Bridge` panel and check status.
- Make sure Server URL points to `http://127.0.0.1:8080`.
- Make sure the Bridge token matches `/setup`.
- Use `HTTP polling` if the browser console shows ChatGPT CSP blocking `ws://127.0.0.1`.
- Check `/debug/events` for `hello`, `page.status`, and diagnostic entries.

If `/health` says `needsSelection: true`:

- Run `/clients` in interactive mode, or call `GET /tm/clients`.
- Select the intended tab with `/select <clientId>` or `POST /tm/select`.

If the bridge rejects HTTP requests:

- Check the `Authorization: Bearer <API_TOKEN>` header.
- Check that your shell exported the same `API_TOKEN` as `.env`.

If the bridge rejects the userscript connection:

- Check `BRIDGE_TOKEN`.
- Check `ALLOWED_ORIGINS`.
- If Tampermonkey sends `Origin: null`, keep `null` in `ALLOWED_ORIGINS`.

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

The coverage script uses Node's built-in test runner with `--experimental-test-coverage` and enforces `--test-coverage-lines=70` for `src/**/*.js`.

## Notes and limitations

The bridge automates the ChatGPT Web UI, so it can still break if ChatGPT changes the page structure. The Tampermonkey approach avoids fragile Chromium debug sessions and is usually more stable than external CDP automation, but it is not equivalent to the official OpenAI API.

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

When a job requests `output.expected = "zip"`, the bridge does not treat a text answer as success. It waits for a downloadable zip artifact, downloads it through the Tampermonkey browser context, validates it, stores it, and exposes it as the job result.

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

This starts the normal HTTP server for Tampermonkey at the configured `PORT`, then reads JSON-RPC lines from stdin and writes JSON-RPC responses to stdout. Logs are disabled on stdout in this mode so they do not corrupt the protocol stream.

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
/ask <prompt>
/result
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


## Tampermonkey reliability notes

The companion userscript now avoids the most fragile large-payload paths used by earlier builds.

For input attachments, stored bridge files are sent to the userscript as signed localhost URLs instead of inline base64 by default. The userscript downloads the file from `GET /tm/files/:id/download?token=...` and attaches it to ChatGPT. This keeps project ZIP uploads out of the command payload for both HTTP polling and WebSocket transports.

For output artifacts, the userscript sends downloaded artifact data back to Node in chunks:

```text
artifact.data.started
artifact.data.chunk
artifact.data.done
```

The server reassembles the chunks and stores the artifact in `DATA_DIR/artifacts`. This is more reliable for generated ZIPs and images than a single huge `contentBase64` message.

Additional userscript hardening:

- request recovery status is included in the initial `hello` after reconnect;
- prompt, upload, generation-start, first-output, and max-request timeouts are reported as diagnostics;
- file upload waits for visible attachment chips, absence of upload/progress indicators, and an enabled send button;
- composer insertion is verified, with paste/native/execCommand/textContent fallbacks;
- model/effort selection searches inside the opened picker/menu instead of the whole page;
- artifact action buttons can be clicked to materialize a download link before download;
- artifact downloads use normal page `fetch` first and `GM_xmlhttpRequest` as fallback;
- the optional network hook now uses a per-page nonce for `postMessage` validation.

Relevant settings:

```env
ATTACHMENT_TRANSPORT=url
PUBLIC_BASE_URL=http://127.0.0.1:8080
ARTIFACT_CHUNK_TIMEOUT_MS=120000
```

Use `ATTACHMENT_TRANSPORT=base64` only as a legacy fallback.
