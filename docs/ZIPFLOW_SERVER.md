# Local workflow service integration

Bridge 6.4 uses Zipflow 1.9 as the authority for local workflow execution. The
normal Bridge TUI remains the only user interface: it renders protocol surfaces,
plans, diffs, history, progress, and actions without opening the standalone
Zipflow UI.

## Ownership boundary

Bridge owns ChatGPT tabs, prompts, model and effort selection, repair loops,
session handoff, artifact selection, notifications, and the three user presets.

Zipflow owns archive inspection, project plans, conflicts, file writes, checks,
Git operations, deployment commands, backups, history, and rollback. A
server-backed Bridge workflow has no alternate interactive mutation pipeline
after a service error.

The integration uses the authenticated local endpoint advertised in
`~/.zipflow/runtime/server-v1.json`. Bridge validates the discovery file, token,
lock, endpoint ownership, API version, schema revision, and required
capabilities before it opens a project. The daemon is started lazily and can be
shared with the standalone client.

## Interactive use

Open a project and enter:

```text
/workflow
```

For a new project this opens the server-backed workflow setup surface. The
following explicit commands are also available:

```text
/workflow preset apply-changes
/workflow preset fix-until-pass
/workflow preset guided-task
/workflow history
/workflow plan
/workflow diff <project-relative-path>
/workflow report
/workflow checks
/workflow fix
```

`/apply [archive.zip]` verifies the selected FileStore artifact, streams the
exact descriptor to the service, verifies the returned size and SHA-256,
persists correlation, and starts an archive run. `/apply --plan` stops after
server-side inspection and plan projection. Force-style local mutation flags
are rejected: Bridge may execute only actions advertised by the current
revisioned server surface. Dangerous deployment and rollback actions require
two confirmations.

After selecting the `fix-until-pass` preset, `/workflow fix` creates or resumes
a durable Bridge series. Zipflow runs the configured checks and owns every
local iteration. On failure Bridge fetches bounded check output, asks ChatGPT
for one corrected ZIP, validates and uploads it with the same series ID, and
continues only through actions advertised by the current server surface.
Attempt and repeated-artifact limits are persisted in Bridge orchestration
state.

## Persistence and recovery

Bridge persists only opaque workflow correlation in
`workflows/server-state-v1.json`: project, run, operation, series and blob IDs,
the archive hash, server epoch, event cursor, and last surface revision. It does
not copy plans, conflict maps, check output, Git state, or backup manifests.

SSE cursors advance only after durable application. On reconnect Bridge performs
`hello`, reopens the canonical project after an epoch change, reads the current
run and operation, replaces its surface projection, and resumes events. A
`stream.gap` causes a full read-only resynchronization. Lost mutation responses
are never retried with a new idempotency key.

## Single interactive backend

Interactive workflow commands use this service exclusively. There is no migration slash command, compatibility wizard, or alternate local apply backend. If the service is unavailable, the command fails instead of switching mutation owners.

## Diagnostics

If the service is unavailable, inspect:

- Bridge daemon health and the sanitized error shown by the workflow surface;
- `~/.zipflow/runtime/server-v1.json`, `.token`, and `.lock`;
- whether the installed `zipflow` package is exactly version 1.9.0;
- API/capability errors from `/v1/hello`;
- the current run report through `/workflow report`.

Do not relax runtime directory or token permissions to recover a daemon. Remove
only an isolated stale runtime after confirming its recorded process is gone.

## Windows readiness

The package, endpoint parser, client transport, discovery model, path
normalization, and tests include Windows named-pipe forms. The current release
intentionally fails closed on Windows daemon startup until owner, DACL, and
reparse-point validation is implemented. It does not silently replace the local
endpoint with TCP. This keeps the protocol and Bridge integration portable
without weakening the initial security boundary.

## Verification and release gates

The Zipflow server path is the normal Bridge 6.4 workflow path, not an
experimental mode. The current implementation has passed these acceptance
gates:

- Zipflow's executable functional-baseline gate against
  `f44e0cb127437ea6ce3e4c7773ccf553673d74dc`;
- deterministic Bridge protocol, mutation-boundary, recovery, migration,
  artifact-transfer, repair-series, and result-protocol tests;
- real cross-process socket tests using the packaged Zipflow consumer;
- browser E2E with extension and tab reload, including reconnect and durable
  workflow recovery;
- exact Zipflow 1.9 package-lock integrity and successful clean package
  installation.

The verified run includes all three cross-process socket workflows, local
extension reload, authenticated Chrome conversation continuity and cleanup, and
authenticated failed-check remediation through a corrected replacement ZIP.
The Zipflow baseline passes 432 of 432 tests and the complete suites pass 774 of
774 Zipflow tests and 1028 Bridge tests with no failures (plus one
environment-only headless-Chromium skip). Exact Zipflow 1.9.0 and Bridge 6.4.0
tarballs install together in a clean consumer.

Publishing either package remains a separate manual release action. A future
environment failure must not be converted into a pass or bypassed by falling
to another mutation pipeline.
