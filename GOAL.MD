# Project Task Workflow Reliability Goal

This file is the roadmap/spec for making the project-task workflow reliable. It should preserve the agreed future phases without becoming a session diary.

Current implementation target: completed through Phase 6 and audited through v59, including tab/session targeting, interactive UX reliability, the ChatGPT DOM-parser rework, generated-artifact download reliability, delayed-artifact/stale-snapshot guards, and stable logical reconciliation of visible thinking blocks. Do not start Phase 7+ unless explicitly asked.

## Runtime baseline

Supported runtime: local Node.js bridge + Chrome/Chromium extension companion + logged-in ChatGPT browser tab.

Legacy Tampermonkey/userscript names still exist in files and routes, but the production path is extension WebSocket transport. Public legacy userscript polling endpoints should remain disabled/unsupported with clear responses.


## Extension compatibility baseline (v56)

The server and extension exchange explicit compatibility metadata:

```text
extensionVersion
clientVersion/content runtime
extensionProtocolVersion
bridgeVersion
minimum/recommended extension version
```

An incompatible client remains visible in setup/diagnostics so the problem is explainable, but it is not eligible for active selection or prompt delivery. The browser panel must display a direct update instruction. Extension manifest versioning follows the compatibility policy in `AGENT.MD`: patch for broadly compatible changes, minor for conditional compatibility, major for intentional incompatibility.

The floating setup control is user-facing onboarding, appears only on ChatGPT chat routes, and keeps raw debug state behind an explicit advanced section. In normal Ink mode, important lifecycle events are transcript entries; the debug strip is rendered only in verbose mode.

## Core problem

The workflow must not depend on one fragile live content-script state or on whichever ChatGPT tab happens to be active.

Intended path:

```text
CLI/API/interactive prompt
-> server creates local turn/request
-> extension sends prompt to ChatGPT
-> content script anchors user turn and assistant turn
-> content script streams visible progress and final answer/artifacts
-> server resolves ZIP result
-> server selects current result
-> server plans/applies or asks for confirmation
```

Project tasks may legitimately run for 10-20 minutes. Reliability must come from explicit phases, identity, progress signals, source-client binding, and recoverable diagnostics; not from one large timeout.

## Target user-visible outcome

Every normal project prompt must reach exactly one explicit outcome:

```text
completed and safely applied
completed with changes waiting for confirmation
completed with no changes
completed without artifact, final answer printed
recoverable failure with exact phase and diagnostics
hard failure with exact reason
```

The user must not see ChatGPT answer successfully while the bridge prints nothing, downloads a stale artifact, applies a ZIP from another turn/project, silently switches tabs, or requires guessing which `/recover` command to run.

## Required identity model

Every project task should keep stable identity across server, extension background, content script, diagnostics, result selection, and apply pipeline.

Required identifiers:

```text
projectId
projectRoot
chatSessionId/sessionId
sourceClientId
sourceTabId
conversationUrl
localTurnId
requestId
submittedUserTurnKey
assistantTurnKey
artifactId
fileId
```

Main invariant:

```text
one project task = one localTurnId = one requestId
```

New prompt target resolution after v51/v52:

```text
if requested session is already open in an idle connected tab -> use it
else if a manually selected idle tab exists -> ask before switching/using it
else if exactly one idle connected tab is available -> ask before using/switching it
else -> refuse with a clear selection error
```

A tab with `activeRequest` is busy, including a request whose `ownerServerInstanceId` belongs to another bridge process and is visible to this content script. Do not send a new prompt there. This is not a distributed discovery/lease system: a tab connected only to another server is simply unavailable to the current server; ownership metadata prevents reuse when that active state is reported during reconnect/switching.

New requests may use the currently selected browser client. Follow-up commands for an existing request must target the request source client/tab where available:

```text
final/forced snapshot -> sourceClientId
recover by turnKey -> sourceClientId
artifact fetch -> sourceClientId
artifact settle retry -> sourceClientId
resume active request -> original connected client if known
```

High-confidence auto-apply requires result identity including:

