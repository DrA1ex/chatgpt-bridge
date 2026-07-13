# Project Context

This is a local Node.js bridge that lets CLI/API/RPC clients drive a logged-in ChatGPT browser tab through a Chrome/Chromium extension. The project is in the extension-only architecture; legacy Tampermonkey names remain in code for compatibility but should not drive new design.

## Architecture

```text
Client / CLI / API / Codex RPC
  -> Express routes / interactive shell / Ink UI
  -> TampermonkeyHub          # legacy name; browser client registry + WebSocket hub
  -> TampermonkeyBridge       # legacy name; prompt lifecycle + artifact/recovery commands
  -> Chrome extension background
  -> Chrome extension content script
  -> ChatGPT Web UI
```

Key runtime facts:

- The extension background owns the WebSocket to the local server.
- The content script owns ChatGPT DOM automation.
- ChatGPT page CSP blocks ordinary page-created localhost WebSockets, so do not move production transport into page JS.
- Multiple ChatGPT tabs must remain separate clients. Do not use origin-wide `localStorage` as tab identity.
- The content script should not run inside ChatGPT iframes.

## Current status

Implemented through Phase 6 plus the v53-v69 DOM-parser, artifact-download, extension compatibility, watchdog, thinking-reconciliation, and UX reviews:

- extension-only runtime and setup diagnostics;
- version-aware extension handshake: outdated/incompatible clients remain visible for diagnostics but are excluded from active selection and prompt delivery; the extension panel shows an explicit update error;
- setup/onboarding UI is user-facing by default, with raw status/logs hidden under Advanced & diagnostics; the floating Bridge control is shown only on chat routes;
- source-client metadata preservation for artifacts/recovery/result resolution;
- token-bound automatic tab opening for opt-in server/interactive requests and the live E2E runner; existing extension clients can create a tab directly, while a no-client fallback opens the system browser and accepts only the client carrying the one-time token;
- normal project `request.done` convergence into result resolving and apply planning;
- Steer/Continue finalization guard;
- visible progress/thinking stream separated from artifact detection;
- selected result safety guard for `/apply`;
- phase-specific watchdog and source-bound forced snapshot;
- watchdog scheduling cannot be postponed indefinitely by weak heartbeats; current generation state is distinct from historical generation;
- normal/recovery result-pipeline failures emit explicit recoverable events while preserving the final assistant answer;
- Ink transcript is append-only through `Static`; dynamic output is confined to one height-bounded answer/thinking/progress panel, debug events are opt-in, and user-facing task milestones are appended directly to the transcript instead of occupying a permanent event panel;
- user prompts are preserved in full in the Ink transcript; progress/tool item fingerprints are tracked separately from aggregate text so individual visible steps are not lost when only item state changes;
- prompt tab targeting prefers the requested ChatGPT session, then asks before switching any idle fallback tab to another session; busy tabs are excluded and active-request ownership is exposed.
- ChatGPT DOM parsing now treats the assistant turn, visible reasoning/tool blocks, and the final author node as separate entities; persistent tool siblings are not mixed into the final answer.
- completion requires a final assistant author node, no Stop, a visible response action bar, stable structural signature, no active tool/Continue/confirmation/error, and the expected conversation id.
- transient reasoning/progress clearing propagates through the bridge so stale UI status does not remain after the final answer; visible reasoning history is preserved separately.
- visible thinking/status blocks are reconciled by stable logical IDs rather than DOM node identity or text alone. Active shimmer labels update in the bounded Live area; a completed logical step is appended to the transcript exactly once, even after React replacement or forced snapshots.
- the floating Bridge launcher collapses to a clean status-bearing mark. Connection state remains visible through the embedded dot, while the label is hidden until hover/focus/open and animates without changing launcher width.
- generated-file cards are parsed across the whole assistant turn, including filename-only buttons and GENERATING/READY/FAILED state; final completion waits for all detected artifacts to be READY.
- artifact materialization is layered: page MAIN-world Blob/data interception first, scoped authenticated/direct URL fetch second, and expected-filename-matched `chrome.downloads` capture as a cancellable fallback.
- direct browser/page capture remains the primary fast path for ZIP, binary, and large artifacts. Text/table actions may instead open a delayed preview in a `role="dialog"`, a generic `[slot="content"]` panel, or a spreadsheet-style `popcorn-toolbar`. Preview identity may be exact filename, filename stem plus format label, or exact-action plus unique format; only then may the container use a bounded multilingual `aria-label` fallback for download/close because ChatGPT currently exposes no stable download id.
- artifact action selection is filename/locator-bound. A generated `selectorHint` is only a weak discovery hint because multiple file buttons may share the same CSS path. The runtime must resolve all candidates inside the exact source turn and click only a unique candidate whose filename matches or whose stable block/action locator matches. Opening another filename is a fail-fast identity error, not a reason to click again.
- artifact materialization uses a 45-second browser-side budget and a 60-second server command envelope. The runtime waits for state transitions with bounded backoff, cancels unused capture paths, and returns immediately on a proven identity/fatal failure instead of leaving a 120-second fallback pending. DOM URL fallback re-resolves the source turn on each poll to survive React replacement.
- ZIP resolution no longer rejects a scoped file action solely because DOM metadata lacks a `.zip` filename: when exactly one materializable artifact exists in the recovered turn, it is downloaded and its bytes are validated as ZIP; multiple ambiguous generic actions are never clicked automatically.

