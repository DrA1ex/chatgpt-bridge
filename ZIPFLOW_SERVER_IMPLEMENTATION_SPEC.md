# Zipflow Workflow Server Implementation Specification

Status: implementation and acceptance verification complete; unpublished

Target repositories:

- Zipflow: `/Users/akoreshnyak/dev/zipflow`
- ChatGPT Bridge: `/Users/akoreshnyak/dev/chatgpt-bridge`

### Current verification status (2026-08-01)

The implementation and acceptance layers have run successfully on the current
trees in both repositories. Publication remains a separate manual action and
was not performed as part of this work.

- Zipflow static checks pass. Its executable functional baseline against
  `f44e0cb127437ea6ce3e4c7773ccf553673d74dc` passes 432 of 432 tests, including
  archive path completion and deliberate double-Enter archive discovery. The
  manifest records `clientBackedParityComplete` as true.
- The complete Zipflow suite passes 774 of 774 tests. The publishable-package
  gate verifies 281 files and installs deterministic runtime dependencies twice.
- Bridge static and package-content checks pass. Its complete isolated suite
  passes 1028 tests with no failures and one environment skip for a separate
  headless-Chromium parser fixture.
- All three real cross-process socket scenarios pass: restart plus rollback,
  checks plus commit plus deployment, and fix-until-pass remediation.
- The local extension-reload E2E passes with both background and content epochs
  replaced. Authenticated Chrome conversation E2E also passes with forced
  extension reload, continuity, exact result, and URL-bound cleanup.
- Authenticated workflow-remediation E2E passes with a broken ZIP, failed check,
  transactional rollback, corrected replacement ZIP, successful check, durable
  completion, duplicate-turn suppression, and conversation cleanup. The final
  run used 180-second pipeline-idle and 300-second workflow-wait bounds because
  the external model exceeded the default idle window on the first attempt.
- Exact local tarballs for Zipflow 1.9.0 and Bridge 6.4.0 install together in a
  clean consumer. Bridge pins Zipflow to exactly 1.9.0 and its lock integrity
  matches the packed Zipflow bytes.
- Windows named-pipe transport remains represented at the protocol and client
  boundaries. Daemon startup intentionally fails closed on Windows until owner,
  DACL, and reparse-point validation is implemented, as required by the stated
  non-goal.

Related architecture:

- [Zipflow Workflow Server Integration Plan](ZIPFLOW_SERVER_INTEGRATION_PLAN.md)
- [Embedded Zipflow Integration Plan](ZIPFLOW_EMBEDDED_INTEGRATION_PLAN.md)

## 1. Objective

Implement Zipflow as a reusable local workflow service and integrate it into the
existing Bridge TUI without displaying or embedding the standalone Zipflow UI.

The completed system must satisfy all of the following:

1. Zipflow runs as an authenticated local server over a Unix domain socket.
2. The server exposes versioned HTTP/JSON resources and an SSE event stream.
3. The server exposes semantic workflow surfaces and actions without terminal
   styling, key bindings, focus, selection, or layout state.
4. Bridge renders every workflow surface with its own theme, components, input
   model, and terminal lifecycle.
5. Zipflow remains the only owner of local project mutation, archive safety,
   checks, Git, deployment, backups, recovery, history, and rollback.
6. Bridge remains the only owner of ChatGPT sessions, prompts, artifacts,
   remediation loops, and visible UI.
7. The protocol is usable by clients other than Bridge. A future MCP adapter
   must not require changes to the core workflow contract.
8. Restarts, retries, and reconnects must never duplicate an apply, commit,
   deployment, or rollback.

The implementation is not complete when only a demo endpoint or Bridge-specific
RPC exists. Protocol schemas, recovery, security, conformance fixtures, and the
full workflow lifecycle are required.

## 2. Explicit Non-Goals

- Do not claim fully verified Windows support in the initial rollout. The local
  transport, discovery metadata, client SDK, and runtime-security boundaries
  must nevertheless remain portable to Windows named pipes without changing
  the core HTTP/JSON/SSE workflow contract.
- Do not expose the server on a network interface by default.
- Do not embed ANSI, Terlio nodes, rendered rows, key names, or terminal sizes in
  the protocol.
- Do not allow API clients to submit arbitrary shell commands to run endpoints.
- Do not move ChatGPT browser control into Zipflow.
- Do not move Zipflow project mutation into Bridge.
- Do not make MCP the primary transport.
- Do not introduce WebSocket in protocol v1.
- Do not publish either npm package as part of implementation unless the user
  gives separate release authorization.
- Do not remove the legacy Bridge workflow engine until migration and recovery
  acceptance gates pass.

## 3. Target Architecture

```text
ChatGPT browser
      │
      ▼
Bridge browser/workflow orchestration
      │
      ├── Bridge TUI renderer, editor, theme, input, overlays
      │
      └── Zipflow client SDK
              │
              │ HTTP/JSON + SSE over Unix domain socket
              ▼
        Zipflow workflow server
              │
              ├── project/workflow configuration
              ├── archive inspection and semantic surfaces
              ├── plan, conflicts, apply, checks
              ├── Git, deploy, history, rollback
              └── durable runs, operations, events, receipts
```

