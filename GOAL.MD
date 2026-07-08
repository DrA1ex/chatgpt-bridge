# Project Task Workflow Reliability Goal

This document is the technical specification and implementation plan for making the main project-task workflow reliable.

It focuses on the runtime process, request identity, browser-session ownership, progress tracking, diagnostics, final response capture, artifact resolution, and apply behavior. It is intentionally technical: the purpose is to prevent repeated local fixes to `/recover`, `/apply`, artifact download, or final-answer extraction without a shared process contract.

## 1. Core problem

The current project-task workflow depends too much on one live content script instance inside one ChatGPT tab.

The expected path is:

```text
CLI prompt
-> server creates turn/request
-> extension sends prompt to ChatGPT
-> content script watches DOM/network
-> content script sends final answer + artifacts
-> server resolves ZIP
-> server plans/applies changes
```

When everything is ideal this works. It becomes unreliable when the content script loses DOM anchoring, the tab becomes hidden/frozen/discarded, ChatGPT changes markup, artifact links appear late, the browser active tab changes, or the content script/background reconnects.

The solution must not be a single large timeout. Project tasks may legitimately run for 10-20 minutes or more. The bridge needs to know whether the request is still healthy, what phase it is in, and whether real request progress is happening.

## 2. Target user-visible outcome

After every normal project prompt, the user must reach exactly one explicit outcome:

```text
completed and applied safely
completed with changes waiting for confirmation
completed with no changes
completed without artifact, final answer printed
recoverable failure with exact phase and diagnostic data
hard failure with exact reason
```

The user must not end up in a state where ChatGPT visibly answered but the bridge prints nothing, downloads a stale artifact, applies a ZIP from another turn, or requires guessing which `/recover` command to run.

## 3. Required identity model

Every project task must have stable identity across server, extension background, content script, diagnostics UI, and apply pipeline.

Required identifiers:

