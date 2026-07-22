# ChatGPT Browser Bridge — Node.js + Browser Extension

Local HTTP/OpenAI-compatible bridge for a logged-in ChatGPT browser tab.

The browser runtime is the Chrome/Chromium extension. Its background service worker owns the authenticated localhost WebSocket, persisted per-tab lease/effect/download state, and the acknowledged critical outbox. Bridge 6.3.x requires Protocol 5 and extension 2.3.x.

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
- `GET /health`, `GET /browser/clients`, `POST /browser/select`, `POST /browser/stop`, `GET /debug/events`
- `POST /chat`, `POST /v1/chat/completions`, and OpenAI-compatible streaming/non-streaming response shapes
- OpenAI-compatible multimodal-ish input parts for text, `file_id` and data-URL `image_url`
- SSE streaming for `/chat?stream=1`
- `bridge` interactive terminal UI (Terlio.js) and `bridge --server` server-only mode
- Session-aware automatic tab targeting, with confirmation before reusing an idle tab on another session
- Cancellation from HTTP disconnects, `/browser/stop`, interactive `/stop`, and Ctrl+C in interactive mode
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
- opt-in real-browser E2E smoke test with isolated-tab automation, real ChatGPT turns, downloadable artifact verification, and URL-bound cleanup

## Requirements

- Node.js 20+
- npm
- Chrome/Chromium browser for the extension runtime
- Logged-in ChatGPT session at `https://chatgpt.com`

Chromium remote debugging and Playwright are not required.

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

```bash
npm run extension:install
```

Then load the stable deployed directory once:

```text
chrome://extensions → Developer mode → Load unpacked → ~/.local/share/chatgpt-bridge/extension
```

The installer preserves that registered directory and atomically replaces files inside it on future updates, so Chrome keeps the same unpacked-extension root identity. Byte-identical bundles are skipped; changed bytes trigger a reload even when version strings are unchanged. Alternatively download the extension ZIP from `/setup`, unzip it into a stable directory of your choice, and load that unpacked folder. Then open or reload:

```text
https://chatgpt.com/
```

While connected, a compact `Bridge` button appears near the bottom-right corner on ChatGPT chat routes. When disconnected, the page runtime and floating panel are removed; click the extension toolbar action to open the setup panel on demand, paste the `BRIDGE_TOKEN` from `/setup`, and press `Save & connect`. The default panel is an onboarding flow; raw status and logs are available only under `Advanced & diagnostics`. The WebSocket is owned by the extension background worker, not by the ChatGPT page. The default endpoint is `ws://127.0.0.1:8080/extension/ws`.

The extension owns privileged browser operations: fetching signed localhost file URLs, capturing downloads created by ChatGPT artifact buttons through `chrome.downloads`, and returning the completed local path so Node can import the file into `DATA_DIR/artifacts`.

### Startup reload of the unpacked extension

Interactive mode and the real-browser E2E runner fingerprint the bundled extension and publish changed files into the stable `~/.local/share/chatgpt-bridge/extension` root before startup checks. The default `ask` policy skips reload only when both the deployed bytes and connected manifest/content versions are already current. Any changed bundle is reloaded automatically, including same-version development fixes, and both versions are verified after reconnect. A version mismatch also reloads the Protocol 5 extension even when compatibility currently marks the client outdated. Older-protocol clients cannot receive the reload command and must be updated manually or through the installer before startup continues.

```bash
npm run interact                 # asks before starting the Terlio UI
npm run interact -- --reload-extension
npm run interact -- --no-reload-extension

npm run test:e2e:real           # asks before opening the isolated E2E tab
npm run test:e2e:real -- --reload-extension
npm run test:e2e:real -- --no-reload-extension
```

The persistent policy is `BRIDGE_STARTUP_EXTENSION_RELOAD=ask|if-needed|always|never` for interactive mode and `E2E_EXTENSION_RELOAD=ask|if-needed|always|never` for real E2E. `--reload-extension` means `if-needed`: it deploys the current bundle and reloads only when files or reported versions differ. Use `--force-reload-extension` only to restart an already-current extension deliberately. `ask` also skips in a non-interactive terminal. Interactive mode skips the reload step if no extension connects during its five-second discovery window. Real E2E owns a bootstrap tab first, so reload confirmation is tied to that exact tab rather than an unrelated browser client. While the confirmation is pending, child-bridge output is buffered and live browser diagnostics are not started, keeping the question visible in the terminal.

`chrome.runtime.reload()` reloads the folder Chrome previously registered; it cannot change Chrome's registered filesystem path. Existing installations that still point at an old checkout must use **Load unpacked** with `~/.local/share/chatgpt-bridge/extension` once. If reload reconnects with the old version, Bridge now fails with `EXTENSION_LOADED_PATH_MISMATCH` and prints the exact deployed path instead of reporting a successful update. Startup reload succeeds only after a Protocol 5 content runtime reconnects with the exact expected package/content versions and a ready ChatGPT root and composer.


### Automatic ChatGPT tab opening

Automatic tab creation is opt-in for ordinary server and interactive requests:

```bash
bridge --auto-open-tab
bridge --server --auto-open-tab
```

The equivalent persistent setting is:

```env
AUTO_OPEN_TAB=1
```

When enabled, the bridge still reuses an unambiguous idle tab already on the requested session. If no safe target exists, it opens a dedicated tab instead of guessing among unrelated tabs. A connected modern extension opens the tab directly. If no extension client is connected yet, the server opens the URL in the operating system's default browser with a one-time launch token and waits only for the extension client that returns that token.

The default browser profile must therefore contain the current extension, a valid Bridge configuration, and a logged-in ChatGPT account. Explicit `sourceClientId` requests remain strict and are never silently redirected. The bridge also refuses to duplicate a requested conversation while that exact conversation is busy in another tab.

HTTP callers can enable or disable the behavior per request with `"autoOpenTab": true|false`. The lower-level `POST /browser/tabs/open` endpoint supports `"allowSystemFallback": true` for the same token-bound system-browser fallback. Automatically opened tabs used for normal work are not deleted or closed automatically.

The extension and bridge exchange explicit version/protocol metadata. An outdated extension remains visible in `/setup`, `/browser/clients`, and diagnostics, but it is excluded from prompt selection and receives an `extension update required` status. Reload the extension ZIP/folder packaged by the running bridge when this appears. Version policy is documented in `AGENT.MD`: patch for broadly compatible changes, minor for conditional compatibility, major for intentional incompatibility.

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
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8080/browser/clients | jq
```

Select a tab:

```bash
curl -X POST http://127.0.0.1:8080/browser/select \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"ext-..."}'
```

Clear explicit selection:

```bash
curl -X DELETE http://127.0.0.1:8080/browser/select \
  -H "Authorization: Bearer $API_TOKEN"
