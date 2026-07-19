import {
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
} from '../state/workflowState.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';
import { pruneAutomationReports } from './diagnostics.js';
import { AutomationRunExecutor } from './executor.js';

export class WorkflowAutomationController {
  constructor({ turnManager, fileStore, transition, publish, processFile, beforeRequest = null, recoverSession = null, finalize = null } = {}) {
    this.turnManager = turnManager || null;
    this.fileStore = fileStore;
    this.transition = transition;
    this.publish = publish;
    this.processFile = processFile;
    this.beforeRequest = typeof beforeRequest === 'function' ? beforeRequest : null;
    this.recoverSession = typeof recoverSession === 'function' ? recoverSession : null;
    this.finalize = typeof finalize === 'function' ? finalize : null;
    this.tasks = new Map();
    this.runControllers = new Map();
    this.activeTurns = new Map();
    this.stopRequests = new Map();
    this.closing = false;
    this.executor = new AutomationRunExecutor({
      turnManager: this.turnManager,
      fileStore: this.fileStore,
      transition: this.transition,
      publish: this.publish,
      processFile: this.processFile,
      beforeRequest: this.beforeRequest,
      recoverSession: this.recoverSession,
      finalize: this.finalize,
      activeTurns: this.activeTurns,
      assertRunning: (currentRuntime, signal) => this.#assertRunning(currentRuntime, signal),
    });
  }

  available() {
    return Boolean(this.turnManager);
  }

  isActive(runtime) {
    return runtime?.workflowState?.run?.kind === WorkflowRunKind.AUTOMATION
      && ![WorkflowLifecycle.READY, WorkflowLifecycle.STOPPED].includes(runtime.workflowState.lifecycle);
  }

  isRunning(workflowId) {
    return this.tasks.has(String(workflowId || ''));
  }

