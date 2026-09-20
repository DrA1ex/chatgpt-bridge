# Developer documentation

This section is for changes to ChatGPT Bridge itself. User-facing setup and usage live under [docs/user](../user/GETTING_STARTED.md).

## Architecture and ownership

Read [Canonical Browser Bridge Architecture](../../ARCHITECTURE.md) first for:

- Node/browser ownership boundaries;
- Protocol 5;
- command/effect settlement;
- tab ownership and serialization;
- canonical request lifecycle;
- reload/recovery rules;
- downloads/artifacts;
- workflow ownership.

The architecture document is the canonical source when implementation details conflict with an older README paragraph or test note.

See [Response reconciliation and transfer integrity](RECONCILIATION_AND_TRANSFER_INTEGRITY.md) for optional conversation-record evidence and integrity-bearing artifact, layout and attachment transport.

## Codex-like app-server layer

See [APP_SERVER.md](APP_SERVER.md) for the thread/turn/item model, REST surface, WebSocket JSON-RPC endpoint, stdio mode, and compatibility limits.

## ChatGPT DOM integration

- [ChatGPT DOM parser specification](../CHATGPT_DOM_PARSER.md) — composer, turn anchoring, reasoning/progress, final-answer boundaries, and safe deletion.
- [Files, artifacts, and code DOM specification](../CHATGPT_FILES_CODE_DOM.md) — file/artifact UI, code blocks, previews, and capture rules.

DOM behavior should remain locale-independent and fail closed when the expected semantic structure is absent.

## Workflows

- [Workflows](../WORKFLOWS.md) — user-visible workflow model and headless commands.
- [Zipflow integration](../ZIPFLOW_SERVER.md) — ownership boundary between Bridge and the local workflow service.

Bridge owns ChatGPT orchestration. Zipflow owns local project mutation and related safety mechanisms.

## Testing

Run the normal test suite:

```bash
npm test
```

The authenticated browser matrix is opt-in:

```bash
npm run test:e2e
```

See [Deterministic Local ChatGPT E2E Runtime](../LOCAL_E2E.md) for the local state-machine contracts and parity boundary.

When changing DOM selectors or parser behavior, add/update sanitized fixtures and keep the parser specifications in sync.

## Versioned browser runtime

The browser extension, content runtime, protocol, and persisted runtime schemas are versioned separately. Current compatibility rules and exact versions are documented in [ARCHITECTURE.md](../../ARCHITECTURE.md) and enforced by startup/runtime checks.

Avoid introducing a second lifecycle or transport-specific source of truth. Public HTTP/SSE/JSON-RPC surfaces should project the canonical request state rather than reconstructing it independently.
