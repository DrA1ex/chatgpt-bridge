# Project Task Workflow Reliability Goal

This document is the technical specification and implementation plan for making the main project-task workflow reliable.

It focuses on the runtime process rather than business behavior. The purpose is to prevent repeated local fixes to `/recover`, `/apply`, artifact download, final-answer extraction, or browser-tab handling without a shared process contract.

## 1. Core problem

The project-task workflow currently depends too much on a single live content script instance inside one ChatGPT tab.

The intended path is:

```text
CLI prompt
-> server creates turn/request
-> extension sends prompt to ChatGPT
-> content script watches DOM/network
-> content script sends final answer + artifacts
-> server resolves ZIP
-> server plans/applies changes
```

This path works only when every part is ideal: the tab stays alive, the content script keeps its in-memory `activeRequest`, DOM anchoring succeeds, ChatGPT markup matches our selectors, artifact links appear before finalization, and the selected/active tab remains the one that owns the request.

The solution must not be a single large timeout. Project tasks may legitimately run for 10-20 minutes or more. The bridge needs to know whether the request is still healthy, what phase it is in, and whether real request progress is happening.

## 2. New finding from debug captures

The latest debug captures changed the priority of the plan.

The normal content-script extraction path can already find, at least in some failing runs:

```text
submitted user turn
assistant turn
final answer
final ZIP artifact
high anchor confidence
source client id
request.done
```

The failure can happen after extraction succeeds.

Observed broken transition:

```text
request.done
-> TurnManager/project result pipeline
-> result/resolving
-> artifact download
-> selected current result
-> apply planning
-> auto-apply or safe apply decision
```

In the failing run, `request.done` was emitted with an answer and a ZIP artifact, but no normal `result/resolving`, `artifact.download.started`, `result.ready`, or `apply.*` events followed.

Manual `/recover` worked because it used a different path that did enter the result pipeline.

Therefore the next implementation priorities are:

1. Make normal `request.done` converge into the same result/apply pipeline as `/recover`.
2. Make stale selected-result application impossible.
3. Split visible progress/thinking text from artifact extraction.
4. Continue reliability work only after the already-extracted final response cannot be lost.

## 3. Target user-visible outcome

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

## 4. Required identity model

Every project task must have stable identity across server, extension background, content script, diagnostics UI, result selection, and apply pipeline.

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

For high-confidence auto-apply, result identity must include:

```text
requestId
turnId
projectId
sourceClientId
sourceTurnKey
artifactId
fileId
```

If source identity is missing, the system may allow explicit manual recovery/apply, but must not silently auto-apply.

## 5. Request phases

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

Additional pipeline-specific phases/events are required:

```text
normal.done.received
normal.pipeline.started
normal.pipeline.missing_after_done
result/resolving
result.ready
apply.plan
apply.done
```

`request.done` must never be a terminal dead end.

## 6. Liveness model

There are several different kinds of liveness. They must not be mixed.

