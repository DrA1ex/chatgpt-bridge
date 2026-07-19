import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowEventType,
  WorkflowEffectKind,
  WorkflowActionKind,
  WorkflowLifecycle,
  WorkflowPhase,
} from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
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

/**
 * Executes one canonical automation run. It may request reducer transitions
 * and typed effects, but it does not own lifecycle, pause, stop, or task maps.
 */
export class AutomationRunExecutor {
  constructor({ turnManager, fileStore, transition, publish, processFile, beforeRequest, recoverSession, finalize, activeTurns, assertRunning }) {
    this.turnManager = turnManager;
    this.fileStore = fileStore;
    this.transition = transition;
    this.publish = publish;
    this.processFile = processFile;
    this.beforeRequest = beforeRequest;
    this.recoverSession = recoverSession;
    this.finalize = finalize;
    this.activeTurns = activeTurns;
    this.assertRunning = assertRunning;
  }

  async execute(runtime, options) {
    const workflow = runtime.config;
    const config = workflow.automation;
    const automationId = options.automationId;
    const maxCycles = Math.max(1, Number(options.maxCycles) || config.maxCycles);
    let startCycle = options.resume
      ? Math.max(1, Number(runtime.workflowState.run.cycle) || 1)
      : 1;
    let threadId = options.resume ? String(runtime.workflowState.run.references?.threadId || '') : '';
    let previousFailureSignature = '';
    let repeatedFailureCount = 0;

    if (options.resume && (options.resumeStatus === WorkflowLifecycle.WAITING_ACTION
      || runtime.workflowState.run.phase === WorkflowPhase.APPLYING)) {
      await this.waitForAction(runtime, config.turn.approvalTimeoutMs, options.signal);
      startCycle += 1;
    }

    for (let cycle = startCycle; cycle <= maxCycles; cycle += 1) {
      this.assertRunning(runtime, options.signal);
      const runRoot = path.join(config.diagnostics.reportDir, `run-${automationId}`);
      const reportDir = path.join(runRoot, `cycle-${String(cycle).padStart(2, '0')}-${timestampKey()}`);
      await fs.mkdir(reportDir, { recursive: true });
      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: automationId,
        phase: WorkflowPhase.CHECKING,
        cycle,
        maxCycles,
        request: { turnId: '' },
        references: { threadId, reportDir, resumed: Boolean(options.resume && cycle === startCycle) },
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
      this.assertRunning(runtime, options.signal);
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
        const finalization = this.finalize ? await this.finalize(runtime, { automationId, cycle, reportDir, validation }) : null;
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: automationId,
          evidence: { cycle, reportDir, result: 'validation-passed', finalization },
        }, 'workflow.automation.completed', { automationId, cycle, reportDir, finalization });
        await pruneAutomationReports(config.diagnostics.reportDir, config.diagnostics.keepReports);
        return;
      }

      const failureSignature = await automationFailureSignature(validation);
      if (previousFailureSignature && failureSignature === previousFailureSignature) repeatedFailureCount += 1;
      else {
        previousFailureSignature = failureSignature;
        repeatedFailureCount = 0;
      }
      if (repeatedFailureCount >= Math.max(1, Number(config.noProgressLimit) || 3)) {
        await this.publish(runtime.id, 'workflow.no-progress', {
          automationId,
          cycle,
          repeatedFailureCount,
          message: `The same check failures remained after ${repeatedFailureCount} updates.`,
          signature: failureSignature,
        });
        await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
          runId: automationId,
          actionId: createWorkflowId('no-progress-action'),
          kind: WorkflowActionKind.NO_PROGRESS,
          reason: `The same check failures remained for ${repeatedFailureCount} updates.`,
          choices: [
            { id: 'retry', label: 'Try another repair cycle', transition: 'continue', phase: WorkflowPhase.CHECKING },
            { id: 'stop', label: 'Stop workflow', transition: 'stop' },
          ],
          references: { cycle, repeatedFailureCount, signature: failureSignature },
        }, 'workflow.no-progress.action.required', { automationId, cycle, repeatedFailureCount });
        await this.waitForAction(runtime, config.turn.approvalTimeoutMs, options.signal);
        previousFailureSignature = '';
        repeatedFailureCount = 0;
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

      let requestSessionId = options.sessionId || runtime.workflowState.run.references?.sessionId || workflow.watch.sessionId || '';
      let requestSourceClientId = options.sourceClientId || config.turn.sourceClientId || workflow.watch.clientId || runtime.boundSourceClientId || '';
      const originalRequestSessionId = requestSessionId;
      if (this.beforeRequest) {
        const prepared = await this.beforeRequest(runtime, {
          sessionId: requestSessionId,
          sourceClientId: requestSourceClientId,
          threadId,
          automationId,
          cycle,
          maxCycles,
          validation,
        });
        requestSessionId = prepared?.sessionId || requestSessionId;
        requestSourceClientId = prepared?.sourceClientId || requestSourceClientId;
      }
      if (requestSessionId && requestSessionId !== originalRequestSessionId) threadId = '';
      threadId = await this.ensureThread(runtime, threadId, { ...options, sessionId: requestSessionId });
      const diagnosticFile = config.onFailure.attachDiagnostics
        ? await this.fileStore.importLocalPath({
          filePath: bundle.bundlePath,
          name: `${runtime.id}-automation-cycle-${cycle}.zip`,
          mime: 'application/zip',
        })
        : null;
      const prompt = buildAutomationPrompt({ workflow, validation, cycle, approachInstruction: options.approachInstruction || '' });
      const promptPreconditions = createHash('sha256').update(JSON.stringify({ prompt, threadId, requestSessionId, requestSourceClientId, cycle })).digest('hex');
      const promptEffectId = `${automationId}:prompt:${cycle}`;
      const { turn } = await executeWorkflowEffect({
        transition: this.transition,
        runtime,
        effect: { id: promptEffectId, kind: WorkflowEffectKind.PROMPT, safe: false, idempotencyKey: promptEffectId, preconditionsHash: promptPreconditions, references: { threadId, cycle } },
        execute: () => this.turnManager.startTurn({
        threadId,
        message: prompt,
        cwd: workflow.projectRoot,
        sessionId: requestSessionId,
        sourceClientId: requestSourceClientId,
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
        }),
      });
      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: automationId,
        phase: WorkflowPhase.WAITING_RESPONSE,
        cycle,
        request: { turnId: turn.id },
        references: { threadId, reportDir, diagnosticFileId: diagnosticFile?.id || '' },
      }, 'workflow.automation.turn.started', { automationId, cycle, threadId, turnId: turn.id, diagnosticFileId: diagnosticFile?.id || '' });

      this.activeTurns.set(runtime.id, turn.id);
      let snapshot;
      let result;
      try {
        snapshot = await this.waitForTurn(runtime, turn.id, config.turn, options.signal);
        result = turnResult(snapshot);
        if (result.status !== 'completed') {
          const turnError = new Error(`Automation turn ${turn.id} ended with ${result.status}: ${result.turn.error?.message || result.answer.slice(0, 1_000) || 'no detail'}`);
          turnError.code = result.turn.error?.code || 'WORKFLOW_AUTOMATION_TURN_FAILED';
          turnError.answer = result.answer;
          throw turnError;
        }
      } catch (error) {
        const recovery = this.recoverSession
          ? await this.recoverSession(runtime, {
            error,
            automationId,
            cycle,
            maxCycles,
            threadId,
            validation,
            sourceClientId: requestSourceClientId,
          })
          : null;
        if (recovery?.recovered) {
          options.sessionId = recovery.sessionId;
          options.sourceClientId = recovery.sourceClientId || requestSourceClientId;
          threadId = '';
          previousFailureSignature = '';
          repeatedFailureCount = 0;
          cycle -= 1;
          continue;
        }
        if (recovery?.waitingAction) {
          const decisionError = new Error('Workflow is waiting for a session recovery decision');
          decisionError.code = 'WORKFLOW_SESSION_AWAITING_DECISION';
          throw decisionError;
        }
        throw error;
      } finally {
        if (this.activeTurns.get(runtime.id) === turn.id) this.activeTurns.delete(runtime.id);
      }
      if (!config.onFailure.applyResult) {
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: automationId,
          evidence: { cycle, reportDir, result: 'turn-completed', fileId: result.fileId },
        }, 'workflow.automation.completed', { automationId, cycle, reportDir, fileId: result.fileId });
        return;
      }
      if (!result.fileId) {
        throw new Error(`Automation turn ${turn.id} completed without the required ${config.onFailure.output.expected || 'ZIP'} artifact`);
      }

      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: automationId,
        phase: WorkflowPhase.APPLYING,
        cycle,
        request: { turnId: turn.id },
        references: { threadId, reportDir },
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
        await this.waitForAction(runtime, config.turn.approvalTimeoutMs, options.signal);
      } else if (!APPLIED_STATUSES.has(String(applyResult?.status || ''))) {
        throw new Error(`Automation result was not applied: ${JSON.stringify(applyResult)}`);
      }
      await this.publish(runtime.id, 'workflow.automation.apply.completed', {
        automationId,
        cycle,
        status: applyResult?.status || runtime.workflowState.run.phase,
      });
      await pruneAutomationReports(config.diagnostics.reportDir, config.diagnostics.keepReports);
    }
  }

  async ensureThread(runtime, threadId, options) {
    if (threadId) {
      const existing = await this.turnManager.getThread(threadId).catch(() => null);
      if (existing) return existing.id;
    }
    const config = runtime.config.automation;
    const thread = await this.turnManager.createThread({
      title: `${runtime.id} automated workflow`,
      cwd: runtime.config.projectRoot,
      sessionId: options.sessionId || runtime.workflowState.run.references?.sessionId || runtime.config.watch.sessionId || '',
      metadata: { workflowAutomation: true, workflowId: runtime.id },
    });
    return thread.id;
  }

  async waitForTurn(runtime, turnId, turnConfig, signal) {
    const started = Date.now();
    let lastStatus = '';
    while (Date.now() - started <= turnConfig.timeoutMs) {
      this.assertRunning(runtime, signal);
      const turn = await this.turnManager.getTurn(turnId);
      if (!turn) throw new Error(`Automation turn disappeared: ${turnId}`);
      const status = String(turn.status || '');
      if (status !== lastStatus) {
        lastStatus = status;
        await this.publish(runtime.id, 'workflow.automation.turn.progress', {
          automationId: runtime.workflowState.run.id,
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

  async waitForAction(runtime, timeoutMs, signal) {
    const runId = runtime.workflowState.run.id;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      this.assertRunning(runtime, signal);
      const state = runtime.workflowState;
      if (state.run.id !== runId) throw new Error(`Automation run ${runId} ended while waiting for an action: ${state.lastOutcome?.message || state.lastOutcome?.code || 'no detail'}`);
      if (state.lifecycle === WorkflowLifecycle.RUNNING && state.run.phase === WorkflowPhase.CHECKING) return state.run;
      if (![WorkflowLifecycle.WAITING_ACTION, WorkflowLifecycle.RECOVERING, WorkflowLifecycle.PAUSED, WorkflowLifecycle.RUNNING].includes(state.lifecycle)) throw new Error(`Automation run ${runId} is no longer active`);
      await sleep(Math.min(1_000, Math.max(250, runtime.config.automation.turn.pollIntervalMs)), signal);
    }
    throw new Error(`Timed out waiting for workflow action in run ${runId} after ${timeoutMs}ms`);
  }
}

async function automationFailureSignature(validation = {}) {
  const rows = [];
  for (const result of validation.failed || []) {
    const stderr = result.stderrPath ? await fs.readFile(result.stderrPath, 'utf8').catch(() => '') : '';
    const stdout = result.stdoutPath ? await fs.readFile(result.stdoutPath, 'utf8').catch(() => '') : '';
    rows.push({
      id: result.id,
      command: result.command,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      error: result.error,
      output: `${stdout}\n${stderr}`.split('\n').slice(-80).join('\n'),
    });
  }
  return JSON.stringify(rows);
}
