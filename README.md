# ChatGPT Browser Bridge

ChatGPT Bridge exposes a logged-in ChatGPT browser session through a local API, Codex-like protocol, and terminal UI.

It uses a Chrome/Chromium extension to drive the real ChatGPT web UI:

```text
CLI / IDE / local client
        |
        v
ChatGPT Bridge
  HTTP / SSE / JSON-RPC
        |
        v
browser extension
        |
        v
logged-in ChatGPT tab
```

Bridge is useful when you want local tools to work through an existing ChatGPT browser session without treating the browser automation details as part of every client.

## Quick start

Requirements:

- Node.js 20+
- npm
- Chrome or Chromium
- a logged-in ChatGPT session at `https://chatgpt.com`

Install:

```bash
npm install
npm link
```

Install the browser extension:

```bash
npm run extension:install
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
~/.local/share/chatgpt-bridge/extension
```

Start Bridge:

```bash
bridge
```

Open:

```text
http://127.0.0.1:8080/setup
```

Paste the displayed `BRIDGE_TOKEN` into the Bridge panel on `https://chatgpt.com/` and connect.

For the complete setup flow, see [Getting started](docs/user/GETTING_STARTED.md).

## Ways to use Bridge

### Interactive terminal

```bash
bridge
```

The default mode starts the terminal UI together with the local Bridge server.

### Server/API mode

```bash
bridge --server
# or
npm start
```

Use this when another application is the UI.

The default server is:

```text
http://127.0.0.1:8080
```

Bridge exposes:

- a simple local chat API;
- streaming SSE;
- session and browser-tab control;
- files and generated artifacts;
- an OpenAI-compatible `/v1/chat/completions` endpoint.

See [HTTP API](docs/user/API.md).

### Codex-like clients

A Codex-inspired JSON-RPC endpoint is available at:

```text
ws://127.0.0.1:8080/codex/ws?token=$API_TOKEN
```

For subprocess-style clients:

```bash
npm run interact -- --codex-stdio
```

This compatibility layer exposes thread/turn/item concepts over the same browser-backed execution core. It is intentionally not a complete Codex app-server implementation.

See [Usage and run modes](docs/user/USAGE.md) and [Codex-like app-server protocol](docs/developer/APP_SERVER.md).

For manual protocol and historical-turn testing, start the bundled browser client:

```bash
npm run ui:codex
```

See [Codex chat test UI](docs/user/CODEX_CHAT_UI.md).

### Project-aware mode

Open a local project:

```bash
bridge --project /path/to/project
```

Bridge can package project context, attach it to ChatGPT turns, recover generated project artifacts, and pass approved project updates through the workflow layer.

See [Usage and run modes](docs/user/USAGE.md) and [Workflows](docs/WORKFLOWS.md).

### Full-Power integration

Bridge can optionally connect to a separate Full-Power owner-PC adapter for privileged local execution.

This execution plane is disabled by default and has its own capability and owner-confirmation security boundary.

See [Full-Power adapter](docs/user/FULL_POWER.md).

## Documentation

### User documentation

- [Getting started](docs/user/GETTING_STARTED.md)
- [Usage and run modes](docs/user/USAGE.md)
- [HTTP API](docs/user/API.md)
- [Browser extension](docs/user/BROWSER_EXTENSION.md)
- [Codex chat test UI](docs/user/CODEX_CHAT_UI.md)
- [Full-Power adapter](docs/user/FULL_POWER.md)
- [Troubleshooting](docs/user/TROUBLESHOOTING.md)

See the [documentation index](docs/README.md) for the full user-facing map.

### Developer documentation

- [Developer guide](docs/developer/README.md)
- [Canonical architecture](ARCHITECTURE.md)
- [Codex-like app-server protocol](docs/developer/APP_SERVER.md)
- [Workflows](docs/WORKFLOWS.md)
- [Zipflow integration](docs/ZIPFLOW_SERVER.md)
- [ChatGPT DOM parser](docs/CHATGPT_DOM_PARSER.md)
- [Files/artifacts DOM specification](docs/CHATGPT_FILES_CODE_DOM.md)
- [Deterministic local E2E runtime](docs/LOCAL_E2E.md)

Implementation details belong in these documents rather than in the root README.

## Development

Install dependencies and run the normal test suite:

```bash
npm install
npm test
```

Run the authenticated real-browser E2E suite only when needed:

```bash
npm run test:e2e
```

For architecture, protocol ownership, browser-effect recovery, DOM contracts, and E2E invariants, start with the [developer guide](docs/developer/README.md).

## Security

Bridge defaults to loopback:

```env
HOST=127.0.0.1
```

Keep it that way unless you intentionally expose the service to a trusted network.

HTTP clients use `API_TOKEN`. The browser extension uses the separate `BRIDGE_TOKEN`.

See [Getting started](docs/user/GETTING_STARTED.md) and [Browser extension](docs/user/BROWSER_EXTENSION.md) for setup details.