```text
requestId
turnId
projectId/projectRoot
sourceClientId
sourceTurnKey
artifactId
fileId
```

If source identity is missing, the system may leave a result selected for explicit manual review/apply, but must not silently auto-apply.

## Request phase model

Project requests should move through explicit phases/events instead of becoming opaque long waits.

Core phases:

```text
created
prompt_delivered_to_extension
prompt_accepted_by_content_script
attachments_uploading
prompt_submitted
waiting_for_user_turn
waiting_for_assistant_turn
generating
post_stop_settle
artifact_settle
final_snapshot_ready
result_resolving
download_in_progress
apply_planning
apply_ready
completed
completed_without_artifact
recoverable_failed
failed
```

Pipeline-specific events:

```text
normal.done.received
normal.pipeline.started
normal.pipeline.missing_after_done
result/resolving
artifact.download.started
artifact.download.done
result.ready
apply.plan / apply/planning
apply.done / apply.skipped / apply.failed
```

`request.done` must never be a terminal dead end for a project task.

## Phase 1 — Observability and diagnostics

Status: implemented for the current reliability scope.

Implemented expectations:

```text
request.progress events
active request diagnostics
clients and active requests in diagnostics page
diagnostics endpoints and debug bundle export
source visibility/focus/anchor data
compact timelines filtered from noisy polling
meaningful request progress separated from heartbeats
visible assistant progress/thinking stream in diagnostics
turn/request timeline summaries that flag request.done without result/resolving
selected result / apply state in diagnostics
current project/session/turn mapping in diagnostics
recent turns with output/source metadata in diagnostics
```

Diagnostics must answer:

```text
Did request.done happen?
If yes, did result/resolving start?
If not, why not?
Which selected result is active?
Does selected result belong to the current project/session/turn?
Which source client and assistant turn produced the result?
```

Remaining diagnostic work belongs to later phases: phase-specific watchdog actions, durable extension request memory, and stronger recovery fallback UX.

## Phase 2 — Source-client binding

Status: implemented for result identity and routing; Phase 5 now enforces apply safety.

Implemented expectations:

```text
normal done/artifact snapshots carry sourceClientId
artifact fetch can use sourceClientId
recover by turnKey can use sourceClientId
artifact settle retry can use sourceClientId
wrong-client command replies are ignored
/resume can search connected clients for a running activeRequest
recovered responses/artifacts inherit command/source client id
artifact download/result events preserve sourceClientId/sourceTurnKey/sourceRequestId
selected ZIP results preserve sourceClientId/sourceTurnKey/sourceRequestId in output metadata
same-turn artifact retries preserve source client identity
```

## Phase 3 — Normal result pipeline convergence

Status: implemented in v35/v36 and retained through v47.

Goal: every successful project `request.done` enters the same result/apply pipeline as `/recover`.

Required behavior:

```text
request.done with final answer only
-> save final answer
-> print final summary
-> completed_without_artifact
-> clear selected result for current turn

request.done with final answer + ZIP artifact
-> save final answer
-> print final summary
-> normal.done.received
-> normal.pipeline.started
-> result/resolving
-> artifact download
-> result.ready
-> selected result becomes current turn result
-> apply planning
-> auto-apply if safe, otherwise wait for confirmation
```

Required invariants:

```text
request.done must be visible in turn events
request.done must either produce result/resolving or completed_without_artifact
final answer must be printed even if result resolving fails
selected result must belong to current project/session/turn
old selected result must be invalidated when a new project task starts
/apply must not apply an old artifact after a newer task completed/failed without selecting a new result
```

Implementation notes:

```text
v35: plain prompt in Ink + open project now routes to runProjectTask; local turn id is requestId.
v35: normal.done.received and normal.pipeline.started are emitted under the project turn.
v36: result.ready now reaches apply planning and safe auto-apply where allowed.
v36: manual /apply records planning/result events when turnManager is available.
v47: selectedResult is explicit scoped state used by /apply.
```

Required regression tests:

