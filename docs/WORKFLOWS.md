# Passive Artifact Workflows

ChatGPT Browser Bridge can watch an already-open ChatGPT conversation without sending the original prompt itself. This supports a workflow where a prompt is written from the mobile app, desktop app, or another browser, while a local daemon receives the completed assistant turn from a monitored web tab.

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

## Real passive-workflow E2E

The real-browser scenario verifies the unsolicited observer path rather than creating a normal bridge turn. It synchronizes project identity into the owned conversation, submits a prompt through the browser-only passive command, waits for `observed.turn.terminal`, downloads the real ZIP, requires an exact project-ID match, applies it, and executes a post-apply command.

```bash
npm run test:e2e:passive-workflow -- --color
```

The scenario uses a temporary project and disables commit, extension deployment, and daemon restart. It is intended to verify the real ChatGPT DOM/extension/download/workflow integration without modifying the bridge repository.

## Interactive commands

```text
/workflow init [path] [--force]
/workflow load <path>
/workflow list
/workflow start <id>
/workflow stop <id>
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

Authenticated API endpoints:

```text
GET    /workflows
POST   /workflows/load
POST   /workflows/:id/start
POST   /workflows/:id/stop
DELETE /workflows/:id
GET    /workflows/:id/events
POST   /workflows/:id/verify
POST   /workflows/:id/extension/deploy
GET    /workflow-approvals
POST   /workflow-approvals/:id/approve
POST   /workflow-approvals/:id/reject
```

## Recovery after restart

Loaded workflows, artifacts, approvals, hashes, and events are persisted. On daemon startup, saved configurations are reloaded. A stopped workflow remains stopped; other workflows resume watching. Pending approvals and automatic conversation bindings remain available.

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
