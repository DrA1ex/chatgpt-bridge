# Project Context / Current Handoff

This file is the working handoff for `chatgpt-browser-bridge-node`. Keep it current when changing the bridge, CLI, extension, project-task, recovery, artifact, or terminal-input flows.

## What this project does

This is a local Node.js bridge that lets a terminal/IDE-like client drive an already logged-in ChatGPT browser tab. The current supported runtime is the Chrome/Chromium extension only. The old Tampermonkey/userscript path is intentionally dropped, although several internal names still say `tampermonkey` for compatibility.

Current runtime shape:

```text
Ink terminal / HTTP API / Codex-like RPC
  -> local Express + WebSocket server
  -> TampermonkeyHub / TampermonkeyBridge (legacy names)
  -> Chrome extension background WebSocket
  -> extension content script in chatgpt.com
  -> ChatGPT Web UI
```

The main workflow under active development is project-task automation:

1. User opens a local project in the CLI.
2. Bridge scans and packages the project into a ZIP snapshot.
3. CLI sends a `/task <prompt>` to ChatGPT with the snapshot and project/agent/skill context.
4. ChatGPT returns a response and normally a downloadable ZIP artifact with the updated full project.
5. Bridge finds/downloads the correct artifact, stores it internally, selects it for `/apply`, and optionally auto-applies it safely to the project.
6. `/recover` can re-read visible ChatGPT responses after local crashes/timeouts and rebuild the same selected-artifact/apply state.
7. `/resume` should attach to a prompt that is already running in the selected ChatGPT tab and continue the same result pipeline.

## Important current problems

These are the most recent user-reported problems and should guide the next fixes.

### 1. Autocomplete is still wrong for `/tab`

Desired behavior:

```text
/tab       may suggest /tabs
/tab<sp>   must stop suggesting /tabs
/tab 1     must not suggest or complete to /tabs
/tab foo   must not suggest or complete to /tabs
```

v23 attempted to fix this in `src/interactiveInk.js` by making `commandSuggestions()` return no command suggestions when the typed token is an exact command followed by whitespace. The user reports the bug still remains, so the issue is likely not only `commandSuggestions()`. Check every path that can insert `/tabs`:

- `commandSuggestions(input)`
- `completeCommand(input)`
- `shouldCompleteSlashCommand(input, selected)`
- the Tab-key handler in `handleInputEvent()` / Ink input logic
- stale `suggestionIndex` or stale selected suggestion after the input changes from `/tab` to `/tab `
- rendering vs completion mismatch: the UI may hide suggestions but Tab may still complete using `completeCommand()`

The fix should be argument-aware. Once an exact known command token has been followed by whitespace, slash-command name completion must be disabled for that line unless the command explicitly has argument suggestions.

### 2. `/recover` and `/apply` process flow is now explicitly documented

Read `SESSION.MD` before changing `/recover` or `/apply`. It documents the required process flow. The most important invariant is: `/recover list` prints visible browser candidate indexes, and `/recover <n>` selects that candidate index. The number is not a local turn id and not the printed ChatGPT visual turn number.

A bug fixed in this handoff: `/recover list` could print `[1] turn 29 ...`, but `/recover 1` failed with `No turn is available for recovery` when local turn metadata was missing or out of scope. `/recover <n>` now allows `TurnManager` to create an adopted local recovery turn in the current project/session scope, attach the selected visible response to it, then continue through the normal answer/artifact/result pipeline.

The user also says the only historically reliable flow was:

```text
/recover N --force
/apply --force
```

Without `--force`, `/recover N` may not download/refresh the artifact, and `/apply` may say the result is already applied even when the project state does not match. v22 attempted to fix early return/idempotency, but this is not fully resolved.

When fixing this, do not rely only on `lastAppliedTurnId` or `lastAppliedFileId`. The safe behavior should be:

- `/recover N` re-reads the chosen visible response and resolves/downloads the selected artifact if the local file is missing, stale, wrong, or from another session/project.
- `/apply` builds a fresh plan against the current project and current selected artifact. It may skip only when the apply plan is actually empty/unchanged, not because old state flags say “already applied”.
- State must be scoped to active project + active ChatGPT session.
- Logs must say which artifact was selected/downloaded/stored/applied.

### 3. Final assistant message sometimes still is not printed

The terminal must show the final ChatGPT answer text after `/ask`, ordinary prompt, `/task`, `/recover`, and `/resume`. Previous fixes added `rememberResponse()` and `/responses`, but the user still saw missing final text in earlier iterations. If this regresses again, inspect both layers:

- response extraction in the extension (`content.js`)
- `TampermonkeyBridge` request result assembly
- `TurnManager` item creation for `agent_message`
- Ink console-stream capture and transcript card rendering
- `rememberResponse()` and `/responses <n>` storage

The app UI/output language should be English.

### 4. Artifact selection/apply lifecycle must be explicit

At the end of a project task or recovery, the terminal should explicitly print:

- which artifact was found;
- whether it was downloaded or reused;
- final stored filename/path inside bridge storage;
- whether it was selected for `/apply`;
- apply progress stages;
- if no artifact was found for a task that required one;
- if an artifact exists but cannot be auto-applied, the exact follow-up command, usually `/apply`, `/apply --interactive`, or `/apply --force`.

The bridge should not silently keep an old ZIP selected when a newer current-turn ZIP exists.

### 5. Runtime storage must live in `~/.bridge-data`

The project should not create `.env` or `.bridge-data` in the project root by default. Runtime files should be stored under `~/.bridge-data` unless `DATA_DIR` or `ENV_FILE` is explicitly set.

Current default is in `src/config.js`:

```text
DEFAULT_DATA_DIR = path.join(os.homedir(), '.bridge-data')
ENV_FILE = process.env.ENV_FILE || path.join(process.env.DATA_DIR || DEFAULT_DATA_DIR, '.env')
```

Important storage areas:

```text
~/.bridge-data/.env
~/.bridge-data/interactive-state.json
~/.bridge-data/files/
~/.bridge-data/artifacts/
~/.bridge-data/projects/
~/.bridge-data/metadata.sqlite or metadata.json fallback
```

Artifacts downloaded from Chrome should be moved/imported into `~/.bridge-data/artifacts`, then old browser-download copies and old applied archives should be removed by retention cleanup.

### 6. Sessions and project state must be scoped

A new project should have its own sessions, response history, selected artifact, last turn, and last applied state. `/apply` and `/recover` must update only the current project/session scope.

v22 added scope helpers in `src/interactiveLegacy.js`:

- `scopeProjectKey(state)`
- `scopeSessionKey(state)`
- `persistCurrentScope(state)`
- `hydrateCurrentScope(state)`
- `switchSessionScope(state, sessionId)`

Verify any new state field is included in `makeScopedFields()` and is persisted/hydrated correctly.

### 7. `/resume` was just added and needs live validation

The desired behavior:

- `/resume` attaches to a prompt already running in the selected ChatGPT tab.
- If no prompt is running, it prints an error.
- If a prompt is running, it prints the user prompt preview, receives current snapshots, then continues as the normal `/task` or chat pipeline.
- For a known project turn, it should resolve/select/apply the resulting ZIP just like `/task`.
- For an unknown active request, it should resume as plain chat and save the answer in `/responses`.

v23 implemented this, but it has not been proven in a live browser run.

## Latest changes before this handoff

The latest packaged version before this context update was `chatgpt-bridge-fixed-v23.zip`.

Recent high-level changes across v20-v24:

- Added explicit `SESSION.MD` process-flow contract for `/recover` and `/apply`.
- Fixed `/recover <n>` after `/recover list` when no local metadata turn exists: it now creates an adopted recovery turn instead of failing with `No turn is available for recovery`.