```text
normal request.done with answer+zip starts result/resolving
normal request.done with answer+zip downloads artifact
normal request.done with answer+zip selects current result
normal request.done with answer+zip triggers apply planning
normal request.done with answer only prints final summary and clears selected result
/apply after failed new task does not apply previous selected artifact
/recover and normal done use the same result resolver
```

## Phase 3.1 — Steer/continuation finalization guard

Status: implemented.

The extension must not treat `Stop` disappearing as final if ChatGPT exposes Steer/Continue controls showing the response is not terminal. It should wait for a terminal marker, artifact, stable condition, or bounded settle.

## Phase 3.2 — Apply UX and compact diagnostics

Status: implemented.

Auto-apply decisions should be explicit. Successful apply should print grouped created/updated/deleted/skipped changes. Diagnostics should summarize result/apply state and timelines without drowning in noisy DOM polling events.

## Phase 4 — Visible intermediate progress/thinking stream

Status: implemented.

Goal: capture visible ChatGPT UI status/progress/reasoning labels as progress, not artifacts. This is not hidden chain-of-thought extraction; only text already visible in the page UI may be captured.

Required stream:

```text
assistant_progress.snapshot / visible_thinking.snapshot
requestId
sourceClientId
assistantTurnKey
text
kind: thinking | progress | tool_status | action_status
length
changedAt
anchorConfidence
```

UI/diagnostics behavior:

```text
assign a stable logical id per visible step
update an active step in place while shimmer/status text changes
preserve the same id when React replaces active UI with its completed cot-v5 button
append each completed step to the normal transcript exactly once
dedupe repeated observer and forced-snapshot reads by id + revision
show only currently active steps in the bounded Ink Live panel
store the completed history and revisions in diagnostics
```

Artifact extraction rules:

```text
valid: filename ends with .zip, ZIP MIME/signature, explicit downloadable file action, belongs to current assistant turn
invalid: thinking/progress controls, status labels, response actions, citations, and unrelated generic buttons
```

Required regression tests:

```text
visible thinking/progress text is emitted as progress, not artifact
progress labels are shown in interactive UI
progress labels do not become application/zip artifacts
real .zip artifact is still detected
```

## Phase 5 — Selected result safety and apply guard

Status: implemented in v47.

Goal: make stale artifact application impossible.

Implemented behavior at project task start:

```text
previous selectedResult is marked stale/cleared for the active project/session
current run/turn identity is stored
```

Implemented behavior at `result.ready`:

```text
selectedResult = current ZIP result
selectedResult.turnId = current run/turn id
selectedResult.projectId/projectRoot = active project identity
selectedResult.sessionId = active session identity
selectedResult.sourceClientId/sourceTurnKey/sourceRequestId = source identity
selectedResult.artifactId = resolved artifact identity
selectedResult.fileId = resolved local file identity
selectedResult.confidence = resolver confidence
```

Implemented `/apply` guard:

```text
if no selected result: refuse with clear message
if selected result is stale: refuse by default
if selected result turn/project/session does not match active scope: refuse
if selected result file is missing/unreadable: refuse
if selected result has low/manual confidence: require explicit confirmation
```

Required regression tests now covered:

```text
new task invalidates previous selected result
completed task without ZIP clears selected result
normal ZIP result selects current result
/apply refuses stale selected result
/apply refuses result from another project
/apply refuses missing selected file
/recover selects recovered ZIP result
/recover then /apply applies recovered result
auto-apply skips missing source identity
auto-apply skips low/manual/uncertain confidence even when source identity exists
current project/session scope preserves selectedResult
```

## Phase 6 — Phase-specific watchdog and forced snapshot

Status: implemented in v50 and completed/audited through v58 for server-side phase/liveness tracking, source-bound forced snapshots, non-starvable watchdog scheduling, explicit result-pipeline failure events, interactive watchdog activity, strict DOM-terminal snapshot validation, stale partial-state clearing, and required-artifact settle on both content and server sides. Browser reload/durable request memory remains Phase 7.

Goal: avoid giant timeouts and detect whether a request is healthy based on phase-specific signals.

Do not mix these liveness classes:

### Hard liveness

Answers only whether the extension/tab/script exists.

Signals:

```text
background port heartbeat
content script heartbeat
tab exists
tab URL still matches ChatGPT
chrome.tabs status
visibilityState
```

This timeout can be short, for example 20-60 seconds. Hard heartbeat must not count as request progress.

### Request progress liveness

Answers whether the current request is moving through expected phases.

Meaningful progress signals:

```text
prompt accepted/submitted
user turn captured
assistant turn captured
generation started
answer length changed
thinking/progress text changed
artifact count changed
network stream activity observed
DOM mutation inside current assistant turn
stop button/generation state changed
post-stop finalization started
artifact settle retry running
result pipeline started after request.done
```

These events should update `lastMeaningfulProgressAt`.

### Generation activity liveness

Answers whether ChatGPT still appears to be generating, even if visible text is stable.

Signals may include:

```text
active streaming fetch/SSE/network request
visible stop button
assistant turn has spinner/streaming markers
DOM mutations inside current assistant turn
visible progress/thinking text changing
answer block changing
```

### Weak liveness

Weak signals prove machinery is alive, not that the request is progressing:

```text
content script heartbeat
page status heartbeat
tab focused/visible
activeRequest object still exists
```

Weak liveness may prevent a “dead script” failure but must not indefinitely reset the meaningful-progress watchdog.

Required watchdog behavior:

```text
if generation appears active:
  do not fail only because text is stable
  show "generation active, no visible text changes"

if only heartbeat remains:
  show "monitoring alive, request progress unclear"
  request source-bound forced snapshot

if request.done happened but no result pipeline started:
  show "final response received, result pipeline did not start"
  trigger result pipeline or mark recoverable_failed
```

Required forced snapshot behavior:

```text
request current assistant snapshot from sourceClientId
read the same assistantTurnKey when known
return answer/thinking/progress/artifacts
do not use latest global response from another tab/turn
```

Implemented through v53:

```text
server request diagnostics expose phase age, meaningful-progress age, hard-heartbeat age, current generation activity, forced-snapshot count, and watchdog state
content script supports source-bound response.snapshot.request
forced snapshot reads the active request or exact assistantTurnKey; it never falls back to a global latest response
watchdog separates weak heartbeat from meaningful progress
weak heartbeat neither resets lastMeaningfulProgressAt nor postpones the scheduled watchdog check indefinitely
current generating/stop-button state is distinct from historical sawGenerating
unchanged forced snapshots do not manufacture meaningful progress
active generation with stable visible text does not fail solely because answer text is unchanged
no meaningful progress emits watchdog events and requests a source-bound forced snapshot
terminal forced-snapshot content can finish the pending request through normal request.done metadata
empty/nonterminal forced snapshots clear stale partial answer state instead of completing from it
required-ZIP requests defer text-only done/forced-snapshot completion and probe the source turn until an artifact appears or the settle window expires
artifact readiness/action changes reset DOM stability even when filename/URL stay unchanged
progress item fingerprints are independent from aggregate progress text, so visible tool/status step changes are emitted
source-client disconnection becomes explicit recoverable_failed instead of a silent hang
normal request.done immediately enters normal.pipeline.started; pre-pipeline or resolver failures emit normal.pipeline.missing_after_done/normal.pipeline.failed
recovery result resolution emits recovery.pipeline.started/recovery.pipeline.failed
final assistant answer remains stored and is shown even when ZIP result resolution fails
interactive Activity renders watchdog/result events and persists compact task milestones into the normal transcript
```

Covered tests:

```text
long active generation stays alive past short idle timeout
silent request still times out/cancels
weak heartbeat does not count as meaningful progress
frequent weak heartbeat cannot starve/postpone the meaningful-progress watchdog
historical sawGenerating does not keep generation active
unchanged forced snapshot does not reset meaningful progress
forced snapshot targets sourceClientId, not active client
forced snapshot preserves assistantTurnKey binding
stale partial answer plus empty forced snapshot does not complete a required-ZIP request
text-only done waits for a later scoped artifact and resumes through the normal result pipeline
progress item changes emit even when aggregate progress text is unchanged
content script implements response.snapshot.request
normal resolver failure records pipeline failure and preserves final answer
```