```

You can also set a persistent default in `.env`:

```env
ACTIVE_CLIENT_ID=ext-...
```

Usually it is better to leave `ACTIVE_CLIENT_ID` empty. For a prompt with a known session, the bridge first chooses an idle tab already on that session. If it must reuse and switch another idle tab, interactive mode asks for confirmation. Busy tabs are never reused. Client ids are browser-profile local and may change if extension/site data is cleared.

## CLI and interactive mode

The package exposes a `bridge` CLI. The default mode is the Terlio.js interactive terminal UI:

```bash
npm run interact
# after linking/installing the command:
bridge
```


Run only the local HTTP/WebSocket server, without terminal UI:

```bash
bridge --server
# or:
npm start
```

This mirrors the common CLI split used by agent tools: `bridge` is the operator UI, while `bridge --server` is the daemon/server process. Interactive mode still starts the local HTTP server internally because the extension background worker connects to its localhost HTTP/WebSocket endpoints.

### Installing the `bridge` command locally

For normal development from a checkout, use `npm link`. Do not use `npx link`: that invokes an unrelated package rather than npm's local-link command.

```bash
cd /path/to/chatgpt-browser-bridge-node
npm install
npm link
bridge
bridge --server
```

The package exposes both `bridge` and the compatibility alias `chatgpt-bridge` through the executable `bin/bridge.js` entrypoint. The entrypoint has a Node shebang and executable permissions, avoiding the `permission denied` failure caused by linking a non-executable source file. The global command remains linked to the checkout, so local changes are used on the next launch.

To remove the development command later:

```bash
npm unlink -g chatgpt-browser-bridge-node
```

Alternative without global linking:

```bash
npm run interact
npm run server
```

If you install from a local folder into another project instead of using `npm link`, use:

```bash
npm install -g /path/to/chatgpt-browser-bridge-node
bridge
```

### Workflow wizard

Workflows are started and controlled through one interactive entry point:

```text
/workflow
```

The wizard offers exactly three goals: apply changes returned by ChatGPT, fix the project until selected checks pass, or work through a guided task. It detects the current project and likely check commands, configures the ChatGPT chat, and shows a final summary before starting. Existing interactive behavior remains unchanged until a workflow is explicitly started.

Global defaults are stored as editable JSON at `~/.bridge-data/workflows/config.json`. They cover chat exhaustion recovery, invalid-result repair, notifications, checks, and workflow-owned Git commits. When a workflow needs a decision, its action list appears automatically and `/workflow` reopens it directly.

Advanced non-interactive compatibility remains available through `bridge workflow init`, `bridge workflow validate`, `bridge workflow run`, and `bridge workflow serve`. See `docs/WORKFLOWS.md` for the presets, result package protocol, project synchronization, session recovery, and commit safety.

### Interactive UI

The interactive UI is built on Terlio.js rather than a plain readline prompt. It keeps an append-only chat transcript for prompts, answers, compact task milestones, and the currently streaming response. The transcript has explicit sticky-tail scroll state: new output follows the bottom until the operator scrolls upward, then remains stable until the bottom is reached again.

The layout has three explicit width modes:

- below 115 columns, only the chat is shown and it uses the full terminal width;
- from 115 through 169 columns, the left context/navigation panel is shown and the chat consumes all remaining width;
- from 170 columns, left and right panels surround an expanding center chat;
- the header, command editor, suggestion area, and footer always span the full terminal width;
- `Ctrl+B` or `/info` opens a scrollable full-details panel. It uses one column below 120 columns and two columns from 120 columns, so information that does not fit a sidebar remains available without squeezing the chat.

Keyboard and pointer controls:

```text
Enter             submit input or accept the selected completion
Shift/Ctrl+Enter  insert a line break
Tab               autocomplete slash commands
↑ / ↓             move within multiline input; otherwise suggestions/history
PgUp / PgDn       scroll the visible pane by a page
Shift+↑ / ↓       scroll the visible pane by one line
Mouse wheel       scroll the pane under the pointer
Scrollbar         click or drag to move through the visible pane
Ctrl+Home / End   jump to the top / resume following the bottom
Ctrl+B            toggle the scrollable details panel; Esc closes it
Ctrl+T            toggle pointer capture for native terminal text selection
Ctrl+C            cancel/exit; active local workflow actions require confirmation
Ctrl+L            clear the transcript
```

The chat pane renders an above/below line counter and an interactive scrollbar. Mouse-wheel and trackpad events scroll the pane under the pointer; clicking or dragging the scrollbar updates the same sticky-tail scroll model used by the keyboard. Transcript text supports multiline mouse selection. After dragging a selection, a short click inside the highlighted text copies it and clears the highlight. Typing the first `/` immediately opens command suggestions with a short description on the same row. Suggestion rows exist only while completion is visible: they temporarily reduce the transcript viewport instead of permanently reserving empty space. Completing a command switches the same surface to contextual parameter suggestions. Commands that are valid without arguments expose an explicit selectable no-argument row. Bare `/workflow` is shown as the only first action and opens the context-sensitive workflow wizard; `/workflow wizard` is an alias, while targeted workflow views appear only after typing a trailing space. Tabs and sessions are suggested by stable list numbers by default, while typing a full runtime ID still selects that exact item. The `/workflow` wizard offers the current tab, a new chat, or another connected tab directly. Space toggles multi-select options, while Esc or Alt+Left returns to the previous setup step without discarding earlier choices. Inside multiline or wrapped input, plain ↑/↓ moves the cursor vertically. Outside multiline input, it navigates active slash suggestions; input history is used only when the editor is empty or while continuing through an unchanged recalled entry. Esc-cancelled drafts and submitted prompts are stored per project root, or per current directory when no project is open, and remain available after restart. `/events normal` keeps compact user-facing milestones in the chat/activity surfaces, while `/events verbose` additionally exposes raw debug events in the wide activity column and diagnostics.

Terlio theme presets are available through `/themes` and `/theme <name>`. Moving through `/theme ` suggestions previews each palette immediately. Escaping or clearing the command restores the saved palette; submitting the command persists the selected theme for the next launch. Available presets include `dark`, `mono`, `amber`, `ocean`, `forest`, `synth`, `slate`, `paper`, and `matrix` when present in the installed Terlio version.

The interactive runtime uses the pointer API provided by `terlio.js@1.1.0`, including SGR mouse decoding, wheel/trackpad events, pointer-region dispatch, and scrollbar click/drag handling. `Ctrl+T` temporarily disables pointer capture when native terminal text selection is preferred. Bracketed paste is enabled for the lifetime of the TUI. Multiline text is preserved exactly for submission; a paste longer than 250 Unicode symbols is shown as `[pasted N symbols]`, behaves as one cursor token, and expands without deleting when Backspace or Delete is pressed at its boundary.

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
  /tab [n|auto|drop n]   show/select/drop current tab

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
  /file clear-ui         clear visible composer attachments
  /file remove <n|id>    remove queued file
  /files                 list local stored files
  /files remove <id>     remove a local stored file

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
  /clear                 clear terminal log
  /help                  compact help
  /quit                  exit
```


During an active answer, press Ctrl+C or use `/stop` to cancel the current request. Press Ctrl+C again when no request is active to leave interactive mode. After the TUI restores the normal screen, Bridge prints shutdown progress, detaches preserved workflow work, and bounds HTTP draining; remaining connections are force-closed instead of leaving an unexplained background process.

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

The stream uses one normalized SSE envelope:

```text
event: event
data: {"type":"answer.delta", ...}
...
event: event
data: {"type":"request.result","result":{...}}
```

Every frame is a typed canonical event. `request.result` is the single authoritative final response frame; `request.error` is the terminal failure frame. Clients must not reconstruct lifecycle state from transport-specific event names.

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

The interactive runtime also reads the active tab's current model and effort immediately after connection or tab changes and displays the observed values separately from saved preferences. Preferences are scoped per project and copied into workflow profiles. When a running workflow specifies an effort that differs from the visible ChatGPT selection, Bridge applies and verifies that effort immediately. `/effort auto` stores an explicit Auto preference; `/effort default` clears the project preference.

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

Accepted effort values are free-form, but visible localized options are normalized to stable internal ids such as `instant`, `medium`, and `high`. The API keeps the localized `label` and full `rawText`, while `id`/`value` are suitable for automation. Thus `--effort high` can select a localized visible option whose label means “High”.

This is intentionally best-effort because ChatGPT model-picker markup changes. Trigger discovery is scoped to the active composer surface and explicitly rejects the ChatGPT history sidebar, message-level model actions, and the extension-owned Bridge panel. Only session discovery/change/delete commands may inspect sidebar history. The content script opens `[data-testid="composer-intelligence-picker-content"]` and treats only its top-level `menuitemradio` entries as effort choices. The last `menuitem[data-has-submenu]` contains the current model. The actual model list is a short-lived Radix portal that appears only while this trigger is hovered/focused; it is associated by `aria-controls`/`aria-labelledby`, read immediately, and may disappear afterward. `aria-checked`/`data-state` identify effort selection and provide a secondary model check, while the submenu trigger remains the authoritative current-model label. Model annotations are preserved in `rawText`/`annotation`. If this semantic structure disappears, the command returns `DOM_SCHEMA_CHANGED` rather than guessing from unrelated composer text. Prompt submission remains non-blocking unless strict model selection was explicitly requested.

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

The browser companion inspects the anchored assistant turn for generated-file cards, file links, large images, and scoped artifact actions. Output files may be button-only cards without `href` or `download`, so discovery uses filename/card/action signals and tracks each candidate as `GENERATING`, `READY`, or `FAILED`. The request is not considered complete while a detected generated file is still being prepared. `/chat` responses include an `artifacts` array:

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

The download is browser-side and source-turn scoped. Node asks the extension content script to fetch a direct URL or click the exact artifact action inside the original assistant turn. Materialization uses three ordered paths: a MAIN-world hook captures page-created Blob/data bytes, a newly exposed direct/authenticated URL is fetched, and `chrome.downloads` is used only as a fallback matched to the expected filename. When the Blob/data path succeeds, the temporary duplicate browser download is suppressed. Losing capture paths are cancelled so a later unrelated download cannot be mistaken for the artifact. Node stores the bytes or imports the completed local path into `DATA_DIR/artifacts`. In interactive mode, `/open <index|artifactId>` downloads the artifact if needed and opens it with the OS default app (`open`, `xdg-open`, or Windows `start`).

ZIP, binary, and large artifacts keep the direct Blob/URL/`chrome.downloads` path and do not wait for preview UI when that direct capture succeeds. Text and table artifacts may use a two-step ChatGPT UI: clicking the artifact action opens a delayed preview as a fullscreen `role="dialog"`, a `[slot="content"]` library panel, or a spreadsheet-style `popcorn-toolbar` panel. Preview identity is fail-closed. The extension accepts an exact filename, an extensionless display title equal to the expected filename stem plus an adjacent format label such as `CSV`, or an arbitrary display title only when the exact artifact action was clicked and that format is unique among READY artifacts in the source assistant turn. It then scopes the multilingual download/close `aria-label` fallback to that proven container, waits through loader states, and closes the preview before processing the next artifact. The preview display title is registered as a temporary expected download-name alias, for example `test_data` + `CSV` becomes `test_data.csv`; aliases never replace the original expected filename and are accepted only after preview identity is proven. The observed CodeMirror text preview also has a bounded UTF-8 DOM fallback. A foreign or ambiguous preview is closed and reported immediately rather than triggering a blind retry.