Recent high-level changes across v20-v23:

- Added `/responses`, `/responses <n>`, and aliases `/response`, `/answer`, `/answers`.
- Added final-answer storage through `rememberResponse()`.
- Added artifact download rename handling when Chrome saves `file.zip` as `file (1).zip`.
- Added artifact movement into internal bridge storage and retention cleanup.
- Attempted to make `recover` and `apply` session/project-scoped.
- Added `/resume` support.
- Attempted to fix `/tab` autocomplete, but the user says the bug remains.
- Moved default runtime data to `~/.bridge-data`.

## Places touched in the latest code changes

Use this map when continuing work.

### `src/interactiveInk.js`

Default Ink/React terminal UI.

Recent/important areas:

- `COMMANDS` includes `/resume`, `/recover`, `/responses`, `/apply`, `/tab`, `/tabs`.
- `normalizeCommand()` maps friendly commands to legacy handlers, for example `/tab 2` -> `/select 2`, `/apply` -> `/result apply`, aliases for `/responses`.
- `commandSuggestions()` attempted to stop `/tabs` after `/tab `.
- `completeCommand()` still needs review for argument-aware completion.
- `shouldCompleteSlashCommand()` and Tab handling need review for stale suggestions.
- Raw terminal input handling lives here: Backspace/Delete, Escape, Option/Cmd arrows, Ctrl commands, bracketed paste.
- Ink command output capture is handled by `captureConsoleLines()` / stream adapters so command progress can appear in the event strip/transcript.

### `src/interactiveLegacy.js`

Despite the name, this still contains most command business logic used by Ink.

Recent/important areas:

- State scope helpers near the top: `persistCurrentScope`, `hydrateCurrentScope`, `switchSessionScope`.
- `INTERACTIVE_STATE_FILE` now uses `config.dataDir`.
- `rememberResponse()`, `printResponseList()`, `printResponseByIndex()` implement `/responses`.
- `runTask()` starts project turns, waits for final turn, saves final answer, and prints/selects ZIP result.
- `runAsk()` sends ordinary prompts and saves final answer.
- `runResume()` implements `/resume` for known project turns and unknown active browser requests.
- `recoverLatestResponse()` implements `/recover list`, `/recover <n>`, `--apply`, `--force`.
- `applyLastTurnResult()` and nearby helpers decide whether the selected result is already applied, build/apply plans, cleanup old result archives, and update `lastAppliedTurnId` / `lastAppliedFileId`.
- Command dispatch in `handleCommand()` maps `/recover`, `/resume`, `/responses`, `/result apply`, `/project`, `/session`, etc.

### `src/turnManager.js`

Project turn lifecycle.

Recent/important areas:

- `recoverTurnFromLatestResponse(id, options)` re-reads visible ChatGPT responses, stores recovered thinking/answer/artifacts as items, and calls `ResultResolver` when ZIP output is expected.
- `resumeActiveTurn(id, options)` attaches a local turn to the active browser request and streams snapshots/events into turn items.
- Ensure completed turns get an `agent_message` item even if the answer arrives only in final `done`.
- Recovery should not early-return only because a turn is already completed if the user explicitly selected a visible response to recover.

### `src/resultResolver.js`

Finds/downloads/validates ZIP results.

Recent/important areas:

- Artifact choice must be turn-aware. Current-turn artifacts should beat older/fallback artifacts.
- `forceArtifactDownload` should be passed to `bridge.fetchArtifact()`.
- If a ZIP is expected but not found, return/log a clear non-ZIP result instead of silently keeping a stale ZIP.
- Downloaded ZIPs should become `fileStore` files with hash, name, size, path, and manifest.

### `src/tampermonkeyBridge.js`

High-level browser bridge.

Recent/important areas:

- `sendRequest()` request lifecycle and final response assembly.
- `resumeActiveRequest(callbacks, options)` added for `/resume`.
- `recoverLatestResponse()` / `recoverResponses()` read visible assistant responses from the extension.
- `fetchArtifact(id, options)` downloads action/link artifacts and must respect `force`.
- Pending request timeout should be idle/activity-based, not an absolute cap while the browser reports the same active request.

### `src/tampermonkeyHub.js`

Browser companion transport hub. Name is legacy.

Recent/important areas:

- Extension clients use WebSocket-like transport.
- Commands must be delivered to `transport: "extension"` clients directly, not put into old polling queues.
- Heartbeat/ping must work for extension clients.
- Active client selection controls which ChatGPT tab receives commands.

### `tools/chrome-bridge-extension/content.js`

Single supported ChatGPT DOM automation surface.

Recent/important areas:

- Composer prompt submission.
- Model/effort selection. This is best-effort and currently fragile; emit clear diagnostics when selection fails.
- `activeRequest` tracking with `requestId`, prompt preview/hash, answer/thinking lengths, artifact count.
- `request.resume` handling sends current snapshots for `/resume`.
- Response extraction should anchor to the submitted user turn and assistant turn after it, not the last stale assistant message.
- Artifact extraction should be scoped to the current assistant turn and not scan so broadly that old artifacts are selected.
- Action-button artifacts may need Chrome download capture rather than direct URL extraction.

### `tools/chrome-bridge-extension/background.js`

Extension background service worker.

Recent/important areas:

- Owns WebSocket to local bridge.
- Fetches signed local file URLs for uploads.
- Captures Chrome downloads for artifact action buttons.
- Should return the actual completed filename/path when Chrome renames a download.

### `src/fileStore.js`

Local storage for input files and downloaded artifacts.

Recent/important areas:

- Store artifacts in `config.dataDir/artifacts`.
- Import actual Chrome download paths after download capture.
- Handle renamed downloads.
- Cleanup old applied result archives by retention count/size.

### `src/config.js`

Runtime config and generated `.env` handling.

Recent/important areas:

- Default data dir is `~/.bridge-data`.
- `.env` should be generated in `~/.bridge-data/.env` unless overridden.
- Do not write project-local `.env` by default.

### Tests touched/added recently

Relevant tests:

```text
test/interactiveInkInput.test.js    terminal input + autocomplete behavior
test/resume.test.js                 resumeActiveRequest behavior
test/stateScope.test.js             project/session-scoped interactive state
test/recovery.test.js               recovery behavior
test/resultResolver.test.js         artifact resolution / forceArtifactDownload
test/artifactDownloadPath.test.js   Chrome renamed download path handling
```

When fixing the current `/tab` bug, add an explicit test for both suggestions and Tab completion:

```text
input: "/tab"     -> suggestions may include /tabs
input: "/tab "    -> suggestions must not include /tabs; Tab must not mutate to /tabs
input: "/tab 1"   -> suggestions must not include /tabs; Tab must not mutate to /tabs
```

When fixing `/recover`/`/apply`, add tests where state says an artifact was already downloaded/applied but the local file is missing, stale, belongs to another session, or the project plan is not actually unchanged.

## Commands that matter now

User-facing commands in the Ink UI:

```text
/tabs, /tab [n|auto]
/sessions, /session [n|new]
/model, /effort
/project [path], /scan, /pack
/task <prompt>
/resume
/recover list
/recover <n> [--apply] [--force]
/responses [n]
/apply [zipPath] [--plan] [--interactive] [--force]
/status, /connect, /stop, /clear, /quit
```

Plain text is a normal ChatGPT prompt. Project ZIP workflow must be explicit through `/task`.

## Required checks before handoff

Run what the local environment allows:

```bash
npm run check
npm test
npm run test:coverage
```

In this sandbox, full `npm test` has sometimes failed only because `express`/`ws`/native packages were not installed. In that case, run targeted tests that do not require missing dependencies and be explicit about the limitation.

