import { WorkflowWatcherStatus } from '../state/workflowState.js';

export async function acknowledgeWorkflowAttention(runtime, { notificationService, persist } = {}) {
  const key = runtime.attention?.key || '';
  const kind = runtime.attention?.kind || '';
  runtime.attention = null;
  if (kind === 'error' && runtime.workflowState?.watcher?.status === WorkflowWatcherStatus.RUNNING) runtime.lastError = '';
  notificationService.acknowledge(key);
  await persist(runtime);
}
