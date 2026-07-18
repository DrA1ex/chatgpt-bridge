import { createHash } from 'node:crypto';
import { buildResultRepairPrompt } from '../result/resultProtocol.js';
import { WorkflowActionKind, WorkflowEffectKind, WorkflowEventType, WorkflowPhase } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { tailLines, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { workflowRequestEffort } from '../support/workflowIntelligence.js';

export class WorkflowResultRepairService {
  constructor({ bridge, transition, publish, processResponse, prepareRequest = null } = {}) {
    this.bridge = bridge;
    this.transition = transition;
    this.publish = publish;
    this.processResponse = processResponse;
    this.prepareRequest = typeof prepareRequest === 'function' ? prepareRequest : null;
  }

  async requestManual(runtime) {
    const reasons = runtime.lastError ? [runtime.lastError] : ['The previous result package did not match the Bridge result protocol.'];
    const sessionId = runtime.lastSessionId || runtime.boundSessionId || runtime.config.watch.sessionId || '';
    const sourceClientId = runtime.lastSourceClientId || runtime.boundSourceClientId || runtime.config.watch.clientId || '';
    if (!sessionId) throw new Error('Cannot request a corrected result because this workflow is not attached to a ChatGPT chat');
    await this.publish(runtime.id, 'workflow.result.repair.manual.started', { reasons, sessionId });
    const prepared = this.prepareRequest ? await this.prepareRequest(runtime, { sessionId, sourceClientId }) : { sessionId, sourceClientId };
    const response = await this.#sendPrompt(runtime, 'manual-repair', {
      message: buildResultRepairPrompt({ workflow: runtime.config, reasons, attempt: 1, maxAttempts: Math.max(1, runtime.config.resultProtocol?.repairAttempts || 1) }),
      sessionId: prepared.sessionId || sessionId,
      sourceClientId: prepared.sourceClientId || sourceClientId,
      effort: workflowRequestEffort(runtime.config),
      // WorkflowManager owns artifact discovery, download, and verification.
      // Do not start a second browser-side required-artifact settle timer here.
      output: { expected: 'zip', required: false },
      fullResponse: true,
    });
    return await this.processResponse(runtime.id, response, { source: 'manual-result-repair', invalidResponseAttempt: 0 });
  }

  async remediate(runtime, state, error, attempt) {
    const workflow = runtime.config;
    const output = error.commandResults?.map((item) => `${item.command}\n${item.stdout || ''}\n${item.stderr || ''}`).join('\n\n') || error.message;
    const prompt = [
      'The project artifact was downloaded and applied transactionally, but the configured validation commands failed. The project was rolled back.',
      `This is remediation attempt ${attempt} of ${workflow.remediation.maxAttempts}.`,
      '',
      'Fix the project based on the validation output below and return a new downloadable ZIP containing the full updated project at the archive root.',
      'Do not return only a patch. Preserve unrelated project files.',
      '',
      'VALIDATION_OUTPUT_BEGIN',
      tailLines(output || error.message, workflow.remediation.outputTailLines),
      'VALIDATION_OUTPUT_END',
    ].join('\n');
    await this.publish(runtime.id, 'workflow.remediation.prompt.started', { pipelineId: state.pipelineId, attempt, sessionId: state.response.session?.id || state.response.sessionId || '' });
    const sameChat = workflow.remediation.sameChat !== false;
    const requestedSessionId = sameChat ? (state.response.session?.id || state.response.sessionId || workflow.watch.sessionId || '') : '';
    const requestedSourceClientId = state.response.sourceClientId || workflow.watch.clientId || '';
    const prepared = sameChat && this.prepareRequest
      ? await this.prepareRequest(runtime, { sessionId: requestedSessionId, sourceClientId: requestedSourceClientId })
      : { sessionId: requestedSessionId, sourceClientId: requestedSourceClientId };
    const response = await this.#sendPrompt(runtime, `remediation-${attempt}`, {
      message: prompt,
      sessionId: prepared.sessionId || requestedSessionId,
      sourceClientId: prepared.sourceClientId || requestedSourceClientId,
      newSession: !sameChat,
      effort: workflowRequestEffort(runtime.config),
      // WorkflowManager owns artifact discovery, download, and verification.
      // Do not start a second browser-side required-artifact settle timer here.
      output: { expected: 'zip', required: false },
      fullResponse: true,
    });
    await this.publish(runtime.id, 'workflow.remediation.response.completed', { attempt, artifactCount: response.artifacts?.length || 0, turnKey: response.turnKey || '' });
    return await this.processResponse(runtime.id, response, { source: 'remediation', remediationAttempt: attempt, pipelineId: state.pipelineId });
  }

  async maybeRepair(runtime, response, { pipelineId, reasons = [], context = {} } = {}) {
    const protocol = runtime.config.resultProtocol || {};
    const action = protocol.repairAction || runtime.config.ux?.invalidResponseAction || 'ask';
    const previousAttempt = Math.max(0, Number(context.invalidResponseAttempt) || 0);
    const maxAttempts = Math.max(0, Number(protocol.repairAttempts) || 0);
    if (action !== 'repair') return null;
    if (previousAttempt >= maxAttempts) {
      await this.publish(runtime.id, 'workflow.result.repair.exhausted', { pipelineId, attempt: previousAttempt, maxAttempts, reasons, action });
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        runId: runtime.workflowState.run.id,
        actionId: createWorkflowId('invalid-result-action'),
        kind: WorkflowActionKind.INVALID_RESULT,
        reason: reasons.join('; ') || 'The returned result is still invalid after repair attempts.',
        choices: [
          { id: 'retry', label: 'Wait for another corrected result', transition: 'recover' },
          { id: 'stop', label: 'Stop workflow', transition: 'stop' },
        ],
        references: { attempt: previousAttempt, maxAttempts, reasons },
      }, 'workflow.result.repair.action.required', { pipelineId, attempt: previousAttempt, maxAttempts, reasons });
      return { status: 'waiting_action' };
    }
    const attempt = previousAttempt + 1;
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: runtime.workflowState.run.id,
      phase: WorkflowPhase.REMEDIATING,
      references: { invalidResponseAttempt: attempt, reasons },
    }, 'workflow.result.repair.started', { pipelineId, attempt, maxAttempts, reasons });
    const requestedSessionId = response.session?.id || response.sessionId || runtime.config.watch.sessionId || runtime.boundSessionId || '';
    const requestedSourceClientId = response.sourceClientId || runtime.config.watch.clientId || runtime.boundSourceClientId || '';
    const prepared = this.prepareRequest
      ? await this.prepareRequest(runtime, { sessionId: requestedSessionId, sourceClientId: requestedSourceClientId })
      : { sessionId: requestedSessionId, sourceClientId: requestedSourceClientId };
    const repairResponse = await this.#sendPrompt(runtime, `invalid-result-${attempt}`, {
      message: buildResultRepairPrompt({ workflow: runtime.config, reasons, attempt, maxAttempts }),
      sessionId: prepared.sessionId || requestedSessionId,
      sourceClientId: prepared.sourceClientId || requestedSourceClientId,
      effort: workflowRequestEffort(runtime.config),
      // WorkflowManager owns artifact discovery, download, and verification.
      // Do not start a second browser-side required-artifact settle timer here.
      output: { expected: 'zip', required: false },
      fullResponse: true,
    });
    await this.publish(runtime.id, 'workflow.result.repair.response', { pipelineId, attempt, artifactCount: repairResponse.artifacts?.length || 0, turnKey: repairResponse.turnKey || '' });
    return await this.processResponse(runtime.id, repairResponse, { ...context, source: 'invalid-result-repair', pipelineId, invalidResponseAttempt: attempt });
  }

  async #sendPrompt(runtime, key, request) {
    if (!runtime.workflowState.run?.id) return await this.bridge.sendRequest(request);
    const preconditionsHash = createHash('sha256').update(JSON.stringify({
      message: request.message,
      sessionId: request.sessionId || '',
      sourceClientId: request.sourceClientId || '',
    })).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:prompt:${key}`;
    return await executeWorkflowEffect({
      transition: this.transition,
      runtime,
      effect: { id: effectId, kind: WorkflowEffectKind.PROMPT, safe: false, idempotencyKey: effectId, preconditionsHash },
      execute: () => this.bridge.sendRequest(request),
    });
  }
}
