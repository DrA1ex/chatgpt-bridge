import { workflowActionLabels } from './workflowActions.js';

/** Executes exactly the action token currently exposed by the v3 snapshot. */
export async function dispatchWorkflowPendingAction({ manager, workflow, index }) {
  if (workflow.lifecycle === 'paused') {
    await manager.command(workflow.id, { type: index === 0 ? 'resume' : 'stop' });
    return { close: true };
  }
  const action = workflowActionLabels(workflow)[index];
  if (!workflow.nextAction || !action) throw new Error('The workflow action is no longer available');
  await manager.command(workflow.id, {
    type: 'act',
    actionId: workflow.nextAction.id,
    choice: action.choice,
  });
  return { close: action.choice !== 'retry' };
}
