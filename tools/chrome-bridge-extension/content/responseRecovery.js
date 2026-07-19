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

    function handleResponseSnapshotRequest(payload) {
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
          send({ type: 'request.snapshot', commandId, requestId: expectedRequestId, active, generating, activeRequest: status, phase, artifacts: [], answer: '', thinking: '', progress: '', url: location.href, title: document.title, session: getCurrentSession() });
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
        turnIndex: snapshot.turnIndex ?? -1,
        candidateIndex: snapshot.candidateIndex || extra.candidateIndex || 1,
        preview: normalizeText(snapshot.answer || snapshot.thinking || snapshot.progress || '').slice(0, 260),
        answerLength: (snapshot.answer || '').length,
        thinkingLength: (snapshot.thinking || '').length,
        artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
        ...extra,
      };
    }
  
    function handleResponseRecoverLatest(payload) {
      const commandId = payload.commandId;
      try {
        const index = Math.max(1, Number(payload.index) || 1);
        const snapshot = readRecentAssistantSnapshots(index)[index - 1] || readLatestAssistantSnapshot(index);
        const hasContent = Boolean(snapshot.answer || snapshot.artifacts.length);
        if (!hasContent) throw new Error(`No assistant response #${index} is visible in the current ChatGPT tab`);
        const session = getCurrentSession();
        send({ type: 'response.recovered', ...responsePayloadFromSnapshot(snapshot, commandId, { session, source: index === 1 ? 'latest-assistant-turn' : `assistant-turn-${index}` }) });
        diagnostic('response.recovered', { commandId, index, answerLength: (snapshot.answer || '').length, artifacts: snapshot.artifacts.length, turnKey: snapshot.turnKey || '', turnIndex: snapshot.turnIndex ?? -1 });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    function handleResponseRecoverTurnKey(payload) {
      const commandId = payload.commandId;
      try {
        const key = String(payload.turnKey || '');
        const snapshot = readAssistantSnapshotByTurnKey(key);
        const hasContent = Boolean(snapshot && (snapshot.answer || snapshot.artifacts.length));
        if (!hasContent) throw new Error(`No assistant response with turnKey ${key || '(empty)'} is visible in the current ChatGPT tab`);
        const session = getCurrentSession();
        send({ type: 'response.recovered', ...responsePayloadFromSnapshot(snapshot, commandId, { session, source: 'assistant-turn-key' }) });
        diagnostic('response.recovered.turnKey', { commandId, turnKey: key, answerLength: (snapshot.answer || '').length, artifacts: snapshot.artifacts.length, turnIndex: snapshot.turnIndex ?? -1 });
      } catch (err) {
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    function handleResponseRecoverList(payload) {
      const commandId = payload.commandId;
      try {
        const limit = Math.max(1, Math.min(10, Number(payload.limit) || 5));
        const session = getCurrentSession();
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
