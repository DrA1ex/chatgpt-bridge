const LABELS = Object.freeze({
  approve: 'Approve and continue',
  commit: 'Create commit',
  continue_without_commit: 'Continue without a commit',
  fix: 'Start fix loop',
  reject: 'Reject this result',
  recover: 'Recover and continue',
  retry: 'Retry the operation',
  keep: 'Keep the changes',
  revert: 'Revert the changes',
  stop: 'Stop the workflow',
});

export function workflowActionLabels(workflow = {}) {
  const action = workflow.nextAction;
  if (!action?.id || !Array.isArray(action.choices)) return [];
  return action.choices.map((choice) => {
    const id = typeof choice === 'string' ? choice : String(choice?.id || '');
    return { choice: id, label: String(choice?.label || LABELS[id] || id) };
  }).filter((item) => item.choice);
}

export function workflowActionTitle(workflow = {}) {
  const action = workflow.nextAction;
  if (!action) return 'Workflow controls';
  return action.kind === 'commit' ? 'Workflow commit needs confirmation' : 'Workflow needs attention';
}
