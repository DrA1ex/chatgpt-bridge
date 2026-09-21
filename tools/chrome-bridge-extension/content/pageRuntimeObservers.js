// Page lifecycle hooks and passive turn context for the shared observation kernel.
// The runtime is activated only after the local Bridge handshake succeeds.
(() => {
  'use strict';

  function createPageRuntimeObservers(deps = {}) {
    const {
      diagnostic,
      getActiveRequest,
      getCurrentSession,
      getTurnNodes,
      removeFloatingPanel,
      readUserTurnPromptText,
      scheduleCollect,
      schedulePageStatus,
      scheduleTabObservation,
      startPageReadinessMonitor,
      startTabObserver,
      stopPageReadinessMonitor,
      stopTabObserver,
      syncFloatingPanelVisibility,
      turnKey,
      turnRole,
      visibleText,
    } = deps;

    let promptBoundary = null;
    let started = false;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    let pushStateWrapper = null;
    let replaceStateWrapper = null;

    function roleFor(turn) {
      return typeof turnRole === 'function'
        ? turnRole(turn)
        : turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '';
    }

    function textFor(turn) {
      if (roleFor(turn) === 'user' && typeof readUserTurnPromptText === 'function') return String(readUserTurnPromptText(turn) || '').trim();
      return String(typeof visibleText === 'function'
        ? visibleText(turn)
        : turn?.innerText || turn?.textContent || '').trim();
    }

    function precedingUserPrompt(ref = {}, turns = getTurnNodes()) {
      for (let index = Math.min(Number(ref.index) - 1, turns.length - 1); index >= 0; index -= 1) {
        const turn = turns[index];
        if (roleFor(turn) !== 'user') continue;
        return {
          key: String(turnKey(turn, index) || `user-${index}`),
          index,
          text: textFor(turn),
        };
      }
      return { key: '', index: -1, text: '' };
    }

    function readObservedTurnContext(snapshot = {}) {
      const turns = getTurnNodes();
      const expectedKey = String(snapshot.turnKey || '');
      if (!expectedKey) return null;
      const index = turns.findIndex((turn, index) => String(turnKey(turn, index) || '') === expectedKey);
      const ref = index >= 0 && roleFor(turns[index]) === 'assistant' ? { index } : null;
      if (!ref) return null;
      const user = precedingUserPrompt(ref, turns);
      return {
        turnKey: String(snapshot.turnKey || ref.key),
        turnIndex: Number.isInteger(snapshot.turnIndex) ? snapshot.turnIndex : ref.index,
        userTurnKey: user.key,
        userTurnIndex: user.index,
        userPrompt: user.text,
        promptBoundary: promptBoundary ? {
          submittedUserTurnKey: String(promptBoundary.submittedUserTurnKey || ''),
          submittedUserTurnIndex: Number(promptBoundary.submittedUserTurnIndex ?? -1),
          registeredAt: Number(promptBoundary.registeredAt) || 0,
        } : null,
      };
    }

    function baselinePassiveTurns(reason = 'baseline') {
      diagnostic('observed.turns.baseline_requested', {
        reason,
        sessionId: String(getCurrentSession()?.id || 'new'),
        owner: 'server_observation_journal',
      });
      scheduleTabObservation(`passive.baseline:${reason}`, 0);
    }

    function registerPassivePromptBoundary(request = {}) {
      promptBoundary = {
        sessionId: String(getCurrentSession()?.id || 'new'),
        submittedUserTurnKey: String(request.submittedUserTurnKey || ''),
        submittedUserTurnIndex: Number.isInteger(request.submittedUserTurnIndex) ? request.submittedUserTurnIndex : -1,
        registeredAt: Date.now(),
      };
      diagnostic('observed.turns.prompt_boundary', promptBoundary);
      scheduleTabObservation('passive.prompt_boundary', 0);
    }

    function schedulePassiveTurnScan(reason = 'passive.changed', delayMs = 0) {
      scheduleTabObservation(reason, delayMs);
    }

    function emitPassiveUserTurn() {
      scheduleTabObservation('passive.user_turn', 0);
      return true;
    }

    function markPassiveTurnDirty() {
      scheduleTabObservation('passive.turn_dirty', 0);
    }

    function ensurePassiveSession(reason = 'session-check') {
      const sessionId = String(getCurrentSession()?.id || 'new');
      if (promptBoundary && promptBoundary.sessionId !== sessionId) promptBoundary = null;
      diagnostic('observed.turns.session_checked', { reason, sessionId });
      return sessionId;
    }

    function attachPassiveTurnObserver() {
      scheduleTabObservation('passive.observer_attached', 0);
    }

    function handlePageLocationChange() {
      if (!started) return;
      ensurePassiveSession('location-change');
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation('location.changed', 0);
      setTimeout(syncFloatingPanelVisibility, 0);
    }

    function handleForegroundResync(reason = 'page.foreground') {
      if (!started) return;
      syncFloatingPanelVisibility();
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation(reason, 0);
      const request = getActiveRequest();
      if (request && document.visibilityState === 'visible') scheduleCollect(request, reason, 0);
    }

    function handleDomReady() { if (started) syncFloatingPanelVisibility(); }
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') handleForegroundResync('visibility.visible');
      else schedulePageStatus('page.changed', 0);
    }
    function handleFocus() { handleForegroundResync('window.focus'); }
    function handlePageShow() { handleForegroundResync('page.show'); }
    function handleBlur() { if (started) schedulePageStatus('page.changed', 0); }

    function start() {
      if (started) return api;
      started = true;
      pushStateWrapper = function bridgePushState() {
        const result = originalPushState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };
      replaceStateWrapper = function bridgeReplaceState() {
        const result = originalReplaceState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };
      history.pushState = pushStateWrapper;
      history.replaceState = replaceStateWrapper;
      window.addEventListener('popstate', handlePageLocationChange);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleDomReady, { once: true });
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('focus', handleFocus);
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener('blur', handleBlur);
      syncFloatingPanelVisibility();
      startPageReadinessMonitor();
      startTabObserver();
      diagnostic('page_runtime.activated', { reason: 'server.hello' });
      return api;
    }

    function stop(reason = 'transport.disconnected') {
      if (!started) return api;
      started = false;
      if (history.pushState === pushStateWrapper) history.pushState = originalPushState;
      if (history.replaceState === replaceStateWrapper) history.replaceState = originalReplaceState;
      pushStateWrapper = null;
      replaceStateWrapper = null;
      window.removeEventListener('popstate', handlePageLocationChange);
      document.removeEventListener('DOMContentLoaded', handleDomReady);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('blur', handleBlur);
      stopPageReadinessMonitor?.();
      stopTabObserver?.();
      removeFloatingPanel?.();
      diagnostic('page_runtime.deactivated', { reason });
      return api;
    }

    const api = Object.freeze({
      attachPassiveTurnObserver,
      baselinePassiveTurns,
      emitPassiveUserTurn,
      ensurePassiveSession,
      handleForegroundResync,
      isStarted: () => started,
      markPassiveTurnDirty,
      readObservedTurnContext,
      registerPassivePromptBoundary,
      schedulePassiveTurnScan,
      start,
      stop,
    });
    return api;
  }

  globalThis.ChatGptPageRuntimeObservers = Object.freeze({ createPageRuntimeObservers });
})();