```text
projectId
projectRoot
chatSessionId
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

Artifacts, downloads, recovery reads, and final snapshots must be bound to the original source client/tab/session. The system must not silently switch to another ChatGPT tab while an existing request is running.

Follow-up commands for an existing request must target the source client:

```text
final snapshot -> sourceClientId
recover by turnKey -> sourceClientId
artifact fetch -> sourceClientId
artifact settle retries -> sourceClientId
```

The active client selection may affect new requests, but not a request that is already running.

## 4. Request phases

A project request should move through explicit phases:

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

Each phase must have observable progress signals and clear diagnostics.

## 5. Liveness model

There are several different kinds of liveness. They must not be mixed.

### 5.1 Hard liveness

Hard liveness answers only:

```text
is the extension/content script alive?
is the port connected?
is the tab still present?
is the tab discarded/frozen/closed?
```

Signals:

```text
background port heartbeat
content script heartbeat
tab exists
tab URL still matches ChatGPT
Chrome tab status
visibilityState
```

This timeout may be relatively short, for example 20-60 seconds, because it detects dead script/tab/connection. Hard heartbeat must not be treated as request progress.

### 5.2 Request progress liveness

Request progress answers:

```text
is this request moving through expected phases?
```

Meaningful progress signals:

```text
prompt accepted
prompt sent
submitted user turn captured
assistant turn captured
generation started
answer length changed
thinking length changed
artifact count changed
network stream activity observed
DOM mutation observed inside current assistant turn
generation status changed
post-stop finalization started
artifact settle retry running
```

These events update `lastMeaningfulProgressAt`.

### 5.3 Generation activity liveness

Generation activity answers:

```text
is ChatGPT still generating even if visible text has not changed recently?
```

Useful signals:

```text
active streaming fetch/SSE/network request
visible stop button
assistant turn has active spinner/streaming markers
DOM mutations inside current assistant turn
thinking block changing
answer block changing
```

No single signal should be the only source of truth forever.

### 5.4 Weak liveness

Weak liveness signals include:

```text
content script heartbeat
page status heartbeat
tab focused/visible
activeRequest object still exists
```

They prove that the machinery is alive, not that ChatGPT is progressing. Weak liveness may keep the request out of a dead-script state, but it must not indefinitely reset request-progress watchdogs.

## 6. Progress events and UI visibility

The content script must emit request-level progress events while a request is active.

A progress event should include:

```text
requestId
phase
visibilityState
focused
submittedUserTurnKey
submittedUserTurnIndex
assistantTurnKey
assistantTurnIndex
anchorConfidence
anchorReason
turnCount
assistantNodeCount
stopButtonVisible
sawGenerating
sawAnswer
answerLength
thinkingLength
artifactCount
networkDone
generationIdleForMs
stableForMs
lastMeaningfulProgressAt
snapshotReason
```

The server must store these events as turn/request events, not only in a short global debug ring.

The CLI/companion UI should show compact progress such as:

```text
[chat] prompt sent
[chat] user turn captured
[chat] assistant turn captured
[chat] generating · thinking 1.2k chars · answer 0 chars · artifact 0
[chat] generating · last stream activity 4s ago
[chat] generation stopped · finalizing response
[result] waiting for artifact link · retry 2/8
[result] artifact found · downloading
[apply] planning changes
```

Warnings should be visible but not noisy:

```text
[warn] ChatGPT tab is hidden; monitoring continues, but timers may be throttled.
[warn] generation appears active, but no answer/thinking changed for 90s.
[warn] source tab disconnected; trying to reconnect to original session.
[warn] assistant turn not anchored yet; not using old responses.
```

## 7. Server supervision

The content script is closest to the DOM and should produce the final snapshot, but the server must supervise the request.

The server should track:

```text
lastHeartbeatAt
lastMeaningfulProgressAt
lastProgressEvent
currentPhase
sourceClientId
sourceUrl
sourceSession
```

If a request is alive but no meaningful progress happens for the current phase, the server should not immediately fail. It should first request a forced snapshot from the source client.

The fallback order should be:

```text
normal content-script final snapshot
-> forced snapshot from source client
-> automatic recovery by stored anchors/checkpoint
-> recoverable_failed with diagnostic bundle
```

Fallback exists, but the normal path should reach final snapshot without requiring it.

## 8. Extension-side request memory

The content script must not be the only owner of active request state.

The extension background should maintain a durable request registry:

```text
requestId
localTurnId
projectId
sourceClientId
sourceTabId
conversationUrl
promptHash
promptPreview
createdAt
sentAt
lastProgressAt
lastMeaningfulProgressAt
currentPhase
submittedUserTurnKey
assistantTurnKey
lastAnswerLength
lastThinkingLength
lastArtifactCount
lastKnownArtifacts
visibilityState
tabStatus
```

The content script should also store a lightweight checkpoint in `sessionStorage`:

```text
requestId
promptHash
baselineTurnKeys
submittedUserTurnKey
assistantTurnKey
lastKnownAnswer
lastKnownThinking
lastKnownArtifacts
```

After reload/reconnect, the content script should report whether it found a request checkpoint and list visible recovery candidates.

This should make accidental tab reload/restore recoverable without manual guessing.

## 9. User/assistant turn anchoring

Current anchoring must remain strict enough to avoid old answers, but it needs better diagnostics and confidence levels.

Primary anchors:

```text
new user turn after baseline
assistant turn after submitted user turn
```

Secondary anchors:

```text
user turn text hash matches prompt hash
assistant turn appears after sentAt
assistant turn appears after baseline assistant count
conversation URL/session matches request
```

Low-confidence fallback:

```text
latest assistant response after sentAt
```

Low-confidence fallback may be used for diagnostics and recovery suggestions. It must not silently auto-apply artifacts.

Every final snapshot should include:

```text
anchorConfidence: high | medium | low
anchorReason
```

Auto-apply should require high or acceptable medium confidence.

## 10. Finalization model

Completion should be two-phase.

The content script should not immediately send `done` the moment generation appears stopped. It should enter finalization:

```text
generation stopped candidate
-> wait for DOM settle
-> re-read the same assistant turn several times
-> wait for artifact links if ZIP expected
-> produce final snapshot
```

Final snapshot should include:

```text
requestId
sourceClientId
conversationUrl
submittedUserTurnKey
assistantTurnKey
assistantTurnIndex
answer
thinking
artifacts
artifactCount
generationSignals
finalizationReason
anchorConfidence
```

If ZIP is expected but not visible, the system enters `artifact_settle` and retries only inside the same source client / same assistant turn.

Forbidden fallbacks:

```text
latest ZIP on page
previous selected ZIP
global artifact cache without current request binding
artifact from another ChatGPT tab
artifact from another project/session
```

If no current artifact appears:

```text
completed_without_artifact
final answer printed
selected result cleared
previous ZIP not reused
manual recovery suggested
```

## 11. Active tab and session handling

Tab/session switching must be treated as normal.

Rules:

1. A running request stays bound to its original source client.
2. New ChatGPT tabs do not steal the running request.
3. Selecting another client affects new requests only.
4. Existing request follow-ups use the source client.
5. If the source tab disconnects, the request enters `source_disconnected`, not silent failure.
6. If the source tab reconnects, the extension attempts automatic reattach.
7. If the source tab was closed and restored, the extension attempts recovery from stored checkpoint.
8. If the conversation URL changed, the system records it and checks whether it is still the expected session.

## 12. Diagnostics page requirements

The diagnostics page must expose enough data to debug a failure without guessing.

### Connected clients

```text
clientId
tabId
url
conversation/session id if known
connected since
last heartbeat
visibilityState
focused
tab status
is selected
has active request
```

### Active requests

```text
requestId
localTurnId
projectId
projectRoot
sourceClientId
sourceTabId
conversationUrl
phase
createdAt
sentAt
lastHeartbeatAt
lastMeaningfulProgressAt
lastProgressEvent
submittedUserTurnKey
assistantTurnKey
answerLength
thinkingLength
artifactCount
anchorConfidence
```

### Timeline

```text
prompt.delivered
prompt.accepted
attachments.started
attachments.done
prompt.sent
user_turn.captured
assistant_turn.captured
generation.started
answer.changed
thinking.changed
artifact.changed
generation.stopped_candidate
finalization.started
artifact_settle.retry
final_snapshot.ready
result.selected
download.started
download.done
apply.plan
apply.done
```

### Manual diagnostic actions

The page should eventually allow safe scoped actions:

```text
force snapshot from source client
re-read assistant turn by turnKey
list visible candidates
download selected current artifact
copy debug bundle
```

Manual actions must be scoped to the selected request/source client, not global latest state.

## 13. Data to collect during failures

When a failure happens, diagnostics should answer:

```text
did the prompt reach ChatGPT?
did content script capture the user turn?
did it capture the assistant turn?
did generation start?
did generation stop?
did answer length ever grow?
did thinking length ever grow?
did artifact count ever grow?
did source client disconnect?
did active client change?
was the tab hidden/frozen/discarded?
did final snapshot happen?
did artifact settle retries happen?
```

The improved diagnostics page should make this visible without raw log inspection.

## 14. Implementation phases

### Phase 1 — Observability first

Add request progress events and diagnostics page improvements.

No major lifecycle behavior rewrite yet.

Deliverables:

```text
request.progress events
turn-scoped diagnostics
active request state in diagnostics page
client/source tab state in diagnostics page
debug bundle export
UI progress status in companion/CLI
```

### Phase 2 — Source client binding

Make every request remember source client/tab/session and route follow-up operations through the source client.

Deliverables:

```text
forced snapshot uses sourceClientId
recover by turnKey uses sourceClientId
artifact fetch uses sourceClientId
artifact settle retry uses sourceClientId
```

Implementation status as of v30:

```text
done/artifact snapshots carry sourceClientId
bridge command routing accepts sourceClientId/clientId
recover by turnKey uses sourceClientId
artifact fetch uses sourceClientId
artifact settle retry uses sourceClientId
wrong-client command replies are ignored
```

Remaining phase-2-adjacent work: forced snapshot command is still planned together with the phase-specific watchdog work.

### Phase 3 — Extension-side request memory

Move request ownership into extension background and add content-script checkpointing.

Deliverables:

```text
background request registry
sessionStorage checkpoint in content script
reattach after content script restart
source tab restored detection
automatic recovery attempt after reconnect
```

Implementation status as of v31:

```text
extension manifest version is 0.2.1 after runtime changes
content script publishes page status immediately when activeRequest starts and when it clears
hub derives client.activeRequest from request.progress/request messages, not only page.status/pong
/resume can find the single running prompt across connected clients instead of only the selected active tab
/resume attaches through the source client for the running request
project resume uses the same discovered source client when reattaching a known local turn
```

Remaining phase-3 work: the extension background still does not persist a durable request registry, and content script request checkpoints in sessionStorage are still planned.

### Phase 4 — Reliable progress watchdog

Replace broad timeout behavior with phase-specific watchdogs.

Deliverables:

```text
hard liveness timeout
meaningful progress watchdog
generation activity watchdog
phase-specific warnings
forced snapshot on stall
recoverable_failed instead of silent hanging
```

### Phase 5 — Two-phase finalization

Make the content script produce a final snapshot after post-stop settle and artifact settle.

Deliverables:

```text
generation stopped candidate
post-stop settle window
same-turn final rereads
artifact settle retries
final.snapshot event
anchor confidence
completed_without_artifact when needed
```

### Phase 6 — Safer recovery and apply integration

Ensure normal workflow and recovery workflow converge into the same result/apply pipeline.

Deliverables:

```text
same result resolver for task/resume/recover
same apply planner
no global latest ZIP fallback
no previous selected result reuse
auto-apply only on safe high-confidence plan
```

## 15. Testing plan

Required scenario tests:

```text
long-running request with periodic generation progress does not timeout
heartbeat without meaningful progress is distinguishable from real progress
hidden tab keeps request alive but marks monitoring as throttled
active tab switch does not move source client for existing request
artifact fetch uses source client, not active client
content script restart reattaches to stored request checkpoint
final answer is printed even when artifact is missing
artifact appears after generation stop and is found during settle retries
old ZIP is not reused when current response has no ZIP
low-confidence recovered response does not auto-apply silently
```

## 16. Non-goals

Do not solve reliability by:

```text
setting a 30-minute timeout
using latest ZIP globally
using latest assistant answer globally
trusting heartbeat as request progress
silently switching to another active ChatGPT tab
requiring manual /recover as normal workflow
auto-applying low-confidence artifacts
```

## 2026-07-08 implementation note: diagnostics auth UX

During Phase 1 observability, the diagnostics HTML page became localhost-only, but some JSON requests made by that page still used general API endpoints protected by `API_TOKEN`. This made the UI show empty objects or unusable loading states when the browser had no API token.

The diagnostics contract is now clarified:

```text
/diagnostics itself and diagnostics-only JSON endpoints are localhost-only operator tools
/diagnostics must not require users to manually provide API_TOKEN in the browser
/general HTTP API endpoints must remain protected by API_TOKEN when configured
/diagnostics must show explicit HTTP errors instead of silent empty sections
```

Implemented diagnostics-only endpoints:

```text
GET /diagnostics/state
GET /diagnostics/events
GET /diagnostics/debug-events
```

These endpoints exist only for the diagnostics page and should not become a general unauthenticated API surface.