### 6.1 Hard liveness

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
chrome.tabs status
visibilityState
```

This timeout can be relatively short, for example 20-60 seconds, because it only detects a dead script, tab, or connection.

Hard heartbeat must not count as request progress.

### 6.2 Request progress liveness

Request progress liveness answers:

```text
is the current request still moving through expected phases?
```

Signals:

```text
prompt accepted
prompt sent
user turn captured
assistant turn captured
generation started
answer length changed
thinking/progress text changed
artifact count changed
network stream activity observed
DOM mutation observed inside current assistant turn
stop button visible
generation status changed
post-stop finalization started
artifact settle retry running
result pipeline started after request.done
```

These events should update `lastMeaningfulProgressAt`.

### 6.3 Generation activity liveness

Generation activity answers:

```text
is ChatGPT still generating, even if visible text has not changed recently?
```

Signals may include:

```text
active streaming fetch/SSE/network request
visible stop button
assistant turn exists and has active spinner/streaming markers
DOM mutations inside current assistant turn
visible progress/thinking text changing
answer block changing
```

The bridge must not depend on only one signal.

### 6.4 Weak liveness

Weak signals include:

```text
content script heartbeat
page status heartbeat
tab focused/visible
activeRequest object still exists
```

They show that the machinery is alive, not that ChatGPT is progressing. Weak liveness may keep a request from being marked as “dead script”, but it must not indefinitely reset the request-progress watchdog.

## 7. Phase 1 — Observability and diagnostics

Status: implemented for the current reliability scope.

Implemented:

```text
request.progress events
active request diagnostics
clients and active requests in diagnostics page
debug bundle export
diagnostics endpoints
basic UI progress events
source visibility/focus/anchor data
compact request timelines filtered from noisy dom.poll progress
clear separation between meaningful request progress and polling heartbeats
visible intermediate assistant progress/thinking text as a first-class stream
turn/request timeline summaries that flag request.done without result/resolving
selected result / apply state in diagnostics
current project/session/turn mapping in diagnostics
recent turns with output/source metadata in diagnostics
```

Diagnostics must now answer:

```text
Did request.done happen?
If yes, did result/resolving start?
If not, why not?
Which selected result is currently active?
Does selected result belong to the current turn/project/session?
Which source client and assistant turn produced the result?
```

Remaining diagnostic work is no longer Phase 1-blocking. The next improvements belong to later phases: phase-specific watchdog actions, durable extension request memory, and stronger apply guards.

## 8. Phase 2 — Source client binding

Status: implemented for result identity and diagnostics; apply enforcement remains Phase 5.

Implemented:

```text
normal done/artifact snapshots carry sourceClientId
artifact fetch can use sourceClientId
recover by turnKey can use sourceClientId
artifact settle retry can use sourceClientId
wrong-client command replies are ignored
/resume can search connected clients for running activeRequest
recovered responses and recovered artifacts inherit command/source client id
artifact download/result events preserve sourceClientId/sourceTurnKey/sourceRequestId
selected ZIP results preserve sourceClientId/sourceTurnKey/sourceRequestId in output metadata
same-turn artifact retries preserve source client identity
```

Source binding is now expected to be an invariant for high-confidence result resolution:

```text
requestId
turnId
projectId/source scope
sourceClientId
sourceTurnKey
artifactId
fileId
```

Known remaining work is intentionally deferred to Phase 5: `/apply` must refuse stale or source-mismatched selected results. Phase 2 only ensures the identity data exists and is visible; Phase 5 enforces it during apply.

## 9. Phase 3 — Normal result pipeline convergence

Status: implemented in v35 for the identified Ink interactive/project-task gap and normal TurnManager result path. Real-run diagnostics should still be collected after installation to verify the end-to-end browser path.

Goal: every successful `request.done` for a project task must enter the same result/apply pipeline as `/recover`.

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
-> result/resolving
-> artifact download
-> result.ready
-> selected result becomes current turn result
-> apply planning
-> auto-apply if safe
```

Required invariants:

```text
request.done must not be a terminal dead end
request.done must be visible in turn events
request.done must either produce result/resolving or completed_without_artifact
final answer must be printed even if result resolving fails
selected result must belong to the current project/session/turn
old selected result must be invalidated when a new project task starts
/apply must never apply an old artifact after a newer task completed or failed without selecting a new result
```

Implementation tasks:

```text
Trace current request.done handling path:
TampermonkeyBridge -> TurnManager -> runProjectTask -> ResultResolver -> ProjectApply

Add explicit event:
normal.done.received

Add explicit event:
normal.pipeline.started

Add explicit error state:
normal.pipeline.missing_after_done

Make runProjectTask treat request.done as the trigger for result resolving

Make result resolving run for normal task/resume/recover through one shared function

On new project task start:
clear or mark stale the previous selected result for that project/session

On /apply:
verify selectedResult.turnId === current expected turnId
verify selectedResult.projectId === current projectId
verify selectedResult.fileId exists
if not, refuse with a clear message
```

Required tests:

```text
normal request.done with answer+zip starts result/resolving
normal request.done with answer+zip downloads artifact
normal request.done with answer+zip selects current result
normal request.done with answer+zip triggers apply planning
normal request.done with answer only prints final summary and clears selected result
/apply after failed new task does not apply previous selected artifact
/recover and normal done use the same result resolver
```

## 10. Phase 4 — Visible intermediate progress/thinking stream

Goal: capture and display visible intermediate texts that ChatGPT renders during generation, such as status/progress/reasoning-step labels shown in the page UI.

This is not hidden chain-of-thought extraction. It is only visible UI text that the user can already see.

Current problem:

Some visible progress texts are currently misclassified as artifacts, for example action-like UI labels such as:

```text
Inspecting and listing contents of uploaded ZIP
```

These should not be treated as ZIP artifacts.

Required model:

Introduce a separate stream:

```text
assistant_progress.snapshot
```

or:

```text
visible_thinking.snapshot
```

Fields:

```text
requestId
sourceClientId
assistantTurnKey
text
kind: thinking | progress | tool_status | action_status
length
changedAt
anchorConfidence
```

Interactive UI should show compact updates:

```text
[thinking] Думаю
[progress] Inspecting uploaded ZIP
[progress] Listing project files
```

But it should avoid spam:

```text
dedupe identical text
throttle repeated progress lines
only print changed text
keep latest progress status visible in UI
store full progress timeline in diagnostics
```

Artifact extraction must ignore visible progress/action/status labels unless they are actual downloadable artifacts.

Valid ZIP artifact candidates:

```text
filename ends with .zip
mime indicates zip
download action explicitly points to a file
artifact container belongs to current assistant turn
```

Invalid artifact candidates:

```text
generic buttons inside thinking/progress UI
status labels
tool/action progress text
buttons without zip-like filename
```

Required tests:

```text
visible thinking/progress text is emitted as progress, not artifact
progress labels are shown in interactive UI
progress labels do not become application/zip artifacts
real .zip artifact is still detected
```

## 11. Phase 5 — Selected result safety and apply guard

Goal: make stale artifact application impossible.

Current problem:

After a normal run failed to select the new result, `/apply` used the previous artifact.

Required behavior at project task start:

```text
mark previous selected result as stale for this project/session
store currentRunId
```

Required behavior at `result.ready`:

```text
selectedResult = current turn result
selectedResult.turnId = currentRunId
selectedResult.projectId = current projectId
selectedResult.sourceClientId = sourceClientId
selectedResult.artifactId = artifactId
selectedResult.fileId = fileId
```

Required behavior at `/apply`:

```text
if no selected result:
  print "No result selected for the current task."

if selected result belongs to older turn:
  refuse by default
  show old turn id and current turn id
  suggest /apply --last only if such explicit command exists

if selected result project does not match current project:
  refuse

if selected result file is missing:
  refuse

if selected result has low confidence:
  require manual confirmation
```

Required tests:

```text
new task clears previous selected result
/apply refuses stale selected result
/apply refuses result from another project
/apply accepts current selected result
/recover selects recovered result for current turn
/recover then /apply applies recovered result
```

## 12. Phase 6 — Phase-specific watchdog and forced snapshot

Goal: avoid huge timeouts and detect whether the request is healthy based on phase-specific signals.

Watchdogs:

```text
hard liveness watchdog:
  detects dead extension/tab/script

meaningful progress watchdog:
  detects no answer/thinking/progress/artifact/generation changes

phase watchdog:
  detects stuck phase, for example request.done without result pipeline
```

Required behavior if generation appears active:

```text
do not fail only because text is stable
show "generation active, no visible text changes"
```

Required behavior if only heartbeat remains:

```text
show "monitoring alive, request progress unclear"
request forced snapshot from source client
```

Required behavior if `request.done` happened but no result pipeline started:

```text
show "final response received, result pipeline did not start"
trigger result pipeline or mark recoverable_failed
```

Required forced snapshot:

```text
request current assistant snapshot from sourceClientId
read same assistantTurnKey
return answer/thinking/progress/artifacts
do not use latest global response
```

Required tests:

```text
long generation with progress does not timeout
heartbeat without meaningful progress triggers warning
request.done without result pipeline triggers pipeline watchdog
forced snapshot uses sourceClientId
forced snapshot does not use active client
```

## 13. Phase 7 — Extension-side durable request memory

Goal: make reload/restore/reconnect recoverable.

Extension background should store a request registry:

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
```

Content script should store a checkpoint in `sessionStorage`:

```text
requestId
promptHash
baselineTurnKeys
submittedUserTurnKey
assistantTurnKey
lastKnownAnswer
lastKnownVisibleProgress
lastKnownArtifacts
```

On reconnect/reload:

```text
content script reports checkpoint
background matches it to request registry
server marks request as reattached
normal finalization continues if possible
otherwise recoverable_failed with candidates
```

Required tests:

```text
content script restart reports checkpoint
resume can attach to background request without content activeRequest
restored tab can recover assistantTurnKey
closed source tab gives source_disconnected instead of silent failure
```

## 14. Phase 8 — Recovery as fallback only

Goal: make `/recover` an explicit fallback path, not the normal required path.

Required behavior:

```text
/recover list shows visible candidates with sourceClientId
/recover N creates/adopts turn
/recover N uses same result resolver as normal done
/recover N --apply uses same apply planner
/recover cannot silently use previous selected result
```

Required tests:

```text
/recover list includes source client
/recover selected artifact carries sourceClientId
/recover result replaces selected result for current project
/recover --apply applies recovered result
/recover without artifact clears current selected result or leaves it unchanged only with explicit warning
```

## 15. Updated implementation order

Recommended order:

```text
Phase 3: Normal result pipeline convergence (implemented in v35)
Phase 4: Visible intermediate progress/thinking stream
Phase 5: Selected result safety and apply guard
Phase 6: Phase-specific watchdog and forced snapshot
Phase 7: Extension-side durable request memory
Phase 8: Recovery as fallback only
```

Rationale:

The latest debug capture proves that extraction can already succeed. The highest-value fix is therefore not more DOM search, but making the already extracted `request.done` flow into result resolving, download, selected result, final summary, and apply.

## 16. Updated success criteria

A normal run with final answer and ZIP must produce:

```text
request.done
normal.pipeline.started
result/resolving
artifact.download.started
artifact.download.done
result.ready
apply.plan
apply.done or apply.waiting_confirmation
```

A normal run with final answer but no ZIP must produce:

```text
request.done
final summary printed
completed_without_artifact
selected result cleared
/apply refuses stale previous artifact
```

Visible intermediate progress must be shown as progress, not artifact:

```text
visible_thinking/progress -> interactive progress stream
actual .zip button/link -> artifact stream
```

Manual recovery must remain possible, but it must not be necessary after a normal successful `request.done`.

## v35 Phase 3 implementation note

The v34 diagnostics showed a normal ChatGPT response with final answer and ZIP artifact, but the response was recorded as a plain chat response with no local project `turnId`. The key cause was that the Ink interactive UI routed plain prompts through the plain chat path even when a project was open. That meant `requestId` was a transient chat request id, not the project turn id, so the project result resolver and apply pipeline never owned the response.

Implemented v35 behavior:

```text
plain prompt in Ink UI + open project
-> runProjectTask
-> local turn id is requestId
-> request.done is recorded under the project turn
-> normal.done.received
-> normal.pipeline.started
-> result/resolving
-> result.ready or completed_without_artifact
-> selected current turn result can be applied
```

Also implemented:

```text
new project task clears/invalidate previous in-memory selected result before waiting
/apply refuses when state.lastTurn does not match state.lastTurnId/currentTurnId
normal pipeline emits explicit normal.done.received and normal.pipeline.started events
```

## 17. Non-goals

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
allowing /apply to use a stale selected result
```
