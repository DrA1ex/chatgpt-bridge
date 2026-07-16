# Artifact Workflows

ChatGPT Browser Bridge can watch an already-open ChatGPT conversation without sending the original prompt itself. A workflow can also run an integrated local validation-and-repair loop that creates its own ChatGPT turns, applies returned project archives through the same transactional pipeline, and validates again. This supports a workflow where a prompt is written from the mobile app, desktop app, or another browser, while a local daemon receives the completed assistant turn from a monitored web tab.

The workflow pipeline is:

1. Observe a new terminal assistant turn.
2. Discover artifacts scoped to that exact turn.
3. Download a candidate through the existing fail-closed artifact materializer.
4. Validate the ZIP structure and project identity.
5. Optionally wait for approval.
6. Build an apply plan and enforce project policy.
7. Apply into the project transactionally.
8. Run configured validation commands.
9. Roll back on failure and optionally send the validation output back to ChatGPT.
10. Process the replacement artifact through the same pipeline.
11. Optionally create a local Git commit.
12. Optionally deploy and reload the unpacked browser extension.
13. Optionally request a supervisor-managed daemon restart after the terminal state is persisted.
14. Return to the watching state.

No workflow command pushes Git commits.

The passive observer uses the same terminal-completion policy as ordinary bridge requests. A stable final answer or ready artifact is sufficient after generation settles; the ChatGPT response action bar is supporting evidence, not a requirement. When the bridge submits a passive workflow prompt itself, every pre-existing assistant turn is baselined before submission so only the new request-owned turn can enter the pipeline.

## Create and validate a workflow

Create a configuration in the project root:

```bash
cd /path/to/project
bridge workflow init
bridge workflow validate
```

`init` creates `bridge.workflow.json`. `validate` resolves paths, normalizes policies, and fails before the bridge starts when a command or policy is invalid.

The configuration describes behavior only. It does not contain the current run, the previous run's ChatGPT thread, or a hidden runtime session binding.

For this repository, `bridge.workflow.example.json` is a complete example. The extension target is left empty, so a successful self-update replaces the files under `tools/chrome-bridge-extension` and reloads the unpacked extension in place.

## User workflow

Start the interactive UI from the project root:

```bash
bridge
```

Then select the ChatGPT conversation for the next run and inspect the dashboard:

```text
/session new
/workflow
/workflow run
```

A fresh run binds to the current session once. That binding is immutable for the life of the run. Running `/session new` while a workflow is active changes only the next run; the active run continues in its original conversation.

The ordinary user-visible states are:

```text
Idle
Running validation
Waiting for ChatGPT
Waiting for approval
Applying changes
Validating result
Succeeded
Failed
Stopped
Interrupted
```

The browser observer is an internal workflow component. There are no normal commands for starting or stopping it. The workflow activates the required observation when it sends a repair turn, restores it after extension reconnects, and releases the binding when the run terminates.

When approval is required, use:

```text
/workflow approve
/workflow reject --reason "reason"
```

Approval and pipeline IDs are not required when one workflow has one pending decision.

If the daemon stopped during a run and `restartPolicy` is `ask`, the dashboard reports `Interrupted`. It does not silently continue an old conversation:

```text
/workflow resume
/workflow discard
```

`resume` keeps the exact run and its bound session. `discard` terminates the saved run, after which `/workflow run` creates a fresh run using the current session.

## Non-interactive operation

Run one validation/repair cycle without the Ink UI:

```bash
bridge workflow run
```

The process exits with status `0` after successful validation, `1` after a workflow failure, and `130` after an operator interruption. Optional overrides include:

```bash
bridge workflow run --session current
bridge workflow run --session new
bridge workflow run --session c/example
bridge workflow run --max-cycles 3
bridge workflow run --approve always
bridge workflow run --approve never
bridge workflow run --verbose
```

Keep the bridge and automatic passive workflow processing alive without a TUI:

```bash
bridge workflow serve
```

`bridge workflow watch` remains a compatibility alias for `serve`.

