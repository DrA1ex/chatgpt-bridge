// Focused request-command family. Loaded before requestCommands.js.
(() => {
  'use strict';

  function createRequestPromptCommands(deps = {}) {
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
    const support = deps.requestCommandSupport || {};
    const { settleEffectCommandWithoutExecution } = support;
    if (typeof settleEffectCommandWithoutExecution !== 'function') throw new TypeError('Prompt commands require request command support');

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

    async function handleRequestRelease(payload) {
      const activeRequest = getActiveRequest();
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      const releaseIdentity = {
        leaseId: String(payload.leaseId || ''),
        ownerServerInstanceId: String(payload.ownerServerInstanceId || ''),
      };
      if (!activeRequest) {
        await settleReleaseCleanup({ commandId, requestId, status: 'completed', released: true, duplicate: true, ...releaseIdentity });
        return;
      }
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        await settleReleaseCleanup({
          commandId, requestId, status: 'failed',
          code: 'RELEASE_ACTIVE_REQUEST_MISMATCH',
          message: `Active request ${activeRequest.requestId} does not match release request`,
          evidence: { activeRequestId: activeRequest.requestId },
          ...releaseIdentity,
        });
        return;
      }
      const released = releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
      await settleReleaseCleanup({ commandId, requestId, status: 'completed', released, ...releaseIdentity });
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

    return Object.freeze({
      handlePromptSend,
      handlePassivePromptSubmit,
      handlePromptCancel,
      handleRequestRelease,
      handlePromptSteer
    });
  }

  globalThis.ChatGptRequestPromptCommands = Object.freeze({ createRequestPromptCommands });
})();
