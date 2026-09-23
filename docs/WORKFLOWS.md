# Workflows

Bridge has one interactive workflow backend: the authenticated local Zipflow service.
The interactive UI does not maintain a second workflow engine, migration mode, or wizard fallback.

## Interactive workflow surface

Open the current project workflow with:

```text
/workflow
```

The command opens the server-backed workflow surface. The same command family exposes read-only status and explicit server operations:

```text
/workflow history
/workflow plan
/workflow diff <path>
/workflow report
/workflow checks
/workflow fix
/workflow preset <apply-changes|fix-until-pass|guided-task>
```

Unknown workflow subcommands are rejected. Interactive mode never falls back to another workflow implementation when Zipflow is unavailable.

## Project turns and apply

Normal text entered while a project is open uses the project-aware turn pipeline. The current project ZIP is attached to that user turn. `/task <text>` uses the same project context but requires a ZIP result. `/chat <text>` deliberately bypasses project ZIP context.

When a project turn produces a valid ZIP, Bridge selects it for `/apply`. If the project does not yet have a saved Zipflow workflow, `/apply` initializes the `apply-changes` preset and continues with the selected artifact. `/apply --plan` and `/apply --interactive` stay on the review surface and do not bypass Zipflow's advertised actions.

## Presets

- `apply-changes` reviews and applies a ChatGPT-produced project archive through Zipflow.
- `fix-until-pass` runs configured checks and requests repair archives until the checks pass or the series stops.
- `guided-task` stores a server-backed workflow configuration for guided project work.

Zipflow owns archive inspection, project writes, checks, Git operations, deployment, history, rollback, conflict resolution, and mutation idempotency. Bridge owns ChatGPT orchestration, project snapshot creation, artifact selection, and the interactive surface.

## Recovery

`/resume` reattaches to an active browser request. `/recover` imports a recently visible completed ChatGPT answer through the normal result resolver. `/recover --apply` continues into the same server-backed apply path.

Bridge persists only the correlation required to reconnect the local workflow service. Mutation responses are not retried with new idempotency keys after an uncertain outcome.

## Headless workflow CLI

The standalone `bridge workflow ...` commands are a separate non-interactive runner and are not slash-command aliases:

```text
bridge workflow init [path]
bridge workflow validate [path]
bridge workflow run [path]
bridge workflow resume [path]
bridge workflow discard [path]
bridge workflow serve [path]
```

They use `bridge.workflow.json` and are intended for unattended or service-style execution. Their lifecycle does not participate in interactive prompt routing.

For the local workflow service protocol, persistence, security boundaries, and repair series contract, see [Local workflow service integration](ZIPFLOW_SERVER.md).
