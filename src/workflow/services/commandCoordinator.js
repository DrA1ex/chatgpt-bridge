import { dispatchWorkflowCommand } from './commandService.js';
import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
} from '../state/workflowState.js';
import { nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';

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
        : this.actions.transition(runtime, WorkflowEventType.PAUSED, { runId: runtime.workflowState.run.id, reason }, 'workflow.paused').then(snapshot),
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
      decision: (id) => this.actions.getDecision(id),
      apply: async (decision) => {
        try {
          await this.actions.resumeApproved(runtime, decision);
          await this.#resolveDecision(decision, 'approve');
          return await continueAutomation();
        } catch (error) {
          decision.status = runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING ? 'pending' : 'failed';
          decision.lastError = error.message || String(error);
          await this.actions.setDecision(decision.id, decision);
          if (runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) await this.#restoreApplyAction(runtime, decision);
          throw error;
        }
      },
      commit: async (decision) => { await this.actions.commit(runtime, decision); return await continueAutomation(); },
      skipCommit: async (decision, reason) => { await this.actions.skipCommit(runtime, decision, reason); return await continueAutomation(); },
      fixChecks: async (decision) => { await this.actions.fixChecks(runtime, decision); return await continueAutomation(); },
      keepChecks: async (decision) => { await this.actions.keepChecks(runtime, decision); return await continueAutomation(); },
      revertChecks: async (decision) => { await this.actions.revertChecks(runtime, decision); return snapshot(); },
      resolveDecision: (decision, choice) => this.#resolveDecision(decision, choice),
      recoverSession: () => this.actions.recoverSession(runtime),
    };
  }

  async #resolveDecision(decision, choice) {
    if (!decision) return;
    decision.status = 'resolved';
    decision.choice = choice;
    decision.decidedAt = nowIso();
    await this.actions.setDecision(decision.id, decision);
  }

  async #restoreApplyAction(runtime, decision) {
    await this.actions.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
      runId: runtime.workflowState.run.id,
      actionId: decision.id,
      kind: WorkflowActionKind.APPLY,
      reason: decision.lastError,
      choices: [
        { id: 'approve', label: 'Retry apply after reviewing local changes', transition: 'continue', phase: WorkflowPhase.VERIFYING },
        { id: 'reject', label: 'Reject changes', transition: 'finish', outcome: { status: 'cancelled', code: 'apply_rejected' } },
        { id: 'stop', label: 'Stop workflow', transition: 'stop' },
      ],
      references: { decisionId: decision.id, artifactKey: decision.artifactKey },
    }, 'workflow.action.retry.required', { actionId: decision.id, message: decision.lastError });
  }
}
