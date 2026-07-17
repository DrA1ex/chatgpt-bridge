import test from 'node:test';
import assert from 'node:assert/strict';

test('workflow UI startup chain can be instantiated by Node ESM', async () => {
  const [view, control, wizard] = await Promise.all([
    import('../src/workflow/ux/workflowView.js'),
    import('../src/workflow/ux/workflowWizardControl.js'),
    import('../src/workflow/ux/workflowWizard.js'),
  ]);
  assert.equal(typeof view.workflowWatcherActive, 'function');
  assert.equal(typeof control.continueWorkflowFromWizard, 'function');
  assert.equal(typeof wizard.WorkflowWizardController, 'function');
});
