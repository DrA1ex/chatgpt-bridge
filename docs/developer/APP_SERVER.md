# Codex-like app-server protocol

Bridge exposes a Codex-inspired automation surface so IDEs and CLI clients can use the same browser-backed execution core through familiar thread/turn/item concepts.

This is an API-shape compatibility layer, not a complete Codex app-server implementation.

The repository includes a loopback-only browser client and Node.js proxy for manual integration testing. See [Codex chat test UI](../user/CODEX_CHAT_UI.md).

## Object model

```text
thread = long-lived work session / conversation
turn   = one user request and one ChatGPT execution
item   = user message, reasoning/progress, assistant message, artifact, etc.
```

The same canonical Bridge request lifecycle backs REST, WebSocket JSON-RPC, stdio JSON-RPC, and browser execution.

## REST

Core endpoints:

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

Typical turn events include:

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

For a live consumer, opening `GET /turns/:id/events?stream=1&recent=0&wait=1` before creating the turn allows the stream to publish readiness first and then committed lifecycle events in order.

## JSON-RPC over WebSocket

Endpoint:

```text
ws://127.0.0.1:8080/codex/ws?token=$API_TOKEN
```

Supported MVP methods:

```text
initialize
thread/list
thread/create
thread/get
thread/reconcile
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

Example:

```json
{"id":1,"method":"initialize","params":{}}
{"id":2,"method":"thread/create","params":{"title":"my-app","cwd":"/Users/me/code/my-app"}}
{"id":3,"method":"turn/start","params":{"threadId":"thread_...","input":"Fix the login bug","output":{"expected":"zip","required":true}}}
```

Notifications are sent on the same socket:

```json
{"method":"turn/started","params":{"turnId":"turn_..."}}
{"method":"item/agentMessage/delta","params":{"turnId":"turn_...","itemId":"item_...","text":"..."}}
{"method":"item/artifact/created","params":{"turnId":"turn_...","artifact":{"id":"artifact_..."}}}
{"method":"turn/completed","params":{"turnId":"turn_..."}}
```

## JSON-RPC over stdio

Run:

```bash
npm run interact -- --codex-stdio
```

The process still starts the normal local HTTP/WebSocket Bridge used by the browser extension. JSON-RPC input is read from stdin and protocol output is written to stdout; normal logs are kept off stdout so they cannot corrupt the protocol stream.

## Capability boundary

`initialize` reports supported and unsupported capabilities explicitly. The current compatibility layer includes threads, turns, items, streaming items, artifacts, and project packaging.

File edits are represented as ZIP artifacts. Direct shell commands, approval workflows, worktrees, and a Codex sandbox are not claimed by this layer.

That distinction is deliberate: a client should be able to detect missing capabilities instead of assuming behavior that Bridge does not implement.

## Project packaging

The JSON-RPC surface uses the same project implementation as the interactive client:

```text
project/open
project/scan
project/pack
turn/start
```

Project packaging produces the same Bridge project snapshot and follows the same ignore/safety rules.

## Implementation rules

The app-server layer should remain a projection of canonical Bridge state.

Do not create transport-specific turn completion logic, retry rules, or artifact ownership. Those belong to the canonical request/browser-effect lifecycle documented in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Existing ChatGPT conversations

- `thread/existing/list`: takes an optional `sourceClientId` (required if more than one compatible tab is available); returns `{ sourceClientId, chats: [{ id, title }] }` from the tab's visible sidebar.
- `thread/attach`: takes `{ sourceClientId, sessionId }`; reads the current branch's user-facing text without navigation, with a guarded idle-tab / visible-DOM fallback, and returns `{ thread, reused }`. An existing active local thread with the same session ID is reused. Optional `refreshHistory: true` refreshes an imported snapshot before local turns exist; afterward it can only prepend uniquely aligned older messages. `thread.metadata.importedHistory` reports the source and whether the snapshot may be incomplete.
- `thread/get` with `includeItems: true` includes the initial imported text snapshot before locally executed turns. Historical messages are not synthetic executed turns. No live synchronization of later external edits or historical attachment import is implied.

### Prompt loops

`loop/start` accepts the ordinary turn parameters plus a concrete bound `threadId` and optional `maxIterations` (1–500, default 50). It returns `{ loop, turn }`. `loop/get` and `loop/stop` take `{ threadId }` and return `{ loop }`. Loop status changes are broadcast as `loop/updated`. Loops run in memory on the Bridge server, continue after a UI disconnect, and stop on server restart without replay. A successful turn without the exact final marker schedules one successor; errors, cancellation, and limits are terminal. No loop state owns the underlying browser request lifecycle.

`thread/history/refresh` takes `{ threadId, sourceClientId?, background? }`.
It refreshes an attached conversation without changing local execution records.
Background reads never navigate or scroll. `thread/get` includes the current
canonical presentation and optional `historyLive` external-generation state.

`thread/history/dismiss` and `thread/history/retry` accept `{ threadId, turnId }`
for an unresolved terminal local prompt. Retry additionally accepts
`confirmUncertain: true` and an optional `sourceClientId`. They preserve the
remote conversation and local execution records. Retry creates one new turn
with an idempotency key and dismisses the old attempt from the history view.
