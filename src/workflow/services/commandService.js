import { WorkflowActionKind, WorkflowEventType } from '../state/workflowState.js';

export async function dispatchWorkflowCommand(runtime, command = {}, actions = {}) {
  const type = String(command.type || command.command || '').trim();
  if (!type) throw new Error('Workflow command type is required');
  if (type === 'activate') return await actions.activate();
  if (type === 'deactivate') return await actions.deactivate();
  if (type === 'run') return await actions.run(command.options || {});
  if (type === 'pause') return await actions.pause(command.reason || 'paused by command');
  if (type === 'resume') return await actions.resume();
  if (type === 'stop') return await actions.stop(command.reason || 'stopped by command');
  if (type === 'retry') return await actions.retry(command.options || {});
  if (type !== 'act') throw new Error(`Unknown workflow command: ${type}`);
  const action = runtime.workflowState.nextAction;
  if (!action) throw new Error(`Workflow ${runtime.id} has no pending action`);
  const actionId = String(command.actionId || '');
  const choice = String(command.choice || '');
  if (action.expiresAt && Date.now() >= Date.parse(action.expiresAt)) {
    await actions.transition(WorkflowEventType.ACTION_EXPIRED, { actionId }, 'workflow.action.expired', { actionId });
    return actions.snapshot();
  }
  const decision = await actions.decision(actionId);
  await actions.transition(WorkflowEventType.ACTION_RESOLVED, { actionId, choice }, 'workflow.action.resolved', { actionId, choice });
  if (choice === 'stop') return actions.snapshot();
  if (action.kind === WorkflowActionKind.APPLY && choice === 'approve') return await actions.apply(decision);
  if (action.kind === WorkflowActionKind.COMMIT && choice === 'commit') return await actions.commit(decision);
  if (action.kind === WorkflowActionKind.COMMIT && choice === 'continue_without_commit') return await actions.skipCommit(decision, command.reason);
  if (action.kind === WorkflowActionKind.FAILED_CHECKS && choice === 'fix') return await actions.fixChecks(decision);
  if (action.kind === WorkflowActionKind.FAILED_CHECKS && choice === 'keep') return await actions.keepChecks(decision);
  if (action.kind === WorkflowActionKind.FAILED_CHECKS && choice === 'revert') return await actions.revertChecks(decision);
  if (action.kind === WorkflowActionKind.SESSION_RECOVERY && choice === 'recover') return await actions.recoverSession();
  if (action.kind === WorkflowActionKind.RECOVERY && choice === 'retry') return await actions.retry(command.options || {});
  if (action.kind === WorkflowActionKind.REMOTE_TRANSPORT && choice === 'resync') return await actions.resyncRemoteTransport();
  if (decision) await actions.resolveDecision(decision, choice);
  return actions.snapshot();
}