## Normalized event model

`/chat?stream=1` emits only normalized lifecycle frames. Each SSE message uses `event: event`; the JSON payload's `type` identifies the canonical event.

Typical frames include:

```text
prompt.accepted
thinking.delta
thinking.snapshot
assistant.progress.snapshot
answer.delta
answer.snapshot
artifact.snapshot
request.result
request.error
```

`request.result` contains the authoritative full response object and closes a successful stream. `request.error` contains the typed terminal error and closes a failed stream. Intermediate deltas are observational updates, not an independent state machine.

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

The extension reconciles visible reasoning/status UI into logical items with stable IDs. A changing shimmer label updates the same active item; a completed `cot-v5` summary is emitted once even if React replaces its DOM node. Interactive mode keeps active items in the Live panel and appends completed items to the transcript once. Repeated DOM polls and forced snapshots do not create duplicate steps.

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

Canonical request diagnostics, including the committed snapshot, active deadlines, rejected events, and bounded transition history, are available per request:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:8080/diagnostics/request-state?requestId=<request-id>" | jq
```

Failed real E2E request waits save a sanitized replay trace in the scenario report directory. The trace can be added under `test/fixtures/request-replay/` as a deterministic reducer regression fixture after reviewing its redaction.

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

There is one authoritative observation pipeline, and it exists only while a canonical Bridge connection is active. After `server.hello`, a `MutationObserver`, navigation hooks, foreground signals, and bounded polling mark `main`/`[role=main]` dirty. Disconnect, authentication failure, or an unreachable server removes those hooks, timers, and the floating panel, leaving only the lightweight extension transport/bootstrap listener. One scheduler performs the stabilized parser pass and publishes an immutable revisioned `TabObservation`. Active requests and passive workflows consume that same snapshot and one shared turn-evidence classifier; passive mode adds only binding/baseline scope and bounded dedupe, not a second terminal policy.

The parser anchors the submitted user turn and follows the latest meaningful assistant turn after it, because ChatGPT may render reasoning, final text, and generated-file actions in separate assistant turn containers. Visible reasoning/tool/status blocks remain separate, and final answer text is extracted only from `[data-message-author-role="assistant"]`. This prevents persistent Python/tool output siblings from being mixed into final Markdown. Browser evidence includes stopped generation, final output, structural stability, blocker absence, turn identity, and artifact facts; only the server canonical reducer may interpret those facts as request completion or failure. If React replaces or virtualizes the scoped assistant turn, the next stabilized observation may rebind to a later request-owned assistant turn. Missing assistant DOM is never reported as a second content-side terminal error; server recovery and deadlines own liveness failure.

The observed DOM contract and parser invariants are documented in `docs/CHATGPT_DOM_PARSER.md`. Selector changes should be accompanied by sanitized phase fixtures under `test/fixtures/chat-dom/`. No page-context network hook is installed. Main-world artifact interception is armed only for one exact capture and is removed immediately on success, cancellation, timeout, or disconnect; `URL.revokeObjectURL` is never replaced, so ChatGPT-owned audio and media Blob lifecycles remain untouched.

Hidden internal reasoning that is not visible in the ChatGPT page is not exposed.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind host |
| `PORT` | `8080` | HTTP/WebSocket port |
| `API_TOKEN` | empty | If set, required for all HTTP API/debug endpoints |
| `ACTIVE_CLIENT_ID` | empty | Optional fixed browser-extension client/tab id |
| `AUTO_OPEN_TAB` | `0` | Open a dedicated ChatGPT tab when a normal request has no safe prompt target |
| `AUTO_OPEN_TAB_TIMEOUT_MS` | `30000` | Maximum wait for the token-matched auto-opened tab to connect |
| `AUTO_OPEN_TAB_BOOTSTRAP_WAIT_MS` | `2500` | Grace period for an existing extension tab to reconnect before using the system browser |
| `BRIDGE_TOKEN` | generated into `.env` on first startup | Token required by the browser extension companion |
| `ALLOWED_ORIGINS` | `https://chatgpt.com,https://chat.openai.com,null` | Accepted WebSocket origins when WS transport is used |
| `PAYLOAD_DEBUG` | `0` | Enable `/v1/chat/completions` payload dump |
| `PAYLOAD_DEBUG_FILE` | `./last_openclaw_payload.json` | Debug dump path when `PAYLOAD_DEBUG=1` |
| `ANSWER_TIMEOUT_MS` | `120000` | Compatibility/default meaningful-progress timeout used when `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` is not set. Weak heartbeat does not reset it. |
| `ANSWER_SETTLE_MS` | `1500` | How long answer text must stay stable before done |
| `ANSWER_DONE_SETTLE_MS` | `600` | Shorter answer-stability window after generation appears idle |
| `POST_STOP_TERMINAL_SETTLE_MS` | `900` | How long the completed action-bar state must remain stable after Stop disappears |
| `PROMPT_ACCEPTED_TIMEOUT_MS` | `10000` | Max wait for the extension content script to accept a prompt command |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Server ping interval for connected extension tabs; heartbeat is hard liveness, not meaningful request progress |
| `CLIENT_STALE_MS` | `30000` | Disconnect stale browser companion clients |
| `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` | `120000` | Long result-phase inactivity limit for a non-generating request; active generation is not stopped by this timer and heartbeat alone does not reset it |
| `REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS` | `60000` | Shorter inactivity limit after generation has stopped, for post-stop/final-snapshot/result/download/apply phases |
| `REQUEST_HARD_LIVENESS_TIMEOUT_MS` | derived | Detect source tab/content-script disconnection from heartbeat age |
| `REQUEST_GENERATION_ACTIVITY_GRACE_MS` | `30000` | Short grace after the last current generation signal; historical `sawGenerating` is not enough |
| `FORCED_SNAPSHOT_AFTER_MS` | `90000` | Request a source-bound assistant snapshot after stalled meaningful progress |
| `FORCED_SNAPSHOT_COOLDOWN_MS` | `60000` | Minimum delay between automatic forced snapshots |
| `FORCED_SNAPSHOT_TIMEOUT_MS` | `30000` | Timeout for one source-bound forced snapshot command |
| `DEBUG_EVENTS_LIMIT` | `250` | In-memory diagnostic event buffer size |
| `JSON_BODY_LIMIT` | `50mb` | Express JSON body size limit for prompts and base64 file uploads |
| `DATA_DIR` | `~/.bridge-data` | Local storage for uploaded files, downloaded artifacts, metadata, config, and interactive state |
| `ENV_FILE` | `<DATA_DIR>/.env` | Override the automatically loaded environment file path |
| `PUBLIC_BASE_URL` | `http://<HOST>:<PORT>` | Public URL embedded in signed local attachment links and setup output |
| `ATTACHMENT_TRANSPORT` | `url` | Attachment delivery mode used by the bridge; `url` keeps file contents out of command payloads |
| `PROMPT_DELIVERY_TIMEOUT_MS` | `30000` | Timeout for delivering `prompt.send` to the selected extension client |
| `REQUIRED_ARTIFACT_SETTLE_MS` | `30000` | Maximum post-generation wait for a required artifact to become materializable |
| `ARTIFACT_CHUNK_TIMEOUT_MS` | `60000` | Maximum idle wait while receiving a chunked artifact transfer |
| `ARTIFACT_RESOLVE_RETRIES` | `5` | Number of bounded retries when resolving a browser artifact action |
| `ARTIFACT_RESOLVE_RETRY_DELAY_MS` | `600` | Base delay between artifact-resolution retries |
| `ARTIFACT_RETENTION_COUNT` | `10` | Maximum number of retained downloaded artifacts before cleanup |
| `ARTIFACT_RETENTION_BYTES` | `262144000` | Maximum retained artifact bytes before cleanup |
| `ZIP_MAX_ENTRIES` | `5000` | Maximum number of entries accepted from an external ZIP |
| `ZIP_MAX_UNCOMPRESSED_SIZE` | `524288000` | Maximum total uncompressed bytes accepted from an external ZIP |

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
- Open an actual chat and use the floating `Bridge` button; it is hidden on non-chat pages.
- Make sure Server URL points to `http://127.0.0.1:8080`.
- Make sure the Bridge token matches `/setup`.
- The extension background worker owns localhost WebSocket transport automatically; there is no transport selector. Background schema-6 transitions are fail-closed: correctness-critical state and the exact immutable outbox envelope are committed atomically before execution or publication. Legacy v1-v5 storage keys are never adopted and are removed only after their records are confirmed idle. Unproved release cleanup quarantines the tab instead of making it reusable.
- Check `/debug/events` for `hello`, `page.status`, and diagnostic entries.

If `/health` says `needsSelection: true`:

- Run `/tabs` in interactive mode, or call `GET /browser/clients`.
- Select the intended tab with `/tab <clientId>` or `POST /browser/select`.

If the bridge rejects HTTP requests:

