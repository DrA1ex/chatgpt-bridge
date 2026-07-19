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
      refreshRequestTurnAnchors,
      registerPassivePromptBoundary,
      releaseRequest,
      reportExecutionFailure,
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
      pagePresence,
      readIntelligenceState,
    } = deps;
    if (!REQUEST_STATE || typeof REQUEST_STATE.createRequestState !== 'function' || typeof REQUEST_STATE.publicRequestStatus !== 'function') {
      throw new TypeError('Request commands require REQUEST_STATE');
    }

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
        if (commandId) send({ type: 'command.error', commandId, requestId, message: 'prompt.send requires requestId' });
        return;
      }
      if (!message.trim() && !attachments.length) {
        if (commandId) send({ type: 'command.error', commandId, requestId, message: 'Empty prompt and no attachments received' });
        reportExecutionFailure({ requestId }, new Error('Empty prompt and no attachments received'), {
          code: 'EMPTY_PROMPT', effectId: `${requestId}:prompt.submit:validation`, effectType: 'prompt.submit',
        });
        return;
      }
  
      if (activeRequest) {
        if (activeRequest.requestId === requestId) {
          const status = publicRequestStatus(activeRequest);
          send({ type: 'prompt.accepted', commandId, requestId, duplicate: true }, { priority: true, immediatePost: true, timeout: 5_000 });
          scheduleTabObservation('prompt.duplicate_delivery', 0);
          diagnostic('prompt.duplicate_ignored', { requestId, phase: activeRequest.phase || 'active' });
          return;
        }
        if (commandId) send({ type: 'command.error', commandId, requestId, message: `Another prompt is active: ${activeRequest.requestId}` });
        reportExecutionFailure({ requestId }, new Error(`Another prompt is active: ${activeRequest.requestId}`), {
          code: 'TAB_BUSY', effectId: `${requestId}:lease.claim:busy`, effectType: 'lease.claim',
          evidence: { activeRequestId: activeRequest.requestId },
        });
        diagnostic('prompt.rejected_busy', { requestId, activeRequestId: activeRequest.requestId, ownerServerInstanceId: activeRequest.ownerServerInstanceId || '' });
        return;
      }
  
      let request = REQUEST_STATE.createRequestState(requestId, options, payload.ownerServerInstanceId || payload.serverInstanceId || getConnectedServerInstanceId(), payload.leaseId);
      setActiveRequest(request);
      request = getActiveRequest();
      activeRequest = request;
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation('request.activated', 0);
  
      try {
        send({ type: 'prompt.accepted', commandId, requestId }, { priority: true, immediatePost: true, timeout: 5_000 });
        setRequestPhase(request, 'prompt_accepted_by_content_script', { meaningful: true });
        diagnostic('prompt.accepted', { requestId });
        emitChatEvent(request, 'prompt.accepted');
  
        await runObservedRequestEffect(request, 'page.ready.initial', async () => {
          await waitForDocumentReady();
          await waitForChatPageReady(request, { stage: 'initial' });
        });
        const sessionEvidence = {
          desiredSessionId: String(options.sessionId || ''),
          newSession: Boolean(options.newSession),
          previousSessionId: String(getCurrentSession()?.id || ''),
        };
        await runObservedRequestEffect(request, 'session.apply', async () => {
          await applySessionOptions(options, request);
          await waitForChatPageReady(request, { stage: 'session' });
        }, { evidence: sessionEvidence });
        await runObservedRequestEffect(request, 'model.apply', async () => {
          const applied = await applyModelOptions(options, request);
          await waitForChatPageReady(request, { stage: 'model', settleMs: 400 });
          return applied;
        }, {
          evidence: { model: String(options.model || ''), effort: String(options.effort || '') },
          result: (applied) => applied,
        });
  
        request.update('request.anchor_updated', {
          baselineAssistantCount: getAssistantNodes().length,
          baselineTurnKeys: new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean)),
          promptHash: simpleHash(message),
          promptPreview: message.slice(0, 160),
          turnBaselineReady: true,
        });
        startDomMonitor(request);
        send({ type: 'session.snapshot', requestId, session: getCurrentSession() }, { priority: true, immediatePost: true, timeout: 5_000 });
        emitChatEvent(request, 'session.snapshot', { session: getCurrentSession() });
  
        if (attachments.length) {
          setRequestPhase(request, 'attachments_uploading', { attachmentCount: attachments.length });
          await runObservedRequestEffect(request, 'attachments.upload', async () => {
            await attachFiles(attachments, request);
          }, { evidence: {
            attachmentCount: attachments.length,
            attachments: attachments.map((item) => ({
              id: String(item.id || ''),
              name: String(item.name || item.filename || ''),
              size: Number(item.size) || 0,
              mime: String(item.mime || item.type || ''),
            })),
          } });
        }
  
        // Arm turn capture only at the actual submission boundary. Foreground,
        // pageshow and MutationObserver resyncs can run while session/model/file
        // setup is still in progress; allowing them to adopt turns earlier binds a
        // new local request to the previous visible user/assistant pair.
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
  
        await runObservedRequestEffect(request, 'prompt.submit', async () => {
          await enterPrompt(message, request, { kind: 'prompt' });
          request.update('request.anchor_updated', { sentAt: Date.now() });
          setRequestPhase(request, 'prompt_submitted', { meaningful: true });
          await waitForSubmittedUserTurnAnchor(request, submissionBaseline, { kind: 'prompt', replace: false, timeoutMs: 5_000 });
          refreshRequestTurnAnchors(request);
          if (!request.submittedUserTurnKey) setRequestPhase(request, 'waiting_for_user_turn', { meaningful: false });
        });
        scheduleTabObservation('prompt.submitted', 0);
        diagnostic('prompt.sent', { requestId });
        emitChatEvent(request, 'prompt.sent', { attachmentCount: attachments.length });
  
        collectAndEmit(request);
      } catch (err) {
        if (!err?.bridgeEffectReported) {
          reportExecutionFailure(request, err, {
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
        await runObservedRequestEffect(request, 'page.ready.initial', async () => {
          await waitForDocumentReady();
          await waitForChatPageReady(request, { stage: 'passive-initial' });
        });
        const sessionEvidence = {
          desiredSessionId: String(options.sessionId || ''),
          newSession: Boolean(options.newSession),
          previousSessionId: String(getCurrentSession()?.id || ''),
        };
        await runObservedRequestEffect(request, 'session.apply', async () => {
          await applySessionOptions(options, request);
          await waitForChatPageReady(request, { stage: 'passive-session' });
        }, { evidence: sessionEvidence });
        await runObservedRequestEffect(request, 'model.apply', async () => {
          const applied = await applyModelOptions(options, request);
          await waitForChatPageReady(request, { stage: 'passive-model', settleMs: 400 });
          return applied;
        }, {
          evidence: { model: String(options.model || ''), effort: String(options.effort || '') },
          result: (applied) => applied,
        });
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
        await runObservedRequestEffect(request, 'prompt.submit', async () => {
          await enterPrompt(message, request, { kind: 'passive' });
          request.update('request.anchor_updated', { sentAt: Date.now() });
          await waitForSubmittedUserTurnAnchor(request, baseline, { kind: 'passive', replace: false, timeoutMs: 7_000 });
          refreshRequestTurnAnchors(request);
        }, { evidence: { mode: 'passive', commandId } });
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
        send({ type: 'command.error', commandId, requestId, message: 'Active request does not match cancel command.' });
        return;
      }
      const reason = String(payload.reason || 'Cancelled by bridge');
      try {
        await runObservedRequestEffect(activeRequest, 'prompt.cancel', async () => {
          const stopped = clickStopButton();
          if (!stopped && findStopButton()) throw new Error('ChatGPT stop control could not be activated');
        }, { write: true, evidence: { reason } });
        diagnostic('prompt.cancel_completed', { requestId: activeRequest.requestId, reason });
        send({ type: 'prompt.cancelled', commandId, requestId: activeRequest.requestId, reason });
        scheduleTabObservation('prompt.cancelled', 0);
      } catch (error) {
        send({ type: 'command.error', commandId, requestId: activeRequest.requestId, message: error?.message || String(error) });
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
        send({ type: 'request.release.completed', commandId, requestId, released: true, duplicate: true, ...releaseIdentity });
        return;
      }
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        send({ type: 'command.error', commandId, requestId, error: `Active request ${activeRequest.requestId} does not match release request` });
        return;
      }
      const released = releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
      send({ type: 'request.release.completed', commandId, requestId, released, ...releaseIdentity });
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
        activeRequest.update('request.anchor_updated', {
          pendingSubmittedTurnBaseline: beforeTurnKeys,
          pendingSubmittedTurnKind: 'steer',
          pendingSubmittedTurnExpectedText: message,
          responseEpoch: Math.max(Number(activeRequest.responseEpoch) || 0, Number(payload.responseEpoch) || 0),
        });
        let reanchored = null;
        await runObservedRequestEffect(activeRequest, 'prompt.steer', async () => {
          await enterPrompt(message, activeRequest, { kind: 'steer' });
          reanchored = await waitForSubmittedUserTurnAnchor(activeRequest, beforeTurnKeys, { kind: 'steer', replace: true, timeoutMs: 5_000 });
        }, { evidence: { messageLength: message.length } });
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
          activeRequest.update('request.anchor_updated', {
            pendingSubmittedTurnBaseline: null,
            pendingSubmittedTurnKind: '',
            pendingSubmittedTurnExpectedText: '',
          });
        }
        send({ type: 'command.error', commandId, message: err.message || String(err) });
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
