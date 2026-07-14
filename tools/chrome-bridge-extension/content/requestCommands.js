// Browser request command handlers and request-local state creation.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestCommands(deps = {}) {
    const {
      DOM_PARSER,
      REQUEST_LIFECYCLE_CORE,
      applyModelOptions,
      applySessionOptions,
      attachFiles,
      baselinePassiveTurns,
      clickStopButton,
      collectAndEmit,
      conversationIdFromUrl,
      diagnostic,
      emitChatEvent,
      enterPrompt,
      findStopButton,
      getActiveRequest,
      getAssistantNodes,
      getConnectedServerInstanceId,
      getCurrentSession,
      getTurnNodes,
      isGenerating,
      markRequestProgress,
      refreshRequestTurnAnchors,
      releaseRequest,
      reportTerminalFailure,
      runObservedRequestEffect,
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
    } = deps;

    function handleRequestResume(payload) {
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
  
      const status = publicRequestStatus(activeRequest);
      send({ type: 'request.resumed', commandId, activeRequest: status, session: getCurrentSession(), url: location.href, title: document.title });
      diagnostic('request.resume.attached', { commandId, requestId: activeRequest.requestId, promptPreview: activeRequest.promptPreview || '' });
  
      // The original bridge process may have already missed earlier snapshots.
      // Re-emit the current cached state immediately before returning to normal
      // DOM polling, even if the text has not changed since the last local poll.
      if (activeRequest.lastThinking) send({ type: 'thinking.snapshot', requestId: activeRequest.requestId, text: activeRequest.lastThinking });
      if (activeRequest.lastAnswer) send({ type: 'answer.snapshot', requestId: activeRequest.requestId, text: activeRequest.lastAnswer });
      if (activeRequest.artifacts?.length) send({ type: 'artifact.snapshot', requestId: activeRequest.requestId, artifacts: activeRequest.artifacts });
      collectAndEmit(activeRequest);
    }
  
    async function handlePromptSend(payload) {
      let activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      const message = String(payload.message || '');
      const options = payload.options || {};
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  
      if (!requestId) return;
      if (!message.trim() && !attachments.length) {
        send(REQUEST_LIFECYCLE_CORE.terminalFailurePayload(
          { requestId, phase: 'prompt_rejected' },
          { code: 'EMPTY_PROMPT', message: 'Empty prompt and no attachments received' },
        ), { priority: true, immediatePost: true, timeout: 5_000 });
        return;
      }
  
      if (activeRequest) {
        if (activeRequest.requestId === requestId) {
          const status = publicRequestStatus(activeRequest);
          send({ type: 'prompt.accepted', requestId, duplicate: true }, { priority: true, immediatePost: true, timeout: 5_000 });
          send({ type: 'request.progress', requestId, ...status, meaningful: false, reason: 'duplicate_prompt_delivery' });
          diagnostic('prompt.duplicate_ignored', { requestId, phase: activeRequest.phase || 'active' });
          return;
        }
        send(REQUEST_LIFECYCLE_CORE.terminalFailurePayload(
          { requestId, phase: 'prompt_rejected' },
          { code: 'TAB_BUSY', message: `Another prompt is active: ${activeRequest.requestId}` },
          { evidence: { activeRequestId: activeRequest.requestId } },
        ), { priority: true, immediatePost: true, timeout: 5_000 });
        diagnostic('prompt.rejected_busy', { requestId, activeRequestId: activeRequest.requestId, ownerServerInstanceId: activeRequest.ownerServerInstanceId || '' });
        return;
      }
  
      const request = createRequestState(requestId, options, payload.serverInstanceId || getConnectedServerInstanceId());
      setActiveRequest(request);
      activeRequest = request;
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation('request.activated', 0);
  
      try {
        send({ type: 'prompt.accepted', requestId }, { priority: true, immediatePost: true, timeout: 5_000 });
        setRequestPhase(request, 'prompt_accepted_by_content_script', { meaningful: true });
        diagnostic('prompt.accepted', { requestId });
        emitChatEvent(request, 'prompt.accepted');
  
        await runObservedRequestEffect(request, 'page.ready.initial', async () => {
          await waitForDocumentReady();
          await waitForChatPageReady(request, { stage: 'initial' });
        });
        await runObservedRequestEffect(request, 'session.apply', async () => {
          await applySessionOptions(options, request);
          await waitForChatPageReady(request, { stage: 'session' });
        });
        await runObservedRequestEffect(request, 'model.apply', async () => {
          await applyModelOptions(options, request);
          await waitForChatPageReady(request, { stage: 'model', settleMs: 400 });
        });
  
        request.baselineAssistantCount = getAssistantNodes().length;
        request.baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean));
        request.promptHash = simpleHash(message);
        request.promptPreview = message.slice(0, 160);
        request.turnBaselineReady = true;
        startDomMonitor(request);
        send({ type: 'session.snapshot', requestId, session: getCurrentSession() }, { priority: true, immediatePost: true, timeout: 5_000 });
        emitChatEvent(request, 'session.snapshot', { session: getCurrentSession() });
  
        if (attachments.length) {
          setRequestPhase(request, 'attachments_uploading', { attachmentCount: attachments.length });
          await runObservedRequestEffect(request, 'attachments.upload', async () => {
            await attachFiles(attachments, request);
          }, { evidence: { attachmentCount: attachments.length } });
        }
  
        // Arm turn capture only at the actual submission boundary. Foreground,
        // pageshow and MutationObserver resyncs can run while session/model/file
        // setup is still in progress; allowing them to adopt turns earlier binds a
        // new local request to the previous visible user/assistant pair.
        const submissionTurns = getTurnNodes();
        const submissionBaseline = new Set(submissionTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
        request.pendingSubmittedTurnBaseline = submissionBaseline;
        request.pendingSubmittedTurnKind = 'prompt';
        request.pendingSubmittedTurnExpectedText = message;
        request.turnCaptureArmed = true;
        request.promptSubmissionStartedAt = Date.now();
        diagnostic('prompt.turn_boundary.armed', {
          requestId,
          turnCount: submissionTurns.length,
          baselineCount: submissionBaseline.size,
        });
        emitChatEvent(request, 'prompt.turn_boundary.armed', {
          turnCount: submissionTurns.length,
          baselineCount: submissionBaseline.size,
        });
  
        await runObservedRequestEffect(request, 'prompt.submit', async () => {
          await enterPrompt(message, request, { kind: 'prompt' });
          request.sentAt = Date.now();
          setRequestPhase(request, 'prompt_submitted', { meaningful: true });
          await waitForSubmittedUserTurnAnchor(request, submissionBaseline, { kind: 'prompt', replace: false, timeoutMs: 5_000 });
          refreshRequestTurnAnchors(request);
          if (!request.submittedUserTurnKey) setRequestPhase(request, 'waiting_for_user_turn', { meaningful: false });
        });
        send({ type: 'status', requestId, status: 'sent' }, { priority: true, immediatePost: true, timeout: 5_000 });
        diagnostic('prompt.sent', { requestId });
        emitChatEvent(request, 'prompt.sent', { attachmentCount: attachments.length });
  
        collectAndEmit(request);
      } catch (err) {
        if (!err?.bridgeEffectReported) {
          reportTerminalFailure(request, err, {
            code: err?.code || 'PROMPT_PREPARATION_FAILED',
            effectId: `${request.requestId}:prompt-preparation`,
            effectType: 'prompt.preparation',
          });
        }
      }
    }
  
    async function handlePassivePromptSubmit(payload) {
      const activeRequest = getActiveRequest();
      const commandId = String(payload.commandId || '');
      const message = String(payload.message || '').trim();
      const options = payload.options || {};
      try {
        if (!commandId) throw new Error('passive.prompt.submit requires commandId');
        if (!message) throw new Error('Passive prompt message is empty');
        if (activeRequest) throw new Error(`Cannot submit a passive prompt while request ${activeRequest.requestId} is active`);
        const request = createRequestState(`passive_${commandId}`, options, payload.serverInstanceId || getConnectedServerInstanceId());
        await waitForDocumentReady();
        await waitForChatPageReady(request, { stage: 'passive-initial' });
        await applySessionOptions(options, request);
        await waitForChatPageReady(request, { stage: 'passive-session' });
        await applyModelOptions(options, request);
        await waitForChatPageReady(request, { stage: 'passive-model', settleMs: 400 });
        baselinePassiveTurns('passive-prompt-submit');
        const beforeTurns = getTurnNodes();
        const baseline = new Set(beforeTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
        request.pendingSubmittedTurnBaseline = baseline;
        request.pendingSubmittedTurnKind = 'passive';
        request.pendingSubmittedTurnExpectedText = message;
        request.turnCaptureArmed = true;
        request.promptSubmissionStartedAt = Date.now();
        diagnostic('passive.prompt.submit.started', { commandId, baselineCount: baseline.size, length: message.length });
        await enterPrompt(message, request, { kind: 'passive' });
        request.sentAt = Date.now();
        await waitForSubmittedUserTurnAnchor(request, baseline, { kind: 'passive', replace: false, timeoutMs: 7_000 });
        refreshRequestTurnAnchors(request);
        send({
          type: 'passive.prompt.submitted',
          commandId,
          submittedUserTurnKey: request.submittedUserTurnKey || '',
          session: getCurrentSession(),
          url: location.href,
          title: document.title,
        });
        diagnostic('passive.prompt.submit.completed', { commandId, submittedUserTurnKey: request.submittedUserTurnKey || '' });
        schedulePassiveTurnScan('passive-prompt-submitted', 500);
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
        diagnostic('passive.prompt.submit.failed', { commandId, message: err.message || String(err) });
      }
    }
  
    function handlePromptCancel(payload) {
      const activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      if (!activeRequest || (requestId && activeRequest.requestId !== requestId)) return;
  
      const reason = String(payload.reason || 'Cancelled by bridge');
      diagnostic('prompt.cancel_received', { requestId: activeRequest.requestId, reason });
      emitChatEvent(activeRequest, 'prompt.cancelled', { reason });
      clickStopButton();
      releaseRequest(activeRequest, reason);
    }
  
    function handleRequestRelease(payload) {
      const activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      if (!activeRequest) return;
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        return;
      }
      releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
    }
  
  
    async function handlePromptSteer(payload) {
      const activeRequest = getActiveRequest();
      const commandId = String(payload.commandId || '');
      const requestId = String(payload.requestId || '');
      const message = String(payload.message || '').trim();
      try {
        if (!activeRequest) throw new Error('No active ChatGPT prompt is running in this tab.');
        if (requestId && activeRequest.requestId !== requestId) {
          throw new Error(`Active prompt is ${activeRequest.requestId}, not ${requestId}.`);
        }
        if (!message) throw new Error('Steer message is empty.');
        const beforeTurns = getTurnNodes();
        const beforeTurnKeys = new Set(beforeTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
        activeRequest.pendingSubmittedTurnBaseline = beforeTurnKeys;
        activeRequest.pendingSubmittedTurnKind = 'steer';
        activeRequest.pendingSubmittedTurnExpectedText = message;
        await enterPrompt(message, activeRequest, { kind: 'steer' });
        const reanchored = await waitForSubmittedUserTurnAnchor(activeRequest, beforeTurnKeys, { kind: 'steer', replace: true, timeoutMs: 5_000 });
        markRequestProgress(activeRequest, 'prompt.steered');
        setRequestPhase(activeRequest, 'steer_submitted', {
          meaningful: true,
          submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
          assistantTurnKey: activeRequest.assistantTurnKey || '',
          reanchored: Boolean(reanchored),
        });
        diagnostic('prompt.steered', {
          requestId: activeRequest.requestId,
          length: message.length,
          beforeTurnCount: beforeTurns.length,
          reanchored: Boolean(reanchored),
          submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
        });
        emitChatEvent(activeRequest, 'prompt.steered', {
          message,
          length: message.length,
          beforeTurnCount: beforeTurns.length,
          reanchored: Boolean(reanchored),
          submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
        });
        send({
          type: 'prompt.steered',
          commandId,
          requestId: activeRequest.requestId,
          messageLength: message.length,
          reanchored: Boolean(reanchored),
          submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
          session: getCurrentSession(),
          url: location.href,
        });
        collectAndEmit(activeRequest);
      } catch (err) {
        if (activeRequest) {
          activeRequest.pendingSubmittedTurnBaseline = null;
          activeRequest.pendingSubmittedTurnKind = '';
          activeRequest.pendingSubmittedTurnExpectedText = '';
        }
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    function createRequestState(requestId, options, ownerServerInstanceId = '') {
      return {
        requestId,
        startedAt: Date.now(),
        options,
        ownerServerInstanceId: String(ownerServerInstanceId || ''),
        phase: 'created',
        lastProgressSentAt: 0,
        lastMeaningfulProgressAt: Date.now(),
        lastMeaningfulProgressReason: 'request.created',
        baselineAssistantCount: 0,
        baselineTurnKeys: new Set(),
        turnBaselineReady: false,
        turnCaptureArmed: false,
        promptSubmissionStartedAt: 0,
        submittedUserTurnKey: '',
        submittedUserTurnIndex: -1,
        submittedUserTurnLogged: false,
        assistantTurnKey: '',
        assistantTurnIndex: -1,
        pendingSubmittedTurnBaseline: null,
        pendingSubmittedTurnKind: '',
        pendingSubmittedTurnExpectedText: '',
        lastUserTurnMismatchSignature: '',
        assistantTurnLogged: false,
        assistantTurnMissingLogged: false,
        assistantTurnMissingSince: 0,
        promptHash: '',
        promptPreview: '',
        lastAnswer: '',
        lastThinking: '',
        lastProgressText: '',
        lastProgressItemsFingerprint: '',
        lastProgressItems: [],
        lastRaw: '',
        lastDomSignature: '',
        lastVisibleThinking: '',
        reasoningHistory: [],
        lastUnknownTestIdsSignature: '',
        lastArtifactsFingerprint: '',
        lastIgnoredArtifactFingerprint: '',
        artifacts: [],
        stableSince: 0,
        generationIdleSince: 0,
        sawAnswer: false,
        sawGenerating: false,
        generationStoppedSent: false,
        steerWaitStartedAt: 0,
        terminalCandidateSince: 0,
        terminalSnapshotSignature: '',
        terminalFailureSignature: '',
        releaseFallbackTimer: null,
        effectSequence: 0,
        steerWaitExpiredAt: 0,
        lastSnapshotChangedAt: 0,
        collectScheduled: false,
        collectTimer: null,
        collecting: false,
        networkDone: false,
        observer: null,
        observerRoot: null,
        observerRootMissingLogged: false,
        pollTimer: null,
        generationStartWarningSent: false,
        firstOutputWarningSent: false,
        maxRequestTimeoutWarningSent: false,
        sentAt: 0,
        finished: false,
      };
    }
  
    function snapshotTerminalForRequest(snapshot, request) {
      const expectedConversationId = conversationIdFromUrl(request?.options?.sessionId || '') || String(request?.options?.sessionId || '');
      return DOM_PARSER.isTerminalResponseSnapshot(snapshot, expectedConversationId);
    }
  
    function publicRequestStatus(request) {
      if (!request) return null;
      const stopButtonVisible = Boolean(findStopButton());
      const generating = stopButtonVisible || isGenerating();
      return {
        requestId: request.requestId,
        startedAt: request.startedAt,
        sentAt: request.sentAt || 0,
        sawGenerating: request.sawGenerating,
        generating,
        stopButtonVisible,
        ownerServerInstanceId: request.ownerServerInstanceId || '',
        phase: request.phase || 'created',
        sawAnswer: request.sawAnswer,
        lastAnswerLength: request.lastAnswer.length,
        lastThinkingLength: request.lastThinking.length,
        lastProgressLength: String(request.lastProgressText || '').length,
        artifactCount: request.artifacts.length,
        submittedUserTurnKey: request.submittedUserTurnKey || '',
        submittedUserTurnIndex: request.submittedUserTurnIndex,
        promptPreview: request.promptPreview || '',
        promptHash: request.promptHash || '',
        assistantTurnKey: request.assistantTurnKey || '',
        assistantTurnIndex: request.assistantTurnIndex ?? -1,
        lastMeaningfulProgressAt: request.lastMeaningfulProgressAt || 0,
        lastMeaningfulProgressReason: request.lastMeaningfulProgressReason || '',
        url: location.href,
        title: document.title,
      };
    }
  
  
    return Object.freeze({
      handlePassivePromptSubmit,
      handlePromptCancel,
      handlePromptSend,
      handlePromptSteer,
      handleRequestRelease,
      handleRequestResume,
      publicRequestStatus,
      snapshotTerminalForRequest,
    });
  }

  globalThis.ChatGptRequestCommands = Object.freeze({ createRequestCommands });
})();