`Ctrl+C` exits immediately while the process is idle or only waiting for ChatGPT/approval. A remotely waiting run is preserved as interrupted and can be continued with `bridge workflow resume` or `/workflow resume`; the browser prompt is not cancelled. If a local command, verification, apply, rollback, extension update, or restart action is active, the CLI asks whether to stop the run before exiting. A second `Ctrl+C` forces termination.

## Integrated validation and repair automation

A workflow can run the complete cycle inside `WorkflowManager`:

1. Execute configured local steps.
2. Preserve complete stdout and stderr in a compressed diagnostics bundle.
3. Complete immediately when every step passes.
4. On failure, send the current project snapshot and diagnostics to the run-bound ChatGPT session.
5. Require one complete project ZIP.
6. Verify, plan, approve when needed, apply, roll back, commit, update the extension, and restart through the existing pipeline.
7. Execute the local steps again until they pass or `maxCycles` is exhausted.

The steps are language-independent shell commands. Each step may define its own working directory, environment, timeout, and failure policy:

```json
{
  "automation": {
    "enabled": true,
    "trigger": "manual",
    "restartPolicy": "ask",
    "session": {
      "policy": "current"
    },
    "maxCycles": 5,
    "continueAfterFailure": true,
    "stepTimeoutMs": 7200000,
    "steps": [
      {
        "name": "Unit and integration tests",
        "command": "npm test",
        "cwd": ".",
        "timeoutMs": 7200000,
        "continueOnFailure": true
      },
      {
        "name": "Real browser E2E",
        "command": "npm run test:e2e:real -- --report-dir \"$WORKFLOW_REPORT_DIR/e2e\"",
        "cwd": ".",
        "timeoutMs": 7200000,
        "continueOnFailure": true
      }
    ],
    "turn": {
      "timeoutMs": 7200000,
      "pollIntervalMs": 1000,
      "approvalTimeoutMs": 86400000,
      "model": "",
      "effort": "high",
      "sourceClientId": ""
    },
    "diagnostics": {
      "reportDir": ".bridge-data/workflow-runs",
      "keepReports": 5,
      "include": [],
      "maxIncludedBytes": 536870912
    },
    "project": {
      "mode": "package",
      "useGitignore": true,
      "snapshotPolicy": "always",
      "force": true
    },
    "onFailure": {
      "action": "chatgpt-repair",
      "prompt": "",
      "attachProject": true,
      "attachDiagnostics": true,
      "applyResult": true,
      "output": { "expected": "zip", "required": true }
    }
  }
}
```

Session policies:

- `current`: bind a fresh run to the interactive/current browser session at start time.
- `new`: create a new ChatGPT conversation for every fresh run.
- `pinned`: always use `automation.session.id`.

Restart policies:

- `ask`: restore the run as `Interrupted` and require `resume` or `discard`. This is the default.
- `auto`: resume the persisted run automatically.
- `discard`: terminate the persisted run during startup.

Legacy `automation.turn.sessionId` and `automation.resumeOnRestart` are accepted and migrated in memory, but new configurations should use `automation.session` and `automation.restartPolicy`.

Every step receives:

```text
WORKFLOW_ID
WORKFLOW_CONFIG
WORKFLOW_PROJECT_ROOT
WORKFLOW_AUTOMATION_ID
WORKFLOW_AUTOMATION_CYCLE
WORKFLOW_REPORT_DIR
```

Direct test output into `WORKFLOW_REPORT_DIR` when possible. `diagnostics.include` may additionally name files or directories below the project root. Missing paths are recorded; symlinks and paths outside the project root are rejected. Complete step logs are always archived. `--verbose` changes only live rendering.

`/workflow stop` and `Ctrl+C` during a confirmed shutdown terminate the complete local process group and cancel an active repair turn. Complete stdout and stderr are flushed before diagnostics are finalized.

When `onFailure.applyResult` is true, `onFailure.output.expected` must be `zip`, and `watch.mode` cannot be `verify` because a verify-only pipeline cannot change the project before the next validation cycle.