Do not start Phase 7+ unless explicitly asked. Future Phase 7-8 implementation details live in `GOAL.MD`.

v60 audit fixes are part of the existing Phase 5/6 scope: Apply rejects symlink-routed writes/deletes, interactive turn waiting cannot lose a terminal event during subscription setup, `/resume` follows already tracked work, and the UI distinguishes `tracking`/`reconnecting`/`resume available` from true `idle`. Returning a visible/focused tab triggers immediate DOM resync; this is in-memory reattachment only and does not replace Phase 7 durable checkpoints.

## Important source files

- `src/index.js`: constructs server, hub, bridge, stores, managers, project service, and RPC server.
- `src/routes.js`: API, file, artifact, job, project, thread/turn routes.
- `src/http/diagnostics.js`: diagnostics page/state/debug bundle helpers.
- `src/tampermonkeyHub.js`: browser client registry, compatibility gating, active client selection, WebSocket transport, token checks.
- `src/extensionCompatibility.js`: semantic version/protocol compatibility policy for bridge and extension handshakes.
- `src/tampermonkeyBridge.js`: request lifecycle, pending commands, progress/deltas, cancellation, source-client routing, artifact fetch.
- `tools/chrome-bridge-extension/content.js`: ChatGPT DOM automation, prompt submit, scoped observation, response/block extraction, artifact discovery, recovery list/select.
- `tools/chrome-bridge-extension/domParserCore.js`: pure turn-phase, visible-block grouping, snapshot-signature, and completion helpers.
- `docs/CHATGPT_DOM_PARSER.md`: observed turn/lifecycle DOM contract; read it before selector/lifecycle changes.
- `docs/CHATGPT_FILES_CODE_DOM.md`: observed input/output file, artifact, and code-block DOM contract.
- `tools/chrome-bridge-extension/artifactCaptureMain.js`: MAIN-world capture bridge for page-created Blob/data/URL artifact downloads.
- `tools/chrome-bridge-extension/background.js`: extension WebSocket relay, signed localhost file fetches, browser download capture.
- `src/turnManager.js`: thread/turn/item model, project turn lifecycle, result pipeline entry, recovery adoption.
- `src/resultResolver.js`: ZIP selection, same-turn artifact retry, download, validation, reconstruction from fenced `file:path` blocks.
- `src/interactiveLegacy.js`: shared command implementation for project tasks, recovery, selected results, and apply. Ink calls this layer.
- `src/interactiveInk.js`: default Ink/React terminal UI.
- `src/interactive/consoleCapture.js`: captures legacy console output for Ink event/status rendering.
- `src/interactive/lineEditor.js`: key decoding, word navigation, bracketed paste, slash completion helpers.
- `src/projectService.js`: project scan/pack/message orchestration.
- `src/project/service/`: scan ignore rules, symbol extraction, project context generation.
- `src/project/apply/`: path policy, snapshot reference, safety checks, planning, and apply runner.
- `src/metadataStore.js`: SQLite/JSON persistence for jobs, downloads, threads, turns, items, and events.

