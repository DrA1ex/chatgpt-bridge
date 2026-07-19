(() => {
  'use strict';

  function createRequestTelemetry({
    diagnostic,
    findStopButton,
    getAssistantNodes,
    getCurrentSession,
    getTurnNodes,
    pagePresence,
    planEffect,
    send,
    settleEffect,
    progressMinIntervalMs = 1500,
  } = {}) {
  function emitChatEvent(request, type, details = {}) {
    if (!request) return;
    diagnostic(`chat.${String(type || 'event')}`, {
      requestId: request.requestId,
      eventType: String(type || 'event'),
      ...details,
    });
  }

  function markRequestProgress(request, reason = 'progress') {
    if (!request) return;
    request.update('request.diagnostic_updated', {
      lastMeaningfulProgressAt: Date.now(),
      lastMeaningfulProgressReason: reason || 'progress',
    });
  }

  function setRequestPhase(request, phase, details = {}) {
    if (!request || !phase || request.phase === phase) return false;
    const previousPhase = request.phase || '';
    request.update('request.executor_updated', { phase });
    markRequestProgress(request, `phase:${phase}`);
    diagnostic('request.phase', { requestId: request.requestId, phase, previousPhase, ...details });
    emitChatEvent(request, 'request.phase', { phase, previousPhase, ...details });
    emitRequestProgress(request, null, details.generating, `phase:${phase}`, { force: true, ...details });
    return true;
  }

  async function runObservedRequestEffect(request, effectType, execute, details = {}) {
    if (!request || typeof execute !== 'function') throw new Error('Observed request effect requires a request and executor');
    const effectSequence = Number(request.effectSequence || 0) + 1;
    request.update('request.executor_updated', { effectSequence });
    const effectId = `${request.requestId}:${effectType}:${effectSequence}`;
    const idempotencyKey = effectId;
    const writeEffect = details.write === true
      || /(?:prompt\.|attachments\.|session\.apply|model\.apply|artifact|download|cancel)/.test(effectType);
    const retryPolicy = details.retryPolicy || (writeEffect ? 'if_unconfirmed' : 'always');
    const preconditions = details.preconditions || {
      url: location.href,
      conversationId: String(getCurrentSession()?.id || ''),
      ownerServerInstanceId: String(request.ownerServerInstanceId || ''),
      leaseId: String(request.leaseId || ''),
    };
    const basePayload = {
      requestId: request.requestId,
      effectId,
      effectType,
      idempotencyKey,
      phase: request.phase || '',
      retryPolicy,
      preconditions,
      evidence: details.evidence && typeof details.evidence === 'object' ? details.evidence : null,
    };
    await planEffect?.({
      ...basePayload,
      kind: effectType,
    });
    send({ type: 'request.effect.started', ...basePayload }, { priority: true, immediatePost: true, timeout: 5_000 });
    diagnostic('request.effect.started', basePayload);
    let browserActionCompleted = false;
    try {
      const result = await execute({ effectId, idempotencyKey });
      browserActionCompleted = true;
      const publicResult = details.result && typeof details.result === 'function' ? details.result(result) : null;
      await settleEffect?.({ ...basePayload, status: 'succeeded', result: publicResult });
      send({
        type: 'request.effect.succeeded',
        ...basePayload,
        result: publicResult,
      }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('request.effect.succeeded', basePayload);
      return result;
    } catch (error) {
      const uncertain = browserActionCompleted || writeEffect;
      const failure = {
        type: uncertain ? 'request.effect.uncertain' : 'request.effect.failed',
        ...basePayload,
        code: String(error?.code || details.code || (uncertain ? 'BROWSER_EFFECT_UNCERTAIN' : 'BROWSER_EFFECT_FAILED')),
        message: String(error?.message || error || `${effectType} failed`),
        retryable: Boolean(error?.retryable ?? details.retryable),
        recoverable: uncertain,
      };
      await settleEffect?.({ ...basePayload, status: uncertain ? 'uncertain' : 'failed', error: { code: failure.code, message: failure.message, retryable: failure.retryable } }).catch(() => {});
      send(failure, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic(uncertain ? 'request.effect.uncertain' : 'request.effect.failed', failure);
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
    if (!request) return;
    const now = Date.now();
    if (!options.force && request.lastProgressSentAt && now - request.lastProgressSentAt < progressMinIntervalMs) return;
    const presence = pagePresence();
    const safeSnapshot = snapshot || {};
    const anchor = anchorConfidenceForRequest(request, safeSnapshot);
    const stopButtonVisible = typeof generating === 'boolean' ? generating : Boolean(findStopButton());
    const answerLength = String(safeSnapshot.answer || '').length;
    const thinkingLength = String(safeSnapshot.thinking || '').length;
    const artifactCount = Array.isArray(safeSnapshot.artifacts) ? safeSnapshot.artifacts.length : 0;
    const progressText = String(safeSnapshot.progress || '');
    const stableForMs = Math.max(0, Number(safeSnapshot.stableForMs) || 0);
    const generationIdleForMs = Math.max(0, Number(safeSnapshot.generationIdleForMs) || 0);
    const payload = {
      type: 'request.execution.diagnostic',
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
      sawGenerating: Boolean(safeSnapshot.sawGenerating),
      sawAnswer: Boolean(safeSnapshot.answer),
      answerLength,
      thinkingLength,
      artifactCount,
      progressLength: progressText.length,
      progressText: progressText.slice(0, 240),
      networkDone: Boolean(safeSnapshot.networkDone),
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
    request.update('request.diagnostic_updated', { lastProgressSentAt: now });
    diagnostic('request.execution_progress', payload);
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