## Stable project identity and context sync

Every managed project receives a stable identity file:

```text
.bridge/PROJECT_ID.json
```

The identifier is a generated UUID and is not derived from the absolute local path. Project snapshots created by the bridge always include this file, together with `.bridge/PROJECT_FINGERPRINT.json`. ChatGPT is instructed to preserve the identity unchanged in every complete project ZIP.

Workflow context synchronization is enabled independently of `verify`, `ask`, or `auto` mode. When a workflow already has a conversation binding, the daemon uploads a small project-context ZIP at startup. When it binds on the first verified artifact, it uploads the context immediately after binding. The context contains the identity, the current fingerprint, and a bounded set of configured fallback files.

```json
{
  "projectContext": {
    "enabled": true,
    "mode": "identity",
    "syncOnStart": true,
    "syncAfterBind": true,
    "fallbackFiles": [
      "package.json",
      "AGENT.MD",
      "README.md"
    ],
    "maxBytes": 2097152
  }
}
```

Verification uses the exact project UUID when the archive contains it. A mismatched UUID always rejects the archive. For older artifacts without the identity file, verification requires at least one configured fallback file to be comparable and unchanged, in addition to package-name, required-file, and project-overlap checks. Set `verification.requireProjectIdentity` to `true` to reject all identity-less archives.

## Watching a conversation

The content runtime watches terminal assistant turns in open ChatGPT tabs. Existing turns are baselined when observation starts and are not processed again. A newly completed turn is emitted even when the original prompt was sent from another device.

ChatGPT normally updates an open conversation through its own live connection. If a browser tab does not reliably receive remote changes, set a refresh interval:

```json
{
  "watch": {
    "bindOnFirstVerifiedArtifact": true,
    "refreshIntervalMs": 300000
  }
}
```

Positive refresh intervals are clamped to at least 30 seconds. A refresh retains the per-session emitted-turn baseline in `sessionStorage`, so already processed turns are not replayed.

For predictable routing, bind a workflow to a conversation and optionally a browser client:

```json
{
  "watch": {
    "sessionId": "conversation-session-id",
    "clientId": "extension-client-id"
  }
}
```

An empty value initially accepts an observed tab. With `bindOnFirstVerifiedArtifact` enabled (the default), the workflow persists the client and conversation that produced the first successfully verified project artifact and ignores later turns from other tabs or conversations. The bound client is also used for periodic refresh and extension reload. Set explicit IDs when the binding must be fixed before the first artifact arrives.

## Workflow modes

`watch.mode` controls what happens after verification:

- `off`: keep the configuration loaded without processing artifacts.
- `verify`: download and verify, but never apply.
- `ask`: create a persistent approval after verification and planning.
- `auto`: apply automatically when verification and policy checks pass. Policy warnings still downgrade the artifact to approval.

`ask` is the default when the mode is omitted.

## Artifact verification

A candidate is selected only from the current assistant turn. A filename is not required: a single scoped generic download action can be materialized and then byte-validated as ZIP. Clearly named non-ZIP files are not treated as project archives.

Verification includes:

- ZIP signature and central-directory validation;
- path traversal and archive safety checks from the existing ZIP layer;
- entry, compressed-size, and extracted-size limits;
- extraction into an isolated staging directory;
- required root files;
- `package.json` project name;
- overlap with the current project tree;
- optional commands executed inside staging.

A verified artifact is keyed by SHA-256 per project. DOM remounts, repeated buttons, daemon restarts, and duplicate turns do not reapply the same archive.

Example:

```json
{
  "artifact": {
    "expected": "zip",
    "requireSingleCandidate": true,
    "maxBytes": 524288000,
    "maxEntries": 50000,
    "maxExtractedBytes": 2147483648
  },
  "verification": {
    "requiredFiles": [
      "package.json",
      "src/index.js"
    ],
    "packageName": "chatgpt-browser-bridge-node",
    "minProjectFileOverlap": 0.15,
    "commands": [],
    "requireProjectIdentity": false,
    "identityFallbackFiles": [
      "package.json",
      "AGENT.MD",
      "README.md"
    ]
  }
}
```

