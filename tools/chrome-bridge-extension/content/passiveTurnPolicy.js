// Pure terminal and baseline policy for passive assistant-turn observation.
// Loaded as a classic MV3 content script before pageRuntimeObservers.js.
(() => {
  'use strict';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new Error(`Passive turn policy requires ${name}`);
    return value;
  }

  function isTerminalSnapshot(snapshot = {}, domParser = null) {
    const completed = requireFunction(domParser?.isCompletedSnapshot, 'DOM_PARSER.isCompletedSnapshot');
    return Boolean(
      snapshot?.turnKey
      && completed(snapshot, '')
      && !snapshot.stopVisible
      && !snapshot.hasActiveTool
      && !snapshot.needsContinue
      && !snapshot.needsConfirmation
      && !snapshot.hasError
    );
  }

  function shouldBaselineAll(reason = '', options = {}) {
    if (options?.markAll === true) return true;
    return String(reason || '') === 'passive-prompt-submit';
  }

  function activeRequestOwnsSnapshot(snapshot = {}, request = {}, requestPolicy = null) {
    if (!request) return false;
    const turnKey = String(snapshot?.turnKey || '');
    const assistantTurnKey = String(request?.assistantTurnKey || '');
    // Passive observation may run before the active monitor captures its exact
    // assistant key. Treat that state as ambiguous and defer instead of using
    // the active request's broad post-submit index heuristic, which can also
    // match an unrelated workflow turn from another bridge.
    if (turnKey && assistantTurnKey) return turnKey === assistantTurnKey;
    const belongs = requestPolicy?.snapshotBelongsToRequest;
    return Boolean(!turnKey && typeof belongs === 'function' && belongs(snapshot, request));
  }

  function activeRequestDisposition(snapshot = {}, request = null, requestPolicy = null) {
    if (!request) return 'emit';
    return activeRequestOwnsSnapshot(snapshot, request, requestPolicy) ? 'suppress-owned' : 'defer';
  }

  function isAfterPromptBoundary(ref = {}, boundary = null, sessionId = '') {
    if (!boundary || String(boundary.sessionId || '') !== String(sessionId || '')) return false;
    const baselineTurnKeys = boundary.baselineTurnKeys && typeof boundary.baselineTurnKeys.has === 'function'
      ? boundary.baselineTurnKeys
      : new Set(boundary.baselineTurnKeys && typeof boundary.baselineTurnKeys[Symbol.iterator] === 'function'
        ? Array.from(boundary.baselineTurnKeys)
        : []);
    if (baselineTurnKeys.has(String(ref.key || ''))) return false;
    const userIndex = Number.isInteger(boundary.submittedUserTurnIndex) ? boundary.submittedUserTurnIndex : -1;
    const turnIndex = Number.isInteger(ref.index) ? ref.index : -1;
    return userIndex >= 0 && turnIndex > userIndex;
  }

  globalThis.ChatGptPassiveTurnPolicy = Object.freeze({
    isTerminalSnapshot,
    shouldBaselineAll,
    activeRequestOwnsSnapshot,
    activeRequestDisposition,
    isAfterPromptBoundary,
  });
})();