- Check the `Authorization: Bearer <API_TOKEN>` header.
- Check that your shell exported the same `API_TOKEN` as `.env`.

If the bridge rejects the extension connection:

- Check that the Bridge token in the floating panel matches `BRIDGE_TOKEN` from `/setup`.
- Check that Server URL points to the same host and port as the running bridge.
- Reload the extension and ChatGPT tab after changing extension files.
- Check `/diagnostics` or `/debug/events` for authentication, WebSocket, and `client.ready` errors.

If a manually attached file chip remains in the composer:

- Use `/file clear-ui` in interactive mode, or call `POST /composer/attachments/clear`.
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

Run the durability and recovery fault-injection matrix:

```bash
npm run test:faults
```

This gate injects persistence failures at background lease/command/effect/outbox/download transitions, verifies that browser and local writes are never repeated after an uncommitted outcome, table-tests exact browser-effect reconciliation evidence, and exercises pause/stop barriers, remote cursor redelivery, request terminal absorption, and strict download identity.

Every production bug found by authenticated E2E must be converted into a deterministic local regression before the fix is considered complete. Cross-layer failures should use the smallest realistic integration boundary that reproduces them, including manifest-order content startup, server-to-background command correlation, release barriers, content reload reconciliation, or canonical request settlement. E2E remains release verification rather than the first or only detector for a known failure mode.

Run the complete deterministic release gate and write a JSON/Markdown report:

```bash
npm run verify:release:local
```

A full release environment can additionally prove a clean install and run the fixed authenticated browser matrix:

```bash
npm run verify:release -- --reload-extension
```

Use `npm run verify:release:live -- --reload-extension --capture-page-layout` when dependencies are already installed. This checks and updates the extension only when needed, runs the authenticated parser/smoke/reasoning/steer/reload/ZIP/layout/workflow/quarantine matrix, and retains sanitized layout diagnostics; use `--force-reload-extension` for an intentional restart. The live gate requires a logged-in browser profile with the unpacked extension and fails explicitly when no compatible extension client is connected.

Run coverage with the current core/API threshold:

```bash
npm run test:coverage
```

The coverage script uses Node's built-in test runner with `--experimental-test-coverage` and enforces `--test-coverage-lines=70` for `src/**/*.js`. It also executes the full test suite, so any functional test failure makes the coverage command fail even when measured line coverage is above the threshold.

## Notes and limitations

The bridge automates the ChatGPT Web UI, so it can still break if ChatGPT changes the page structure. The extension background/content-script architecture avoids fragile Chromium debug sessions and page-CSP WebSocket failures, but it is not equivalent to the official OpenAI API.

The OpenAI-compatible endpoint still forwards the last user message as the main prompt, but it now also extracts file ids and data-URL images from modern multimodal content parts. System messages, tool calls and structured output schemas are not implemented.

## Codex-like app-server mode

The bridge now uses Codex-inspired names for the automation core:

```text
thread  = long-lived work session / conversation
turn    = one user request and one ChatGPT execution
item    = user message, reasoning, assistant message, artifact, etc.
```


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
GET  /turns/:id/events?stream=1&recent=0&wait=1
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

For live consumers, open `GET /turns/:id/events?stream=1&recent=0&wait=1` **before** creating the turn. The endpoint emits `ready` even when the turn does not yet exist, then streams committed progress, reasoning, final-message, and terminal events in order. Progress snapshots include `logicalId`, `text`, `revision`, state/visibility fields, and matching completion wrappers.

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

Use `/chat` when you want a direct prompt without attaching the project ZIP:

```text
bridge> /chat What is the purpose of AGENT.md in this project?
```

`/chat` uses the current browser session and does not upload the project archive.

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
/chat <prompt>
/result
/recover [--force|--apply]
/recover [--force|--apply]
/result download [path]
/apply [--plan|--interactive|--force]
```

Typical flow:

```text
bridge> /project session new
bridge> /skills enable nodejs tests
bridge> Fix the failing login test and return an updated project ZIP
...
[result] ready updated-project.zip
bridge> /apply
Safety warnings are shown if the project is not a git repository, if the git worktree has uncommitted/untracked files, or if a file changed locally after the snapshot was sent. Default `/apply` asks once for the whole sync plan. It does not ask for every ordinary changed file. Use `/apply --interactive` when you want to choose individual updates/deletes. The ZIP stays available and can be applied later with `/apply`.

If the CLI disconnects while ChatGPT is still generating, use `/resume` after reconnecting to the same ChatGPT tab to attach to the active prompt and keep streaming through the normal pipeline. If the bridge process, CLI, browser companion, or request lifecycle fails while ChatGPT continues and eventually finishes the answer, use `/recover` after reconnecting to the same ChatGPT tab. Recovery asks the companion to read the latest visible assistant message, re-registers its artifacts, and resolves the ZIP result into the last project turn. Use `/recover --apply` to recover and immediately run the normal safe apply flow, or `/recover --force` to overwrite an already completed local turn with the latest visible answer.
```

`/apply` synchronizes the last ZIP result back into the opened project. It validates the archive before extraction, strips a common top-level folder such as `project/`, skips `.git`, `.bridge`, and `node_modules` entries, creates new files, updates changed files, and deletes files that were part of the original project snapshot but are absent from the result ZIP. Ignored files and files that were never sent in the original snapshot are not deleted. Ordinary updates are applied after one common confirmation. Locally changed files after snapshot are highlighted as conflicts. `/apply --plan` prints the plan without writing, `/apply --interactive` asks per update/delete, and `/apply --force` applies without confirmation.

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

| Variable | Default | Description |
| --- | --- | --- |
| `PROJECT_MAX_FILES` | `2000` | Maximum number of project files included in one snapshot |
| `PROJECT_MAX_ZIP_BYTES` | `52428800` | Maximum generated project snapshot ZIP size |
| `PROJECT_MAX_SINGLE_FILE_BYTES` | `1048576` | Maximum size of one source file included in a project snapshot |
| `PROJECT_CONTEXT_MAX_SYMBOLS` | `2000` | Maximum number of indexed symbols written into project context |
| `PROJECT_TREE_LIMIT` | `500` | Maximum number of paths rendered in the project tree summary |

Built-in excludes cover common dependency folders, build outputs, IDE metadata, caches, virtual environments, logs, archives, macOS metadata, and secret-looking files such as `.env` / `.env.*`. `.gitignore`, `.ignore`, and `.bridgeignore` are also applied.


## Extension reliability notes

The supported extension path avoids large inline command payloads and keeps privileged browser operations outside the ChatGPT page context.

For input attachments, stored bridge files are normally exposed through short-lived signed localhost URLs. The extension background worker fetches them outside page CSP and the content script attaches the resulting `File` objects to the ChatGPT composer.

For output artifacts, the content script can return a small artifact inline or stream larger data in protocol chunks:

```text
artifact.data.started
artifact.data.chunk
artifact.data.done
```

For page-generated Blob/data artifacts, a small MAIN-world bridge captures the generated bytes around the scoped click and avoids a duplicate temporary download. Direct or newly exposed URLs are fetched as the next path. If the action starts a normal browser download, the background worker captures only a download whose filename matches the expected artifact, returns its local path, and ignores unrelated downloads. All unused capture paths are cancelled. Node imports the result into `DATA_DIR/artifacts` and validates ZIP outputs before selection/apply.

Generated-file actions are selected by exact filename or by a stable block/action locator inside the source assistant turn. `selectorHint` is never treated as identity because several file buttons can share the same CSS path. Artifact materialization has a 45-second browser-side budget and a 60-second server envelope; it waits for concrete DOM/download state changes with bounded backoff and fails immediately when a different filename preview proves that the wrong action was selected.

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
ARTIFACT_CHUNK_TIMEOUT_MS=60000
```


## Local and real-browser E2E

The preferred E2E entry point is deterministic and local. It starts the real Bridge server, connects a Protocol 5 mock extension participant, serves an interactive ChatGPT-shaped page, and runs the same registered scenario functions used by the authenticated browser matrix:

```bash
npm run test:e2e:local
```

The local runtime covers request ownership, BrowserEffect command settlement, immutable observations, reasoning progress, steering, reload recovery, quarantine isolation, artifacts, workflows, multi-bridge transport, project context, and cleanup. It does not replace the live compatibility check for Chrome platform behavior or current ChatGPT selector drift. See `docs/LOCAL_E2E.md` for the state-machine and layout contracts.

Useful focused commands:

```bash
npm run test:e2e:local:fixtures   # captured DOM/reducer replay plus mock layout/contract tests
npm run test:e2e:local:core       # request, parser, steering, reload, quarantine, artifacts, projects
npm run test:e2e:local:workflows  # passive, approval, remediation, and remote-worker workflows
npm run test:e2e:mock             # all scenarios, without the fixture preflight
npm run mock:chatgpt              # interactive visual fixture server only
```

The authenticated runner remains the final product/platform compatibility matrix:

The real E2E runner is intentionally separate from `npm test`: it uses the logged-in ChatGPT account, sends actual messages, creates a real conversation, and asks ChatGPT to generate a real downloadable file.