## Apply policy and rollback

The archive is never extracted directly over the project during verification. After a plan passes policy, the applier snapshots every file that can be changed or deleted. Post-apply commands run only after the file operation completes.

If a command fails, the snapshot is restored before remediation starts.

```json
{
  "apply": {
    "sync": true,
    "requireCleanGit": false,
    "rollbackOnFailure": true,
    "protectedPaths": [
      ".git/**",
      ".env*",
      ".bridge-data/**",
      "node_modules/**"
    ],
    "allowedWarningCodes": [
      "NO_REFERENCE_MANIFEST_FOR_SYNC"
    ],
    "maxChangedFiles": 2000,
    "maxDeletedFiles": 200,
    "commands": [
      "npm test",
      "npm run check"
    ],
    "timeoutMs": 1200000
  }
}
```

A missing Git repository is non-blocking when `requireCleanGit` is false. Local-change, protected-path, excessive-change, and excessive-delete warnings require approval in auto mode.

## Remediation loop

When a post-apply command fails and rollback succeeds, the daemon can send a bounded console excerpt back to the same conversation:

```json
{
  "remediation": {
    "enabled": true,
    "maxAttempts": 2,
    "sameChat": true,
    "outputTailLines": 250,
    "prompt": ""
  }
}
```

The generated prompt contains exact `VALIDATION_OUTPUT_BEGIN` and `VALIDATION_OUTPUT_END` boundaries and requests another complete project ZIP. The replacement archive is downloaded, verified, planned, applied, and tested through the same rules.

Set `sameChat` to `false` to create a new remediation session instead. The default is the original conversation because it contains the implementation context.

## Git commit modes

Commits are local only. Supported modes:

- `none`: never commit.
- `block`: use a commit block already present in the artifact-producing answer.
- `same-chat`: after tests pass, ask the same conversation for a marked commit message.
- `new-chat`: attach a bounded Git status/diff context to a temporary new conversation, parse its marked response, delete the temporary conversation, and commit.

Configuration:

```json
{
  "commit": {
    "mode": "block",
    "required": false,
    "beginMarker": "COMMIT_MESSAGE_BEGIN",
    "endMarker": "COMMIT_MESSAGE_END",
    "style": "detailed",
    "maxContextBytes": 2097152,
    "authorName": "",
    "authorEmail": ""
  }
}
```

For `block` mode, instruct ChatGPT to include:

```text
COMMIT_MESSAGE_BEGIN
Implement passive artifact workflows

Add verification, transactional application, remediation, and extension reload support.
COMMIT_MESSAGE_END
```

If the block is absent and `required` is false, the workflow succeeds without a commit. If `required` is true, the already-validated project remains applied, the commit step is reported as failed, and the workflow completes with a warning. A commit failure never triggers a misleading replacement-ZIP remediation cycle.

## Automatic unpacked-extension updates

For a self-updating project, Chrome may keep loading the extension directly from the project directory:

```json
{
  "extensionUpdate": {
    "enabled": true,
    "sourceDir": "tools/chrome-bridge-extension",
    "targetDir": "",
    "reloadTabs": true,
    "reconnectTimeoutMs": 20000,
    "backupRetention": 5,
    "rollbackOnReloadFailure": true
  }
}
```

Set `targetDir` to an external stable directory when the project path is not stable. That choice requires one initial **Load unpacked** action, but no repeated removal or re-adding.

Before project files are changed, the daemon archives the currently installed extension directory under:

```text
~/.bridge-data/workflows/<workflow-id>/extension-backups/
```

The backup is ZIP-validated and retained according to `backupRetention`. An external stable target is deployed through a sibling staging directory and an atomic directory rename. The previous directory is kept until the new service worker reconnects. If reconnect fails, the daemon restores either that displaced directory or the validated backup archive and attempts to reload the previous extension version.