## Project workflow

A project task should follow this path:

```text
/project open <path>
/task <prompt>
TurnManager.startTurn
ProjectService packs/reuses snapshot
TampermonkeyBridge sends prompt to source browser client
content script anchors submitted user turn and assistant turn
request.done returns answer/thinking/progress/artifacts
TurnManager records final items
ResultResolver resolves expected ZIP output
selectedResult is set for the current project/session
apply planning runs; safe auto-apply may apply, otherwise /apply remains available
```

Plain prompts in Ink are routed to project task mode when a project is open. `/ask` is for lightweight questions and should not attach the full project ZIP.

## Project ZIPs

Input snapshots use:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

Returned ZIPs should contain project files at archive root. The prompt contract tells the model to return `package.json`, `src/...`, etc., not `project/package.json`. The apply fallback can treat a single top-level `project/` folder as the returned root, but protected metadata and ignored paths must remain blocked.

Never include obvious secrets, `.git`, `node_modules`, build output, caches, DB dumps, env files, or generated archives unless explicitly reviewed.

## Result and apply state

`selectedResult` is the source of truth for `/apply` without a path. It is scoped by active project root/id and ChatGPT session. It contains at least:

```text
turnId
projectId
projectRoot
sessionId
sourceClientId
sourceTurnKey
sourceRequestId
artifactId
fileId
name/size/sha256
confidence
stale/staleReason
```

Rules:

- New project tasks mark the previous selection stale and then clear/select based on the new result.
- A completed project turn without ZIP clears the selection.
- A completed ZIP from task, resume, or recovery selects the current result.
- `/apply` refuses stale selected results, selected results from another project, missing files, and low-confidence/manual results without confirmation.
- Safe auto-apply requires source-client identity; otherwise it skips and leaves the result selected for manual review.
- `lastAppliedTurnId` and `lastAppliedFileId` must never skip a fresh apply plan.

## Recovery contract

`/recover list` asks the browser companion for visible assistant-response candidates and prints browser candidate indexes:

```text
[1] turn 29 · 267 chars · 1 artifact(s) · preview
```

`/recover <n>` must interpret `n` as that candidate index. It must not treat `n` as a local turn id, database id, or the printed ChatGPT visual turn number.

Recovery flow:

1. Ask content script for the exact visible candidate via `response.recover.latest`.
2. Attach it to the current local turn if possible.
3. If no local turn exists and recovery is allowed, create an adopted recovery turn in the current project/session scope.
4. Store recovered thinking/answer/artifacts as turn items.
5. If ZIP output is expected, run the same `ResultResolver` pipeline as normal `request.done`.
6. Select the recovered ZIP result for the current scope.
7. `/recover <n> --apply` then calls the same `/apply` path.

A visible browser candidate plus missing local state is not enough reason to fail with `No turn is available for recovery`; use adopted recovery turns.

## Source-client routing

For an existing request, do not silently use a newly active ChatGPT tab. These operations must target the source client where available:

```text
artifact fetch
same-turn artifact retry
recover by assistant turn key
resume active known request
final snapshot / forced snapshot
```

Result metadata should preserve `sourceClientId`, `sourceRequestId`, and `sourceTurnKey` into downloads, events, diagnostics, and `selectedResult`.

For a new prompt with a known `sessionId`, tab selection is source-aware:

```text
1. use an idle connected tab already on the requested session;
2. otherwise, if a manually selected idle tab is the candidate, ask before switching it to the requested session;
3. otherwise, if exactly one idle tab is available, ask before using it and switching sessions;
4. if several idle fallbacks are available, require explicit `/select`;
5. never send a new prompt to a tab with `activeRequest`.
```

Non-interactive callers that cannot confirm an idle fallback should receive a clear `CLIENT_SELECTION_REQUIRED` error rather than silently using the wrong tab. `ownerServerInstanceId` is honored when an active request is reported, but there is no distributed cross-server lease/discovery layer: tabs connected only to another server are not candidates for this server.

## Extension DOM extraction constraints

The content script anchors extraction to the submitted user turn and the assistant turn after it. It must not use the latest pre-existing assistant message as fallback.

Parser hierarchy:

```text
conversation turn (`data-turn-id` is primary identity)
  -> visible reasoning/status/tool blocks
  -> final `[data-message-author-role="assistant"]` node
```

Only the final author node supplies `answer`. The full turn text is diagnostic `raw` data and must never become an answer/recovery fallback. Reasoning summaries may disappear when final streaming starts, so changed snapshots are emitted in real time; classless tool/status siblings are grouped structurally and remain separate from final Markdown.

The observer is scoped to `main`/`[role=main]`, rereads normalized state after mutations, and includes meaningful attributes in the snapshot signature. Missing/ambiguous composer or conversation roots produce `DOM_SCHEMA_CHANGED` instead of guessing.

Completion is composite:

```text
new assistant turn anchored to the submitted user turn
final assistant author node exists
Stop absent
response action bar present
signature stable >= 1500 ms
no active tool, Continue, confirmation, or visible error
conversation id still matches the requested session
```

Visible thinking/action/progress text is progress, not an artifact. Artifact discovery scans the whole anchored assistant turn because generated file cards can be siblings of the final author node. It accepts explicit file/download cards and filename-bearing scoped actions (including button-only `.txt`, `.csv`, `.json`, and ZIP files), tracks `GENERATING`/`READY`/`FAILED`, and excludes citations, copy/turn actions, tool controls, and generic status UI. Completion waits until every detected generated artifact is `READY`.

Artifact download is source-turn scoped and layered:

```text
1. MAIN-world interception captures page-created Blob/data downloads and their bytes;
2. a newly exposed direct/authenticated URL is fetched from the scoped artifact card;
3. chrome.downloads is a fallback for real browser downloads and must match the expected filename.
```

Only one path wins. Pending page/background captures are cancelled afterward so a later unrelated browser download cannot be claimed.

## Diagnostics

Use `/diagnostics` and diagnostics state/debug bundles for workflow debugging. Important signals:

```text
request.done
normal.done.received
normal.pipeline.started
result/resolving
artifact.downloading / artifact.downloaded
result.ready
apply/planning
apply/plan.ready
apply/skipped / apply/done / apply/failed
watchdog.*
forced_snapshot.requested / forced_snapshot.received / forced_snapshot.failed
selectedResult
```

`request.done` must not be a terminal dead end for project tasks.

## Testing

Minimum handoff checks:

```bash
npm run check
npm test
```

Coverage command:

```bash
npm run test:coverage
```

Current audited result: the v55 artifact metadata-fallback regression suite is included; use the latest test output rather than this count if the suite changes. The aggregate line-coverage command remains below the configured 70% threshold because large interactive/RPC/diagnostics entry points are undercovered; treat this as known test debt unless a task explicitly targets coverage.

Known current dependency note: `npm audit --omit=dev` reports 7 transitive vulnerabilities (5 high, 2 low) through `sqlite3`/`node-gyp`/`tar`; automatic remediation proposes the breaking `sqlite3@6` update and should be handled separately.

## Current deferred work

Phase 6: implemented and audited through v60. Weak heartbeat cannot reset meaningful progress or postpone watchdog checks; forced snapshots are source-bound, clear stale partial answer state when the current DOM snapshot is empty, and cannot complete a required-ZIP task without an artifact. A server-side artifact-settle guard continues probing the original assistant turn after an early text-only `done`, while the content script independently waits for generated-file readiness. Normal pipeline failures remain explicit and preserve the final answer.

