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
  if (typeof planEffect !== 'function' || typeof settleEffect !== 'function') {
    throw new TypeError('Request telemetry requires durable browser-effect plan and settlement adapters');
  }

  function effectPersistenceError(message, cause = null) {
    const error = new Error(message);
    error.code = 'BROWSER_EFFECT_PERSISTENCE_FAILED';
    error.cause = cause || null;
    error.bridgeEffectPersistenceFailure = true;
    error.bridgeEffectReported = true;
    return error;
  }

  function assertPersistedEffect(result, expected, status) {
    const effect = result?.effect || null;
    const valid = result?.persisted === true
      && effect
      && String(effect.effectId || '') === String(expected.effectId || '')
      && String(effect.idempotencyKey || '') === String(expected.idempotencyKey || '')
      && String(effect.requestId || '') === String(expected.requestId || '')
      && String(effect.leaseId || '') === String(expected.leaseId || '')
      && String(effect.ownerServerInstanceId || '') === String(expected.ownerServerInstanceId || '')
      && Number(effect.responseEpoch) === Number(expected.responseEpoch)
      && Number(effect.attempt) === Number(expected.attempt)
      && String(effect.preconditionsHash || '') === String(expected.preconditionsHash || '')
      && String(effect.status || '') === status;
    if (!valid) throw effectPersistenceError(`Browser effect ${expected.effectId || expected.effectType || 'unknown'} was not durably persisted as ${status}`);
    return effect;
  }

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

  async function settleUnexecutableEffect(identity = {}, effectType = '', descriptor = null, cause = null, options = {}) {
    if (!descriptor || typeof descriptor !== 'object' || descriptor.kind !== effectType
      || !descriptor.effectId || !descriptor.idempotencyKey) {
      throw effectPersistenceError(`Cannot settle unexecutable ${effectType || 'browser'} effect without its exact server descriptor`);
    }
    const basePayload = {
      requestId: String(identity.requestId || descriptor.preconditions?.requestId || ''),
      leaseId: String(identity.leaseId || descriptor.preconditions?.leaseId || ''),
      ownerServerInstanceId: String(identity.ownerServerInstanceId || descriptor.preconditions?.ownerServerInstanceId || ''),
      commandId: String(identity.commandId || ''),
      causationId: String(descriptor.causationId || identity.commandId || descriptor.effectId),
      responseEpoch: Math.max(0, Number(identity.responseEpoch ?? descriptor.responseEpoch ?? descriptor.preconditions?.responseEpoch) || 0),
      attempt: Math.max(1, Number(descriptor.attempt) || 1),
      effectId: String(descriptor.effectId),
      effectType,
      idempotencyKey: String(descriptor.idempotencyKey),
      phase: String(identity.phase || ''),
      retryPolicy: String(descriptor.retryPolicy || 'never'),
      preconditions: descriptor.preconditions && typeof descriptor.preconditions === 'object' ? descriptor.preconditions : {},
      preconditionsHash: String(descriptor.preconditionsHash || ''),
      evidence: options.evidence && typeof options.evidence === 'object' ? options.evidence : null,
    };
    try {
      const planned = await planEffect({ ...basePayload, kind: effectType });
      assertPersistedEffect(planned, basePayload, 'dispatched');
    } catch (error) {
      if (error?.bridgeEffectPersistenceFailure) throw error;
      throw effectPersistenceError(`Browser effect ${basePayload.effectId} could not be verified before non-execution settlement`, error);
    }
    const provenNotExecuted = options.provenNotExecuted === true;
    const status = provenNotExecuted ? 'cancelled' : 'uncertain';
    const error = cause instanceof Error ? cause : new Error(String(cause || `${effectType} could not be executed by content runtime`));
    const failure = {
      code: String(error.code || (provenNotExecuted ? 'BROWSER_EFFECT_CANCELLED' : 'BROWSER_EFFECT_UNCERTAIN')),
      message: String(error.message || error),
      retryable: !provenNotExecuted,
    };
    try {
      const persisted = await settleEffect({
        ...basePayload,
        status,
        error: failure,
        provenNotExecuted,
        cancellationEvidence: provenNotExecuted
          ? (options.cancellationEvidence || { source: 'content_precondition', reason: 'executor_not_entered' })
          : null,
      });
      assertPersistedEffect(persisted, basePayload, status);
    } catch (settleError) {
      if (settleError?.bridgeEffectPersistenceFailure) throw settleError;
      throw effectPersistenceError(`Browser effect ${basePayload.effectId} ${status} result was not durably committed`, settleError);
    }
    diagnostic(`request.effect.${status}`, { ...basePayload, ...failure, provenNotExecuted });
    return { status, effectId: basePayload.effectId };
  }

  async function runObservedRequestEffect(request, effectType, execute, details = {}) {
    if (!request || typeof execute !== 'function') throw new Error('Observed request effect requires a request and executor');
    const descriptor = details.effect && typeof details.effect === 'object' ? details.effect : null;
    if (!descriptor || descriptor.kind !== effectType || !descriptor.effectId || !descriptor.idempotencyKey) {
      const error = new Error(`Server execution plan is missing a valid descriptor for ${effectType}`);
      error.code = 'REQUEST_EXECUTION_PLAN_INVALID';
      throw error;
    }
    const writeEffect = descriptor.write === true;
    const basePayload = {
      requestId: request.requestId,
      leaseId: String(request.leaseId || ''),
      ownerServerInstanceId: String(request.ownerServerInstanceId || ''),
      commandId: String(request.commandId || ''),
      causationId: String(descriptor.causationId || request.commandId || descriptor.effectId),
      responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
      attempt: Math.max(1, Number(descriptor.attempt) || 1),
      effectId: String(descriptor.effectId),
      effectType,
      idempotencyKey: String(descriptor.idempotencyKey),
      phase: request.phase || '',
      retryPolicy: String(descriptor.retryPolicy || 'never'),
      preconditions: descriptor.preconditions && typeof descriptor.preconditions === 'object' ? descriptor.preconditions : {},
      preconditionsHash: String(descriptor.preconditionsHash || ''),
      evidence: details.evidence && typeof details.evidence === 'object' ? details.evidence : null,
    };
    let planned;
    try {
      planned = await planEffect({
        ...basePayload,
        kind: effectType,
      });
      assertPersistedEffect(planned, basePayload, 'dispatched');
    } catch (cause) {
      if (cause?.bridgeEffectPersistenceFailure) throw cause;
      throw effectPersistenceError(`Browser effect ${basePayload.effectId} could not be planned and dispatched durably`, cause);
    }
    send({ type: 'request.effect.started', ...basePayload }, { priority: true, immediatePost: true, timeout: 5_000 });
    diagnostic('request.effect.started', basePayload);
    let browserActionCompleted = false;
    try {
      const result = await execute({ effectId: basePayload.effectId, idempotencyKey: basePayload.idempotencyKey });
      browserActionCompleted = true;
      const publicResult = details.result && typeof details.result === 'function' ? details.result(result) : null;
      try {
        const persisted = await settleEffect({ ...basePayload, status: 'succeeded', result: publicResult });
        assertPersistedEffect(persisted, basePayload, 'succeeded');
      } catch (cause) {
        if (cause?.bridgeEffectPersistenceFailure) throw cause;
        throw effectPersistenceError(`Browser effect ${basePayload.effectId} succeeded physically but its result was not durably committed`, cause);
      }
      // The background reporter is the only extension-to-server owner of
      // terminal physical-effect results. Content waits for durable settlement
      // and returns; it must not create a second independently delivered result.
      diagnostic('request.effect.succeeded', basePayload);
      return result;
    } catch (error) {
      if (error?.bridgeEffectPersistenceFailure) {
        diagnostic('request.effect.persistence_failed', {
          ...basePayload,
          code: String(error.code || 'BROWSER_EFFECT_PERSISTENCE_FAILED'),
          message: String(error.message || error),
          browserActionCompleted,
        });
        throw error;
      }
      const cancelled = Boolean(error?.provenNotExecuted === true);
      const uncertain = !cancelled && (browserActionCompleted || writeEffect);
      const status = cancelled ? 'cancelled' : (uncertain ? 'uncertain' : 'failed');
      const failure = {
        ...basePayload,
        code: String(error?.code || details.code || (cancelled ? 'BROWSER_EFFECT_CANCELLED' : uncertain ? 'BROWSER_EFFECT_UNCERTAIN' : 'BROWSER_EFFECT_FAILED')),
        message: String(error?.message || error || `${effectType} failed`),
        retryable: Boolean(error?.retryable ?? details.retryable),
        recoverable: uncertain,
        provenNotExecuted: cancelled,
        cancellationEvidence: cancelled ? (error?.cancellationEvidence || { source: 'executor', reason: 'proved_not_executed' }) : null,
      };
      try {
        const persisted = await settleEffect({
          ...basePayload,
          status,
          error: { code: failure.code, message: failure.message, retryable: failure.retryable },
          provenNotExecuted: cancelled,
          cancellationEvidence: failure.cancellationEvidence,
        });
        assertPersistedEffect(persisted, basePayload, status);
      } catch (cause) {
        if (cause?.bridgeEffectPersistenceFailure) throw cause;
        throw effectPersistenceError(`Browser effect ${basePayload.effectId} ${status} result was not durably committed`, cause);
      }
      // Terminal failure/cancellation/uncertainty is reported from the
      // persisted background ledger, never directly from disposable content.
      diagnostic(`request.effect.${status}`, failure);
      try {
        error.bridgeEffectReported = true;
        error.bridgeEffectStatus = status;
        error.recoverable = uncertain;
        if (uncertain) error.retryable = true;
        error.evidence = {
          ...(error.evidence && typeof error.evidence === 'object' ? error.evidence : {}),
          effectId: basePayload.effectId,
          effectType,
          idempotencyKey: basePayload.idempotencyKey,
          responseEpoch: basePayload.responseEpoch,
          status,
        };
      } catch {}
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
      settleUnexecutableEffect,
      setRequestPhase,
    });
  }

  globalThis.ChatGptRequestTelemetry = Object.freeze({ createRequestTelemetry });
})();
