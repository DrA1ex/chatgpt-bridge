# Workflow UX

ChatGPT Browser Bridge provides an interactive workflow wizard for project tasks that need repeated ChatGPT turns, returned files, local checks, and controlled Git commits.

The only workflow command a user needs to remember is:

```text
/workflow
```

`/workflow wizard` is an explicit alias for the same context-sensitive wizard. In command completion, the bare `/workflow` action is shown by itself; targeted views appear only after typing `/workflow ` with a trailing space.

Nothing starts automatically when Bridge opens. Ordinary interactive prompts, `/ask`, `/resume`, `/apply`, `/recover`, tab selection, and artifact handling keep their existing behavior until the user explicitly starts or resumes a workflow.

## Workflow presets

The wizard exposes three goals.

### Apply changes from ChatGPT

Bridge mirrors only the newly active browser turn: the current user prompt, visible reasoning, and the full assistant answer. Existing chat history is baselined and is not imported. Browser-origin prompts are written only to the transcript; they never replace or modify the local prompt editor. Streaming snapshots update stable entries instead of creating duplicates, and the next browser turn replaces the previous mirrored turn.

Bridge watches the selected ChatGPT chat for valid result packages. It downloads, validates, optionally reviews, applies, checks, and commits workflow-owned changes, then returns to watching the chat.

### Fix the project until checks pass

Bridge runs the selected project checks. When they fail, it builds a structured failure report, sends the report to ChatGPT, validates and applies the returned files, creates an iteration checkpoint according to policy, and runs the checks again. Repeated identical failures trigger a user decision instead of an unlimited loop.

### Work through a task

Normal text entered in the interactive prompt is routed through the focused workflow. Bridge manages chat setup, project synchronization, attachments, returned files, optional checks, and commits. Text-only ChatGPT responses are valid in this mode.

## Starting a workflow

Run Bridge from the project directory:

```bash
bridge
```

Then enter:

```text
/workflow
```

For a new workflow, the wizard asks for at most five normal decisions:

1. The goal.
2. The ChatGPT chat: current tab, new chat, or another open tab.
3. The project directory.
4. Suggested or custom project checks.
5. A final summary before starting.

Bridge detects likely checks from `package.json`, Python project files, `Cargo.toml`, `go.mod`, `Makefile`, `composer.json`, workspace configuration, and an existing Bridge workflow configuration. Every detected item shows both a friendly label and the exact command.

Space toggles multi-select choices. Esc or Alt+Left returns to the previous wizard step while preserving all current selections and typed values.

For **Apply changes from ChatGPT**, pressing Enter on the final summary enables passive observation immediately. The UI may describe this as “watching ChatGPT”, but it is a subscription on the same workflow v3 lifecycle rather than a separate watcher state. No separate `/workflow run` command is required. Continue writing in the selected ChatGPT browser tab. As soon as a new browser prompt appears, Bridge uses the shared `TabObservation` stream to show that prompt, visible reasoning, and the full answer. If observation is paused, open `/workflow` and choose **Start watching this ChatGPT tab**.

When a compatible tab connects or a workflow is loaded, Bridge reads the currently selected ChatGPT model and reasoning effort and shows them in the header and context panels. Model and effort preferences are stored per project and in workflow profiles. If the active effort differs from the running workflow's saved effort, Bridge immediately switches the ChatGPT picker and verifies the resulting state before continuing. `/effort auto` is stored as an explicit preference; `/effort default` clears the preference.
If an individual model/effort command times out while the workflow-owned tab remains connected, the interactive runtime keeps retrying and shows a waiting status instead of turning the live workflow into an error.

When workflows already exist, Bridge opens that continuation view once during interactive startup, without starting a stopped workflow on the user's behalf. Project selection prefers an explicit `--project`, then the selected workflow's saved project root, then the directory where Bridge was launched. `/workflow` opens the same context-sensitive menu for continuing, viewing attention states, starting another workflow, changing settings, pausing or stopping, and editing global defaults. When a workflow needs a decision, `/workflow` opens that decision directly.

