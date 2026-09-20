# Configuration

Bridge creates `~/.bridge-data/.env` on first startup, so a hand-written environment file is not required for the normal local setup.

This page is the runtime environment reference for the Node Bridge. Defaults shown here match `src/config.js`.

## Server and authentication

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind host. Keep this on loopback unless you intentionally expose Bridge to a trusted network. |
| `PORT` | `8080` | HTTP/WebSocket port. |
| `PUBLIC_BASE_URL` | `http://<HOST>:<PORT>` | Base URL embedded in signed local attachment links and setup output. |
| `API_TOKEN` | generated on first start | Bearer token used by HTTP and Codex-like API clients. |
| `BRIDGE_TOKEN` | generated on first start | Separate token used by the browser extension. |
| `ALLOWED_ORIGINS` | bundled extension origin | Accepted browser-extension WebSocket origin. Override only for a deliberately rebuilt extension identity. |
| `ENV_FILE` | `<DATA_DIR>/.env` | Override the environment file loaded by Bridge. |
| `DATA_DIR` | `~/.bridge-data` | Files, artifacts, metadata, generated configuration, and interactive state. |
| `JSON_BODY_LIMIT` | `50mb` | Express JSON body limit for prompts and inline/base64 file uploads. |

## Browser selection and automatic tab opening

| Variable | Default | Description |
| --- | --- | --- |
| `ACTIVE_CLIENT_ID` | empty | Optional fixed browser-extension client/tab ID. Usually leave this unset so Bridge can route by session. |
| `AUTO_OPEN_TAB` | `0` | Open a dedicated ChatGPT tab when no safe prompt target exists. |
| `AUTO_OPEN_TAB_TIMEOUT_MS` | `30000` | Maximum wait for the token-bound automatically opened tab to connect. |
| `AUTO_OPEN_TAB_BOOTSTRAP_WAIT_MS` | `2500` | Grace period for an existing extension client to reconnect before Bridge falls back to the system browser. |
| `PROMPT_DELIVERY_TIMEOUT_MS` | `30000` | Timeout for delivering `prompt.send` to the selected extension client. |
| `PROMPT_ACCEPTED_TIMEOUT_MS` | `10000` | Maximum wait for the content runtime to accept the prompt command. |
| `PASSIVE_PROMPT_REVIEW_AFTER_MS` | `120000` | Age after which an unresolved passive prompt is surfaced for owner review. This never authorizes an automatic resend. |

## Request progress and completion

These settings control liveness and completion detection. They should normally be left at their defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `ANSWER_TIMEOUT_MS` | `120000` | Compatibility/default meaningful-progress timeout used when `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` is unset. |
| `REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS` | `ANSWER_TIMEOUT_MS` | Inactivity limit while waiting for meaningful result progress when generation is not active. |
| `REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS` | `60000` | Shorter inactivity limit after generation stops, covering final snapshot/result/download/apply work. |
| `REQUEST_HARD_LIVENESS_TIMEOUT_MS` | derived | Hard source-client liveness timeout derived from stale-client and heartbeat settings unless explicitly set. |
| `REQUEST_GENERATION_ACTIVITY_GRACE_MS` | `30000` | Grace after the most recent current-generation signal before generation is considered inactive. |
| `FORCED_SNAPSHOT_AFTER_MS` | `90000` | Delay before requesting a source-bound assistant snapshot after stalled meaningful progress. |
| `FORCED_SNAPSHOT_COOLDOWN_MS` | `60000` | Minimum delay between automatic forced snapshots. |
| `FORCED_SNAPSHOT_TIMEOUT_MS` | `30000` | Timeout for one forced snapshot command. |
| `ANSWER_SETTLE_MS` | `1500` | General answer-text stability window. |
| `ANSWER_DONE_SETTLE_MS` | `600` | Shorter answer stability window after generation appears idle. |
| `POST_STOP_TERMINAL_SETTLE_MS` | `900` | Required stability of terminal UI state after the Stop control disappears. |
| `REQUIRED_ARTIFACT_SETTLE_MS` | `30000` | Post-generation wait for a required artifact to become materializable. |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Extension-client heartbeat interval. Heartbeat proves liveness, not meaningful request progress. |
| `CLIENT_STALE_MS` | `30000` | Age after which a browser client is treated as stale. |

