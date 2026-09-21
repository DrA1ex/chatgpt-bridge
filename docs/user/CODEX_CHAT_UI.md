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
