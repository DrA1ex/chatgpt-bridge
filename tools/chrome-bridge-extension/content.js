(() => {
  'use strict';

  if (window.top !== window.self) return;

  const EXTENSION_API = globalThis.ChatGptExtensionApi;
  const RUNTIME_CONFIG = globalThis.ChatGptContentRuntimeConfig;
  if (!EXTENSION_API || !RUNTIME_CONFIG) throw new Error('ChatGPT extension runtime modules were not loaded before content.js');
  const { DEFAULT_CONFIG, readBrowserLaunchMetadataFromUrl, safeLaunchBridgeServerUrl } = RUNTIME_CONFIG;

  const INSTANCE_KEY = '__chatgptBrowserBridgeCompanionInstance';
  const CONTENT_SCRIPT_VERSION = '3.0.0';
  const EXTENSION_PROTOCOL_VERSION = 3;
  const EXTENSION_VERSION = (() => {
    try { return String(chrome.runtime.getManifest()?.version || ''); } catch { return ''; }
  })();
  try {
    if (unsafeWindow && unsafeWindow[INSTANCE_KEY]) return;
    if (unsafeWindow) unsafeWindow[INSTANCE_KEY] = { version: CONTENT_SCRIPT_VERSION, startedAt: Date.now() };
  } catch {}

  const initialBrowserLaunch = readBrowserLaunchMetadataFromUrl();
  const CONFIG = RUNTIME_CONFIG.loadConfig(EXTENSION_API);
  if (initialBrowserLaunch.launchServerUrl) CONFIG.serverUrl = initialBrowserLaunch.launchServerUrl;
  const DOM_PARSER = globalThis.ChatGptDomParserCore;
  if (!DOM_PARSER) throw new Error('ChatGPT DOM parser core was not loaded before content.js');
  const TAB_OBSERVATION_CORE = globalThis.ChatGptTabObservationCore;
  const TAB_OBSERVER_FACTORY = globalThis.ChatGptTabObserver;
  const REQUEST_LIFECYCLE_CORE = globalThis.ChatGptRequestLifecycleCore;
  if (!TAB_OBSERVATION_CORE || !TAB_OBSERVER_FACTORY) throw new Error('ChatGPT tab observer modules were not loaded before content.js');
  if (!REQUEST_LIFECYCLE_CORE) throw new Error('ChatGPT request lifecycle core was not loaded before content.js');
  const DOM_UTILITIES = globalThis.ChatGptDomUtilities;
  if (!DOM_UTILITIES) throw new Error('ChatGPT DOM utility module was not loaded before content.js');
  const { delay, isVisible, normalizeComparable, normalizeText, unique, visibleText } = DOM_UTILITIES;
  const CLIENT_ID_STORAGE_KEY = 'chatgptBridgeTabClientId';
  let fallbackClientId = '';
  let extensionPort = null;
  let browserTabId = null;
  let browserLaunchToken = initialBrowserLaunch.launchToken;
  let browserRequestedUrl = initialBrowserLaunch.requestedUrl;
  let browserLaunchServerUrl = initialBrowserLaunch.launchServerUrl;
  let extensionRequestSeq = 0;
  const extensionRequests = new Map();
  const PAGE_ARTIFACT_CONTENT_SOURCE = 'chatgpt-browser-bridge-artifact-content-v1';
  const PAGE_ARTIFACT_MAIN_SOURCE = 'chatgpt-browser-bridge-artifact-main-v1';
  const pageArtifactCaptures = new Map();
  let pageArtifactCaptureSeq = 0;
  let artifactActionQueue = Promise.resolve();
  const thinkingStateByTurn = new Map();
  const thinkingNodeTokens = new WeakMap();
  let thinkingNodeTokenSequence = 1;
  let reconnectTimer = null;
  let activeRequest = null;
  let connectedServerInstanceId = '';

  function saveConfigPatch(patch) {
    RUNTIME_CONFIG.saveConfigPatch(EXTENSION_API, CONFIG, patch);
  }

  function log(...args) {
    if (CONFIG.debug) console.log('[chatgpt-bridge-extension]', ...args);
  }

  function getClientId() {
    let id = '';
    try { id = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY) || ''; } catch {}
    if (!id) {
      id = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try { sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id); } catch { fallbackClientId = id; }
    }
    return id || fallbackClientId;
  }

  function authCheckUrl(serverUrl = CONFIG.serverUrl, token = CONFIG.token) {
    const url = new URL('/extension/auth/check', String(serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''));
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('runtime', 'extension');
    return url.toString();
  }

  const PANEL_RUNTIME_FACTORY = globalThis.ChatGptPanelRuntime;
  if (!PANEL_RUNTIME_FACTORY) throw new Error('ChatGPT panel runtime module was not loaded before content.js');
  const {
    applyCompatibilityStatus,
    compareVersionStrings,
    getBridgeVersion,
    recordLocalLog,
    safeJsonParse,
    safeUrlPath,
    setBridgeVersion,
    setPanelStatus,
    summarizePayload,
    syncFloatingPanelVisibility,
    updatePanel,
  } = PANEL_RUNTIME_FACTORY.createPanelRuntime({
    CONFIG,
    CONTENT_SCRIPT_VERSION,
    DEFAULT_CONFIG,
    EXTENSION_VERSION,
    authCheckUrl: (...args) => authCheckUrl(...args),
    connect: (...args) => connect(...args),
    disconnectTransport: (...args) => disconnectTransport(...args),
    extensionHttpJson: (...args) => extensionHttpJson(...args),
    getActiveRequest: () => activeRequest,
    getClientId,
    getCurrentSession: (...args) => getCurrentSession(...args),
    publicRequestStatus: (...args) => publicRequestStatus(...args),
    saveConfigPatch,
  });

  function send(payload) {
    if (!extensionPort) {
      recordLocalLog('out.drop', { type: payload?.type || 'unknown', reason: 'extension_port_not_ready' });
      return false;
    }
    try {
      extensionPort.postMessage({ type: 'bridge.payload', payload });
      recordLocalLog('out.extension', summarizePayload(payload));
      return true;
    } catch (err) {
      recordLocalLog('out.extension_failed', { error: err.message || String(err), payload: summarizePayload(payload) });
      return false;
    }
  }

  async function sendCritical(payload) {
    return send(payload);
  }

  function diagnostic(name, details = {}) {
    send({
      type: 'diagnostic',
      name,
      requestId: details.requestId,
      url: location.href,
      title: document.title,
      time: Date.now(),
      ...details,
    });
  }

  const PAGE_STATUS_RUNTIME_FACTORY = globalThis.ChatGptPageStatusRuntime;
  if (!PAGE_STATUS_RUNTIME_FACTORY) throw new Error('ChatGPT page status runtime module was not loaded before content.js');
  const {
    getLastTabObservation,
    pagePresence,
    schedulePageStatus,
    scheduleTabObservation,
    sendPageStatus,
    startPageReadinessMonitor,
    startTabObserver,
  } = PAGE_STATUS_RUNTIME_FACTORY.createPageStatusRuntime({
    CONFIG,
    TAB_OBSERVATION_CORE,
    TAB_OBSERVER_FACTORY,
    chatPageReadiness: (...args) => chatPageReadiness(...args),
    diagnostic,
    findChatMain: (...args) => findChatMain(...args),
    getActiveRequest: () => activeRequest,
    getCurrentSession: (...args) => getCurrentSession(...args),
    isGenerating: (...args) => isGenerating(...args),
    publicRequestStatus: (...args) => publicRequestStatus(...args),
    readAssistantSnapshot: (...args) => readAssistantSnapshot(...args),
    readLatestAssistantSnapshot: (...args) => readLatestAssistantSnapshot(...args),
    send,
  });

  const REQUEST_TELEMETRY_FACTORY = globalThis.ChatGptRequestTelemetry;
  if (!REQUEST_TELEMETRY_FACTORY) throw new Error('ChatGPT request telemetry module was not loaded before content.js');
  const {
    emitChatEvent,
    emitRequestProgress,
    markRequestProgress,
    runObservedRequestEffect,
    setRequestPhase,
  } = REQUEST_TELEMETRY_FACTORY.createRequestTelemetry({
    diagnostic,
    findStopButton: (...args) => findStopButton(...args),
    getAssistantNodes: (...args) => getAssistantNodes(...args),
    getCurrentSession: (...args) => getCurrentSession(...args),
    getTurnNodes: (...args) => getTurnNodes(...args),
    pagePresence,
    send,
  });

  function helloPayload() {
    return {
      type: 'hello',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      clientVersion: CONTENT_SCRIPT_VERSION,
      clientId: getClientId(),
      browserTabId,
      launchToken: browserLaunchToken,
      requestedUrl: browserRequestedUrl,
      launchServerUrl: browserLaunchServerUrl,
      url: location.href,
      title: document.title,
      session: getCurrentSession(),
      ...pagePresence(),
      capabilities: {
        dom: true,
        network: CONFIG.networkStreamEnabled,
        promptInput: true,
        passivePromptSubmission: true,
        cancel: true,
        markdown: true,
        diagnostics: true,
        sessions: true,
        sessionDeletion: true,
        browserTabs: true,
        promptSteering: true,
        fileUpload: true,
        artifacts: true,
        artifactDownload: true,
        modelSelection: true,
        effortSelection: true,
        chunkedArtifactDownload: true,
        requestRecoveryStatus: true,
        extensionTransport: hasExtensionRuntime(),
        extensionDownloads: hasExtensionRuntime(),
      },
      activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null,
      tabObservation: getLastTabObservation(),
    };
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!CONFIG.token) {
      setPanelStatus('not configured', 'Paste BRIDGE_TOKEN from /setup');
      return;
    }
    connectExtensionTransport();
  }

  function hasExtensionRuntime() {
    try { return Boolean(globalThis.chrome?.runtime?.id && typeof chrome.runtime.connect === 'function'); } catch { return false; }
  }

  function connectExtensionTransport() {
    if (!hasExtensionRuntime()) {
      setPanelStatus('extension unavailable', 'Install/load the ChatGPT Bridge extension');
      return;
    }
    try {
      extensionPort = chrome.runtime.connect({ name: 'chatgpt-bridge-tab' });
    } catch (err) {
      extensionPort = null;
      setPanelStatus('extension error', err.message || String(err));
      scheduleReconnect();
      return;
    }

    extensionPort.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'extension.response') {
        const pending = extensionRequests.get(message.requestId);
        if (pending) {
          extensionRequests.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result || {});
        }
        return;
      }
      if (message.type === 'extension.connected') {
        browserTabId = Number.isInteger(message.browserTabId) ? message.browserTabId : null;
        browserLaunchToken = String(message.launchToken || browserLaunchToken || '');
        browserRequestedUrl = String(message.requestedUrl || browserRequestedUrl || '');
        browserLaunchServerUrl = safeLaunchBridgeServerUrl(message.serverUrl || browserLaunchServerUrl || '');
        if (browserLaunchServerUrl) CONFIG.serverUrl = browserLaunchServerUrl;
        setPanelStatus('connected', 'Extension WebSocket connected');
        send(helloPayload());
        return;
      }
      if (message.type === 'extension.status') {
        if (message.compatibility) applyCompatibilityStatus(message.compatibility, message.status || 'extension status');
        else setPanelStatus(message.status || 'extension status', message.detail || '');
        return;
      }
      if (message.type === 'extension.auth_error') {
        setPanelStatus('auth failed', message.detail || 'Invalid BRIDGE_TOKEN. Paste the token from /setup and click Save & Connect.');
        recordLocalLog('extension.auth_error', { status: message.httpStatus || 0, message: message.detail || '' });
        return;
      }
      if (message.type === 'extension.error') {
        setPanelStatus('extension error', message.message || 'Unknown extension error');
        recordLocalLog('extension.error', { message: message.message || '' });
        return;
      }
      if (message.type === 'server.message') {
        handleServerMessage(message.payload);
      }
    });

    extensionPort.onDisconnect.addListener(() => {
      extensionPort = null;
      for (const [requestId, pending] of extensionRequests.entries()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Extension background disconnected'));
        extensionRequests.delete(requestId);
      }
      setPanelStatus('extension disconnected', chrome.runtime.lastError?.message || 'Background service worker disconnected');
      scheduleReconnect();
    });

    extensionPort.postMessage({
      type: 'bridge.connect',
      serverUrl: CONFIG.serverUrl,
      token: CONFIG.token,
      clientId: getClientId(),
      page: helloPayload(),
    });
  }

  function extensionRequest(type, payload = {}, timeoutMs = 30_000) {
    if (!extensionPort) return Promise.reject(new Error('Extension port is not connected'));
    const requestId = `ext-${Date.now().toString(36)}-${(extensionRequestSeq += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        extensionRequests.delete(requestId);
        reject(new Error(`Timed out waiting for extension response: ${type}`));
      }, Math.max(1_000, Number(timeoutMs) || 30_000));
      extensionRequests.set(requestId, { resolve, reject, timer });
      try {
        extensionPort.postMessage({ type, requestId, ...payload });
      } catch (err) {
        clearTimeout(timer);
        extensionRequests.delete(requestId);
        reject(err);
      }
    });
  }


  function nextPageArtifactCaptureId() {
    pageArtifactCaptureSeq += 1;
    return `page-artifact-${Date.now().toString(36)}-${pageArtifactCaptureSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function postPageArtifactMessage(type, payload = {}) {
    window.postMessage({ source: PAGE_ARTIFACT_CONTENT_SOURCE, type, ...payload }, '*');
  }

  function settlePageArtifactCapture(captureId, method, value) {
    const state = pageArtifactCaptures.get(captureId);
    if (!state || state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    pageArtifactCaptures.delete(captureId);
    state[method](value);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== PAGE_ARTIFACT_MAIN_SOURCE) return;
    const captureId = String(message.captureId || '');
    const state = pageArtifactCaptures.get(captureId);
    if (!state) return;

    if (message.type === 'artifact.capture.armed') {
      state.armed = true;
      state.armedResolve?.(true);
      return;
    }

    if (message.type === 'artifact.capture.candidate') {
      settlePageArtifactCapture(captureId, 'resolve', {
        kind: String(message.kind || 'url'),
        url: String(message.url || ''),
        downloadName: String(message.downloadName || ''),
        mime: String(message.mime || ''),
        size: Number(message.size || 0),
        blob: message.blob instanceof Blob ? message.blob : null,
        observedAt: Number(message.observedAt || Date.now()),
      });
    }
  });

  async function armPageArtifactCapture(artifact = {}, timeoutMs = 45_000) {
    const captureId = nextPageArtifactCaptureId();
    let armedResolve;
    let armedReject;
    const armedPromise = new Promise((resolve, reject) => {
      armedResolve = resolve;
      armedReject = reject;
    });
    const candidatePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pageArtifactCaptures.delete(captureId);
        reject(new Error(`Timed out waiting for page-generated artifact: ${artifact.name || artifact.id || captureId}`));
      }, Math.max(1_000, Number(timeoutMs) || 45_000));
      pageArtifactCaptures.set(captureId, { resolve, reject, timer, armedResolve, armedReject, armed: false, settled: false });
    });
    postPageArtifactMessage('artifact.capture.arm', {
      captureId,
      expectedName: artifact.name || '',
      expectedNames: [artifact.name || artifact.fileName || ''].filter(Boolean),
      timeoutMs,
    });
    const ackTimer = setTimeout(() => armedReject(new Error('Page artifact capture bridge did not acknowledge arm request')), 1_500);
    try {
      await armedPromise;
    } catch (err) {
      const state = pageArtifactCaptures.get(captureId);
      if (state && !state.settled) {
        state.settled = true;
        clearTimeout(state.timer);
        pageArtifactCaptures.delete(captureId);
        state.reject(err);
        candidatePromise.catch(() => {});
      }
      throw err;
    } finally {
      clearTimeout(ackTimer);
    }
    return {
      captureId,
      wait: candidatePromise,
      addExpectedNames(expectedNames = []) {
        postPageArtifactMessage('artifact.capture.expect', {
          captureId,
          expectedNames: Array.from(expectedNames || []).filter(Boolean),
        });
      },
      cancel(reason = 'cancelled') {
        const state = pageArtifactCaptures.get(captureId);
        if (state && !state.settled) {
          state.settled = true;
          clearTimeout(state.timer);
          pageArtifactCaptures.delete(captureId);
          state.reject(new Error(`Page artifact capture ${reason}`));
        }
        postPageArtifactMessage('artifact.capture.cancel', { captureId });
      },
    };
  }

  function enqueueArtifactAction(task) {
    const run = artifactActionQueue.then(task, task);
    artifactActionQueue = run.catch(() => {});
    return run;
  }

  function extensionHttpJson({ method = 'GET', url, data = undefined, timeout = 30_000, signal = null }) {
    recordLocalLog('http.request', { method, path: safeUrlPath(url), hasBody: data !== undefined, timeout });
    return new Promise((resolve, reject) => {
      if (typeof EXTENSION_API.httpRequest !== 'function') {
        reject(new Error('Extension HTTP transport is not available'));
        return;
      }
      if (signal?.aborted) {
        const abortErr = new Error(`Request aborted: ${url}`);
        abortErr.name = 'AbortError';
        reject(abortErr);
        return;
      }

      let settled = false;
      let request = null;
      const cleanup = () => {
        if (signal && abortHandler) {
          try { signal.removeEventListener('abort', abortHandler); } catch {}
        }
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const abortHandler = () => {
        try { request?.abort?.(); } catch {}
        const err = new Error(`Request aborted: ${url}`);
        err.name = 'AbortError';
        recordLocalLog('http.aborted', { method, path: safeUrlPath(url), reason: signal?.reason || '' });
        finish(reject, err);
      };
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });

      request = EXTENSION_API.httpRequest({
        method,
        url,
        data: data === undefined ? undefined : JSON.stringify(data),
        headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
        responseType: 'json',
        timeout,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            recordLocalLog('http.error', { method, path: safeUrlPath(url), status: response.status });
            finish(reject, new Error(`HTTP ${response.status}: ${typeof response.responseText === 'string' ? response.responseText.slice(0, 200) : ''}`));
            return;
          }
          recordLocalLog('http.response', { method, path: safeUrlPath(url), status: response.status });
          finish(resolve, response.response && typeof response.response === 'object' ? response.response : safeJsonParse(response.responseText) || {});
        },
        onerror() { recordLocalLog('http.failed', { method, path: safeUrlPath(url) }); finish(reject, new Error(`Request failed: ${url}`)); },
        ontimeout() { recordLocalLog('http.timeout', { method, path: safeUrlPath(url), timeout }); finish(reject, new Error(`Request timed out: ${url}`)); },
        onabort() { abortHandler(); },
      });
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(connect, CONFIG.reconnectMs);
  }

  function disconnectTransport() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { extensionPort?.disconnect?.(); } catch {}
    extensionPort = null;
  }

  const COMPOSER_COMMANDS_FACTORY = globalThis.ChatGptComposerCommands;
  const ATTACHMENT_COMMANDS_FACTORY = globalThis.ChatGptAttachmentCommands;
  if (!COMPOSER_COMMANDS_FACTORY || !ATTACHMENT_COMMANDS_FACTORY) {
    throw new Error('ChatGPT composer command modules were not loaded before content.js');
  }
  const {
    enterPrompt,
    findComposer,
    buttonSignalText,
    findChatMain,
    findTurnByKey,
    findComposerRootStrict,
    finalizationControlRoots,
    findStopButton,
    findSendButton,
    findContinueButton,
    readFinalizationSignals,
    shouldDeferFinalizationForSteer,
    clickStopButton,
    isUsableButton,
  } = COMPOSER_COMMANDS_FACTORY.createComposerCommands({
    CONFIG,
    conversationIdFromUrl: (...args) => conversationIdFromUrl(...args),
    delay,
    diagnostic,
    emitChatEvent,
    emitRequestProgress,
    getActiveRequest: () => activeRequest,
    getTurnNodes: (...args) => getTurnNodes(...args),
    isGenerating,
    isVisible,
    normalizeComparable,
    setRequestPhase,
    turnKey: (...args) => turnKey(...args),
    turnRole: (...args) => turnRole(...args),
    visibleText,
    waitForChatPageReady: (...args) => waitForChatPageReady(...args),
  });
  const { attachFiles, handleComposerAttachmentsClear } = ATTACHMENT_COMMANDS_FACTORY.createAttachmentCommands({
    CONFIG,
    EXTENSION_API,
    delay,
    diagnostic,
    emitChatEvent,
    findComposerRoot: () => {
      const composer = findComposer();
      return composer?.closest('form')
        || composer?.closest('[data-testid*="composer" i]')
        || composer?.parentElement?.parentElement?.parentElement
        || document.body;
    },
    findSendButton,
    isUsableButton,
    isVisible,
    send,
    visibleText,
  });

  const RESPONSE_DOM_FACTORY = globalThis.ChatGptResponseDom;
  const ARTIFACT_DOM_FACTORY = globalThis.ChatGptArtifactDom;
  const TURN_SNAPSHOTS_FACTORY = globalThis.ChatGptTurnSnapshots;
  if (!RESPONSE_DOM_FACTORY || !ARTIFACT_DOM_FACTORY || !TURN_SNAPSHOTS_FACTORY) {
    throw new Error('ChatGPT response DOM modules were not loaded before content.js');
  }
  const {
    actionSelectorHint,
    guessNameFromUrl,
    guessMime,
    simpleHash,
    safeOuterHtml,
    codeUiActionText,
    domPathForNode,
    createResponseParserPass,
    extractResponseBlocks,
    parserAuditForRoot,
    mergeParserAudits,
    normalizeMarkdown,
  } = RESPONSE_DOM_FACTORY.createResponseDom({ DOM_PARSER, isVisible, normalizeText, visibleText });
  const {
    collectArtifactsForAssistantNode,
    queryAllWithSelf,
    isBrowserOnlyArtifactUrl,
    isExcludedArtifactAction,
    artifactLocatorMeta,
    artifactFileName,
    collectArtifactsFromNode,
  } = ARTIFACT_DOM_FACTORY.createArtifactDom({
    DOM_PARSER,
    actionSelectorHint,
    guessMime,
    guessNameFromUrl,
    isVisible,
    normalizeText,
    simpleHash,
    visibleText,
  });
  const {
    getTurnNodes,
    getFinalAssistantNode,
    turnKey,
    turnRole,
    getAssistantNodes,
    getAssistantNodeFromTurn,
    waitForSubmittedUserTurnAnchor,
    refreshRequestTurnAnchors,
    readLatestAssistantSnapshot,
    readAssistantSnapshotByTurnKey,
    readRecentAssistantSnapshots,
    readAssistantSnapshot,
    responseActionBarVisible,
    readAssistantNodeSnapshot,
  } = TURN_SNAPSHOTS_FACTORY.createTurnSnapshots({
    DOM_PARSER,
    buttonSignalText,
    collectArtifactsForAssistantNode,
    delay,
    diagnostic,
    emitChatEvent,
    extractResponseBlocks,
    finalizationControlRoots,
    findContinueButton,
    findSendButton,
    findStopButton,
    getActiveRequest: () => activeRequest,
    isVisible,
    mergeParserAudits,
    nextThinkingNodeToken: () => `node-${thinkingNodeTokenSequence++}`,
    normalizeText,
    parserAuditForRoot,
    safeOuterHtml,
    simpleHash,
    thinkingNodeTokens,
    thinkingStateByTurn,
    visibleText,
  });

  const REQUEST_MONITOR_FACTORY = globalThis.ChatGptRequestMonitor;
  if (!REQUEST_MONITOR_FACTORY) throw new Error('ChatGPT request monitor module was not loaded before content.js');
  const {
    attachDomObserver,
    collectAndEmit,
    emitTerminalSnapshot,
    releaseRequest,
    reportTerminalFailure,
    scheduleCollect,
    startDomMonitor,
  } = REQUEST_MONITOR_FACTORY.createRequestMonitor({
    CONFIG,
    DOM_PARSER,
    REQUEST_LIFECYCLE_CORE,
    conversationIdFromUrl: (...args) => conversationIdFromUrl(...args),
    diagnostic,
    emitChatEvent,
    emitRequestProgress,
    findChatMain,
    findTurnByKey,
    getActiveRequest: () => activeRequest,
    getAssistantNodes,
    getCurrentSession: (...args) => getCurrentSession(...args),
    getTurnNodes,
    isGenerating,
    markRequestProgress,
    readAssistantSnapshot,
    readFinalizationSignals,
    refreshRequestTurnAnchors,
    schedulePageStatus,
    scheduleTabObservation,
    send,
    setActiveRequest: (request) => { activeRequest = request; },
    setRequestPhase,
    shouldDeferFinalizationForSteer,
  });

  function isGenerating() { return Boolean(findStopButton()); }


  const SESSION_COMMANDS_FACTORY = globalThis.ChatGptSessionCommands;
  if (!SESSION_COMMANDS_FACTORY) throw new Error('ChatGPT session command module was not loaded before content.js');
  const {
    getCurrentSession,
    conversationIdFromUrl,
    collectSessions,
    handleSessionsList,
    handleSessionsNew,
    handleSessionsSelect,
    handleSessionsDelete,
    handleBrowserTabOpen,
    handleBrowserTabClose,
    handleBrowserTabReload,
    handleExtensionReload,
    openNewSession,
    selectSessionById,
  } = SESSION_COMMANDS_FACTORY.createSessionCommands({
    CONFIG,
    CONTENT_SCRIPT_VERSION,
    DOM_PARSER,
    EXTENSION_VERSION,
    chatPageReadiness: (...args) => chatPageReadiness(...args),
    delay,
    diagnostic,
    extensionRequest,
    isVisible,
    safeLaunchBridgeServerUrl,
    schedulePageStatus,
    send,
    visibleText,
    waitForDocumentReady: (...args) => waitForDocumentReady(...args),
  });

  const INTELLIGENCE_COMMANDS_FACTORY = globalThis.ChatGptIntelligenceCommands;
  if (!INTELLIGENCE_COMMANDS_FACTORY) throw new Error('ChatGPT intelligence command module was not loaded before content.js');
  const {
    INTELLIGENCE_UI_TIMING,
    readIntelligenceState,
    trySelectIntelligenceOption,
    handleModelsList,
    handleEffortsList,
  } = INTELLIGENCE_COMMANDS_FACTORY.createIntelligenceCommands({
    DOM_PARSER,
    buttonSignalText,
    delay,
    diagnostic,
    findComposer,
    findComposerRootStrict,
    isUsableButton,
    isVisible,
    normalizeComparable,
    normalizeText,
    send,
    unique,
    visibleText,
  });

  const REQUEST_PREPARATION_FACTORY = globalThis.ChatGptRequestPreparation;
  if (!REQUEST_PREPARATION_FACTORY) throw new Error('ChatGPT request preparation module was not loaded before content.js');
  const {
    applyModelOptions,
    applySessionOptions,
    chatPageReadiness,
    waitForChatPageReady,
    waitForDocumentReady,
  } = REQUEST_PREPARATION_FACTORY.createRequestPreparation({
    CONFIG,
    DOM_PARSER,
    INTELLIGENCE_UI_TIMING,
    delay,
    diagnostic,
    emitChatEvent,
    findChatMain,
    findComposer,
    isVisible,
    openNewSession,
    readIntelligenceState,
    schedulePageStatus,
    selectSessionById,
    send,
    trySelectIntelligenceOption,
  });

  const RESPONSE_RECOVERY_FACTORY = globalThis.ChatGptResponseRecovery;
  if (!RESPONSE_RECOVERY_FACTORY) throw new Error('ChatGPT response recovery module was not loaded before content.js');
  const {
    handleResponseRecoverLatest,
    handleResponseRecoverList,
    handleResponseRecoverTurnKey,
    handleResponseSnapshotRequest,
  } = RESPONSE_RECOVERY_FACTORY.createResponseRecovery({
    DOM_PARSER,
    diagnostic,
    findStopButton,
    getActiveRequest: () => activeRequest,
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
    snapshotTerminalForRequest,
  });

  const ARTIFACT_PREVIEW_FACTORY = globalThis.ChatGptArtifactPreview;
  const ARTIFACT_TRANSFER_FACTORY = globalThis.ChatGptArtifactTransfer;
  if (!ARTIFACT_PREVIEW_FACTORY || !ARTIFACT_TRANSFER_FACTORY) {
    throw new Error('ChatGPT artifact interaction modules were not loaded before content.js');
  }
  const {
    closeArtifactPreview,
    closeVisibleArtifactPreviewsBeforeAction,
    materializeArtifactPreview,
    visibleArtifactPreviewContainers,
    waitForLateArtifactPreview,
  } = ARTIFACT_PREVIEW_FACTORY.createArtifactPreview({
    CONFIG,
    DOM_PARSER,
    arrayBufferToBase64: (...args) => arrayBufferToBase64(...args),
    artifactSourceRoot: (...args) => artifactSourceRoot(...args),
    collectArtifactsFromNode,
    delay,
    diagnostic,
    isUsableButton,
    isVisible,
    normalizeComparable,
    normalizeText,
    unique,
  });
  const {
    arrayBufferToBase64,
    artifactSourceRoot,
    handleArtifactFetch,
  } = ARTIFACT_TRANSFER_FACTORY.createArtifactTransfer({
    CONFIG,
    DOM_PARSER,
    EXTENSION_API,
    armPageArtifactCapture,
    artifactFileName,
    artifactLocatorMeta,
    closeArtifactPreview,
    closeVisibleArtifactPreviewsBeforeAction,
    collectArtifactsFromNode,
    delay,
    diagnostic,
    enqueueArtifactAction,
    extensionRequest,
    findTurnByKey,
    getExtensionPort: () => extensionPort,
    guessMime,
    guessNameFromUrl,
    isBrowserOnlyArtifactUrl,
    isExcludedArtifactAction,
    isUsableButton,
    isVisible,
    materializeArtifactPreview,
    normalizeComparable,
    queryAllWithSelf,
    send,
    visibleArtifactPreviewContainers,
    waitForLateArtifactPreview,
  });

  const PAGE_RUNTIME_OBSERVERS_FACTORY = globalThis.ChatGptPageRuntimeObservers;
  if (!PAGE_RUNTIME_OBSERVERS_FACTORY) throw new Error('ChatGPT page runtime observer module was not loaded before content.js');
  const {
    baselinePassiveTurns,
    schedulePassiveTurnScan,
    start: startPageRuntimeObservers,
  } = PAGE_RUNTIME_OBSERVERS_FACTORY.createPageRuntimeObservers({
    CONFIG,
    DOM_PARSER,
    attachDomObserver,
    collectAndEmit,
    connect,
    diagnostic,
    findChatMain,
    findStopButton,
    getActiveRequest: () => activeRequest,
    getAssistantNodeFromTurn,
    getClientId,
    getCurrentSession,
    getFinalAssistantNode,
    getTurnNodes,
    readAssistantNodeSnapshot,
    responseActionBarVisible,
    scheduleCollect,
    schedulePageStatus,
    scheduleTabObservation,
    send,
    startPageReadinessMonitor,
    startTabObserver,
    syncFloatingPanelVisibility,
    turnKey,
  });
  const REQUEST_COMMANDS_FACTORY = globalThis.ChatGptRequestCommands;
  if (!REQUEST_COMMANDS_FACTORY) throw new Error('ChatGPT request command module was not loaded before content.js');
  const {
    handlePassivePromptSubmit,
    handlePromptCancel,
    handlePromptSend,
    handlePromptSteer,
    handleRequestRelease,
    handleRequestResume,
    publicRequestStatus,
    snapshotTerminalForRequest,
  } = REQUEST_COMMANDS_FACTORY.createRequestCommands({
    DOM_PARSER,
    REQUEST_LIFECYCLE_CORE,
    applyModelOptions,
    applySessionOptions,
    attachFiles,
    baselinePassiveTurns,
    clickStopButton,
    collectAndEmit,
    conversationIdFromUrl,
    diagnostic,
    emitChatEvent,
    enterPrompt,
    findStopButton,
    getActiveRequest: () => activeRequest,
    getAssistantNodes,
    getConnectedServerInstanceId: () => connectedServerInstanceId,
    getCurrentSession,
    getTurnNodes,
    isGenerating,
    markRequestProgress,
    refreshRequestTurnAnchors,
    releaseRequest,
    reportTerminalFailure,
    runObservedRequestEffect,
    schedulePageStatus,
    schedulePassiveTurnScan,
    scheduleTabObservation,
    send,
    setActiveRequest: (request) => { activeRequest = request; },
    setRequestPhase,
    simpleHash,
    startDomMonitor,
    turnKey,
    waitForChatPageReady,
    waitForDocumentReady,
    waitForSubmittedUserTurnAnchor,
  });

  const SERVER_COMMAND_ROUTER_FACTORY = globalThis.ChatGptServerCommandRouter;
  if (!SERVER_COMMAND_ROUTER_FACTORY) throw new Error('ChatGPT server command router module was not loaded before content.js');
  const { handleServerMessage } = SERVER_COMMAND_ROUTER_FACTORY.createServerCommandRouter({
    CONTENT_SCRIPT_VERSION,
    EXTENSION_VERSION,
    applyCompatibilityStatus,
    compareVersionStrings,
    getActiveRequest: () => activeRequest,
    getBridgeVersion,
    getCurrentSession,
    handleArtifactFetch,
    handleBrowserTabClose,
    handleBrowserTabOpen,
    handleBrowserTabReload,
    handleComposerAttachmentsClear,
    handleEffortsList,
    handleExtensionReload,
    handleModelsList,
    handlePassivePromptSubmit,
    handlePromptCancel,
    handlePromptSend,
    handlePromptSteer,
    handleRequestRelease,
    handleRequestResume,
    handleResponseRecoverLatest,
    handleResponseRecoverList,
    handleResponseRecoverTurnKey,
    handleResponseSnapshotRequest,
    handleSessionsDelete,
    handleSessionsList,
    handleSessionsNew,
    handleSessionsSelect,
    pagePresence,
    publicRequestStatus,
    schedulePageStatus,
    send,
    setBridgeVersion,
    setConnectedServerInstanceId: (value) => { connectedServerInstanceId = value; },
    updatePanel,
  });

  startPageRuntimeObservers();
})();
