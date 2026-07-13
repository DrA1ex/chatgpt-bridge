# Project Task Workflow Reliability Goal

This file is the roadmap/spec for making the project-task workflow reliable. It should preserve the agreed future phases without becoming a session diary.

Current implementation target: completed through Phase 6 and audited through v69, including tab/session targeting, interactive UX reliability, the ChatGPT DOM-parser rework, generated-artifact download reliability, delayed-artifact/stale-snapshot guards, and stable logical reconciliation of visible thinking blocks. Do not start Phase 7+ unless explicitly asked.

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

Status: implemented in v50 and completed/audited through v60 for server-side phase/liveness tracking, source-bound forced snapshots, non-starvable watchdog scheduling, explicit result-pipeline failure events, interactive watchdog activity, strict DOM-terminal snapshot validation, stale partial-state clearing, and required-artifact settle on both content and server sides. Browser reload/durable request memory remains Phase 7.

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

## v60 — Apply containment and reconnect UX audit

Status: implemented within the existing Phase 5/6 scope. This is not Phase 7 durable request memory.

The review found several gaps in behavior already marked as implemented even though the existing test suite was green. Implemented invariants:

```text
ZIP apply rejects an existing symlink in any descendant path component
sync-delete rejects symlink-routed reference paths and rechecks immediately before unlink
turn completion listeners are attached before history/status reconciliation, so a terminal event cannot be lost in the read/subscribe race
/resume follows an already tracked local project turn instead of failing with already tracked locally
plain-chat /resume can follow the existing pending request without creating a second browser tracker
an active local/browser request is rendered as tracking, reconnecting, or resume available; it is never shown as ordinary idle
content runtime reports finalizing after generation stops while post-stop settling is still active
returning to a visible/focused/pageshow tab immediately reattaches the DOM observer and collects a fresh source-bound snapshot
when the same in-memory request reconnects, the server emits request.reattached and requests a source-bound snapshot
```

Covered regressions:

```text
ZIP write through project symlink cannot modify an outside file
sync-delete through project symlink cannot remove an outside file
terminal event arriving during getTurn reconciliation cannot hang waitForTurn
/resume follows an already tracked project turn
resumeActiveRequest followers share one pending browser request
Ink status distinguishes idle from tracking/reconnecting/resumable work
extension foreground return triggers immediate collection and uses finalizing instead of idle
```

