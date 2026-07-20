// Browser request command handlers and request-local state creation.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestCommands(deps = {}) {
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
      reportExecutionFailure,
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
    if (!REQUEST_STATE || typeof REQUEST_STATE.createRequestState !== 'function' || typeof REQUEST_STATE.publicRequestStatus !== 'function') {
      throw new TypeError('Request commands require REQUEST_STATE');
    }

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

    function turnRole(turn) {
      return String(turn?.getAttribute?.('data-turn')
        || turn?.querySelector?.('[data-message-author-role]')?.getAttribute?.('data-message-author-role')
        || turn?.getAttribute?.('data-message-author-role')
        || '');
    }

    function turnText(turn) {
      const value = String(turn?.innerText || turn?.textContent || '');
      return typeof normalizeText === 'function' ? normalizeText(value) : value.trim().replace(/\s+/g, ' ');
    }

    function projectedBoundaryEvidence(projection = {}) {
      const records = Array.from(getTurnNodes?.() || []).map((turn, index) => ({
        turn,
        index,
        key: String(turnKey?.(turn, index) || ''),
        role: turnRole(turn),
        text: turnText(turn),
      }));
      const expectedKey = String(projection.submittedUserTurnKey || '');
      const expectedText = typeof normalizeText === 'function'
        ? normalizeText(String(projection.submittedPromptText || ''))
        : String(projection.submittedPromptText || '').trim().replace(/\s+/g, ' ');
      let user = records.find((record) => record.role === 'user' && record.key === expectedKey) || null;
      let status = user ? 'matched' : '';
      if (!user && expectedText) {
        user = records.filter((record) => record.role === 'user' && record.text === expectedText).at(-1) || null;
        if (user) status = 'rebound';
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
      let assistant = records.find((record) => record.role === 'assistant'
        && record.key === expectedAssistantKey
        && record.index > user.index) || null;
      if (!assistant) {
        assistant = records.filter((record) => record.role === 'assistant' && record.index > user.index).at(-1) || null;
      }
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
  
    async function handlePromptSend(payload) {
      let activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      const message = String(payload.message || '');
      const options = payload.options || {};
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  
      if (!requestId) {
        diagnostic('prompt.execution.invalid_identity', { commandId, requestId, reason: 'request_id_missing' });
        return;
      }
      if (!message.trim() && !attachments.length) {
        diagnostic('prompt.execution.invalid_payload', { commandId, requestId, reason: 'empty_prompt_and_attachments' });
        return;
      }
  
      const executionPlan = payload.executionPlan && typeof payload.executionPlan === 'object'
        ? payload.executionPlan
        : null;
      const planSteps = Array.isArray(executionPlan?.steps) ? executionPlan.steps : [];
      const expectedKinds = ['page.ready.initial', 'session.apply', 'model.apply', ...(attachments.length ? ['attachments.upload'] : []), 'prompt.submit'];
      const actualKinds = planSteps.map((step) => String(step?.kind || ''));
      if (executionPlan?.requestId !== requestId
        || expectedKinds.length !== actualKinds.length
        || expectedKinds.some((kind, index) => actualKinds[index] !== kind)
        || planSteps.some((step) => !step?.effectId || !step?.idempotencyKey || !step?.retryPolicy || !step?.preconditionsHash)) {
        const error = new Error('prompt.send requires a complete server-owned execution plan');
        error.code = 'REQUEST_EXECUTION_PLAN_INVALID';
        diagnostic('prompt.execution.invalid_plan', { commandId, requestId, code: error.code, message: error.message });
        return;
      }
      const startAtStepId = String(executionPlan.startAtStepId || planSteps[0]?.stepId || '');
      const startAtIndex = planSteps.findIndex((step) => String(step.stepId || '') === startAtStepId);
      if (startAtIndex < 0) {
        diagnostic('prompt.execution.invalid_start_step', { commandId, requestId, startAtStepId });
        return;
      }
      const currentStep = planSteps[startAtIndex];
      const currentStepKind = String(currentStep?.kind || '');
      const continuingExecution = Boolean(
        activeRequest
        && activeRequest.requestId === requestId
        && payload.executionStepOnly === true
        && payload.continuationOfEffectId
        && !activeRequest.sentAt
        && !activeRequest.submittedUserTurnKey
      );

      if (activeRequest) {
        if (activeRequest.requestId === requestId && !continuingExecution) {
          scheduleTabObservation('prompt.duplicate_delivery', 0);
          diagnostic('prompt.duplicate_ignored', { requestId, phase: activeRequest.phase || 'active' });
          return;
        }
        if (continuingExecution) {
          activeRequest.update('request.identity_updated', { commandId });
          activeRequest.update('request.executor_updated', { recovering: false });
          activeRequest.update('request.anchor_updated', {
            promptHash: simpleHash(message),
            promptPreview: message.slice(0, 160),
          });
          diagnostic('prompt.execution.step', {
            requestId,
            commandId,
            startAtStepId,
            continuationOfEffectId: String(payload.continuationOfEffectId || ''),
            continuationReason: String(payload.continuationReason || ''),
          });
        } else {
          const error = Object.assign(new Error(`Another prompt is active: ${activeRequest.requestId}`), { code: 'TAB_BUSY' });
          await settleEffectCommandWithoutExecution(payload, currentStepKind, currentStep, error, {
            request: activeRequest,
            evidence: { activeRequestId: activeRequest.requestId },
          });
          diagnostic('prompt.rejected_busy', { requestId, activeRequestId: activeRequest.requestId, ownerServerInstanceId: activeRequest.ownerServerInstanceId || '' });
          return;
        }
      }

      let request = activeRequest;
      if (!continuingExecution) {
        request = REQUEST_STATE.createRequestState(requestId, options, payload.ownerServerInstanceId || payload.serverInstanceId || getConnectedServerInstanceId(), payload.leaseId, { commandId, responseEpoch: payload.responseEpoch });
        setActiveRequest(request);
        request = getActiveRequest();
        activeRequest = request;
        schedulePageStatus('page.changed', 0);
        scheduleTabObservation('request.activated', 0);
      }
  
      try {
        if (!continuingExecution) {
          setRequestPhase(request, 'prompt_accepted_by_content_script', { meaningful: true });
          diagnostic('prompt.accepted', { requestId });
          emitChatEvent(request, 'prompt.accepted');
        }
  
        if (currentStepKind === 'page.ready.initial') {
          await runObservedRequestEffect(request, currentStepKind, async () => {
            await waitForDocumentReady();
            await waitForChatPageReady(request, { stage: 'initial' });
          }, { effect: currentStep });
          scheduleTabObservation('prompt.execution.page_ready', 0);
          return;
        }

        if (currentStepKind === 'session.apply') {
          const sessionEvidence = {
            desiredSessionId: String(options.sessionId || ''),
            newSession: Boolean(options.newSession),
            previousSessionId: String(getCurrentSession()?.id || ''),
          };
          await runObservedRequestEffect(request, currentStepKind, async () => {
            await applySessionOptions(options, request);
            await waitForChatPageReady(request, { stage: 'session' });
          }, { effect: currentStep, evidence: sessionEvidence });
          scheduleTabObservation('prompt.execution.session_applied', 0);
          return;
        }

        if (currentStepKind === 'model.apply') {
          await runObservedRequestEffect(request, currentStepKind, async () => {
            const applied = await applyModelOptions(options, request);
            await waitForChatPageReady(request, { stage: 'model', settleMs: 400 });
            return applied;
          }, {
            effect: currentStep,
            evidence: { model: String(options.model || ''), effort: String(options.effort || '') },
            result: (applied) => applied,
          });
          scheduleTabObservation('prompt.execution.model_applied', 0);
          return;
        }

        if (currentStepKind === 'attachments.upload') {
          if (!attachments.length) throw Object.assign(new Error('Execution plan requested attachment upload without attachments'), { code: 'REQUEST_EXECUTION_PLAN_INVALID' });
          setRequestPhase(request, 'attachments_uploading', { attachmentCount: attachments.length });
          await runObservedRequestEffect(request, currentStepKind, async () => {
            await attachFiles(attachments, request);
          }, { effect: currentStep, evidence: {
            attachmentCount: attachments.length,
            attachments: attachments.map((item) => ({
              id: String(item.id || ''),
              name: String(item.name || item.filename || ''),
              size: Number(item.size) || 0,
              mime: String(item.mime || item.type || ''),
            })),
          } });
          scheduleTabObservation('prompt.execution.attachments_uploaded', 0);
          return;
        }

        if (currentStepKind !== 'prompt.submit') {
          throw Object.assign(new Error(`Unsupported prompt execution step: ${currentStepKind}`), { code: 'REQUEST_EXECUTION_PLAN_INVALID' });
        }

        request.update('request.anchor_updated', {
          baselineAssistantCount: getAssistantNodes().length,
          baselineTurnKeys: new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean)),
          promptHash: simpleHash(message),
          promptPreview: message.slice(0, 160),
          turnBaselineReady: true,
        });
        startDomMonitor(request);
        emitChatEvent(request, 'session.snapshot', { session: getCurrentSession() });

        const submissionTurns = getTurnNodes();
        const submissionBaseline = new Set(submissionTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
        request.update('request.anchor_updated', {
          pendingSubmittedTurnBaseline: submissionBaseline,
          pendingSubmittedTurnKind: 'prompt',
          pendingSubmittedTurnExpectedText: message,
          turnCaptureArmed: true,
          promptSubmissionStartedAt: Date.now(),
        });
        diagnostic('prompt.turn_boundary.armed', {
          requestId,
          turnCount: submissionTurns.length,
          baselineCount: submissionBaseline.size,
        });
        emitChatEvent(request, 'prompt.turn_boundary.armed', {
          turnCount: submissionTurns.length,
          baselineCount: submissionBaseline.size,
        });

        await runObservedRequestEffect(request, currentStepKind, async () => {
          await enterPrompt(message, request, { kind: 'prompt' });
          request.update('request.anchor_updated', { sentAt: Date.now() });
          setRequestPhase(request, 'prompt_submitted', { meaningful: true });
          await waitForSubmittedUserTurnAnchor(request, submissionBaseline, { kind: 'prompt', replace: false, timeoutMs: 5_000 });
          refreshRequestTurnAnchors(request);
          if (!request.submittedUserTurnKey) setRequestPhase(request, 'waiting_for_user_turn', { meaningful: false });
        }, { effect: currentStep });
        scheduleTabObservation('prompt.submitted', 0);
        diagnostic('prompt.sent', { requestId });
        emitChatEvent(request, 'prompt.sent', { attachmentCount: attachments.length });
        collectAndEmit(request);

      } catch (err) {
        if (!err?.bridgeEffectReported) {
          await settleEffectCommandWithoutExecution(payload, currentStepKind, currentStep, err, { request });
        }
        diagnostic('prompt.execution.step_failed', {
          requestId,
          commandId,
          effectId: String(currentStep?.effectId || ''),
          effectType: currentStepKind,
          code: String(err?.code || 'PROMPT_EXECUTION_STEP_FAILED'),
          message: String(err?.message || err),
          effectStatus: String(err?.bridgeEffectStatus || ''),
        });
      }
    }
  
    async function handlePassivePromptSubmit(payload) {
      const activeRequest = getActiveRequest();
      const commandId = String(payload.commandId || '');
      const message = String(payload.message || '').trim();
      const options = payload.options || {};
      let request = null;
      try {
        if (!commandId) throw new Error('passive.prompt.submit requires commandId');
        if (!message) throw new Error('Passive prompt message is empty');
        if (activeRequest) throw new Error(`Cannot submit a passive prompt while request ${activeRequest.requestId} is active`);
        setActiveRequest(REQUEST_STATE.createRequestState(
          `passive_${commandId}`,
          options,
          payload.ownerServerInstanceId || payload.serverInstanceId || getConnectedServerInstanceId(),
          payload.leaseId,
        ));
        request = getActiveRequest();
        if (!request) throw new Error('Passive prompt executor projection could not be claimed');
        // This is one standalone durable command, not a canonical request.
        // Its internal read waits and DOM writes are settled by the command ledger
        // as a whole, so it must not invent request BrowserEffect identities.
        await waitForDocumentReady();
        await waitForChatPageReady(request, { stage: 'passive-initial' });
        await applySessionOptions(options, request);
        await waitForChatPageReady(request, { stage: 'passive-session' });
        await applyModelOptions(options, request);
        await waitForChatPageReady(request, { stage: 'passive-model', settleMs: 400 });
        baselinePassiveTurns('passive-prompt-submit', { markAll: true });
        const beforeTurns = getTurnNodes();
        const baseline = new Set(beforeTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
        request.update('request.anchor_updated', {
          pendingSubmittedTurnBaseline: baseline,
          pendingSubmittedTurnKind: 'passive',
          pendingSubmittedTurnExpectedText: message,
          turnCaptureArmed: true,
          promptSubmissionStartedAt: Date.now(),
        });
        diagnostic('passive.prompt.submit.started', { commandId, baselineCount: baseline.size, length: message.length });
        await enterPrompt(message, request, { kind: 'passive' });
        request.update('request.anchor_updated', { sentAt: Date.now() });
        await waitForSubmittedUserTurnAnchor(request, baseline, { kind: 'passive', replace: false, timeoutMs: 7_000 });
        refreshRequestTurnAnchors(request);
        registerPassivePromptBoundary(request, baseline);
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
      } finally {
        if (request && getActiveRequest()?.requestId === request.requestId) {
          setActiveRequest(null);
          schedulePageStatus('page.changed', 0);
          scheduleTabObservation('passive.prompt.executor_released', 0);
        }
      }
    }
  
    async function handlePromptCancel(payload) {
      const activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      if (!activeRequest || (requestId && activeRequest.requestId !== requestId)) {
        const error = Object.assign(new Error('Active request does not match cancel command.'), { code: 'ACTIVE_REQUEST_MISMATCH' });
        await settleEffectCommandWithoutExecution(payload, 'prompt.cancel', payload.effect, error, {
          request: activeRequest,
          evidence: { expectedRequestId: requestId },
        });
        return;
      }
      const reason = String(payload.reason || 'Cancelled by bridge');
      try {
        activeRequest.update('request.identity_updated', { commandId });
        await runObservedRequestEffect(activeRequest, 'prompt.cancel', async () => {
          const stopped = clickStopButton();
          if (!stopped && findStopButton()) throw new Error('ChatGPT stop control could not be activated');
        }, { effect: payload.effect, write: true, evidence: { reason } });
        diagnostic('prompt.cancel_completed', { requestId: activeRequest.requestId, reason });
        scheduleTabObservation('cancel.effect.settled', 0);
      } catch (error) {
        if (!error?.bridgeEffectReported) {
          await settleEffectCommandWithoutExecution(payload, 'prompt.cancel', payload.effect, error, { request: activeRequest });
        }
        diagnostic('prompt.cancel_failed', { requestId: activeRequest.requestId, code: String(error?.code || ''), message: error?.message || String(error) });
      }
    }
  
    function handleRequestRelease(payload) {
      const activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      const releaseIdentity = {
        leaseId: String(payload.leaseId || ''),
        ownerServerInstanceId: String(payload.ownerServerInstanceId || ''),
      };
      if (!activeRequest) {
        send({ type: 'request.cleanup.completed', commandId, requestId, released: true, duplicate: true, ...releaseIdentity });
        return;
      }
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        send({
          type: 'request.cleanup.failed', commandId, requestId,
          code: 'RELEASE_ACTIVE_REQUEST_MISMATCH',
          message: `Active request ${activeRequest.requestId} does not match release request`,
          activeRequestId: activeRequest.requestId,
          ...releaseIdentity,
        });
        return;
      }
      const released = releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
      send({ type: 'request.cleanup.completed', commandId, requestId, released, ...releaseIdentity });
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
        activeRequest.update('request.identity_updated', { commandId });
        activeRequest.update('request.anchor_updated', {
          pendingSubmittedTurnBaseline: beforeTurnKeys,
          pendingSubmittedTurnKind: 'steer',
          pendingSubmittedTurnExpectedText: message,
        });
        let reanchored = null;
        const previousResponseEpoch = Math.max(0, Number(activeRequest.responseEpoch) || 0);
        const targetResponseEpoch = Math.max(previousResponseEpoch + 1, Number(payload.responseEpoch) || 0);
        await runObservedRequestEffect(activeRequest, 'prompt.steer', async () => {
          await enterPrompt(message, activeRequest, { kind: 'steer' });
          reanchored = await waitForSubmittedUserTurnAnchor(activeRequest, beforeTurnKeys, { kind: 'steer', replace: true, timeoutMs: 5_000 });
          return {
            submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
            submittedUserTurnIndex: activeRequest.submittedUserTurnIndex,
            previousResponseEpoch,
            targetResponseEpoch,
          };
        }, {
          effect: payload.effect,
          write: true,
          evidence: { messageLength: message.length, previousResponseEpoch, targetResponseEpoch },
          result: (result) => result,
        });
        activeRequest.update('request.anchor_updated', {
          responseEpoch: targetResponseEpoch,
        });
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
        collectAndEmit(activeRequest);
      } catch (err) {
        if (activeRequest) {
          activeRequest.update('request.anchor_updated', {
            pendingSubmittedTurnBaseline: null,
            pendingSubmittedTurnKind: '',
            pendingSubmittedTurnExpectedText: '',
          });
        }
        if (!err?.bridgeEffectReported) {
          await settleEffectCommandWithoutExecution(payload, 'prompt.steer', payload.effect, err, { request: activeRequest });
        }
        diagnostic('prompt.steer_failed', {
          requestId: activeRequest?.requestId || requestId,
          code: String(err?.code || 'PROMPT_STEER_FAILED'),
          message: err.message || String(err),
          effectStatus: String(err?.bridgeEffectStatus || ''),
        });
      }
    }
  
    function composerText() {
      const composer = findComposer?.();
      if (!composer) return '';
      return String('value' in composer ? composer.value : composer.innerText || composer.textContent || '').trim();
    }

    function composerAttachmentCount() {
      const root = findComposerRootStrict?.() || findComposer?.()?.closest?.('form') || null;
      if (!root) return 0;
      const selectors = [
        '[data-testid*="attachment" i]', '[data-testid*="file" i]',
        '[aria-label*="remove file" i]', '[aria-label*="remove attachment" i]',
      ];
      const found = new Set();
      for (const selector of selectors) {
        for (const node of root.querySelectorAll?.(selector) || []) found.add(node.closest?.('[data-testid*="attachment" i], [data-testid*="file" i]') || node);
      }
      return found.size;
    }

    function phaseRank(value) {
      let phase = '';
      try { phase = String(value ?? '').toLowerCase(); } catch { return 0; }
      const exactRanks = Object.freeze({
        created: 0,
        prompt_accepted_by_content_script: 1,
        page_ready: 2,
        session_applied: 3,
        model_applied: 4,
        attachments_uploading: 5,
        prompt_submitted: 6,
        waiting_for_user_turn: 6,
        waiting_for_response: 6,
        generating: 6,
        finalizing: 6,
      });
      if (Object.prototype.hasOwnProperty.call(exactRanks, phase)) return exactRanks[phase];
      if (phase.includes('session')) return 3;
      if (phase.includes('model') || phase.includes('intelligence')) return 4;
      if (phase.includes('attachment')) return 5;
      if (phase.includes('prompt_submitted') || phase.includes('steer_submitted')
        || phase.includes('waiting') || phase.includes('generat') || phase.includes('final')) return 6;
      return 0;
    }

    async function handleEffectReconcile(input) {
      const payload = input && typeof input === 'object' ? input : {};
      const commandId = String(payload.commandId || '');
      const requestId = String(payload.requestId || '');
      const effectId = String(payload.effectId || '');
      const effectType = String(payload.effectType || '');
      const preconditions = payload.preconditions && typeof payload.preconditions === 'object' ? payload.preconditions : {};
      const expected = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : {};
      const request = getActiveRequest();
      let outcome = 'uncertain';
      let reason = 'effect_specific_evidence_missing';
      const evidence = {
        effectType,
        activeRequestId: String(request?.requestId || ''),
        phase: String(request?.phase || ''),
        sessionId: String(getCurrentSession()?.id || ''),
        sentAt: Number(request?.sentAt) || 0,
        submittedUserTurnKey: String(request?.submittedUserTurnKey || ''),
        responseEpoch: Number(request?.responseEpoch) || 0,
      };

      if (!request || (requestId && request.requestId !== requestId)) {
        reason = 'request_projection_missing_or_mismatched';
      } else if (effectType.startsWith('page.ready')) {
        const presence = pagePresence?.() || {};
        Object.assign(evidence, { pageReady: Boolean(presence.pageReady), composerReady: Boolean(presence.composerReady), chatMainReady: Boolean(presence.chatMainReady) });
        if (presence.pageReady || (presence.chatMainReady && presence.composerReady)) {
          outcome = 'succeeded'; reason = 'page_readiness_observed';
        }
      } else if (effectType === 'session.apply') {
        const desired = String(expected.desiredSessionId || expected.sessionId || preconditions.sessionId || request.options?.sessionId || '');
        const newSession = Boolean(expected.newSession || request.options?.newSession);
        const previousSessionId = String(expected.previousSessionId || '');
        Object.assign(evidence, { expectedSessionId: desired, newSession, previousSessionId });
        if (!desired && !newSession) {
          outcome = 'succeeded'; reason = 'no_session_change_requested';
        } else if (desired && evidence.sessionId === desired) {
          outcome = 'succeeded'; reason = 'expected_session_observed';
        } else if (newSession && evidence.sessionId && evidence.sessionId !== previousSessionId) {
          outcome = 'succeeded'; reason = 'new_session_identity_observed';
        } else if (phaseRank(request.phase) < 3 && evidence.sessionId === previousSessionId) {
          outcome = 'not_started'; reason = 'session_stage_not_reached';
        } else reason = 'session_identity_does_not_prove_effect';
      } else if (effectType === 'model.apply') {
        const desiredModel = String(expected.model || preconditions.model || request.options?.model || '');
        const desiredEffort = String(expected.effort || preconditions.effort || request.options?.effort || '');
        Object.assign(evidence, { desiredModel, desiredEffort });
        if (!desiredModel && !desiredEffort) {
          outcome = 'succeeded'; reason = 'no_intelligence_change_requested';
        } else {
          try {
            const intelligence = await readIntelligenceState?.({ includeModels: Boolean(desiredModel) });
            const modelMatches = !desiredModel || DOM_PARSER.intelligenceOptionMatches(intelligence?.selectedModel || {}, desiredModel);
            const effortMatches = !desiredEffort || DOM_PARSER.intelligenceOptionMatches(intelligence?.selectedEffort || {}, desiredEffort);
            Object.assign(evidence, {
              selectedModel: intelligence?.selectedModel || null,
              selectedEffort: intelligence?.selectedEffort || null,
              modelMatches,
              effortMatches,
            });
            if (modelMatches && effortMatches) {
              outcome = 'succeeded'; reason = 'selected_intelligence_matches_expected';
            } else if (phaseRank(request.phase) < 4) {
              outcome = 'not_started'; reason = 'model_stage_not_reached';
            } else reason = 'selected_intelligence_does_not_match_expected';
          } catch (error) {
            evidence.intelligenceReadError = String(error?.message || error || 'unknown');
            if (phaseRank(request.phase) < 4) {
              outcome = 'not_started'; reason = 'model_stage_not_reached';
            } else reason = 'intelligence_state_unavailable';
          }
        }
      } else if (effectType === 'attachments.upload') {
        const expectedAttachments = Array.isArray(expected.attachments) ? expected.attachments : [];
        const expectedNames = expectedAttachments.map((item) => String(item?.name || '')).filter(Boolean);
        const expectedCount = Math.max(expectedNames.length, Number(expected.attachmentCount || preconditions.attachmentCount) || 0);
        const root = findComposerRootStrict?.() || findComposer?.()?.closest?.('form') || null;
        const composerVisibleText = String(root?.innerText || root?.textContent || '');
        const visibleCount = composerAttachmentCount();
        const visibleNames = expectedNames.filter((name) => composerVisibleText.includes(name));
        Object.assign(evidence, { expectedAttachmentCount: expectedCount, expectedNames, visibleAttachmentCount: visibleCount, visibleNames });
        if (!expectedCount) {
          outcome = 'succeeded'; reason = 'no_attachments_requested';
        } else if (expectedNames.length && visibleNames.length === expectedNames.length) {
          outcome = 'succeeded'; reason = 'expected_attachment_names_visible_in_composer';
        } else if (!expectedNames.length && visibleCount >= expectedCount) {
          outcome = 'succeeded'; reason = 'expected_attachment_count_visible_in_composer';
        } else if (phaseRank(request.phase) < 5 && visibleCount === 0) {
          outcome = 'not_started'; reason = 'attachment_stage_not_reached';
        } else reason = 'attachment_identity_does_not_prove_effect';
      } else if (effectType === 'prompt.submit' || effectType === 'prompt.steer') {
        const expectedText = String(expected.message || preconditions.message || request.pendingSubmittedTurnExpectedText || '');
        const currentComposerText = composerText();
        Object.assign(evidence, { expectedTextLength: expectedText.length, composerTextLength: currentComposerText.length });
        if (request.submittedUserTurnKey) {
          outcome = 'succeeded'; reason = 'submitted_user_turn_observed';
        } else if (expectedText && currentComposerText === expectedText) {
          outcome = 'not_started'; reason = 'expected_prompt_still_in_composer';
        } else reason = 'prompt_submission_not_provable';
      } else if (effectType === 'prompt.cancel') {
        const stillGenerating = Boolean(findStopButton?.() || isGenerating?.());
        evidence.stillGenerating = stillGenerating;
        if (!stillGenerating) {
          outcome = 'succeeded'; reason = 'generation_is_quiescent';
        } else reason = 'generation_still_active';
      } else if (/artifact|download/.test(effectType)) {
        const backgroundEvidence = payload.backgroundEvidence && typeof payload.backgroundEvidence === 'object'
          ? payload.backgroundEvidence
          : {};
        const persistedEffect = backgroundEvidence.effect || null;
        const captures = Array.isArray(backgroundEvidence.downloads) ? backgroundEvidence.downloads : [];
        const completedCapture = captures.find((capture) => capture.status === 'completed');
        const failedCapture = captures.find((capture) => capture.status === 'failed');
        Object.assign(evidence, { backgroundEffect: persistedEffect, downloadCaptures: captures });
        if (persistedEffect?.status === 'succeeded' || completedCapture) {
          outcome = 'succeeded'; reason = completedCapture ? 'download_capture_completed' : 'background_effect_succeeded';
        } else if (persistedEffect?.status === 'planned' && !captures.length) {
          outcome = 'not_started'; reason = 'background_effect_not_dispatched';
        } else if (persistedEffect?.status === 'failed' || failedCapture) {
          outcome = 'failed'; reason = failedCapture ? 'download_capture_failed' : 'background_effect_failed';
        } else reason = 'background_capture_state_does_not_prove_effect';
      } else if (payload.retryPolicy === 'always' && phaseRank(request.phase) > 0) {
        outcome = 'succeeded'; reason = 'read_only_stage_has_active_projection';
      }

      send({
        type: 'request.effect.reconciled', commandId, requestId, effectId, effectType,
        reconciliationOutcome: outcome, reconciliationReason: reason, evidence,
      }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('request.effect.reconciled', { requestId, effectId, effectType, outcome, reason, evidence });
    }

    function publicRequestStatus(request) {
      const stopButtonVisible = Boolean(findStopButton());
      return REQUEST_STATE.publicRequestStatus(request, {
        generating: stopButtonVisible || isGenerating(),
        stopButtonVisible,
        url: location.href,
        title: document.title,
      });
    }
  
  
    return Object.freeze({
      handlePassivePromptSubmit,
      handlePromptCancel,
      handlePromptSend,
      handlePromptSteer,
      handleRequestRelease,
      handleRequestResume,
      handleEffectReconcile,
      publicRequestStatus,
    });
  }

  globalThis.ChatGptRequestCommands = Object.freeze({ createRequestCommands });
})();
