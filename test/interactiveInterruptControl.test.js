import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteractiveInterrupt } from '../src/interactive/interruptControl.js';

function activeLegacyWorkflow() {
  return {
    id: 'legacy-1',
    lifecycle: 'running',
    run: { id: 'run-1', phase: 'running' },
    nextAction: { id: 'action-1', choices: [] },
  };
}

test('server-backed interactive exit ignores hidden legacy workflow state', () => {
  let exited = 0;
  const runtime = {
    abortController: null,
    options: {
      zipflowWorkflowRuntime: {},
      workflowManager: { list: () => [activeLegacyWorkflow()] },
    },
    workflowExitPrompt: null,
    detachOnExit: false,
    exit() { exited += 1; },
    invalidate() {},
  };

  handleInteractiveInterrupt(runtime);
  assert.equal(exited, 1);
  assert.equal(runtime.workflowExitPrompt, null);
  assert.equal(runtime.detachOnExit, false);
});
