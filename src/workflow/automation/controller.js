import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowAutomationStatus,
  WorkflowPipelineStatus,
  WorkflowStateEventType,
  isWorkflowAutomationActive,
  isWorkflowPipelineActive,
  isWorkflowPipelineTerminal,
} from '../state/workflowState.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';
import { runAutomationSteps } from './commandRunner.js';
import {
  collectAutomationDiagnostics,
  createAutomationBundle,
  pruneAutomationReports,
  writeAutomationSummary,
} from './diagnostics.js';
import { buildAutomationPrompt } from './prompt.js';
import { sleep, timestampKey, turnResult } from './runtimeSupport.js';

const TERMINAL_TURN_STATUSES = new Set(['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled']);
const APPLIED_STATUSES = new Set(['applied', 'applied-with-warnings', 'duplicate']);

export class WorkflowAutomationController {
  constructor({ turnManager, fileStore, transition, publish, processFile } = {}) {
    this.turnManager = turnManager || null;
    this.fileStore = fileStore;
    this.transition = transition;
    this.publish = publish;
    this.processFile = processFile;
    this.tasks = new Map();
    this.runControllers = new Map();
    this.activeTurns = new Map();
    this.stopRequests = new Map();
    this.closing = false;
  }

  available() {
    return Boolean(this.turnManager);
  }