The standalone Zipflow TUI uses the same server API while preserving the
interactive behavior of the baseline product. This is the protocol completeness
test: the API supports Zipflow as a product, not only the subset required by
Bridge.

## 4. Repository Responsibilities

### 4.1 Zipflow repository

Zipflow implements and owns:

- server lifecycle and authentication;
- Unix-socket HTTP transport;
- protocol schemas and OpenAPI;
- the public Node client SDK;
- project sessions and canonical project identity;
- semantic surface and action projection;
- workflow configuration;
- archive blob storage and validation;
- durable operations, event journal, and idempotency receipts;
- all local workflow execution;
- standalone TUI adaptation to the server;
- protocol and conformance tests.

### 4.2 Bridge repository

Bridge implements and owns:

- daemon discovery and startup using its installed Zipflow dependency;
- connection health, reconnect, and compatibility handling;
- mapping Zipflow surfaces to Bridge-native view models;
- workflow detail rendering and input dispatch;
- ChatGPT-to-Zipflow artifact transfer;
- ChatGPT remediation and fix-until-pass orchestration;
- migration from Bridge workflow v3 to the server-backed workflow schema;
- Bridge integration, UI, recovery, and real-browser tests.

Bridge must not import Zipflow application or filesystem modules. It may import
only the public client SDK and protocol constants or schemas.

## 5. Package and Version Boundaries

### 5.1 Zipflow package exports

Add public package exports:

```json
{
  "exports": {
    ".": "./src/index.js",
    "./client": "./src/client/index.js",
    "./protocol": "./src/protocol/index.js"
  }
}
```

`zipflow/client` must contain transport and validation code only. Importing it
must not:

- initialize a workflow;
- read project files;
- install signal handlers;
- import Terlio;
- write to disk;
- start a server.

`zipflow/protocol` exports protocol version constants, stable enums, and JSON
Schema accessors without runtime side effects.

### 5.2 Target versions

- Target Zipflow feature version: `1.9.0` (the implementation baseline is
  already `1.8.3`; the integration must not downgrade the package).
- Target Bridge integration version: `6.4.0`.
- Zipflow workflow-file version and Bridge browser Protocol 5 are independent
  from the new server API version and must not be conflated with it.
- The server API URI major is `/v1`.
- `GET /v1/hello` returns an exact `apiVersion`, initially `1.0`.

Bridge uses an exact npm dependency during initial rollout:

```json
{
  "dependencies": {
    "zipflow": "1.9.0"
  }
}
```

The agent may use a local package or link while developing across the two
repositories, but committed package metadata must resolve to a publishable npm
version rather than an absolute local path.

## 6. Server Process and Unix Socket

### 6.1 Entry point

Add:

```text
zipflow serve
zipflow serve --socket /absolute/path.sock
zipflow serve --idle-timeout-ms 300000
```

The command runs in the foreground. Bridge may spawn it as a detached managed
daemon and rely on idle shutdown.

### 6.2 Default paths

Use:

```text
Socket directory: /tmp/zipflow-<uid>
Socket:           /tmp/zipflow-<uid>/api-v1.sock
Discovery file:   ~/.zipflow/runtime/server-v1.json
Token file:       ~/.zipflow/runtime/server-v1.token
Lock file:        ~/.zipflow/runtime/server-v1.lock
```

Requirements:

- socket directory mode `0700`;
- socket mode `0600`;
- token and lock files mode `0600`;
- verify that every existing runtime path is owned by the current UID;
- reject symlinks for runtime files and the socket directory;
- use a short `/tmp` path because macOS limits Unix-socket path length;
- never recursively delete the socket directory;
- remove only exact validated stale runtime paths.

### 6.3 Discovery metadata

`server-v1.json` contains:

```json
{
  "pid": 12345,
  "socketPath": "/tmp/zipflow-501/api-v1.sock",
  "apiVersion": "1.0",
  "zipflowVersion": "1.4.0",
  "serverEpoch": "opaque-uuid",
  "startedAt": "2026-07-28T00:00:00.000Z"
}
```

The authentication token is never written to this file.

### 6.4 Startup and stale-state rules

1. Acquire the lock using exclusive creation.
2. If a lock exists, read and validate discovery metadata.
3. Attempt `GET /v1/hello`.
4. Reuse the server only when authentication and API compatibility succeed.
5. Never kill an incompatible or unresponsive PID automatically.
6. Exact socket and metadata cleanup is allowed only when:
   - the PID is proven absent;
   - the socket is unreachable;
   - every path passes ownership, type, and parent validation.
7. Write the token and discovery metadata atomically before accepting clients.
8. On graceful shutdown, stop accepting new mutations, settle or refuse active
   critical operations, emit `server.stopping`, close streams, then unlink the
   exact socket and runtime metadata.

### 6.5 Authentication

Every `/v1` request except no endpoint requires:

```text
Authorization: Bearer <token>
```

Even `/v1/hello` requires authentication. An unauthenticated process must not be
able to discover projects, versions, runs, or capabilities through the socket.

## 7. Transport Choice

Use Node HTTP/1.1 over `server.listen(socketPath)`.

