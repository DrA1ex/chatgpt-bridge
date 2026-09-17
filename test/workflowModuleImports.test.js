import test from 'node:test';
import assert from 'node:assert/strict';

test('workflow CLI view module can be instantiated by Node ESM', async () => {
  const view = await import('../src/workflow/ux/workflowView.js');
  assert.equal(typeof view.workflowWatcherActive, 'function');
  assert.equal(typeof view.workflowStage, 'function');
});
