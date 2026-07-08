# Project Task Workflow Goal

This document is the technical specification for the main project-task workflow. It defines the expected runtime process, state ownership, invariants, terminal output, artifact selection, result resolution, recovery behavior, and apply behavior.

This is not an implementation plan for a single patch. It is the process contract that future code changes and tests must satisfy.

## 1. Objective

The normal project-task workflow must complete without requiring manual `/recover` in the successful path.

When a user opens a project and runs a project task, the bridge must:

1. create a scoped local turn for the user prompt;
2. scan and package the current project snapshot as a ZIP attachment;
3. send the prompt and ZIP snapshot to the selected ChatGPT browser session;
4. track the submitted user turn in the ChatGPT DOM;
5. read the assistant response that belongs to that submitted user turn;
6. wait until the assistant response is final;
7. print the final assistant answer in the terminal UI;
8. resolve a ZIP artifact from that same assistant response only;
9. download/import/validate the ZIP artifact;
10. build a fresh apply plan against the current local project;
11. automatically apply a safe plan, or ask/skip with a clear reason when conflicts or warnings exist;
12. clearly report no-op results when the ZIP contains no changes.

`/recover` is an emergency path for lost state, browser reloads, server restarts, interrupted requests, or DOM responses that were produced but not captured by the normal flow. It must not be required in a normal successful run.

## 2. Non-goals

This document does not describe product/business behavior. It describes the technical runtime process.

This document does not require any code change by itself. It should be used as the reference contract before implementing fixes.

This document does not redefine safe ZIP application semantics. Existing safety constraints remain mandatory: path validation, ignored-file protection, local-change detection, and conflict handling.

## 3. Entities and identifiers

The workflow uses several identifiers. They must not be confused or substituted for one another.

### `projectScope`

The current local project context. It includes at least:

- project root path;
- project thread id;
- current snapshot manifest;
- selected project/session scoped state.

All result and apply state must be scoped to the active project.

### `chatSessionScope`

The active ChatGPT browser session/tab selected through the bridge. It includes at least:

- browser client id;
- ChatGPT page/session identity when available;
- selected companion connection.

All browser-visible response recovery and artifact selection must be scoped to the active browser session.

### `localTurnId`

The bridge metadata id for one user request / agent run.

For a project task, this is the main process id. Every prompt send, final answer, artifact, result file, apply plan, and apply outcome must be traceable back to this id.

### `browserRequestId`

The id sent to the browser companion for the prompt request.

For project tasks, the preferred invariant is:

```text
browserRequestId === localTurnId
```

If the implementation keeps them separate, the mapping must be explicit and bidirectional:

```text
localTurnId -> browserRequestId
browserRequestId -> localTurnId
```

### `submittedUserTurnKey`

The DOM anchor/key for the user message that was actually submitted to ChatGPT for the current request.

This is critical. Assistant response extraction must be anchored to this submitted user turn rather than to the last assistant message on the page.

### `assistantTurnKey` / `assistantTurnIndex`

The DOM anchor/key/index for the assistant response that belongs to the current submitted user turn.

The correct assistant response is the assistant turn after `submittedUserTurnKey`.

### `candidateIndex`

The visible index printed by `/recover list`, for example:

```text
/recover list
  [1] turn 29 · 267 chars · 1 artifact(s) · ...
```

`[1]` is a volatile browser-visible recovery candidate index. It is not a local turn id, not a database id, not the ChatGPT visual turn number, and not an artifact id.

### `artifactId`

The id of a browser-visible artifact candidate. By itself, it is not enough to prove that the artifact belongs to the current request. It must be associated with the current `localTurnId`, `browserRequestId`, and/or `assistantTurnKey`.

### `fileId`

The local bridge storage id after an artifact has been downloaded/imported into the bridge data directory.

### `selectedResult`

The current ZIP result selected for `/apply`.

This state must be scoped by project, browser session, and local turn. A global “last ZIP” must never be used as the default result for a new task.

