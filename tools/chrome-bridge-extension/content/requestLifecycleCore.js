// Pure request-lifecycle payload helpers for the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function text(value = '') {
    return String(value ?? '');
  }

  function array(value) {
    return Array.isArray(value) ? value : [];
  }

  function terminalSnapshotSignature(snapshot = {}) {
    return JSON.stringify([
      text(snapshot.turnKey),
      Number.isInteger(snapshot.turnIndex) ? snapshot.turnIndex : -1,
      text(snapshot.messageId),
      text(snapshot.phase),
      text(snapshot.answer),
      text(snapshot.thinking),
      text(snapshot.progress),
      array(snapshot.artifacts).map((artifact) => [
        text(artifact?.id),
        text(artifact?.name),
        text(artifact?.phase || artifact?.state),
        text(artifact?.url || artifact?.downloadUrl || artifact?.src),
      ]),
      Boolean(snapshot.hasFinalMessage),
      Boolean(snapshot.actionBarVisible),
      Boolean(snapshot.stopVisible),
    ]);
  }

  function terminalSnapshotPayload(request = {}, snapshot = {}, details = {}) {
    return {
      type: 'request.terminal_snapshot',
      requestId: text(request.requestId),
      answer: text(snapshot.answer || request.lastAnswer),
      thinking: text(snapshot.thinking || request.lastThinking),
      reasoningHistory: array(request.reasoningHistory),
      progress: text(snapshot.progress || request.lastProgressText),
      progressItems: array(snapshot.progressItems),
      responseBlocks: array(snapshot.responseBlocks),
      codeBlocks: array(snapshot.codeBlocks),
      codeBlockDiagnostics: array(snapshot.codeBlockDiagnostics),
      parserAudit: snapshot.parserAudit && typeof snapshot.parserAudit === 'object' ? snapshot.parserAudit : null,
      artifacts: array(snapshot.artifacts).length ? array(snapshot.artifacts) : array(request.artifacts),
      turnKey: text(snapshot.turnKey || request.assistantTurnKey),
      turnIndex: Number.isInteger(snapshot.turnIndex) ? snapshot.turnIndex : Number(request.assistantTurnIndex ?? -1),
      messageId: text(snapshot.messageId),
      modelSlug: text(snapshot.modelSlug),
      domPhase: text(snapshot.phase),
      format: text(snapshot.format),
      reason: text(snapshot.reason || details.reason),
      finishReason: text(details.finishReason || details.reason || 'terminal_observation'),
      completionEvidence: {
        stableForMs: Math.max(0, Number(details.stableForMs) || 0),
        generationIdleForMs: Math.max(0, Number(details.generationIdleForMs) || 0),
        terminalSettled: Boolean(details.terminalSettled),
        finalizationConfidence: text(details.finalizationConfidence),
        networkDone: Boolean(details.networkDone),
      },
    };
  }

  function terminalFailurePayload(request = {}, error = {}, details = {}) {
    const message = text(error?.message || error || details.message || 'Request failed');
    return {
      type: 'request.terminal_failure',
      requestId: text(request.requestId),
      code: text(error?.code || details.code || 'BROWSER_EFFECT_FAILED'),
      message,
      retryable: Boolean(error?.retryable ?? details.retryable),
      effectId: text(details.effectId),
      effectType: text(details.effectType),
      evidence: details.evidence && typeof details.evidence === 'object' ? details.evidence : null,
      phase: text(request.phase),
    };
  }

  Object.assign(globalThis, {
    ChatGptRequestLifecycleCore: Object.freeze({
      terminalSnapshotSignature,
      terminalSnapshotPayload,
      terminalFailurePayload,
    }),
  });
})();
