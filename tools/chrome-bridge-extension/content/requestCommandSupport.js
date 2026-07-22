// Focused request-command family. Loaded before requestCommands.js.
(() => {
  'use strict';

  function createRequestCommandSupport(deps = {}) {
    const {
      DOM_PARSER,
      REQUEST_STATE,
      applyModelOptions,
      applySessionOptions,
      attachFiles,
      baselinePassiveTurns,
      clickStopButton,
      collectAndEmit,
      conversationIdFromUrl,
      delay,
      diagnostic,
      emitChatEvent,
      enterPrompt,
      findStopButton,
      findComposer,
      findComposerRootStrict,
      getActiveRequest,
      getAssistantNodes,
      getConnectedServerInstanceId,
      getCurrentSession,
      getTurnNodes,
      isGenerating,
      markRequestProgress,
      normalizeText,
      refreshRequestTurnAnchors,
      registerPassivePromptBoundary,
      releaseRequest,
      settleEffectReconciliation,
      settleReleaseCleanup,
      runObservedRequestEffect,
      settleUnexecutableEffect,
      schedulePageStatus,
      schedulePassiveTurnScan,
      scheduleTabObservation,
      send,
      setActiveRequest,
      setRequestPhase,
      simpleHash,
      startDomMonitor,
      turnKey,
      waitForChatPageReady,
      waitForDocumentReady,
      waitForSubmittedUserTurnAnchor,
      pagePresence,
      readIntelligenceState,
      resumeBoundaryTimeoutMs = 2_500,
    } = deps;
    function effectIdentity(payload = {}, request = null) {
      const descriptor = payload.effect && typeof payload.effect === 'object' ? payload.effect : null;
      return {
        requestId: String(payload.requestId || request?.requestId || descriptor?.preconditions?.requestId || ''),
        leaseId: String(payload.leaseId || request?.leaseId || descriptor?.preconditions?.leaseId || ''),
        ownerServerInstanceId: String(payload.ownerServerInstanceId || request?.ownerServerInstanceId || descriptor?.preconditions?.ownerServerInstanceId || ''),
        responseEpoch: Math.max(0, Number(payload.responseEpoch ?? request?.responseEpoch ?? descriptor?.responseEpoch ?? descriptor?.preconditions?.responseEpoch) || 0),
        commandId: String(payload.commandId || request?.commandId || ''),
        phase: String(request?.phase || ''),
      };
    }

    async function settleEffectCommandWithoutExecution(payload, effectType, descriptor, error, options = {}) {
      try {
        await settleUnexecutableEffect(
          effectIdentity(payload, options.request || null),
          effectType,
          descriptor,
          error,
          {
            provenNotExecuted: options.provenNotExecuted === true,
            evidence: {
              source: 'content_command_precondition',
              activeRequestId: String(options.request?.requestId || ''),
              ...(options.evidence && typeof options.evidence === 'object' ? options.evidence : {}),
            },
          },
        );
      } catch (settleError) {
        diagnostic('request.effect.non_execution_settlement_failed', {
          commandId: String(payload.commandId || ''),
          requestId: String(payload.requestId || ''),
          effectType,
          effectId: String(descriptor?.effectId || ''),
          code: String(settleError?.code || 'BROWSER_EFFECT_PERSISTENCE_FAILED'),
          message: String(settleError?.message || settleError),
        });
      }
    }

    return Object.freeze({
      effectIdentity,
      settleEffectCommandWithoutExecution
    });
  }

  globalThis.ChatGptRequestCommandSupport = Object.freeze({ createRequestCommandSupport });
})();