## 4. Normal `/task <prompt>` workflow

### Step 1: open project

The user opens a project:

```text
/project open <path>
```

The bridge must establish or restore:

```text
projectRoot
projectThreadId
lastProjectScan / snapshot manifest
active browser session, if selected
project/session scoped result state
```

Switching project or browser session must not reuse `lastTurn`, `lastArtifacts`, `selectedResult`, or apply state from another scope.

### Step 2: start project task

The user runs:

```text
/task <prompt>
```

The bridge creates a local turn:

```text
localTurn.status = queued
localTurn.input.message = prompt
localTurn.input.output.expected = zip
localTurn.input.output.required = true
localTurn.input.cwd = projectRoot
localTurn.threadId = projectThreadId
```

From this point, this turn is the active project run.

The request id sent to the browser must either be the same id or explicitly mapped to it.

### Step 3: scan and package project

Before submitting the prompt, the bridge scans and packages the project snapshot.

The ZIP must contain the selected project files under:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

The scanner must respect ignore rules and default exclusions. It must not include `.git`, `node_modules`, build output, caches, temporary files, secrets, `.env`, local bridge data, or unrelated archives unless explicitly reviewed.

The snapshot manifest is the reference for later apply planning.

### Step 4: send prompt to ChatGPT

The bridge sends a browser companion request like:

```text
type: prompt.send
requestId: localTurnId
message: final task message
attachments: project snapshot ZIP
expectedOutput: zip
```

Before submitting, the content script records a DOM baseline:

```text
existing assistant count
existing turn keys
current session/client identity
```

After submission, the content script must identify the new submitted user turn:

```text
submittedUserTurnKey
submittedUserTurnIndex
```

If the submitted user turn cannot be identified, that is a diagnostic failure state. The implementation must not silently fall back to an older assistant response.

### Step 5: show progress

The terminal UI should show the user-visible process without excessive noise:

```text
[project] scanning <projectRoot>
[project] snapshot <id> · <file count> files · <ignored count> ignored
[project] package <snapshot.zip> · <size> · attached
[turn] started <localTurnId>
[chat] prompt delivered
[chat] prompt accepted
[chat] prompt sent
[chat] generation started
```

During generation, the UI may show thinking/answer/artifact snapshots. These snapshots are progress only and must not be treated as the final answer.

### Step 6: select the correct assistant response

The content script must read only the assistant response that belongs to the current submitted user turn.

Correct selection order:

1. find `submittedUserTurnKey` created by the current prompt;
2. find the assistant turn after that submitted user turn;
3. read thinking, answer text, and artifacts only from that assistant turn;
4. do not fallback to a pre-existing assistant turn;
5. do not collect ZIP artifacts from broad page containers that can include old responses.

If there is no assistant turn after the submitted user turn, the request is not successfully complete.

### Step 7: finish generation

A project turn is final only after a stable final response is available.

Acceptable completion signals include:

```text
generation stopped/done
+ final assistant turn exists after submittedUserTurnKey
+ final answer and/or artifact data was read from that assistant turn
+ content is stable after a final fresh read
```

On completion, the content script must do one final fresh read from the same assistant turn:

```text
finalSnapshot = readAssistantAfter(submittedUserTurnKey)
finalAnswer = finalSnapshot.answer
finalThinking = finalSnapshot.thinking
finalArtifacts = finalSnapshot.artifacts
finalAssistantTurnKey = finalSnapshot.turnKey
```

Then it sends the bridge a final event:

```text
type: done
requestId: localTurnId
answer: finalAnswer
thinking: finalThinking
artifacts: finalArtifacts
session: currentSession
submittedUserTurnKey: submittedUserTurnKey
assistantTurnKey: finalAssistantTurnKey
assistantTurnIndex: finalSnapshot.turnIndex
```

Required invariant:

```text
done.requestId === active localTurnId
done.assistantTurnKey belongs to the assistant turn after submittedUserTurnKey
```