Treat the listen target as a local-endpoint abstraction. The v1 release default
is a Unix domain socket on macOS and Linux. The boundary must also accept a
Windows named-pipe path (`\\.\pipe\...`) through a platform adapter; protocol,
router, authentication, idempotency, application, and client code must not
depend on POSIX path or permission semantics. POSIX UID/mode/symlink checks and
future Windows owner/DACL/reparse-point checks belong to separate
runtime-security adapters.

The Node client uses:

```js
http.request({
  socketPath,
  path,
  method,
  headers,
});
```

Do not depend on global `fetch` for Unix-socket transport.

Use:

- JSON for bounded request and response bodies;
- raw `application/zip` streaming for blob upload;
- `text/event-stream` for events;
- cursor pagination for potentially large collections;
- separate endpoints for plans, diffs, reports, and command output.

## 8. Protocol Conventions

### 8.1 Hello response

`GET /v1/hello`

```json
{
  "apiVersion": "1.0",
  "schemaRevision": 1,
  "serverEpoch": "opaque-uuid",
  "server": {
    "name": "zipflow",
    "version": "1.4.0",
    "platform": "darwin"
  },
  "capabilities": [
    "projects",
    "workflow_config",
    "blobs",
    "archive_runs",
    "check_runs",
    "semantic_surfaces",
    "actions",
    "plans",
    "diffs",
    "history",
    "rollback",
    "events"
  ],
  "links": {
    "openapi": "/v1/openapi.json",
    "schemas": "/v1/schemas"
  }
}
```

Bridge must verify:

- API major equals `1`;
- all required capabilities are present;
- `schemaRevision` is within the supported range;
- unknown optional capabilities are ignored.

### 8.2 Mutations

Every state-changing request requires:

```text
Idempotency-Key: <opaque caller-generated value>
```

Rules:

- the same key and semantically identical request return the original receipt;
- the same key with a different request returns `409 IDEMPOTENCY_CONFLICT`;
- receipts are persisted before success is returned;
- receipts for active runs are never pruned;
- terminal receipts are retained with the run and follow run-retention policy.

### 8.3 Revisions

Mutable resources return:

```text
ETag: "<revision>"
```

Mutation of an existing resource requires:

```text
If-Match: "<expected-revision>"
```

A mismatch returns `409 STALE_REVISION` with the current revision and no state
change.

Dynamic actions are valid only for the surface revision that advertised them.

### 8.4 Errors

Use `application/problem+json`:

```json
{
  "type": "https://zipflow.dev/problems/stale-revision",
  "title": "Stale workflow revision",
  "status": 409,
  "code": "STALE_REVISION",
  "message": "The workflow changed after this action was displayed.",
  "retryable": true,
  "details": {
    "currentRevision": 18
  },
  "recoveryAction": "refresh"
}
```

Required stable codes:

- `AUTH_REQUIRED`
- `API_INCOMPATIBLE`
- `CAPABILITY_MISSING`
- `PROJECT_NOT_FOUND`
- `RUN_NOT_FOUND`
- `OPERATION_NOT_FOUND`
- `STALE_REVISION`
- `ACTION_NOT_AVAILABLE`
- `ACTION_INPUT_INVALID`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `OPERATION_BUSY`
- `UNSAFE_ARCHIVE`
- `ARCHIVE_LIMIT_EXCEEDED`
- `CANCEL_DEFERRED`
- `STREAM_GAP`
- `INTERNAL_ERROR`

Do not expose stack traces, secrets, environment variables, tokens, or raw
credential-like file contents in API errors.

## 9. Resource API

### 9.1 Protocol documents

```text
GET /v1/hello
GET /v1/openapi.json
GET /v1/schemas
GET /v1/schemas/{name}
```

OpenAPI and schemas must be served from the same checked-in sources used by
tests. Do not maintain independent runtime and documentation definitions.

### 9.2 Projects

### Open project

```text
POST /v1/projects/open
Idempotency-Key: ...
Content-Type: application/json
```

Request:

```json
{
  "path": "/absolute/canonical-or-resolvable/project/path",
  "client": {
    "name": "chatgpt-bridge",
    "instanceId": "opaque-id"
  }
}
```

Response:

```json
{
  "projectId": "opaque-project-id",
  "canonicalPath": "/absolute/canonical/project/path",
  "project": {
    "name": "project-name",
    "technologies": [],
    "labels": []
  },
  "workflowConfigured": true,
  "workflowRevision": 9,
  "activeRunId": null,
  "surface": {}
}
```

Project identity is derived from the canonical path. Reopening the same project
through a symlink or path alias returns the same `projectId`.

### Project summary

```text
GET /v1/projects/{projectId}
```

Returns project metadata, workflow summary, active operations, current
attention, and links. It must not inline full history, plans, diffs, or output.

### 9.3 Workflow configuration

```text
GET /v1/projects/{projectId}/workflow
PUT /v1/projects/{projectId}/workflow
```

The PUT body is a complete replacement draft, not a JSON merge patch.

PUT requirements:

- `If-Match`;
- `Idempotency-Key`;
- full Zipflow workflow validation;
- atomic persistence;
- no mutation on validation failure;
- normalized configuration returned in the response.

