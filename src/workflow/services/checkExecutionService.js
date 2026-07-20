import path from 'node:path';
import { createHash } from 'node:crypto';
import { runWorkflowCommands } from '../commandRunner.js';
import { boundedText, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { executeLocalEffect } from '../state/localEffects.js';
import {
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  WorkflowRunKind,
} from '../state/workflowState.js';

export class WorkflowCheckExecutionService {
  constructor({ transition, publish, runCommands = runWorkflowCommands } = {}) {
    if (typeof transition !== 'function') throw new Error('WorkflowCheckExecutionService requires transition');
    if (typeof publish !== 'function') throw new Error('WorkflowCheckExecutionService requires publish');
    this.transition = transition;
    this.publish = publish;
    this.runCommands = runCommands;
  }

  async run(runtime) {
    const commands = runtime.config.automation?.steps?.map((item) => item.command).filter(Boolean)
      || runtime.config.apply?.commands || [];
    if (!commands.length) return { ok: true, results: [], reason: 'no-checks' };

    let ownedRun = false;
    if (runtime.workflowState.lifecycle === WorkflowLifecycle.READY) {
      ownedRun = true;
      await this.transition(runtime, WorkflowEventType.RUN_STARTED, {
        runId: createWorkflowId('run'),
        kind: WorkflowRunKind.MANUAL,
        phase: WorkflowPhase.CHECKING,
        references: { trigger: 'manual-checks' },
      });
    }

    const timeoutMs = runtime.config.apply?.timeoutMs || 20 * 60_000;
    const projectRoot = path.resolve(runtime.config.projectRoot);
    const preconditionsHash = createHash('sha256').update(JSON.stringify({ projectRoot, commands, timeoutMs })).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:checks:${preconditionsHash.slice(0, 16)}`;
    await this.publish(runtime.id, 'workflow.checks.started', { commands, effectId });

    try {
      const result = await executeLocalEffect({
        transition: this.transition,
        runtime,
        effect: {
          id: effectId,
          kind: WorkflowLocalEffectKind.CHECKS,
          safe: true,
          idempotencyKey: `${runtime.workflowState.run.id}:checks:${preconditionsHash}`,
          preconditionsHash,
          references: { commands, projectRoot },
        },
        execute: async () => await this.runCommands(commands, {
          cwd: runtime.config.projectRoot,
          timeoutMs,
          onOutput: (stream, output) => this.publish(runtime.id, 'workflow.checks.output', {
            stream,
            output: boundedText(output, 4_000),
          }),
        }),
      });
      await this.publish(runtime.id, 'workflow.checks.completed', {
        ok: result.ok,
        effectId,
        results: result.results.map((item) => ({
          command: item.command,
          ok: item.ok,
          code: item.code,
          durationMs: item.durationMs,
        })),
      });
      if (ownedRun) {
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: runtime.workflowState.run.id,
          code: result.ok ? 'checks_passed' : 'checks_failed',
          message: result.ok ? 'Checks passed' : 'Checks completed with failures',
          evidence: { effectId, ok: result.ok },
        });
      }
      return result;
    } catch (error) {
      if (ownedRun && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) {
        await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
          runId: runtime.workflowState.run.id,
          code: error.code || 'checks_failed',
          message: error.message || String(error),
          evidence: { effectId },
        }).catch(() => {});
      }
      throw error;
    }
  }
}