For project tasks where ZIP output is required, a `done` event with no answer and no artifact is not a successful completion. It is a recoverable failure with a clear diagnostic.

### Step 8: persist and print final answer

After `done`, `TurnManager` must persist:

```text
reasoning item = final thinking
agent_message item = final answer
artifact items = final artifacts
```

The turn should then contain:

```text
status = completed or final_response_ready
output.answer = final answer
output.artifacts = final artifacts
```

The terminal UI must print the final assistant answer after completion. It must not stop at intermediate thinking/progress snapshots.

If the final answer is empty, the UI must explicitly say so:

```text
[result] ChatGPT finished, but final answer text was empty.
```

An empty final answer is a warning/error condition, not silent success.

### Step 9: resolve ZIP artifact from the current response

After the final answer is available, the bridge resolves the ZIP artifact only from the current assistant response.

Artifact selection priority:

1. artifact with `requestId === localTurnId`;
2. artifact with `sourceTurnKey === finalAssistantTurnKey`;
3. artifact with current recovered/response candidate index, when in recovery mode;
4. artifact with ZIP-like name or MIME type;
5. if multiple candidates remain, select the best-scored candidate and log why it was selected.

The bridge must never use an old globally cached ZIP when the current response did not expose a matching ZIP.

If a ZIP is expected but no matching ZIP exists:

```text
[result] expected ZIP artifact, but current ChatGPT response did not expose one.
[result] no artifact selected for /apply.
```

The previous selected result must be cleared or ignored for this scope. A new failed result must not leave an old ZIP selected.

### Step 10: download, import, and validate ZIP

After selecting the artifact, the bridge downloads it.

For artifact action buttons, the extension must click the button inside the current assistant turn only. It must not click a similarly named button from an older response.

After download, Node imports the file into bridge-managed storage and records:

```text
fileId
artifactId
localTurnId
requestId
sourceTurnKey
sha256
size
name
stored path
```

The ZIP must be validated before it becomes applyable:

```text
valid ZIP structure
no path traversal
no absolute paths
no unsafe symlinks
entry count and size limits are acceptable
expected project layout is present or safely understood
```

Only after validation can this ZIP become the current selected result.

### Step 11: report result state

Successful result resolution should be visible in the terminal:

```text
[result] final answer received · <chars> chars
[result] selected artifact: <name/id> · source <assistantTurnKey>
[artifact] downloading <name>
[artifact] downloaded <fileId> · <size> · <path>
[result] validated zip · <entry count> entries
[result] selected for apply: <localTurnId> / <fileId>
```

If no ZIP is found:

```text
[result] no ZIP artifact found for current turn
[result] previous selected result was not reused
```

If the ZIP is invalid:

```text
[result] ZIP artifact downloaded but failed validation: <reason>
[result] nothing selected for apply
```

### Step 12: build apply plan

After a valid current ZIP result exists, the bridge must build a fresh apply plan automatically.

The apply plan must compare the result ZIP with the current local project and the original snapshot manifest. It must classify at least:

```text
filesToCreate
filesToUpdate
filesToDelete
filesUnchanged
filesSkipped
locallyChangedUpdates
locallyChangedDeletes
safetyWarnings
```

`lastAppliedTurnId` and `lastAppliedFileId` may be used for logs/diagnostics only. They must not skip planning.

The source of truth is the fresh apply plan.

### Step 13: apply decision

If the ZIP exists but the fresh apply plan is empty:

```text
[apply] ZIP contains no changes relative to current project.
```

If the plan has changes and no conflicts/safety warnings:

```text
[apply] safe plan detected; applying automatically.
[apply] wrote <N> file(s), deleted <M> file(s)
```

If there are local conflicts, unsafe entries, skipped critical files, or other warnings:

```text
[apply] conflicts/warnings detected
[apply] automatic apply skipped: <reason>
[apply] use /apply --interactive or /apply --force
```

