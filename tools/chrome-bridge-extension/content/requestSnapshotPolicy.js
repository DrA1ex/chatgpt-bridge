// Pure request-scoped snapshot recovery and terminal-observation policy.
// Loaded as a classic MV3 content script before requestMonitor.js.
(() => {
  'use strict';

  function artifacts(snapshot = {}) {
    return Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
  }

  function snapshotHasResponse(snapshot = {}) {
    return Boolean(String(snapshot.answer || '').trim() || artifacts(snapshot).length || snapshot.hasFinalMessage);
  }

  function snapshotBelongsToRequest(snapshot = {}, request = {}) {
    const key = String(snapshot.turnKey || '');
    const turnIndex = Number.isInteger(snapshot.turnIndex) ? snapshot.turnIndex : -1;
    const submittedIndex = Number.isInteger(request.submittedUserTurnIndex) ? request.submittedUserTurnIndex : -1;
    if (submittedIndex >= 0 && turnIndex >= 0) return turnIndex > submittedIndex;
    if (key && key === String(request.assistantTurnKey || '')) return true;
    const baseline = request.baselineTurnKeys instanceof Set
      ? request.baselineTurnKeys
      : new Set(Array.isArray(request.baselineTurnKeys) ? request.baselineTurnKeys : []);
    return Boolean(key && !baseline.has(key));
  }

  function selectRecoverySnapshot(request = {}, candidates = []) {
    return (Array.isArray(candidates) ? candidates : [])
      .filter((snapshot) => snapshotHasResponse(snapshot) && snapshotBelongsToRequest(snapshot, request))
      .sort((left, right) => {
        const leftIndex = Number.isInteger(left.turnIndex) ? left.turnIndex : -1;
        const rightIndex = Number.isInteger(right.turnIndex) ? right.turnIndex : -1;
        return rightIndex - leftIndex;
      })[0] || null;
  }

  function resolveRequestSnapshot(request = {}, scopedSnapshot = {}, recoveryCandidates = []) {
    if (snapshotHasResponse(scopedSnapshot)) return { snapshot: scopedSnapshot, source: 'scoped' };
    const recovered = selectRecoverySnapshot(request, recoveryCandidates);
    if (recovered) return { snapshot: recovered, source: 'recent_assistant_turn' };
    return { snapshot: scopedSnapshot, source: 'empty' };
  }

  function terminalObservationEvidence(input = {}) {
    const request = input.request || {};
    const snapshot = input.snapshot || {};
    const signals = input.signals || {};
    const artifactReady = artifacts(snapshot).length > 0;
    const hasOutput = Boolean(String(snapshot.answer || '').trim() || artifactReady);
    const streamingVisible = Boolean(snapshot.streamingVisible || /STREAMING/.test(String(snapshot.phase || '').toUpperCase()));
    const unblocked = !input.generating
      && !streamingVisible
      && !signals.stopButtonVisible
      && !signals.hasActiveTool
      && !signals.continueButtonVisible
      && !signals.needsConfirmation
      && !signals.hasError
      && signals.conversationMatches !== false;
    const strongUiEvidence = Boolean(signals.actionBarVisible || signals.regenerateButtonVisible || input.networkDone);
    const quietAfterGeneration = Boolean(input.sawGenerating)
      && Number(input.generationIdleForMs || 0) >= Math.max(2_500, Number(input.terminalSettleMs || 0));
    const outputIdentityVisible = Boolean(snapshot.hasFinalMessage || artifactReady);
    return {
      candidateVisible: hasOutput && outputIdentityVisible && unblocked,
      eligible: hasOutput && outputIdentityVisible && unblocked && (strongUiEvidence || quietAfterGeneration),
      confidence: strongUiEvidence ? 'high' : quietAfterGeneration ? 'medium' : 'low',
      strongUiEvidence,
      quietAfterGeneration,
      artifactReady,
      streamingVisible,
    };
  }

  globalThis.ChatGptRequestSnapshotPolicy = Object.freeze({
    snapshotHasResponse,
    snapshotBelongsToRequest,
    selectRecoverySnapshot,
    resolveRequestSnapshot,
    terminalObservationEvidence,
  });
})();
