(() => {
  'use strict';

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
    let lastPageStatusSignature = '';
    let lastPageStatusAt = 0;
    let tabObserver = null;
    let lastTabObservation = null;
    const observationSubscribers = new Set();

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
    const started = Date.now();
    let lastSignature = '';
    let readySamples = 0;
    const timer = setInterval(() => {
      const presence = pagePresence();
      const signature = JSON.stringify([presence.documentReadyState, presence.chatMainReady, presence.composerReady, presence.pageReady, location.href]);
      if (signature !== lastSignature) {
        lastSignature = signature;
        sendPageStatus('page.status');
      }
      readySamples = presence.pageReady ? readySamples + 1 : 0;
      if (readySamples >= 3 || Date.now() - started >= 60_000) clearInterval(timer);
    }, 250);
    return timer;
  }


  function readTabObservation() {
    const requestStatus = getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null;
    const snapshot = getActiveRequest()?.turnCaptureArmed
      ? readAssistantSnapshot(getActiveRequest())
      : readLatestAssistantSnapshot(1);
    const turnContext = typeof readObservedTurnContext === 'function'
      ? readObservedTurnContext(snapshot)
      : null;
    return TAB_OBSERVATION_CORE.normalizeTabObservation({
      url: location.href,
      title: document.title,
      session: getCurrentSession(),
      presence: pagePresence(),
      snapshot,
      turnContext,
      activeRequest: requestStatus,
      generating: Boolean(snapshot?.stopVisible || isGenerating()),
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
      ...pagePresence(),
    }, { immediatePost: true });
    for (const subscriber of observationSubscribers) {
      try { subscriber(observation); } catch (error) { diagnostic('tab_observer.subscriber_failed', { message: error?.message || String(error) }); }
    }
  }

  function startTabObserver() {
    if (tabObserver) return tabObserver;
    tabObserver = TAB_OBSERVER_FACTORY.createTabObserver({
      MutationObserver,
      pollMs: Math.max(1_000, (Number(CONFIG.domPollMs) || 250) * 4),
      settleMs: 80,
      degradedSettleMs: 600,
      resolveRoot: () => findChatMain() || document.body || null,
      read: () => readTabObservation(),
      signature: TAB_OBSERVATION_CORE.signatureForObservation,
      emit: emitTabObservation,
      diagnostic: (name, details) => diagnostic(name, details),
    });
    tabObserver.start();
    return tabObserver;
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
      subscribeTabObservation,
    });
  }

  globalThis.ChatGptPageStatusRuntime = Object.freeze({ createPageStatusRuntime });
})();