API clients may select configured checks and policies. Run endpoints must not
accept new shell command strings.

### 9.4 Blob upload

```text
POST /v1/blobs
Content-Type: application/zip
Content-Length: ...
X-Zipflow-Filename: result.zip
Idempotency-Key: ...
```

Response:

```json
{
  "blobId": "sha256:...",
  "sha256": "...",
  "size": 123456,
  "filename": "result.zip",
  "createdAt": "2026-07-28T00:00:00.000Z"
}
```

Requirements:

- stream to an isolated temporary file;
- enforce configured compressed-size limits while reading;
- hash while streaming;
- fsync and atomically publish to Zipflow-owned blob storage;
- deduplicate by hash;
- never trust the supplied filename as a path;
- delete an incomplete temporary file after failure;
- do not expose a general arbitrary-path import endpoint in protocol v1.

The standalone Zipflow client and Bridge both upload selected local archives
through this endpoint.

### 9.5 Start archive run

```text
POST /v1/projects/{projectId}/runs
Idempotency-Key: ...
Content-Type: application/json
```

Request:

```json
{
  "kind": "archive",
  "blobId": "sha256:...",
  "seriesId": null,
  "correlation": {
    "producer": "chatgpt-bridge",
    "workflowId": "bridge-workflow-id",
    "requestId": "bridge-request-id"
  }
}
```

Response status `202`:

```json
{
  "runId": "opaque-run-id",
  "operationId": "opaque-operation-id",
  "status": "running",
  "links": {
    "run": "/v1/runs/...",
    "operation": "/v1/operations/...",
    "events": "/v1/events?runId=..."
  }
}
```

The response is returned after durable run creation and before long archive
inspection completes.

### 9.6 Start configured check run

```text
POST /v1/projects/{projectId}/check-runs
Idempotency-Key: ...
Content-Type: application/json
```

Request:

```json
{
  "seriesId": "optional-series-id",
  "checkIds": ["configured-check-id"]
}
```

Omitting `checkIds` runs every selected check in workflow order. Unknown or
unselected IDs return validation errors. Raw commands are forbidden.

### 9.7 Runs and operations

```text
GET  /v1/runs/{runId}
GET  /v1/operations/{operationId}
POST /v1/operations/{operationId}/cancel
```

Run status enum:

```text
created
inspecting
waiting_action
applying
checking
committing
deploying
completed
failed
cancelled
rolled_back
uncertain
```

Operation settlement enum:

```text
active
cancel_requested
cancel_deferred
succeeded
failed
cancelled
uncertain
```

Cancellation returns:

- `202` while cancellation is pending or deferred;
- `200` when the operation is already terminal;
- the current operation resource in both cases.

### 9.8 Semantic surface and actions

```text
GET  /v1/runs/{runId}/surface
POST /v1/runs/{runId}/actions/{actionId}
```

Action request:

```json
{
  "input": {}
}
```

The action endpoint requires `If-Match` for the surface revision and an
idempotency key.

Actions include apply, keep local, conflict resolution, retry, commit, continue
without commit, deploy, skip deploy, finish, and rollback when those actions are
valid. There must be no generic action that executes an arbitrary command.

### 9.9 Plan, diff, output, history, and reports

```text
GET /v1/runs/{runId}/plan?group=<kind>&cursor=<cursor>&limit=<n>
GET /v1/runs/{runId}/diff?path=<encoded-relative-path>&mode=<mode>
GET /v1/runs/{runId}/output?source=<checks|deploy>&cursor=<cursor>
GET /v1/runs/{runId}/report
GET /v1/projects/{projectId}/history?cursor=<cursor>&limit=<n>&status=<status>
```

Requirements:

- cursor values are opaque;
- enforce server-side maximum page sizes;
- validate every requested relative path against the run manifest;
- diff responses contain semantic hunks and lines, never ANSI;
- output responses are bounded and preserve truncation metadata;
- reports are sanitized using existing Zipflow report policy.

Rollback is advertised as a run action. Do not add a second unconditional
rollback mutation endpoint.

## 10. Semantic Surface Contract

### 10.1 Surface

Minimum shape:

```json
{
  "id": "surface-id",
  "kind": "plan_review",
  "revision": 17,
  "title": "Review changes",
  "summary": "3 added, 2 changed, 0 removed",
  "stage": {
    "id": "review",
    "index": 2,
    "count": 5
  },
  "sections": [],
  "actions": [],
  "links": {}
}
```

Required surface kinds:

- `project_home`
- `workflow_setup`
- `archive_inspecting`
- `archive_root_choice`
- `archive_safety`
- `plan_review`
- `plan_files`
- `conflict_summary`
- `conflict_file`
- `operation_progress`
- `checks_failed`
- `commit_choice`
- `commit_message`
- `deploy_choice`
- `completed`
- `history`
- `run_details`
- `rollback_confirm`
- `error`

Do not mirror every current Zipflow TUI screen name mechanically. Combine
screens when they represent the same semantic client responsibility.

### 10.2 Sections

Sections are a discriminated union. Protocol v1 must support:

- `text`
- `summary_fields`
- `progress`
- `choice_list`
- `plan_summary`
- `file_groups`
- `file_details`
- `conflict`
- `check_results`
- `commit`
- `deployment`
- `history_rows`
- `warning_list`
- `error`