Before running it, install or reload the extension from `tools/chrome-bridge-extension` and make sure the browser profile is logged into ChatGPT. Then run:

```bash
npm run test:e2e:real
```

The default terminal view keeps lifecycle milestones, warnings, and failures while hiding known high-frequency browser diagnostics. Use `--verbose` only when the complete live event stream is useful:

```bash
npm run test:e2e:real -- --verbose
```

No diagnostic evidence is discarded in the default mode. Every parsed browser event is written to `browser-debug.ndjson`, and the final report ZIP uses lossless DEFLATE compression. Large repetitive JSON/NDJSON traces therefore remain fully recoverable without producing an uncompressed tens-of-megabytes archive.

The runner also exposes stable, independently runnable scenarios. List them with:

```bash
npm run test:e2e:list
```

A short basic pair is available as `npm run test:e2e:smoke`; it runs `conversation` plus `model-effort`.

Common focused runs:

```bash
npm run test:e2e:conversation
npm run test:e2e:response-markdown
npm run test:e2e:reasoning-lifecycle
npm run test:e2e:model-effort
npm run test:e2e:reasoning-steer
npm run test:e2e:files
npm run test:e2e:zip
npm run test:e2e:artifacts
npm run test:e2e:passive-workflow
npm run test:e2e:workflow-approval
npm run test:e2e:workflow-remediation
npm run test:e2e:workflow-multi-bridge
npm run test:e2e:workflows
npm run test:workflow:multi-bridge    # deterministic two-process integration without Chrome
npm run test:e2e:project-context
npm run test:e2e:project-no-context
npm run test:e2e:project
npm run test:parser-fixture              # deterministic captured-DOM fixture; optional Chromium part uses CHROMIUM_BIN
npm run test:e2e:capture-dom             # rebuild captured DOM fixtures in the standard test directory
npm run test:e2e:local:fixtures          # replay captured DOM/reducer traces and validate the mock layout contract
npm run test:e2e:local                   # run fixture preflight plus the complete deterministic E2E matrix
```

Workflow waits are deliberately bounded. Each workflow stage has a 120-second absolute deadline by default, and a started pipeline fails after 60 seconds without committed progress:

```bash
npm run test:e2e:workflows -- \
  --workflow-wait-timeout-ms 120000 \
  --pipeline-idle-timeout-ms 60000
```

The absolute deadline also covers the case where ChatGPT visibly produced a ZIP but the passive observer never published a terminal turn. The shorter pipeline-idle deadline applies only after download/verification/apply has started. The first `Ctrl+C` aborts active waits, marks the run and current scenario as `interrupted`, cancels canonical browser requests and running turns, performs ordinary session/tab cleanup, writes the final report and ZIP bundle, removes `RUNNING.json`, and exits with code 130. A second `Ctrl+C` forces immediate exit when cleanup itself is stuck.

### Capturing live ChatGPT DOM for offline tests

The capture mode records real markup from the scoped assistant turn and semantic parser expectations. When diagnostics contain a self-contained canonical transition sequence beginning with `request.created`, it also records a reducer trace. It does **not** save the complete ChatGPT page, sidebar, account menu, or unrelated conversations.

Rebuild the standard captured-DOM corpus with one command:

```bash
npm run test:e2e:capture-dom
```

This removes the previous generated corpus and writes the new fixtures to `test/fixtures/chat-dom/captured/generated/`. Verify only the collected fixture corpus locally, without running the scenario matrix, with:

```bash
npm run test:e2e:local:fixtures
```

Run the complete deterministic Protocol 5 scenario matrix with:

```bash
npm run test:e2e:local
```

To capture a focused scenario:

```bash
npm run test:e2e:real -- \
  --scenario response-markdown \
  --capture-dom-fixtures
```

Direct `test:e2e:real` captures are written below the run report directory in `dom-fixtures/` unless an explicit output directory is supplied. Use an explicit directory for a focused reviewed fixture set:

```bash
npm run test:e2e:real -- \
  --scenario response-markdown \
  --capture-dom-fixtures \
  --fixture-output-dir test/fixtures/chat-dom/captured/2026-07-response-markdown
```

Each captured request contains sanitized `*.html` and a `*.fixture.json` semantic parser expectation. When canonical diagnostics contain a self-contained transition sequence beginning with `request.created`, capture also writes `request-trace.json`; truncated traces are skipped. URLs, tokens, message/turn identifiers, email addresses, run ids, and dynamic markers are replaced before writing. Review every promoted fixture before committing it.

`npm test` automatically executes captured HTML through the actual artifact, response, and turn parser modules without Chrome. It also replays captured canonical traces through the request reducer. A recurring live parser or lifecycle regression should be represented by one of these fixtures instead of being fixed only in a browser wait. The reviewed offline corpus includes generated `response-markdown` and `reasoning-lifecycle` timelines plus a required-ZIP scenario that pairs sanitized artifact markup with a self-contained canonical reducer trace. A corpus gate requires both the ZIP parser fixture and its sibling `request-trace.json`.

### Capturing sanitized page structure for E2E diagnostics

Use the explicit layout flag when a live failure depends on page structure outside one assistant turn, such as the composer, model picker, sidebar, dialogs, or the extension panel:

```bash
npm run test:e2e:real -- --capture-page-layout
# Alias:
npm run test:e2e:real -- --capture-layout
```

The runner captures a structural snapshot after startup, before and after each selected scenario, at the failure boundary before recovery, and during finalization. Files are written under `page-layout/` in the normal report directory and indexed by `page-layout/index.json`. Identical snapshots are deduplicated by SHA-256.

This is diagnostic evidence, not a fixture corpus and not a raw page dump. Message bodies, chat titles, account labels, composer/input values, media sources, conversation identifiers, query strings, and unstable element ids are removed or replaced. The snapshot retains selector-relevant structure such as tag names, classes, `data-testid`, ARIA state, visibility, computed display/position, and rounded element rectangles. Review captures before sharing them despite the sanitizer.

Layout capture is a read-only standalone command and never receives or creates a request lease. It may run while a request owns the tab, but a stale request ID in diagnostic metadata remains correlation data only. A capture error is recorded in the index and does not replace the original scenario failure.

The workflow E2E group synchronizes one shared project identity once per owned conversation. Its per-scenario report includes `workflow-progress.json`; waits poll the committed workflow v3 lifecycle, phase, and `nextAction`, and fail immediately when a correlated canonical outcome makes the target impossible. SIGINT/SIGTERM finalize the report as `interrupted`.

The same selection is available directly through repeatable `--scenario` / `--scenarios` options. Comma-separated values and aliases are supported:

```bash
npm run test:e2e:real -- --scenario parser
npm run test:e2e:real -- --scenario conversation,model-effort
npm run test:e2e:real -- --scenario artifacts
npm run test:e2e:real -- --scenario workflows
npm run test:e2e:real -- --scenario project
```

A run with one selected scenario writes to `.bridge-data/e2e/<scenario-id>/` by default, so its report does not overwrite another focused scenario. A full run still uses `.bridge-data/e2e/last-real-e2e/`. An explicit `--report-dir` always takes precedence.

Each invocation creates one minimal owned-conversation bootstrap before running the selected scenarios. The bootstrap is setup rather than a reported scenario: it establishes the exact `sessionId` and canonical URL required for safe cleanup, removing the former hidden dependency on the conversation test running first.

If a scenario fails while its source tab is still generating or owns an active request, the runner reloads only that isolated tab using the existing request lease and waits for a replacement protocol hello plus an idle, ready composer before starting the next scenario. This prevents one failed passive prompt from cascading into unrelated project tests. Text and structured artifact assertions are format-semantic: JSON is parsed, and optional final newlines or CRLF/LF differences do not fail text/CSV checks. Binary formats remain byte/signature validated.

Reasoning lifecycle retries are evaluated as retries: an incomplete first observation does not fail the scenario when a later isolated attempt contains the full required sequence. The scenario fails or becomes inconclusive only when no completed attempt exposes all required checkpoints.

The reasoning scenario also verifies the **public** turn stream. It opens SSE before creating the turn, requires separate ordered `0%` through `100%` updates over meaningful elapsed time, requires `100%` before the final assistant message and terminal event, and verifies completion wrappers for every logical progress item. The raw public records and validation result are written to `scenarios/reasoning-lifecycle/public-progress-events.json`; a complete DOM timeline alone cannot make this check pass.

Every prompt is explicitly pinned to the newly created `sourceClientId`; the runner never relies on whichever unrelated tab happens to be selected. The runner performs these end-to-end checks through the public bridge API and the real page DOM:

1. sends a direct prompt and verifies the exact final answer;
2. sends a follow-up to the same concrete ChatGPT session and verifies conversation continuity;
3. `response-markdown` returns deterministic mixed Markdown and verifies paragraph boundaries, inline code, per-block fenced-code languages, exact code text, semantic block order, terminal leaf ownership, zero unknown content, and 100 percent parser coverage;
4. `reasoning-lifecycle` independently verifies visible DOM reasoning and the pre-subscribed public SSE contract, including live ordered `0%` through `100%`, completion wrappers, and ordering before the final/terminal events; the `parser` scenario group runs both parser scenarios;
5. `model-effort` reads the visible picker state, switches to a different model and then a different effort by default, confirms each real change, verifies short exact answers, and restores the original selection; explicit flags still test exactly the requested values;
6. the remaining scenarios independently verify active-request steering, multiple generated files, a deterministic ZIP, project context/skills, multi-turn ZIP modification, and snapshot reuse;
7. every artifact-producing scenario audits Chrome-backed source cleanup and confirms that the exact captured file no longer exists after safe import and deletion.

Tab creation is automatic and uses the same bridge-level auto-open mechanism as ordinary requests. By default the runner starts an isolated bridge on a free loopback port with a separate temporary data directory, so an ordinary bridge already using `8080` cannot be mistaken for the test server. The system-opened ChatGPT URL briefly carries both a one-time `chatgpt-bridge-launch` token and the isolated `chatgpt-bridge-server` address. Extension 2.3.0 using Protocol 5 validates the loopback address, connects only that tab to the E2E bridge, and removes both launch parameters from the address bar. The current E2E suite requires extension 2.3.0 with content runtime 4.3.0. The `reload-mid-request` scenario has an independent ten-minute wall-clock ceiling even when the global turn limit is disabled. Unit-test workers and real E2E bridge/worker processes explicitly suppress terminal bells and native desktop notifications; test failures are reported only through their normal console and report outputs. The first Ctrl+C starts graceful cleanup; an immediate duplicate signal from the process group is ignored, and a later deliberate Ctrl+C forces exit. The bridge accepts only the exact token reported by the extension handshake or adopted from that exact launch URL; unrelated reconnecting tabs are ignored. Canonical extension-reload recovery opens a replacement tab with a stable `bridge-recovery-*` token; `bridge-reload-*` remains reserved for temporary connection handoff and is never accepted as tab ownership. If the launch parameters remain visible after the page loads, reload the unpacked extension and reload the ChatGPT tab because stale content-script code is still running.

A reloaded content script receives only the background lease/effect recovery journal. It rebuilds a complete request projection before sending the replacement protocol hello. The real E2E runner follows the owned Chrome tab across content epochs by tab ID plus launch token; the content client ID is intentionally treated as ephemeral. When an owned tab does not complete its replacement hello, the active scenario is the single infrastructure root failure and later browser-dependent scenarios are reported as blocked rather than failed independently.

By default the runner cleans up only the conversation it created. It stores the concrete `sessionId` and canonical `/c/<id>` URL returned by the first real response, verifies that the same source tab is still on exactly that URL, and sends both values to the content script. The content script repeats the check before opening the conversation menu, before clicking Delete, and before confirming. If any identity check fails, cleanup is refused, the tab is left open, and the test fails rather than risking another chat. After confirmed deletion, only the E2E tab is closed.

Browser-downloaded artifact sources are cleaned separately and with stricter file identity checks. The bridge first copies the completed file into its artifact store. It removes the source only when Chrome supplied the exact absolute path, download id and actual filename, the file creation time falls inside the current capture window, the expected size matches, the path is a regular file rather than a symbolic link, and device/inode plus all timestamps are unchanged after import. If a page Blob/URL path returns first but the same click has already received a `chrome.downloads` id, the browser capture is retained and becomes authoritative; this prevents the fast path from abandoning the only identity that can safely remove the physical Downloads file. Missing or conflicting evidence emits `artifact.download.source_cleanup_skipped` and leaves the source untouched. The real E2E runner audits every fetched artifact: page-only captures require no filesystem cleanup, while a `chrome-downloads` capture must report exact-source removal and an immediate `lstat` must confirm that the registered path is absent. It never scans or deletes by a broad filename mask.

Artifact discovery rejects links that navigate to the current ChatGPT conversation; those links are page navigation, not file URLs. Action artifacts are materialized by clicking their scoped action even when an anchor exposes a misleading current-page `href`. ZIP selection uses filename, MIME, action label, block text, and format metadata and never falls back to an unrelated first artifact when a ZIP predicate has no match. All direct byte sources are validated against the expected binary signature before they can win materialization.

Keep the conversation and tab for manual inspection with:

```bash
npm run test:e2e:real -- --keep-session
```

Useful options:

```text
--timeout-ms <ms>          timeout for short bridge control calls, default 30000ms
--prompt-timeout-ms <ms>   optional absolute timeout for synchronous prompts; 0 means no client-side total limit
--result-idle-timeout-ms <ms> fail only after no observable result progress, default 300000ms
--turn-max-timeout-ms <ms> optional absolute turn limit; 0 means disabled
--artifact-timeout-ms <ms> artifact materialization timeout, default 45000ms, maximum 60000ms
--report-dir <path>        diagnostics directory
--port <port>              explicit port for the auto-started E2E bridge; default is a free random port
--base-url <url>           use a specific existing or auto-started loopback bridge
--scenario <id>            scenario to run; repeat or pass comma-separated ids/aliases
--list-scenarios            print scenario ids and aliases without starting bridge/browser
--model <label-or-id>      model to verify in model-effort; repeat or pass comma-separated values
--effort <value>           effort to verify in model-effort; repeat or pass comma-separated values
--tab-ready-timeout-ms     timeout waiting for the real composer to become stable
--tab-settle-ms <ms>       extra pause after page readiness
--strict-reasoning         fail when no visible reasoning is exposed after both attempts
--capture-dom-fixtures      save sanitized assistant-turn DOM, parser expectations, and canonical traces
--capture-page-layout       save sanitized structural page snapshots at startup and scenario boundaries
--fixture-output-dir <path> override the fixture directory and enable DOM capture
--reload-extension        deploy and reload only when extension files or versions differ
--force-reload-extension  reload even when the connected bundle is already current
--no-reload-extension     skip the startup extension reload prompt
--no-start-server          require an already running bridge
--no-open-browser          disable the OS browser fallback
```

For example:

```bash
npm run test:e2e:model-effort
npm run test:e2e:model-effort -- --model "GPT-5.6 Thinking" --effort high
npm run test:e2e:model-effort -- --models "GPT-5.6 Thinking,GPT-5.6" --efforts "medium,high"
```

Without explicit values, `model-effort` must prove a real state transition: it selects a different model, re-reads the picker, then selects a different effort and re-reads that picker. A final guarded turn restores the original model and effort so the E2E does not leave account UI state changed. Explicit models and efforts form a bounded Cartesian matrix of at most 12 real turns and test exactly the supplied fields. Every case verifies the exact response marker and the corresponding `model.apply.started` / `model.apply.done` confirmation.

Full-suite diagnostics are project-local at `.bridge-data/e2e/last-real-e2e/`. A focused scenario or a single group alias uses `.bridge-data/e2e/<scenario-or-alias>/`; each directory has a sibling uploadable ZIP bundle. `console.log`, `RUNNING.json`, `report.partial.json`, and `timeline.partial.ndjson` are created before the first real prompt, so a failed or interrupted run still leaves useful evidence.

`response-markdown` prints the path of a live `parser-observation.txt` file as soon as its turn starts. The file is appended on every meaningful DOM snapshot and contains raw visible assistant text, ordered parsed blocks, reasoning/progress, artifact content, excluded interface leaves and controls, unknown nodes, duplicate ownership, and coverage. Its final section is labelled `FINAL TERMINAL SNAPSHOT`, allowing direct manual comparison with the ChatGPT UI even when the parser and the expected fixture do not know a future component type.

The same scenario writes `parser-audit.json`, `response-blocks.json`, `reasoning-blocks.json`, `unknown-nodes.json`, `terminal-dom.html`, `raw-dom-timeline.json`, `parsed-timeline.json`, `stored-items.json`, `turn-events.json`, `expected-answer.md`, `final-answer.md`, `response-parsing-diff.json`, and `code-block-dom-context.json`. Unknown visible content is retained as an explicit `unknown` block in ordinary parsing but fails strict E2E; no visible leaf may have zero or multiple owners. Streaming snapshots are audited for ownership consistency, while exact text and 100 percent coverage are required only from the terminal snapshot because React may legitimately rerender incomplete Markdown.

`reasoning-lifecycle` writes its own timeline/item/event JSON files. In a combined alias run diagnostics live under scenario-named subdirectories, so a Markdown failure cannot suppress reasoning validation. Finalization includes every completed diagnostic file in the ZIP, writes `report.json`, `SUMMARY.md`, and `timeline.ndjson`, then verifies that every primary output is non-empty.


### ZIP completion guard and bounded artifact waits

A completed ChatGPT answer may contain source code mentioning filenames as well as one real downloadable ZIP. Generic code-block controls such as Copy buttons can expose `data-state="closed"`; this is not artifact lifecycle evidence. The parser now creates state-only artifacts only from explicit busy/progress/loading/error signals, so filenames inside adjacent code cannot become phantom `GENERATING` artifacts that keep the turn open.

