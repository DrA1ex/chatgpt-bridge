// Active request monitoring facade over the single tab-observation kernel.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestMonitor(deps = {}) {
    const {
      diagnostic,
      findChatMain,
      findTurnByKey,
      getActiveRequest,
      refreshRequestTurnAnchors,
      schedulePageStatus,
      scheduleTabObservation,
      send,
      setActiveRequest,
      subscribeTabObservation,
    } = deps;
    let observationSubscription = null;

    function findChatObservationRoot(request = null) {
      const anchoredTurn = findTurnByKey(request?.assistantTurnKey || request?.submittedUserTurnKey || '');
      return anchoredTurn?.closest?.('main')
        || anchoredTurn?.closest?.('[role="main"]')
        || findChatMain()
        || null;
    }

    function syncExecutionProjection(request, observation = null) {
      if (!request || !observation) return;
      const active = observation.activeRequest;
      if (active?.requestId && active.requestId !== request.requestId) return;
      const submittedUserTurnKey = String(request.submittedUserTurnKey || '');
      const observedUserTurnKey = String(observation.turn?.userKey || '');
      const observedAssistantTurnKey = String(observation.turn?.key || '');
      const observedUserTurnIndex = Number(observation.turn?.userIndex ?? -1);
      const observedAssistantTurnIndex = Number(observation.turn?.index ?? -1);
      const boundaryMatches = Boolean(
        submittedUserTurnKey
        && observedUserTurnKey === submittedUserTurnKey
        && (!Number.isInteger(request.submittedUserTurnIndex)
          || request.submittedUserTurnIndex < 0
          || observedUserTurnIndex < 0
          || observedUserTurnIndex === request.submittedUserTurnIndex)
        && (observedAssistantTurnIndex < 0
          || observedUserTurnIndex < 0
          || observedAssistantTurnIndex > observedUserTurnIndex)
      );
      if (boundaryMatches && observedAssistantTurnKey && observedAssistantTurnKey !== request.assistantTurnKey) {
        request.update('request.anchor_updated', {
          assistantTurnKey: observedAssistantTurnKey,
          assistantTurnIndex: observedAssistantTurnIndex,
        });
      }
      request.update('request.observation_cursor_updated', {
        lastObservationRevision: Number(observation.revision) || 0,
        lastObservationEpoch: String(observation.observerId || ''),
        lastObservationAt: Number(observation.observedAt) || Date.now(),
      });
    }

    function ensureObservationSubscription() {
      if (observationSubscription) return;
      observationSubscription = subscribeTabObservation?.((observation) => {
        const request = getActiveRequest();
        if (!request) return;
        syncExecutionProjection(request, observation);
      }) || null;
    }

    function attachDomObserver(request) {
      const root = findChatObservationRoot(request);
      ensureObservationSubscription();
      diagnostic(root ? 'dom_monitor.shared_kernel_attached' : 'dom_schema.chat_root_missing', {
        requestId: String(request?.requestId || ''),
        tagName: root?.tagName || '',
        testId: root?.getAttribute?.('data-testid') || '',
        sharedObservationKernel: true,
      });
      return Boolean(root);
    }

    function scheduleCollect(request, reason = 'request.changed', delayMs = 0) {
      if (!request || getActiveRequest()?.requestId !== request.requestId) return;
      scheduleTabObservation(reason, delayMs);
    }

    function collectAndEmit(request, reason = 'request.changed') {
      if (!request || getActiveRequest()?.requestId !== request.requestId) return;
      if (request.turnCaptureArmed) refreshRequestTurnAnchors(request);
      scheduleTabObservation(reason, 0);
    }

    function startDomMonitor(request) {
      attachDomObserver(request);
      scheduleCollect(request, 'request.monitor.started', 0);
      diagnostic('dom_monitor.started', { requestId: String(request?.requestId || ''), sharedObservationKernel: true });
    }

    // Failures in content are execution evidence, never terminal request decisions.
    function reportExecutionFailure(request, error, details = {}) {
      if (!request) return false;
      const effectType = String(details.effectType || 'content.execution');
      const effectId = String(details.effectId || `${request.requestId}:${effectType}:unscoped`);
      const payload = {
        type: 'request.effect.failed',
        requestId: request.requestId,
        effectId,
        effectType,
        code: String(details.code || error?.code || 'BROWSER_EFFECT_FAILED'),
        message: String(error?.message || error || `${effectType} failed`),
        retryable: Boolean(details.retryable ?? error?.retryable),
        evidence: details.evidence && typeof details.evidence === 'object' ? details.evidence : null,
      };
      diagnostic('request.execution_failed', payload);
      send(payload, { priority: true, immediatePost: true, timeout: 5_000 });
      scheduleTabObservation('request.execution_failed', 0);
      return true;
    }

    function releaseRequest(request, reason = 'server_release') {
      if (!request || getActiveRequest()?.requestId !== request.requestId) return false;
      setActiveRequest(null);
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation('request.released', 0);
      diagnostic('request.released', { requestId: request.requestId, reason, owner: 'server_canonical_release' });
      return true;
    }

    return Object.freeze({
      attachDomObserver,
      collectAndEmit,
      findChatObservationRoot,
      releaseRequest,
      reportExecutionFailure,
      scheduleCollect,
      startDomMonitor,
    });
  }

  globalThis.ChatGptRequestMonitor = Object.freeze({ createRequestMonitor });
})();
