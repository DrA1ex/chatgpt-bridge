# Usage and run modes

Bridge has one browser automation core but several ways to use it. Pick the surface that fits the client you want to connect.

## Interactive CLI

Run:

```bash
bridge
# or
npm run interact
```

This starts the Terlio terminal UI and the local Bridge server in the same process.

Use it when you want to work directly from a terminal, select ChatGPT sessions, choose models/effort, attach files, inspect artifacts, or work with a local project.

## Server mode

Run:

```bash
bridge --server
# or
npm start
```

This starts only the local HTTP/WebSocket server.

Use server mode when another application is the UI: an IDE, a custom script, an OpenAI-compatible client, or a Codex-like client.

The default address is `http://127.0.0.1:8080`.

## HTTP and OpenAI-compatible clients

The simplest Bridge endpoint is:

```text
POST /chat
```

An OpenAI-compatible chat-completions surface is also available at:

```text
POST /v1/chat/completions
```

Both require `Authorization: Bearer <API_TOKEN>` when `API_TOKEN` is configured.

See [HTTP API](API.md) for examples, streaming, sessions, files, and artifacts.

## Codex-compatible clients

Server mode also exposes a Codex-like JSON-RPC WebSocket:

```text
ws://127.0.0.1:8080/codex/ws?token=$API_TOKEN
```

It models work as:

```text
thread -> long-lived work session
turn   -> one request/execution
item   -> message, reasoning/progress, artifact, and similar turn output
```

For clients that expect a subprocess-style app server, use stdio mode:

```bash
npm run interact -- --codex-stdio
```

This still starts the local HTTP/WebSocket server for the browser extension, while JSON-RPC requests and responses use stdin/stdout.

The compatibility layer is intentionally partial; it is not a full Codex app-server implementation. See [Codex-like app-server protocol](../developer/APP_SERVER.md) for supported methods and capabilities.

## Project-aware interactive mode

Open a project directly:

```bash
bridge --project /path/to/project
# or
npm run interact -- --project /path/to/project
```

Plain prompts become project-aware. Bridge scans the project, applies ignore rules, packages the current project context, and attaches it to the same ChatGPT turn.

Useful commands include:

```text
/project
/project open <path>
/project scan
/project pack
/project sync
/project session list
/project session new
/project session use <id|index>
/task <prompt>
/chat <prompt>
/recover [list|n] [--force|--apply]
/apply [--plan|--interactive|--force]
```

Use `/chat` for a direct chat turn without project packaging. Use `/task` when the result must contain a complete updated project ZIP.

## Workflows

Open the workflow surface with:

```text
/workflow
```

Interactive workflows use the authenticated local Zipflow service. Zipflow owns project mutation, checks, Git/deployment operations, backups, history, and rollback; Bridge owns ChatGPT orchestration and artifact selection.

For the full workflow model see [Workflows](../WORKFLOWS.md) and [Zipflow integration](../ZIPFLOW_SERVER.md).

## Running as a service

A systemd unit is included under `systemd/`.

Typical installation:

```bash
sudo cp systemd/chatgpt-bridge-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chatgpt-bridge-node
journalctl -u chatgpt-bridge-node -f
```

After the service starts, open `/setup` and connect the browser extension as usual.

## Security defaults

Keep the default bind address unless you explicitly need remote access:

```env
HOST=127.0.0.1
```

If you bind to `0.0.0.0`, use a strong `API_TOKEN` and firewall the port. The browser extension uses the separate `BRIDGE_TOKEN` and does not need the HTTP API token.