Remaining boundary: a full content-script/background/server restart can still lose in-memory request identity. The durable registry/checkpoint work below remains Phase 7 and is still not implemented.

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
Phase 6: Phase-specific watchdog and forced snapshot — implemented/audited through v60
v54-v55: generated artifact discovery/materialization and metadata fallback — implemented outside numbered phases
Phase 7: Extension-side durable request memory — next
Phase 8: Recovery as fallback only — later
```

Rationale: debug captures showed extraction can already succeed. Phases 3-6 now cover normal result convergence, visible progress, selected-result safety, stuck-state detection, source-bound forced snapshots, apply-path containment, and explicit in-memory reconnect UX. The next reliability boundary is durable reload/reconnect state in Phase 7, followed by recovery-as-fallback UX in Phase 8.

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

## v61 real-browser E2E audit

Status: implemented as an explicit, opt-in smoke suite.

The real E2E contract now covers the normal browser path rather than a synthetic DOM fixture:

```text
open one isolated ChatGPT tab automatically
bind it to a one-time launch token before navigation
send a real prompt and verify the exact final answer
send a real follow-up to the concrete returned session id
verify that the follow-up stayed on the same /c/<id> URL
ask ChatGPT directly for a real downloadable file
materialize the artifact through the normal bridge path and verify bytes
remove only the created conversation after exact source-client + sessionId + canonical URL checks
leave the session and tab intact with --keep-session
```

Safety invariants:

```text
real E2E is not part of npm test and cannot spend ChatGPT requests accidentally
new tab metadata is persisted before navigation so the content connection cannot outrun its launch token
session deletion requires expectedSessionId and expectedUrl at the HTTP, bridge, DOM-guard, menu, and confirmation layers
a generic page-level More/Delete control is not accepted as the conversation delete action
the delete action must become visible after opening the menu for the exact current conversation
cleanup refusal leaves the tab open and fails visibly
only the source tab associated with the E2E client may be closed
```

Automated coverage includes the URL guard, bridge command routing, extension launch-token ordering, guarded menu behavior, and public HTTP endpoints. The live-account command remains a manual/CI opt-in because it requires a logged-in browser profile and consumes real ChatGPT turns.

## v61 real-browser E2E matrix

Completed:

- opt-in real ChatGPT E2E runner with automatic isolated-tab opening;
- visible reasoning/progress item and terminal completion checks;
- source-bound in-flight steer command and REST endpoint;
- multiple independent file downloads and deterministic ZIP verification;
- multi-turn project result modification;
- project `AGENT.md` and enabled skill behavior checks;
- absence-safe project flow without agent/skills;
- unchanged snapshot reuse assertion proving the project ZIP is not attached again;
- fail-closed URL/session-bound cleanup and `--keep-session` inspection mode;
- JSON, Markdown, NDJSON and ZIP diagnostic reports suitable for direct bug handoff.

The live suite is intentionally excluded from `npm test` because it consumes real ChatGPT requests and requires an authenticated browser tab.

## v62 token-bound automatic tab opening

Status: implemented as an opt-in extension of normal server and interactive prompt routing.

Completed:

```text
replace E2E "exactly one new client" inference with exact launch-token matching
centralize extension-created and system-browser-created tab opening in TampermonkeyBridge
support --auto-open-tab and --no-auto-open-tab for interactive/server processes
support AUTO_OPEN_TAB and per-request autoOpenTab overrides
propagate autoOpenTab through chat, OpenAI-compatible request bodies, jobs, and turns
allow POST /browser/tabs/open to opt into system fallback
wait briefly for old extension tabs to reconnect before invoking the OS browser
show open-tab requested/completed/failed events in interactive output
preserve strict explicit sourceClientId routing
refuse automatic duplication of a requested conversation that is already busy
```

Identity invariant:

```text
A browser tab is considered the auto-open result only when it proves the exact one-time launch token generated for that request. The normal proof is the extension handshake; an exact token parsed from the bridge-created launch URL is a compatibility fallback when the handshake field is omitted. Client-count deltas, focus, an ordinary ChatGPT URL, and reconnect timing are not sufficient identity.
```

Regression coverage includes system-browser token routing, extension-background tab creation when all normal tabs are busy, per-request disable override, strict sourceClientId preservation, busy-session non-duplication, generic launch-token adoption in the extension, API propagation, and the real E2E runner's centralized open route.


## v63 isolated E2E launch routing

Status: implemented.

The live E2E runner no longer shares the normal `8080` bridge by default. It chooses a free loopback port, starts the test server with an isolated temporary `DATA_DIR`, and passes the target server origin together with the one-time launch token. Extension 0.4.0+ treats that server URL as an in-memory/per-tab override only and persists it in `chrome.storage.session` so page reloads do not fall back to the ordinary bridge.

The bridge also derives the exact one-time token from a launch URL when a client reaches the correct server but an older/stale content script omits `launchToken` from hello. This fallback still requires the cryptographically unpredictable exact token and never falls back to counting new clients. Timeout diagnostics list observed client URLs and extension/content versions and explicitly identify stale extension code.

## v64 real E2E readiness, steer, selection, and diagnostics hardening

Status: implemented.

Completed:

```text
wait for document + scoped chat root + visible composer readiness before the first real prompt
require a stable ready interval plus a small post-ready settle delay
retry prompt and steer submission when the real DOM does not confirm a new user turn/composer clear/generation start
expose pageReady/chatMainReady/composerReady through hello, page status, hub clients, and E2E tab selection
expose activeRequests in /health so steer orchestration observes the same tracked state as the bridge
make the steer scenario start with RED, wait for a genuinely active accepted request, then override it in-flight to BLUE
make any contextual-memory prompt explicitly forbid account-wide ChatGPT memory updates
support repeatable/comma-separated --model and --effort E2E matrices with model.apply.done verification
write diagnostics under the current project's .bridge-data/e2e directory before the first prompt
persist console.log, RUNNING.json, report.partial.json, and timeline.partial.ndjson throughout the run
finalize and verify report.json, SUMMARY.md, timeline.ndjson, and the uploadable ZIP without skipping server cleanup on a diagnostics error
retry the exact URL-bound conversation-menu cleanup only for transient UI-not-ready failures
```

Observed root cause fixed:

```text
The old steer runner waited for /health.activeRequests, but /health did not return that field. A real request could be accepted and finish while the runner waited for a state that was impossible to observe. The old diagnostics path was also derived from the global DATA_DIR and final files were written only during shutdown, so looking under the project .bridge-data directory after an early failure appeared as if no report had been created.
```

The safety invariant is unchanged: cleanup retries never relax `sourceClientId + sessionId + canonical expectedUrl` verification and leave the tab/session intact when identity cannot be proven.

## v65 steer turn re-anchoring and locale-independent destructive UI

Status: implemented.

Completed:

```text
re-anchor one active request from the original assistant turn to the new user/assistant pair created by a real steer
clear stale pre-steer answer, artifact, stability, and terminal-candidate state when that new user turn is adopted
select the first assistant turn after the steer user turn instead of the original placeholder
recognize conversation deletion by stable data-testid and Radix trigger/menu ownership
remove localized visible-label and aria-label matching from destructive action selection
scope confirmation to the modal that appeared after the exact delete action
accept only a semantic confirmation test id or one unique destructive button
fail closed when stable structural identity is unavailable
```

Observed failure fixed:

```text
The browser accepted the steer and rendered a second user turn plus the expected final assistant answer. The tracker retained the old assistant anchor, so completion inspected the earlier empty placeholder and reported a failed turn. Separately, the correct Russian delete item was present as data-testid="delete-chat-menu-item", but old descriptor logic mixed its test id with visible text and then applied an exact localized-label comparison. Both paths now use structural identity rather than translated strings.
```


## 2026-07-12 — fullscreen text-artifact preview materialization (v64)

Added bridge 4.10.3 / extension 0.4.4 / content 2.12.3. Live E2E diagnostics showed that ChatGPT text/JSON/CSV artifact buttons can open a fullscreen CodeMirror preview instead of starting a browser download. Artifact materialization now performs a filename-bound second action inside the newly opened preview, keeps page/blob and `chrome.downloads` captures armed, closes the preview before the next file, and has a bounded UTF-8 DOM fallback for text previews. Preview action selection is locale-independent and fail-closed.


## 2026-07-12 — delayed fullscreen preview readiness and English E2E prompts (v66)

Added bridge 4.10.4 / extension 0.4.5 / content 2.12.4. Fullscreen artifact previews are now considered ready only after the filename-bound preview has a usable structural download control and, for text previews, a mounted code-content node. The content script keeps polling through loader states with bounded diagnostics and a 45-second readiness ceiling instead of abandoning the preview after eight seconds. All prompts and steer messages sent by the real E2E runner are now English and explicitly keep contextual markers out of account-wide memory.

## 2026-07-12 — v67 localized preview controls and delayed-preview cleanup

Status: implemented.

Added bridge 4.10.5 / extension 0.4.6 / content 2.12.5. Artifact preview materialization now supports both observed ChatGPT layouts: fullscreen `role="dialog"` and library `[slot="content"]`. The preview is bound to the exact expected filename before any localized action fallback is allowed. Download labels cover common English, Russian, French, German, Spanish, Italian, Portuguese, Dutch, Polish, Turkish, Japanese, Korean, Simplified Chinese, and Traditional Chinese variants; close prefers `data-testid="close-button"` and otherwise uses the same scoped multilingual fallback.

Direct Blob/URL/`chrome.downloads` capture remains the primary path for ZIP, binary, and large files. A text-like `page-url`/`dom-url` result now waits only for a bounded late-preview cleanup. If a preview from the previous text artifact appears while the next text artifact is being processed, the extension closes the foreign filename-bound preview and retries the current scoped artifact click once.

Regression suite: 199/199 passing.


## 2026-07-12 — v68 live action re-resolution after foreign preview

Status: implemented.

Added bridge 4.10.6 / extension 0.4.7 / content 2.12.6. The real E2E report showed the first text preview closing successfully and the second artifact fetch starting, but the foreign-preview retry then called `retryAction.click()` even though `retryAction` was a function. That synchronous type error left the other capture promises pending until the 120-second artifact timeout.

The retry contract is now callable-only. Initial and retry clicks both re-resolve the exact scoped action from the live assistant turn, wait up to a bounded interval for a usable element after Radix/React replacement, and emit `artifact.action.retry_clicked`. The DOM URL materializer also re-resolves the live source turn on every poll. E2E console output now prints artifact download start and completion with bytes and duration.


## 2026-07-12 — v69 exact artifact identity and bounded materialization

Status: implemented.

Added bridge 4.10.7 / extension 0.4.8 / content 2.12.7. Analysis of the real E2E artifact list showed that all three generated-file buttons carried the same generic `selectorHint`. The old fast path used `document.querySelector(selectorHint)` and therefore selected the first TXT button again while the JSON artifact was requested.

The selector hint is now discovery-only. The runtime enumerates actions inside the exact source assistant turn and accepts one unique candidate only when its filename matches exactly or its stable block/action locator matches. A foreign filename preview is closed and returned immediately as `ARTIFACT_ACTION_TARGET_MISMATCH`; it no longer triggers another blind click.

Artifact materialization now has a 45-second browser-side budget and a 60-second server envelope. Action readiness is observed with bounded exponential backoff, preview/download/URL paths run concurrently, unused paths are cancelled, and fatal identity errors short-circuit the race. The previous 120-second artifact fallback is removed. Regression suite: 204/204 passing.

## v70 extensionless artifact titles and CSV/table preview identity

Status: implemented.

Added bridge 4.10.8 / extension 0.4.9 / content 2.12.8. The uploaded real E2E report showed that the exact CSV artifact action was selected, but ChatGPT opened a spreadsheet-style `[slot="content"]` preview whose `[data-testid="popcorn-file-title"]` displayed `test_data` and a separate `CSV` format label instead of the generated filename with `.csv`. The old preview detector therefore reported `preview_container_not_visible` until the bounded materialization timeout.

The preview parser now recognizes `popcorn-toolbar`, scopes controls to `popcorn-toolbar-actions`, and supports a fail-closed identity hierarchy: exact filename, exact display title, expected filename stem plus matching format label, or arbitrary display title only when that format is unique among READY artifacts in the exact source assistant turn. After identity is proven, the display title plus expected extension is registered as a temporary page/browser-download alias, while the original expected filename remains valid. Multiple same-format artifacts without stronger identity are rejected as ambiguous. Direct ZIP, binary, and large-file capture remains the primary path and is not delayed by table-preview handling. Regression suite: 209/209 passing.


## v71 ZIP completion guard, lifecycle filtering, and bounded waits

Status: implemented.

Added bridge 4.10.9 / extension 0.4.10 / content 2.12.9. The uploaded real E2E report showed the correct `d909460e04b6-bundle.zip` action as READY, but the DOM parser also emitted a false `alpha.txt` artifact from Python source because the adjacent Copy button had `data-state="closed"`. The phantom artifact remained `GENERATING`, so the completed response never became terminal and the old 300-second E2E request timeout expired before artifact download capture was armed.

The state scanner now accepts only explicit lifecycle descriptors and excludes generic artifact-unrelated controls. Completion ignores defensive non-lifecycle candidates, while genuine loading/progress items still block. A required ZIP contract now matches a materializable ZIP specifically, not an arbitrary READY artifact. The server uses bounded required-artifact probes (`500ms` exponential backoff capped at `5s`) within a 30-second post-generation ceiling. The E2E request timeout is 90 seconds and artifact materialization is 45 seconds (configurable only within 10–60 seconds). Timeout aborts preserve a real Error and useful diagnostic message. Regression suite: 212/212 passing.


## v72 semantic ZIP action identity and progress-aware E2E timeouts

Status: implemented.

Added bridge 4.10.10 / extension 0.4.11 / content 2.12.10. A real project result exposed one READY button titled `Download the updated project ZIP` rather than a filename. The server-side required ZIP guard now recognizes semantic ZIP/archive identity from action labels and block text, avoiding the unnecessary 30-second post-generation settle while still rejecting unrelated READY files.

The live runner no longer treats 90 seconds as the maximum duration of a turn. Timeouts are split by responsibility: active generation has no default absolute limit; pre-completion result inactivity is five minutes; post-generation pipeline inactivity is 60 seconds; artifact materialization is 45 seconds; and short HTTP controls are 30 seconds. The isolated bridge now receives the result timeout instead of accidentally using the HTTP-control timeout. The production bridge likewise applies a shorter post-generation watchdog while preserving indefinite active-generation liveness unless an explicit maximum is configured.

Delete confirmation waits up to ten seconds using bounded exponential backoff and emits waiting/timeout diagnostics. Exact URL-bound cleanup retries up to three times with exponential delays without weakening identity checks. A final two-second URL-removal grace handles a confirmation/navigation race. Regression suite: 215/215 passing.

## v72 — Lossless response-parser ownership audit

Status: implemented outside the numbered reliability phases.

The final-response parser no longer assumes that all future ChatGPT components are already known. Implemented invariants:

```text
one ordered block stream produces both Markdown and stored structured output
outer response-level code widgets own nested editor implementation nodes
nested CodeMirror pre elements never become duplicate top-level code blocks
every visible text leaf has exactly one ownership category
unknown visible text remains in the answer as an explicit unknown block
strict parser E2E rejects unknown or duplicate ownership and requires full terminal coverage
streaming React rerenders are not tested with an invalid byte-prefix rule
live parser-observation.txt supports direct human verification
machine diagnostics preserve blocks, audit, unknown nodes, reasoning, and terminal DOM
```

Regression coverage includes current nested CodeMirror widgets, localized Copy/Run actions, unknown widget chrome, parser-audit transport, English-only Markdown documentation, and E2E transcript/report surfaces.
