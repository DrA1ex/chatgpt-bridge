# Getting started

This guide gets a local ChatGPT Bridge instance connected to a logged-in ChatGPT browser tab.

## Requirements

- Node.js 20 or newer
- npm
- Chrome or Chromium
- a logged-in ChatGPT session at `https://chatgpt.com`

Bridge automates the ChatGPT web UI. It is not the official OpenAI API.

## 1. Install

From a checkout of the repository:

```bash
npm install
```

For development, link the CLI so the `bridge` command points at your checkout:

```bash
npm link
```

You can skip `npm link` and use the npm scripts instead.

No `.env` file is required for the first start. Bridge creates `~/.bridge-data/.env` when needed and generates stable local configuration, including `API_TOKEN` and `BRIDGE_TOKEN`.

## 2. Install the browser extension

Publish the extension into its stable local directory:

```bash
npm run extension:install
```

Then open:

```text
chrome://extensions
```

Enable **Developer mode**, choose **Load unpacked**, and select:

```text
~/.local/share/chatgpt-bridge/extension
```

You normally need to select this directory only once. Later Bridge updates replace the contents of the same directory.

## 3. Start Bridge

Server-only mode:

```bash
npm start
# or, after npm link
bridge --server
```

Interactive terminal mode:

```bash
npm run interact
# or
bridge
```

Interactive mode also starts the local HTTP/WebSocket server because the browser extension connects to it.

The default server address is:

```text
http://127.0.0.1:8080
```

## 4. Connect ChatGPT

Open the setup page:

```text
http://127.0.0.1:8080/setup
```

Open or reload `https://chatgpt.com/`. Use the extension toolbar action or the Bridge panel, paste the `BRIDGE_TOKEN` shown by the setup page, and choose **Save & connect**.

The extension connects to the local Bridge over:

```text
ws://127.0.0.1:8080/extension/ws
```

The extension uses `BRIDGE_TOKEN`. HTTP and Codex-like clients use the separate `API_TOKEN`.

## 5. Verify the connection

Load the API token from `~/.bridge-data/.env` or export it manually, then check health:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:8080/health | jq
```

A connected setup reports at least one browser client.

Send a simple request:

```bash
curl -X POST http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Say hello in one sentence."}'
```

## What next?

See [Usage and run modes](USAGE.md) to choose between the interactive CLI, server/API mode, Codex-compatible clients, project-aware mode, and workflows.

For extension setup details and multi-tab behavior, see [Browser extension](BROWSER_EXTENSION.md).
