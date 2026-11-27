# Codex chat test UI

Bridge includes a browser test client for its Codex-like JSON-RPC protocol. It is useful for manually checking threads, historical turns, streaming reasoning, attachments, generated images, and artifact downloads without writing a separate client.

The page is a protocol client, not a second Bridge runtime. Requests still use the normal `TurnManager`, browser extension, ChatGPT tab, persistence, and artifact materialization paths.

## Start

Start Bridge in server mode:

```bash
npm start
```

In another terminal, start the test UI:

```bash
npm run ui:codex
```

The launcher opens `http://127.0.0.1:8090/`. To keep it headless or change ports:

```bash
npm run ui:codex -- --no-open --port 8091 --bridge-port 8080
```

By default the launcher reads `API_TOKEN` from `~/.bridge-data/.env`. A different file can be selected with `--env-file PATH`; an existing `API_TOKEN` environment variable takes precedence.

## Security boundary

The Node.js launcher binds only to loopback. It creates an HttpOnly session cookie and proxies:

- browser JSON-RPC WebSocket traffic to `/codex/ws`;
- setup status used for explicit ChatGPT-tab selection;
- artifact preview and download requests.

`API_TOKEN` is added by the launcher on the server side and is never returned to browser JavaScript. Keep both Bridge and this UI bound to loopback.

## Historical-turn behavior

When an existing thread is opened, the UI reconstructs the conversation from `thread/get` with `includeTurns` and `includeItems`.

- Reasoning rows use persisted `sequence`, then `firstSeenAt`, item creation order, and stable item order as fallbacks.
- ChatGPT action labels such as `Edit` and `Редактировать` are not reasoning steps.
- Generated-image previews load eagerly, including images outside the initial scroll viewport.
- A failed preview remains a normal artifact card with a working download link instead of disappearing.
- Older artifact items that stored metadata directly in `content` remain readable.
- Opening an existing thread performs a read-only reconciliation against the connected ChatGPT tab with the same session ID. Missing historical image artifacts are shown without rewriting canonical turn status, and signed Estuary copies are coalesced by content ID.

These contracts are covered by `test/codexChatUi.test.js`. The UI launcher itself is Node.js; the previous standalone Python proxy is not required.

## Protocol scope

The client exposes the methods and capabilities documented in [Codex-like app-server protocol](../developer/APP_SERVER.md). It is intended for development and integration testing, not as a claim of full Codex app-server compatibility.

## Connect an existing ChatGPT chat

Choose the ChatGPT browser tab in the header (or use Auto when only one
compatible tab is connected). Select **Connect chat**, search for a
conversation visible in that tab's ChatGPT sidebar, then confirm. Bridge
reads the current branch without navigating, even during generation. If
the conversation record is unavailable, an idle tab may navigate to the
conversation and import the currently rendered messages instead. A busy
tab is never navigated for history import. The imported thread remains available locally
and subsequent prompts reuse its original session ID. Connecting the same
active thread again does not duplicate its history.

This is an initial text snapshot, not continuous bidirectional history sync.
Historical attachments, images, tool output and reasoning are not imported.
The browser's internal conversation-record endpoint is tried first, with
an authenticated retry for 401/403/404. DOM-only imports are explicitly
marked as potentially incomplete because older messages may be virtualized.
Use **Refresh history** before the first Bridge turn to update an imported
snapshot (for example after generation finishes). After local turns exist,
only uniquely aligned older messages may be prepended.
Reload the packaged extension before using this feature.

## Repeat a prompt (Loop)

Select an existing conversation, enable **Loop**, choose the iteration
limit (default 50, maximum 500), and send a prompt. The server appends a
random per-loop completion marker and submits the same prompt after each
successful turn, in the same conversation. It stops only when the marker
is the final standalone line, the iteration limit is reached, a turn
fails, or you click **Stop**. Closing/reloading WebUI does not stop a
running server-side loop; restarting the Bridge server stops it, and the
loop is not automatically replayed. File attachments are uploaded on the
first iteration only. Marker detection is model-reported completion, not
an independent verification of the task.

The initial imported snapshot can be expanded from a virtualized
transcript on an idle tab. The DOM fallback remains marked partial.
Refresh history after local turns only prepends older messages if the
previous imported prefix can be uniquely aligned.

### Synchronizing attached conversations

Refresh history replaces a provisional DOM import with the validated current
conversation branch when available, even after Bridge turns were executed.
Local execution records, reasoning and artifacts are retained; the history
view overlays uniquely matched local turns on the canonical messages. An
ambiguous match remains a separate local turn rather than losing local data.
The selected attached chat refreshes approximately every ten seconds while
WebUI is open and no local turn is active. Background refresh never navigates
or scrolls ChatGPT. An external generating turn is a temporary read-only
snapshot, not a local execution or Loop completion signal.

Unconfirmed local prompts in attached conversations are outlined in red.
**Retry** repeats the original request in the same conversation (with its
saved model, effort and attachments); uncertain delivery requires explicit
confirmation. A failed Loop iteration is retried once, not as a new Loop.
**Remove** hides the unsuccessful local attempt, not the remote conversation
or stored diagnostic records and artifacts. A proven remote message remains
visible even if its local attempt was previously dismissed.

Loop progression uses the saved terminal turn as its source of truth.
Notifications trigger an immediate check, with a low-frequency server-side
check as a fallback. A missing saved response stops the loop explicitly
rather than silently repeating an ambiguous iteration.
