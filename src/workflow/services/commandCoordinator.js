import { dispatchWorkflowCommand } from './commandService.js';
import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
} from '../state/workflowState.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';

function automationActive(runtime) {
  return runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION
    && ![WorkflowLifecycle.READY, WorkflowLifecycle.STOPPED].includes(runtime.workflowState.lifecycle);
}

export class WorkflowCommandCoordinator {
  constructor(actions = {}) { this.actions = actions; }

  async execute(runtime, command = {}) {
    const commandId = String(command.commandId || createWorkflowId('workflow-command'));
    await this.actions.transition(runtime, WorkflowEventType.COMMAND_ACCEPTED, {
      commandId,
      type: String(command.type || command.command || ''),
    }, 'workflow.command.accepted', { commandId }, {
      eventId: `command:${commandId}`,
      expectedRevision: command.expectedRevision,
    });
    return await dispatchWorkflowCommand(runtime, command, this.#commandActions(runtime));
  }

  #commandActions(runtime) {
    const snapshot = () => publicWorkflowSnapshot(runtime);
    const continueAutomation = async () => { await this.actions.ensureAutomation(runtime); return snapshot(); };
    return {
      activate: () => this.actions.activate(runtime),
      deactivate: () => this.actions.deactivate(runtime),
      run: (options) => String(options.kind || '') === WorkflowRunKind.GUIDED
        ? this.actions.startGuided(runtime, options)
        : this.actions.runAutomation(runtime, options),
      pause: (reason) => automationActive(runtime)
        ? this.actions.pauseAutomation(runtime, reason)
        : this.#pauseWorkflow(runtime, reason),
      resume: () => automationActive(runtime)
        ? this.actions.resumeAutomation(runtime)
        : this.actions.transition(runtime, WorkflowEventType.RESUMED, { runId: runtime.workflowState.run.id }, 'workflow.resumed').then(snapshot),
      stop: (reason) => automationActive(runtime) ? this.actions.stopAutomation(runtime, reason) : this.actions.deactivate(runtime),
      retry: async (options) => {
        if (runtime.workflowState.lifecycle === WorkflowLifecycle.RECOVERING) {
          await this.actions.transition(runtime, WorkflowEventType.RECOVERY_RESUMED, { runId: runtime.workflowState.run.id }, 'workflow.recovery.resumed');
          if (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION) return await this.actions.restoreAutomation(runtime);
          return snapshot();
        }
        return await this.actions.restartAutomation(runtime, { trigger: 'retry-command', ...options });
      },
      transition: (...args) => this.actions.transition(runtime, ...args),
      snapshot,
      decision: (id) => this.actions.getActionPayload(id),
      apply: async (payload) => {
        try {
          await this.actions.resumeApproved(runtime, payload);
          return await continueAutomation();
        } catch (error) {
          if (runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) await this.#restoreApplyAction(runtime, payload, error);
          throw error;
        }
      },
      commit: async (decision) => { await this.actions.commit(runtime, decision); return await continueAutomation(); },
      skipCommit: async (decision, reason) => { await this.actions.skipCommit(runtime, decision, reason); return await continueAutomation(); },
      fixChecks: async (decision) => { await this.actions.fixChecks(runtime, decision); return await continueAutomation(); },
      keepChecks: async (decision) => { await this.actions.keepChecks(runtime, decision); return await continueAutomation(); },
      revertChecks: async (decision) => { await this.actions.revertChecks(runtime, decision); return snapshot(); },
      resolveDecision: async () => {},
      recoverSession: () => this.actions.recoverSession(runtime),
      resyncRemoteTransport: () => this.actions.resyncRemoteTransport(runtime),
    };
  }


  async #pauseWorkflow(runtime, reason = 'paused by user') {
    if (!runtime.workflowState.run?.id) throw new Error(`Workflow ${runtime.id} has no active run to pause`);
    if (!runtime.workflowState.control?.pauseRequested) {
      await this.actions.transition(runtime, WorkflowEventType.PAUSE_REQUESTED, {
        runId: runtime.workflowState.run.id,
        reason,
      }, 'workflow.pause_requested', { reason });
    }
    await this.actions.transition(runtime, WorkflowEventType.PAUSED, {
      runId: runtime.workflowState.run.id,
      reason,
    }, 'workflow.paused', { reason });
    return publicWorkflowSnapshot(runtime);
  }


  async #restoreApplyAction(runtime, payload, error) {
    const actionId = createWorkflowId('apply-retry');
    const message = error?.message || String(error);
    await this.actions.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
      runId: runtime.workflowState.run.id,
      actionId,
      kind: WorkflowActionKind.APPLY,
      reason: message,
      choices: [
        { id: 'approve', label: 'Retry apply after reviewing local changes', transition: 'continue', phase: WorkflowPhase.VERIFYING },
        { id: 'reject', label: 'Reject changes', transition: 'finish', outcome: { status: 'cancelled', code: 'apply_rejected' } },
        { id: 'stop', label: 'Stop workflow', transition: 'stop' },
      ],
      references: { payloadRef: actionId, artifactKey: payload.artifactKey },
    }, 'workflow.action.retry.required', { actionId, message }, {
      actionPayloads: { [actionId]: { ...payload, id: actionId, retryOf: payload.id || '', lastError: message } },
    });
  }
}