v51/v52 UX: prompt target resolution prefers requested-session tabs, confirms any idle fallback tab before switching, safely resends the same request after full session navigation, excludes busy tabs, and reports request ownership. Ink uses a stable append-only transcript with a bounded live panel and opt-in debug events.

Phase 7: extension-side durable request memory. Next reliability phase for restoration after content/background/server memory is actually lost; v60 only improves in-memory reconnect detection and UX.

Phase 8: recovery as fallback only. Recovery works better now, but the full phase means normal successful `request.done` should make manual recovery unnecessary except as an explicit fallback.

## Real-browser E2E runtime (v61)

Run the opt-in live smoke suite with:

```bash
npm run test:e2e:real
npm run test:e2e:real -- --keep-session
```

`scripts/e2e-real.js` talks only to the public HTTP API. It starts the bridge when needed, records the previously selected client, creates a new isolated ChatGPT tab, selects that exact client, sends direct real prompts, verifies session continuity and a generated file artifact, then restores the previous selection.

Automatic tab opening has two paths:

```text
connected compatible extension client
  -> POST /browser/tabs/open
  -> background creates about:blank
  -> launch token + per-tab bridge server stored in chrome.storage.session
  -> tab navigates to ChatGPT
  -> runner waits for the client carrying that exact token

no connected client
  -> E2E starts on a free loopback port with an isolated DATA_DIR
  -> OS opens https://chatgpt.com/#chatgpt-bridge-launch=<token>&chatgpt-bridge-server=<loopback-url>
  -> content script connects this tab to that E2E server and removes the launch fragment
  -> bridge accepts only the exact token from handshake or exact launch URL fallback
```

Cleanup is deliberately fail-closed. The runner keeps the first response's concrete `sessionId` and canonical conversation URL. Before deletion it verifies that the exact E2E source client still reports that URL. `POST /sessions/delete` forwards both values to the same source tab; `domParserCore.verifySessionDeletionTarget` must pass before menu open, before delete click, and before confirmation. The menu action must be newly exposed by the current conversation's own menu. Any mismatch leaves the session/tab in place for inspection. `--keep-session` skips cleanup intentionally.

New control routes:

```text
POST /browser/tabs/open
POST /browser/tabs/close
POST /sessions/delete
```

These routes require the normal API bearer token. Session deletion additionally requires `expectedUrl`; tab close requires `sourceClientId` and can require both the launch token and expected current URL.

## Automatic prompt-tab creation (v62)

Ordinary HTTP, job, turn, legacy interactive, and Ink requests can opt into automatic tab creation with `autoOpenTab`, `AUTO_OPEN_TAB=1`, or `--auto-open-tab`.

Resolution order remains safety-first:

```text
explicit sourceClientId -> exact or fail
idle tab already on requested session -> reuse
unambiguous selected/active idle tab -> reuse
no safe target + auto-open enabled -> create dedicated token-bound tab
otherwise -> confirmation/CLIENT_SELECTION_REQUIRED/error as before
```

A requested session that is already busy is never duplicated automatically. When a browser-control-capable extension tab exists, its background creates `about:blank`, stores the launch identity and target bridge server in `chrome.storage.session`, then navigates to ChatGPT. When no control client reconnects within the bootstrap grace period, Node opens a ChatGPT URL in the system browser with exact one-time launch metadata. The content script validates a loopback-only per-tab server override, connects to it without changing the user's saved configuration, removes the launch fragment, and returns the token in its hello payload. The hub also recovers that exact token from the launch URL when a stale handshake omits it. Reconnecting unrelated tabs are ignored.


## Real E2E readiness and diagnostics (v64)

The live runner requires extension 0.4.10+ / content 2.12.9+ for page readiness and ZIP completion hardening. A token-bound client is not sufficient by itself: before sending, the runner waits for `pageReady && chatMainReady && composerReady`, then waits the configured settle interval. The content script independently waits again before each submit, verifies real submission evidence, and retries a bounded number of times.

