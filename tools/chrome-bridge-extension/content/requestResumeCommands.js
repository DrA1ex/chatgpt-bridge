// Focused request-command family. Loaded before requestCommands.js.
(() => {
  'use strict';

  function createRequestResumeCommands(deps = {}) {
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
      turnRole,
      readUserTurnPromptText,
      waitForChatPageReady,
      waitForDocumentReady,
      waitForSubmittedUserTurnAnchor,
      pagePresence,
      readIntelligenceState,
      resumeBoundaryTimeoutMs = 2_500,
    } = deps;
    const { publicRequestStatus } = deps;
    if (typeof publicRequestStatus !== 'function') throw new TypeError('Request resume commands require publicRequestStatus');

    function turnText(turn, role) {
      const value = role === 'user' && readUserTurnPromptText
        ? readUserTurnPromptText(turn)
        : String(turn?.innerText || turn?.textContent || '');
      return typeof normalizeText === 'function' ? normalizeText(value) : value.trim().replace(/\s+/g, ' ');
    }

    function projectedBoundaryEvidence(projection = {}) {
      const records = Array.from(getTurnNodes?.() || []).map((turn, index) => {
        const role = turnRole(turn);
        return { turn, index, key: String(turnKey?.(turn, index) || ''), role, text: turnText(turn, role) };
      });
      const expectedKey = String(projection.submittedUserTurnKey || '');
      const expectedText = typeof normalizeText === 'function'
        ? normalizeText(String(projection.submittedPromptText || ''))
        : String(projection.submittedPromptText || '').trim().replace(/\s+/g, ' ');
      let user = records.find((record) => record.role === 'user' && record.key === expectedKey) || null;
      let status = user ? 'matched' : '';
      if (!user && expectedText) {
        const matches = records.filter((record) => record.role === 'user' && record.key && record.text === expectedText);
        // Repeated Loop prompts can have identical text. Never rebind an
        // ambiguous message or use its position as a durable identity.
        if (matches.length === 1) {
          user = matches[0];
          status = 'rebound';
        }
      }
      if (!user) {
        return {
          status: 'missing',
          submittedUserTurnKey: expectedKey,
          submittedUserTurnIndex: Number(projection.submittedUserTurnIndex ?? -1),
          assistantTurnKey: '',
          assistantTurnIndex: -1,
          evidence: {
            expectedKey,
            expectedPromptLength: expectedText.length,
            turnCount: records.length,
            userTurnCount: records.filter((record) => record.role === 'user').length,
          },
        };
      }
      const expectedAssistantKey = String(projection.assistantTurnKey || '');
      const nextUser = records.find((record) => record.role === 'user' && record.index > user.index);
      const candidates = records.filter((record) => record.role === 'assistant' && record.key
        && record.index > user.index && (!nextUser || record.index < nextUser.index));
      const assistant = candidates.find((record) => record.key === expectedAssistantKey)
        || candidates.at(-1) || null;
      return {
        status,
        submittedUserTurnKey: user.key,
        submittedUserTurnIndex: user.index,
        assistantTurnKey: assistant?.key || '',
        assistantTurnIndex: assistant?.index ?? -1,
        evidence: {
          expectedKey,
          matchedKey: user.key,
          exactKeyMatch: user.key === expectedKey,
          promptTextMatched: Boolean(expectedText && user.text === expectedText),
          turnCount: records.length,
        },
      };
    }

    async function resolveProjectedBoundary(activeRequest, projection = {}) {
      if (!projection.submittedUserTurnKey) return {
        status: 'none',
        submittedUserTurnKey: '',
        submittedUserTurnIndex: -1,
        assistantTurnKey: '',
        assistantTurnIndex: -1,
        evidence: { reason: 'projection_has_no_submitted_user_turn' },
      };
      await waitForChatPageReady?.(activeRequest, { stage: 'request.resume', timeoutMs: 5_000, settleMs: 300 });
      const startedAt = Date.now();
      let result = projectedBoundaryEvidence(projection);
      const timeoutMs = Math.max(0, Number(resumeBoundaryTimeoutMs) || 0);
      while (result.status === 'missing' && Date.now() - startedAt < timeoutMs) {
        if (typeof delay === 'function') await delay(150);
        else await new Promise((resolve) => setTimeout(resolve, 150));
        result = projectedBoundaryEvidence(projection);
      }
      return result;
    }

    async function handleRequestResume(payload) {
      const activeRequest = getActiveRequest();
      const commandId = payload.commandId;
      const expectedRequestId = String(payload.requestId || '');
      if (!activeRequest) {
        send({ type: 'command.error', commandId, message: 'No active ChatGPT prompt is running in this tab.' });
        diagnostic('request.resume.no_active', { commandId });
        return;
      }
      if (expectedRequestId && activeRequest.requestId !== expectedRequestId) {
        send({ type: 'command.error', commandId, message: `Active prompt is ${activeRequest.requestId}, not ${expectedRequestId}.` });
        diagnostic('request.resume.request_mismatch', { commandId, expectedRequestId, activeRequestId: activeRequest.requestId });
        return;
      }

      if (payload.leaseId || payload.ownerServerInstanceId) {
        activeRequest.update('request.identity_updated', {
          commandId,
          leaseId: String(payload.leaseId || activeRequest.leaseId || ''),
          ownerServerInstanceId: String(payload.ownerServerInstanceId || activeRequest.ownerServerInstanceId || ''),
        });
      }

      const projection = payload.projection && typeof payload.projection === 'object' ? payload.projection : null;
      let boundary = {
        status: 'none', submittedUserTurnKey: '', submittedUserTurnIndex: -1,
        assistantTurnKey: '', assistantTurnIndex: -1, evidence: null,
      };
      if (projection) {
        boundary = await resolveProjectedBoundary(activeRequest, projection);
        const anchorPatch = {
          responseEpoch: Math.max(0, Number(projection.responseEpoch) || 0),
          submittedUserTurnKey: String(boundary.submittedUserTurnKey || projection.submittedUserTurnKey || ''),
          submittedUserTurnIndex: Number.isInteger(boundary.submittedUserTurnIndex)
            ? boundary.submittedUserTurnIndex
            : Number(projection.submittedUserTurnIndex ?? -1),
          assistantTurnKey: String(boundary.assistantTurnKey || ''),
          assistantTurnIndex: Number.isInteger(boundary.assistantTurnIndex) ? boundary.assistantTurnIndex : -1,
        };
        if (Number(projection.sentAt) > 0) anchorPatch.sentAt = Number(projection.sentAt);
        activeRequest.update('request.anchor_updated', anchorPatch);
        diagnostic('request.resume.projection_applied', {
          commandId,
          requestId: activeRequest.requestId,
          responseEpoch: anchorPatch.responseEpoch,
          submittedUserTurnKey: anchorPatch.submittedUserTurnKey || '',
          assistantTurnKey: anchorPatch.assistantTurnKey || '',
          boundaryStatus: boundary.status,
          boundaryEvidence: boundary.evidence,
        });
      }

      const status = publicRequestStatus(activeRequest);
      send({
        type: 'request.resumed', commandId, activeRequest: status, session: getCurrentSession(),
        url: location.href, title: document.title,
        boundaryStatus: boundary.status,
        boundaryEvidence: boundary.evidence,
        submittedUserTurnKey: boundary.submittedUserTurnKey || '',
        submittedUserTurnIndex: boundary.submittedUserTurnIndex,
        assistantTurnKey: boundary.assistantTurnKey || '',
        assistantTurnIndex: boundary.assistantTurnIndex,
      });
      diagnostic('request.resume.attached', { commandId, requestId: activeRequest.requestId, promptPreview: activeRequest.promptPreview || '' });

      // Resumption requests one fresh normalized observation. Cached fragments
      // are never replayed independently because their identity cannot be proven.
      startDomMonitor(activeRequest);
      collectAndEmit(activeRequest, 'request.resume');
    }

    return Object.freeze({
      handleRequestResume
    });
  }

  globalThis.ChatGptRequestResumeCommands = Object.freeze({ createRequestResumeCommands });
})();