  async waitForIdle(workflowId, timeoutMs = 30_000) {
    const id = String(workflowId || '');
    const task = this.tasks.get(id);
    if (!task) return true;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
      timer.unref?.();
    });
    const done = Promise.resolve(task).then(() => true, () => true);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  async start(runtime, options = {}) {
    const config = runtime.config.automation;
    if (this.closing) throw new Error('Workflow automation controller is closing');
    if (!config?.enabled) throw new Error(`Workflow automation is disabled for ${runtime.id}`);
    if (!this.turnManager) throw new Error('Workflow automation requires the local TurnManager');
    if (!config.steps.length) throw new Error('Workflow automation requires at least one configured step');
    if (this.isActive(runtime) || this.tasks.has(runtime.id)) {
      throw new Error(`Workflow automation is already active for ${runtime.id}`);
    }
    const automationId = createWorkflowId('automation');
    const maxCycles = Math.max(1, Number(options.maxCycles) || config.maxCycles);
    this.stopRequests.delete(runtime.id);
    await this.transition(runtime, WorkflowEventType.RUN_STARTED, {
      runId: automationId,
      kind: WorkflowRunKind.AUTOMATION,
      phase: WorkflowPhase.CHECKING,
      cycle: 1,
      maxCycles,
      references: {
        threadId: '',
        trigger: String(options.trigger || 'manual'),
        verbose: Boolean(options.verbose),
        sessionId: String(options.sessionId || ''),
        sessionPolicy: String(options.sessionPolicy || config.session?.policy || 'current'),
      },
    }, 'workflow.automation.started', { automationId, maxCycles, trigger: String(options.trigger || 'manual') });
    this.#launch(runtime, { ...options, maxCycles, automationId, resume: false });
    return runtime.workflowState.run;
  }

  async restore(runtime) {
    if (!this.isActive(runtime)) return runtime.workflowState.run;
    if (!runtime.config.automation.enabled) {
      await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: runtime.workflowState.run.id,
        message: 'Automation was interrupted by daemon restart and is no longer enabled',
        evidence: { interruptedStatus: runtime.workflowState.lifecycle },
      }, 'workflow.automation.failed', {
        automationId: runtime.workflowState.run.id,
        message: 'Automation interrupted by daemon restart',
      });
      return runtime.workflowState.run;
    }
    if (!this.turnManager) {
      await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: runtime.workflowState.run.id,
        message: 'Automation cannot resume without the local TurnManager',
      }, 'workflow.automation.failed', {
        automationId: runtime.workflowState.run.id,
        message: 'TurnManager unavailable after restart',
      });
      return runtime.workflowState.run;
    }
    const previousStatus = runtime.workflowState.lifecycle;
    const resumePipeline = previousStatus === WorkflowLifecycle.WAITING_ACTION
      || runtime.workflowState.run.phase === WorkflowPhase.APPLYING;
    const staleTurnId = runtime.workflowState.run.request.turnId;
    if (staleTurnId && !resumePipeline) {
      await this.turnManager.cancelTurn(staleTurnId, 'Workflow automation resumed after daemon restart').catch(() => null);
    }
    await this.publish(runtime.id, 'workflow.automation.resumed', {
      automationId: runtime.workflowState.run.id,
      cycle: runtime.workflowState.run.cycle,
      previousStatus,
      resumePipeline,
    });
    this.stopRequests.delete(runtime.id);
    this.#launch(runtime, {
      automationId: runtime.workflowState.run.id,
      maxCycles: runtime.workflowState.run.maxCycles || runtime.config.automation.maxCycles,
      resume: true,
      trigger: 'restore',
      resumeStatus: previousStatus,
      sessionId: String(runtime.workflowState.run.references?.sessionId || ''),
      sessionPolicy: String(runtime.workflowState.run.references?.sessionPolicy || runtime.config.automation.session?.policy || 'current'),
    });
    return runtime.workflowState.run;
  }

  async pause(runtime, reason = 'paused by user') {
    if (!this.isActive(runtime)) return runtime.workflowState.run;
    const automationId = runtime.workflowState.run.id;
    if (!runtime.workflowState.control?.pauseRequested) {
      await this.transition(runtime, WorkflowEventType.PAUSE_REQUESTED, {
        runId: automationId,
        reason,
      }, 'workflow.automation.pause_requested', { automationId, reason });
    }
    this.stopRequests.set(runtime.id, String(reason || 'paused by user'));
    this.runControllers.get(runtime.id)?.abort(reason);
    const turnId = runtime.workflowState.run.request.turnId;
    if (turnId && this.turnManager) await this.turnManager.cancelTurn(turnId, reason).catch(() => null);
    const settled = await this.waitForIdle(runtime.id, 30_000);
    if (!settled) {
      const error = new Error(`Timed out waiting for workflow ${runtime.id} effects to settle after pause request`);
      error.code = 'WORKFLOW_PAUSE_BARRIER_TIMEOUT';
      throw error;
    }
    await this.transition(runtime, WorkflowEventType.PAUSED, { runId: automationId, reason }, 'workflow.automation.paused', {
      automationId,
      cycle: runtime.workflowState.run.cycle,
      reason,
    });
    return runtime.workflowState.run;
  }

  async resume(runtime) {
    if (runtime.workflowState.lifecycle !== WorkflowLifecycle.PAUSED) return runtime.workflowState.run;
    await this.transition(runtime, WorkflowEventType.RESUMED, { runId: runtime.workflowState.run.id }, 'workflow.automation.resumed', { automationId: runtime.workflowState.run.id });
    return runtime.workflowState.run;
  }

  async stop(runtime, reason = 'stopped by user') {
    if (!this.isActive(runtime)) return runtime.workflowState.run;
    const automationId = runtime.workflowState.run.id;
    if (!runtime.workflowState.control?.stopRequested) {
      await this.transition(runtime, WorkflowEventType.STOP_REQUESTED, {
        runId: automationId,
        reason,
      }, 'workflow.automation.stop_requested', { automationId, reason });
    }
    this.stopRequests.set(runtime.id, String(reason || 'stopped by user'));
    this.runControllers.get(runtime.id)?.abort(reason);
    const turnId = runtime.workflowState.run.request.turnId;
    if (turnId && this.turnManager) await this.turnManager.cancelTurn(turnId, reason).catch(() => null);
    const settled = await this.waitForIdle(runtime.id, 30_000);
    if (!settled) {
      const error = new Error(`Timed out waiting for workflow ${runtime.id} effects to settle after stop request`);
      error.code = 'WORKFLOW_STOP_BARRIER_TIMEOUT';
      throw error;
    }
    await this.transition(runtime, WorkflowEventType.STOPPED, {
      runId: automationId,
      reason,
    }, 'workflow.automation.stopped', { automationId, reason });
    return runtime.workflowState.run;
  }

  async close({ timeoutMs = 30_000, cancelActiveTurns = true } = {}) {
    this.closing = true;
    const pending = Array.from(this.tasks.values());
    if (!cancelActiveTurns) {
      return { drained: pending.length === 0, pending: pending.length, preserved: pending.length > 0 };
    }
    for (const workflowId of this.tasks.keys()) {
      this.stopRequests.set(workflowId, 'daemon shutting down');
      this.runControllers.get(workflowId)?.abort('daemon shutting down');
    }
    if (this.turnManager) {
      await Promise.allSettled(Array.from(this.activeTurns.values()).map((turnId) => (
        this.turnManager.cancelTurn(turnId, 'Workflow automation interrupted by daemon shutdown')
      )));
    }
    if (!pending.length) return { drained: true, pending: 0 };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ drained: false, pending: pending.length }), Math.max(0, Number(timeoutMs) || 0));
      timer.unref?.();
    });
    const drained = Promise.allSettled(pending).then(() => ({ drained: true, pending: 0 }));
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  #launch(runtime, options) {
    const controller = new AbortController();
    this.runControllers.set(runtime.id, controller);
    const task = this.executor.execute(runtime, { ...options, signal: controller.signal })
      .catch(async (error) => {
        if (this.closing || runtime.workflowState?.lifecycle === WorkflowLifecycle.STOPPED || runtime.workflowState?.control?.stopRequested || runtime.workflowState?.control?.pauseRequested) return;
        if (error.code === 'WORKFLOW_AUTOMATION_STOPPED' && runtime.workflowState?.lifecycle === WorkflowLifecycle.PAUSED) return;
        const automationId = runtime.workflowState?.run?.id || options.automationId;
        if (automationId && this.isActive(runtime)) {
          await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
            runId: automationId,
            message: error.message || String(error),
            evidence: { code: error.code || '' },
          }, 'workflow.automation.failed', {
            automationId,
            message: error.message || String(error),
            code: error.code || '',
          }).catch(() => null);
        }
      })
      .finally(async () => {
        await pruneAutomationReports(runtime.config.automation.diagnostics.reportDir, runtime.config.automation.diagnostics.keepReports).catch(() => null);
        this.tasks.delete(runtime.id);
        this.runControllers.delete(runtime.id);
        this.activeTurns.delete(runtime.id);
        this.stopRequests.delete(runtime.id);
      });
    this.tasks.set(runtime.id, task);
  }

  #assertRunning(runtime, signal) {
    const reason = this.stopRequests.get(runtime.id);
    if (reason || signal?.aborted || runtime.workflowState?.lifecycle === WorkflowLifecycle.STOPPED || runtime.workflowState?.control?.pauseRequested || runtime.workflowState?.control?.stopRequested) {
      const error = new Error(reason || (signal?.aborted ? 'Workflow automation interrupted' : 'Workflow automation stopped'));
      error.code = 'WORKFLOW_AUTOMATION_STOPPED';
      throw error;
    }
  }
}