Large content is referenced through links rather than embedded.

### 10.3 Actions

Minimum shape:

```json
{
  "id": "approve-plan",
  "kind": "approve_plan",
  "label": "Apply update",
  "description": "Apply the reviewed file plan.",
  "enabled": true,
  "disabledReason": null,
  "risk": "project_write",
  "confirmation": "explicit",
  "inputSchema": null,
  "presentation": {
    "role": "primary"
  }
}
```

Risk enum:

- `read`
- `project_write`
- `process`
- `git`
- `deploy`

Confirmation enum:

- `none`
- `explicit`
- `dangerous`

Presentation role is a hint only:

- `primary`
- `secondary`
- `destructive`

Clients decide colors, placement, shortcuts, and focus.

Action `kind` is stable protocol data. `label` and `description` are display
copy and may change without changing action semantics.

### 10.4 Input schemas

Use JSON Schema for actions requiring input, including:

- archive-root selection;
- conflict choice;
- commit message;
- custom workflow configuration fields;
- search/filter values when server-side filtering is required.

Client-only navigation, menu search, focus, and scroll never use action input
schemas and are not sent to the server.

## 11. Event Stream

Endpoint:

```text
GET /v1/events?projectId=<id>&runId=<id>&operationId=<id>
Accept: text/event-stream
Last-Event-ID: <sequence>
```

SSE record:

```text
id: 184
event: operation.progress
data: {"serverEpoch":"...","sequence":184,"projectId":"...","runId":"...","operationId":"...","revision":17,"data":{"phase":"checks","completed":2,"total":4}}
```

Required event types:

- `project.changed`
- `workflow.changed`
- `surface.changed`
- `operation.started`
- `operation.progress`
- `operation.cancel_requested`
- `operation.settled`
- `run.attention`
- `run.completed`
- `run.failed`
- `run.rolled_back`
- `stream.gap`
- `server.stopping`

Rules:

- `serverEpoch` is stable for one server process.
- `sequence` is monotonic within an epoch.
- terminal, attention, mutation, and settlement events are durable.
- high-rate progress events may be coalesced.
- reconnect with a retained `Last-Event-ID` replays later events in order.
- an unavailable cursor emits `stream.gap` with `retainedFrom`, then closes the
  stream so the client performs full resource resynchronization.
- Bridge advances its cursor only after applying the event to its own durable
  workflow state.

## 12. Zipflow Internal Implementation

### 12.1 Required module families

Create focused module families rather than one server/controller file:

```text
src/protocol/
  constants.js
  schemas.js
  validation.js
  errors.js

src/server/
  server.js
  router.js
  auth.js
  runtime-paths.js
  lifecycle.js
  project-registry.js
  operation-registry.js
  idempotency-store.js
  event-journal.js
  sse.js
  blob-store.js

src/application/
  workflow-session.js
  surface-projector.js
  action-registry.js

src/client/
  index.js
  http-client.js
  event-client.js
```

File names may be adjusted to match established repository conventions, but the
owner boundaries must remain visible.

### 12.2 Application extraction

The current Zipflow controller mixes workflow orchestration and TUI navigation.
Refactor it incrementally:

1. Keep archive, plan, apply, check, Git, deployment, history, and security
   modules as the execution source of truth.
2. Introduce a `WorkflowSession` that owns:
   - canonical project and workflow state;
   - current run and operation references;
   - the semantic surface;
   - advertised actions;
   - durable transition ordering.
3. Move action meaning out of selected-menu indexes. Every executable user
   choice must have a stable semantic ID.
4. Keep focus, selected index, search query, scroll, pointer state, and viewport
   state in clients.
5. Introduce a surface projector from domain/application state.
6. Make both the server and standalone TUI dispatch semantic action IDs through
   the same application boundary.
7. Do not duplicate apply/check/commit logic in the server router.

### 12.3 Multi-client and multi-project rules

- Multiple read clients may observe one project.
- Only one mutating operation may own a canonical project at a time.
- Different projects may run concurrently when their locks and operation
  managers are independent.
- A client disconnect does not cancel an operation.
- Cancellation is an explicit authenticated action.
- Project locks and durable run state, not client connections, determine
  ownership and recovery.

### 12.4 Blob and idempotency storage

Store server-owned data below the existing Zipflow home using dedicated roots:

```text
~/.zipflow/server/blobs/
~/.zipflow/server/idempotency/
~/.zipflow/server/events/
```

Use existing durable atomic-write helpers. Apply retention without deleting
blobs or receipts referenced by active or retained runs.

### 12.5 Standalone Zipflow client

After server behavior is complete:

- `zipflow` ensures a compatible local server exists;
- it opens the current project through `zipflow/client`;
- it maps semantic surfaces to the existing Zipflow renderer;
- it sends semantic actions rather than calling application functions directly;
- it keeps its own theme, localization, focus, editor, and navigation state.

Do not remove direct-mode implementation until the client-backed TUI passes the
full existing test suite. A temporary development switch is acceptable during
migration; the released path must have one application source of truth.

## 13. Bridge Implementation