A required ZIP contract is satisfied by explicit ZIP metadata, by a READY action whose own display title semantically identifies a ZIP/archive, or by one extensionless READY action scoped to the completed assistant turn. The last case proceeds directly to materialization and byte-level ZIP validation, which is necessary for labels such as “Download the complete updated project”. A clearly named non-ZIP action (`result.txt`, `video.mp4`, `bundle.tar`, and similar) and multiple generic actions remain insufficient. Ambient prose mentioning `result.txt` does not disqualify a generic project-download button because only the action's direct identity is used for the non-ZIP check. Once generation is terminal, the server probes for a genuinely missing required artifact with bounded backoff (`0.5s`, `1s`, `2s`, `4s`, then at most `5s`) and a hard 30-second post-generation limit. The E2E runner no longer imposes a fixed total duration on turns: it watches turn events and active-request progress, fails after five minutes of inactivity by default, and has no absolute turn limit unless `--turn-max-timeout-ms` is set. Artifact materialization remains bounded to 45 seconds by default and cannot exceed 60 seconds. A known identity mismatch or other proven fatal state returns immediately instead of consuming the remaining timeout.

A manual browser download cannot be retroactively associated with a bridge fetch unless the fetch command has already armed its capture ID. The bridge therefore completes the response from the READY artifact first and only then starts the source-bound download command.

## Recovery and apply improvements

If the bridge process, terminal UI, or local server exits while ChatGPT is still working, the browser tab may still finish successfully. The interactive UI can recover from the visible ChatGPT DOM after restart:

```bash
bridge
/recover list
/recover 1
/recover 2 --apply
/recover list
/recover 2 --apply
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
```

The command still uses the normal project apply safety checks, `.bridge`/ignored-file protection, conflict detection, and optional `--plan`, `--interactive`, or `--force` flags.

## Terminal UI details

The default `bridge` Terlio UI supports a richer command input and a dedicated scrollable chat surface:

- type `/` to show commands immediately, with usage and short help on each row;
- after a command is completed, the same list shows contextual subcommands, flags, IDs, and values;
- use ↑/↓ to move vertically inside multiline input first, then through active suggestions, and through persistent history only from an empty editor or unchanged recalled entry;
- press `Tab` to complete the highlighted command or parameter; `Enter` executes an exact command that is valid without extra arguments, such as `/workflow`;
- command suggestions use a bounded window directly above the editor only while visible; the transcript viewport temporarily shrinks instead of losing permanent space;
- use `PgUp`/`PgDn`, `Shift+↑`/`Shift+↓`, and `Ctrl+Home`/`Ctrl+End` for the visible scrollable pane; mouse wheel/trackpad and scrollbar click/drag use the same scroll state;
- drag across transcript rows for multiline selection, then short-click the highlight to copy it;
- the chat follows streaming output only while it is already at the bottom;
- use `Ctrl+B` or `/info` for the complete keyboard reference plus connection, project, session, workflow, and navigation details; press `Esc` to close it;
- while a request is running, `Ctrl+C` asks whether to cancel the ChatGPT prompt or detach/exit and leave it running in the browser;
- current thinking and progress remain a live response section, while assistant answer chunks update one in-place streaming transcript entry until completion; wide terminals also summarize activity in the right column.

### Recovery notes: inline artifact buttons

ChatGPT can render a downloadable result as an inline markdown button rather than an `<a href>` link. A common example is a button labelled “Download the updated ZIP”. In extension mode, `/recover list` and `/recover <n>` now scan recent assistant turns, assistant message roots, and artifact-bearing markdown fallback nodes. Such buttons are returned as action artifacts, and `/recover <n> --apply` can click the matching button with `chrome.downloads` capture armed, import the completed local download into `DATA_DIR/artifacts`, and run the normal safe project apply flow.

Manual ZIP apply is still available when you downloaded the result yourself:

```bash
/apply /path/to/result.zip
/apply /path/to/result.zip --plan
/apply /path/to/result.zip --interactive
```

### Terminal input navigation

The Terlio input editor grows from one to five visual rows and behaves like a multiline line editor:

- `Left` / `Right`: move by character.
- `Backspace` / `Delete`: edit at the cursor.
- `Ctrl+Left` / `Ctrl+Right`: move by word on PC/Linux terminals.
- `Option+Left` / `Option+Right`: move by word on macOS when the terminal sends `Esc-b` / `Esc-f` or common CSI modifier sequences.
- `Up` / `Down`: move vertically inside multiline or wrapped input before completion/history navigation.
- `Shift+Up` / `Shift+Down`: scroll the transcript or details pane by one line.
- `Home` / `End`, `Ctrl+A` / `Ctrl+E`, and common Cmd-arrow terminal mappings: jump to the beginning/end of the line.
- `Backspace` is handled through both terminal key metadata and raw `\x7f` / `\x08`, so it should not insert visible control characters.
- Bracketed and raw multiline paste are accepted. Paste blocks over 250 symbols render compactly as one token while preserving their exact submitted content; Backspace/Delete expands the token rather than discarding it.
- Submitted prompts and Esc-cancelled drafts are persisted in history scoped to the project root or current directory.

Command suggestions use a bounded window rendered directly above the editor only while completion is active. The main transcript keeps all available rows when suggestions are absent and temporarily shrinks while they are visible. Each command and parameter has short inline help; no-argument command variants are selectable explicitly. Theme rows preview their palette while selected and restore the previous palette on cancellation.

## Real ChatGPT E2E matrix

The opt-in browser E2E suite uses a logged-in ChatGPT tab and real model requests:

```bash
npm run test:e2e:real
```

It opens an isolated tab automatically when the extension supports browser tab control. Canonical prompts and steering carry the request lease, while diagnostics, artifact fetches, session cleanup, and maintenance are standalone background commands that never create request ownership. The shared command manifest assigns every command an explicit reload-recovery class. A command durably registered but not dispatched is reported as `proved_not_started`. Passive prompt submission, session selection, tab reload, model/effort application, attachment clearing, artifact fetch, and extension maintenance are reconciled from kind-specific evidence. Session deletion requires explicit proof that the target is absent and never treats navigation as deletion; session creation and tab open/close remain typed uncertainty after an ambiguous dispatch. No unsafe write is replayed because a result was lost. A timed-out standalone operation is cancelled and settled before the runner advances, preventing one artifact or cleanup command from poisoning later scenarios. Before the first submission it waits until the document, scoped chat root, and composer are visible and stable, then applies a short settle delay. Immediately before clicking Send, the content runtime records the exact set of visible turn keys and arms output capture; model/session/file preparation cannot bind a new bridge request to the previous response. The new user turn must also match the submitted prompt text, allowing attachment chips as separate lines but rejecting an unrelated new turn. Every prompt submission is attempted once and then checked against real DOM evidence. If the write cannot be proved, it becomes an uncertain browser effect and enters canonical recovery; the extension never clicks Send again speculatively. The suite verifies deterministic conversation continuity, visible reasoning/progress parsing, terminal completion, an in-flight steer command that overrides the original final-answer rule, optional model/effort combinations, two-tab quarantine isolation with unrelated work continuing on the safe tab, multiple downloadable files, one deterministic ZIP, project `AGENT.md` and enabled skill instructions, multi-turn modification of a previous result, unchanged project snapshot reuse without re-attaching the input ZIP, and the absence-safe path when no agent or skill exists.

Visible reasoning means only reasoning summaries, progress, and tool/status items actually rendered by ChatGPT. Hidden chain-of-thought is not accessible. By default, a run with no visible reasoning item records that scenario as inconclusive; use `--strict-reasoning` when absence of visible reasoning should fail the run. Prompts that need continuity explicitly say that the marker must stay only in the current conversation context and must not be added to account-wide ChatGPT memory.

The suite writes:

- `.bridge-data/e2e/last-real-e2e/console.log`
- `.bridge-data/e2e/last-real-e2e/RUNNING.json` while active
- `.bridge-data/e2e/last-real-e2e/report.partial.json`
- `.bridge-data/e2e/last-real-e2e/timeline.partial.ndjson`
- `.bridge-data/e2e/last-real-e2e/report.json`
- `.bridge-data/e2e/last-real-e2e/SUMMARY.md`
- `.bridge-data/e2e/last-real-e2e/timeline.ndjson`
- `.bridge-data/e2e/last-real-e2e/page-layout/index.json` when `--capture-page-layout` is enabled
- `.bridge-data/e2e/last-real-e2e.zip`

Upload the ZIP diagnostic bundle when a live run fails. It includes scenario results, turn items, completion and steer events, artifact metadata and hashes, project packaging/reuse evidence, and bridge/debug events. With `--capture-page-layout`, it also includes deduplicated sanitized structural snapshots and their index.

Use `--keep-session` to leave the verified conversation and E2E tab open. Otherwise cleanup is fail-closed: the runner deletes only when both the current source-tab URL and session id match the conversation it created.

### Locale-independent E2E cleanup and real steer turns

ChatGPT may implement an in-flight steer as a new user turn followed by a new assistant turn. The current bridge re-anchors the existing request to that pair, so the final steered answer is not confused with the original assistant placeholder.