  isActive(runtime) {
    return isWorkflowAutomationActive(runtime?.workflowState);
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
    await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STARTED, {
      automationId,
      status: WorkflowAutomationStatus.VALIDATING,
      cycle: 1,
      maxCycles,
      threadId: options.resetThread ? '' : runtime.workflowState?.automation?.threadId || '',
      evidence: {
        trigger: String(options.trigger || 'manual'),
        verbose: Boolean(options.verbose),
      },
    }, 'workflow.automation.started', { automationId, maxCycles, trigger: String(options.trigger || 'manual') });
    this.#launch(runtime, { ...options, maxCycles, automationId, resume: false });
    return runtime.workflowState.automation;
  }

  async restore(runtime) {
    if (!this.isActive(runtime)) return runtime.workflowState.automation;
    if (!runtime.config.automation.enabled || !runtime.config.automation.resumeOnRestart) {
      await this.transition(runtime, WorkflowStateEventType.AUTOMATION_FAILED, {
        automationId: runtime.workflowState.automation.id,
        error: 'Automation was interrupted by daemon restart and resumeOnRestart is disabled',
        evidence: { interruptedStatus: runtime.workflowState.automation.status },
      }, 'workflow.automation.failed', {
        automationId: runtime.workflowState.automation.id,
        message: 'Automation interrupted by daemon restart',
      });
      return runtime.workflowState.automation;
    }
    if (!this.turnManager) {
      await this.transition(runtime, WorkflowStateEventType.AUTOMATION_FAILED, {
        automationId: runtime.workflowState.automation.id,
        error: 'Automation cannot resume without the local TurnManager',
      }, 'workflow.automation.failed', {
        automationId: runtime.workflowState.automation.id,
        message: 'TurnManager unavailable after restart',
      });
      return runtime.workflowState.automation;
    }
    const previousStatus = runtime.workflowState.automation.status;
    const resumePipeline = previousStatus === WorkflowAutomationStatus.AWAITING_APPROVAL
      || previousStatus === WorkflowAutomationStatus.APPLYING;
    const staleTurnId = runtime.workflowState.automation.turnId;
    if (staleTurnId && !resumePipeline) {
      await this.turnManager.cancelTurn(staleTurnId, 'Workflow automation resumed after daemon restart').catch(() => null);
    }
    await this.publish(runtime.id, 'workflow.automation.resumed', {
      automationId: runtime.workflowState.automation.id,
      cycle: runtime.workflowState.automation.cycle,
      previousStatus,
      resumePipeline,
    });
    this.stopRequests.delete(runtime.id);
    this.#launch(runtime, {
      automationId: runtime.workflowState.automation.id,
      maxCycles: runtime.workflowState.automation.maxCycles || runtime.config.automation.maxCycles,
      resume: true,
      trigger: 'restore',
      resumeStatus: previousStatus,
    });
    return runtime.workflowState.automation;
  }

  async stop(runtime, reason = 'stopped by user') {
    if (!this.isActive(runtime)) return runtime.workflowState.automation;
    this.stopRequests.set(runtime.id, String(reason || 'stopped by user'));
    this.runControllers.get(runtime.id)?.abort(reason);
    const turnId = runtime.workflowState.automation.turnId;
    if (turnId && this.turnManager) await this.turnManager.cancelTurn(turnId, reason).catch(() => null);
    await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STOPPED, {
      automationId: runtime.workflowState.automation.id,
      message: reason,
      evidence: { reason },
    }, 'workflow.automation.stopped', {
      automationId: runtime.workflowState.automation.id,
      reason,
    });
    return runtime.workflowState.automation;
  }

  async close({ timeoutMs = 30_000 } = {}) {
    this.closing = true;
    for (const workflowId of this.tasks.keys()) {
      this.stopRequests.set(workflowId, 'daemon shutting down');
      this.runControllers.get(workflowId)?.abort('daemon shutting down');
    }
    if (this.turnManager) {
      await Promise.allSettled(Array.from(this.activeTurns.values()).map((turnId) => (
        this.turnManager.cancelTurn(turnId, 'Workflow automation interrupted by daemon shutdown')
      )));
    }
    const pending = Array.from(this.tasks.values());
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
    const task = this.#execute(runtime, { ...options, signal: controller.signal })
      .catch(async (error) => {
        if (this.closing || runtime.workflowState?.automation?.status === WorkflowAutomationStatus.STOPPED) return;
        const automationId = runtime.workflowState?.automation?.id || options.automationId;
        if (automationId && this.isActive(runtime)) {
          await this.transition(runtime, WorkflowStateEventType.AUTOMATION_FAILED, {
            automationId,
            error: error.message || String(error),
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
    if (reason || signal?.aborted || runtime.workflowState?.automation?.status === WorkflowAutomationStatus.STOPPED) {
      const error = new Error(reason || (signal?.aborted ? 'Workflow automation interrupted' : 'Workflow automation stopped'));
      error.code = 'WORKFLOW_AUTOMATION_STOPPED';
      throw error;
    }
  }

  async #execute(runtime, options) {
    const workflow = runtime.config;
    const config = workflow.automation;
    const automationId = options.automationId;
    const maxCycles = Math.max(1, Number(options.maxCycles) || config.maxCycles);
    let startCycle = options.resume
      ? Math.max(1, Number(runtime.workflowState.automation.cycle) || 1)
      : 1;
    let threadId = options.resetThread ? '' : String(runtime.workflowState.automation.threadId || '');

    if (options.resume && (options.resumeStatus === WorkflowAutomationStatus.AWAITING_APPROVAL
      || options.resumeStatus === WorkflowAutomationStatus.APPLYING)) {
      const pipeline = runtime.workflowState.pipeline;
      if (isWorkflowPipelineActive(runtime.workflowState)) {
        await this.#waitForPipeline(runtime, config.turn.approvalTimeoutMs, options.signal);
      } else if (!isWorkflowPipelineTerminal(runtime.workflowState)) {
        throw new Error(`Automation cannot resume ${options.resumeStatus}: pipeline ${pipeline.id || '<none>'} is ${pipeline.status}`);
      } else if (pipeline.status !== WorkflowPipelineStatus.COMPLETED) {
        throw new Error(`Automation pipeline ${pipeline.id || '<none>'} ended with ${pipeline.status}: ${pipeline.terminal?.message || pipeline.terminal?.code || 'no detail'}`);
      }
      startCycle += 1;
    }

    for (let cycle = startCycle; cycle <= maxCycles; cycle += 1) {
      this.#assertRunning(runtime, options.signal);
      const runRoot = path.join(config.diagnostics.reportDir, `run-${automationId}`);
      const reportDir = path.join(runRoot, `cycle-${String(cycle).padStart(2, '0')}-${timestampKey()}`);
      await fs.mkdir(reportDir, { recursive: true });
      await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
        automationId,
        status: WorkflowAutomationStatus.VALIDATING,
        cycle,
        maxCycles,
        threadId,
        turnId: '',
        reportDir,
        approvalId: '',
        evidence: { resumed: Boolean(options.resume && cycle === startCycle) },
      }, 'workflow.automation.validation.started', { automationId, cycle, maxCycles, reportDir });

      const validation = await runAutomationSteps(config.steps, {
        cwd: workflow.projectRoot,
        reportDir,
        timeoutMs: config.stepTimeoutMs,
        verbose: Boolean(options.verbose),
        automationId,
        cycle,
        publish: (type, data) => this.publish(runtime.id, type, data),
        signal: options.signal,
        env: {
          ...process.env,
          WORKFLOW_ID: runtime.id,
          WORKFLOW_CONFIG: workflow.configPath,
          WORKFLOW_PROJECT_ROOT: workflow.projectRoot,
          WORKFLOW_AUTOMATION_ID: automationId,
          WORKFLOW_AUTOMATION_CYCLE: String(cycle),
          WORKFLOW_REPORT_DIR: reportDir,
        },
      });
      this.#assertRunning(runtime, options.signal);
      await collectAutomationDiagnostics({
        projectRoot: workflow.projectRoot,
        reportDir,
        include: config.diagnostics.include,
        maxIncludedBytes: config.diagnostics.maxIncludedBytes,
      });
      const { summary } = await writeAutomationSummary({ reportDir, cycle, validation, workflowId: runtime.id, automationId });
      await this.publish(runtime.id, 'workflow.automation.validation.completed', {
        automationId,
        cycle,
        ok: validation.ok,
        steps: validation.results.map((result) => ({ id: result.id, name: result.name, ok: result.ok, code: result.code, durationMs: result.durationMs })),
      });

      if (validation.ok) {
        await this.transition(runtime, WorkflowStateEventType.AUTOMATION_COMPLETED, {
          automationId,
          evidence: { cycle, reportDir, result: 'validation-passed' },
        }, 'workflow.automation.completed', { automationId, cycle, reportDir });
        await pruneAutomationReports(config.diagnostics.reportDir, config.diagnostics.keepReports);
        return;
      }

      const bundlePath = path.join(reportDir, 'diagnostics.zip');
      const bundle = await createAutomationBundle({ reportDir, bundlePath });
      await this.publish(runtime.id, 'workflow.automation.diagnostics.created', {
        automationId,
        cycle,
        path: bundle.bundlePath,
        size: bundle.size,
        entries: bundle.entries,
      });

      if (cycle >= maxCycles) {
        const error = new Error(`Workflow automation exhausted ${maxCycles} validation cycle(s)`);
        error.code = 'WORKFLOW_AUTOMATION_EXHAUSTED';
        throw error;
      }

      threadId = await this.#ensureThread(runtime, threadId, options);
      const diagnosticFile = config.onFailure.attachDiagnostics
        ? await this.fileStore.importLocalPath({
          filePath: bundle.bundlePath,
          name: `${runtime.id}-automation-cycle-${cycle}.zip`,
          mime: 'application/zip',
        })
        : null;
      const prompt = buildAutomationPrompt({ workflow, validation, cycle });
      const { turn } = await this.turnManager.startTurn({
        threadId,
        message: prompt,
        cwd: workflow.projectRoot,
        sessionId: options.sessionId || config.turn.sessionId || workflow.watch.sessionId || '',
        sourceClientId: options.sourceClientId || config.turn.sourceClientId || workflow.watch.clientId || runtime.boundSourceClientId || '',
        model: options.model || config.turn.model || '',
        effort: options.effort || config.turn.effort || '',
        attachments: diagnosticFile ? [diagnosticFile.id] : [],
        project: config.onFailure.attachProject ? {
          ...config.project,
          cwd: workflow.projectRoot,
        } : null,
        output: config.onFailure.output,
        metadata: {
          workflowAutomation: true,
          workflowId: runtime.id,
          automationId,
          cycle,
          diagnosticSummary: summary.slice(0, 8_000),
        },
      });
      await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
        automationId,
        status: WorkflowAutomationStatus.WAITING_TURN,
        cycle,
        threadId,
        turnId: turn.id,
        reportDir,
        evidence: { diagnosticFileId: diagnosticFile?.id || '' },
      }, 'workflow.automation.turn.started', { automationId, cycle, threadId, turnId: turn.id, diagnosticFileId: diagnosticFile?.id || '' });

      this.activeTurns.set(runtime.id, turn.id);
      let snapshot;
      try {
        snapshot = await this.#waitForTurn(runtime, turn.id, config.turn, options.signal);
      } finally {
        if (this.activeTurns.get(runtime.id) === turn.id) this.activeTurns.delete(runtime.id);
      }
      const result = turnResult(snapshot);
      if (result.status !== 'completed') {
        throw new Error(`Automation turn ${turn.id} ended with ${result.status}: ${result.turn.error?.message || result.answer.slice(0, 1_000) || 'no detail'}`);
      }
      if (!config.onFailure.applyResult) {
        await this.transition(runtime, WorkflowStateEventType.AUTOMATION_COMPLETED, {
          automationId,
          evidence: { cycle, reportDir, result: 'turn-completed', fileId: result.fileId },
        }, 'workflow.automation.completed', { automationId, cycle, reportDir, fileId: result.fileId });
        return;
      }
      if (!result.fileId) {
        throw new Error(`Automation turn ${turn.id} completed without the required ${config.onFailure.output.expected || 'ZIP'} artifact`);
      }

      await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
        automationId,
        status: WorkflowAutomationStatus.APPLYING,
        cycle,
        threadId,
        turnId: turn.id,
        reportDir,
      }, 'workflow.automation.apply.started', { automationId, cycle, turnId: turn.id, fileId: result.fileId });
      const thread = await this.turnManager.getThread(threadId).catch(() => null);
      const applyResult = await this.processFile(runtime, {
        fileId: result.fileId,
        answer: result.answer,
        turnId: turn.id,
        turnKey: String(result.response?.turnKey || turn.id),
        sessionId: String(thread?.sessionId || result.response?.session?.id || result.response?.sessionId || ''),
        sourceClientId: String(turn.input?.sourceClientId || result.response?.sourceClientId || ''),
      });
      if (applyResult?.status === 'pending-approval') {
        await this.transition(runtime, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
          automationId,
          status: WorkflowAutomationStatus.AWAITING_APPROVAL,
          cycle,
          threadId,
          turnId: turn.id,
          reportDir,
          approvalId: applyResult.approvalId,
        }, 'workflow.automation.approval.required', {
          automationId,
          cycle,
          approvalId: applyResult.approvalId,
          pipelineId: runtime.workflowState.pipeline.id,
        });
        await this.#waitForPipeline(runtime, config.turn.approvalTimeoutMs, options.signal);
      } else if (!APPLIED_STATUSES.has(String(applyResult?.status || ''))) {
        throw new Error(`Automation result was not applied: ${JSON.stringify(applyResult)}`);
      }
      await this.publish(runtime.id, 'workflow.automation.apply.completed', {
        automationId,
        cycle,
        status: applyResult?.status || runtime.workflowState.pipeline.status,
      });
      await pruneAutomationReports(config.diagnostics.reportDir, config.diagnostics.keepReports);
    }
  }

  async #ensureThread(runtime, threadId, options) {
    if (threadId) {
      const existing = await this.turnManager.getThread(threadId).catch(() => null);
      if (existing) return existing.id;
    }
    const config = runtime.config.automation;
    const thread = await this.turnManager.createThread({
      title: `${runtime.id} automated workflow`,
      cwd: runtime.config.projectRoot,
      sessionId: options.sessionId || config.turn.sessionId || runtime.config.watch.sessionId || '',
      metadata: { workflowAutomation: true, workflowId: runtime.id },
    });
    return thread.id;
  }

  async #waitForTurn(runtime, turnId, turnConfig, signal) {
    const started = Date.now();
    let lastStatus = '';
    while (Date.now() - started <= turnConfig.timeoutMs) {
      this.#assertRunning(runtime, signal);
      const turn = await this.turnManager.getTurn(turnId);
      if (!turn) throw new Error(`Automation turn disappeared: ${turnId}`);
      const status = String(turn.status || '');
      if (status !== lastStatus) {
        lastStatus = status;
        await this.publish(runtime.id, 'workflow.automation.turn.progress', {
          automationId: runtime.workflowState.automation.id,
          turnId,
          status,
        });
      }
      if (TERMINAL_TURN_STATUSES.has(status)) {
        return { turn, items: await this.turnManager.getItems({ turnId }) };
      }
      await sleep(turnConfig.pollIntervalMs, signal);
    }
    throw new Error(`Timed out waiting for automation turn ${turnId} after ${turnConfig.timeoutMs}ms; last status: ${lastStatus || 'unknown'}`);
  }

  async #waitForPipeline(runtime, timeoutMs, signal) {
    const pipelineId = runtime.workflowState.pipeline.id;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      this.#assertRunning(runtime, signal);
      const state = runtime.workflowState;
      if (state.pipeline.id !== pipelineId) {
        throw new Error(`Automation approval pipeline changed from ${pipelineId} to ${state.pipeline.id || '<none>'}`);
      }
      if (isWorkflowPipelineTerminal(state)) {
        if (state.pipeline.status === WorkflowPipelineStatus.COMPLETED) return state.pipeline;
        throw new Error(`Automation pipeline ${pipelineId} ended with ${state.pipeline.status}: ${state.pipeline.terminal?.message || state.pipeline.terminal?.code || 'no detail'}`);
      }
      if (!isWorkflowPipelineActive(state)) {
        throw new Error(`Automation pipeline ${pipelineId} is no longer active`);
      }
      await sleep(Math.min(1_000, Math.max(250, runtime.config.automation.turn.pollIntervalMs)), signal);
    }
    throw new Error(`Timed out waiting for automation approval pipeline ${pipelineId} after ${timeoutMs}ms`);
  }
}