### 13.1 New Bridge owners

Introduce:

- `ZipflowDaemonManager`
  - resolves the installed Zipflow server executable;
  - reads validated discovery/token files;
  - performs hello and capability checks;
  - starts a compatible daemon when absent;
  - exposes health and reconnect state.
- `ZipflowWorkflowClient`
  - wraps `zipflow/client`;
  - owns project IDs, event subscriptions, retries, and bounded API errors;
  - never decides workflow policy.
- `WorkflowSurfaceController`
  - stores the current surface projection;
  - maps Bridge user interactions to advertised action IDs;
  - retains client-only focus, scroll, search, and editor state.
- Bridge surface renderers
  - generic sections/actions renderer;
  - plan/file renderer;
  - unified and side-by-side diff renderer;
  - progress/check renderer;
  - workflow setup renderer;
  - history/run-details renderer.

### 13.2 TUI integration

- Preserve the existing Bridge header, footer, theme, prompt editor, pointer
  handling, and terminal lifecycle.
- Background Zipflow events add stable Bridge transcript/activity entries.
- Attention creates a native Bridge action block.
- Opening an action displays a detail surface in the current Bridge runtime.
- `Esc` returns to the exact prior chat view without cancelling the server run.
- The chat prompt draft and scroll state are preserved while a workflow detail
  surface is open.
- On narrow terminals, workflow details use the full main area.
- On wide terminals, background progress remains visible in the Activity panel.
- User-facing UI must say **Workflow**, **Review changes**, **Project checks**,
  **History**, and **Rollback**, not **Zipflow server**.
- The implementation name may appear only under advanced diagnostics and
  third-party notices.

### 13.3 Command behavior

- `/workflow`
  - opens current attention when present;
  - otherwise opens the unified Bridge workflow setup/management surface;
  - reads and writes local workflow configuration through the server.
- `/apply`
  - uploads the selected artifact to `/v1/blobs`;
  - starts an archive run;
  - opens review when the server advertises attention.
- `/apply --plan`
  - starts inspection but never sends an apply action;
  - opens the plan surface.
- `/apply --interactive`
  - remains a compatibility alias for `/apply`.
- `/apply --force`
  - must not bypass server safety;
  - reject it with guidance to use configured workflow policy.
- Existing `/result`, `/recover`, and artifact selection continue to select the
  source ZIP; they do not mutate the project directly.

### 13.4 Artifact transfer

Bridge must:

1. Resolve the selected FileStore artifact.
2. Verify it is still the exact validated regular file.
3. Stream it to `/v1/blobs`.
4. Verify the returned size and SHA-256 against Bridge metadata.
5. Persist `blobId`, hash, and correlation before starting a run.
6. Never pass Bridge FileStore paths as arbitrary server path inputs.

### 13.5 Workflow state v4

Bridge workflow v4 stores:

```json
{
  "localWorkflow": {
    "backend": "zipflow-server-v1",
    "projectId": "opaque-id",
    "runId": "opaque-id",
    "operationId": "opaque-id",
    "seriesId": "opaque-id",
    "blobId": "sha256:...",
    "archiveSha256": "...",
    "serverEpoch": "...",
    "eventCursor": 184,
    "lastSurfaceRevision": 17
  }
}
```

It must not copy the Zipflow plan, conflict map, backup manifest, check output,
or Git state into Bridge persistence.

### 13.6 Reconnect

On server disconnect:

1. Mark local workflow connectivity degraded without terminating ChatGPT work.
2. Stop issuing mutations.
3. Reconnect using bounded backoff.
4. Perform `/v1/hello`.
5. If the epoch changed, reopen the canonical project.
6. Fetch the current run and operation by ID.
7. Replace the local surface projection from the authoritative run resource.
8. Resume SSE from the retained cursor when possible.
9. On `stream.gap`, fetch full project/run/operation state and store the new
   cursor only after successful resynchronization.
10. Never repeat a mutation solely because its response was lost.

### 13.7 Fix-until-pass series

Bridge owns the ChatGPT loop. Zipflow owns local iterations.

Sequence:

1. Create or restore a Bridge series ID.
2. Start configured check run.
3. If checks pass, request the advertised series-completion/commit action.
4. If checks fail, fetch bounded failure output and build the ChatGPT repair
   request.
5. Download and upload the new ZIP.
6. Start an archive run correlated to the same series.
7. Resolve advertised local actions through Bridge UI or configured policy.
8. Run checks again.
9. Stop at configured Bridge attempt/no-progress limits.
10. Let Zipflow create checkpoints and perform only the advertised final squash
    or commit action.

Bridge must never stage or rewrite Git history itself in the server-backed path.

## 14. Result Metadata

Add protected archive metadata:

```text
.zipflow/result.json
```

Schema:

```json
{
  "version": 1,
  "status": "changed",
  "summary": "Implemented the requested change.",
  "commitMessage": "Implement requested change",
  "files": ["src/example.js"],
  "producer": {
    "name": "chatgpt-bridge",
    "workflowId": "bridge-workflow-id",
    "requestId": "bridge-request-id",
    "projectId": "bridge-project-id"
  }
}
```

Rules:

- status enum: `changed`, `unchanged`, `completed`;
- summary is required and non-empty;
- file paths are optional, advisory, safe relative paths;
- effective changes come from the Zipflow plan, not the declared file list;
- `.zipflow/result.json` and all `.zipflow/` control files are never applied;
- `.zipflow/commit-message.txt` takes precedence over `commitMessage`;
- Bridge validates producer correlation before accepting a result into a
  workflow.

Update Bridge workflow instructions to request the new metadata.

## 15. MCP Compatibility

MCP is not required to complete the initial Bridge rollout, but protocol v1 must
support it without server changes.

After server and Bridge stabilization, add:

```text
zipflow mcp --socket <path>
```

The MCP adapter:

- imports `zipflow/client`;
- connects to the authenticated Unix socket;
- exposes stable tools for open project, inspect archive, get state, list
  actions, act, get plan, get diff, run checks, history, and rollback;
- exposes large plans, diffs, reports, and output as resources;
- maps action risk classes to explicit approval boundaries;
- never bypasses revisions, idempotency, project locks, or advertised actions.

Do not encode Bridge screen names or ChatGPT concepts in MCP tools.

## 16. Migration

### 16.1 Zipflow migration

- Preserve existing workflow files and normalize them through current Zipflow
  migration logic.
- Do not create a second server-specific workflow format.
- Preserve existing run history and backup locations.
- Standalone TUI and server clients must see the same workflow and history.

### 16.2 Bridge workflow migration

Migration is allowed only when the legacy workflow has no dispatched or
uncertain unsafe local effect.

Map:

- `apply.sync=true` → Zipflow snapshot mode;
- `apply.sync=false` → overlay mode;
- Bridge check command list → Zipflow configured checks;
- checkpoint and result-commit policy → Zipflow Git policy;
- deployment command and policy → Zipflow deployment policy;
- protected paths and exclusions → stricter union with Zipflow defaults;
- ChatGPT binding, model, effort, remediation, attempts, session exhaustion,
  notifications, and no-progress policy remain Bridge-owned.

The migrated draft is shown in the Bridge workflow UI and requires explicit
confirmation before saving.

Active legacy runs continue on the legacy backend until terminal. New workflows
use the server backend after the development flag becomes the default.

Do not delete or overwrite legacy state files. Archive them read-only after a
successful migration receipt is durable.

## 17. Security Requirements

- Unix socket and token authenticate clients.
- API authentication does not auto-approve high-risk actions.
- Every action includes a risk class.
- Editing executable commands and enabling dangerous autonomy require explicit
  workflow configuration confirmation.
- Run endpoints accept configured command IDs only.
- Deployment requires an advertised `deploy` action and configured command.
- No API response contains environment secrets, tokens, credential file
  contents, or unbounded process output.
- Blob filenames are display metadata only.
- Archive and diff paths use existing Zipflow path-safety logic.
- The server binds no TCP port by default.
- If TCP support is later added, it is a separate security design and not an
  incidental server option.

## 18. Test Requirements

### 18.1 Zipflow tests

Add tests for:

- runtime path ownership, permissions, and symlink rejection;
- socket path length on macOS-compatible paths;
- exclusive startup and stale-state recovery;
- token authentication;
- hello/capability negotiation;
- OpenAPI and JSON Schema validity;
- schema/runtime route parity;
- blob streaming, limits, hashing, deduplication, and cleanup;
- canonical project identity;
- workflow revision conflicts;
- idempotency receipt replay and conflict;
- semantic surface/action projection;
- stale and duplicate actions;
- archive inspection through completion;
- cancellation before, during, and after critical sections;
- durable operation reconciliation after server restart;
- SSE ordering, reconnect, epoch, cursor replay, coalescing, and gap events;
- plan/diff pagination and path safety;
- history and rollback availability;
- redacted errors;
- client SDK side-effect-free import;
- standalone TUI parity against existing workflow fixtures;
- packed-package server and client smoke tests.

### 18.2 Bridge tests

Add tests for:

- daemon discovery, startup, compatibility, and unavailable state;
- authenticated UDS client behavior;
- artifact upload and hash verification;
- workflow state v4 persistence;
- event application and durable cursor advancement;
- reconnect with same and changed server epochs;
- gap resynchronization;
- generic and specialized surface rendering;
- action input validation and stale-action refresh;
- preservation of chat draft, scroll, selection, theme, pointer mode, and
  terminal cleanup;
- `/workflow`, `/apply`, `/apply --plan`, and rejected `/apply --force`;
- apply-changes, guided-task, and fix-until-pass presets;
- failed check → ChatGPT remediation → new archive → success;
- no duplicate apply/commit/deploy after lost responses or restarts;
- legacy workflow migration gates;
- server failure not terminating ordinary ChatGPT use;
- absence of Zipflow branding in normal UI.

### 18.3 Cross-repository conformance

Create shared JSON fixtures covering:

- hello;
- every surface kind;
- every section kind;
- every risk and confirmation class;
- every stable error code;
- SSE replay and gap;
- one successful archive run;
- one conflict run;
- one failed-check run;
- one rollback.

Zipflow validates that it produces conforming fixtures. Bridge validates that it
can consume and render them. The fixtures must be copied from one canonical
generated artifact or package resource, not maintained manually in divergent
forms.