## Global workflow configuration

The first workflow uses recommended defaults and lets the user customize session recovery, commit behavior, and notifications. The settings are stored in a formatted, human-editable JSON file:

```text
~/.bridge-data/workflows/config.json
```

The wizard can show this path and reload the file after manual changes. JSON comments are not supported. Unknown fields are preserved, while invalid known values fail with the exact JSON path.

The default shape is:

```json
{
  "version": 1,
  "defaults": {
    "sessionExhaustion": "start-new-chat",
    "invalidResponseAction": "repair",
    "invalidResponseAttempts": 2,
    "notifications": {
      "enabled": true,
      "terminalBell": true,
      "desktop": true,
      "reminderIntervalMs": 900000
    },
    "commits": {
      "mode": "automatic",
      "iterationStrategy": "checkpoint",
      "completionStrategy": "squash",
      "includeOnlyWorkflowChanges": true
    },
    "checks": {
      "maxAttempts": 8,
      "noProgressLimit": 3
    }
  },
  "profiles": {}
}
```

Saved profiles and per-workflow settings override these defaults.

## Status and attention

The workflow panel uses plain-language states such as:

```text
Preparing ChatGPT
Waiting for ChatGPT
Refreshing the project context
Running project checks
Preparing a failure report
Downloading returned files
Checking returned files
Applying changes
Saving a checkpoint
Waiting for your decision
Starting a new ChatGPT chat
Squashing commits
Paused
Completed
Stopped
```

A workflow that needs input keeps a persistent attention state. The available actions are shown immediately, and entering `/workflow` reopens the same action list. Internal observer, pipeline, approval, and worker identifiers remain debug-only.

Bridge notifies for decisions, conflicts, retry exhaustion, session exhaustion, completion, and terminal errors through layered best-effort mechanisms:

1. A terminal bell when the output is interactive and bell notifications are enabled.
2. A persistent in-terminal attention banner.
3. A native desktop notification when available: `osascript` on macOS, `notify-send` on Linux, or a PowerShell toast on Windows.

Desktop notification failures never fail the workflow. Stable attention keys prevent repeated polling from producing duplicate notifications; a reminder may be emitted after the configured interval.

## Chat setup and recovery

A new workflow chat receives two separate attachments:

```text
project.zip
bridge-workflow-instructions.md
```

The instruction file is never inserted into the project archive and is never applied to the project. Bridge sends a short readiness prompt and waits for ChatGPT to acknowledge the setup.

For an existing chat, the default is quiet attachment: Bridge uses the existing context and sends workflow instructions only when needed. The wizard can explicitly send the instructions immediately.

Bridge recognizes common context-window and unusable-chat failures. The configured session policy can:

- start a new chat automatically;
- ask before starting a new chat;
- stop the workflow.

Automatic recovery creates a fresh project archive, attaches the workflow instructions, and sends a concise handoff containing the original goal, current attempt, failing checks, and useful conclusions. The newly attached project becomes the only current source of truth.

## Project context synchronization

Bridge stores a per-chat fingerprint of the project snapshot last uploaded to ChatGPT. The fingerprint covers included relative paths, file sizes, content hashes, configuration metadata, and available Git/worktree baseline information. It does not rely only on Git HEAD, so uncommitted changes are detected.

Before a workflow request:

- an unchanged project sends only the prompt and incremental artifacts;
- a changed project creates and uploads a fresh complete archive, tells ChatGPT that the previous snapshot is obsolete, and records the new remote-context fingerprint.

Excluded build outputs, caches, runtime state, temporary reports, and other configured transient files do not cause a refresh. Applied changes returned by the same chat are recorded as already known to that chat.

## Result package protocol

A result archive intended for automatic application must include:

```text
bridge-result.json
```

Example:

```json
{
  "version": 1,
  "status": "changed",
  "summary": "Fixed workflow response handling",
  "commitMessage": "Fix workflow response handling",
  "files": [
    "src/workflow/handler.js",
    "test/workflowHandler.test.js"
  ]
}
```