After a successful project apply and commit step, the daemon:

1. Uses the updated source directory in place, or synchronizes it into the configured external target.
2. Requests one extension reload from the connected runtime.
3. The service worker stores the affected ChatGPT tab IDs.
4. `chrome.runtime.reload()` loads the new extension files.
5. The restarted service worker reloads those ChatGPT tabs.
6. The bridge waits for a compatible extension/content runtime to reconnect.

The manifest contains a stable public `key`, so the extension ID remains stable if the unpacked directory is moved or reloaded. No private signing key is included.

The first transition from an older extension that does not understand the reload command requires one manual **Reload** click in `chrome://extensions` after replacing the files. It does not require removing or adding the extension again. Once version 0.5.0 or newer is active, later workflow updates can reload themselves.

## Restarting the daemon after a self-update

Node.js cannot replace code already loaded by the current process. A self-hosted workflow can therefore persist its terminal state and request a supervisor restart:

```json
{
  "daemonRestart": {
    "enabled": true,
    "mode": "exit",
    "delayMs": 1000,
    "exitCode": 75,
    "required": false
  }
}
```

In `exit` mode, the daemon writes `workflows/restart-request.json`, emits `workflow.daemon.restart.requested`, closes the server and persistent stores cleanly, and exits with the configured non-zero code. `systemd` with `Restart=on-failure` and ordinary PM2 autorestart start the updated code. On startup, the workflow is restored before the command-line workflow file is considered, so the persisted conversation binding is not replaced. The restart intent is acknowledged through `workflow.daemon.restart.completed` and then removed.

`command` mode starts a configured detached command and then exits normally. Use it only when an external supervisor cannot restart on an exit code.

Example PM2 start command:

```bash
pm2 start src/index.js --name chatgpt-bridge -- --server --workflow ./bridge.workflow.json
```

The bundled systemd unit already uses `Restart=on-failure`, so exit code `75` triggers a restart.

## Real workflow E2E

The real-browser workflow suite verifies the unsolicited observer path rather than creating a normal bridge turn for the initial artifact request. The suite synchronizes one stable project identity into the owned conversation and reuses it across the selected workflow scenarios. Each scenario then submits its user prompt through the browser-only passive command.

Run the complete workflow matrix:

```bash
npm run test:e2e:workflows -- --color
```

The matrix contains four independently runnable scenarios:

```bash
npm run test:e2e:passive-workflow -- --color
npm run test:e2e:workflow-multi-bridge -- --color
npm run test:e2e:workflow-approval -- --color
npm run test:e2e:workflow-remediation -- --color
```

`passive-workflow` waits for `observed.turn.terminal`, downloads the real ZIP, requires an exact project-ID match, applies it automatically, and executes a post-apply command.

`workflow-multi-bridge` keeps the ordinary E2E bridge as the sole owner of the ChatGPT tab and starts an independent workflow-worker process. The worker subscribes to the primary bridge's authenticated sequenced observed-turn SSE, downloads the generated ZIP through the primary artifact API into its own file store, verifies it, and applies it locally. It must not connect a second extension transport to the same tab.

`workflow-approval` runs in `ask` mode. It proves that the verified archive is held in the persistent approval queue and that the project remains unchanged until the E2E explicitly approves that exact approval ID.

`workflow-remediation` intentionally applies an archive that fails a deterministic post-apply command. It requires a successful rollback, sends the captured validation output to the same conversation, waits for a replacement ZIP, applies the corrected archive, and verifies the final project state.


A browser-independent process integration is also available:

```bash
npm run test:workflow:multi-bridge
```

It starts separate primary and worker Node processes and verifies the same observed-turn, HTTP artifact import, project verification, and apply path without requiring Chrome.

All workflow scenarios use isolated temporary projects and disable commit, extension deployment, and daemon restart. They verify the real ChatGPT DOM, extension, download, observer, verifier, transaction, approval, rollback, remediation, and command-execution integration without modifying the bridge repository.