Automatic E2E cleanup does not depend on the interface language. It verifies the exact conversation URL/session, opens a structurally identified conversation menu, requires a stable conversation-delete `data-testid`, and scopes confirmation to the newly opened destructive modal. Visible menu/button text is recorded for diagnostics but is never used to authorize deletion. If the expected structure is absent, cleanup stops and leaves the chat open.


## Long-turn E2E waiting and delayed deletion confirmation

The real E2E runner treats result generation, post-generation processing, artifact materialization, and short control calls as separate wait domains. While the source tab reports active generation, there is no default absolute deadline, so a half-hour reasoning/tool run remains valid even when visible text changes slowly. Before completion, a non-generating result wait fails only after five minutes without observable progress. Once generation has stopped and the turn enters post-stop, artifact, result, download, or apply processing, a separate 60-second inactivity watchdog applies. Artifact materialization is independently bounded to 45 seconds, while ordinary HTTP control calls remain bounded to 30 seconds. Synchronous `/chat` and `/sessions/:id/messages` E2E calls have no client-side total timeout by default.

When a run fails, the final console section is `E2E FAILURE SUMMARY`. `FAILED` lines identify failed scenarios, cleanup, or the aggregate run failure. `ERROR` lines list deduplicated browser/runtime diagnostics such as `tab_observer.collect_failed` or canonical runtime errors, so the root `ReferenceError` or `TypeError` is visible at the end instead of being buried earlier in the log. The same entries are stored in `report.json` under `failureSummary`.

Conversation cleanup waits for the confirmation dialog and its stable destructive action with bounded exponential backoff for up to ten seconds. The outer exact-URL/source-bound deletion command has three attempts with `500ms`, `1000ms`, and `2000ms` delays. A final two-second URL-removal grace handles deletion completing immediately after the last dialog probe. These waits never relax session URL or source-client verification.


### Readable and colored real-E2E logs

The real-browser runner prints a structured live trace instead of only high-level prompt timestamps. Each line includes elapsed time, a status, scenario scope, a clear action or wait condition, and relevant fields:

```text
00:08.420  ⌕ SEARCH [model-picker] Located possible Intelligence menu triggers  count=2
00:08.567  ▶ ACTION [model-picker] Activating Intelligence menu trigger once  attempt=1  method=pointer-click
00:08.568  … WAIT   [model-picker] Waiting for Intelligence menu to become visible and stable  timeoutMs=1300
00:09.031  ✓ OK     [model-picker] Intelligence menu is open and stable  elapsedMs=463
00:10.114  ▶ ACTION [model-picker] Clicking model option once  requested=GPT-5.5
00:11.509  ✓ OK     [model-picker] Model/effort application finished  modelApplied=true
```

`STEP`, `SEARCH`, `WAIT`, `ACTION`, `RETRY`, `STATE`, `OK`, `WARN`, and `FAIL` use distinct ANSI colors in an interactive terminal. Use `--color` to force ANSI output or `--no-color` to disable it. The saved `console.log` contains the same formatting and fields without escape sequences. A `RETRY` line always means a real fallback was attempted; repeated state observation remains `WAIT` or `STATE` and does not imply another click.

The model picker is read through one combined state request. Model and effort option clicks occur at most once per requested selection. The extension performs one combined post-selection verification and returns that normalized state as the canonical `model.apply` browser-effect result. The server projects `model.apply.started` and `model.apply.done` into the public turn timeline, so the E2E runner does not depend on content diagnostics or reopen the picker only to repeat the same check.


The trace includes the internal browser decision path, not only the outer scenario steps. It reports page/composer readiness, the exact pre-submit turn boundary, user-turn anchoring, assistant-turn capture, generation and terminal phases, artifact candidate scans, preview/capture choices, concrete download ownership, safe cleanup verification, recovery, steering, and conversation deletion. Diagnostics that do not yet have a dedicated formatter are still printed as bounded `Browser diagnostic: <name>` records rather than being silently hidden.

Non-reasoning scenarios request `instant` effort. After the runner has established that Instant is active, later non-reasoning turns omit the effort field and do not reopen the picker. `reasoning-lifecycle` switches to a reasoning-capable effort and uses a generated id in `TEST_<id>_BEGIN` / `TEST_<id>_FINISH`. It checks the visible `0%` through `100%` progress checkpoints, the expected sum `25502500`, and a delay-free JavaScript block that prints the result. Each attempt saves its exact prompt and final answer as `.txt` diagnostics.

## Artifact and repair workflows

Enter `/workflow` in the interactive UI to start, inspect, pause, resume, or stop a workflow. The same menu opens pending confirmations, invalid-result recovery, local-change conflicts, no-progress decisions, commit approval, and exhausted-chat recovery without requiring additional workflow commands.

The three presets share one workflow runner. Its canonical v3 state persists the workflow-owned Git base SHA, checkpoint SHAs, owned paths, expected path states, and last commit message, so final-only and squash policies resume correctly after restart:

- **Apply changes from ChatGPT** enables passive observation immediately when the wizard summary is confirmed; no separate `/workflow run` is required. Observation is a subscription on the same workflow v3 lifecycle, not a second watcher state. On the next Bridge startup, a saved workflow is offered for continuation automatically. The project root comes from an explicit `--project`, then the selected workflow profile, then the directory where Bridge was launched; stale persisted temporary directories do not override those sources. Continue chatting in the selected browser tab. Bridge baselines existing history and mirrors only the newly active turn from the shared `TabObservation`: the current user prompt, complete visible reasoning, and full answer. Browser-origin prompts are transcript-only and never enter the local editor. The next browser turn replaces the previous mirrored turn. Bridge validates returned project packages, applies workflow-owned files, optionally runs checks and commits, then returns the workflow to `ready`. Retryable artifact-preview/materialization failures remain typed effects and do not create a parallel lifecycle.
- **Fix the project until checks pass** runs selected commands, sends structured failures to ChatGPT, applies fixes, creates checkpoints, detects no progress, and can squash successful iterations into one final commit.
- **Work through a task** routes normal prompts through the focused workflow and presents contextual actions after each response; text-only replies are valid.

New chats receive the project archive and `bridge-workflow-instructions.md` as separate attachments. Bridge fingerprints the effective project and uploads a new archive only when included local contents changed. A machine-applicable result must contain `bridge-result.json`; its `files` field is optional and advisory because Bridge derives the effective changed-file set from the transactional project diff and ignores listed files that did not change. Sync deletion is limited to eligible files from the original snapshot, and the project-root `.gitignore` is additionally protected even when a returned archive omits it. Invalid packages are repaired automatically up to the configured limit. Correction and remediation requests use the workflow's configured effort, while `auto` preserves the current tab setting instead of forcing `instant`. While a bound workflow tab remains connected, startup model/effort discovery keeps retrying rather than failing after one command timeout. Control metadata is validated but never written into the project.

Workflow commits stage only exact workflow-owned files. Unrelated local changes are preserved, overlapping edits require a decision, and no workflow pushes commits. Global defaults and saved profiles live in `~/.bridge-data/workflows/config.json`. Full behavior and advanced compatibility commands are documented in `docs/WORKFLOWS.md`.

### Independent workflow worker

One ChatGPT tab is owned by one primary bridge process. A second bridge process must not compete for the same extension WebSocket. Independent workflow execution instead uses the primary bridge as an upstream observation/artifact service:

```text
primary bridge + browser tab
  GET /browser/observed-turns/stream
  GET /artifacts/:id/download
       -> workflow worker process
          own FileStore + WorkflowManager
          verify / approve / apply / remediate locally
```

Run a worker with:

`WORKFLOW_CONFIG` may be used instead of `--workflow`; it has no default for an ordinary worker process and must point to a workflow JSON file.

```bash
npm run workflow:worker -- \
  --port 8091 \
  --workflow ./bridge.workflow.json \
  --data-dir ./.bridge-data/workflow-worker \
  --upstream-url http://127.0.0.1:8080 \
  --upstream-token "$API_TOKEN" \
  --api-token "$WORKER_API_TOKEN"
```

The primary API exposes a bounded observed-turn journal at `GET /browser/observed-turns` and authenticated SSE at `GET /browser/observed-turns/stream`. Every stream item is identified by upstream epoch and sequence. Workers persist the cursor only after durable workflow enqueue, reset sequence interpretation when the primary epoch changes, and receive a typed `stream.gap` when the requested cursor predates retained history. They download artifacts through the primary HTTP API and import them into their own artifact store before verification.

Two tests cover this topology:

```bash
npm run test:workflow:multi-bridge       # deterministic separate Node processes
npm run test:e2e:workflow-multi-bridge  # real ChatGPT tab + independent worker
```

The real E2E scenario keeps the ordinary isolated bridge as the sole browser owner, starts a child workflow worker, submits a passive prompt through the primary bridge, and requires the child process to observe, download, verify, and apply the generated ZIP.

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the configuration schema, approval commands, remediation lifecycle, extension update setup, API endpoints, and safety policy.
