# Documentation

ChatGPT Bridge documentation is split by audience.

## User documentation

Start here if you want to install Bridge, connect a browser, or use it from a CLI, IDE, or another local client.

- [Getting started](user/GETTING_STARTED.md) — install, connect the browser extension, and send the first request.
- [Usage and run modes](user/USAGE.md) — interactive CLI, server mode, Codex-compatible clients, projects, and workflows.
- [HTTP API](user/API.md) — chat, sessions, files, artifacts, streaming, and the OpenAI-compatible endpoint.
- [Browser extension](user/BROWSER_EXTENSION.md) — setup, tab selection, automatic tab opening, and extension updates.
- [Full-Power adapter](user/FULL_POWER.md) — optional owner-PC execution integration and its security boundary.
- [Troubleshooting](user/TROUBLESHOOTING.md) — common connection, browser, streaming, and recovery problems.

## Developer documentation

Start here if you are changing Bridge itself.

- [Developer guide](developer/README.md) — map of the implementation-oriented documentation.
- [Codex-like app-server protocol](developer/APP_SERVER.md) — threads, turns, items, JSON-RPC, and transport details.
- [Canonical architecture](../ARCHITECTURE.md) — ownership, Protocol 5, browser effects, recovery, and workflow boundaries.
- [Workflows](WORKFLOWS.md) and [Zipflow integration](ZIPFLOW_SERVER.md).
- [ChatGPT DOM parser](CHATGPT_DOM_PARSER.md) and [files/artifacts DOM](CHATGPT_FILES_CODE_DOM.md).
- [Deterministic local E2E runtime](LOCAL_E2E.md).

The root [README](../README.md) intentionally stays short. It should help a new user understand what Bridge is, get it running, and choose the right documentation path without exposing implementation details first.
