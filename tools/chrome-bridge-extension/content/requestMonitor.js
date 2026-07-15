// Active request DOM monitoring and terminal observation reporting.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestMonitor(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      REQUEST_LIFECYCLE_CORE,
      REQUEST_SNAPSHOT_POLICY,
      conversationIdFromUrl,
      diagnostic,
      emitChatEvent,
      emitRequestProgress,
      findChatMain,
      findTurnByKey,
      getActiveRequest,
      getAssistantNodes,
      getCurrentSession,
      getTurnNodes,
      isGenerating,
      markRequestProgress,
      readAssistantSnapshot,
      readRecentAssistantSnapshots,
      readFinalizationSignals,
      refreshRequestTurnAnchors,
      schedulePageStatus,
      scheduleTabObservation,
      send,
      setActiveRequest,
      setRequestPhase,
      shouldDeferFinalizationForSteer,
    } = deps;

    function scheduleCollect(request, reason = 'mutation', delayMs = 50) {
      if (!request || request.finished) return;
      if (request.collectScheduled) return;
      request.collectScheduled = true;
      request.collectTimer = setTimeout(() => {
        request.collectScheduled = false;
        request.collectTimer = null;
        collectAndEmit(request, reason);
      }, Math.max(0, Number(delayMs) || 0));
    }
  
    function findChatObservationRoot(request = null) {
      const anchoredTurn = findTurnByKey(request?.assistantTurnKey || request?.submittedUserTurnKey || '');
      return anchoredTurn?.closest?.('main')
        || anchoredTurn?.closest?.('[role="main"]')
        || findChatMain()
        || null;
    }
  
    function attachDomObserver(request) {
      const root = findChatObservationRoot(request);
      if (!root) {
        if (!request.observerRootMissingLogged) {
          request.observerRootMissingLogged = true;
          diagnostic('dom_schema.chat_root_missing', { requestId: request.requestId, url: location.href });
        }
        return false;
      }
      request.observerRootMissingLogged = false;
      if (request.observerRoot === root) return true;
      try { request.observer?.disconnect(); } catch {}
      const listener = () => scheduleCollect(request, 'mutation', 50);
      request.observer = new MutationObserver(listener);
      request.observerRoot = root;
      request.observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'data-testid',
          'data-turn',
          'data-turn-id',
          'data-turn-id-container',
          'data-message-id',
          'data-message-author-role',
          'data-message-model-slug',
          'data-state',
          'aria-expanded',
          'aria-checked',
          'aria-busy',
          'aria-label',
          'aria-disabled',
          'disabled',
          'href',
          'download',
          'src',
        ],
      });
      diagnostic('dom_monitor.root_attached', {
        requestId: request.requestId,
        tagName: root.tagName || '',
        testId: root.getAttribute?.('data-testid') || '',
        fallback: false,
      });
      return true;
    }
  
    function startDomMonitor(request) {
      attachDomObserver(request);
      request.pollTimer = setInterval(() => {
        attachDomObserver(request);
        scheduleCollect(request, 'poll', 0);
      }, CONFIG.domPollMs);
      scheduleCollect(request, 'monitor.start', 0);
      diagnostic('dom_monitor.started', { requestId: request.requestId });
    }
  
    function collectAndEmit(request, collectReason = 'poll') {
      if (request.finished) return;
      if (request.collecting) {
        scheduleCollect(request, 'collect.rescheduled', 50);
        return;
      }
      request.collecting = true;
      try {
  
      // The observer may be attached before submission so it cannot miss the
      // first DOM mutation, but output/turn capture stays disarmed until the
      // exact pre-submit baseline has been recorded.
      if (!request.turnCaptureArmed) return;
  
      refreshRequestTurnAnchors(request);
      let snapshot = readAssistantSnapshot(request);
      let generating = Boolean(snapshot.stopVisible || isGenerating());
      const now = Date.now();
      if (!generating && request.sawGenerating && !REQUEST_SNAPSHOT_POLICY.snapshotHasResponse(snapshot)) {
        const resolved = REQUEST_SNAPSHOT_POLICY.resolveRequestSnapshot(request, snapshot, readRecentAssistantSnapshots(12));
        if (resolved.source !== 'empty' && resolved.source !== 'scoped') {
          snapshot = resolved.snapshot;
          generating = Boolean(snapshot.stopVisible || isGenerating());
          const recoverySignature = JSON.stringify([resolved.source, snapshot.turnKey || '', snapshot.answer || '', (snapshot.artifacts || []).map((item) => item.id || item.name || '')]);
          if (recoverySignature !== request.lastRecoverySnapshotSignature) {
            request.lastRecoverySnapshotSignature = recoverySignature;
            diagnostic('assistant_turn.recovered_after_generation', {
              requestId: request.requestId,
              source: resolved.source,
              turnKey: snapshot.turnKey || '',
              turnIndex: snapshot.turnIndex ?? -1,
              answerLength: String(snapshot.answer || '').length,
              artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
            });
          }
        }
      }
  
      if (snapshot.signature && snapshot.signature !== request.lastDomSignature) {
        const hadSignature = Boolean(request.lastDomSignature);
        request.lastDomSignature = snapshot.signature;
        request.stableSince = now;
        request.lastSnapshotChangedAt = now;
        if (hadSignature) markRequestProgress(request, `dom.signature:${snapshot.phase || 'changed'}`);
        if (request.options?.captureDomTimeline) {
          emitChatEvent(request, 'assistant.dom.snapshot', {
            collectReason,
            signature: snapshot.signature,
            phase: snapshot.phase || '',
            turnKey: snapshot.turnKey || '',
            turnIndex: snapshot.turnIndex ?? -1,
            messageId: snapshot.messageId || '',
            modelSlug: snapshot.modelSlug || '',
            answer: snapshot.answer || '',
            thinking: snapshot.thinking || '',
            progress: snapshot.progress || '',
            progressItems: snapshot.progressItems || [],
            reasoningHistory: snapshot.reasoningHistory || [],
            visibleBlocks: snapshot.visibleBlocks || [],
            responseBlocks: snapshot.responseBlocks || [],
            codeBlocks: snapshot.codeBlocks || [],
            codeBlockDiagnostics: snapshot.codeBlockDiagnostics || [],
            parserAudit: snapshot.parserAudit || null,
            rawText: snapshot.raw || '',
            format: snapshot.format || '',
            stopVisible: Boolean(snapshot.stopVisible),
            sendVisible: Boolean(snapshot.sendVisible),
            actionBarVisible: Boolean(snapshot.actionBarVisible),
            hasFinalMessage: Boolean(snapshot.hasFinalMessage),
            hasActiveTool: Boolean(snapshot.hasActiveTool),
          });
        }
      }
  
      if (snapshot.unknownTestIds?.length) {
        const unknownSignature = JSON.stringify(snapshot.unknownTestIds);
        if (unknownSignature !== request.lastUnknownTestIdsSignature) {
          request.lastUnknownTestIdsSignature = unknownSignature;
          diagnostic('dom_schema.unknown_testids', { requestId: request.requestId, turnKey: snapshot.turnKey || '', testIds: snapshot.unknownTestIds });
        }
      }
  
      if (snapshot.turnKey && snapshot.turnKey !== request.assistantTurnKey) {
        request.assistantTurnKey = snapshot.turnKey;
        request.assistantTurnIndex = snapshot.turnIndex ?? -1;
        request.assistantTurnLogged = true;
        diagnostic('assistant_turn.captured', { requestId: request.requestId, turnKey: snapshot.turnKey, turnIndex: snapshot.turnIndex ?? -1, reason: snapshot.reason || '' });
        emitChatEvent(request, 'assistant_turn.captured', { turnKey: snapshot.turnKey, turnIndex: snapshot.turnIndex ?? -1, reason: snapshot.reason || '' });
        setRequestPhase(request, generating ? 'generating' : 'waiting_for_assistant_output', { snapshotReason: snapshot.reason || '', domPhase: snapshot.phase || '', generating });
      }
  
      if (snapshot.phase === DOM_PARSER.PHASE.ASSISTANT_REASONING || snapshot.phase === DOM_PARSER.PHASE.TOOL_RUNNING) {
        setRequestPhase(request, snapshot.phase === DOM_PARSER.PHASE.TOOL_RUNNING ? 'tool_running' : 'assistant_reasoning', { domPhase: snapshot.phase, generating });
      } else if (snapshot.phase === DOM_PARSER.PHASE.ASSISTANT_FINAL_STREAMING || snapshot.phase === DOM_PARSER.PHASE.ASSISTANT_FINAL_STREAMING_WITH_HISTORY) {
        setRequestPhase(request, 'assistant_final_streaming', { domPhase: snapshot.phase, generating });
      } else if (snapshot.phase === DOM_PARSER.PHASE.NEEDS_CONFIRMATION) {
        setRequestPhase(request, 'needs_confirmation', { domPhase: snapshot.phase, meaningful: false });
      } else if (snapshot.phase === DOM_PARSER.PHASE.NEEDS_CONTINUE) {
        setRequestPhase(request, 'needs_continue', { domPhase: snapshot.phase, meaningful: false });
      }
  
      if (generating) {
        if (!request.sawGenerating) {
          send({ type: 'status', requestId: request.requestId, status: 'generating' });
          diagnostic('generation.started', { requestId: request.requestId });
          emitChatEvent(request, 'generation.started');
        }
        if (![DOM_PARSER.PHASE.ASSISTANT_REASONING, DOM_PARSER.PHASE.TOOL_RUNNING, DOM_PARSER.PHASE.ASSISTANT_FINAL_STREAMING, DOM_PARSER.PHASE.ASSISTANT_FINAL_STREAMING_WITH_HISTORY].includes(snapshot.phase)) {
          setRequestPhase(request, 'generating', { generating: true, domPhase: snapshot.phase || '' });
        }
        request.sawGenerating = true;
        request.generationIdleSince = 0;
        request.steerWaitStartedAt = 0;
        request.terminalCandidateSince = 0;
        request.steerWaitExpiredAt = 0;
      } else if (!request.generationIdleSince) {
        request.generationIdleSince = now;
        if (request.sawGenerating && !request.generationStoppedSent) {
          request.generationStoppedSent = true;
          send({ type: 'status', requestId: request.requestId, status: 'finalizing' });
          diagnostic('generation.stopped', { requestId: request.requestId });
          emitChatEvent(request, 'generation.stopped');
          setRequestPhase(request, 'post_stop_settle', { generating: false });
        }
      }
  
      if (request.sawGenerating && request.generationIdleSince && !request.sawAnswer && !snapshot.answer && !(snapshot.artifacts || []).length && !request.artifacts.length) {
        const idleForMs = now - request.generationIdleSince;
        if (idleForMs > 1500 && !request.assistantTurnMissingLogged) {
          request.assistantTurnMissingLogged = true;
          diagnostic('assistant_turn.not_found_after_generation', {
            requestId: request.requestId,
            idleForMs,
            submittedUserTurnKey: request.submittedUserTurnKey || '',
            submittedUserTurnIndex: request.submittedUserTurnIndex,
            turnCount: getTurnNodes().length,
            assistantNodeCount: getAssistantNodes().length,
            snapshotReason: snapshot.reason || '',
          });
        }
        if (idleForMs > 8000 && !request.assistantTurnRecoveryPendingLogged) {
          request.assistantTurnRecoveryPendingLogged = true;
          diagnostic('assistant_turn.recovery_pending', {
            requestId: request.requestId,
            idleForMs,
            submittedUserTurnKey: request.submittedUserTurnKey || '',
            assistantTurnKey: request.assistantTurnKey || '',
          });
        }
      }
  
      const completedReasoning = Array.isArray(snapshot.reasoningHistory) ? snapshot.reasoningHistory : [];
      for (const item of completedReasoning) {
        const id = String(item?.id || item?.key || '');
        if (!id) continue;
        const existingIndex = request.reasoningHistory.findIndex((record) => String(record?.id || record?.key || '') === id);
        const record = { ...item, id, key: id, at: item.lastSeenAt || now, turnKey: snapshot.turnKey || '' };
        if (existingIndex >= 0) request.reasoningHistory[existingIndex] = record;
        else request.reasoningHistory.push(record);
      }
  
      if (snapshot.thinking !== request.lastVisibleThinking) {
        request.lastVisibleThinking = snapshot.thinking;
        request.lastThinking = snapshot.thinking;
        markRequestProgress(request, snapshot.thinking ? 'thinking.snapshot' : 'thinking.cleared');
        send({ type: 'thinking.snapshot', requestId: request.requestId, text: snapshot.thinking, phase: snapshot.phase || '', messageId: snapshot.messageId || '', modelSlug: snapshot.modelSlug || '' });
        diagnostic('thinking.snapshot', { requestId: request.requestId, length: snapshot.thinking.length, phase: snapshot.phase || '' });
        emitRequestProgress(request, snapshot, generating, snapshot.thinking ? 'thinking.snapshot' : 'thinking.cleared', { force: true });
      }
  
      const progressItemsFingerprint = JSON.stringify((snapshot.progressItems || []).map((item) => [
        item.key || '',
        item.kind || '',
        item.text || '',
        item.state || '',
        item.active ? 'active' : '',
      ]));
      if (snapshot.progress !== request.lastProgressText || progressItemsFingerprint !== request.lastProgressItemsFingerprint) {
        request.lastProgressText = snapshot.progress;
        request.lastProgressItemsFingerprint = progressItemsFingerprint;
        request.lastProgressItems = snapshot.progressItems || [];
        request.lastSnapshotChangedAt = now;
        markRequestProgress(request, snapshot.progress ? 'assistant.progress.snapshot' : 'assistant.progress.cleared');
        send({ type: 'assistant.progress.snapshot', requestId: request.requestId, text: snapshot.progress, items: snapshot.progressItems || [], kind: 'visible_progress', phase: snapshot.phase || '', assistantTurnKey: snapshot.turnKey || request.assistantTurnKey || '' });
        diagnostic('assistant.progress.snapshot', { requestId: request.requestId, length: snapshot.progress.length, phase: snapshot.phase || '' });
        emitChatEvent(request, 'assistant.progress.snapshot', { text: snapshot.progress, items: snapshot.progressItems || [], length: snapshot.progress.length, phase: snapshot.phase || '', assistantTurnKey: snapshot.turnKey || request.assistantTurnKey || '' });
        emitRequestProgress(request, snapshot, generating, snapshot.progress ? 'assistant.progress.snapshot' : 'assistant.progress.cleared', { force: true });
      }
  
      if (snapshot.answer && snapshot.answer !== request.lastAnswer) {
        request.lastAnswer = snapshot.answer;
        request.sawAnswer = true;
        markRequestProgress(request, 'answer.snapshot');
        request.stableSince = now;
        request.lastSnapshotChangedAt = now;
        send({ type: 'answer.snapshot', requestId: request.requestId, text: snapshot.answer });
        diagnostic('answer.snapshot', { requestId: request.requestId, length: snapshot.answer.length, format: snapshot.format, phase: snapshot.phase || '', messageId: snapshot.messageId || '', modelSlug: snapshot.modelSlug || '' });
        emitRequestProgress(request, snapshot, generating, 'answer.snapshot', { force: true });
      }
  
      const artifactFingerprint = JSON.stringify(snapshot.artifacts.map((artifact) => [
        artifact.id,
        artifact.kind,
        artifact.name,
        artifact.url || artifact.src || artifact.downloadUrl,
        artifact.mime || '',
        artifact.phase || '',
        artifact.state || '',
        artifact.downloadable ? 'downloadable' : '',
        artifact.downloadActionPresent ? 'action' : '',
        artifact.actionLabel || '',
        artifact.lifecycleObserved ?? null,
      ]));
      if (artifactFingerprint !== request.lastArtifactsFingerprint) {
        request.lastArtifactsFingerprint = artifactFingerprint;
        request.artifacts = snapshot.artifacts;
        request.stableSince = now;
        request.lastSnapshotChangedAt = now;
        markRequestProgress(request, 'artifact.snapshot');
        send({ type: 'artifact.snapshot', requestId: request.requestId, artifacts: snapshot.artifacts });
        diagnostic('artifact.snapshot', { requestId: request.requestId, count: snapshot.artifacts.length });
        emitChatEvent(request, 'artifact.snapshot', { artifacts: snapshot.artifacts });
        const ignoredArtifacts = snapshot.artifacts.filter((artifact) => {
          const phase = String(artifact?.phase || 'READY').toUpperCase();
          return phase !== 'READY' && phase !== 'FAILED' && !DOM_PARSER.artifactBlocksCompletion(artifact);
        });
        const ignoredFingerprint = JSON.stringify(ignoredArtifacts.map((artifact) => [artifact.id, artifact.name, artifact.phase]));
        if (ignoredFingerprint !== request.lastIgnoredArtifactFingerprint) {
          request.lastIgnoredArtifactFingerprint = ignoredFingerprint;
          if (ignoredArtifacts.length) {
            diagnostic('artifact.nonblocking_candidates_ignored', {
              requestId: request.requestId,
              artifacts: ignoredArtifacts.map((artifact) => ({ id: artifact.id || '', name: artifact.name || '', phase: artifact.phase || '' })),
            });
            emitChatEvent(request, 'artifact.nonblocking_candidates_ignored', {
              artifacts: ignoredArtifacts.map((artifact) => ({ id: artifact.id || '', name: artifact.name || '', phase: artifact.phase || '' })),
            });
          }
        }
        emitRequestProgress(request, snapshot, generating, 'artifact.snapshot', { force: true });
      }
  
      if (snapshot.raw && snapshot.raw !== request.lastRaw) request.lastRaw = snapshot.raw;
  
      if (request.sentAt) {
        const sentFor = now - request.sentAt;
        if (!request.sawGenerating && !request.sawAnswer && sentFor > CONFIG.generationStartTimeoutMs && !request.generationStartWarningSent) {
          request.generationStartWarningSent = true;
          diagnostic('generation.start_timeout_warning', { requestId: request.requestId, sentFor });
          emitChatEvent(request, 'generation.start_timeout_warning', { sentFor });
        }
        if (request.sawGenerating && !request.sawAnswer && sentFor > CONFIG.firstOutputTimeoutMs && !request.firstOutputWarningSent) {
          request.firstOutputWarningSent = true;
          diagnostic('generation.first_output_timeout_warning', { requestId: request.requestId, sentFor });
          emitChatEvent(request, 'generation.first_output_timeout_warning', { sentFor });
        }
        if (CONFIG.maxRequestTimeoutMs > 0 && sentFor > CONFIG.maxRequestTimeoutMs && !request.maxRequestTimeoutWarningSent) {
          request.maxRequestTimeoutWarningSent = true;
          diagnostic('request.max_timeout_warning', { requestId: request.requestId, sentFor, maxRequestTimeoutMs: CONFIG.maxRequestTimeoutMs });
          emitChatEvent(request, 'request.max_timeout_warning', { sentFor, maxRequestTimeoutMs: CONFIG.maxRequestTimeoutMs });
        }
      }
  
      emitRequestProgress(request, snapshot, generating, 'dom.poll', { meaningful: false });
  
      const answerSettleMs = Math.max(1500, Number(request.options.answerSettleMs) || CONFIG.defaultAnswerSettleMs);
      const doneSettleMs = Math.max(300, Number(request.options.answerDoneSettleMs) || CONFIG.defaultAnswerDoneSettleMs);
      const stableForMs = request.stableSince ? now - request.stableSince : 0;
      const generationIdleForMs = request.generationIdleSince ? now - request.generationIdleSince : 0;
      const oldEnough = now - request.startedAt >= 1000;
      const hasOutput = request.sawAnswer || request.artifacts.length > 0;
  
      const signals = readFinalizationSignals(request, snapshot, generating);
      if (!signals.conversationMatches) {
        reportTerminalFailure(request, new Error(`CONVERSATION_CHANGED: expected ${request.options?.sessionId || 'requested session'}, current ${snapshot.conversationId || 'unknown'}`), {
          code: 'CONVERSATION_CHANGED',
          evidence: { expectedConversationId: request.options?.sessionId || '', currentConversationId: snapshot.conversationId || '' },
        });
        return;
      }
      if (signals.hasError && !generating && stableForMs >= 1000) {
        reportTerminalFailure(request, new Error(`CHATGPT_UI_ERROR: ${snapshot.errorText || 'ChatGPT displayed an error state.'}`), {
          code: 'CHATGPT_UI_ERROR',
          evidence: { errorText: snapshot.errorText || '', domPhase: snapshot.phase || '' },
        });
        return;
      }
  
      const domCompleted = DOM_PARSER.isTerminalResponseSnapshot(snapshot, conversationIdFromUrl(request.options?.sessionId || '') || String(request.options?.sessionId || ''));
      const terminalSettleMs = Math.max(500, Number(request.options?.postStopTerminalSettleMs) || CONFIG.postStopTerminalSettleMs);
      const terminalEvidence = REQUEST_SNAPSHOT_POLICY.terminalObservationEvidence({
        request,
        snapshot,
        signals,
        generating,
        stableForMs,
        generationIdleForMs,
        terminalSettleMs,
        networkDone: request.networkDone,
      });
      if (terminalEvidence.candidateVisible && !request.terminalCandidateSince) request.terminalCandidateSince = now;
      if (!terminalEvidence.candidateVisible) request.terminalCandidateSince = 0;
      const terminalSettled = terminalEvidence.candidateVisible && (now - (request.terminalCandidateSince || now)) >= terminalSettleMs;
      const continuationDeferred = shouldDeferFinalizationForSteer(request, snapshot, signals, now);
      const requiredStableMs = request.networkDone ? doneSettleMs : answerSettleMs;
      const doneByDom = oldEnough
        && hasOutput
        && domCompleted
        && terminalEvidence.eligible
        && stableForMs >= requiredStableMs
        && terminalSettled
        && !continuationDeferred;
      const doneByNetwork = doneByDom && request.networkDone;
  
      if (doneByDom) {
        diagnostic(doneByNetwork ? 'done.by_network' : 'done.by_dom', {
          requestId: request.requestId,
          stableForMs,
          generationIdleForMs,
          domPhase: snapshot.phase || '',
          messageId: snapshot.messageId || '',
          modelSlug: snapshot.modelSlug || '',
          actionBarVisible: signals.actionBarVisible,
          sendButtonVisible: signals.sendButtonVisible,
          continueButtonVisible: signals.continueButtonVisible,
          steerControlVisible: signals.steerControlVisible,
          regenerateButtonVisible: signals.regenerateButtonVisible,
          terminalMarkerVisible: signals.terminalMarkerVisible,
          finalizationConfidence: terminalEvidence.confidence,
        });
        setRequestPhase(request, 'terminal_snapshot_observed', {
          reason: doneByNetwork ? 'done.by_network' : 'done.by_dom',
          stableForMs,
          generationIdleForMs,
          domPhase: snapshot.phase || '',
          finalizationConfidence: terminalEvidence.confidence,
        });
        emitTerminalSnapshot(request, snapshot, {
          reason: doneByNetwork ? 'done.by_network' : 'done.by_dom',
          finishReason: doneByNetwork ? 'network_terminal_observation' : 'dom_terminal_observation',
          stableForMs,
          generationIdleForMs,
          terminalSettled,
          finalizationConfidence: terminalEvidence.confidence,
          networkDone: request.networkDone,
        });
      }
      } finally {
        request.collecting = false;
      }
    }
  
    function scheduleReleaseFallback(request, reason = 'terminal_observation') {
      if (!request || request.finished || request.releaseFallbackTimer) return;
      request.releaseFallbackTimer = setTimeout(() => {
        request.releaseFallbackTimer = null;
        if (!request.finished) releaseRequest(request, `${reason}:server_release_timeout`);
      }, 15_000);
      request.releaseFallbackTimer.unref?.();
    }
  
    function emitTerminalSnapshot(request, snapshot, details = {}) {
      if (!request || request.finished) return false;
      const signature = REQUEST_LIFECYCLE_CORE.terminalSnapshotSignature(snapshot);
      if (signature && signature === request.terminalSnapshotSignature) return false;
      request.terminalSnapshotSignature = signature;
      const payload = {
        ...REQUEST_LIFECYCLE_CORE.terminalSnapshotPayload(request, snapshot, details),
        session: getCurrentSession(),
        url: location.href,
        title: document.title,
      };
      diagnostic('request.terminal_snapshot', {
        requestId: request.requestId,
        answerLength: payload.answer.length,
        artifactCount: payload.artifacts.length,
        turnKey: payload.turnKey || '',
        finishReason: payload.finishReason,
      });
      send(payload, { priority: true, immediatePost: true, timeout: 5_000 });
      scheduleTabObservation('request.terminal_snapshot', 0);
      scheduleReleaseFallback(request, 'terminal_snapshot');
      return true;
    }
  
    function reportTerminalFailure(request, error, details = {}) {
      if (!request || request.finished) return false;
      const payload = REQUEST_LIFECYCLE_CORE.terminalFailurePayload(request, error, details);
      const signature = JSON.stringify([payload.code, payload.message, payload.effectId, payload.effectType]);
      if (signature === request.terminalFailureSignature) return false;
      request.terminalFailureSignature = signature;
      setRequestPhase(request, 'terminal_failure_observed', {
        meaningful: true,
        code: payload.code,
        effectType: payload.effectType || '',
      });
      diagnostic('request.terminal_failure', {
        requestId: request.requestId,
        code: payload.code,
        message: payload.message,
        effectType: payload.effectType || '',
      });
      send(payload, { priority: true, immediatePost: true, timeout: 5_000 });
      scheduleTabObservation('request.terminal_failure', 0);
      scheduleReleaseFallback(request, 'terminal_failure');
      return true;
    }
  
    function releaseRequest(request, reason = 'server_terminal') {
      if (!request || request.finished) return false;
      request.finished = true;
      try { request.observer?.disconnect(); } catch {}
      if (request.pollTimer) clearInterval(request.pollTimer);
      if (request.collectTimer) clearTimeout(request.collectTimer);
      if (request.releaseFallbackTimer) clearTimeout(request.releaseFallbackTimer);
      request.releaseFallbackTimer = null;
      if (getActiveRequest() === request) {
        setActiveRequest(null);
        schedulePageStatus('page.changed', 0);
        scheduleTabObservation('request.released', 0);
      }
      diagnostic('request.released', { requestId: request.requestId, reason });
      return true;
    }
  
  
    return Object.freeze({
      attachDomObserver,
      collectAndEmit,
      emitTerminalSnapshot,
      findChatObservationRoot,
      releaseRequest,
      reportTerminalFailure,
      scheduleCollect,
      startDomMonitor,
    });
  }

  globalThis.ChatGptRequestMonitor = Object.freeze({ createRequestMonitor });
})();