Auto-apply is allowed only for a safe plan.

## 5. Required state machine

Project turns should move through explicit states. The exact enum names may differ, but the process must be representable as:

```text
queued
packing_project
sending_prompt
prompt_sent
generating
finalizing_response
resolving_result
result_ready
planning_apply
waiting_apply_confirmation
applying
completed
completed_no_changes
completed_without_artifact
failed
recoverable_failed
```

Important rule: for project tasks requiring ZIP output, `completed` must not be reached merely because text was received. Successful completion requires:

```text
final answer received
+ current ZIP artifact resolved
+ ZIP downloaded/imported/validated
+ apply-plan handled
```

If a final answer exists but no ZIP exists, the turn should be `completed_without_artifact` or another explicit non-success state.

If a ZIP exists but apply is skipped due to conflicts, the state should remain `result_ready` or `waiting_apply_confirmation`, not generic success.

## 6. Expected terminal output examples

### Successful safe auto-apply

```text
[project] scanning /path/to/project
[project] snapshot abc123 · 184 files · 12 ignored
[project] package project-snapshot.zip · 220 KB · attached
[turn] started turn_xxx
[chat] prompt delivered
[chat] prompt accepted
[chat] prompt sent
[chat] generation started

<thinking/answer progress, if available>

[chat] generation stopped
[turn] final answer received · 846 chars

<final ChatGPT answer>

[result] resolving zip
[result] selected artifact: chatgpt-bridge-fixed-v26.zip · source turn_abc · artifact action_xxx
[artifact] downloading chatgpt-bridge-fixed-v26.zip
[artifact] downloaded file_yyy · 241 KB · ~/.bridge-data/artifacts/...
[result] validated zip · 37 entries
[result] selected for apply: turn_xxx / file_yyy

[apply] planning against /path/to/project
[apply] +2 create, ~5 update, -0 delete, =180 unchanged
[apply] safe plan detected; applying automatically
[apply] wrote 7 file(s), deleted 0 file(s)
```

### No changes

```text
[result] selected for apply: turn_xxx / file_yyy
[apply] planning against /path/to/project
[apply] +0 create, ~0 update, -0 delete, =187 unchanged
[apply] ZIP contains no changes relative to current project.
```

### Conflicts

```text
[apply] planning against /path/to/project
[apply] !2 locally changed update conflict(s)
[apply] automatic apply skipped: local changes would be overwritten
[apply] use /apply --interactive to choose changes, or /apply --force to apply the whole ZIP.
```

### Missing artifact

```text
[turn] final answer received · 612 chars

<final ChatGPT answer>

[result] expected ZIP artifact, but current response did not expose a ZIP.
[result] no result selected for /apply.
[result] use /recover list if the browser visibly contains a downloadable artifact.
```

## 7. Recovery flow

Recovery is an emergency path. It must reuse the same result/apply pipeline after it attaches a visible browser response to local state.

### `/recover list`

`/recover list` reads visible assistant responses from the active ChatGPT tab and prints volatile candidate indexes:

```text
/recover list
  [1] turn 29 · 267 chars · 1 artifact(s) · ...
  [2] turn 28 · 1034 chars · 1 artifact(s) · ...
```

The displayed `[n]` is `candidateIndex`.

This command is read-only for apply state. It must not select a ZIP, change `selectedResult`, or reuse a previous artifact.

### `/recover <n>`

`/recover <n>` must:

1. interpret `<n>` as `candidateIndex`;
2. read that visible assistant response from the active browser session;
3. attach it to the current project/session scope;
4. create an adopted local recovery turn if no suitable local turn exists;
5. store final answer, thinking, and artifacts as turn items;
6. resolve/download/validate ZIP artifacts only from that recovered candidate;
7. select the recovered ZIP result for apply only if the candidate provided a valid ZIP.

A missing local turn is not enough reason to fail when the browser returned a visible candidate. The implementation must use the adopted recovery turn path.