Bridge validates archive integrity, the manifest schema, workflow/project identity when available, safe relative paths, non-empty changes, duplicate results, complete-file output, commit-message policy, and package-lock registry safety. The optional manifest `files` list is reconciled for diagnostics, while the transactional project diff determines what is actually applied; unchanged listed files are ignored.
The project-root `.gitignore` is protected from sync deletion even when a returned archive omits it. A retryable artifact preview or materialization timeout leaves the passive observation subscription enabled for another result instead of creating a sticky `Waiting for your decision` state; stale persisted materialization attention is cleared during restore.

Patch and diff files are rejected. `bridge-result.json` and `.bridge/*` are control metadata: Bridge validates them but never writes them into the project.

When a recoverable result is invalid, Bridge sends a concise correction request automatically. The default is two repair attempts. Reaching the limit creates an attention state with actions to resend instructions, review or ignore the response, or stop. Internal correction, remediation, context-sync, session-recovery, and commit-message requests inherit the workflow's configured effort; `auto` leaves the tab's current effort unchanged rather than forcing `instant`.

## Safe application and Git commits

Bridge records the starting worktree state and tracks the exact files modified by the workflow. It never uses `git add -A` for workflow commits.

Unrelated pre-existing or concurrent user changes remain untouched. When both the user and the workflow modify the same file incompatibly, Bridge stops before application and shows conflict actions.

Commit modes are:

```text
automatic
ask
disabled
```

Iterative strategies are:

```text
checkpoint
final-only
```

Completion strategies are:

```text
squash
keep-checkpoints
```

The default fix loop creates workflow-owned checkpoint commits and squashes them into one final commit after all checks pass. Squashing is refused when unrelated commits appeared in the checkpoint range, leaving recoverable checkpoint state. The final message prefers the latest valid `commitMessage` from ChatGPT and falls back to a concise task/file summary.

No workflow operation pushes commits.

## Pause, resume, stop, and completion

The `/workflow` menu contains the relevant controls; separate commands are not required.

Pausing preserves the active run and its chat binding. Bridge refuses an unsafe pause during the actual file-application critical section. Resume continues the saved run. Stop first records a durable stop request, prevents new effects, and cancels only work proved not started or explicitly cancellable. A dispatched or uncertain browser/local write must settle or roll back before the lifecycle becomes `stopped`; restoration actions are offered when rollback state exists.

On completion, the workflow panel reports checks, changed files, and the final commit, then offers to return to normal interactive mode, inspect details, or start another workflow.

## Advanced and non-interactive compatibility

The existing workflow engine and configuration remain available for automation and development use:

```bash
bridge workflow init
bridge workflow validate
bridge workflow run
bridge workflow serve
```

Legacy saved workflows are loaded through the same runner and mapped to the new user-facing states where possible. These commands are advanced interfaces; interactive users should start with `/workflow`.

An independent workflow worker can still use the primary bridge as the browser observation and artifact source:

```bash
npm run workflow:worker -- \
  --port 8091 \
  --workflow ./bridge.workflow.json \
  --data-dir ./.bridge-data/workflow-worker
```

Only the primary bridge owns the browser WebSocket. The worker keeps its own file store and workflow manager and consumes observed turns and artifacts from the primary process. The stream identity includes an upstream epoch and sequence; the worker persists its cursor only after durable workflow enqueue. A primary restart changes the epoch, and a cursor older than retained history produces a typed `stream.gap` instead of silently losing turns.

## Testing

The repository includes unit, integration, rendering, Git, and mock-browser workflow coverage, together with the existing real-browser workflow harness. Local regression tests cover the shared services and user states used by all three presets, including result repair, local project changes, session recovery, commit ownership, checkpoint squash, and pause/resume/stop behavior. Authenticated release-matrix execution and the remaining policy questions are recorded in [Workflow UX Open Questions](WORKFLOW_UX_OPEN_QUESTIONS.md).

Run the complete local suite with:

```bash
npm run check
npm test
```
