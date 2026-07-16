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

## Quick start for this repository

Copy the example configuration:

```bash
cp bridge.workflow.example.json bridge.workflow.json
```

Review the paths and policies. The repository example leaves `extensionUpdate.targetDir` empty, so extension files are updated in place under `tools/chrome-bridge-extension`.

If Chrome already loads the unpacked extension from that directory, no installation change is required. Successful workflows call `chrome.runtime.reload()` and reload the open ChatGPT tabs automatically.

To use an external stable extension directory instead, set `extensionUpdate.targetDir` and run:

```bash
npm run extension:install -- --config bridge.workflow.json
```

Load the printed directory once from `chrome://extensions`. Future updates keep using that directory without removing and adding the extension again.

Start the daemon:

```bash
node src/index.js --server --workflow ./bridge.workflow.json
```

The daemon persists workflow state under:

```text
~/.bridge-data/workflows/state.json
```

The exact root follows the configured bridge data directory.

## Integrated validation and repair automation

A loaded workflow may run the complete repeated cycle directly inside `WorkflowManager`:

1. Execute configured local steps.
2. Preserve complete stdout and stderr in a compressed diagnostics bundle.
3. If every step passes, complete the automation run.
4. If a step fails, create a ChatGPT turn with the current project snapshot and diagnostics.
5. Require one complete project ZIP from that turn.
6. Verify, plan, apply, test, roll back, commit, update the extension, and restart through the existing workflow pipeline.
7. Run the local steps again until they pass or `maxCycles` is exhausted.

This is not a separate supervisor or a second artifact protocol. The automation state is persisted beside the watcher and pipeline state, and the passive watcher is temporarily ignored while the automation owns its request.

The steps are language-independent shell commands. Each step may have its own working directory, environment, timeout, and failure policy:

```json
{
  "automation": {
    "enabled": true,
    "trigger": "manual",
    "maxCycles": 5,
    "continueAfterFailure": true,
    "suspendWatcher": true,
    "resumeOnRestart": true,
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
      "sessionId": "",
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

`trigger` may be `manual` or `on-start`. Manual runs start with `/workflow run <id>` or the HTTP endpoint. `on-start` begins after the workflow is loaded by a primary bridge that has a local `TurnManager`. Independent passive workflow workers keep their existing observer role and do not create automation turns.

Every step receives these environment variables:

```text
WORKFLOW_ID
WORKFLOW_CONFIG
WORKFLOW_PROJECT_ROOT
WORKFLOW_AUTOMATION_ID
WORKFLOW_AUTOMATION_CYCLE
WORKFLOW_REPORT_DIR
```

Direct test output into `WORKFLOW_REPORT_DIR` when possible. `diagnostics.include` may additionally name files or directories under the project root. Missing paths are recorded rather than silently ignored; symlinks and paths outside the project root are never copied. Complete step logs are always archived. Interactive `--verbose` changes only live terminal rendering.

When auto-apply encounters a policy warning, the automation enters `awaiting_approval` and remains attached to the same workflow pipeline. Approving that exact approval continues the validation loop; rejecting it terminates the run. After daemon restart, an interrupted local command is rerun, but an `applying` or `awaiting_approval` automation waits for the already persisted pipeline instead of creating a replacement repair turn.

`/workflow run-stop` aborts the complete active command process group and cancels an active repair turn. It does not merely mark the state stopped. Complete stdout and stderr are flushed before any diagnostic archive is created.

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
/workflow init [path] [--force]
/workflow load <path>
/workflow list
/workflow start <id>
/workflow stop <id>
/workflow run <id> [--verbose] [--reset-thread] [--max-cycles n]
/workflow run-stop <id> [reason]
/workflow unload <id>
/workflow verify <id> <artifactId|fileId>
/workflow approvals
/workflow approve <approvalId>
/workflow reject <approvalId> [reason]
/workflow events <id> [limit]
/workflow extension <id>
/watch <configPath>
/watch-status
/unwatch [id]
```

`/workflow verify` downloads an artifact when necessary and executes the configured ZIP/project/staging verification without applying it.

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
  -d '{"verbose":false,"maxCycles":5,"resetThread":false}' \
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

Loaded workflows, automation runs, artifacts, approvals, hashes, and events are persisted. On daemon startup, saved configurations are reloaded. A stopped workflow remains stopped; other workflows resume watching. With `resumeOnRestart` enabled, interrupted local validation reruns its current cycle because a partially executed command is not trusted. An automation that was applying or awaiting approval remains attached to its exact persisted pipeline and continues only after that pipeline completes. Pending approvals and automatic conversation bindings remain available.

If the daemon stopped after project files were changed but before the pipeline completed, startup inspects the persisted rollback manifest. A safe complete manifest is applied automatically before watching resumes. An unsafe or incomplete rollback state stops the workflow instead of continuing with a potentially mixed project tree.

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