Always reload the Chrome extension after changing files under `tools/chrome-bridge-extension/`. Restart the Node bridge after changes under `src/` or config/storage behavior.

## 2026-07-08 v29 workflow reliability phase 1

`GOAL.MD` now contains the reliability plan for the project-task workflow. The current implementation starts with observability rather than a full lifecycle rewrite.

Implemented phase 1 pieces:

- `tools/chrome-bridge-extension/content.js` emits `request.progress` snapshots for active prompt requests. These include phase, tab visibility/focus, submitted user turn, assistant turn, anchor confidence, answer/thinking lengths, artifact count, generation signals, network done, and last meaningful progress metadata.
- The content script emits explicit phase/chat events for prompt accepted, prompt submitted, user turn captured, assistant turn captured, generation started/stopped, post-stop settle, final snapshot ready, and warning states.
- `src/tampermonkeyBridge.js` keeps compact active request diagnostics for pending requests, distinguishes last heartbeat/activity/progress/meaningful progress timestamps, and exposes `bridge.requestDiagnostics()` through `health()`.
- `src/routes.js` exposes `/diagnostics/state` and `/events`, and the `/diagnostics` page now displays server state, connected clients, active requests, recent request events, live debug events, and a copyable debug bundle.
- `src/interactiveLegacy.js` / the Ink UI event strip now render meaningful `request.progress` and request phase events while suppressing noisy normal `dom.poll` progress.

Important limitation: this phase does not yet change ownership of running requests. `activeRequest` still primarily lives in the content script, and source-client-bound follow-up routing is not fully implemented yet. The next phases should bind follow-up commands to `sourceClientId`, add extension-background request memory, add phase-specific watchdogs, and implement two-phase finalization.

## 2026-07-08 v30 reliability phase 2 + diagnostics syntax fix

This update fixes a blocker from v29: `/diagnostics` generated an inline script with a literal newline in a JavaScript string. Browsers and the blackbox VM test reported `SyntaxError: Invalid or unexpected token`, and the diagnostics UI remained stuck at `Loading…`. `src/routes.js` now emits `\\n` in the generated script, and the diagnostics inline script parses cleanly.

Implemented phase 2 source-client binding pieces:

- `src/tampermonkeyBridge.js` now records `sourceClientId` on artifacts received via `artifact.snapshot` and final `done` payloads.
- Final bridge responses include `sourceClientId`, so downstream result resolution knows which ChatGPT tab produced the answer/artifact.
- `#sendCommand()` accepts `sourceClientId` / `clientId` and routes commands to that exact browser client using `hub.sendToClient()` instead of always using the active client.
- `recoverResponseByTurnKey()`, artifact fetch, and result artifact-settle retries can now stay bound to the source client.
- `src/resultResolver.js` passes `sourceClientId` into same-turn recovery and artifact downloads. If the user switches active ChatGPT tabs while a request is finalizing, retries/downloads should continue to target the original source tab.
- Command responses are already checked against the command's client id, so wrong-tab command replies are ignored.

Added/updated tests:

- `test/tampermonkeyReliability.test.js` covers artifact fetch routing to the artifact source client and turnKey recovery routing to the requested source client.
- `test/resultResolver.test.js` now asserts that result resolution passes `sourceClientId` into artifact fetch and delayed artifact same-turn retry.

Still not implemented in this phase:

- Extension-background durable request registry.
- `sessionStorage` active request checkpoints in content script.
- Automatic reattach after content script restart/tab restore.
- Phase-specific watchdogs and forced snapshot on stall.


## 2026-07-08 v31 resume/source request visibility fix

This update fixes another running-request reliability issue around `/resume`.

Before v31, `/resume` mostly looked at `bridge.health().activeClient.activeRequest`. That value depended on `page.status`/`pong` from the selected active tab. A ChatGPT prompt could still be running in the content script while the server saw no selected-tab `activeRequest`, or while the running request belonged to another connected tab.

Implemented pieces:

- `tools/chrome-bridge-extension/manifest.json` version was incremented from `0.2.0` to `0.2.1` because the extension runtime changed.
- `tools/chrome-bridge-extension/content.js` now schedules an immediate page-status update when `activeRequest` is created and when it is cleared.
- `src/tampermonkeyHub.js` derives `client.activeRequest` from request lifecycle messages such as `request.progress`, `prompt.accepted`, snapshots, and status events. It clears the client active request on `done`/`error`.
- `src/tampermonkeyBridge.js` exposes active request candidates and resolves `/resume` targets across all connected clients. If exactly one tab has a running prompt, `/resume` can attach to it even if it is not the selected active tab.
- `resumeActiveRequest()` now sends `request.resume` to the resolved source client instead of using `sendToActive()`.
- `src/turnManager.js` uses the resolved source client when resuming a known local project turn.
- `src/interactiveLegacy.js` reports the source tab for `/resume` and prints a clear multiple-running-prompts message if more than one candidate exists.

Remaining limitation: this is not a full extension-background durable request registry yet. If the content script is destroyed and loses its in-memory `activeRequest`, v31 improves server-side visibility while the content script is alive, but does not fully restore a request after tab discard/reload. That remains the next Phase 3 item.

## 2026-07-08 v32 diagnostics API-token fix

This update fixes a blocking diagnostics UI problem introduced by the observability work. `/diagnostics` itself was localhost-only, but its JavaScript fetched `/diagnostics/state`, `/events`, and `/debug/events` after the global `requireApiToken` middleware. When `API_TOKEN` was configured, the page displayed empty `{}` sections or stayed unusable because the browser did not attach the API token and there was no UI to provide one.

Implemented pieces:

- `src/routes.js` now exposes localhost-only diagnostics JSON endpoints before `requireApiToken`:
  - `GET /diagnostics/state`
  - `GET /diagnostics/events`
  - `GET /diagnostics/debug-events`
- The diagnostics page now uses these diagnostics-scoped endpoints instead of the protected general API endpoints.
- The page has explicit fetch error handling. If diagnostics loading fails, it displays HTTP status/detail and a hint instead of silent `{}` output.
- The general HTTP API remains protected by `API_TOKEN`; only localhost diagnostics/setup endpoints bypass it.
- `test/api.blackbox.test.js` now verifies that diagnostics JSON endpoints work without API auth while `/health` still requires `API_TOKEN`.

No Chrome extension runtime files changed in this update, so the extension manifest version was not incremented.

## 2026-07-08 v34 Phase 1/2 completion pass

This update finishes the previously incomplete Phase 1/2 reliability pieces without implementing Phase 3 normal result pipeline convergence yet.

Phase 1 additions:

- `src/eventBus.js` now keeps compact per-request timelines in addition to the normal event/debug rings. Noisy `request.progress` events from `dom.poll` are excluded, and repeated identical compact events are deduplicated.
- `src/routes.js` diagnostics state now includes compact request timelines, timeline summaries, interactive selected/apply state, current project/session/turn mapping, and recent turns with output/source metadata. `/diagnostics` displays these sections directly and includes them in the copyable debug bundle.
- Timeline summaries flag important breakpoints such as `request.done` without subsequent `result/resolving`, `result/resolving` without `result.ready`, or `result.ready` without visible apply planning.
- `tools/chrome-bridge-extension/content.js` now extracts visible assistant progress/thinking labels as `assistant.progress.snapshot` instead of letting them be confused with artifacts.
- `src/tampermonkeyBridge.js`, `src/interactiveLegacy.js`, and the Ink UI can carry/render this visible progress stream. This is visible UI text only; it is not hidden chain-of-thought extraction.
- Artifact extraction was tightened so generic progress/status buttons are not treated as downloadable ZIP artifacts. ZIP artifacts still require a zip-like filename/mime or explicit download/artifact intent.

Phase 2 additions:

- Recovered command responses now inherit the source client from the routed command when the content response does not explicitly include `sourceClientId`.
- Recovered artifacts, result validation/download events, download metadata, and ready ZIP results now preserve `sourceClientId`, `sourceRequestId`, and `sourceTurnKey` where available.
- Same-turn artifact retry and artifact download paths keep source-client metadata visible in diagnostics and result output.

Extension version:

- `tools/chrome-bridge-extension/manifest.json` was incremented from `0.2.1` to `0.2.2` because `content.js` changed.

Still intentionally not implemented here:

- Phase 3: making every normal `request.done` enter the result/apply pipeline.
- Phase 5: refusing stale or source-mismatched `/apply` selections. This pass makes source identity visible and preserved, but does not enforce it during apply yet.
- Durable extension-background request registry and phase-specific watchdogs.


## 2026-07-08 v35 Phase 3 normal pipeline convergence

This update implements the Phase 3 fix identified from the v34 debug log.

Root cause addressed:

- The Ink interactive UI (`src/interactiveInk.js`) sent plain prompts through `bridge.sendRequest()` even when a project was open.
- That created plain chat responses with transient request ids and empty `turnId`, so `request.done` could contain the final answer and ZIP artifact while the project `TurnManager` never ran `result/resolving`.
- The old project result stayed selected, so `/apply` could apply the previous ZIP.

Implemented pieces:

- Plain prompts in Ink interactive now route to `runProjectTask()` when `state.projectRoot`, `projectService`, and `turnManager` are available.
- Ink project prompts now follow the same project path as legacy interactive: local turn id is the request id, then result resolving and safe auto-apply can run from that turn.
- `runProjectTask()` clears the previous in-memory `lastTurn`/artifacts immediately after the new turn is created and records `currentTurnId`. This prevents a stale previous result from remaining selectable while a newer project task is running or has failed without a ZIP.
- `applyLastTurnResult()` now refuses a stale selection if `state.lastTurn.id` does not match `state.lastTurnId` or `state.currentTurnId`.
- `TurnManager` records explicit `normal.done.received` and `normal.pipeline.started` events before expected-output resolution. Diagnostics can now distinguish `request.done` received from the project pipeline actually starting.

Added tests:

- Normal project `request.done` with answer+ZIP enters `result/resolving` under the project turn id.
- `runProjectTask()` invalidates the previous selected result before waiting for a new result.
- Ink interactive routing sends plain prompts to project task mode when a project is open.

No Chrome extension runtime file changed in this update, so the extension manifest version was not incremented.

## 2026-07-08 v36 Phase 3 auto-apply completion

This update closes the remaining Phase 3 gap observed after v35: the normal project pipeline reached `result.ready` and selected the current ZIP, but safe apply planning did not run automatically.

Implemented pieces:

- `runProjectTask()` now performs safe auto-apply itself after a completed ZIP result when a `fileStore` is available. This makes the normal project-task path end at apply planning/auto-apply instead of relying on outer Ink/legacy command wrappers.
- `applyLastTurnResult()` now emits turn-scoped apply events when a `turnManager` is available:
  - `apply/planning`
  - `apply/plan.ready`
  - `apply/skipped`
  - `apply/auto.started`
  - `apply/manual.started`
  - `apply/done`
  - `apply/failed`
- Diagnostics timeline summaries now recognize both `apply.*` and `apply/` event naming, so `result.ready` followed by apply planning no longer appears as a missing apply pipeline.
- `TurnManager` exposes `recordTurnEvent()` for controlled external workflow events such as apply planning after the turn result is ready.
- Fixed the resumed project-turn path to record `normal.done.received` under the resumed turn id.

Added regression coverage:

- A completed project task with a safe ZIP result now auto-applies the archive, updates `lastAppliedTurnId`/`lastAppliedFileId`, and records apply events.

No Chrome extension runtime files changed in this update, so the extension manifest version was not incremented.
