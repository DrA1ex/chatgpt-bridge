import { rememberResponse, saveInteractiveState } from './runtime.js';

export async function runGuidedWorkflow(runtime, message, workflow) {
  if (!runtime.options.bridge.health().ok && !runtime.options.bridge.canAutoOpenPromptTab?.()) {
    return runtime.pushEntry({ kind: 'error', title: 'Not connected', body: 'No ChatGPT browser extension is connected. Use /connect, or restart with --auto-open-tab.' });
  }
  const controller = new AbortController();
  const health = runtime.options.bridge.health();
  let sourceClientId = workflow.clientId || health.activeClient?.id || '';
  let sessionId = workflow.sessionId || workflow.boundSessionId || runtime.state.sessionId || '';
  const attachments = runtime.state.pendingAttachments.map((file) => file.id);
  runtime.abortController = controller;
  runtime.busy = true;
  runtime.phase = 'guided workflow';
  runtime.clearLive();
  runtime.resetActivity();
  runtime.chatProgressState = { records: {} };
  runtime.pushEntry({ kind: 'user', title: 'You', subtitle: `workflow: ${workflow.label || workflow.id}`, body: message });
  try {
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const prepared = await runtime.options.workflowManager.prepareWorkflowRequest(workflow.id, { sessionId, sourceClientId });
        sessionId = prepared.sessionId || sessionId;
        sourceClientId = prepared.sourceClientId || sourceClientId;
        await runtime.options.workflowManager.refreshProjectContext(workflow.id, { sessionId, sourceClientId });
        response = await runtime.options.bridge.sendRequest({
          message,
          sessionId,
          sourceClientId,
          model: runtime.state.model,
          effort: runtime.state.effort,
          attachments,
          fullResponse: true,
        }, {
          onEvent: (event) => runtime.onChatEvent(event),
          onThinkingUpdate: (value) => { runtime.thinking = value || ''; runtime.invalidate(); },
          onProgressUpdate: (value) => { runtime.progress = value || ''; runtime.invalidate(); },
          onAnswerUpdate: (value) => runtime.updateAssistantStream(value || ''),
          onArtifactUpdate: (artifacts) => runtime.onArtifactUpdate(artifacts),
        }, {
          signal: controller.signal,
          fullResponse: true,
          confirmClientSelection: ({ message: question }) => runtime.context.confirm(question),
        });
        break;
      } catch (error) {
        const current = runtime.options.workflowManager.get(workflow.id);
        if (current?.attention?.required) {
          await runtime.workflowWizard.openForWorkflow(workflow.id);
          return;
        }
        if (attempt > 0) throw error;
        const recovery = await runtime.options.workflowManager.recoverWorkflowSession(workflow.id, { error, sourceClientId });
        if (recovery?.attention) {
          await runtime.workflowWizard.openForWorkflow(workflow.id);
          return;
        }
        if (!recovery?.recovered) throw error;
        sessionId = recovery.sessionId;
        sourceClientId = recovery.sourceClientId || sourceClientId;
      }
    }
    if (!response) throw new Error('Guided workflow did not receive a ChatGPT response');
    if (response.session?.id) runtime.state.sessionId = response.session.id;
    if (Array.isArray(response.artifacts)) runtime.state.lastArtifacts = response.artifacts;
    runtime.state.pendingAttachments = [];
    const finalAnswer = String(response.answer || response.response || '');
    rememberResponse(runtime.state, {
      id: response.requestId || response.id || '',
      source: 'guided-workflow',
      title: `Guided task · ${workflow.label || workflow.id}`,
      text: finalAnswer,
      artifactCount: response.artifacts?.length || 0,
      createdAt: response.createdAt,
    });
    runtime.flushActivitySummary();
    runtime.completeAssistantStream(finalAnswer || '(empty answer)');
    runtime.clearLive();
    if (response.artifacts?.length) {
      runtime.pushEntry({
        kind: 'artifact',
        title: `Returned files (${response.artifacts.length})`,
        body: response.artifacts.map((artifact, index) => `[${index + 1}] ${artifact.name || artifact.filename || artifact.id || 'artifact'}`).join('\n'),
      });
    }
    await saveInteractiveState(runtime.state).catch(() => {});
    if (response.artifacts?.length) {
      await runtime.options.workflowManager.processResponse(workflow.id, response, {
        source: 'guided-task',
        remediationAttempt: 0,
      });
    }
    const latest = runtime.options.workflowManager.get(workflow.id) || workflow;
    if (latest.attention?.required) await runtime.workflowWizard.openForWorkflow(workflow.id);
    else runtime.workflowWizard.showGuidedResponse(latest, response);
  } catch (error) {
    runtime.failAssistantStream('Assistant · interrupted');
    runtime.flushActivitySummary();
    runtime.pushEntry({ kind: 'error', title: 'Guided task failed', body: error.message });
    await saveInteractiveState(runtime.state).catch(() => {});
  } finally {
    runtime.abortController = null;
    runtime.busy = false;
    runtime.phase = 'idle';
    runtime.invalidate();
  }
}
