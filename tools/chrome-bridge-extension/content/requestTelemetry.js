(() => {
  'use strict';

  function createRequestTelemetry({
    diagnostic,
    findStopButton,
    getAssistantNodes,
    getCurrentSession,
    getTurnNodes,
    pagePresence,
    send,
    progressMinIntervalMs = 1500,
  } = {}) {
  function emitChatEvent(request, type, details = {}) {
    if (!request) return;
    send({
      type: 'chat.event',
      requestId: request.requestId,
      event: {
        type,
        requestId: request.requestId,
        time: new Date().toISOString(),
        url: location.href,
        title: document.title,
        ...details,
      },
    });
  }

  function markRequestProgress(request, reason = 'progress') {
    if (!request) return;
    request.lastMeaningfulProgressAt = Date.now();
    request.lastMeaningfulProgressReason = reason || 'progress';
  }

  function setRequestPhase(request, phase, details = {}) {
    if (!request || !phase || request.phase === phase) return false;
    const previousPhase = request.phase || '';
    request.phase = phase;
    markRequestProgress(request, `phase:${phase}`);
    diagnostic('request.phase', { requestId: request.requestId, phase, previousPhase, ...details });
    emitChatEvent(request, 'request.phase', { phase, previousPhase, ...details });
    emitRequestProgress(request, null, details.generating, `phase:${phase}`, { force: true, ...details });
    return true;
  }

  async function runObservedRequestEffect(request, effectType, execute, details = {}) {
    if (!request || typeof execute !== 'function') throw new Error('Observed request effect requires a request and executor');
    request.effectSequence = Number(request.effectSequence || 0) + 1;
    const effectId = `${request.requestId}:${effectType}:${request.effectSequence}`;
    const basePayload = {
      requestId: request.requestId,
      effectId,
      effectType,
      phase: request.phase || '',
      evidence: details.evidence && typeof details.evidence === 'object' ? details.evidence : null,
    };
    send({ type: 'request.effect.started', ...basePayload }, { priority: true, immediatePost: true, timeout: 5_000 });
    diagnostic('request.effect.started', basePayload);
    try {
      const result = await execute();
      send({
        type: 'request.effect.succeeded',
        ...basePayload,
        result: details.result && typeof details.result === 'function' ? details.result(result) : null,
      }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('request.effect.succeeded', basePayload);
      return result;
    } catch (error) {
      const failure = {
        type: 'request.effect.failed',
        ...basePayload,
        code: String(error?.code || details.code || 'BROWSER_EFFECT_FAILED'),
        message: String(error?.message || error || `${effectType} failed`),
        retryable: Boolean(error?.retryable ?? details.retryable),
      };
      send(failure, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('request.effect.failed', failure);
      try { error.bridgeEffectReported = true; } catch {}
      throw error;
    }
  }

  function anchorConfidenceForRequest(request, snapshot = null) {
    if (!request?.submittedUserTurnKey) return { confidence: 'none', reason: 'no_submitted_user_turn' };
    if (snapshot?.turnKey) return { confidence: 'high', reason: snapshot.reason || 'assistant_after_submitted_user' };
    return { confidence: 'medium', reason: snapshot?.reason || 'submitted_user_turn_only' };
  }

  function emitRequestProgress(request, snapshot = null, generating = undefined, reason = 'progress', options = {}) {
    if (!request || (request.finished && !options.allowFinished)) return;
    const now = Date.now();
    if (!options.force && request.lastProgressSentAt && now - request.lastProgressSentAt < progressMinIntervalMs) return;
    const presence = pagePresence();
    const safeSnapshot = snapshot || {};
    const anchor = anchorConfidenceForRequest(request, safeSnapshot);
    const stopButtonVisible = typeof generating === 'boolean' ? generating : Boolean(findStopButton());
    const answerLength = String(safeSnapshot.answer || request.lastAnswer || '').length;
    const thinkingLength = String(safeSnapshot.thinking || request.lastThinking || '').length;
    const artifactCount = Array.isArray(safeSnapshot.artifacts) ? safeSnapshot.artifacts.length : request.artifacts.length;
    const progressText = String(safeSnapshot.progress || request.lastProgressText || '');
    const stableForMs = request.stableSince ? now - request.stableSince : 0;
    const generationIdleForMs = request.generationIdleSince ? now - request.generationIdleSince : 0;
    const payload = {
      type: 'request.progress',
      requestId: request.requestId,
      phase: request.phase || 'created',
      reason,
      meaningful: options.meaningful !== false,
      url: location.href,
      title: document.title,
      session: getCurrentSession(),
      ...presence,
      submittedUserTurnKey: request.submittedUserTurnKey || '',
      submittedUserTurnIndex: request.submittedUserTurnIndex ?? -1,
      assistantTurnKey: safeSnapshot.turnKey || request.assistantTurnKey || '',
      assistantTurnIndex: safeSnapshot.turnIndex ?? request.assistantTurnIndex ?? -1,
      anchorConfidence: options.anchorConfidence || anchor.confidence,
      anchorReason: options.anchorReason || anchor.reason,
      turnCount: safeSnapshot.turnCount ?? getTurnNodes().length,
      assistantNodeCount: safeSnapshot.count ?? getAssistantNodes().length,
      stopButtonVisible,
      sawGenerating: Boolean(request.sawGenerating),
      sawAnswer: Boolean(request.sawAnswer),
      answerLength,
      thinkingLength,
      artifactCount,
      progressLength: progressText.length,
      progressText: progressText.slice(0, 240),
      networkDone: Boolean(request.networkDone),
      sendButtonVisible: Boolean(options.sendButtonVisible),
      regenerateButtonVisible: Boolean(options.regenerateButtonVisible),
      continueButtonVisible: Boolean(options.continueButtonVisible),
      steerControlVisible: Boolean(options.steerControlVisible),
      finalizationConfidence: options.finalizationConfidence || '',
      stableForMs,
      generationIdleForMs,
      lastMeaningfulProgressAt: request.lastMeaningfulProgressAt || 0,
      lastMeaningfulProgressReason: request.lastMeaningfulProgressReason || '',
      snapshotReason: safeSnapshot.reason || '',
      domPhase: safeSnapshot.phase || '',
      messageId: safeSnapshot.messageId || '',
      modelSlug: safeSnapshot.modelSlug || '',
      actionBarVisible: Boolean(safeSnapshot.actionBarVisible),
      hasFinalMessage: Boolean(safeSnapshot.hasFinalMessage),
      hasActiveTool: Boolean(safeSnapshot.hasActiveTool),
      needsConfirmation: Boolean(safeSnapshot.needsConfirmation),
      needsContinue: Boolean(safeSnapshot.needsContinue),
      domSchemaUnknownTestIds: safeSnapshot.unknownTestIds || [],
    };
    request.lastProgressSentAt = now;
    request.lastProgressSignature = JSON.stringify([payload.phase, payload.domPhase, payload.answerLength, payload.thinkingLength, payload.artifactCount, payload.progressLength, payload.submittedUserTurnKey, payload.assistantTurnKey, payload.messageId, payload.stopButtonVisible, payload.actionBarVisible, payload.visibilityState]);
    send(payload);
  }


    return Object.freeze({
      emitChatEvent,
      emitRequestProgress,
      markRequestProgress,
      runObservedRequestEffect,
      setRequestPhase,
    });
  }

  globalThis.ChatGptRequestTelemetry = Object.freeze({ createRequestTelemetry });
})();
