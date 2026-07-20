(() => {
  'use strict';

  const IGNORED_OBSERVATION_MUTATION_SELECTOR = [
    '#chatgpt-bridge-panel-root',
    '#prompt-textarea',
    'textarea',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[data-testid="composer"]',
    '[data-testid*="composer" i]',
    'form[data-type="unified-composer"]',
  ].join(',');

  const TURN_OBSERVATION_MUTATION_SELECTOR = '[data-testid^="conversation-turn-"],section[data-turn],[data-message-author-role]';

  const URGENT_OBSERVATION_MUTATION_SELECTOR = [
    '[data-testid^="conversation-turn-"]',
    'section[data-turn]',
    '[data-message-author-role]',
    '.streaming-animation',
    '[data-testid^="cot-v5-"]',
    '[role="status"]',
    '[aria-live]',
    '[aria-busy="true"]',
    '[data-testid*="artifact" i]',
    '[data-testid*="error" i]',
  ].join(',');

  function elementForMutationNode(node) {
    if (!node) return null;
    if (node.nodeType === globalThis.Node?.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  function isInsideIgnoredObservationSurface(node) {
    const element = elementForMutationNode(node);
    if (!element) return false;
    try {
      if (element.closest?.(TURN_OBSERVATION_MUTATION_SELECTOR)) return false;
      return Boolean(element.closest?.(IGNORED_OBSERVATION_MUTATION_SELECTOR));
    } catch { return false; }
  }

  function recordTouchesOnlyIgnoredSurface(record = {}) {
    if (isInsideIgnoredObservationSurface(record.target)) return true;
    const changedNodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
    return changedNodes.length > 0 && changedNodes.every(isInsideIgnoredObservationSurface);
  }

  function nodeTouchesUrgentObservationSurface(node) {
    const element = elementForMutationNode(node);
    if (!element) return false;
    try {
      if (element.matches?.(URGENT_OBSERVATION_MUTATION_SELECTOR)) return true;
      if (element.closest?.(URGENT_OBSERVATION_MUTATION_SELECTOR)) return true;
      return Boolean(element.querySelector?.(URGENT_OBSERVATION_MUTATION_SELECTOR));
    } catch {
      return false;
    }
  }

  function createObservationMutationClassifier({ getActiveRequest } = {}) {
    return function classifyObservationMutations(records = []) {
      const source = Array.from(records || []);
      if (source.length && source.every(recordTouchesOnlyIgnoredSurface)) {
        return { ignore: true, reason: 'mutation.composer_ignored' };
      }
      const urgent = source.some((record) => {
        if (nodeTouchesUrgentObservationSurface(record.target)) return true;
        return [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])]
          .some(nodeTouchesUrgentObservationSurface);
      });
      return {
        ignore: false,
        reason: urgent ? 'mutation.turn' : 'mutation.peripheral',
        delayMs: urgent || getActiveRequest?.() ? 60 : 180,
      };
    };
  }

  function createPageStatusRuntime({
    CONFIG,
    TAB_OBSERVATION_CORE,
    TAB_OBSERVER_FACTORY,
    chatPageReadiness,
    diagnostic,
    findChatMain,
    getActiveRequest,
    getCurrentSession,
    isGenerating,
    publicRequestStatus,
    readObservedTurnContext,
    readAssistantSnapshot,
    readLatestAssistantSnapshot,
    send,
  } = {}) {
    let pageStatusTimer = null;
    let pageReadinessTimer = null;
    let lastPageStatusSignature = '';
    let lastPageStatusAt = 0;
    let tabObserver = null;
    let lastTabObservation = null;
    const observationSubscribers = new Set();
    const classifyMutations = createObservationMutationClassifier({ getActiveRequest });

    function pagePresence() {
      const readiness = chatPageReadiness();
      return {
        visibilityState: document.visibilityState || '',
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
        documentReadyState: document.readyState || '',
        chatMainReady: readiness.chatMainReady,
        composerReady: readiness.composerReady,
        pageReady: readiness.ready,
      };
    }

    function sendPageStatus(type = 'page.status') {
      const presence = pagePresence();
      const payload = { type, url: location.href, title: document.title, time: Date.now(), session: getCurrentSession(), activeRequest: getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null, tabObservation: lastTabObservation, ...presence };
      const signature = JSON.stringify([type, payload.url, payload.title, payload.visibilityState, payload.focused, payload.documentReadyState, payload.chatMainReady, payload.composerReady, payload.pageReady, payload.session?.id || '', payload.activeRequest?.requestId || '']);
      const now = Date.now();
      if (signature === lastPageStatusSignature && now - lastPageStatusAt < 500) return;
      lastPageStatusSignature = signature;
      lastPageStatusAt = now;
      send(payload, { immediatePost: true });
    }

    function schedulePageStatus(type = 'page.status', delayMs = 80) {
      if (pageStatusTimer) clearTimeout(pageStatusTimer);
      pageStatusTimer = setTimeout(() => {
        pageStatusTimer = null;
        sendPageStatus(type);
      }, Math.max(0, Number(delayMs) || 0));
    }

    function startPageReadinessMonitor() {
      if (pageReadinessTimer) return pageReadinessTimer;
      const started = Date.now();
      let lastSignature = '';
      let readySamples = 0;
      pageReadinessTimer = setInterval(() => {
        const presence = pagePresence();
        const signature = JSON.stringify([presence.documentReadyState, presence.chatMainReady, presence.composerReady, presence.pageReady, location.href]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          sendPageStatus('page.status');
        }
        readySamples = presence.pageReady ? readySamples + 1 : 0;
        if (readySamples >= 3 || Date.now() - started >= 60_000) stopPageReadinessMonitor();
      }, 250);
      return pageReadinessTimer;
    }

    function stopPageReadinessMonitor() {
      if (pageReadinessTimer) clearInterval(pageReadinessTimer);
      pageReadinessTimer = null;
      if (pageStatusTimer) clearTimeout(pageStatusTimer);
      pageStatusTimer = null;
    }

    function readTabObservation() {
      const request = getActiveRequest();
      const requestStatus = request ? publicRequestStatus(request) : null;
      const snapshot = request?.turnCaptureArmed
        ? readAssistantSnapshot(request)
        : readLatestAssistantSnapshot(1);
      const turnContext = typeof readObservedTurnContext === 'function'
        ? readObservedTurnContext(snapshot)
        : null;
      const presence = pagePresence();
      return TAB_OBSERVATION_CORE.normalizeTabObservation({
        url: location.href,
        title: document.title,
        session: getCurrentSession(),
        presence,
        snapshot,
        turnContext,
        activeRequest: requestStatus,
        generating: Boolean(snapshot?.stopVisible || snapshot?.streamingVisible || snapshot?.hasActiveTool),
      });
    }

    function emitTabObservation(observation) {
      lastTabObservation = observation;
      send({
        type: 'tab.observation',
        revision: observation.revision,
        observedAt: observation.observedAt,
        reason: observation.reason,
        observation,
        url: observation.url,
        title: observation.title,
        session: getCurrentSession(),
        activeRequest: observation.activeRequest,
        visibilityState: observation.visibility,
        focused: observation.focused,
        documentReadyState: observation.document?.readyState || '',
        chatMainReady: Boolean(observation.document?.chatMainReady),
        composerReady: observation.composer?.state === 'ready',
        pageReady: Boolean(observation.document?.pageReady),
      }, { immediatePost: true });
      for (const subscriber of observationSubscribers) {
        try { subscriber(observation); } catch (error) { diagnostic('tab_observer.subscriber_failed', { message: error?.message || String(error) }); }
      }
    }

    function startTabObserver() {
      if (tabObserver) return tabObserver;
      tabObserver = TAB_OBSERVER_FACTORY.createTabObserver({
        MutationObserver,
        pollMs: Math.max(5_000, (Number(CONFIG.domPollMs) || 250) * 20),
        settleMs: 120,
        degradedSettleMs: 600,
        stabilityMilestones: [750, 2_000],
        classifyMutations,
        resolveRoot: () => findChatMain() || document.body || null,
        read: () => readTabObservation(),
        signature: TAB_OBSERVATION_CORE.signatureForObservation,
        emit: emitTabObservation,
        diagnostic: (name, details) => diagnostic(name, details),
      });
      tabObserver.start();
      return tabObserver;
    }

    function stopTabObserver() {
      tabObserver?.stop?.();
      tabObserver = null;
    }

    function scheduleTabObservation(reason = 'tab.changed', delayMs = 0) {
      tabObserver?.schedule(reason, delayMs);
    }

    function getLastTabObservation() {
      return lastTabObservation;
    }

    function subscribeTabObservation(subscriber) {
      if (typeof subscriber !== 'function') throw new TypeError('Tab observation subscriber must be a function');
      observationSubscribers.add(subscriber);
      if (lastTabObservation) subscriber(lastTabObservation);
      return () => observationSubscribers.delete(subscriber);
    }

    return Object.freeze({
      getLastTabObservation,
      pagePresence,
      schedulePageStatus,
      scheduleTabObservation,
      sendPageStatus,
      startPageReadinessMonitor,
      startTabObserver,
      stopPageReadinessMonitor,
      stopTabObserver,
      subscribeTabObservation,
    });
  }

  globalThis.ChatGptPageStatusRuntime = Object.freeze({
    createObservationMutationClassifier,
    createPageStatusRuntime,
  });
})();
