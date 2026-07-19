import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowRunKind,
  isWorkflowActive,
} from '../state/workflowState.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';

export class WorkflowRemoteTransportService {
  constructor({ bridge, workflows, runtimeCoordinator, ensureAutomation } = {}) {
    this.bridge = bridge;
    this.workflows = workflows;
    this.runtimeCoordinator = runtimeCoordinator;
    this.ensureAutomation = ensureAutomation;
  }

  async handleGap(gap = {}) {
    const results = [];
    for (const runtime of this.workflows.values()) {
      if (!isWorkflowActive(runtime.workflowState)) continue;
      results.push(await this.runtimeCoordinator.enqueue(runtime.id, async () => {
        const runId = runtime.workflowState.run.id;
        if (runtime.workflowState.lifecycle !== WorkflowLifecycle.RECOVERING) {
          await this.runtimeCoordinator.transition(runtime, WorkflowEventType.RECOVERY_STARTED, {
            runId,
            reason: 'remote-observed-turn-stream-gap',
          }, 'workflow.remote_transport.recovery_started', { gap });
        }
        await this.runtimeCoordinator.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
          runId,
          actionId: createWorkflowId('remote-transport-action'),
          kind: WorkflowActionKind.REMOTE_TRANSPORT,
          reason: `The workflow worker missed upstream observed turns. Retained data begins at sequence ${Number(gap.retainedFromSequence) || 0}.`,
          choices: [
            { id: 'resync', label: 'Resume from the oldest retained turn', transition: 'recover' },
            { id: 'stop', label: 'Stop workflow without guessing', transition: 'stop' },
          ],
          references: { ...gap },
        }, 'workflow.remote_transport.action_required', { gap });
        return publicWorkflowSnapshot(runtime);
      }));
    }
    return results;
  }

  async resync(runtime) {
    if (typeof this.bridge?.resyncFromRetained !== 'function') throw new Error('Remote transport resync is unavailable');
    const resumed = await this.bridge.resyncFromRetained();
    if (!resumed) throw new Error('Remote transport has no pending stream gap to resync');
    if (runtime.workflowState.lifecycle === WorkflowLifecycle.RECOVERING) {
      await this.runtimeCoordinator.transition(runtime, WorkflowEventType.RECOVERY_RESUMED, {
        runId: runtime.workflowState.run.id,
      }, 'workflow.remote_transport.resumed', { streamEpoch: this.bridge.health?.().streamEpoch || '' });
    }
    if (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION) await this.ensureAutomation(runtime);
    return publicWorkflowSnapshot(runtime);
  }
}
