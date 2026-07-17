const ATTENTION_EVENTS = new Map([
  ['workflow.approval.required', { kind: 'confirmation', title: 'Workflow needs confirmation' }],
  ['workflow.automation.approval.required', { kind: 'confirmation', title: 'Workflow needs confirmation' }],
  ['workflow.commit.approval.required', { kind: 'commit-confirmation', title: 'Workflow commit needs confirmation' }],
  ['workflow.checks.failed.after-apply', { kind: 'checks-failed', title: 'Project checks failed' }],
  ['workflow.result.repair.exhausted', { kind: 'invalid-response', title: 'ChatGPT result needs attention' }],
  ['workflow.no-progress', { kind: 'no-progress', title: 'Workflow is not making progress' }],
  ['workflow.session.exhausted.ask', { kind: 'session-exhausted', title: 'ChatGPT chat cannot continue' }],
  ['workflow.local-change.conflict', { kind: 'local-conflict', title: 'Local project changes conflict' }],
  ['workflow.failed', { kind: 'error', title: 'Workflow stopped with an error' }],
  ['workflow.automation.failed', { kind: 'error', title: 'Workflow stopped with an error' }],
  ['workflow.completed_with_warnings', { kind: 'warning', title: 'Workflow completed with warnings' }],
]);

const COMPLETION_EVENTS = new Set(['workflow.completed', 'workflow.automation.completed', 'workflow.guided.completed']);

function text(value) { return String(value || '').trim(); }

function mappedFailure(type, data = {}) {
  if (type !== 'workflow.automation.failed' && type !== 'workflow.failed') return null;
  if (data.code === 'WORKFLOW_SESSION_AWAITING_DECISION') return { kind: 'session-exhausted', title: 'ChatGPT chat cannot continue' };
  if (data.code === 'WORKFLOW_NO_PROGRESS') return { kind: 'no-progress', title: 'Workflow is not making progress' };
  if (data.code === 'WORKFLOW_LOCAL_CHANGE_CONFLICT') return { kind: 'local-conflict', title: 'Local project changes conflict' };
  return null;
}

export function attentionForWorkflowEvent(workflowId, type, data = {}) {
  const mapped = mappedFailure(type, data) || ATTENTION_EVENTS.get(type);
  if (mapped) {
    const detail = text(data.message || data.reason || data.error || data.code || mapped.title);
    const identity = text(data.approvalId || data.pipelineId || data.automationId || data.attempt || detail);
    return {
      required: true,
      key: `${workflowId}:${mapped.kind}:${identity}`,
      kind: mapped.kind,
      title: mapped.title,
      message: detail,
      eventType: type,
      updatedAt: new Date().toISOString(),
    };
  }
  if (COMPLETION_EVENTS.has(type)) {
    return {
      required: false,
      key: `${workflowId}:completed:${text(data.automationId || data.pipelineId || data.commit)}`,
      kind: 'completed',
      title: 'Workflow completed',
      message: text(data.message || data.commit || 'The workflow completed successfully.'),
      eventType: type,
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

export function attentionActions(workflow = {}) {
  const attention = workflow.attention || {};
  if (attention.kind === 'confirmation') return ['Approve the changes', 'Review the changes', 'Reject the changes', 'Stop the workflow'];
  if (attention.kind === 'commit-confirmation') return ['Create this commit', 'Review the commit', 'Continue without a commit', 'Stop the workflow'];
  if (attention.kind === 'checks-failed') return ['Ask ChatGPT to fix the failures', 'Keep the changes and stop', 'Revert this workflow update', 'Review the test output'];
  if (attention.kind === 'invalid-response') return ['Send the instructions again', 'Review the response', 'Ignore this response and keep waiting', 'Stop the workflow'];
  if (attention.kind === 'session-exhausted') return ['Start a new chat and continue', 'Review the handoff first', 'Stop the workflow'];
  if (attention.kind === 'local-conflict') return ['Refresh ChatGPT with the latest project and continue', 'Review the local changes', 'Continue without refreshing', 'Stop the workflow'];
  if (attention.kind === 'no-progress') return ['Ask ChatGPT to try a different approach', 'Review current changes', 'Continue anyway', 'Stop and restore the starting state'];
  if (attention.kind === 'paused') return ['Resume the workflow', 'Stop the workflow'];
  if (attention.kind === 'error') return ['Ignore this error and keep watching', 'Review workflow details', 'Restart the workflow', 'Stop the workflow'];
  if (attention.kind === 'completed') return ['Return to normal interactive mode', 'Open workflow details', 'Start another workflow'];
  return [];
}
