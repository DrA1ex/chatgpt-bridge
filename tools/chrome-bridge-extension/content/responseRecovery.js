// Source-bound request snapshots and assistant response recovery.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createResponseRecovery(deps = {}) {
    const {
      DOM_PARSER,
      REQUEST_SNAPSHOT_POLICY,
      diagnostic,
      findStopButton,
      getActiveRequest,
      getCurrentSession,
      collectSessions,
      readVisibleHistory,
      readOlderVisibleHistory,
      isGenerating,
      normalizeText,
      publicRequestStatus,
      readAssistantSnapshot,
      readAssistantSnapshotByTurnKey,
      readLatestAssistantSnapshot,
      readRecentAssistantSnapshots,
      refreshRequestTurnAnchors,
      send,
    } = deps;

    async function reconciliationFor(payload, snapshot) {
      if (!payload.reconcileConversation || typeof payload.reconcileConversation !== 'object') return undefined;
      const expected = { ...payload.reconcileConversation,
        assistantMessageId: payload.reconcileConversation.assistantMessageId || snapshot?.messageId || '' };
      if (snapshot?.messageId && snapshot.messageId !== expected.assistantMessageId) {
        return globalThis.ChatGptConversationReconciliation.createResult(expected, 'mismatch', 'observed_assistant_identity');
      }
      return await globalThis.ChatGptConversationReconciliation.read(expected, snapshot?.answer, { signal: payload.signal });
    }

    async function handleResponseSnapshotRequest(payload) {
      const activeRequest = getActiveRequest();
      const commandId = payload.commandId;
      const expectedRequestId = String(payload.requestId || '');
      const expectedTurnKey = String(payload.turnKey || payload.assistantTurnKey || '');
  
      try {
        let snapshot = null;
        let active = false;
        let generating = false;
        let status = null;
        let phase = '';
  
        if (activeRequest && (!expectedRequestId || activeRequest.requestId === expectedRequestId)) {
          refreshRequestTurnAnchors(activeRequest);
          snapshot = readAssistantSnapshot(activeRequest);
          generating = Boolean(snapshot.stopVisible || isGenerating());
          if (!generating && !REQUEST_SNAPSHOT_POLICY.snapshotHasResponse(snapshot)) {
            const resolved = REQUEST_SNAPSHOT_POLICY.resolveRequestSnapshot(activeRequest, snapshot, readRecentAssistantSnapshots(12));
            snapshot = resolved.snapshot;
            if (resolved.source !== 'empty' && resolved.source !== 'scoped') {
              diagnostic('response.snapshot.recovered_request_turn', {
                commandId,
                requestId: activeRequest.requestId,
                source: resolved.source,
                turnKey: snapshot.turnKey || '',
                answerLength: String(snapshot.answer || '').length,
                artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
              });
            }
          }
          active = true;
          status = publicRequestStatus(activeRequest);
          phase = activeRequest.phase || '';
          diagnostic('response.snapshot.active_request', {
            commandId,
            requestId: activeRequest.requestId,
            turnKey: snapshot.turnKey || activeRequest.assistantTurnKey || '',
            generating,
            answerLength: (snapshot.answer || '').length,
            artifacts: snapshot.artifacts.length,
          });
        } else if (expectedTurnKey) {
          snapshot = readAssistantSnapshotByTurnKey(expectedTurnKey);
          active = false;
          generating = false;
          phase = 'snapshot_checked';
          diagnostic('response.snapshot.turn_key', {
            commandId,
            requestId: expectedRequestId,
            turnKey: expectedTurnKey,
            found: Boolean(snapshot && (snapshot.answer || snapshot.raw || snapshot.thinking || snapshot.artifacts?.length)),
          });
        } else {
          throw new Error('No active request in this tab and no assistantTurnKey was provided for a source-bound snapshot.');
        }
  
        const hasContent = Boolean(snapshot && (snapshot.answer || snapshot.thinking || snapshot.progress || snapshot.artifacts.length));
        if (!snapshot || !hasContent) {
          send({ type: 'request.snapshot', commandId, requestId: expectedRequestId, active, generating, activeRequest: status, phase, artifacts: [], answer: '', thinking: '', progress: '', url: location.href, title: document.title, session: getCurrentSession(), reconciliation: await reconciliationFor(payload, snapshot) });
          return;
        }
  
        const progress = snapshot.progress || '';
        const stopButtonVisible = Boolean(snapshot.stopVisible || findStopButton());
        send({
          type: 'request.snapshot',
          ...responsePayloadFromSnapshot(snapshot, commandId, {
            requestId: expectedRequestId || activeRequest?.requestId || '',
            session: getCurrentSession(),
            source: active ? 'active-request-snapshot' : 'assistant-turn-key-snapshot',
            active,
            activeRequest: status,
            generating,
            stopButtonVisible,
            progress,
            progressText: progress,
            progressItems: snapshot.progressItems || [],
            phase,
            completionEvidence: {
              generationStopped: !generating,
              finalMessage: Boolean(snapshot.hasFinalMessage),
              actionBarVisible: Boolean(snapshot.actionBarVisible),
            },
            domPhase: snapshot.phase || '',
            messageId: snapshot.messageId || '',
            reconciliation: await reconciliationFor(payload, snapshot),
            modelSlug: snapshot.modelSlug || '',
            actionBarVisible: Boolean(snapshot.actionBarVisible),
            reasoningHistory: Array.isArray(snapshot.reasoningHistory) ? snapshot.reasoningHistory : [],
          }),
        });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    function responsePayloadFromSnapshot(snapshot, commandId, extra = {}) {
      return {
        commandId,
        answer: snapshot.answer || '',
        thinking: snapshot.thinking || '',
        progress: snapshot.progress || '',
        progressItems: snapshot.progressItems || [],
        reasoningHistory: snapshot.reasoningHistory || [],
        responseBlocks: snapshot.responseBlocks || [],
        codeBlocks: snapshot.codeBlocks || [],
        codeBlockDiagnostics: snapshot.codeBlockDiagnostics || [],
        parserAudit: snapshot.parserAudit || null,
        domPhase: snapshot.phase || '',
        messageId: snapshot.messageId || '',
        modelSlug: snapshot.modelSlug || '',
        artifacts: snapshot.artifacts || [],
        url: location.href,
        title: document.title,
        recoveredAt: new Date().toISOString(),
        source: 'assistant-turn',
        format: snapshot.format || 'unknown',
        reason: snapshot.reason || '',
        turnKey: snapshot.turnKey || '',
        userTurnKey: snapshot.userTurnKey || '',
        turnIndex: snapshot.turnIndex ?? -1,
        candidateIndex: snapshot.candidateIndex || extra.candidateIndex || 1,
        preview: normalizeText(snapshot.answer || snapshot.thinking || snapshot.progress || '').slice(0, 260),
        answerLength: (snapshot.answer || '').length,
        thinkingLength: (snapshot.thinking || '').length,
        artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
        ...extra,
      };
    }
  
    async function handleResponseRecoverLatest(payload) {
      const commandId = payload.commandId;
      try {
        const index = Math.max(1, Number(payload.index) || 1);
        const snapshot = readRecentAssistantSnapshots(index)[index - 1] || readLatestAssistantSnapshot(index);
        const hasContent = Boolean(snapshot.answer || snapshot.artifacts.length);
        if (!hasContent) throw new Error(`No assistant response #${index} is visible in the current ChatGPT tab`);
        const session = getCurrentSession();
        send({ type: 'response.recovered', ...responsePayloadFromSnapshot(snapshot, commandId, { session, source: index === 1 ? 'latest-assistant-turn' : `assistant-turn-${index}`, reconciliation: await reconciliationFor(payload, snapshot) }) });
        diagnostic('response.recovered', { commandId, index, answerLength: (snapshot.answer || '').length, artifacts: snapshot.artifacts.length, turnKey: snapshot.turnKey || '', turnIndex: snapshot.turnIndex ?? -1 });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    async function handleResponseRecoverTurnKey(payload) {
      const commandId = payload.commandId;
      try {
        const key = String(payload.turnKey || '');
        const snapshot = readAssistantSnapshotByTurnKey(key);
        const hasContent = Boolean(snapshot && (snapshot.answer || snapshot.artifacts.length));
        if (!hasContent) throw new Error(`No assistant response with turnKey ${key || '(empty)'} is visible in the current ChatGPT tab`);
        const session = getCurrentSession();
        send({ type: 'response.recovered', ...responsePayloadFromSnapshot(snapshot, commandId, { session, source: 'assistant-turn-key', reconciliation: await reconciliationFor(payload, snapshot) }) });
        diagnostic('response.recovered.turnKey', { commandId, turnKey: key, answerLength: (snapshot.answer || '').length, artifacts: snapshot.artifacts.length, turnIndex: snapshot.turnIndex ?? -1 });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    async function handleResponseRecoverList(payload) {
      const commandId = payload.commandId;
      try {
        const limit = Math.max(1, Math.min(10, Number(payload.limit) || 5));
        const session = getCurrentSession();
        if (payload.historySessionId) {
          const sessionId = String(payload.historySessionId);
          if (session.id !== sessionId && !collectSessions?.().some((chat) => chat.id === sessionId)) {
            throw new Error('Requested conversation is not visible in this ChatGPT tab');
          }
          let history = await globalThis.ChatGptConversationReconciliation.readHistory(sessionId);
          const sourceGenerating = Boolean(isGenerating?.());
          const sourceRequestActive = Boolean(getActiveRequest?.());
          const currentSession = getCurrentSession();
          // External generation is observational only. A Bridge-owned turn
          // already has its own lifecycle, deltas and artifact pipeline.
          const externalGenerating = currentSession.id === sessionId && session.id === sessionId
            && sourceGenerating && !sourceRequestActive;
          const live = externalGenerating && readVisibleHistory
            ? { generating: true, messages: readVisibleHistory() } : null;
          const reason = history.reason || '';
          if (history.status !== 'available' && currentSession.id === sessionId && session.id === sessionId
            && reason !== 'page_conversation_changed' && readVisibleHistory) {
            const canScroll = () => getCurrentSession().id === sessionId && !isGenerating?.() && !getActiveRequest?.();
            const messages = readOlderVisibleHistory && canScroll() && !payload.historyBackground
              ? await readOlderVisibleHistory(canScroll) : readVisibleHistory();
            if (getCurrentSession().id !== sessionId) throw new Error('ChatGPT conversation changed during history import');
            if (messages.length && JSON.stringify(messages).length <= 500_000) {
              history = { status: 'available', source: 'visible-dom', conversationId: sessionId,
                messages, partial: true, reason, initialStatus: history.initialStatus, authRetry: history.authRetry,
                stage: history.stage, elapsedMs: history.elapsedMs };
            }
          }
          if (history.status === 'available' && currentSession.id === sessionId && (sourceGenerating || sourceRequestActive)) history.partial = true;
          if (live && JSON.stringify(live.messages).length <= 500_000) {
            history.live = live;
            // Do not persist the last provisional assistant fragment as
            // completed history when the record read failed.
            if (history.source === 'visible-dom') {
              const lastUser = history.messages.findLastIndex(message => message.role === 'user');
              if (lastUser >= 0) history.messages = history.messages.slice(0, lastUser + 1);
            }
          }
          diagnostic('conversation.history.read', {
            commandId, sessionId, source: history.source || 'conversation-record',
            status: history.status, reason, initialStatus: history.initialStatus,
            authRetry: history.authRetry, stage: history.stage, elapsedMs: history.elapsedMs, partial: Boolean(history.partial),
            messageCount: history.messages?.length || 0, sourceGenerating, sourceRequestActive,
          });
          send({ type: 'response.recovered.list', commandId, session: currentSession, candidates: [], history, sourceGenerating, sourceRequestActive });
          return;
        }
        const candidates = readRecentAssistantSnapshots(limit)
          .map((snapshot, index) => responsePayloadFromSnapshot(snapshot, commandId, { session, candidateIndex: index + 1 }))
          .filter((item) => {
            if (Array.isArray(item.artifacts) && item.artifacts.length) return true;
            const answer = normalizeText(item.answer || '');
            if (!answer && !item.thinking) return false;
            if (/^(thinking|thinking stopped|thinking остановлено|остановлено)$/i.test(answer)) return false;
            return true;
          });
        send({ type: 'response.recovered.list', commandId, candidates, session, url: location.href, title: document.title, recoveredAt: new Date().toISOString() });
        diagnostic('response.recovered.list', { commandId, count: candidates.length });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
  
    return Object.freeze({
      handleResponseRecoverLatest,
      handleResponseRecoverList,
      handleResponseRecoverTurnKey,
      handleResponseSnapshotRequest,
    });
  }

  globalThis.ChatGptResponseRecovery = Object.freeze({ createResponseRecovery });
})();