## Transient ChatGPT errors

| Variable | Default | Description |
| --- | --- | --- |
| `CHATGPT_TRANSIENT_ERROR_MAX_RETRIES` | `3` | Maximum automatic retries for recognized transient ChatGPT request errors. |
| `CHATGPT_TRANSIENT_ERROR_RETRY_BASE_MS` | `1000` | Initial retry delay. |
| `CHATGPT_TRANSIENT_ERROR_RETRY_MAX_MS` | `8000` | Maximum retry delay. |

Retries apply only to the explicitly supported transient-error path. Bridge does not turn uncertain browser effects into blind repeated writes.

## Files and artifacts

| Variable | Default | Description |
| --- | --- | --- |
| `ATTACHMENT_TRANSPORT` | `url` | Attachment delivery mode. The default keeps file contents out of browser command payloads. |
| `ARTIFACT_CHUNK_TIMEOUT_MS` | `60000` | Maximum idle wait while receiving a chunked artifact transfer. |
| `ARTIFACT_RESOLVE_RETRIES` | `5` | Number of bounded attempts to resolve a browser artifact action. |
| `ARTIFACT_RESOLVE_RETRY_DELAY_MS` | `600` | Base delay between artifact-resolution attempts. |
| `ARTIFACT_RETENTION_COUNT` | `10` | Maximum retained downloaded artifact count before cleanup. |
| `ARTIFACT_RETENTION_BYTES` | `262144000` | Maximum retained artifact bytes before cleanup. |
| `ZIP_MAX_ENTRIES` | `5000` | Maximum entries accepted from an external ZIP. |
| `ZIP_MAX_UNCOMPRESSED_SIZE` | `524288000` | Maximum total uncompressed bytes accepted from an external ZIP. |

## Project packaging

| Variable | Default | Description |
| --- | --- | --- |
| `PROJECT_MAX_FILES` | `2000` | Maximum project files included in one snapshot. |
| `PROJECT_MAX_ZIP_BYTES` | `52428800` | Maximum generated project ZIP size. |
| `PROJECT_MAX_SINGLE_FILE_BYTES` | `1048576` | Maximum size of one project file included in a snapshot. |
| `PROJECT_CONTEXT_MAX_SYMBOLS` | `2000` | Maximum indexed symbols written into project context. |
| `PROJECT_TREE_LIMIT` | `500` | Maximum paths rendered in the project tree summary. |

## Diagnostics

| Variable | Default | Description |
| --- | --- | --- |
| `DEBUG_EVENTS_LIMIT` | `250` | Maximum number of recent diagnostic events kept in memory. |
| `PAYLOAD_DEBUG` | `0` | Enable the OpenAI-compatible request payload debug dump. Disabled by default because prompts may be private. |
| `PAYLOAD_DEBUG_FILE` | `<DATA_DIR>/last_openclaw_payload.json` | Destination for the payload debug dump. |

## Full-Power adapter

These values are relevant only when the optional Full-Power execution plane is enabled.

| Variable | Default | Description |
| --- | --- | --- |
| `FULL_POWER_BRIDGE_URL` | `http://127.0.0.1:8788` | Loopback URL of the Full-Power adapter. |
| `FULL_POWER_BRIDGE_TOKEN` | empty | Internal adapter token. An empty value disables the Bridge-side Full-Power integration. |
| `FULL_POWER_OWNER_TOKEN` | empty | Separate owner-confirmation token for protected Full-Power actions. |
| `FULL_POWER_REQUEST_TIMEOUT_MS` | `30000` | Timeout for one request to the adapter. |

See [Full-Power adapter](FULL_POWER.md) for the execution and security model.

## Workflow worker

`WORKFLOW_CONFIG` can point the headless workflow worker at a workflow JSON file instead of passing `--workflow`.

It has no implicit ordinary-worker default: a headless worker must receive a workflow explicitly through the CLI or `WORKFLOW_CONFIG`.

See [Workflows](../WORKFLOWS.md) for workflow commands and lifecycle details.
