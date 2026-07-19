// Page lifecycle hooks and passive turn context for the shared observation kernel.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createPageRuntimeObservers(deps = {}) {
    const {
      CONFIG,
      connect,
      diagnostic,
      getActiveRequest,
      getAssistantNodeFromTurn,
      getCurrentSession,
      getTurnNodes,
      scheduleCollect,
      schedulePageStatus,
      scheduleTabObservation,
      startPageReadinessMonitor,
      startTabObserver,
      syncFloatingPanelVisibility,
      turnKey,
      turnRole,
      visibleText,
    } = deps;

    const HOOK_SOURCE = 'chatgpt-browser-bridge-network-hook';
    const HOOK_NONCE = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let networkHookInjected = false;
    let promptBoundary = null;

    function roleFor(turn) {
      return typeof turnRole === 'function'
        ? turnRole(turn)
        : turn?.getAttribute?.('data-turn') || turn?.getAttribute?.('data-message-author-role') || '';
    }

    function textFor(turn) {
      return String(typeof visibleText === 'function'
        ? visibleText(turn)
        : turn?.innerText || turn?.textContent || '').trim();
    }

    function currentAssistantTurnRefs(limit = 80) {
      const turns = getTurnNodes();
      const offset = Math.max(0, turns.length - Math.max(1, Number(limit) || 80));
      const result = [];
      for (let index = offset; index < turns.length; index += 1) {
        const turn = turns[index];
        const node = getAssistantNodeFromTurn(turn);
        const key = String(turnKey(turn, index) || '');
        if (!node || !key) continue;
        result.push({ key, node, turn, index, turnCount: turns.length });
      }
      return result;
    }

    function precedingUserPrompt(ref = {}) {
      const turns = getTurnNodes();
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
      const refs = currentAssistantTurnRefs(24);
      const expectedKey = String(snapshot.turnKey || '');
      const ref = refs.find((item) => item.key === expectedKey) || refs.at(-1) || null;
      if (!ref) return null;
      const user = precedingUserPrompt(ref);
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

    function injectNetworkHook() {
      if (!CONFIG.networkStreamEnabled || networkHookInjected) return;
      networkHookInjected = true;
      const script = document.createElement('script');
      script.textContent = `(() => {
        if (window.__chatgptBridgeNetworkHookInstalled) return;
        window.__chatgptBridgeNetworkHookInstalled = true;
        const SOURCE = ${JSON.stringify(HOOK_SOURCE)};
        const NONCE = ${JSON.stringify(HOOK_NONCE)};
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
        const watch = (url, type = '') => /chatgpt|openai|conversation|backend-api|responses|stream|event-stream/i.test(String(url || '') + ' ' + String(type || ''));
        const post = (payload) => window.postMessage({ source: SOURCE, nonce: NONCE, ...payload }, '*');
        const watchBody = async (url, response) => {
          try {
            if (!response?.body || !decoder || !watch(url, response.headers?.get?.('content-type'))) return;
            const reader = response.body.getReader();
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
            post({ type: 'network.done', url: String(url || '') });
          } catch (error) { post({ type: 'network.error', url: String(url || ''), message: error?.message || String(error) }); }
        };
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') window.fetch = async function bridgeFetch(input) {
          const response = await originalFetch.apply(this, arguments);
          try { watchBody(typeof input === 'string' ? input : input?.url, response.clone()); } catch {}
          return response;
        };
      })();`;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    }

    function handleNetworkMessage(event) {
      if (event.source !== window) return;
      const payload = event.data;
      if (!payload || payload.source !== HOOK_SOURCE || payload.nonce !== HOOK_NONCE) return;
      diagnostic(payload.type === 'network.done' ? 'network.done_hint' : 'network.error', {
        requestId: String(getActiveRequest()?.requestId || ''),
        url: String(payload.url || ''),
        message: String(payload.message || ''),
        terminalAuthority: false,
      });
      scheduleTabObservation(payload.type === 'network.done' ? 'network.done_hint' : 'network.error', 0);
    }

    function handlePageLocationChange() {
      ensurePassiveSession('location-change');
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation('location.changed', 0);
      setTimeout(syncFloatingPanelVisibility, 0);
    }

    function handleForegroundResync(reason = 'page.foreground') {
      syncFloatingPanelVisibility();
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation(reason, 0);
      const request = getActiveRequest();
      if (request && document.visibilityState === 'visible') scheduleCollect(request, reason, 0);
    }

    function start() {
      const originalPushState = history.pushState;
      history.pushState = function bridgePushState() {
        const result = originalPushState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };
      const originalReplaceState = history.replaceState;
      history.replaceState = function bridgeReplaceState() {
        const result = originalReplaceState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };
      window.addEventListener('popstate', handlePageLocationChange);
      syncFloatingPanelVisibility();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncFloatingPanelVisibility, { once: true });
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') handleForegroundResync('visibility.visible');
        else schedulePageStatus('page.changed', 0);
      });
      window.addEventListener('focus', () => handleForegroundResync('window.focus'));
      window.addEventListener('pageshow', () => handleForegroundResync('page.show'));
      window.addEventListener('blur', () => schedulePageStatus('page.changed', 0));
      window.addEventListener('message', handleNetworkMessage);
      injectNetworkHook();
      startPageReadinessMonitor();
      startTabObserver();
      connect();
    }

    return Object.freeze({
      attachPassiveTurnObserver,
      baselinePassiveTurns,
      emitPassiveUserTurn,
      ensurePassiveSession,
      handleForegroundResync,
      markPassiveTurnDirty,
      readObservedTurnContext,
      registerPassivePromptBoundary,
      schedulePassiveTurnScan,
      start,
    });
  }

  globalThis.ChatGptPageRuntimeObservers = Object.freeze({ createPageRuntimeObservers });
})();