Each scenario writes `workflow-config.json`, `workflow-events.json`, `workflow-approvals.json`, `workflow-progress.json`, and `project-terminal-state.json` into its report directory. `workflow-progress.json` makes it explicit which stages actually occurred, including passive submission, observation, download, verification, approval, apply, remediation, and completion. The colored console trace names the exact event being awaited, shows the current workflow stage, distinguishes actual actions from polling, and fails immediately on terminal events that make the requested target impossible. Interrupted runs are finalized with status `interrupted` instead of leaving only partial diagnostics.

## Interactive commands

```text
/workflow
/workflow run [id] [--session current|new|pinned|<id>] [--max-cycles n] [--verbose]
/workflow stop [id]
/workflow restart [id]
/workflow resume [id]
/workflow discard [id]
/workflow approve [workflow]
/workflow reject [workflow] [--reason text]
/workflow history [id]
/workflow show [id]
/workflow logs [id] [--verbose]
/workflow list
/workflow init [path] [--force]
/workflow load <path>
```

`/workflow` is the dashboard. It shows the workflow definition, user-facing stage, run ID, cycle, immutable bound session or next-run session, last error, and the actions that are currently valid. Internal watcher, pipeline, and approval identifiers are available only through `/workflow debug`.

Administrative compatibility commands for manual verification, extension deployment, and old watcher control remain accepted during migration, but they are intentionally absent from normal help and completion.

## HTTP API

Authenticated primary/worker API endpoints:

```text
GET    /browser/observed-turns
GET    /browser/observed-turns/stream
GET    /workflows
POST   /workflows/load
POST   /workflows/:id/start
POST   /workflows/:id/stop
POST   /workflows/:id/run
POST   /workflows/:id/run/stop
POST   /workflows/:id/run/restart
POST   /workflows/:id/run/resume
POST   /workflows/:id/run/discard
DELETE /workflows/:id
GET    /workflows/:id/events
POST   /workflows/:id/verify
POST   /workflows/:id/process-file
POST   /workflows/:id/extension/deploy
GET    /workflow-approvals
POST   /workflow-approvals/:id/approve
POST   /workflow-approvals/:id/reject
```

Start a manual automation run with optional overrides:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"verbose":false,"maxCycles":5,"sessionPolicy":"current"}' \
  http://127.0.0.1:8080/workflows/<workflow-id>/run
```

Stop it with:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"stopped by operator"}' \
  http://127.0.0.1:8080/workflows/<workflow-id>/run/stop
```

## Recovery after restart

Workflow definitions, artifacts, approvals, run state, hashes, and events are persisted. Pipeline recovery remains fail-closed: an apply operation that stopped after changing files is recovered or rolled back from its exact persisted manifest before new work is accepted.

Automation recovery follows `automation.restartPolicy`:

- `ask` marks the run `Interrupted`; `/workflow resume` continues the exact run and bound session, while `/workflow discard` terminates it.
- `auto` resumes automatically.
- `discard` terminates the saved run during startup.

A fresh `/workflow run` is refused while an interrupted run exists, so an old ChatGPT session cannot be resumed accidentally. Pending approvals remain attached to their exact pipeline and are not replaced by a newer observed turn.

The browser observer stores recently emitted turn signatures in the tab session. Reconnecting the bridge, reloading the extension, or periodically refreshing the tab does not replay those turns.

## Safety boundaries

- Auto mode is scoped to one configured project root.
- A candidate must belong to the observed assistant turn.
- Multiple explicit ZIP candidates are rejected when `requireSingleCandidate` is enabled.
- Protected paths cannot be modified automatically.
- A project-root queue serializes artifacts and apply operations, including turns that arrive while another pipeline is running.
- Only one loaded workflow may manage a project root.
- Artifact SHA-256 prevents duplicate application.
- Validation failure rolls back before any remediation prompt is sent.
- Git push is never performed.
- Automatic commits are skipped when Git changes existed before artifact application, so unrelated local work is never included by `git add -A`.
- Extension reload waits for the expected runtime version to reconnect.