### `/recover <n> --apply`

This must run the full `/recover <n>` flow first, then use the same apply planning and safety logic as normal project task results.

It must not apply a previously selected ZIP if the current recovered candidate did not provide a ZIP.

## 8. `/apply` flow

`/apply` without a path applies the current selected ZIP result from the current project/session scope only.

`/apply /path/to/result.zip` applies the explicitly supplied local ZIP, but through the same validation, planning, conflict detection, and safety logic.

Every `/apply` invocation must build a fresh apply plan against the current project tree. A previous `lastAppliedTurnId` or `lastAppliedFileId` must not skip planning.

A result can be skipped only when:

```text
the fresh plan is empty
or the user cancels
or safety rules block automatic apply
```

## 9. Core invariants

1. One project prompt-run maps to one local turn and one browser request.
2. The final assistant answer must be printed after every completed project task.
3. Assistant extraction must be anchored to the submitted user turn.
4. Artifacts must be selected only from the current assistant response.
5. A failed/missing current ZIP must not leave an old ZIP selected.
6. `/task`, `/resume`, `/recover --apply`, and `/apply` must converge into one shared result/apply pipeline.
7. `/recover` must not be necessary in the normal successful workflow.
8. `/apply` must always build a fresh plan.
9. Auto-apply is allowed only for safe plans without conflicts or warnings.
10. No-change results must be reported explicitly.
11. Project/session scope boundaries must prevent cross-project or cross-tab result reuse.

## 10. Required regression coverage

The next implementation step should add scenario-level tests, not only isolated helper tests.

Minimum coverage:

```text
1. /task receives final done and prints the final assistant answer.
2. /task selects a ZIP artifact with matching requestId or assistantTurnKey.
3. /task does not select an old ZIP when the DOM contains an old artifact and the new response has no ZIP.
4. /task clears or ignores previous selected result when required ZIP is missing.
5. /task downloads/imports/validates the ZIP and stores fileId in turn output.
6. /task builds an apply plan after result_ready.
7. /task auto-applies a safe plan.
8. /task does not auto-apply a conflicting plan and prints a follow-up command.
9. /task with an empty plan prints a no-changes message.
10. /resume uses the same final result/apply pipeline as /task.
11. /recover 1 uses candidateIndex, not local turn id.
12. /recover 1 --apply uses the recovered ZIP, not a previous selected ZIP.
13. /apply always replans against the current project state.
14. Switching project/session does not reuse selected results from another scope.
```

## 11. Current suspected failure areas

When the user sees initial answer/progress but not the final summary after ChatGPT finishes, inspect the full final-answer path:

```text
content.js request finalization
TampermonkeyBridge finish/done handling
TurnManager turn/item persistence
answerTextFromTurnItems
waitForTurn / project task orchestration
consoleStream.finish
Ink transcript rendering
```

When a ZIP downloads but appears to belong to an older prompt, inspect artifact identity and scoping:

```text
content.js readAssistantSnapshot
content.js artifact collection inside assistant node
artifact action discovery and click target scoping
TampermonkeyBridge artifact registry/cache
ResultResolver ZIP selection
artifact.fetch / materializeArtifactAction
interactive selected result state
```

The main risk is any fallback that reads “latest assistant response” or “latest ZIP artifact” globally instead of the response after the current submitted user turn.

## 12. Implementation direction for the next step

Before changing feature behavior, align the code around one shared pipeline:

```text
run prompt
-> receive final answer
-> print final answer
-> resolve current artifact
-> download/import/validate
-> select current result
-> build fresh apply plan
-> auto-apply or ask/skip/warn
```

Do not continue fixing `/recover`, `/apply`, artifact download, or terminal rendering as unrelated local problems. The current bugs are likely caused by broken boundaries between these stages.

The success criterion is simple: after a normal project task, the user should not need to guess which `/recover <n>` or `/apply` command to run. The normal workflow must reach a clear final state by itself.
