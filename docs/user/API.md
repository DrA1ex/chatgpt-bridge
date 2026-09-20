# HTTP API

The local API defaults to `http://127.0.0.1:8080`.

When `API_TOKEN` is configured, send:

```text
Authorization: Bearer <API_TOKEN>
```

## Simple chat

```bash
curl -X POST http://127.0.0.1:8080/chat \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

Streaming uses the same endpoint:

```bash
curl -N -X POST 'http://127.0.0.1:8080/chat?stream=1' \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

The stream emits normalized `event: event` frames. `request.result` is the authoritative successful terminal frame and `request.error` is the terminal failure frame.

## Sessions

List sessions:

```text
GET /sessions
```

Create/select/send:

```text
POST /sessions/new
POST /sessions/select
POST /sessions/:id/messages
```

You can also use `newSession`, `sessionId`, or `freshTab` directly on `POST /chat`.

`freshTab` implies a new session and requires a dedicated new browser tab instead of falling back to an existing connected tab.

## Models and effort

Bridge can best-effort apply a visible ChatGPT model and reasoning/effort option before prompt submission.

Discovery endpoints:

```text
GET /models
GET /efforts
```

Example:

```json
{
  "model": "GPT-5.5 Thinking",
  "effort": "high",
  "message": "Solve this carefully"
}
```

Model/effort selection depends on the current ChatGPT UI. If the expected semantic structure changes, Bridge reports a typed schema error instead of guessing from unrelated page text.

## Input files

Typical flow:

```text
POST /files
  -> receive file.id
  -> pass that id in /chat attachments
  -> extension attaches it to the ChatGPT composer
```

Import a local file path:

```text
POST /files/from-path
```

Then send:

```json
{
  "message": "Summarize this file",
  "attachments": ["file_..."]
}
```

Inline base64 attachments are also supported for appropriate file sizes.

## Output artifacts

Bridge tracks generated files/images as artifacts.

List them:

```text
GET /artifacts
```

Download one through its source browser tab:

```text
GET /artifacts/:id/download
```

Artifact capture is source-turn scoped. The extension proves a matching artifact action or URL before starting the browser-side download and Node stores the result under the Bridge data directory.

## OpenAI-compatible chat completions

Non-streaming and streaming requests use:

```text
POST /v1/chat/completions
```

Example:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"chatgpt",
    "messages":[{"role":"user","content":"Hello"}]
  }'
```

Set `"stream": true` for SSE. Visible reasoning may be emitted as `reasoning_content`; assistant text uses normal `content` deltas. The OpenAI-compatible stream is append-only and ends with `data: [DONE]`.

Modern content parts can include text, Bridge `file_id` values, and base64 data-URL images.

## Project API

Project-aware clients can use:

```text
POST /projects/open
POST /projects/scan
POST /projects/pack
```

The same project scanner/packer is used by interactive and Codex-like modes.

## Diagnostics and events

Normalized product events:

```text
GET /events/stream
```

Recent debug events:

```text
GET /debug/events
```

Protocol/debug stream:

```text
GET /debug/stream
```

Browser diagnostics page:

```text
http://127.0.0.1:8080/diagnostics
```

Debug output is intentionally bounded and should not be treated as a raw dump of full private prompts, answers, files, or DOM state.

For Codex-like thread/turn/item APIs and JSON-RPC, see [Codex-like app-server protocol](../developer/APP_SERVER.md).
