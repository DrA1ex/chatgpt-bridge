// Focused request-command family. Loaded before requestCommands.js.
(() => {
  'use strict';

  function createRequestEffectReconciliation(deps = {}) {
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

      await settleEffectReconciliation({
        commandId, requestId, effectId, effectType,
        idempotencyKey: String(payload.idempotencyKey || ''),
        preconditionsHash: String(payload.preconditionsHash || ''),
        reconciliationOutcome: outcome, reconciliationReason: reason, evidence,
      });
      diagnostic('browser.effect.reconciled', { requestId, effectId, effectType, outcome, reason, evidence });
    }


    return Object.freeze({
      handleEffectReconcile
    });
  }

  globalThis.ChatGptRequestEffectReconciliation = Object.freeze({ createRequestEffectReconciliation });
})();