Operational follow-up, not an incomplete Phase 6 contract:

```text
tune timeout defaults from real long-run captures
add a richer phase policy table only if captures show phase-specific false positives
```

## v53 — ChatGPT DOM parser reliability review

Status: implemented outside the numbered reliability phases.

The parser contract was reconciled with live ChatGPT DOM observations in `docs/CHATGPT_DOM_PARSER.md`. Implemented invariants:

```text
data-turn-id is the primary turn identity
conversation-turn-N and DOM index are snapshot-only fallbacks
answer comes only from [data-message-author-role="assistant"]
reasoning/tool/status siblings are separate visible blocks
transient reasoning is emitted before React replaces it
MutationObserver is scoped to main/[role=main]
completion requires final node + no Stop + action bar + stable signature
Continue/confirmation/error/tool-running states are non-terminal
recovery never promotes whole-turn raw text to final answer
artifact actions require explicit file/download intent
model and effort lists are read from the opened intelligence picker and nested model menu
missing/ambiguous critical roots report DOM_SCHEMA_CHANGED
```

Regression coverage includes phase-classification fixtures, tool/status grouping, completion gates, structural-signature changes, parser script load order, strict composer/picker selectors, and transient progress clearing through the server bridge.


## v54 — Generated artifact discovery and download reliability

Status: implemented outside the numbered reliability phases.

The file/artifact contract was reconciled with live observations in `docs/CHATGPT_FILES_CODE_DOM.md`. Implemented invariants:

```text
output files are discovered across the anchored assistant turn, not only inside final Markdown
filename-only file buttons can be artifacts when scoped file signals are present
file cards carry GENERATING / READY / FAILED state
final completion waits for all discovered generated artifacts to be READY
artifact actions are relocated only inside their original source turn/card
page-created Blob/data downloads are captured in MAIN world and streamed without polluting Downloads
newly exposed direct/authenticated URLs are fetched as the second path
chrome.downloads is a filename-matched fallback, not a global next-download listener
unrelated downloads are ignored and losing capture paths are cancelled
artifact capture source is preserved into server diagnostics/download metadata
```

This does not implement Phase 7 durable request memory. It improves the existing source-bound artifact path.

## v55 — Artifact metadata fallback and byte-level ZIP validation

Status: implemented outside numbered phases.

A real ChatGPT generated-file control may be scoped correctly and clickable while exposing neither a `.zip` filename nor a stable URL. The previous resolver rejected such controls before materialization, so diagnostics could show `artifactCount: 1` but no `artifact.downloading`.

Implemented invariants:

```text
prefer explicit .zip name/MIME metadata
if metadata is insufficient and exactly one scoped materializable artifact exists:
  click/fetch that action through the normal source-bound artifact path
  validate the downloaded bytes as ZIP before selecting/applying it
if multiple generic actions are ambiguous:
  refuse rather than click an arbitrary file
record artifact summaries and selectionReason in diagnostics
```

DOM filename extraction now prioritizes the action itself and nearby siblings before scanning the whole content block, avoiding accidental association with an unrelated filename mentioned earlier in the paragraph.

## Phase 7 — Extension-side durable request memory

Status: not implemented.

Goal: make reload/restore/reconnect recoverable without relying only on in-memory content-script `activeRequest`.

Extension background request registry should store:

```text
requestId
turnId
projectId
sourceClientId
sourceTabId
conversationUrl
promptHash
submittedUserTurnKey
assistantTurnKey
lastAnswerLength
lastProgressText
lastArtifactCount
phase
lastUpdatedAt
```

Content script `sessionStorage` checkpoint should store:

```text
requestId
promptHash
baselineTurnKeys
submittedUserTurnKey
assistantTurnKey
lastKnownAnswer
lastKnownVisibleProgress
lastKnownArtifacts
phase
```

Reconnect/reload behavior:

```text
content script reports checkpoint to background
background matches checkpoint to request registry
server marks request as reattached
normal finalization continues if possible
otherwise request becomes recoverable_failed with exact candidates/reason
closed source tab gives source_disconnected instead of silent failure
```

Implementation tasks:

```text
add background request registry keyed by requestId/sourceTabId
write content checkpoint after prompt submit, user turn anchor, assistant turn anchor, progress, answer/artifact updates
on WebSocket reconnect, replay active registry/checkpoints to server
teach /resume to attach to background registry even if content activeRequest was lost
surface registry/checkpoint state in diagnostics/debug bundle
expire old registry entries safely
```

Required tests:

```text
content script restart reports checkpoint
resume can attach to background request without content activeRequest
restored tab can recover assistantTurnKey
closed source tab gives source_disconnected instead of silent failure
registry does not attach a checkpoint from a different project/request
```

## Phase 8 — Recovery as fallback only

Status: partially implemented, not complete as a phase.

Goal: `/recover` remains available as an explicit fallback, but a normal successful `request.done` should not require manual recovery.

Required behavior:

```text
/recover list shows visible candidates with sourceClientId/source tab info
/recover <n> uses browser-visible candidate index
/recover <n> creates/adopts a local turn if needed
/recover <n> uses the same ResultResolver path as normal done
/recover <n> --apply uses the same apply planner and selectedResult guard
/recover cannot silently use previous selected result
/recover without artifact clears current selected result or leaves it unchanged only with explicit warning
```

Implementation tasks:

```text
make recovery UI explain candidate identity/source clearly
make recovery result replacement rules explicit in diagnostics
add source-client mismatch warnings for recovery candidates
make /recover --apply print the same apply plan/summary as normal apply
ensure recovery is never required after normal answer+ZIP request.done
```

Required tests:

```text
/recover list includes source client
/recover selected artifact carries sourceClientId
/recover result replaces selected result for current project
/recover --apply applies recovered result
/recover without artifact clears current selected result or leaves it unchanged only with explicit warning
/recover refuses/makes explicit source mismatch instead of applying stale selected result
```

## Updated implementation order

```text
Phase 3: Normal result pipeline convergence — implemented
Phase 4: Visible intermediate progress/thinking stream — implemented
Phase 5: Selected result safety and apply guard — implemented
Phase 6: Phase-specific watchdog and forced snapshot — implemented/audited through v58
v54-v55: generated artifact discovery/materialization and metadata fallback — implemented outside numbered phases
Phase 7: Extension-side durable request memory — next
Phase 8: Recovery as fallback only — later
```

Rationale: debug captures showed extraction can already succeed. Phases 3-6 now cover normal result convergence, visible progress, selected-result safety, stuck-state detection, and source-bound forced snapshots. The next reliability boundary is durable reload/reconnect state in Phase 7, followed by recovery-as-fallback UX in Phase 8.

## Updated success criteria

Normal run with final answer and ZIP:

```text
request.done
normal.pipeline.started
result/resolving
artifact.download.started
artifact.download.done
result.ready
apply.plan/apply.planning
apply.done or apply.waiting_confirmation/apply.skipped with reason
```

Normal run with final answer but no ZIP:

```text
request.done
final summary printed
completed_without_artifact
selected result cleared
/apply refuses stale previous artifact
```

Visible intermediate progress:

```text
visible_thinking/progress -> interactive progress stream
actual .zip button/link -> artifact stream
progress labels never become ZIP artifacts
```

Manual recovery:

```text
/recover can still adopt/select/apply a visible result
/recover result must carry source identity when available
/recover must not be necessary after normal successful request.done
```

## Non-goals

Do not solve reliability by:

```text
setting a 30-minute timeout
using latest ZIP globally
using latest assistant answer globally
trusting heartbeat as request progress
silently switching to another active ChatGPT tab
requiring manual /recover as normal workflow
auto-applying low-confidence artifacts
classifying visible progress labels as artifacts
allowing /apply to use stale selected result
reviving Playwright/CDP or public userscript polling as production transport
```