Steer orchestration must observe the bridge's tracked request, not infer activity from elapsed time. `/health.activeRequests` is part of the diagnostic contract. The E2E scenario sends a separate steer only after prompt acceptance plus submission/generation evidence and requires the steer to override the original RED rule with exact BLUE.

Any prompt that needs a value across turns must say that the value is retained only in the current conversation context and must not be written to account-wide ChatGPT memory.

Default report location is project-local:

```text
.bridge-data/e2e/last-real-e2e/
.bridge-data/e2e/last-real-e2e.zip
```

`console.log`, `RUNNING.json`, `report.partial.json`, and `timeline.partial.ndjson` are created incrementally. Final files are verified non-empty. A report-write failure must not prevent owned-server termination or temporary-directory cleanup.

## Steer re-anchoring and locale-independent cleanup (v65)

A successful in-flight steer creates a new user turn and a new assistant turn in the same conversation. The content runtime now re-anchors the active request to that new pair and clears stale answer/artifact terminal state from the pre-steer assistant placeholder. This fixes the observed case where ChatGPT visibly returned the steered result but the bridge continued reading the earlier assistant turn and marked the request failed.

E2E conversation cleanup no longer uses localized visible labels or translated `aria-label` strings. Candidate triggers are selected structurally from the exact session row, stable conversation-menu test ids, or top-level menu relationships. The destructive action requires a stable conversation-delete `data-testid` and must belong to the trigger-owned or newly opened Radix menu. Confirmation is accepted only from the newly appeared modal through a semantic test id or one unique destructive button. Text is diagnostics-only; missing structural identity is a hard refusal.


### Delayed artifact-preview readiness

A file-preview shell may appear before its loader finishes and before its download control or content is mounted. Do not treat container appearance as readiness. Re-query the identity-bound container until the control is usable; require mounted CodeMirror content only for text viewers, not for CSV/table viewers. Extensionless display titles are matched with adjacent format labels, while arbitrary titles require the format to be unique among READY artifacts in the source turn. Real E2E messages are intentionally English-only and must explicitly prohibit account-wide memory updates when testing conversation-local context.


## Spreadsheet/table preview identity (v70)

The observed CSV preview uses `[slot="content"]` with `[data-testid="popcorn-toolbar"]`. Its visible title can omit the extension: `[data-testid="popcorn-file-title"]` exposes a display title such as `test_data` and a sibling format label such as `CSV`. The exact expected filename may therefore differ from both the display title and the eventual browser-download filename.

The runtime first proves the artifact action inside the source assistant turn, then binds the preview by exact filename, exact display title, stem+format, or an arbitrary display title only when the expected format is unique in that turn. Once bound, the display title plus expected extension is added as a temporary capture alias. This permits `test_data.csv` while preserving the original generated filename as an alternative. Multiple same-format artifacts without stronger identity remain ambiguous and fail closed.


## 2026-07-13 — v71 ZIP completion guard and bounded waits

The real E2E ZIP failure was not a regression in direct ZIP download. The exact ZIP action was present and READY. A generic code-block Copy button also exposed `data-state="closed"`; the broad state scanner read nearby Python source, extracted `alpha.txt`, and emitted a phantom `GENERATING` artifact. Because completion requires all real lifecycle artifacts to be terminal, this false item kept the request alive until the runner's former 300-second envelope expired.

State-only artifact discovery now requires explicit lifecycle evidence (`aria-busy`, progressbar, loader/spinner/generating/error metadata). Generic buttons and anchors are excluded from that path. Non-lifecycle leaked candidates are defense-in-depth non-blocking. Required ZIP output is satisfied only by a materializable ZIP, not by any READY file. Post-generation required-artifact snapshots use bounded backoff and a 30-second ceiling; real E2E request and materialization budgets are 90 and 45 seconds respectively.