### 18.4 Real integration

Add a local two-process integration test:

1. Build or pack Zipflow.
2. Start `zipflow serve` on a temporary Unix socket.
3. Start Bridge with a temporary data directory and injected socket/token.
4. Upload a fixture project ZIP.
5. Inspect, approve, apply, and run checks.
6. Restart the Zipflow server during a non-critical stage and reconnect.
7. Verify exact project bytes and one run receipt.
8. Run a failed-check remediation cycle with a fake ChatGPT transport.
9. Verify history and rollback.
10. Shut down and verify terminal, socket, lock, and temporary-file cleanup.

Authenticated real-browser E2E remains a release gate after deterministic local
integration passes.

## 19. Implementation Phases and Gates

### Phase 0: Baseline

- Run both repositories' current static checks and full unit suites.
- Record existing failures without modifying unrelated behavior.
- Confirm working-tree state and preserve unrelated changes.

Gate: both baselines are understood and reproducible.

### Phase 1: Protocol and client skeleton

- Add constants, schemas, OpenAPI, errors, conformance fixtures, UDS HTTP client,
  and SSE client.
- Implement authenticated `/v1/hello`.

Gate: packed Zipflow client connects to a test server; schema and side-effect
tests pass.

### Phase 2: Server lifecycle and durable infrastructure

- Add secure runtime paths, server startup, auth, project registry, blob store,
  idempotency store, operation registry, event journal, and SSE.

Gate: lifecycle, security, retry, restart, and stream tests pass without project
mutation.

### Phase 3: Workflow application projection

- Introduce `WorkflowSession`, semantic surfaces, stable actions, and revisions.
- Connect existing Zipflow archive/run modules to server resources.

Gate: complete archive/check/history/rollback flows pass through HTTP with no
TUI.

### Phase 4: Standalone Zipflow client parity

- Move the existing Zipflow TUI onto the server/client boundary.
- Add a separate functional-regression gate derived from Zipflow commit
  `f44e0cb127437ea6ce3e4c7773ccf553673d74dc` (version 1.8.3). Keep a
  checked-in capability manifest covering project discovery, setup, archive
  review, apply/rollback, checks/deploy, Git, history/export, LLM/autopilot,
  settings/localization, updates, terminal UX, cancellation, and recovery.
- Keep every manifest entry bound to deterministic current tests. Do not remove
  direct mode or mark client-backed parity complete while any baseline
  capability is available only through the retained direct implementation.

Gate: the full existing Zipflow verification and package-release suite passes
through the client-backed path, and `npm run test:functional-baseline` proves
that no capability present at `f44e0cb1` was dropped or silently made
unreachable.

### Phase 5: Bridge read-only integration

- Add daemon manager, client, SSE state, workflow configuration rendering,
  history, plan, and diff views.

Gate: Bridge can configure and inspect a workflow without mutating the project,
and UI state remains stable.

### Phase 6: Bridge mutation integration

- Add artifact upload, actions, apply, checks, commit, deployment, rollback, and
  all three presets.

Gate: deterministic local cross-process integration passes, including restarts
and no duplicate mutations.

### Phase 7: Migration and default switch

- Add Bridge v3→v4 migration, allow legacy active runs to settle, make the server
  backend the default for new workflows, and archive migrated state.

Gate: migration fault matrix and authenticated workflow E2E pass.

### Phase 8: Cleanup and optional MCP adapter

- Remove obsolete Bridge local workflow mutation modules only after coverage
  proves the server path.
- Add MCP adapter and examples as a separate deliverable.

Gate: no direct project mutation, checks, Git, or deployment remain in the
Bridge server-backed workflow path.

## 20. Definition of Done

The work is complete only when:

- Bridge provides one visually consistent TUI with no transition to Zipflow UI;
- workflow setup is available inside Bridge and persists the shared Zipflow
  workflow;
- protocol v1 is documented, schema-validated, authenticated, and versioned;
- Bridge, standalone Zipflow, and the client SDK pass shared conformance
  fixtures;
- all local mutations are owned by Zipflow;
- all ChatGPT orchestration is owned by Bridge;
- retries and restarts cannot duplicate unsafe actions;
- the full three-preset workflow and rollback pass deterministic integration;
- real-browser workflow E2E passes;
- legacy active work is not silently discarded;
- documentation describes operation, diagnostics, recovery, and security;
- both repositories pass their complete verification and package-install gates.

## 21. Handoff Rules for the Implementing Agent

- Read both repositories' current architecture, goals, and development
  instructions before editing.
- Work phase by phase and keep each phase independently testable.
- Do not implement Bridge-specific shortcuts in the Zipflow protocol.
- Do not copy Zipflow execution logic into Bridge.
- Do not expose controller-selected indexes or Terlio structures through the
  API.
- Convert every discovered production defect into a deterministic regression
  test.
- Preserve unrelated working-tree changes and existing unpublished commits.
- Do not publish packages, push, or create releases without explicit user
  authorization.
- When a phase changes a public contract, update schemas, OpenAPI, fixtures,
  client validation, and both repositories' documentation in the same phase.
