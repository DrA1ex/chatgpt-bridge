# Workflow UX Test Coverage

Workflow verification is part of the normal project verification command:

```bash
npm run verify
```

The interactive workflow surface is server-backed. Coverage focuses on command routing, project archive selection, workflow service state, apply/review boundaries, repair series behavior, result validation, and recovery. There is no separate wizard or migration UI coverage gate.

Primary deterministic suites include:

- `test/serverWorkflowCommands.test.js`
- `test/serverWorkflowMutationBoundary.test.js`
- `test/serverWorkflowPresets.test.js`
- `test/zipflowWorkflowClient.test.js`
- `test/zipflowWorkflowCoordinator.test.js`
- `test/interactiveCanonicalCommands.test.js`
- `test/interactiveCommandSuggestions.test.js`
- `test/interactiveRecoveryFlow.test.js`

Authenticated browser scenarios remain available through:

```bash
npm run test:e2e -- --scenario workflows
```
