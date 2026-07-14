// Chrome extension content-script compatibility layer for the browser companion.
(() => {
  const prefix = 'chatgptBridge:';
  globalThis.GM_getValue = function GM_getValue(key, fallback) {
    try {
      const raw = localStorage.getItem(prefix + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  };
  globalThis.GM_setValue = function GM_setValue(key, value) {
    try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch {}
  };
  globalThis.GM_xmlhttpRequest = function GM_xmlhttpRequest(details = {}) {
    const requestId = `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let aborted = false;
    let timer = null;
    const finish = (callback, arg) => {
      if (aborted) return;
      if (timer) clearTimeout(timer);
      try { callback?.(arg); } catch (err) { console.error('[chatgpt-bridge-extension] callback failed', err); }
    };
    if (details.timeout) {
      timer = setTimeout(() => {
        aborted = true;
        try { details.ontimeout?.(); } catch {}
      }, Number(details.timeout) || 0);
    }
    chrome.runtime.sendMessage({
      type: 'bridge.http',
      requestId,
      request: {
        method: details.method || 'GET',
        url: details.url,
        headers: details.headers || {},
        data: details.data,
        responseType: details.responseType || 'text',
      },
    }, (response) => {
      if (aborted) return;
      if (chrome.runtime.lastError) {
        finish(details.onerror, { error: chrome.runtime.lastError.message });
        return;
      }
      if (!response || response.error) {
        finish(details.onerror, { error: response?.error || 'Extension HTTP request failed' });
        return;
      }
      const result = response.result || {};
      let body = result.data;
      if (result.responseType === 'arraybuffer' && Array.isArray(body)) body = new Uint8Array(body).buffer;
      const responseText = typeof body === 'string'
        ? body
        : body == null
          ? ''
          : JSON.stringify(body);
      const event = {
        status: result.status || 0,
        response: body,
        responseText,
        responseHeaders: result.contentType ? `content-type: ${result.contentType}` : '',
      };
      finish(details.onload, event);
    });
    return {
      abort() {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { details.onabort?.(); } catch {}
      }
    };
  };
})();

// ==UserScript==
// @name         ChatGPT Browser Bridge Companion
// @namespace    local.chatgpt-browser-bridge
// @version      2.14.1
// @description  Sends prompts/files to ChatGPT, streams chat events, extracts sessions and artifacts through a local Node.js bridge extension.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @noframes
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self) return;

  const INSTANCE_KEY = '__chatgptBrowserBridgeCompanionInstance';
  const CONTENT_SCRIPT_VERSION = '2.14.1';
  const EXTENSION_PROTOCOL_VERSION = 2;
  const EXTENSION_VERSION = (() => {
    try { return String(chrome.runtime.getManifest()?.version || ''); } catch { return ''; }
  })();
  try {
    if (unsafeWindow && unsafeWindow[INSTANCE_KEY]) return;
    if (unsafeWindow) unsafeWindow[INSTANCE_KEY] = { version: CONTENT_SCRIPT_VERSION, startedAt: Date.now() };
  } catch {}

  const CONFIG_VERSION = 8;
  const URL_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch';
  const URL_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server';
  const BRIDGE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
  const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);

  const DEFAULT_CONFIG = {
    serverUrl: 'http://127.0.0.1:8080',
    token: '',
    transport: 'extension',
    reconnectMs: 1500,
    pollTimeoutMs: 25_000,
    pollActiveTimeoutMs: 300,
    pollIdleDelayMs: 0,
    domPollMs: 250,
    defaultAnswerSettleMs: 1500,
    defaultAnswerDoneSettleMs: 600,
    steerContinuationSettleMs: 90_000,
    postStopTerminalSettleMs: 900,
    requiredArtifactSettleMs: 30_000,
    attachmentUploadTimeoutMs: 90_000,
    pageReadyTimeoutMs: 45_000,
    pageReadySettleMs: 1_000,
    promptSubmitAckTimeoutMs: 4_000,
    promptSubmitRetries: 3,
    promptSubmitRetryDelayMs: 700,
    generationStartTimeoutMs: 30_000,
    firstOutputTimeoutMs: 75_000,
    maxRequestTimeoutMs: 0,
    artifactChunkSize: 256 * 1024,
    artifactDownloadTimeoutMs: 45_000,
    networkStreamEnabled: false,
    debug: false,
  };

  function safeLaunchBridgeServerUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' || !LOOPBACK_BRIDGE_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) return '';
      if (parsed.pathname && parsed.pathname !== '/') return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  function readBrowserLaunchMetadataFromUrl() {
    try {
      const url = new URL(location.href);
      const params = new URLSearchParams(url.hash.replace(/^#/, ''));
      const launchToken = String(params.get(URL_LAUNCH_HASH_KEY) || '');
      if (!BRIDGE_LAUNCH_TOKEN_RE.test(launchToken)) return { launchToken: '', launchServerUrl: '', requestedUrl: '' };
      const launchServerUrl = safeLaunchBridgeServerUrl(params.get(URL_LAUNCH_SERVER_HASH_KEY));
      params.delete(URL_LAUNCH_HASH_KEY);
      params.delete(URL_LAUNCH_SERVER_HASH_KEY);
      url.hash = params.toString();
      const requestedUrl = url.toString();
      try { history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch {}
      return { launchToken, launchServerUrl, requestedUrl };
    } catch {
      return { launchToken: '', launchServerUrl: '', requestedUrl: '' };
    }
  }

  const initialBrowserLaunch = readBrowserLaunchMetadataFromUrl();
  const CONFIG = loadConfig();
  if (initialBrowserLaunch.launchServerUrl) CONFIG.serverUrl = initialBrowserLaunch.launchServerUrl;
  const DOM_PARSER = globalThis.ChatGptDomParserCore;
  if (!DOM_PARSER) throw new Error('ChatGPT DOM parser core was not loaded before content.js');
  const HOOK_SOURCE = 'chatgpt-browser-bridge-network-hook';
  const HOOK_NONCE = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const CLIENT_ID_STORAGE_KEY = 'chatgptBridgeTabClientId';
  let fallbackClientId = '';
  let ws = null;
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
  let pollAbort = false;
  let pollingStarted = false;
  let activeRequest = null;
  let connectedServerInstanceId = '';
  let networkHookInjected = false;
  let panelState = { status: 'starting', lastError: '', connectedAt: 0, busy: '', compatibility: null, bridgeVersion: '' };
  const localLogs = [];
  let pollingOutbox = [];
  let pollingFlushInFlight = false;
  let pollingFlushTimer = null;
  let pollingExchangeController = null;
  let pollingExchangeInFlight = false;
  let pageStatusTimer = null;
  let lastPageStatusSignature = '';
  let lastPageStatusAt = 0;
  const REQUEST_PROGRESS_MIN_INTERVAL_MS = 1500;

  function gmGet(key, fallback) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : localStorage.getItem(key) || fallback; } catch { return fallback; }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      else localStorage.setItem(key, value);
    } catch {}
  }

  function numberFromConfig(key, fallback, min, max) {
    const raw = gmGet(key, fallback);
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function loadConfig() {
    migrateConfigIfNeeded();
    const defaultTransport = hasExtensionRuntime() ? 'extension' : DEFAULT_CONFIG.transport;
    const transport = hasExtensionRuntime() ? 'extension' : String(gmGet('bridge.transport', defaultTransport) || defaultTransport);
    return {
      ...DEFAULT_CONFIG,
      serverUrl: String(gmGet('bridge.serverUrl', DEFAULT_CONFIG.serverUrl) || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''),
      token: String(gmGet('bridge.token', DEFAULT_CONFIG.token) || DEFAULT_CONFIG.token),
      transport,
      debug: Boolean(gmGet('bridge.debug', DEFAULT_CONFIG.debug)),
      pollTimeoutMs: numberFromConfig('bridge.pollTimeoutMs', DEFAULT_CONFIG.pollTimeoutMs, 250, 30_000),
      pollActiveTimeoutMs: numberFromConfig('bridge.pollActiveTimeoutMs', DEFAULT_CONFIG.pollActiveTimeoutMs, 100, 2_000),
      pollIdleDelayMs: numberFromConfig('bridge.pollIdleDelayMs', DEFAULT_CONFIG.pollIdleDelayMs, 0, 2_000),
    };
  }

  function migrateConfigIfNeeded() {
    const storedVersion = Number(gmGet('bridge.configVersion', 0)) || 0;
    if (storedVersion >= CONFIG_VERSION) return;

    // v5 switches polling to a single exchange channel. Old short-poll values from
    // v4 can keep the companion hot-looping and still do not fix event batching.
    // Force the new defaults once; user edits after this migration are preserved.
    gmSet('bridge.pollTimeoutMs', DEFAULT_CONFIG.pollTimeoutMs);
    gmSet('bridge.pollActiveTimeoutMs', DEFAULT_CONFIG.pollActiveTimeoutMs);
    gmSet('bridge.pollIdleDelayMs', DEFAULT_CONFIG.pollIdleDelayMs);

    // v7 makes the extension runtime primary. In extension content scripts,
    // prefer the extension background WebSocket automatically; userscript fallback
    // has no chrome.runtime.connect and remains on polling.
    if (hasExtensionRuntime()) gmSet('bridge.transport', 'extension');

    gmSet('bridge.configVersion', CONFIG_VERSION);
  }

  function saveConfigPatch(patch) {
    Object.assign(CONFIG, patch);
    if (patch.serverUrl != null) gmSet('bridge.serverUrl', String(patch.serverUrl).replace(/\/$/, ''));
    if (patch.token != null) gmSet('bridge.token', String(patch.token));
    if (patch.transport != null) gmSet('bridge.transport', String(patch.transport));
    if (patch.debug != null) gmSet('bridge.debug', Boolean(patch.debug));
    if (patch.pollTimeoutMs != null) gmSet('bridge.pollTimeoutMs', numberFromConfigValue(patch.pollTimeoutMs, DEFAULT_CONFIG.pollTimeoutMs, 250, 30_000));
    if (patch.pollActiveTimeoutMs != null) gmSet('bridge.pollActiveTimeoutMs', numberFromConfigValue(patch.pollActiveTimeoutMs, DEFAULT_CONFIG.pollActiveTimeoutMs, 100, 2_000));
    if (patch.pollIdleDelayMs != null) gmSet('bridge.pollIdleDelayMs', numberFromConfigValue(patch.pollIdleDelayMs, DEFAULT_CONFIG.pollIdleDelayMs, 0, 2_000));
  }

  function numberFromConfigValue(raw, fallback, min, max) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function log(...args) {
    if (CONFIG.debug) console.log('[chatgpt-bridge-extension]', ...args);
  }

  function getClientId() {
    let id = '';
    try { id = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY) || ''; } catch {}
    if (!id) {
      id = `tm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try { sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id); } catch { fallbackClientId = id; }
    }
    return id || fallbackClientId;
  }

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

  function wsUrl() {
    const base = CONFIG.serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const url = new URL('/tm/ws', base);
    if (CONFIG.token) url.searchParams.set('token', CONFIG.token);
    return url.toString();
  }

  function httpUrl(path) {
    const url = new URL(path, CONFIG.serverUrl);
    if (CONFIG.token) url.searchParams.set('token', CONFIG.token);
    return url.toString();
  }

  function authCheckUrl(serverUrl = CONFIG.serverUrl, token = CONFIG.token) {
    const url = new URL('/tm/auth/check', String(serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''));
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('runtime', 'extension');
    return url.toString();
  }

  function send(payload, options = {}) {
    if (CONFIG.transport === 'extension' && extensionPort) {
      try {
        extensionPort.postMessage({ type: 'bridge.payload', payload });
        recordLocalLog('out.extension', summarizePayload(payload));
        return true;
      } catch (err) {
        recordLocalLog('out.extension_failed', { error: err.message || String(err), payload: summarizePayload(payload) });
      }
    }
    if (CONFIG.transport === 'websocket' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      recordLocalLog('out.ws', summarizePayload(payload));
      return true;
    }
    if (CONFIG.transport === 'polling') {
      if (options.immediatePost) {
        void sendPollingImmediate(payload, options);
        return true;
      }
      enqueuePollingPayload(payload, options);
      return true;
    }
    recordLocalLog('out.drop', { type: payload?.type || 'unknown', reason: 'transport_not_ready' });
    return false;
  }

  async function sendPollingImmediate(payload, options = {}) {
    // Polling mode is intentionally single-channel now. A second /tm/events POST can
    // be delayed behind the currently open /tm/poll in Tampermonkey; instead, push
    // the event into the next /tm/exchange request and wake the exchange loop.
    enqueuePollingPayload(payload, { priority: Boolean(options.priority), immediate: true });
    return true;
  }

  async function sendCritical(payload) {
    if (CONFIG.transport === 'websocket') return send(payload, { priority: true });
    if (CONFIG.transport !== 'polling') return false;
    enqueuePollingPayload(payload, { priority: true, immediate: true });
    return true;
  }

  function enqueuePollingPayload(payload, options = {}) {
    if (!CONFIG.token) return false;
    if (options.priority) pollingOutbox.unshift(payload);
    else pollingOutbox.push(payload);
    while (pollingOutbox.length > 1000) pollingOutbox.shift();
    wakePollingExchange(options.immediate !== false ? 'event.queued' : 'event.queued_deferred');
    return true;
  }

  function schedulePollingFlush(delayMs = 0) {
    // Legacy helper kept for older callers. Polling events are delivered by the
    // /tm/exchange loop, not by a separate /tm/events batch sender.
    if (pollingFlushTimer) clearTimeout(pollingFlushTimer);
    pollingFlushTimer = setTimeout(() => {
      pollingFlushTimer = null;
      wakePollingExchange('legacy.flush');
    }, Math.max(0, Number(delayMs) || 0));
  }

  async function flushPollingOutbox() {
    // No-op by design. A separate event POST can be blocked by a long poll in
    // userscript environments; the exchange loop owns polling-mode delivery.
    wakePollingExchange('legacy.flush_now');
  }

  function wakePollingExchange(reason = 'wake') {
    if (CONFIG.transport !== 'polling') return;
    if (!pollingExchangeController) return;
    try {
      pollingExchangeController.abort(reason);
      recordLocalLog('poll.exchange.wake', { reason });
    } catch {}
  }

  function drainPollingOutbox(limit = 50) {
    if (!pollingOutbox.length) return [];
    return pollingOutbox.splice(0, Math.max(1, Number(limit) || 50));
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

  function emitChatEvent(request, type, details = {}) {
    if (!request) return;
    send({
      type: 'chat.event',
      requestId: request.requestId,
      event: {
        type,
        requestId: request.requestId,
        time: new Date().toISOString(),
        url: location.href,
        title: document.title,
        ...details,
      },
    });
  }

  function markRequestProgress(request, reason = 'progress') {
    if (!request) return;
    request.lastMeaningfulProgressAt = Date.now();
    request.lastMeaningfulProgressReason = reason || 'progress';
  }

  function setRequestPhase(request, phase, details = {}) {
    if (!request || !phase || request.phase === phase) return false;
    const previousPhase = request.phase || '';
    request.phase = phase;
    markRequestProgress(request, `phase:${phase}`);
    diagnostic('request.phase', { requestId: request.requestId, phase, previousPhase, ...details });
    emitChatEvent(request, 'request.phase', { phase, previousPhase, ...details });
    emitRequestProgress(request, null, details.generating, `phase:${phase}`, { force: true, ...details });
    return true;
  }

  function anchorConfidenceForRequest(request, snapshot = null) {
    if (!request?.submittedUserTurnKey) return { confidence: 'none', reason: 'no_submitted_user_turn' };
    if (snapshot?.turnKey) return { confidence: 'high', reason: snapshot.reason || 'assistant_after_submitted_user' };
    return { confidence: 'medium', reason: snapshot?.reason || 'submitted_user_turn_only' };
  }

  function emitRequestProgress(request, snapshot = null, generating = undefined, reason = 'progress', options = {}) {
    if (!request || (request.finished && !options.allowFinished)) return;
    const now = Date.now();
    if (!options.force && request.lastProgressSentAt && now - request.lastProgressSentAt < REQUEST_PROGRESS_MIN_INTERVAL_MS) return;
    const presence = pagePresence();
    const safeSnapshot = snapshot || {};
    const anchor = anchorConfidenceForRequest(request, safeSnapshot);
    const stopButtonVisible = typeof generating === 'boolean' ? generating : Boolean(findStopButton());
    const answerLength = String(safeSnapshot.answer || request.lastAnswer || '').length;
    const thinkingLength = String(safeSnapshot.thinking || request.lastThinking || '').length;
    const artifactCount = Array.isArray(safeSnapshot.artifacts) ? safeSnapshot.artifacts.length : request.artifacts.length;
    const progressText = String(safeSnapshot.progress || request.lastProgressText || '');
    const stableForMs = request.stableSince ? now - request.stableSince : 0;
    const generationIdleForMs = request.generationIdleSince ? now - request.generationIdleSince : 0;
    const payload = {
      type: 'request.progress',
      requestId: request.requestId,
      phase: request.phase || 'created',
      reason,
      meaningful: options.meaningful !== false,
      url: location.href,
      title: document.title,
      session: getCurrentSession(),
      ...presence,
      submittedUserTurnKey: request.submittedUserTurnKey || '',
      submittedUserTurnIndex: request.submittedUserTurnIndex ?? -1,
      assistantTurnKey: safeSnapshot.turnKey || request.assistantTurnKey || '',
      assistantTurnIndex: safeSnapshot.turnIndex ?? request.assistantTurnIndex ?? -1,
      anchorConfidence: options.anchorConfidence || anchor.confidence,
      anchorReason: options.anchorReason || anchor.reason,
      turnCount: safeSnapshot.turnCount ?? getTurnNodes().length,
      assistantNodeCount: safeSnapshot.count ?? getAssistantNodes().length,
      stopButtonVisible,
      sawGenerating: Boolean(request.sawGenerating),
      sawAnswer: Boolean(request.sawAnswer),
      answerLength,
      thinkingLength,
      artifactCount,
      progressLength: progressText.length,
      progressText: progressText.slice(0, 240),
      networkDone: Boolean(request.networkDone),
      sendButtonVisible: Boolean(options.sendButtonVisible),
      regenerateButtonVisible: Boolean(options.regenerateButtonVisible),
      continueButtonVisible: Boolean(options.continueButtonVisible),
      steerControlVisible: Boolean(options.steerControlVisible),
      finalizationConfidence: options.finalizationConfidence || '',
      stableForMs,
      generationIdleForMs,
      lastMeaningfulProgressAt: request.lastMeaningfulProgressAt || 0,
      lastMeaningfulProgressReason: request.lastMeaningfulProgressReason || '',
      snapshotReason: safeSnapshot.reason || '',
      domPhase: safeSnapshot.phase || '',
      messageId: safeSnapshot.messageId || '',
      modelSlug: safeSnapshot.modelSlug || '',
      actionBarVisible: Boolean(safeSnapshot.actionBarVisible),
      hasFinalMessage: Boolean(safeSnapshot.hasFinalMessage),
      hasActiveTool: Boolean(safeSnapshot.hasActiveTool),
      needsConfirmation: Boolean(safeSnapshot.needsConfirmation),
      needsContinue: Boolean(safeSnapshot.needsContinue),
      domSchemaUnknownTestIds: safeSnapshot.unknownTestIds || [],
    };
    request.lastProgressSentAt = now;
    request.lastProgressSignature = JSON.stringify([payload.phase, payload.domPhase, payload.answerLength, payload.thinkingLength, payload.artifactCount, payload.progressLength, payload.submittedUserTurnKey, payload.assistantTurnKey, payload.messageId, payload.stopButtonVisible, payload.actionBarVisible, payload.visibilityState]);
    send(payload);
  }

  function sendPageStatus(type = 'page.status') {
    const presence = pagePresence();
    const payload = { type, url: location.href, title: document.title, time: Date.now(), session: getCurrentSession(), activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null, ...presence };
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
        pollingTransport: false,
        websocketTransport: false,
        extensionTransport: hasExtensionRuntime(),
        extensionDownloads: hasExtensionRuntime(),
      },
      activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null,
    };
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!CONFIG.token) {
      setPanelStatus('not configured', 'Paste BRIDGE_TOKEN from /setup');
      return;
    }
    CONFIG.transport = 'extension';
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

  function connectWebSocket() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      setPanelStatus('websocket error', err.message || String(err));
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      log('connected via websocket');
      setPanelStatus('connected', 'WebSocket connected');
      send(helloPayload());
    });

    ws.addEventListener('message', (event) => {
      const payload = safeJsonParse(event.data);
      if (!payload || typeof payload !== 'object') return;
      handleServerMessage(payload);
    });

    ws.addEventListener('close', () => {
      log('websocket disconnected');
      ws = null;
      setPanelStatus('disconnected', 'WebSocket closed');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      setPanelStatus('websocket error', 'WebSocket failed; use polling if CSP blocks ws://127.0.0.1');
    });
  }

  function startPollingTransport() {
    if (pollingStarted) return;
    pollingStarted = true;
    pollAbort = false;
    void pollingLoop();
  }

  async function pollingLoop() {
    while (!pollAbort && CONFIG.transport === 'polling') {
      try {
        await postHello();
        setPanelStatus('connected', 'HTTP polling connected');
        break;
      } catch (err) {
        setPanelStatus('server offline/auth failed', err.message || String(err));
        await delay(CONFIG.reconnectMs);
      }
    }

    while (!pollAbort && CONFIG.transport === 'polling') {
      const active = Boolean(activeRequest);
      const timeoutMs = active
        ? (Number(CONFIG.pollActiveTimeoutMs) || DEFAULT_CONFIG.pollActiveTimeoutMs)
        : (Number(CONFIG.pollTimeoutMs) || DEFAULT_CONFIG.pollTimeoutMs);
      const payloads = drainPollingOutbox(active ? 100 : 50);
      const controller = new AbortController();
      pollingExchangeController = controller;
      pollingExchangeInFlight = true;
      try {
        const response = await postPollingExchange(payloads, { timeoutMs, signal: controller.signal });
        pollingExchangeController = null;
        pollingExchangeInFlight = false;
        if (payloads.length) recordLocalLog('poll.exchange.sent', { count: payloads.length, types: payloads.map((item) => item?.type || 'unknown').slice(0, 8) });
        const commands = Array.isArray(response.commands) ? response.commands : [];
        if (commands.length && !(commands.length === 1 && commands[0]?.type === 'noop')) recordLocalLog('poll.commands', { count: commands.length, types: commands.map((cmd) => cmd?.type || 'unknown') });
        for (const command of commands) handleServerMessage(command);
        if (!commands.length || (commands.length === 1 && commands[0]?.type === 'noop')) {
          const idleDelayMs = Number(CONFIG.pollIdleDelayMs) || 0;
          if (idleDelayMs > 0) await delay(idleDelayMs);
        }
      } catch (err) {
        pollingExchangeController = null;
        pollingExchangeInFlight = false;
        if (err?.name === 'AbortError' || /aborted/i.test(err?.message || '')) {
          if (payloads.length) pollingOutbox = payloads.concat(pollingOutbox).slice(0, 1000);
          await delay(0);
          continue;
        }
        if (payloads.length) pollingOutbox = payloads.concat(pollingOutbox).slice(0, 1000);
        setPanelStatus('polling error', err.message || String(err));
        await delay(CONFIG.reconnectMs);
      }
    }
  }

  async function postHello() {
    return await gmRequestJson({ method: 'POST', url: httpUrl('/tm/hello'), data: helloPayload(), timeout: 10_000 });
  }

  async function postPollingExchange(payloads = [], { timeoutMs = DEFAULT_CONFIG.pollTimeoutMs, signal = null } = {}) {
    const safeTimeoutMs = Math.max(0, Math.round(Number(timeoutMs) || 0));
    return await gmRequestJson({
      method: 'POST',
      url: httpUrl('/tm/exchange'),
      data: {
        clientId: getClientId(),
        hello: helloPayload(),
        payloads: Array.isArray(payloads) ? payloads : [],
        timeoutMs: safeTimeoutMs,
      },
      timeout: Math.max(2_000, safeTimeoutMs + 2_000),
      signal,
    });
  }

  async function postPollingPayloads(payloads, { timeout = 20_000 } = {}) {
    if (!CONFIG.token) return false;
    const cleanPayloads = (Array.isArray(payloads) ? payloads : [payloads]).filter(Boolean);
    if (!cleanPayloads.length) return true;
    await gmRequestJson({
      method: 'POST',
      url: httpUrl('/tm/events'),
      data: { clientId: getClientId(), payloads: cleanPayloads },
      timeout,
    });
    return true;
  }

  function gmRequestJson({ method = 'GET', url, data = undefined, timeout = 30_000, signal = null }) {
    recordLocalLog('http.request', { method, path: safeUrlPath(url), hasBody: data !== undefined, timeout });
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest is not available'));
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

      request = GM_xmlhttpRequest({
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

  function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function safeUrlPath(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}`;
    } catch { return String(rawUrl || '').slice(0, 120); }
  }


  function recordLocalLog(type, details = {}) {
    const entry = { time: new Date().toISOString(), type, details };
    localLogs.push(entry);
    while (localLogs.length > 200) localLogs.shift();
    updatePanel();
  }

  function summarizePayload(payload = {}) {
    return {
      type: payload.type || 'unknown',
      requestId: payload.requestId,
      commandId: payload.commandId,
      eventType: payload.event?.type,
      textLength: typeof payload.text === 'string' ? payload.text.length : undefined,
      answerLength: typeof payload.answer === 'string' ? payload.answer.length : undefined,
    };
  }

  function setPanelBusy(label) {
    panelState.busy = label || '';
    updatePanel();
  }

  function setButtonBusy(button, busy, label = '') {
    if (!button) return;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = Boolean(busy);
    button.classList.toggle('cgb-loading', Boolean(busy));
    button.textContent = busy ? `${label || button.dataset.originalText}…` : button.dataset.originalText;
  }

  function setPanelStatus(status, lastError = '') {
    const changed = panelState.status !== status || panelState.lastError !== lastError;
    panelState.status = status;
    panelState.lastError = lastError;
    if (isPanelOkStatus(status)) panelState.connectedAt = Date.now();
    if (changed) {
      localLogs.push({ time: new Date().toISOString(), type: 'status', details: { status, lastError } });
      while (localLogs.length > 200) localLogs.shift();
    }
    updatePanel();
  }

  function isPanelOkStatus(status) {
    const text = String(status || '').toLowerCase();
    if (!text) return false;
    if (/(auth|invalid|error|failed|fail|disconnected|not connected|reconnecting|unreachable|offline|not configured|queueing)/i.test(text)) return false;
    return /(connected|reachable|accepted)/i.test(text);
  }

  function isChatConversationUrl(value = location.href) {
    let url;
    try { url = new URL(String(value || location.href), location.origin); } catch { return false; }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') return true;
    if (/^\/c\/[^/]+$/i.test(path)) return true;
    if (/^\/g\/[^/]+(?:\/c\/[^/]+)?$/i.test(path)) return true;
    return false;
  }

  function panelStatusView() {
    const status = String(panelState.status || '').toLowerCase();
    const compatibility = panelState.compatibility;
    if (compatibility?.compatible === false || /update required|outdated|incompatible/i.test(status)) {
      return {
        tone: 'danger',
        eyebrow: 'Update required',
        title: compatibility?.status === 'bridge_outdated' ? 'Update the local bridge' : 'Reload the browser extension',
        detail: compatibility?.message || panelState.lastError || 'The installed extension is not compatible with this bridge version.',
      };
    }
    if (!CONFIG.token) {
      return {
        tone: 'setup',
        eyebrow: 'One-time setup',
        title: 'Connect this ChatGPT tab',
        detail: 'Open the local setup page, copy the Bridge token, then paste it below.',
      };
    }
    if (panelState.busy) {
      return { tone: 'working', eyebrow: 'Working', title: panelState.busy, detail: 'Checking the local bridge connection…' };
    }
    if (isPanelOkStatus(panelState.status)) {
      return {
        tone: 'ok',
        eyebrow: 'Ready',
        title: activeRequest ? 'Bridge is connected and working' : 'Bridge is connected',
        detail: activeRequest ? `Current request: ${activeRequest.phase || activeRequest.requestId}` : 'This chat tab can receive prompts from the local bridge.',
      };
    }
    return {
      tone: 'danger',
      eyebrow: 'Needs attention',
      title: panelState.status || 'Not connected',
      detail: panelState.lastError || 'Check that the local bridge is running, then reconnect.',
    };
  }

  function syncFloatingPanelVisibility() {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!isChatConversationUrl()) {
      root?.remove();
      return;
    }
    if (!root) initFloatingPanel();
    else {
      root.hidden = false;
      updatePanel();
    }
  }

  function setFloatingPanelOpen(open) {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!root) return;
    const expanded = Boolean(open);
    root.classList.toggle('cgb-open', expanded);
    root.querySelector('#cgb-tab')?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function initFloatingPanel() {
    if (!isChatConversationUrl()) return;
    if (document.getElementById('chatgpt-bridge-panel-root')) {
      updatePanel();
      return;
    }
    const root = document.createElement('div');
    root.id = 'chatgpt-bridge-panel-root';
    root.innerHTML = `
      <style>
        #chatgpt-bridge-panel-root{position:fixed;right:0;bottom:88px;z-index:2147483647;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;color-scheme:light dark;pointer-events:none}
        #cgb-launcher{pointer-events:auto;width:132px;transform:translateX(calc(100% - 38px));transition:transform .22s cubic-bezier(.2,.8,.2,1);will-change:transform}
        #cgb-launcher:hover,#cgb-launcher:focus-within,#chatgpt-bridge-panel-root.cgb-open #cgb-launcher{transform:translateX(0)}
        #cgb-tab{appearance:none;display:flex;align-items:center;gap:9px;width:132px;min-height:42px;padding:7px 12px 7px 7px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(24,24,27,.94);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.24);backdrop-filter:blur(14px);cursor:pointer;transition:box-shadow .18s ease,background .18s ease;user-select:none;overflow:hidden}
        #cgb-tab:hover{box-shadow:0 14px 34px rgba(0,0,0,.3);background:#111113}
        #cgb-tab:focus-visible{outline:3px solid rgba(59,130,246,.38);outline-offset:2px}
        #cgb-mark{position:relative;display:grid;place-items:center;flex:0 0 auto;width:26px;height:26px;border-radius:9px;background:linear-gradient(145deg,#4f46e5,#2563eb);font-weight:800;font-size:12px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
        #cgb-label{white-space:nowrap;font-weight:650;opacity:0;transform:translateX(7px);visibility:hidden;transition:opacity .14s ease,transform .2s cubic-bezier(.2,.8,.2,1),visibility 0s linear .2s}
        #cgb-launcher:hover #cgb-label,#cgb-launcher:focus-within #cgb-label,#chatgpt-bridge-panel-root.cgb-open #cgb-label{opacity:1;transform:translateX(0);visibility:visible;transition-delay:.045s,.045s,0s}
        #cgb-dot{position:absolute;right:-2px;bottom:-2px;width:9px;height:9px;border:2px solid #18181b;border-radius:50%;background:#a1a1aa;box-shadow:0 0 0 2px rgba(161,161,170,.12)}
        #cgb-tab.cgb-ok #cgb-dot{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.16)}
        #cgb-tab.cgb-bad #cgb-dot{background:#fb7185;box-shadow:0 0 0 3px rgba(251,113,133,.17)}
        #cgb-tab.cgb-unconfigured #cgb-dot,#cgb-tab.cgb-busy #cgb-dot{background:#fbbf24;animation:cgb-pulse 1.25s ease infinite}
        @keyframes cgb-pulse{0%,100%{opacity:1}50%{opacity:.38}}
        #cgb-panel{pointer-events:auto;display:none;position:absolute;right:14px;bottom:54px;width:min(390px,calc(100vw - 28px));box-sizing:border-box;background:#fff;color:#18181b;border:1px solid rgba(0,0,0,.1);border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden}
        #chatgpt-bridge-panel-root.cgb-open #cgb-panel{display:block}
        #cgb-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 18px 12px}
        #cgb-header h3{margin:0;font-size:17px;letter-spacing:-.01em}#cgb-header p{margin:3px 0 0;color:#71717a;font-size:12px}
        #cgb-close{appearance:none;border:0;background:transparent;color:#71717a;width:30px;height:30px;border-radius:9px;font-size:20px;line-height:1;cursor:pointer}#cgb-close:hover{background:#f4f4f5;color:#18181b}
        #cgb-state{margin:0 18px 14px;padding:13px 14px;border-radius:14px;border:1px solid #e4e4e7;background:#fafafa}
        #cgb-state[data-tone="ok"]{border-color:#bbf7d0;background:#f0fdf4}#cgb-state[data-tone="danger"]{border-color:#fecdd3;background:#fff1f2}#cgb-state[data-tone="working"],#cgb-state[data-tone="setup"]{border-color:#fde68a;background:#fffbeb}
        #cgb-state-eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:750;color:#71717a}#cgb-state-title{font-size:14px;font-weight:700;margin-top:2px}#cgb-state-detail{font-size:12px;color:#52525b;margin-top:3px;white-space:pre-wrap}
        #cgb-form{padding:0 18px 18px}#cgb-form label{display:flex;justify-content:space-between;gap:8px;margin:12px 0 5px;color:#52525b;font-size:12px;font-weight:650}
        .cgb-field{display:flex;align-items:center;gap:6px}.cgb-field input{box-sizing:border-box;min-width:0;flex:1;padding:10px 11px;border:1px solid #d4d4d8;border-radius:11px;background:#fff;color:#18181b;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}.cgb-field input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12)}
        .cgb-icon-button{appearance:none;border:1px solid #d4d4d8;background:#fff;color:#52525b;border-radius:10px;padding:9px;cursor:pointer}.cgb-icon-button:hover{background:#f4f4f5}
        #cgb-actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px}.cgb-button{appearance:none;border:1px solid #d4d4d8;border-radius:11px;padding:10px 13px;background:#fff;color:#27272a;font-weight:650;cursor:pointer}.cgb-button:hover{background:#f4f4f5}.cgb-button-primary{border-color:#2563eb;background:#2563eb;color:#fff}.cgb-button-primary:hover{background:#1d4ed8}.cgb-button:disabled{opacity:.6;cursor:wait}.cgb-loading::before{content:'⟳ ';display:inline-block;animation:cgb-spin .9s linear infinite}@keyframes cgb-spin{to{transform:rotate(360deg)}}
        #cgb-help{margin:10px 0 0;color:#71717a;font-size:11px}
        #cgb-advanced{border-top:1px solid #e4e4e7;padding:12px 18px 16px;background:#fafafa}#cgb-advanced summary{cursor:pointer;color:#52525b;font-weight:650;font-size:12px;user-select:none}#cgb-advanced-grid{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}#cgb-advanced-grid .cgb-button{font-size:11px;padding:7px 9px}
        #cgb-debug-state,#cgb-log{white-space:pre-wrap;overflow:auto;max-height:150px;margin:10px 0 0;padding:9px;border-radius:10px;background:#18181b;color:#e4e4e7;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
        #cgb-footer{display:flex;justify-content:space-between;gap:10px;margin-top:10px;color:#a1a1aa;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}
        @media(prefers-reduced-motion:reduce){#cgb-launcher,#cgb-label{transition:none}}
        @media(prefers-color-scheme:dark){#cgb-panel{background:#18181b;color:#f4f4f5;border-color:#3f3f46}#cgb-header p,#cgb-state-detail,#cgb-form label,#cgb-help,#cgb-advanced summary{color:#a1a1aa}#cgb-close:hover,.cgb-icon-button:hover,.cgb-button:hover{background:#27272a;color:#f4f4f5}#cgb-state{background:#202024;border-color:#3f3f46}#cgb-state[data-tone="ok"]{background:#10251a;border-color:#166534}#cgb-state[data-tone="danger"]{background:#30151b;border-color:#9f1239}#cgb-state[data-tone="working"],#cgb-state[data-tone="setup"]{background:#2b2411;border-color:#854d0e}.cgb-field input,.cgb-icon-button,.cgb-button{background:#202024;color:#f4f4f5;border-color:#3f3f46}#cgb-advanced{background:#151518;border-color:#3f3f46}}
      </style>
      <div id="cgb-launcher"><button id="cgb-tab" type="button" aria-label="Open ChatGPT Bridge settings" aria-expanded="false"><span id="cgb-mark">B<span id="cgb-dot" aria-hidden="true"></span></span><span id="cgb-label">Bridge</span></button></div>
      <section id="cgb-panel" aria-label="ChatGPT Bridge setup">
        <div id="cgb-header"><div><h3>ChatGPT Bridge</h3><p>Connect this chat to your local bridge.</p></div><button id="cgb-close" type="button" title="Close" aria-label="Close">×</button></div>
        <div id="cgb-state" data-tone="setup"><div id="cgb-state-eyebrow">Starting</div><div id="cgb-state-title">Checking connection</div><div id="cgb-state-detail">Connecting to the local bridge…</div></div>
        <div id="cgb-form">
          <label for="cgb-server"><span>Local bridge URL</span><span>Step 1</span></label>
          <div class="cgb-field"><input id="cgb-server" value="${escapeHtml(CONFIG.serverUrl)}" autocomplete="url" spellcheck="false"></div>
          <label for="cgb-token"><span>Bridge token</span><span>Step 2</span></label>
          <div class="cgb-field"><input id="cgb-token" type="password" value="${escapeHtml(CONFIG.token)}" placeholder="Copy from the local /setup page" autocomplete="off" spellcheck="false"><button id="cgb-token-toggle" class="cgb-icon-button" type="button" aria-label="Show token" title="Show token">Show</button></div>
          <input id="cgb-transport" type="hidden" value="extension">
          <div id="cgb-actions"><button id="cgb-save" class="cgb-button cgb-button-primary" type="button">Save & connect</button><button id="cgb-setup" class="cgb-button" type="button">Open setup guide</button></div>
          <p id="cgb-help">The Bridge token is local and separate from the API token. It is stored in this ChatGPT origin for this browser profile.</p>
        </div>
        <details id="cgb-advanced"><summary>Advanced & diagnostics</summary><div id="cgb-advanced-grid"><button id="cgb-test" class="cgb-button" type="button">Test connection</button><button id="cgb-diag" class="cgb-button" type="button">Open diagnostics</button><button id="cgb-copy" class="cgb-button" type="button">Copy diagnostics</button></div><pre id="cgb-debug-state"></pre><pre id="cgb-log"></pre><div id="cgb-footer"><span id="cgb-versions"></span><span id="cgb-page-session"></span></div></details>
      </section>`;
    (document.documentElement || document.body).appendChild(root);
    root.querySelector('#cgb-transport').value = CONFIG.transport;
    const tabButton = root.querySelector('#cgb-tab');
    tabButton.addEventListener('click', () => setFloatingPanelOpen(!root.classList.contains('cgb-open')));
    root.querySelector('#cgb-close').addEventListener('click', () => setFloatingPanelOpen(false));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('cgb-open')) {
        setFloatingPanelOpen(false);
        tabButton.focus();
      }
    });
    root.querySelector('#cgb-token-toggle').addEventListener('click', (event) => {
      const input = root.querySelector('#cgb-token');
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
      event.currentTarget.setAttribute('aria-label', reveal ? 'Hide token' : 'Show token');
    });
    root.querySelector('#cgb-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setButtonBusy(button, true, 'Connecting');
      setPanelBusy('Connecting');
      try {
        saveConfigPatch({
          serverUrl: root.querySelector('#cgb-server').value.trim() || DEFAULT_CONFIG.serverUrl,
          token: root.querySelector('#cgb-token').value.trim(),
          transport: root.querySelector('#cgb-transport').value,
        });
        panelState.compatibility = null;
        disconnectTransport();
        connect();
        recordLocalLog('ui.save_connect', { transport: CONFIG.transport, serverUrl: CONFIG.serverUrl, hasToken: Boolean(CONFIG.token) });
      } finally {
        setTimeout(() => { setButtonBusy(button, false); setPanelBusy(''); }, 650);
        updatePanel();
      }
    });
    root.querySelector('#cgb-test').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setButtonBusy(button, true, 'Testing');
      setPanelBusy('Testing connection');
      try {
        const serverUrl = root.querySelector('#cgb-server').value.trim() || DEFAULT_CONFIG.serverUrl;
        const token = root.querySelector('#cgb-token').value.trim();
        const result = await gmRequestJson({ method: 'GET', url: new URL('/setup/status', serverUrl).toString(), timeout: 5000 });
        const auth = await gmRequestJson({ method: 'GET', url: authCheckUrl(serverUrl, token), timeout: 5000 });
        setPanelStatus('token accepted', `${result.clients?.length || 0} tab(s) connected. Bridge token accepted: ${Boolean(auth.bridgeTokenAccepted)}.`);
        recordLocalLog('ui.test.ok', { clients: result.clients?.length || 0, bridgeTokenAccepted: Boolean(auth.bridgeTokenAccepted) });
      } catch (err) {
        setPanelStatus('connection test failed', err.message || String(err));
        recordLocalLog('ui.test.failed', { error: err.message || String(err) });
      } finally { setButtonBusy(button, false); setPanelBusy(''); }
    });
    root.querySelector('#cgb-setup').addEventListener('click', () => window.open(new URL('/setup', root.querySelector('#cgb-server').value.trim() || CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-diag').addEventListener('click', () => window.open(new URL('/diagnostics', CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-copy').addEventListener('click', async () => {
      const text = JSON.stringify({
        versions: { extension: EXTENSION_VERSION, content: CONTENT_SCRIPT_VERSION, bridge: panelState.bridgeVersion || '' },
        compatibility: panelState.compatibility,
        config: { serverUrl: CONFIG.serverUrl, transport: CONFIG.transport, hasToken: Boolean(CONFIG.token) },
        status: panelState,
        url: location.href,
        clientId: getClientId(),
        activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null,
      }, null, 2);
      try { await navigator.clipboard.writeText(text); } catch {}
    });
    setTimeout(() => { if (!CONFIG.token || panelState.compatibility?.compatible === false) setFloatingPanelOpen(true); }, 450);
    updatePanel();
  }

  function updatePanel() {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!root) return;
    if (!isChatConversationUrl()) {
      root.remove();
      return;
    }
    const tab = root.querySelector('#cgb-tab');
    const statusCard = root.querySelector('#cgb-state');
    const view = panelStatusView();
    if (tab) {
      tab.classList.remove('cgb-ok', 'cgb-bad', 'cgb-unconfigured', 'cgb-busy');
      if (panelState.busy) tab.classList.add('cgb-busy');
      else if (!CONFIG.token) tab.classList.add('cgb-unconfigured');
      else if (view.tone === 'ok') tab.classList.add('cgb-ok');
      else tab.classList.add('cgb-bad');
      tab.title = `ChatGPT Bridge: ${view.title}`;
      tab.setAttribute('aria-label', `ChatGPT Bridge: ${view.title}. Open settings`);
    }
    if (statusCard) statusCard.dataset.tone = view.tone;
    const eyebrow = root.querySelector('#cgb-state-eyebrow');
    const title = root.querySelector('#cgb-state-title');
    const detail = root.querySelector('#cgb-state-detail');
    if (eyebrow) eyebrow.textContent = view.eyebrow;
    if (title) title.textContent = view.title;
    if (detail) detail.textContent = view.detail;
    const debug = root.querySelector('#cgb-debug-state');
    if (debug) {
      debug.textContent = JSON.stringify({
        status: panelState.status,
        last: panelState.lastError,
        compatibility: panelState.compatibility,
        serverUrl: CONFIG.serverUrl,
        hasToken: Boolean(CONFIG.token),
        clientId: getClientId(),
        activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null,
        page: location.href,
      }, null, 2);
    }
    const logNode = root.querySelector('#cgb-log');
    if (logNode) logNode.textContent = localLogs.slice(-20).map((entry) => `${entry.time} ${entry.type} ${JSON.stringify(entry.details || {})}`).join('\n') || 'No local extension logs yet.';
    const versions = root.querySelector('#cgb-versions');
    if (versions) versions.textContent = `ext ${EXTENSION_VERSION || '?'} · content ${CONTENT_SCRIPT_VERSION}${panelState.bridgeVersion ? ` · bridge ${panelState.bridgeVersion}` : ''}`;
    const pageSession = root.querySelector('#cgb-page-session');
    if (pageSession) pageSession.textContent = getCurrentSession()?.id || 'new chat';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function compareVersionStrings(left = '', right = '') {
    const parse = (value) => {
      const match = String(value || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      return match ? [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)] : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index += 1) {
      if (a[index] > b[index]) return 1;
      if (a[index] < b[index]) return -1;
    }
    return 0;
  }

  function applyCompatibilityStatus(compatibility = {}, fallbackStatus = '') {
    if (!compatibility || typeof compatibility !== 'object') return;
    panelState.compatibility = compatibility;
    if (compatibility.compatible === false) {
      setPanelStatus(fallbackStatus || (compatibility.status === 'bridge_outdated' ? 'bridge update required' : 'extension update required'), compatibility.message || 'Extension compatibility check failed.');
      setFloatingPanelOpen(true);
    } else if (compatibility.compatible === true && /update required|outdated|incompatible/i.test(String(panelState.status || ''))) {
      setPanelStatus('connected', compatibility.message || 'Extension compatibility check passed.');
    } else {
      updatePanel();
    }
  }

  function disconnectTransport() {
    pollAbort = true;
    pollingStarted = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { extensionPort?.disconnect?.(); } catch {}
    extensionPort = null;
    try { ws?.close?.(); } catch {}
    ws = null;
  }

  function handleServerMessage(payload) {
    if (payload.type === 'server.hello') {
      connectedServerInstanceId = String(payload.serverInstanceId || '');
      panelState.bridgeVersion = String(payload.bridgeVersion || '');
      const requirements = payload.extensionCompatibility && typeof payload.extensionCompatibility === 'object' ? payload.extensionCompatibility : null;
      if (requirements?.minExtensionVersion) {
        const extensionComparison = compareVersionStrings(EXTENSION_VERSION, requirements.minExtensionVersion);
        const contentComparison = compareVersionStrings(CONTENT_SCRIPT_VERSION, requirements.minContentVersion || '0.0.0');
        if (extensionComparison == null || extensionComparison < 0 || contentComparison == null || contentComparison < 0) {
          applyCompatibilityStatus({
            compatible: false,
            status: 'extension_outdated',
            message: `Extension ${EXTENSION_VERSION || 'unknown'} is older than required ${requirements.minExtensionVersion}. Reload the extension package from bridge ${panelState.bridgeVersion || 'server'}.`,
            ...requirements,
            extensionVersion: EXTENSION_VERSION,
            contentVersion: CONTENT_SCRIPT_VERSION,
          }, 'extension update required');
        }
      }
      schedulePageStatus('page.status', 0);
      updatePanel();
      return;
    }

    if (payload.type === 'extension.compatibility' || payload.type === 'extension.status') {
      applyCompatibilityStatus(payload.compatibility || {
        compatible: payload.compatible !== false,
        status: payload.status || '',
        message: payload.detail || '',
      }, payload.status || 'extension status');
      return;
    }

    if (payload.type === 'ping') {
      send({ type: 'pong', time: Date.now(), url: location.href, title: document.title, session: getCurrentSession(), activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null, ...pagePresence() });
      return;
    }

    if (payload.type === 'request.resume') {
      handleRequestResume(payload);
      return;
    }

    if (payload.type === 'prompt.send') {
      void handlePromptSend(payload);
      return;
    }

    if (payload.type === 'passive.prompt.submit') {
      void handlePassivePromptSubmit(payload);
      return;
    }

    if (payload.type === 'prompt.cancel') {
      handlePromptCancel(payload);
      return;
    }

    if (payload.type === 'prompt.steer') {
      void handlePromptSteer(payload);
      return;
    }

    if (payload.type === 'sessions.list') {
      handleSessionsList(payload);
      return;
    }

    if (payload.type === 'sessions.new') {
      void handleSessionsNew(payload);
      return;
    }

    if (payload.type === 'sessions.select') {
      void handleSessionsSelect(payload);
      return;
    }

    if (payload.type === 'sessions.delete') {
      void handleSessionsDelete(payload);
      return;
    }

    if (payload.type === 'browser.tab.open') {
      void handleBrowserTabOpen(payload);
      return;
    }

    if (payload.type === 'browser.tab.close') {
      void handleBrowserTabClose(payload);
      return;
    }

    if (payload.type === 'browser.tab.reload') {
      handleBrowserTabReload(payload);
      return;
    }

    if (payload.type === 'extension.reload') {
      handleExtensionReload(payload);
      return;
    }

    if (payload.type === 'artifact.fetch') {
      void handleArtifactFetch(payload);
      return;
    }

    if (payload.type === 'response.snapshot.request') {
      handleResponseSnapshotRequest(payload);
      return;
    }

    if (payload.type === 'response.recover.latest') {
      handleResponseRecoverLatest(payload);
      return;
    }

    if (payload.type === 'response.recover.turnKey') {
      handleResponseRecoverTurnKey(payload);
      return;
    }

    if (payload.type === 'response.recover.list') {
      handleResponseRecoverList(payload);
      return;
    }

    if (payload.type === 'models.list') {
      void handleModelsList(payload);
      return;
    }

    if (payload.type === 'efforts.list') {
      void handleEffortsList(payload);
      return;
    }

    if (payload.type === 'composer.attachments.clear') {
      void handleComposerAttachmentsClear(payload);
    }
  }

  function handleRequestResume(payload) {
    const commandId = payload.commandId;
    const expectedRequestId = String(payload.requestId || '');
    if (!activeRequest) {
      send({ type: 'command.error', commandId, message: 'No active ChatGPT prompt is running in this tab.' });
      diagnostic('request.resume.no_active', { commandId });
      return;
    }
    if (expectedRequestId && activeRequest.requestId !== expectedRequestId) {
      send({ type: 'command.error', commandId, message: `Active prompt is ${activeRequest.requestId}, not ${expectedRequestId}.` });
      diagnostic('request.resume.request_mismatch', { commandId, expectedRequestId, activeRequestId: activeRequest.requestId });
      return;
    }

    const status = publicRequestStatus(activeRequest);
    send({ type: 'request.resumed', commandId, activeRequest: status, session: getCurrentSession(), url: location.href, title: document.title });
    diagnostic('request.resume.attached', { commandId, requestId: activeRequest.requestId, promptPreview: activeRequest.promptPreview || '' });

    // The original bridge process may have already missed earlier snapshots.
    // Re-emit the current cached state immediately before returning to normal
    // DOM polling, even if the text has not changed since the last local poll.
    if (activeRequest.lastThinking) send({ type: 'thinking.snapshot', requestId: activeRequest.requestId, text: activeRequest.lastThinking });
    if (activeRequest.lastAnswer) send({ type: 'answer.snapshot', requestId: activeRequest.requestId, text: activeRequest.lastAnswer });
    if (activeRequest.artifacts?.length) send({ type: 'artifact.snapshot', requestId: activeRequest.requestId, artifacts: activeRequest.artifacts });
    collectAndEmit(activeRequest);
  }

  async function handlePromptSend(payload) {
    const requestId = String(payload.requestId || '');
    const message = String(payload.message || '');
    const options = payload.options || {};
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (!requestId) return;
    if (!message.trim() && !attachments.length) {
      send({ type: 'error', requestId, message: 'Empty prompt and no attachments received' });
      return;
    }

    if (activeRequest) {
      if (activeRequest.requestId === requestId) {
        const status = publicRequestStatus(activeRequest);
        send({ type: 'prompt.accepted', requestId, duplicate: true }, { priority: true, immediatePost: true, timeout: 5_000 });
        send({ type: 'request.progress', requestId, ...status, meaningful: false, reason: 'duplicate_prompt_delivery' });
        diagnostic('prompt.duplicate_ignored', { requestId, phase: activeRequest.phase || 'active' });
        return;
      }
      send({ type: 'error', requestId, message: `Another prompt is active: ${activeRequest.requestId}` });
      diagnostic('prompt.rejected_busy', { requestId, activeRequestId: activeRequest.requestId, ownerServerInstanceId: activeRequest.ownerServerInstanceId || '' });
      return;
    }

    const request = createRequestState(requestId, options, payload.serverInstanceId || connectedServerInstanceId);
    activeRequest = request;
    schedulePageStatus('page.changed', 0);

    try {
      send({ type: 'prompt.accepted', requestId }, { priority: true, immediatePost: true, timeout: 5_000 });
      setRequestPhase(request, 'prompt_accepted_by_content_script', { meaningful: true });
      diagnostic('prompt.accepted', { requestId });
      emitChatEvent(request, 'prompt.accepted');

      await waitForDocumentReady();
      await waitForChatPageReady(request, { stage: 'initial' });
      await applySessionOptions(options, request);
      await waitForChatPageReady(request, { stage: 'session' });
      await applyModelOptions(options, request);
      await waitForChatPageReady(request, { stage: 'model', settleMs: 400 });

      request.baselineAssistantCount = getAssistantNodes().length;
      request.baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean));
      request.promptHash = simpleHash(message);
      request.promptPreview = message.slice(0, 160);
      request.turnBaselineReady = true;
      startDomMonitor(request);
      send({ type: 'session.snapshot', requestId, session: getCurrentSession() }, { priority: true, immediatePost: true, timeout: 5_000 });
      emitChatEvent(request, 'session.snapshot', { session: getCurrentSession() });

      if (attachments.length) {
        setRequestPhase(request, 'attachments_uploading', { attachmentCount: attachments.length });
        await attachFiles(attachments, request);
      }

      // Arm turn capture only at the actual submission boundary. Foreground,
      // pageshow and MutationObserver resyncs can run while session/model/file
      // setup is still in progress; allowing them to adopt turns earlier binds a
      // new local request to the previous visible user/assistant pair.
      const submissionTurns = getTurnNodes();
      const submissionBaseline = new Set(submissionTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
      request.pendingSubmittedTurnBaseline = submissionBaseline;
      request.pendingSubmittedTurnKind = 'prompt';
      request.pendingSubmittedTurnExpectedText = message;
      request.turnCaptureArmed = true;
      request.promptSubmissionStartedAt = Date.now();
      diagnostic('prompt.turn_boundary.armed', {
        requestId,
        turnCount: submissionTurns.length,
        baselineCount: submissionBaseline.size,
      });
      emitChatEvent(request, 'prompt.turn_boundary.armed', {
        turnCount: submissionTurns.length,
        baselineCount: submissionBaseline.size,
      });

      await enterPrompt(message, request, { kind: 'prompt' });
      request.sentAt = Date.now();
      setRequestPhase(request, 'prompt_submitted', { meaningful: true });
      await waitForSubmittedUserTurnAnchor(request, submissionBaseline, { kind: 'prompt', replace: false, timeoutMs: 5_000 });
      refreshRequestTurnAnchors(request);
      if (!request.submittedUserTurnKey) setRequestPhase(request, 'waiting_for_user_turn', { meaningful: false });
      send({ type: 'status', requestId, status: 'sent' }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('prompt.sent', { requestId });
      emitChatEvent(request, 'prompt.sent', { attachmentCount: attachments.length });

      collectAndEmit(request);
    } catch (err) {
      finishRequest(request, err);
    }
  }

  async function handlePassivePromptSubmit(payload) {
    const commandId = String(payload.commandId || '');
    const message = String(payload.message || '').trim();
    const options = payload.options || {};
    try {
      if (!commandId) throw new Error('passive.prompt.submit requires commandId');
      if (!message) throw new Error('Passive prompt message is empty');
      if (activeRequest) throw new Error(`Cannot submit a passive prompt while request ${activeRequest.requestId} is active`);
      const request = createRequestState(`passive_${commandId}`, options, payload.serverInstanceId || connectedServerInstanceId);
      await waitForDocumentReady();
      await waitForChatPageReady(request, { stage: 'passive-initial' });
      await applySessionOptions(options, request);
      await waitForChatPageReady(request, { stage: 'passive-session' });
      await applyModelOptions(options, request);
      await waitForChatPageReady(request, { stage: 'passive-model', settleMs: 400 });
      baselinePassiveTurns('passive-prompt-submit');
      const beforeTurns = getTurnNodes();
      const baseline = new Set(beforeTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
      request.pendingSubmittedTurnBaseline = baseline;
      request.pendingSubmittedTurnKind = 'passive';
      request.pendingSubmittedTurnExpectedText = message;
      request.turnCaptureArmed = true;
      request.promptSubmissionStartedAt = Date.now();
      diagnostic('passive.prompt.submit.started', { commandId, baselineCount: baseline.size, length: message.length });
      await enterPrompt(message, request, { kind: 'passive' });
      request.sentAt = Date.now();
      await waitForSubmittedUserTurnAnchor(request, baseline, { kind: 'passive', replace: false, timeoutMs: 7_000 });
      refreshRequestTurnAnchors(request);
      send({
        type: 'passive.prompt.submitted',
        commandId,
        submittedUserTurnKey: request.submittedUserTurnKey || '',
        session: getCurrentSession(),
        url: location.href,
        title: document.title,
      });
      diagnostic('passive.prompt.submit.completed', { commandId, submittedUserTurnKey: request.submittedUserTurnKey || '' });
      schedulePassiveTurnScan('passive-prompt-submitted', 500);
    } catch (err) {
      send({ type: 'command.error', commandId, message: err.message || String(err) });
      diagnostic('passive.prompt.submit.failed', { commandId, message: err.message || String(err) });
    }
  }

  function handlePromptCancel(payload) {
    const requestId = String(payload.requestId || '');
    if (!activeRequest || (requestId && activeRequest.requestId !== requestId)) return;

    const reason = String(payload.reason || 'Cancelled by bridge');
    diagnostic('prompt.cancel_received', { requestId: activeRequest.requestId, reason });
    emitChatEvent(activeRequest, 'prompt.cancelled', { reason });
    clickStopButton();
    finishRequest(activeRequest, new Error(reason));
  }


  async function handlePromptSteer(payload) {
    const commandId = String(payload.commandId || '');
    const requestId = String(payload.requestId || '');
    const message = String(payload.message || '').trim();
    try {
      if (!activeRequest) throw new Error('No active ChatGPT prompt is running in this tab.');
      if (requestId && activeRequest.requestId !== requestId) {
        throw new Error(`Active prompt is ${activeRequest.requestId}, not ${requestId}.`);
      }
      if (!message) throw new Error('Steer message is empty.');
      const beforeTurns = getTurnNodes();
      const beforeTurnKeys = new Set(beforeTurns.map((turn, index) => turnKey(turn, index)).filter(Boolean));
      activeRequest.pendingSubmittedTurnBaseline = beforeTurnKeys;
      activeRequest.pendingSubmittedTurnKind = 'steer';
      activeRequest.pendingSubmittedTurnExpectedText = message;
      await enterPrompt(message, activeRequest, { kind: 'steer' });
      const reanchored = await waitForSubmittedUserTurnAnchor(activeRequest, beforeTurnKeys, { kind: 'steer', replace: true, timeoutMs: 5_000 });
      markRequestProgress(activeRequest, 'prompt.steered');
      setRequestPhase(activeRequest, 'steer_submitted', {
        meaningful: true,
        submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
        assistantTurnKey: activeRequest.assistantTurnKey || '',
        reanchored: Boolean(reanchored),
      });
      diagnostic('prompt.steered', {
        requestId: activeRequest.requestId,
        length: message.length,
        beforeTurnCount: beforeTurns.length,
        reanchored: Boolean(reanchored),
        submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
      });
      emitChatEvent(activeRequest, 'prompt.steered', {
        message,
        length: message.length,
        beforeTurnCount: beforeTurns.length,
        reanchored: Boolean(reanchored),
        submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
      });
      send({
        type: 'prompt.steered',
        commandId,
        requestId: activeRequest.requestId,
        messageLength: message.length,
        reanchored: Boolean(reanchored),
        submittedUserTurnKey: activeRequest.submittedUserTurnKey || '',
        session: getCurrentSession(),
        url: location.href,
      });
      collectAndEmit(activeRequest);
    } catch (err) {
      if (activeRequest) {
        activeRequest.pendingSubmittedTurnBaseline = null;
        activeRequest.pendingSubmittedTurnKind = '';
        activeRequest.pendingSubmittedTurnExpectedText = '';
      }
      send({ type: 'command.error', commandId, message: err.message || String(err) });
    }
  }

  function createRequestState(requestId, options, ownerServerInstanceId = '') {
    return {
      requestId,
      startedAt: Date.now(),
      options,
      ownerServerInstanceId: String(ownerServerInstanceId || ''),
      phase: 'created',
      lastProgressSentAt: 0,
      lastMeaningfulProgressAt: Date.now(),
      lastMeaningfulProgressReason: 'request.created',
      baselineAssistantCount: 0,
      baselineTurnKeys: new Set(),
      turnBaselineReady: false,
      turnCaptureArmed: false,
      promptSubmissionStartedAt: 0,
      submittedUserTurnKey: '',
      submittedUserTurnIndex: -1,
      submittedUserTurnLogged: false,
      assistantTurnKey: '',
      assistantTurnIndex: -1,
      pendingSubmittedTurnBaseline: null,
      pendingSubmittedTurnKind: '',
      pendingSubmittedTurnExpectedText: '',
      lastUserTurnMismatchSignature: '',
      assistantTurnLogged: false,
      assistantTurnMissingLogged: false,
      assistantTurnMissingSince: 0,
      promptHash: '',
      promptPreview: '',
      lastAnswer: '',
      lastThinking: '',
      lastProgressText: '',
      lastProgressItemsFingerprint: '',
      lastProgressItems: [],
      lastRaw: '',
      lastDomSignature: '',
      lastVisibleThinking: '',
      reasoningHistory: [],
      lastUnknownTestIdsSignature: '',
      lastArtifactsFingerprint: '',
      lastIgnoredArtifactFingerprint: '',
      artifacts: [],
      stableSince: 0,
      generationIdleSince: 0,
      sawAnswer: false,
      sawGenerating: false,
      generationStoppedSent: false,
      steerWaitStartedAt: 0,
      terminalCandidateSince: 0,
      requiredArtifactWaitSince: 0,
      requiredArtifactWaitLogged: false,
      steerWaitExpiredAt: 0,
      lastSnapshotChangedAt: 0,
      collectScheduled: false,
      collectTimer: null,
      collecting: false,
      networkDone: false,
      observer: null,
      observerRoot: null,
      observerRootMissingLogged: false,
      pollTimer: null,
      finishTimer: null,
      generationStartWarningSent: false,
      firstOutputWarningSent: false,
      maxRequestTimeoutWarningSent: false,
      sentAt: 0,
      finished: false,
    };
  }

  function expectedOutputContract(request) {
    const source = request?.options?.expectedOutput && typeof request.options.expectedOutput === 'object'
      ? request.options.expectedOutput
      : {};
    return {
      expected: String(source.expected || source.format || '').toLowerCase(),
      required: Boolean(source.required),
    };
  }

  function requiredArtifactPending(request, snapshot, now = Date.now()) {
    const contract = expectedOutputContract(request);
    const expectsZip = contract.required && contract.expected === 'zip';
    const expectsFile = contract.required && ['file', 'artifact', 'download'].includes(contract.expected);
    if (!expectsZip && !expectsFile) return { pending: false, timedOut: false, waitedMs: 0 };
    const readyArtifacts = (Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : []).filter((artifact) => {
      return String(artifact?.phase || 'READY').toUpperCase() === 'READY'
        && Boolean(artifact?.downloadActionPresent || artifact?.downloadable || artifact?.url || artifact?.downloadUrl || artifact?.src);
    });
    const artifactIdentitySignal = (artifact) => [
      artifact?.name,
      artifact?.fileName,
      artifact?.mime,
      artifact?.kind,
      artifact?.actionLabel,
      artifact?.blockText,
      artifact?.downloadUrl,
      artifact?.url,
      artifact?.src,
    ].filter(Boolean).join(' ');
    const artifactExplicitFileSignal = (artifact) => [
      artifact?.name,
      artifact?.fileName,
      artifact?.mime,
      artifact?.actionLabel,
      artifact?.text,
      artifact?.downloadUrl,
      artifact?.url,
      artifact?.src,
    ].filter(Boolean).join(' ');
    const hasDefiniteZip = readyArtifacts.some((artifact) => {
      const label = artifactIdentitySignal(artifact);
      return /\.zip(?:\b|$)/i.test(label) || /application\/(?:x-)?zip/i.test(label);
    });
    const explicitNonZip = /\.(?:txt|csv|json|js|mjs|cjs|ts|tsx|jsx|md|pdf|png|jpe?g|webp|gif|svg|html?|css|xml|ya?ml|toml|ini|log|py|sh|bash|zsh|sql|tar|gz|tgz|7z|rar|docx|xlsx|pptx|odt|ods|odp|rtf|mp3|wav|flac|aac|mp4|m4v|mov|webm|avi|mkv|wasm|bin|dmg|pkg|exe)(?:\b|$)/i;
    const oneSafeGenericZipAction = readyArtifacts.length === 1
      && !explicitNonZip.test(artifactExplicitFileSignal(readyArtifacts[0]));
    // The resolver can safely materialize one extensionless scoped file action
    // and validate its bytes as ZIP. A clearly named non-ZIP file or multiple
    // generic actions remain pending instead of being selected optimistically.
    const hasRequiredArtifact = expectsFile
      ? readyArtifacts.length > 0
      : hasDefiniteZip || oneSafeGenericZipAction;
    if (hasRequiredArtifact) {
      request.requiredArtifactWaitSince = 0;
      request.requiredArtifactWaitLogged = false;
      return { pending: false, timedOut: false, waitedMs: 0 };
    }
    if (!request.requiredArtifactWaitSince) request.requiredArtifactWaitSince = now;
    const waitedMs = now - request.requiredArtifactWaitSince;
    const limitMs = Math.max(1_500, Number(request.options?.requiredArtifactSettleMs) || CONFIG.requiredArtifactSettleMs);
    return { pending: waitedMs < limitMs, timedOut: waitedMs >= limitMs, waitedMs, limitMs };
  }

  function snapshotTerminalForRequest(snapshot, request) {
    const expectedConversationId = conversationIdFromUrl(request?.options?.sessionId || '') || String(request?.options?.sessionId || '');
    if (!DOM_PARSER.isCompletedSnapshot(snapshot, expectedConversationId)) return false;
    const artifactState = requiredArtifactPending(request, snapshot);
    return !artifactState.pending;
  }

  function publicRequestStatus(request) {
    if (!request) return null;
    const stopButtonVisible = Boolean(findStopButton());
    const generating = stopButtonVisible || isGenerating();
    return {
      requestId: request.requestId,
      startedAt: request.startedAt,
      sentAt: request.sentAt || 0,
      sawGenerating: request.sawGenerating,
      generating,
      stopButtonVisible,
      ownerServerInstanceId: request.ownerServerInstanceId || '',
      phase: request.phase || 'created',
      sawAnswer: request.sawAnswer,
      lastAnswerLength: request.lastAnswer.length,
      lastThinkingLength: request.lastThinking.length,
      lastProgressLength: String(request.lastProgressText || '').length,
      artifactCount: request.artifacts.length,
      submittedUserTurnKey: request.submittedUserTurnKey || '',
      submittedUserTurnIndex: request.submittedUserTurnIndex,
      promptPreview: request.promptPreview || '',
      promptHash: request.promptHash || '',
      assistantTurnKey: request.assistantTurnKey || '',
      assistantTurnIndex: request.assistantTurnIndex ?? -1,
      lastMeaningfulProgressAt: request.lastMeaningfulProgressAt || 0,
      lastMeaningfulProgressReason: request.lastMeaningfulProgressReason || '',
      url: location.href,
      title: document.title,
    };
  }

  function waitForDocumentReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  function chatPageReadiness() {
    const chatMain = findChatMain();
    const composer = findComposer();
    const composerReady = Boolean(composer && composer.isConnected && isVisible(composer) && !composer.disabled && !composer.readOnly);
    const chatMainReady = Boolean(chatMain && chatMain.isConnected && isVisible(chatMain));
    return {
      ready: document.readyState !== 'loading' && chatMainReady && composerReady,
      chatMainReady,
      composerReady,
      composer,
      url: location.href,
    };
  }

  async function waitForChatPageReady(request, options = {}) {
    const timeoutMs = Math.max(5_000, Number(options.timeoutMs || request?.options?.pageReadyTimeoutMs || CONFIG.pageReadyTimeoutMs) || CONFIG.pageReadyTimeoutMs);
    const settleMs = Math.max(150, Number(options.settleMs ?? request?.options?.pageReadySettleMs ?? CONFIG.pageReadySettleMs) || CONFIG.pageReadySettleMs);
    const stage = String(options.stage || 'prompt');
    const started = Date.now();
    let readySince = 0;
    let readyUrl = '';
    let lastState = '';

    emitChatEvent(request, 'page.ready.wait', { stage, timeoutMs, settleMs });
    while (Date.now() - started < timeoutMs) {
      const state = chatPageReadiness();
      const signature = JSON.stringify([document.readyState, state.chatMainReady, state.composerReady, state.url]);
      if (signature !== lastState) {
        lastState = signature;
        diagnostic('page.ready.state', {
          requestId: request?.requestId,
          stage,
          documentReadyState: document.readyState,
          chatMainReady: state.chatMainReady,
          composerReady: state.composerReady,
          url: state.url,
        });
      }
      if (state.ready) {
        if (!readySince || readyUrl !== state.url) {
          readySince = Date.now();
          readyUrl = state.url;
        }
        if (Date.now() - readySince >= settleMs) {
          diagnostic('page.ready', { requestId: request?.requestId, stage, waitedMs: Date.now() - started, settleMs, url: state.url });
          emitChatEvent(request, 'page.ready', { stage, waitedMs: Date.now() - started, settleMs, url: state.url });
          schedulePageStatus('page.changed', 0);
          return state;
        }
      } else {
        readySince = 0;
        readyUrl = '';
      }
      await delay(200);
    }

    const state = chatPageReadiness();
    diagnostic('page.ready.timeout', {
      requestId: request?.requestId,
      stage,
      timeoutMs,
      documentReadyState: document.readyState,
      chatMainReady: state.chatMainReady,
      composerReady: state.composerReady,
      url: state.url,
    });
    throw new Error(`CHAT_PAGE_NOT_READY: ChatGPT composer did not become stable during ${stage} after ${timeoutMs}ms`);
  }

  async function applySessionOptions(options, request) {
    if (options.newSession) {
      emitChatEvent(request, 'session.new.started');
      const session = await openNewSession();
      emitChatEvent(request, 'session.new.done', { session });
      return;
    }

    if (options.sessionId) {
      emitChatEvent(request, 'session.select.started', { sessionId: options.sessionId });
      const session = await selectSessionById(options.sessionId);
      emitChatEvent(request, 'session.select.done', { session });
    }
  }

  async function applyModelOptions(options, request) {
    const model = String(options.model || '').trim();
    const effort = String(options.effort || '').trim();
    if (!model && !effort) return;

    emitChatEvent(request, 'model.apply.started', { model, effort });
    diagnostic('model.apply.started', { requestId: request.requestId, model, effort });

    const result = { model, effort, modelApplied: false, effortApplied: false, warnings: [] };
    let modelSelection = null;
    let effortSelection = null;

    if (model) {
      modelSelection = await trySelectIntelligenceOption(model, 'model', request);
      if (!modelSelection.matched) result.warnings.push(`Could not find model option: ${model}`);
      if (effort) await delay(INTELLIGENCE_UI_TIMING.betweenSelectionsMs);
    }

    if (effort) {
      const effortLabel = effortLabelFromValue(effort);
      effortSelection = await trySelectIntelligenceOption(effortLabel, 'effort', request);
      if (!effortSelection.matched) result.warnings.push(`Could not find effort option: ${effort}`);
    }

    let state = null;
    let verificationError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      diagnostic('model.apply.verification.started', { requestId: request.requestId, model, effort, attempt });
      try {
        state = await readIntelligenceState({ includeModels: Boolean(model) });
        result.modelApplied = model ? DOM_PARSER.intelligenceOptionMatches(state.selectedModel || {}, model) : false;
        result.effortApplied = effort ? DOM_PARSER.intelligenceOptionMatches(state.selectedEffort || {}, effortLabelFromValue(effort)) : false;
        const verified = (!model || result.modelApplied) && (!effort || result.effortApplied);
        if (verified) break;
        verificationError = new Error(`Picker state mismatch: model=${state.selectedModel?.label || ''} effort=${state.selectedEffort?.id || state.selectedEffort?.label || ''}`);
      } catch (err) {
        verificationError = err;
      }
      if (attempt < 2) {
        diagnostic('model.apply.verification.retry', { requestId: request.requestId, model, effort, attempt, message: verificationError?.message || 'state mismatch' });
        await delay(INTELLIGENCE_UI_TIMING.verificationRetryMs);
      }
    }

    if (model && !result.modelApplied) result.warnings.push(`Could not confirm model selection: ${model}`);
    if (effort && !result.effortApplied) result.warnings.push(`Could not confirm effort selection: ${effort}`);
    if (verificationError && result.warnings.length) result.warnings.push(`Verification detail: ${verificationError.message}`);

    const verifiedIntelligence = state ? {
      models: Array.isArray(state.models) ? state.models : [],
      efforts: Array.isArray(state.efforts) ? state.efforts : [],
      selectedModel: state.selectedModel || null,
      selectedEffort: state.selectedEffort || null,
      capturedAt: state.capturedAt || Date.now(),
    } : null;
    const completedResult = { ...result, intelligence: verifiedIntelligence };
    send({ type: 'chat.event', requestId: request.requestId, event: { type: 'model.apply.done', requestId: request.requestId, time: new Date().toISOString(), ...completedResult } });
    diagnostic('model.apply.done', {
      requestId: request.requestId,
      ...completedResult,
      modelSelection: modelSelection ? { matched: modelSelection.matched, clicked: modelSelection.clicked, alreadySelected: modelSelection.alreadySelected } : null,
      effortSelection: effortSelection ? { matched: effortSelection.matched, clicked: effortSelection.clicked, alreadySelected: effortSelection.alreadySelected } : null,
      selectedModel: state?.selectedModel?.label || '',
      selectedEffort: state?.selectedEffort?.id || state?.selectedEffort?.label || '',
    });
  }

  function effortLabelFromValue(value) {
    const normalized = String(value || '').toLowerCase();
    const map = {
      low: 'low',
      medium: 'medium',
      med: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      'x-high': 'xhigh',
      auto: 'auto',
      instant: 'instant',
      thinking: 'thinking',
    };
    return map[normalized] || value;
  }

  function normalizeComparable(value) {
    return String(value || '').toLowerCase().replace(/[\s_\-.]+/g, '').trim();
  }

  async function attachFiles(attachments, request) {
    emitChatEvent(request, 'files.attach.started', { count: attachments.length, files: attachments.map(stripAttachmentContent) });
    const files = [];

    for (const attachment of attachments) {
      try {
        files.push(await attachmentToFile(attachment));
        diagnostic('file.prepared', { requestId: request.requestId, id: attachment.id, name: attachment.name, size: attachment.size });
      } catch (err) {
        diagnostic('file.prepare_failed', { requestId: request.requestId, id: attachment.id, name: attachment.name, message: err.message });
        throw err;
      }
    }

    const input = await waitForFileInput(request);
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    diagnostic('file.input.changed', { requestId: request.requestId, count: files.length, names: files.map((file) => file.name) });
    emitChatEvent(request, 'files.attach.changed', { count: files.length, names: files.map((file) => file.name) });

    await waitForAttachmentChips(files, request).catch((err) => {
      diagnostic('file.upload_wait.warning', { requestId: request.requestId, message: err.message });
      emitChatEvent(request, 'files.attach.warning', { message: err.message });
    });
    emitChatEvent(request, 'files.attach.done', { count: files.length, names: files.map((file) => file.name) });
  }

  function stripAttachmentContent(attachment) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const { contentBase64, content, ...rest } = attachment;
    return rest;
  }

  async function attachmentToFile(attachment) {
    const name = String(attachment.name || attachment.filename || attachment.id || 'attachment');
    const mime = String(attachment.mime || attachment.type || 'application/octet-stream');

    if (attachment.contentBase64) {
      return new File([base64ToUint8Array(attachment.contentBase64)], name, { type: mime });
    }

    if (attachment.content) {
      return new File([String(attachment.content)], name, { type: mime || 'text/plain' });
    }

    if (attachment.url) {
      const blob = await fetchAttachmentBlob(attachment.url, mime);
      return new File([blob], name, { type: blob.type || mime });
    }

    throw new Error(`Attachment has no content: ${name}`);
  }

  function base64ToUint8Array(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function fetchAttachmentBlob(url, fallbackMime = 'application/octet-stream') {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.blob();
    } catch (err) {
      if (typeof GM_xmlhttpRequest !== 'function') throw new Error(`Could not fetch attachment URL: ${err.message || err}`);
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          anonymous: false,
          onload(response) {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`Could not fetch attachment URL with GM_xmlhttpRequest: HTTP ${response.status}`));
              return;
            }
            const blob = response.response instanceof Blob ? response.response : new Blob([response.response], { type: fallbackMime });
            resolve(blob);
          },
          onerror() { reject(new Error('Could not fetch attachment URL with GM_xmlhttpRequest')); },
          ontimeout() { reject(new Error('Timed out fetching attachment URL')); },
        });
      });
    }
  }

  async function waitForFileInput(request, timeoutMs = 10_000) {
    const existing = findFileInput();
    if (existing) return existing;

    const attachButton = findAttachButton();
    if (attachButton) {
      attachButton.click();
      diagnostic('file.attach_button.clicked', { requestId: request.requestId });
      await delay(350);
    } else {
      diagnostic('file.attach_button.not_found', { requestId: request.requestId });
    }

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const input = findFileInput();
      if (input) return input;
      await delay(200);
    }

    throw new Error('File input not found in ChatGPT composer');
  }

  function findFileInput() {
    return Array.from(document.querySelectorAll('input[type="file"]')).find((input) => !input.disabled) || null;
  }

  function findAttachButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isUsableButton);
    return buttons.find((button) => {
      const text = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.innerText || button.textContent || ''].filter(Boolean).join(' ');
      return /attach|upload|file|add photos|paperclip|прикреп|загруз|файл|скреп/i.test(text);
    }) || null;
  }

  async function waitForAttachmentChips(files, request) {
    const started = Date.now();
    const names = files.map((file) => file.name).filter(Boolean);
    let lastVisibleCount = 0;

    while (Date.now() - started < CONFIG.attachmentUploadTimeoutMs) {
      const root = findComposerRoot();
      const rootText = visibleText(root || document.body);
      const visibleNames = names.filter((name) => rootText.includes(name) || visibleText(document.body).includes(name));
      lastVisibleCount = visibleNames.length;

      const uploadError = findUploadError(root || document.body);
      if (uploadError) {
        diagnostic('file.upload_error', { requestId: request.requestId, message: uploadError });
        throw new Error(`Attachment upload failed: ${uploadError}`);
      }

      const busy = isAttachmentUploadBusy(root || document.body);
      const sendButton = findSendButton();
      if (visibleNames.length === names.length && !busy && sendButton) {
        diagnostic('file.upload.complete', { requestId: request.requestId, names, elapsedMs: Date.now() - started });
        return;
      }

      if (visibleNames.length !== lastVisibleCount || (Date.now() - started) % 3000 < 350) {
        emitChatEvent(request, 'files.attach.progress', { visible: visibleNames.length, total: names.length, busy });
      }
      await delay(350);
    }

    throw new Error(`Timed out waiting for file attachment upload completion (${lastVisibleCount}/${names.length} visible)`);
  }

  function findUploadError(root) {
    const text = visibleText(root);
    const match = text.match(/(upload failed|failed to upload|could not upload|unsupported file|file too large|ошибка загрузки|не удалось загрузить|файл слишком большой)/i);
    return match ? match[0] : '';
  }

  function isAttachmentUploadBusy(root) {
    const candidates = Array.from((root || document.body).querySelectorAll('[aria-busy="true"], [role="progressbar"], progress, [data-testid*="progress" i], [data-testid*="upload" i], svg[class*="spinner" i], div[class*="spinner" i]'));
    return candidates.some((element) => isVisible(element) && !/send|submit/i.test(element.getAttribute('data-testid') || ''));
  }

  function promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore) {
    const turns = getTurnNodes();
    const newUserTurn = turns
      .map((turn, index) => ({ turn, index, key: turnKey(turn, index), role: turnRole(turn) }))
      .find((item) => item.role === 'user' && item.key && !baselineTurnKeys.has(item.key));
    if (newUserTurn) return { confirmed: true, reason: 'new_user_turn', turnKey: newUserTurn.key, turnIndex: newUserTurn.index };

    const currentComposer = findComposer();
    if (message.trim() && composerBefore && (!currentComposer || !composerContainsText(currentComposer, message))) {
      return { confirmed: true, reason: 'composer_cleared' };
    }

    if (!baselineTurnKeys.size && (findStopButton() || isGenerating())) {
      return { confirmed: true, reason: 'generation_started' };
    }
    return { confirmed: false, reason: 'no_submission_evidence' };
  }

  async function waitForPromptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const evidence = promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore);
      if (evidence.confirmed) return { ...evidence, waitedMs: Date.now() - started };
      await delay(120);
    }
    return { confirmed: false, reason: 'submission_ack_timeout', waitedMs: Date.now() - started };
  }

  async function enterPrompt(message, request, options = {}) {
    const kind = String(options.kind || 'prompt');
    const retryCount = Math.max(1, Math.min(5, Number(request?.options?.promptSubmitRetries || CONFIG.promptSubmitRetries) || CONFIG.promptSubmitRetries));
    const ackTimeoutMs = Math.max(1_000, Number(request?.options?.promptSubmitAckTimeoutMs || CONFIG.promptSubmitAckTimeoutMs) || CONFIG.promptSubmitAckTimeoutMs);
    const retryDelayMs = Math.max(150, Number(request?.options?.promptSubmitRetryDelayMs || CONFIG.promptSubmitRetryDelayMs) || CONFIG.promptSubmitRetryDelayMs);
    const baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean));

    for (let attempt = 1; attempt <= retryCount; attempt += 1) {
      const existingEvidence = promptSubmissionEvidence(request, baselineTurnKeys, message, null);
      if (existingEvidence.confirmed) {
        diagnostic('prompt.submit.already_confirmed', { requestId: request.requestId, kind, attempt, ...existingEvidence });
        return existingEvidence;
      }

      await waitForChatPageReady(request, { stage: `${kind}.submit.${attempt}`, settleMs: attempt === 1 ? 350 : 600 });
      const composer = await waitForComposer(request);
      if (!findChatMain()) {
        throw new Error('DOM_SCHEMA_CHANGED: Chat conversation root is missing. Refusing to submit without a scoped DOM observation root.');
      }
      if (message.trim()) {
        await focusAndSetComposerText(composer, message, request);
        diagnostic('composer.filled', { requestId: request.requestId, kind, attempt, length: message.length });
      } else {
        composer.focus();
      }

      await delay(160);
      const button = findSendButton([findComposerRootStrict()].filter(Boolean));
      let method = 'keyboard';
      if (button) {
        method = 'button';
        diagnostic('send_button.found', { requestId: request.requestId, kind, attempt, label: button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || '' });
        button.click();
      } else {
        diagnostic('send_button.not_found_keyboard_fallback', { requestId: request.requestId, kind, attempt });
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
      }

      const evidence = await waitForPromptSubmissionEvidence(request, baselineTurnKeys, message, composer, ackTimeoutMs);
      diagnostic('prompt.submit.attempt', { requestId: request.requestId, kind, attempt, method, ...evidence });
      emitChatEvent(request, evidence.confirmed ? 'prompt.submit.confirmed' : 'prompt.submit.retry', { kind, attempt, method, ...evidence });
      if (evidence.confirmed) return evidence;
      if (attempt < retryCount) await delay(retryDelayMs * attempt);
    }

    throw new Error(`PROMPT_SUBMIT_NOT_CONFIRMED: ChatGPT did not acknowledge ${kind} submission after ${retryCount} attempts`);
  }

  function waitForComposer(request, timeoutMs = 30_000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const composer = findComposer();
        if (composer) {
          diagnostic('composer.found', { requestId: request.requestId, tagName: composer.tagName, role: composer.getAttribute('role') || '', testId: composer.getAttribute('data-testid') || '' });
          resolve(composer);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          diagnostic('composer.not_found', { requestId: request.requestId, timeoutMs });
          reject(new Error('DOM_SCHEMA_CHANGED: ChatGPT composer is missing or ambiguous. Verify login state and current ChatGPT markup.'));
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function usableComposerCandidates(selector, root = document) {
    return Array.from(root.querySelectorAll(selector))
      .filter((element) => isVisible(element) && !element.disabled && !element.readOnly);
  }

  function findComposer() {
    const primary = usableComposerCandidates('#prompt-textarea[contenteditable="true"]');
    if (primary.length === 1) return primary[0];
    if (primary.length > 1) {
      diagnostic('dom_schema.composer_ambiguous', { selector: '#prompt-textarea[contenteditable="true"]', count: primary.length });
      return null;
    }

    const roots = Array.from(document.querySelectorAll('form, [data-testid*="composer" i]'))
      .filter((root) => isVisible(root) && root.querySelector('[contenteditable="true"], textarea'));
    const candidates = [];
    const seen = new Set();
    const add = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      candidates.push(element);
    };
    for (const root of roots) {
      for (const element of usableComposerCandidates('[role="textbox"][aria-label][contenteditable="true"]', root)) add(element);
      for (const element of usableComposerCandidates('textarea[name="prompt-textarea"], textarea[aria-label]', root)) add(element);
      for (const element of usableComposerCandidates('.ProseMirror[contenteditable="true"]', root)) add(element);
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) diagnostic('dom_schema.composer_ambiguous', { selector: 'composer scoped fallback', count: candidates.length });
    return null;
  }

  async function focusAndSetComposerText(element, text, request) {
    element.focus();
    await delay(20);

    const attempts = [
      () => setComposerTextByPaste(element, text),
      () => setComposerTextByNativeValue(element, text),
      () => setComposerTextByExecCommand(element, text),
      () => setComposerTextByTextContent(element, text),
    ];

    for (let i = 0; i < attempts.length; i += 1) {
      attempts[i]();
      await delay(80);
      if (composerContainsText(element, text)) {
        diagnostic('composer.text_verified', { requestId: request.requestId, method: i + 1, length: text.length });
        return;
      }
    }

    diagnostic('composer.text_verify_failed', { requestId: request.requestId, expectedLength: text.length, actualLength: visibleText(element).length });
    throw new Error('COMPOSER_TEXT_VERIFY_FAILED');
  }

  function setComposerTextByPaste(element, text) {
    clearComposerElement(element);
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event);
  }

  function setComposerTextByNativeValue(element, text) {
    if (!(element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')) return;
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor?.set?.call(element, '');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    descriptor?.set?.call(element, text);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerTextByExecCommand(element, text) {
    clearComposerElement(element);
    if (document.execCommand) document.execCommand('insertText', false, text);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function setComposerTextByTextContent(element, text) {
    clearComposerElement(element);
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') element.value = text;
    else element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clearComposerElement(element) {
    element.focus();
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.execCommand) document.execCommand('delete', false);
    if (visibleText(element)) element.textContent = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  }

  function composerContainsText(element, text) {
    const expected = normalizeComparable(text).slice(0, 2000);
    const actual = normalizeComparable(element.value || element.innerText || element.textContent || '');
    return expected ? actual.includes(expected.slice(0, Math.min(expected.length, 200))) : true;
  }


  function buttonSignalText(element) {
    const text = [
      element?.getAttribute?.('data-testid'),
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      element?.getAttribute?.('data-state'),
      element?.getAttribute?.('placeholder'),
      element?.textContent || '',
    ].filter(Boolean).join(' ');
    return text.length > 500 ? text.slice(0, 500) : text;
  }

  function scopedQueryAll(roots, selector) {
    const result = [];
    const seen = new Set();
    for (const root of roots || []) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      try {
        if (root.matches?.(selector)) result.push(root);
        result.push(...Array.from(root.querySelectorAll?.(selector) || []));
      } catch {
        // Ignore selector/root combinations that become invalid during DOM churn.
      }
    }
    return result;
  }

  function findChatMain() {
    return document.querySelector('main') || document.querySelector('[role="main"]') || null;
  }

  function findTurnByKey(key) {
    if (!key) return null;
    const turns = getTurnNodes();
    return turns.find((turn, index) => turnKey(turn, index) === key) || null;
  }

  function findComposerRootStrict() {
    const composer = findComposer();
    if (!composer) return null;
    return composer.closest('form')
      || composer.closest('[data-testid*="composer" i]')
      || composer.closest('[role="presentation"]')
      || composer.parentElement?.parentElement?.parentElement
      || composer.parentElement
      || null;
  }

  function finalizationControlRoots(request, snapshot = {}) {
    const roots = [];
    const add = (node) => { if (node && !roots.includes(node)) roots.push(node); };
    add(findComposerRootStrict());
    add(findTurnByKey(snapshot.turnKey || request?.assistantTurnKey || ''));
    if (!roots.length) {
      const main = findChatMain();
      if (main) add(main);
    }
    return roots;
  }

  function findButtonBySignal(roots, pattern, selectors = []) {
    for (const selector of selectors) {
      const found = scopedQueryAll(roots, selector).find(isUsableButton);
      if (found) return found;
    }
    return scopedQueryAll(roots, 'button, [role="button"]').find((element) => {
      if (!isUsableButton(element)) return false;
      return pattern.test(buttonSignalText(element));
    }) || null;
  }

  function findStopButton(roots = [document]) {
    return findButtonBySignal(roots, /stop[-_ ]?(button|generating|streaming)|\bstop\b|остановить|停止/i, [
      '[data-testid*="stop" i]',
      'button[aria-label*="Stop" i]',
      '[role="button"][aria-label*="Stop" i]',
    ]);
  }

  function findSendButton(roots = [document]) {
    return findButtonBySignal(roots, /send[-_ ]?(button|message|prompt)?|submit|arrow-up|paper-airplane|отправ|послать|发送|送信/i, [
      '[data-testid="send-button"]',
      '[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      '[role="button"][aria-label*="Send" i]',
    ]);
  }

  function findRegenerateButton(roots = [document]) {
    return findButtonBySignal(roots, /regenerate|retry|try again|rerun|repeat|повтор|сгенерировать снова|заново|もう一度/i, [
      '[data-testid*="regenerate" i]',
      '[data-testid*="retry" i]',
      'button[aria-label*="Regenerate" i]',
      'button[aria-label*="Retry" i]',
    ]);
  }

  function findContinueButton(roots = [document]) {
    return findButtonBySignal(roots, /continue|keep going|resume|продолж|возобнов|続け/i, [
      '[data-testid*="continue" i]',
      'button[aria-label*="Continue" i]',
      '[role="button"][aria-label*="Continue" i]',
    ]);
  }

  function findSteerControl(roots = finalizationControlRoots(activeRequest)) {
    const selector = [
      '[data-testid*="steer" i]',
      '[data-testid*="guidance" i]',
      '[aria-label*="steer" i]',
      '[aria-label*="guide" i]',
      '[aria-label*="guidance" i]',
      '[aria-label*="direct" i]',
      '[aria-label*="interrupt" i]',
      '[placeholder*="steer" i]',
      '[placeholder*="guide" i]',
      '[placeholder*="guidance" i]',
      '[placeholder*="уточ" i]',
      '[placeholder*="направ" i]',
      '[aria-label*="уточ" i]',
      '[aria-label*="направ" i]',
      '[aria-label*="скоррект" i]',
    ].join(',');
    return scopedQueryAll(roots, selector).find((element) => {
      if (!isVisible(element)) return false;
      const text = [
        element.getAttribute?.('data-testid'),
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('placeholder'),
        element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' ? element.value : '',
      ].filter(Boolean).join(' ');
      return /steer|guide|guidance|direct|interrupt|nudge|уточн|направ|скоррект|подправ|вмешат|рули|настрой ход/i.test(text);
    }) || null;
  }

  function readFinalizationSignals(request, snapshot = {}, generating = false) {
    const roots = finalizationControlRoots(request, snapshot);
    const stopButtonVisible = Boolean(snapshot.stopVisible || generating || findStopButton(roots));
    const sendButtonVisible = Boolean(snapshot.sendVisible || findSendButton(roots));
    const regenerateButtonVisible = Boolean(findRegenerateButton(roots));
    const continueButtonVisible = Boolean(snapshot.needsContinue || findContinueButton(roots));
    const steerControlVisible = Boolean(findSteerControl(roots));
    const actionBarVisible = Boolean(snapshot.actionBarVisible);
    const hasFinalMessage = Boolean(snapshot.hasFinalMessage);
    const hasActiveTool = Boolean(snapshot.hasActiveTool);
    const needsConfirmation = Boolean(snapshot.needsConfirmation);
    const hasError = Boolean(snapshot.hasError);
    const expectedConversationId = conversationIdFromUrl(request?.options?.sessionId || '') || String(request?.options?.sessionId || '');
    const conversationMatches = !expectedConversationId || !snapshot.conversationId || snapshot.conversationId === expectedConversationId;
    const terminalMarkerVisible = Boolean(hasFinalMessage && actionBarVisible && !stopButtonVisible && !hasActiveTool && !continueButtonVisible && !needsConfirmation && !hasError && conversationMatches);
    // Continue/Steer are interactive continuation controls. Confirmation is a
    // separate lifecycle state and must never age out into a completed answer.
    const interactiveContinuation = Boolean(continueButtonVisible || steerControlVisible);
    const artifactReady = Array.isArray(snapshot.artifacts) && snapshot.artifacts.length > 0;
    return {
      stopButtonVisible,
      sendButtonVisible,
      regenerateButtonVisible,
      continueButtonVisible,
      steerControlVisible,
      actionBarVisible,
      hasFinalMessage,
      hasActiveTool,
      needsConfirmation,
      hasError,
      conversationMatches,
      terminalMarkerVisible,
      interactiveContinuation,
      artifactReady,
      finalizationConfidence: terminalMarkerVisible ? 'high' : (interactiveContinuation || hasError || !conversationMatches ? 'low' : 'medium'),
    };
  }

  function shouldDeferFinalizationForSteer(request, snapshot, signals, now) {
    if (!request || !signals?.interactiveContinuation) {
      if (request) {
        request.steerWaitStartedAt = 0;
        request.steerWaitExpiredAt = 0;
      }
      return false;
    }

    if (!request.steerWaitStartedAt) {
      request.steerWaitStartedAt = now;
      diagnostic('generation.steer_available', {
        requestId: request.requestId,
        sendButtonVisible: signals.sendButtonVisible,
        continueButtonVisible: signals.continueButtonVisible,
        steerControlVisible: signals.steerControlVisible,
        regenerateButtonVisible: signals.regenerateButtonVisible,
        artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
      });
      emitChatEvent(request, 'generation.steer_available', {
        sendButtonVisible: signals.sendButtonVisible,
        continueButtonVisible: signals.continueButtonVisible,
        steerControlVisible: signals.steerControlVisible,
        regenerateButtonVisible: signals.regenerateButtonVisible,
      });
    }

    const waitForMs = now - request.steerWaitStartedAt;
    const maxWaitMs = Number(request.options?.steerContinuationSettleMs) || CONFIG.steerContinuationSettleMs;
    if (waitForMs <= maxWaitMs) {
      setRequestPhase(request, signals.steerControlVisible || signals.continueButtonVisible ? 'steer_available' : 'continuation_wait', {
        waitForMs,
        maxWaitMs,
        sendButtonVisible: signals.sendButtonVisible,
        continueButtonVisible: signals.continueButtonVisible,
        steerControlVisible: signals.steerControlVisible,
        regenerateButtonVisible: signals.regenerateButtonVisible,
        finalizationConfidence: signals.finalizationConfidence,
      });
      emitRequestProgress(request, snapshot, false, 'generation.steer_wait', {
        force: true,
        meaningful: false,
        sendButtonVisible: signals.sendButtonVisible,
        continueButtonVisible: signals.continueButtonVisible,
        steerControlVisible: signals.steerControlVisible,
        regenerateButtonVisible: signals.regenerateButtonVisible,
        finalizationConfidence: signals.finalizationConfidence,
      });
      return true;
    }

    if (!request.steerWaitExpiredAt) request.steerWaitExpiredAt = now;
    diagnostic('generation.steer_wait.expired', { requestId: request.requestId, waitForMs, maxWaitMs });
    emitChatEvent(request, 'generation.steer_wait.expired', { waitForMs, maxWaitMs });
    return false;
  }


  function clickStopButton() {
    const button = findStopButton();
    if (!button) {
      diagnostic('stop_button.not_found', { requestId: activeRequest?.requestId });
      return false;
    }
    button.click();
    diagnostic('stop_button.clicked', { requestId: activeRequest?.requestId });
    return true;
  }

  function isUsableButton(element) {
    return Boolean(element) && isVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  }

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
    const snapshot = readAssistantSnapshot(request);
    const generating = Boolean(snapshot.stopVisible || isGenerating());
    const now = Date.now();

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

    if (request.sawGenerating && request.generationIdleSince && !request.sawAnswer && !snapshot.answer) {
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
      if (idleForMs > 8000) {
        finishRequest(request, new Error('ChatGPT generation stopped, but no assistant response was found after the submitted user turn.'));
        return;
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
      finishRequest(request, new Error(`CONVERSATION_CHANGED: expected ${request.options?.sessionId || 'requested session'}, current ${snapshot.conversationId || 'unknown'}`));
      return;
    }
    if (signals.hasError && !generating && stableForMs >= 1000) {
      finishRequest(request, new Error(`CHATGPT_UI_ERROR: ${snapshot.errorText || 'ChatGPT displayed an error state.'}`));
      return;
    }

    const domCompleted = DOM_PARSER.isCompletedSnapshot(snapshot, conversationIdFromUrl(request.options?.sessionId || '') || String(request.options?.sessionId || ''));
    const artifactSettle = domCompleted ? requiredArtifactPending(request, snapshot, now) : { pending: false, timedOut: false, waitedMs: 0 };
    if (artifactSettle.pending) {
      setRequestPhase(request, 'artifact_settle', { expected: 'zip', waitedMs: artifactSettle.waitedMs, limitMs: artifactSettle.limitMs });
      if (!request.requiredArtifactWaitLogged) {
        request.requiredArtifactWaitLogged = true;
        diagnostic('artifact.required_wait_started', { requestId: request.requestId, waitedMs: artifactSettle.waitedMs, limitMs: artifactSettle.limitMs });
        emitChatEvent(request, 'artifact.required_wait_started', { expected: 'zip', waitedMs: artifactSettle.waitedMs, limitMs: artifactSettle.limitMs });
      }
    } else if (artifactSettle.timedOut && request.requiredArtifactWaitLogged) {
      diagnostic('artifact.required_wait_expired', { requestId: request.requestId, waitedMs: artifactSettle.waitedMs, limitMs: artifactSettle.limitMs });
      emitChatEvent(request, 'artifact.required_wait_expired', { expected: 'zip', waitedMs: artifactSettle.waitedMs, limitMs: artifactSettle.limitMs });
      request.requiredArtifactWaitLogged = false;
    }
    const terminalSettleMs = Math.max(500, Number(request.options?.postStopTerminalSettleMs) || CONFIG.postStopTerminalSettleMs);
    if (signals.terminalMarkerVisible && !request.terminalCandidateSince) request.terminalCandidateSince = now;
    if (!signals.terminalMarkerVisible) request.terminalCandidateSince = 0;
    const terminalSettled = signals.terminalMarkerVisible && (now - (request.terminalCandidateSince || now)) >= terminalSettleMs;
    const continuationDeferred = shouldDeferFinalizationForSteer(request, snapshot, signals, now);
    const requiredStableMs = request.networkDone ? doneSettleMs : answerSettleMs;
    const doneByDom = oldEnough
      && hasOutput
      && domCompleted
      && !artifactSettle.pending
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
        finalizationConfidence: signals.finalizationConfidence,
      });
      setRequestPhase(request, 'final_snapshot_ready', {
        reason: doneByNetwork ? 'done.by_network' : 'done.by_dom',
        stableForMs,
        generationIdleForMs,
        domPhase: snapshot.phase || '',
        finalizationConfidence: signals.finalizationConfidence,
      });
      finishRequest(request, null, request.lastAnswer);
    }
    } finally {
      request.collecting = false;
    }
  }

  function finishRequest(request, err, answer = '') {
    if (!request || request.finished) return;
    request.finished = true;

    try { request.observer?.disconnect(); } catch {}
    if (request.pollTimer) clearInterval(request.pollTimer);
    if (request.collectTimer) clearTimeout(request.collectTimer);
    if (request.finishTimer) clearTimeout(request.finishTimer);
    if (activeRequest === request) {
      activeRequest = null;
      schedulePageStatus('page.changed', 0);
    }

    if (err) {
      request.phase = 'failed';
      diagnostic('request.error', { requestId: request.requestId, message: err.message || String(err) });
      send({ type: 'error', requestId: request.requestId, message: err.message || String(err) });
      return;
    }

    const finalSnapshot = readAssistantSnapshot(request);
    const finalAnswer = finalSnapshot.answer || answer || request.lastAnswer || '';
    const reasoningHistory = Array.isArray(request.reasoningHistory) ? request.reasoningHistory : [];
    const finalThinking = finalSnapshot.thinking || '';
    const finalProgress = finalSnapshot.progress || '';
    const finalArtifacts = finalSnapshot.artifacts.length ? finalSnapshot.artifacts : request.artifacts;
    const session = getCurrentSession();

    if (finalAnswer && finalAnswer !== request.lastAnswer) send({ type: 'answer.snapshot', requestId: request.requestId, text: finalAnswer });
    if (finalThinking !== request.lastThinking) send({ type: 'thinking.snapshot', requestId: request.requestId, text: finalThinking });
    const finalProgressItemsFingerprint = JSON.stringify((finalSnapshot.progressItems || []).map((item) => [item.id || item.key || '', item.revision || 0, item.state || '', item.text || '', item.visible ? 'visible' : 'hidden']));
    if (finalProgress !== request.lastProgressText || finalProgressItemsFingerprint !== request.lastProgressItemsFingerprint) {
      send({ type: 'assistant.progress.snapshot', requestId: request.requestId, text: finalProgress, items: finalSnapshot.progressItems || [], kind: 'visible_progress', assistantTurnKey: finalSnapshot.turnKey || '' });
    }
    if (JSON.stringify(finalArtifacts) !== JSON.stringify(request.artifacts)) send({ type: 'artifact.snapshot', requestId: request.requestId, artifacts: finalArtifacts });

    request.phase = 'final_snapshot_ready';
    emitRequestProgress(request, finalSnapshot, false, 'request.done', { force: true, allowFinished: true, anchorConfidence: finalSnapshot.turnKey ? 'high' : 'low', anchorReason: finalSnapshot.reason || '' });
    diagnostic('request.done', { requestId: request.requestId, answerLength: finalAnswer.length, thinkingLength: finalThinking.length, progressLength: finalProgress.length, artifacts: finalArtifacts.length, session, turnKey: finalSnapshot.turnKey || '', turnIndex: finalSnapshot.turnIndex ?? -1, messageId: finalSnapshot.messageId || '', modelSlug: finalSnapshot.modelSlug || '', domPhase: finalSnapshot.phase || '', format: finalSnapshot.format || '' });
    send({ type: 'done', requestId: request.requestId, answer: finalAnswer, thinking: finalThinking, reasoningHistory, progress: finalProgress, progressItems: finalSnapshot.progressItems || [], responseBlocks: finalSnapshot.responseBlocks || [], codeBlocks: finalSnapshot.codeBlocks || [], codeBlockDiagnostics: finalSnapshot.codeBlockDiagnostics || [], parserAudit: finalSnapshot.parserAudit || null, artifacts: finalArtifacts, session, url: location.href, title: document.title, finishReason: 'stop', turnKey: finalSnapshot.turnKey || '', turnIndex: finalSnapshot.turnIndex ?? -1, messageId: finalSnapshot.messageId || '', modelSlug: finalSnapshot.modelSlug || '', domPhase: finalSnapshot.phase || '', format: finalSnapshot.format || '', reason: finalSnapshot.reason || '' });
  }

  function getTurnNodes() {
    const selectors = [
      '[data-testid^="conversation-turn-"][data-turn]',
      'section[data-turn][data-turn-id]',
      'main section[data-turn]',
      '[role="main"] section[data-turn]',
    ];
    const seen = new Set();
    const turns = [];
    for (const selector of selectors) {
      for (const turn of Array.from(document.querySelectorAll(selector))) {
        if (seen.has(turn)) continue;
        seen.add(turn);
        turns.push(turn);
      }
    }
    return turns.sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function isCredibleFinalAssistantNode(node) {
    if (!node?.matches?.('[data-message-author-role="assistant"]')) return false;
    if (node.getAttribute?.('data-message-id')) return true;
    if (node.getAttribute?.('data-message-model-slug')) return true;
    if (node.hasAttribute?.('data-turn-start-message')) return true;
    if (node.matches?.('.markdown') || node.querySelector?.('.markdown, [data-start][data-end], pre, code')) return true;
    return false;
  }

  function getFinalAssistantNode(root) {
    if (!root) return null;
    if (isCredibleFinalAssistantNode(root)) return root;
    return Array.from(root.querySelectorAll?.('[data-message-author-role="assistant"]') || []).find(isCredibleFinalAssistantNode) || null;
  }

  function turnKey(turn, index = -1) {
    if (!turn) return '';
    const finalNode = getFinalAssistantNode(turn);
    return turn.getAttribute?.('data-turn-id')
      || finalNode?.getAttribute?.('data-message-id')
      || turn.getAttribute?.('data-message-id')
      || turn.getAttribute?.('data-testid')
      || turn.getAttribute?.('data-turn-id-container')
      || (index >= 0 ? `turn-index-${index}` : '');
  }

  function turnRole(turn) {
    if (!turn) return '';
    const direct = turn.getAttribute?.('data-turn');
    if (direct) return direct;
    const msg = turn.querySelector?.('[data-message-author-role]');
    return msg?.getAttribute('data-message-author-role') || turn.getAttribute?.('data-message-author-role') || '';
  }

  function getAssistantNodes() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function getAssistantNodeFromTurn(turn) {
    if (!turn) return null;
    if (turnRole(turn) === 'assistant') return turn;
    return getFinalAssistantNode(turn);
  }

  function requestTurnRecords() {
    return getTurnNodes().map((turn, index) => ({
      turn,
      index,
      key: turnKey(turn, index),
      role: turnRole(turn),
      text: visibleText(turn),
    }));
  }

  function resetAssistantAnchorAfterSteer(request, candidate) {
    const previousAssistantTurnKey = request.assistantTurnKey || '';
    request.assistantTurnKey = '';
    request.assistantTurnIndex = -1;
    request.assistantTurnLogged = false;
    request.assistantTurnMissingLogged = false;
    request.lastDomSignature = '';
    request.lastVisibleThinking = '';
    request.lastProgressText = '';
    request.lastProgressItemsFingerprint = '';
    request.lastAnswer = '';
    request.sawAnswer = false;
    request.lastArtifactsFingerprint = '';
    request.artifacts = [];
    request.stableSince = Date.now();
    request.lastSnapshotChangedAt = Date.now();
    request.generationIdleSince = 0;
    request.generationStoppedSent = false;
    request.terminalCandidateSince = 0;
    request.steerWaitStartedAt = 0;
    request.steerWaitExpiredAt = 0;
    diagnostic('steer.turn.reanchored', {
      requestId: request.requestId,
      submittedUserTurnKey: candidate.key,
      submittedUserTurnIndex: candidate.index,
      previousAssistantTurnKey,
    });
    emitChatEvent(request, 'steer.turn.reanchored', {
      submittedUserTurnKey: candidate.key,
      submittedUserTurnIndex: candidate.index,
      previousAssistantTurnKey,
    });
  }

  function adoptSubmittedUserTurn(request, baselineTurnKeys, { kind = 'prompt', replace = false } = {}) {
    if (!request || (!replace && request.submittedUserTurnKey)) return null;
    const records = requestTurnRecords();
    const baseline = baselineTurnKeys instanceof Set ? baselineTurnKeys : new Set(baselineTurnKeys || []);
    const expectedText = String(request.pendingSubmittedTurnExpectedText || '');
    const candidate = DOM_PARSER.selectLatestMatchingNewTurnRecord(records, baseline, 'user', expectedText);
    if (!candidate) {
      const unmatched = records.filter((record) => record?.key && record.role === 'user' && !baseline.has(record.key));
      if (unmatched.length && expectedText) {
        const mismatchSignature = unmatched.map((record) => `${record.key}:${simpleHash(record.text || '')}`).join('|');
        if (mismatchSignature !== request.lastUserTurnMismatchSignature) {
          request.lastUserTurnMismatchSignature = mismatchSignature;
          diagnostic(`${kind}.user_turn_text_mismatch`, {
            requestId: request.requestId,
            expectedTextHash: simpleHash(expectedText),
            candidates: unmatched.map((record) => ({ key: record.key, index: record.index, textHash: simpleHash(record.text || ''), textLength: String(record.text || '').length })),
          });
        }
      }
      return null;
    }
    const previousSubmittedUserTurnKey = request.submittedUserTurnKey || '';
    const changed = candidate.key !== previousSubmittedUserTurnKey;
    request.submittedUserTurnKey = candidate.key;
    request.submittedUserTurnIndex = candidate.index;
    request.pendingSubmittedTurnBaseline = null;
    request.pendingSubmittedTurnKind = '';
    request.pendingSubmittedTurnExpectedText = '';
    request.lastUserTurnMismatchSignature = '';

    if (kind === 'steer' && changed) resetAssistantAnchorAfterSteer(request, candidate);

    const eventName = kind === 'steer' ? 'steer_user_turn.captured' : 'submitted_user_turn.captured';
    diagnostic(eventName, {
      requestId: request.requestId,
      turnKey: candidate.key,
      turnIndex: candidate.index,
      textLength: candidate.text.length,
      textHash: simpleHash(candidate.text),
      promptHash: request.promptHash || '',
      previousSubmittedUserTurnKey,
    });
    emitChatEvent(request, kind === 'steer' ? 'steer_user_turn.captured' : 'user_turn.captured', {
      turnKey: candidate.key,
      turnIndex: candidate.index,
      textLength: candidate.text.length,
      textHash: simpleHash(candidate.text),
      promptHash: request.promptHash || '',
      previousSubmittedUserTurnKey,
    });
    setRequestPhase(request, 'waiting_for_assistant_turn', {
      submittedUserTurnKey: candidate.key,
      submittedUserTurnIndex: candidate.index,
      reanchoredAfterSteer: kind === 'steer',
    });
    return candidate;
  }

  async function waitForSubmittedUserTurnAnchor(request, baselineTurnKeys, { kind = 'prompt', replace = false, timeoutMs = 5_000 } = {}) {
    const baseline = baselineTurnKeys instanceof Set ? baselineTurnKeys : new Set(baselineTurnKeys || []);
    const alreadyCaptured = () => {
      const key = String(request?.submittedUserTurnKey || '');
      if (!key || baseline.has(key)) return null;
      return { key, index: request.submittedUserTurnIndex, reason: 'already_captured_by_dom_monitor' };
    };
    const started = Date.now();
    diagnostic(`${kind}.user_turn_anchor_wait.started`, {
      requestId: request?.requestId || '',
      timeoutMs,
      baselineCount: baseline.size,
      expectedTextHash: simpleHash(String(request?.pendingSubmittedTurnExpectedText || '')),
    });
    while (Date.now() - started < timeoutMs) {
      const existing = alreadyCaptured();
      if (existing) return existing;
      const candidate = adoptSubmittedUserTurn(request, baseline, { kind, replace });
      if (candidate) return candidate;
      await delay(100);
    }
    diagnostic(`${kind}.user_turn_anchor_pending`, {
      requestId: request?.requestId || '',
      timeoutMs,
      turnCount: getTurnNodes().length,
    });
    return null;
  }

  function refreshRequestTurnAnchors(request) {
    if (!request || !request.turnCaptureArmed) return;
    if (request.pendingSubmittedTurnBaseline) {
      const candidate = adoptSubmittedUserTurn(request, request.pendingSubmittedTurnBaseline, {
        kind: request.pendingSubmittedTurnKind || 'steer',
        replace: true,
      });
      if (candidate) return;
    }
    if (request.submittedUserTurnKey) return;
    const baseline = request.baselineTurnKeys instanceof Set ? request.baselineTurnKeys : new Set();
    adoptSubmittedUserTurn(request, baseline, { kind: 'prompt', replace: false });
  }

  function findAssistantTurnAfterSubmittedUser(request) {
    const records = requestTurnRecords();
    if (!records.length) return { node: null, turns: [], reason: 'no_turns' };
    if (!request?.submittedUserTurnKey) return { node: null, turns: records.map((record) => record.turn), reason: 'no_submitted_user_turn' };

    const selectedRecord = DOM_PARSER.selectFirstTurnAfterRecord(records, request.submittedUserTurnKey, 'assistant');
    const turns = records.map((record) => record.turn);
    if (!selectedRecord) {
      const startIndex = records.findIndex((record) => record.key === request.submittedUserTurnKey);
      return {
        node: null,
        turns,
        reason: startIndex < 0 ? 'submitted_user_turn_not_found' : 'no_assistant_turn_after_submitted_user',
        startIndex,
      };
    }
    const node = getAssistantNodeFromTurn(selectedRecord.turn);
    if (!node) return { node: null, turns, reason: 'assistant_turn_has_no_node', startIndex: selectedRecord.index };
    return {
      node,
      turn: selectedRecord.turn,
      turns,
      index: selectedRecord.index,
      key: selectedRecord.key,
      reason: 'selected_after_submitted_user',
    };
  }

  function findAssistantTurns(limit = 5) {
    const turns = getTurnNodes();
    const all = [];
    const seenNodes = new Set();
    const seenKeys = new Set();
    const scanLimit = Math.max(Number(limit) || 5, 40);
    const pushCandidate = (candidate) => {
      if (!candidate?.node || seenNodes.has(candidate.node)) return;
      const key = candidate.key || turnKey(candidate.turn, candidate.index) || candidate.node.getAttribute('data-message-id') || '';
      const nodeKey = key || `node-${all.length}`;
      if (seenKeys.has(nodeKey)) return;
      seenNodes.add(candidate.node);
      seenKeys.add(nodeKey);
      all.push({ ...candidate, key });
    };

    for (let index = turns.length - 1; index >= 0 && all.length < scanLimit; index -= 1) {
      const turn = turns[index];
      if (turnRole(turn) !== 'assistant') continue;
      const node = getAssistantNodeFromTurn(turn);
      pushCandidate({ node, turn, turns, index, key: turnKey(turn, index), reason: 'assistant_turn' });
    }

    // ChatGPT sometimes virtualizes turns or exposes assistant-message roots
    // without a matching visible conversation-turn section. Recovery should scan
    // those too, otherwise downloadable action buttons inside the latest answer
    // may be missed. Keep DOM order, but do not stop at the display limit: older
    // visible answers can contain artifact action buttons while newer turns are
    // only progress/thinking notes.
    const nodes = getAssistantNodes();
    for (let index = nodes.length - 1; index >= 0 && all.length < scanLimit; index -= 1) {
      const node = nodes[index];
      const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
      pushCandidate({
        node,
        turn: containingTurn,
        turns,
        index: containingTurn ? turns.indexOf(containingTurn) : -1,
        key: containingTurn ? turnKey(containingTurn, turns.indexOf(containingTurn)) : node.getAttribute('data-message-id') || '',
        reason: containingTurn ? 'assistant_node_turn_fallback' : 'assistant_node_fallback',
      });
    }

    // Last-resort artifact scan for markdown blocks that include artifact action
    // buttons but are not nested under a detected assistant node. This keeps
    // recovery useful after DOM churn or partial virtualization. Do this even if
    // the normal assistant-turn scan already found enough textual candidates.
    let artifactFallbacks = 0;
    for (const node of Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .markdown, [data-message-author-role="assistant"] .markdown')).reverse()) {
      if (artifactFallbacks >= 20) break;
      if (!collectArtifactsFromNode(node, { reason: 'artifact_scan' }).length) continue;
      artifactFallbacks += 1;
      const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
      const turnIndex = containingTurn ? turns.indexOf(containingTurn) : -1;
      pushCandidate({
        node,
        turn: containingTurn,
        turns,
        index: turnIndex,
        key: containingTurn ? turnKey(containingTurn, turnIndex) : node.getAttribute('data-message-id') || `artifact-${simpleHash(visibleText(node))}`,
        reason: containingTurn ? 'artifact_turn_fallback' : 'artifact_markdown_fallback',
      });
    }
    return all;
  }

  function isMeaningfulRecoverySnapshot(snapshot) {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.artifacts) && snapshot.artifacts.length) return true;
    // Recovery candidates must be actual assistant output. A transient
    // reasoning/tool snapshot is useful diagnostics, but it is not a response
    // that can safely replace the normal result pipeline.
    const answer = normalizeText(snapshot.answer || '');
    if (!answer) return false;
    if (/^(thinking|think|thinking stopped|thinking остановлено|остановлено|мысли остановлены)$/i.test(answer)) return false;
    return true;
  }

  function readSnapshotForCandidate(selected, candidateIndex = 1) {
    if (!selected?.node) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: getAssistantNodes().length, turnCount: selected?.turns?.length || 0, format: 'none', artifacts: [], reason: selected?.reason || 'no_assistant_node', candidateIndex };
    const snapshot = readAssistantNodeSnapshot(selected.node, { count: getAssistantNodes().length, turnCount: selected.turns.length, reason: selected.reason, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex });
    return { ...snapshot, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex };
  }

  function readRecoverySnapshots(limit = 5) {
    const displayLimit = Math.max(1, Math.min(20, Number(limit) || 5));
    const selected = [];
    const seen = new Set();
    const snapshots = findAssistantTurns(Math.max(displayLimit, 40))
      .map((candidate, index) => readSnapshotForCandidate(candidate, index + 1))
      .filter(isMeaningfulRecoverySnapshot);

    const add = (snapshot) => {
      const key = snapshot.turnKey || `${snapshot.reason}:${snapshot.answerLength || snapshot.answer?.length || 0}:${snapshot.artifactCount || snapshot.artifacts?.length || 0}:${simpleHash(snapshot.answer || snapshot.raw || '')}`;
      if (seen.has(key)) return;
      seen.add(key);
      selected.push({ ...snapshot, candidateIndex: selected.length + 1 });
    };

    // Keep recent useful assistant messages first.
    for (const snapshot of snapshots) {
      if (selected.length >= displayLimit) break;
      add(snapshot);
    }

    // Always include visible artifact-bearing messages if they were not among
    // the first displayLimit responses. This is the important recovery path for
    // inline buttons like “скачать обновлённый ZIP”.
    for (const snapshot of snapshots) {
      if (!Array.isArray(snapshot.artifacts) || !snapshot.artifacts.length) continue;
      add(snapshot);
      if (selected.length >= Math.max(displayLimit, 12)) break;
    }

    return selected;
  }

  function findLatestAssistantTurn(index = 1) {
    const snapshots = readRecoverySnapshots(Math.max(10, Number(index) || 1));
    const snapshot = snapshots[Math.max(0, (Number(index) || 1) - 1)];
    if (snapshot) return snapshot;
    return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: getAssistantNodes().length, turnCount: getTurnNodes().length, format: 'none', artifacts: [], reason: 'no_assistant_node', turnKey: '', turnIndex: -1, candidateIndex: Number(index) || 1 };
  }

  function readLatestAssistantSnapshot(index = 1) {
    return findLatestAssistantTurn(index);
  }

  function readAssistantSnapshotByTurnKey(key = '') {
    const expectedKey = String(key || '');
    if (!expectedKey) return null;
    const turns = getTurnNodes();
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turnKey(turn, index) !== expectedKey) continue;
      const node = getAssistantNodeFromTurn(turn);
      if (!node) return null;
      return readAssistantNodeSnapshot(node, { turnCount: turns.length, reason: 'turn_key_recovery', turnKey: expectedKey, turnIndex: index });
    }
    const node = getAssistantNodes().find((item) => item.getAttribute('data-message-id') === expectedKey);
    if (!node) return null;
    return readAssistantNodeSnapshot(node, { count: getAssistantNodes().length, turnCount: turns.length, reason: 'turn_key_node_recovery', turnKey: expectedKey, turnIndex: -1 });
  }

  function readRecentAssistantSnapshots(limit = 5) {
    return readRecoverySnapshots(limit);
  }

  function readAssistantSnapshot(requestOrBaseline) {
    if (requestOrBaseline && typeof requestOrBaseline === 'object') {
      const request = requestOrBaseline;
      const selected = findAssistantTurnAfterSubmittedUser(request);
      if (selected.node) return readAssistantNodeSnapshot(selected.node, { turnCount: selected.turns.length, reason: selected.reason, turnKey: selected.key || '', turnIndex: selected.index ?? -1 });

      // Before the submitted user turn is visible, do not fall back to an older
      // assistant response. Virtualized ChatGPT DOM can reorder text and keeps
      // old assistant nodes around; old fallbacks caused stale answers and hangs.
      const nodes = getAssistantNodes();
      return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: selected.reason, turnCount: selected.turns.length };
    }

    const nodes = getAssistantNodes();
    if (!nodes.length) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: 0, format: 'none', artifacts: [], reason: 'no_nodes' };
    const safeBaselineCount = Math.max(0, Number(requestOrBaseline) || 0);
    if (nodes.length <= safeBaselineCount) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'baseline_not_exceeded' };
    const candidateNodes = nodes.slice(safeBaselineCount);
    const node = candidateNodes[candidateNodes.length - 1];
    if (!node) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'no_candidate' };
    return readAssistantNodeSnapshot(node, { count: nodes.length, reason: 'baseline_candidate' });
  }

  function directChildContaining(parent, descendant) {
    if (!parent || !descendant) return null;
    return Array.from(parent.children || []).find((child) => child === descendant || child.contains?.(descendant)) || null;
  }

  function isMeaningfulVisibleElement(element) {
    if (!element || !isVisible(element)) return false;
    if (element.matches?.('script, style, noscript')) return false;
    if (element.matches?.('[data-testid="copy-turn-action-button"]')) return false;
    if (element.matches?.('[data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
    if (element.matches?.('[role="group"][aria-label]')) {
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-testid') || ''}`;
      if (/action|response|message|действ|ответ/i.test(label)) return false;
    }
    if (!element.querySelector?.('[data-message-author-role="assistant"]')
      && element.querySelector?.('[data-testid="copy-turn-action-button"]')) return false;
    const text = visibleText(element);
    return Boolean(text || element.querySelector?.('pre, code, img, a[href], button, [role="status"], [aria-live], [data-testid^="cot-v5-"]'));
  }

  function findMessageStack(turn, finalNode) {
    if (!turn || !finalNode) return { stack: turn || finalNode, finalBranch: finalNode };
    let branch = finalNode;
    let parent = finalNode.parentElement;
    while (parent && (parent === turn || turn.contains?.(parent))) {
      const finalBranch = directChildContaining(parent, finalNode) || branch;
      const children = Array.from(parent.children || []).filter(isMeaningfulVisibleElement);
      const finalIndex = children.indexOf(finalBranch);
      if (finalIndex > 0) return { stack: parent, finalBranch };
      if (parent === turn) break;
      branch = parent;
      parent = parent.parentElement;
    }
    return { stack: finalNode.parentElement || turn, finalBranch: finalNode };
  }

  function findTemporaryMessageStack(turn) {
    if (!turn) return null;
    let current = turn;
    for (let depth = 0; depth < 8; depth += 1) {
      const children = Array.from(current.children || []).filter(isMeaningfulVisibleElement);
      if (children.length !== 1) break;
      const child = children[0];
      if (child.matches?.('[data-testid^="cot-v5-"], [role="status"], [aria-live], pre, code')) break;
      current = child;
    }
    return current;
  }

  function blockTestIds(element) {
    if (!element) return [];
    const ids = [];
    const own = element.getAttribute?.('data-testid');
    if (own) ids.push(own);
    for (const child of Array.from(element.querySelectorAll?.('[data-testid]') || [])) {
      const value = child.getAttribute('data-testid');
      if (value) ids.push(value);
    }
    return Array.from(new Set(ids)).slice(0, 40);
  }

  function blockIsActive(element) {
    if (!element) return false;
    const activeSelector = [
      '[aria-busy="true"]',
      '[data-state="loading"]',
      '[data-state="running"]',
      '[data-state="pending"]',
      '[data-state="streaming"]',
      '[data-status="running"]',
      '[data-status="pending"]',
    ].join(',');
    if (element.matches?.(activeSelector) || element.querySelector?.(activeSelector)) return true;
    if (element.matches?.('[role="progressbar"]') || element.querySelector?.('[role="progressbar"]')) return true;
    const testIdSignal = blockTestIds(element).join(' ');
    if (/spinner|loading|running|pending|streaming|progress/i.test(testIdSignal)) return true;

    // Text is only a fallback for compact status labels. Tool source/output can
    // legitimately contain words such as "running" and must not keep a
    // completed turn permanently active.
    const hasCode = Boolean(element.matches?.('pre, code') || element.querySelector?.('pre, code'));
    const text = normalizeText(visibleText(element));
    const signal = `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('data-state') || ''} ${text}`;
    return !hasCode
      && text.length <= 180
      && /^(?:running|working|processing|loading|in progress|выполняется|обрабатывается|загрузка)(?:\b|\s|[.…])/i.test(normalizeText(signal));
  }

  function thinkingNodeToken(element) {
    if (!element) return '';
    let token = thinkingNodeTokens.get(element);
    if (!token) {
      token = `node-${thinkingNodeTokenSequence++}`;
      thinkingNodeTokens.set(element, token);
    }
    return token;
  }

  function hasClassToken(element, token) {
    return Boolean(element?.classList?.contains?.(token));
  }

  function isThinkingUiExcluded(element) {
    if (!element) return true;
    if (element.closest?.('form, [data-testid*="composer" i], pre, code, [data-testid="webpage-citation-pill"]')) return true;
    if (element.closest?.('[data-testid="copy-turn-action-button"], [data-testid*="turn-action" i], [data-testid*="message-action" i], [role="group"][aria-label*="action" i]')) return true;
    if (element.closest?.('[data-testid*="artifact" i], [data-testid*="file" i]')) return true;
    const interactive = element.closest?.('button, [role="button"], a[href]');
    if (interactive && !interactive.querySelector?.('[data-testid^="cot-v5-"]')) {
      const signal = buttonSignalText(interactive);
      if (/copy|download|save|open file|regenerate|retry|share|копир|скач|сохран|открыть файл|повтор|поделиться/i.test(signal)) return true;
    }
    return false;
  }

  function nearestThinkingScope(element, turn) {
    let current = element;
    while (current && current !== turn) {
      if (current.hasAttribute?.('data-start') && current.hasAttribute?.('data-end')) return current;
      if (current.hasAttribute?.('data-item-anchor') || current.hasAttribute?.('data-transition-position')) return current;
      const testId = current.getAttribute?.('data-testid') || '';
      if (testId && !/^cot-v5-(?:tool-icon-pile|native-tool-icon)$/i.test(testId)) return current;
      current = current.parentElement;
    }
    return element;
  }

  function thinkingStructuralHint(element, turn, ordinal = 0) {
    const scope = nearestThinkingScope(element, turn);
    const attributes = [
      scope?.getAttribute?.('data-testid') || '',
      scope?.getAttribute?.('data-start') || '',
      scope?.getAttribute?.('data-end') || '',
      scope?.getAttribute?.('data-item-anchor') || '',
      scope?.getAttribute?.('data-transition-position') || '',
      scope?.getAttribute?.('role') || '',
      scope?.tagName?.toLowerCase?.() || '',
    ].filter(Boolean).join('|');
    return `${attributes || 'thinking-slot'}:${ordinal}`;
  }

  function thinkingLabelText(element) {
    if (!element) return '';
    const clone = element.cloneNode?.(true);
    if (!clone) return visibleText(element);
    for (const excluded of Array.from(clone.querySelectorAll?.('[data-testid^="cot-v5-"], svg, [aria-hidden="true"], .sr-only') || [])) excluded.remove();
    return normalizeText(clone.innerText || clone.textContent || '');
  }

  function isReasoningTransitionContext(element, turn, finalNode) {
    if (!element || !turn?.contains?.(element)) return false;
    if (hasClassToken(element, 'loading-shimmer-tertiary')) return true;
    if (element.querySelector?.('[data-testid^="cot-v5-"]') || element.closest?.('[data-testid^="cot-v5-"]')) return true;
    const transition = element.closest?.('[data-item-anchor], [data-transition-position]');
    if (!transition || !turn.contains(transition)) return false;
    if (!hasClassToken(element, 'text-token-text-tertiary') && !element.querySelector?.('.text-token-text-tertiary')) return false;
    if (finalNode && !finalNode.contains(element)) {
      const { stack, finalBranch } = findMessageStack(turn, finalNode);
      const children = Array.from(stack?.children || []);
      const elementBranch = directChildContaining(stack, element);
      return elementBranch && finalBranch && children.indexOf(elementBranch) < children.indexOf(finalBranch);
    }
    return true;
  }

  function collectExplicitThinkingCandidates(turn, finalNode) {
    if (!turn?.querySelectorAll) return [];
    const roots = [];
    const add = (element) => {
      if (!element || !isVisible(element) || isThinkingUiExcluded(element)) return;
      if (!turn.contains(element)) return;
      if (roots.some((root) => root === element || root.contains?.(element))) return;
      for (let index = roots.length - 1; index >= 0; index -= 1) {
        if (element.contains?.(roots[index])) roots.splice(index, 1);
      }
      roots.push(element);
    };

    for (const element of Array.from(turn.querySelectorAll('.loading-shimmer-tertiary'))) add(element);
    for (const marker of Array.from(turn.querySelectorAll('[data-testid^="cot-v5-"]'))) {
      add(marker.closest?.('button, [role="button"]') || marker.parentElement);
    }
    for (const element of Array.from(turn.querySelectorAll('.text-token-text-tertiary'))) {
      if (!isReasoningTransitionContext(element, turn, finalNode)) continue;
      add(element.closest?.('button, [role="button"]') || element);
    }

    return roots.map((element, index) => {
      const text = thinkingLabelText(element);
      const testIds = blockTestIds(element);
      const shimmer = hasClassToken(element, 'loading-shimmer-tertiary') || Boolean(element.querySelector?.('.loading-shimmer-tertiary'));
      const cot = testIds.some((value) => /^cot-v5-/i.test(value));
      const active = shimmer || blockIsActive(element);
      return {
        _element: element,
        _exclusionRoot: nearestThinkingScope(element, turn) || element,
        index,
        text,
        kind: element.querySelector?.('pre, code') ? 'tool_status' : 'thinking',
        active,
        state: active ? 'active' : 'completed',
        nodeToken: thinkingNodeToken(element),
        structuralHint: thinkingStructuralHint(element, turn, index),
        source: cot ? 'cot-v5' : shimmer ? 'loading-shimmer-tertiary' : 'tertiary-transition',
        testIds,
      };
    }).filter((candidate) => candidate.text);
  }

  function thinkingRegistryForTurn(turnId = '') {
    const key = String(turnId || 'unknown-turn');
    if (!thinkingStateByTurn.has(key)) thinkingStateByTurn.set(key, { turnId: key, scan: 0, nextSequence: 1, records: [] });
    while (thinkingStateByTurn.size > 24) thinkingStateByTurn.delete(thinkingStateByTurn.keys().next().value);
    return thinkingStateByTurn.get(key);
  }

  function reconcileThinkingCandidates(turnId, candidates, options = {}) {
    const reconciled = DOM_PARSER.reconcileThinkingBlocks(thinkingRegistryForTurn(turnId), candidates, {
      turnId,
      now: Date.now(),
      finalSeen: Boolean(options.finalSeen),
    });
    thinkingStateByTurn.set(String(turnId || 'unknown-turn'), reconciled.state);
    return reconciled;
  }

  function readVisibleBlock(element, index, finalNode = null) {
    const final = Boolean(finalNode && (element === finalNode || element.contains?.(finalNode)));
    const textRoot = final ? finalNode : element;
    const text = visibleText(textRoot);
    const testIds = blockTestIds(element);
    const block = {
      index,
      final,
      text,
      testIds,
      role: element.getAttribute?.('role') || '',
      state: element.getAttribute?.('data-state') || null,
      ariaBusy: element.getAttribute?.('aria-busy') || null,
      expanded: element.hasAttribute?.('aria-expanded') ? element.getAttribute('aria-expanded') === 'true' : null,
      hasCode: Boolean(element.matches?.('pre, code') || element.querySelector?.('pre, code')),
      active: !final && blockIsActive(element),
      key: `${testIds[0] || element.tagName || 'block'}:${simpleHash(`${testIds.join('|')}|${text}`)}`,
      nodeToken: thinkingNodeToken(element),
      structuralHint: thinkingStructuralHint(element, element.closest?.('[data-turn]') || null, index),
      _element: element,
    };
    return { ...block, kind: DOM_PARSER.classifyVisibleBlock(block) };
  }

  function readAssistantVisibleBlocks(turn, finalNode) {
    if (!turn) return [];
    const { stack, finalBranch } = finalNode
      ? findMessageStack(turn, finalNode)
      : { stack: findTemporaryMessageStack(turn), finalBranch: null };
    const roots = Array.from(stack?.children || []).filter(isMeaningfulVisibleElement);
    const source = roots.length ? roots : [stack || turn].filter(Boolean);
    const blocks = source.map((element, index) => readVisibleBlock(element, index, finalNode));

    // Some transient reasoning summaries are nested and later replaced wholesale.
    // Capture top-most cot/status nodes even when the temporary stack has only one wrapper.
    if (!finalNode) {
      const markers = Array.from(turn.querySelectorAll?.('[data-testid^="cot-v5-"], [role="status"], [aria-live], [aria-busy="true"]') || [])
        .filter((element) => isMeaningfulVisibleElement(element))
        .filter((element, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains?.(element)));
      for (const marker of markers) {
        if (blocks.some((block) => block.text === visibleText(marker))) continue;
        blocks.push(readVisibleBlock(marker, blocks.length, null));
      }
    }

    const grouped = DOM_PARSER.groupVisibleBlocks(blocks);
    return grouped.filter((block) => block.final || block.text);
  }

  function responseActionBarVisible(turn) {
    if (!turn?.querySelectorAll) return false;
    const copy = Array.from(turn.querySelectorAll('[data-testid="copy-turn-action-button"]')).find(isVisible);
    if (copy) return true;
    return Array.from(turn.querySelectorAll('[role="group"][aria-label], [data-testid*="turn-action" i], [data-testid*="message-action" i]'))
      .some((group) => isVisible(group) && /action|response|message|действ|ответ/i.test(`${group.getAttribute('aria-label') || ''} ${group.getAttribute('data-testid') || ''}`));
  }

  function readConfirmationState(turn) {
    const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || turn || findChatMain();
    if (!root?.querySelectorAll) return false;
    return Array.from(root.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="confirm" i], [data-testid*="approval" i]'))
      .some((element) => {
        if (!isVisible(element)) return false;
        const buttons = Array.from(element.querySelectorAll('button, [role="button"]')).filter(isVisible);
        const text = `${visibleText(element)} ${buttons.map(buttonSignalText).join(' ')}`;
        return buttons.length > 0 && /confirm|allow|approve|continue|разреш|подтверд|одобр/i.test(text);
      });
  }

  function readErrorState(turn) {
    const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || findChatMain() || turn;
    if (!root?.querySelectorAll) return { hasError: false, text: '' };
    const candidate = Array.from(root.querySelectorAll('[role="alert"], [data-testid*="error" i], [data-testid*="rate-limit" i]'))
      .find((element) => {
        if (!isVisible(element)) return false;
        const text = visibleText(element);
        return /error|failed|something went wrong|rate limit|try again|ошиб|не удалось|лимит/i.test(text);
      });
    return { hasError: Boolean(candidate), text: candidate ? visibleText(candidate) : '' };
  }

  function unknownTurnTestIds(turn) {
    if (!turn?.querySelectorAll) return [];
    const known = /^(?:conversation-turn-|cot-v5-|copy-turn-action-button$|webpage-citation-pill$|send-button$|stop-button$|composer-|turn-|message-|artifact|file|download)/i;
    return Array.from(new Set(Array.from(turn.querySelectorAll('[data-testid]'))
      .map((element) => element.getAttribute('data-testid') || '')
      .filter((value) => value && !known.test(value))))
      .slice(0, 40);
  }

  function isCodeBlockChromeElement(element) {
    if (!element || element.closest?.('pre') || element.querySelector?.('pre')) return false;
    const tag = element.tagName?.toLowerCase?.() || '';
    if (/^(?:p|h[1-6]|li|blockquote|table|thead|tbody|tr|td|th)$/.test(tag)) return false;
    let wrapper = element.parentElement;
    let targetPre = null;
    for (let depth = 0; wrapper && depth < 8; depth += 1, wrapper = wrapper.parentElement) {
      const blocks = Array.from(wrapper.querySelectorAll?.('pre') || []);
      if (blocks.length === 1) { targetPre = blocks[0]; break; }
      if (blocks.length > 1 || wrapper.matches?.('.markdown')) break;
    }
    if (!targetPre) return false;
    const relation = element.compareDocumentPosition?.(targetPre) || 0;
    const beforePre = Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    const afterPre = Boolean(relation & Node.DOCUMENT_POSITION_PRECEDING);
    if (!beforePre && !afterPre) return false;
    const text = visibleText(element);
    const signal = `${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''} ${element.getAttribute?.('aria-label') || ''}`;
    const structural = /header|toolbar|code|language|syntax/i.test(signal);
    const action = codeUiActionText(`${text} ${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''}`)
      || Boolean(element.querySelector?.('button, [role="button"]'));
    const languages = DOM_PARSER.codeLanguageLabelsFromText(text);
    return structural || action || (languages.length > 0 && text.length <= 100);
  }

  function extractFinalAnswer(finalNode, excludedRoots = []) {
    if (!finalNode) return { answer: '', format: 'none', responseBlocks: [], codeBlocks: [], codeBlockDiagnostics: [], parserAudit: null };
    const exclusions = (Array.isArray(excludedRoots) ? excludedRoots : []).filter(Boolean);
    const isExcluded = (element) => Boolean(
      exclusions.some((root) => root === element || root.contains?.(element))
      || element?.matches?.('button, [role="button"], [data-testid="copy-turn-action-button"], [data-testid*="turn-action" i]')
      || element?.closest?.('[data-testid*="turn-action" i], [role="group"][aria-label*="action" i]')
      || isCodeBlockChromeElement(element)
    );
    const markdownNodes = [];
    if (finalNode.matches?.('.markdown')) markdownNodes.push(finalNode);
    markdownNodes.push(...Array.from(finalNode.querySelectorAll?.('.markdown') || []));
    const uniqueMarkdownNodes = markdownNodes.filter((element, index, all) => all.indexOf(element) === index && !all.some((other, otherIndex) => otherIndex !== index && other.contains?.(element)));
    const roots = uniqueMarkdownNodes.length ? uniqueMarkdownNodes : [finalNode];
    const parserPasses = new Map(roots.map((root) => [root, createResponseParserPass(root)]));
    const extractedBlocks = roots.flatMap((element) => extractResponseBlocks(element, isExcluded, parserPasses.get(element)))
      .map((block, index) => ({ ...block, index }));
    const codeBlockDiagnostics = extractedBlocks
      .filter((block) => block.type === 'code_block')
      .map((block, codeIndex) => ({ index: block.index, codeIndex, ...(block._languageDiagnostic || {}) }));
    const rootAudits = roots.map((root) => parserAuditForRoot(
      root,
      extractedBlocks.filter((block) => root.contains?.(block._element) || root === block._element),
      isExcluded,
      parserPasses.get(root),
    ));
    const parserAudit = mergeParserAudits(rootAudits);
    const passMetrics = roots
      .map((root) => globalThis.ChatGptResponseParserCore?.parserPassMetrics?.(parserPasses.get(root)))
      .filter(Boolean);
    if (parserAudit && passMetrics.length) {
      parserAudit.performance = {
        roots: passMetrics.length,
        durationMs: Number(passMetrics.reduce((sum, item) => sum + Number(item.durationMs || 0), 0).toFixed(3)),
        maxRootDurationMs: Number(Math.max(...passMetrics.map((item) => Number(item.durationMs || 0))).toFixed(3)),
        computedStyleReads: passMetrics.reduce((sum, item) => sum + Number(item.computedStyleReads || 0), 0),
        visibilityChecks: passMetrics.reduce((sum, item) => sum + Number(item.visibilityChecks || 0), 0),
        visibilityCacheHits: passMetrics.reduce((sum, item) => sum + Number(item.visibilityCacheHits || 0), 0),
        leafWalks: passMetrics.reduce((sum, item) => sum + Number(item.leafWalks || 0), 0),
        ownerCandidateChecks: passMetrics.reduce((sum, item) => sum + Number(item.ownerCandidateChecks || 0), 0),
        ownerCandidatesEnumerated: passMetrics.reduce((sum, item) => sum + Number(item.ownerCandidatesEnumerated || 0), 0),
      };
    }
    const responseBlocks = extractedBlocks.map(({ _languageDiagnostic, _codeInspection, _blockDiagnostic, _element, _ownedLeaves, ...block }) => ({
      ...block,
      ...(block.type === 'code_block' ? { diagnostic: _languageDiagnostic || null } : _blockDiagnostic ? { diagnostic: _blockDiagnostic } : {}),
    }));
    const codeBlocks = responseBlocks.filter((block) => block.type === 'code_block').map((block) => ({
      index: block.index,
      language: block.language || '',
      code: block.code || '',
      markdown: block.markdown || '',
    }));
    const answer = normalizeMarkdown(responseBlocks.map((block) => block.markdown || block.text || '').filter(Boolean).join('\n\n'));
    return {
      answer,
      format: answer ? (uniqueMarkdownNodes.length ? 'markdown' : 'structured') : 'none',
      responseBlocks,
      codeBlocks,
      codeBlockDiagnostics,
      parserAudit,
    };
  }

  function readAssistantNodeSnapshot(node, meta = {}) {
    if (!node) return { answer: '', thinking: '', progress: '', progressItems: [], visibleBlocks: [], raw: '', count: meta.count || 0, turnCount: meta.turnCount || 0, format: 'none', artifacts: [], reason: meta.reason || 'no_node', turnKey: meta.turnKey || '', turnIndex: meta.turnIndex ?? -1, candidateIndex: meta.candidateIndex ?? 0, phase: DOM_PARSER.PHASE.ASSISTANT_PLACEHOLDER, signature: '' };

    const turn = node.closest?.('[data-testid^="conversation-turn-"][data-turn], section[data-turn][data-turn-id], main section[data-turn]')
      || (turnRole(node) === 'assistant' ? node : null);
    const parseRoot = turn || node;
    const finalNode = getFinalAssistantNode(parseRoot);
    const visibleBlocks = readAssistantVisibleBlocks(parseRoot, finalNode);
    const explicitThinking = collectExplicitThinkingCandidates(parseRoot, finalNode);
    const broadNonFinalBlocks = visibleBlocks.filter((block) => block.kind !== 'final').filter((block) => {
      const element = block._element;
      if (!element) return true;
      return !explicitThinking.some((candidate) => {
        const root = candidate._element;
        return root && (root === element || root.contains?.(element) || element.contains?.(root) || normalizeText(candidate.text) === normalizeText(block.text));
      });
    });
    const broadCandidates = broadNonFinalBlocks.map((block, index) => ({
      _element: block._element,
      index: explicitThinking.length + index,
      text: block.text,
      kind: block.kind === 'reasoning-summary' ? 'thinking' : block.kind === 'tool' ? 'tool_status' : block.kind === 'status' ? 'progress' : 'action_status',
      active: Boolean(block.active),
      state: block.active ? 'active' : 'completed',
      nodeToken: block.nodeToken || thinkingNodeToken(block._element),
      structuralHint: block.structuralHint || thinkingStructuralHint(block._element, parseRoot, explicitThinking.length + index),
      source: block.testIds?.join(' ') || block.kind,
      testIds: block.testIds || [],
    })).filter((candidate) => candidate.text && !DOM_PARSER.isAssistantAuthorLabel(candidate.text));
    const logicalTurnKey = meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) || finalNode?.getAttribute?.('data-message-id') || 'assistant-turn';
    const reconciledThinking = reconcileThinkingCandidates(logicalTurnKey, [...explicitThinking, ...broadCandidates], { finalSeen: Boolean(finalNode) });
    const progressItems = reconciledThinking.items;
    const activeProgressItems = progressItems.filter((item) => item.active && item.visible);
    const thinking = activeProgressItems.filter((item) => item.kind === 'thinking').map((item) => item.text).join('\n');
    const progress = activeProgressItems.filter((item) => item.kind !== 'thinking').map((item) => item.text).join('\n');
    const reasoningHistory = progressItems.filter((item) => item.state === 'completed' && item.kind === 'thinking');
    const artifacts = collectArtifactsForAssistantNode(parseRoot, meta);
    const { answer, format, responseBlocks, codeBlocks, codeBlockDiagnostics, parserAudit } = extractFinalAnswer(finalNode, explicitThinking.map((candidate) => candidate._exclusionRoot || candidate._element));
    const raw = visibleText(parseRoot);
    const stopVisible = Boolean(findStopButton(finalizationControlRoots(activeRequest, { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
    const sendVisible = Boolean(findSendButton(finalizationControlRoots(activeRequest, { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
    const actionBarVisible = responseActionBarVisible(parseRoot);
    const hasActiveTool = progressItems.some((item) => item.kind === 'tool_status' && item.active && item.visible);
    const needsContinue = Boolean(findContinueButton(finalizationControlRoots(activeRequest, { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
    const needsConfirmation = readConfirmationState(parseRoot);
    const errorState = readErrorState(parseRoot);
    const failedArtifacts = artifacts.filter((artifact) => String(artifact.phase || '').toUpperCase() === 'FAILED');
    const artifactErrorText = failedArtifacts.map((artifact) => artifact.errorText || artifact.name || artifact.id).filter(Boolean).join('; ');
    const testIds = blockTestIds(parseRoot);
    const hasReasoningMarker = testIds.some((value) => /^cot-v5-/i.test(value)) || progressItems.some((item) => item.kind === 'thinking');
    const role = turnRole(parseRoot) || 'assistant';
    const phase = DOM_PARSER.classifyTurnPhase({
      role,
      hasFinalNode: Boolean(finalNode),
      stopVisible,
      actionBarVisible,
      hasPriorVisibleBlocks: progressItems.length > 0,
      hasReasoningMarker,
      hasVisibleStatusText: activeProgressItems.some((block) => block.text),
      hasActiveTool,
      needsConfirmation,
      needsContinue,
      hasError: errorState.hasError || failedArtifacts.length > 0,
    });
    if (parserAudit?.coverage) parserAudit.coverage.reasoningLeaves = progressItems.filter((item) => item.kind === 'thinking' && item.text).length;
    if (parserAudit && phase === DOM_PARSER.PHASE.ASSISTANT_FINAL && finalNode) {
      parserAudit.sourceHtml = safeOuterHtml(finalNode, 50_000);
      parserAudit.sourceDomPath = domPathForNode(finalNode, parseRoot);
    }
    const snapshot = {
      answer,
      thinking,
      progress,
      progressItems,
      reasoningHistory,
      visibleBlocks: visibleBlocks.map(({ _element, nodeToken, structuralHint, ...block }) => block),
      raw,
      count: meta.count || getAssistantNodes().length,
      turnCount: meta.turnCount || getTurnNodes().length,
      format,
      responseBlocks,
      codeBlocks,
      codeBlockDiagnostics,
      parserAudit,
      artifacts,
      reason: meta.reason || (finalNode ? 'final_author_node' : 'assistant_turn_without_final'),
      turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) || finalNode?.getAttribute?.('data-message-id') || '',
      turnIndex: meta.turnIndex ?? -1,
      candidateIndex: meta.candidateIndex ?? 0,
      messageId: finalNode?.getAttribute?.('data-message-id') || '',
      modelSlug: finalNode?.getAttribute?.('data-message-model-slug') || '',
      phase,
      stopVisible,
      sendVisible,
      actionBarVisible,
      hasFinalMessage: Boolean(finalNode),
      hasActiveTool,
      needsConfirmation,
      needsContinue,
      hasError: errorState.hasError || failedArtifacts.length > 0,
      errorText: errorState.text || artifactErrorText,
      conversationId: conversationIdFromUrl(location.href) || '',
      unknownTestIds: unknownTurnTestIds(parseRoot),
    };
    snapshot.signature = DOM_PARSER.buildSnapshotSignature(snapshot);
    return snapshot;
  }

  function isZipLikeLabel(text = '') {
    return /\.zip(?:\b|$)|application\/zip|zip archive|архив zip/i.test(String(text || ''));
  }

  function hasStrictArtifactIntent(text = '') {
    const value = String(text || '');
    return isZipLikeLabel(value) || /download|скачать|export|artifact|canvas|sandbox:|archive file|download file|save (?:file|artifact|archive)|сохранить (?:файл|архив)|выгрузить (?:файл|архив)/i.test(value);
  }

  function looksLikeThinkingProgressText(text = '') {
    const value = String(text || '');
    return /thinking|think|reasoning|thought|думаю|размыш|inspect|list|read|scan|upload|prepare|analyz|смотрю|читаю|провер|анализ/i.test(value);
  }

  function collectArtifactsForAssistantNode(node, meta = {}) {
    const scopes = [];
    const addScope = (scope) => {
      if (!scope || scopes.includes(scope)) return;
      scopes.push(scope);
    };
    addScope(node);
    const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
    addScope(containingTurn);
    const effectiveMeta = {
      ...meta,
      turnKey: meta.turnKey || turnKey(containingTurn || node, meta.turnIndex ?? -1),
    };
    // Output files can be children of the final Markdown node or sibling tool
    // result blocks, but the scan must remain inside the owning assistant turn.
    return mergeArtifacts(...scopes.map((scope) => collectArtifactsFromNode(scope, effectiveMeta)));
  }

  function artifactPhaseRank(phase = '') {
    return ({ FAILED: 4, READY: 3, GENERATING: 2, UPLOADING: 1 }[String(phase || '').toUpperCase()] || 0);
  }

  function mergeArtifactRecords(left, right) {
    if (!left) return right;
    if (!right) return left;
    const preferred = artifactPhaseRank(right.phase) >= artifactPhaseRank(left.phase) ? right : left;
    const fallback = preferred === right ? left : right;
    return {
      ...fallback,
      ...preferred,
      url: preferred.url || fallback.url || '',
      downloadUrl: preferred.downloadUrl || fallback.downloadUrl || '',
      src: preferred.src || fallback.src || '',
      selectorHint: preferred.selectorHint || fallback.selectorHint || '',
      actionLabel: preferred.actionLabel || fallback.actionLabel || '',
      downloadable: Boolean(preferred.downloadable || fallback.downloadable),
      downloadActionPresent: Boolean(preferred.downloadActionPresent || fallback.downloadActionPresent),
      rawAttributes: { ...(fallback.rawAttributes || {}), ...(preferred.rawAttributes || {}) },
    };
  }

  function mergeArtifacts(...lists) {
    const byKey = new Map();
    for (const artifact of lists.flat().filter(Boolean)) {
      const key = artifact.id || artifact.downloadUrl || artifact.url || artifact.src || [artifact.kind, artifact.name, artifact.blockStart, artifact.blockEnd, artifact.actionLabel].filter(Boolean).join('|');
      if (!key) continue;
      byKey.set(key, mergeArtifactRecords(byKey.get(key), artifact));
    }
    return [...byKey.values()];
  }

  function queryAllWithSelf(root, selector) {
    if (!root?.querySelectorAll) return [];
    const result = [];
    try {
      if (root.matches?.(selector)) result.push(root);
      result.push(...Array.from(root.querySelectorAll(selector)));
    } catch {
      // Ignore selector incompatibilities in older Chromium builds.
    }
    return result;
  }

  function elementDescriptor(element) {
    if (!element) return '';
    const own = [
      visibleText(element),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('download'),
      element.getAttribute?.('href'),
      element.getAttribute?.('class'),
      element.getAttribute?.('data-state'),
      element.getAttribute?.('aria-busy'),
    ];
    const descendants = Array.from(element.querySelectorAll?.('[aria-label], [title], [data-testid], [data-state], [aria-busy], a[href], [download]') || [])
      .slice(0, 24)
      .flatMap((child) => [child.getAttribute('aria-label'), child.getAttribute('title'), child.getAttribute('data-testid'), child.getAttribute('data-state'), child.getAttribute('aria-busy'), child.getAttribute('download'), child.getAttribute('href')]);
    return normalizeText([...own, ...descendants].filter(Boolean).join(' '));
  }

  function artifactActionSignal(element) {
    if (!element) return '';
    return normalizeText([
      visibleText(element),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('download'),
      element.getAttribute?.('href'),
      element.getAttribute?.('data-state'),
      element.getAttribute?.('aria-busy'),
    ].filter(Boolean).join(' '));
  }

  function isBrowserOnlyArtifactUrl(url = '') {
    const value = String(url || '');
    return /^sandbox:/i.test(value) || /^filesystem:/i.test(value) || /\/mnt\/data\//i.test(value);
  }

  function isExcludedArtifactAction(element) {
    if (!element) return true;
    const signal = artifactActionSignal(element);
    if (/copy|копировать|citation|цитирование кода|share|поделиться|regenerate|повторить ответ/i.test(signal)) return true;
    if (element.closest?.('[data-testid="webpage-citation-pill"], [data-testid="copy-turn-action-button"], [data-testid*="turn-action" i], [role="group"][aria-label*="action" i]')) return true;
    return false;
  }

  function artifactBlockElement(element, root) {
    if (!element) return null;
    const stable = element.closest?.('[data-start][data-end], [data-testid*="artifact" i], [data-testid*="file" i]');
    if (stable && (!root?.contains || root.contains(stable))) return stable;
    const semantic = element.closest?.('p, li, figure');
    if (semantic && (!root?.contains || root.contains(semantic))) return semantic;
    return element.parentElement && (!root?.contains || root.contains(element.parentElement)) ? element.parentElement : element;
  }

  function artifactLocatorMeta(element, root) {
    const block = artifactBlockElement(element, root);
    const actions = block ? queryAllWithSelf(block, 'button, [role="button"], a[href]') : [];
    return {
      blockStart: block?.getAttribute?.('data-start') || '',
      blockEnd: block?.getAttribute?.('data-end') || '',
      blockTestId: block?.getAttribute?.('data-testid') || '',
      blockText: normalizeText(visibleText(block)).slice(0, 500),
      actionOrdinal: Math.max(0, actions.indexOf(element)),
      actionTag: element?.tagName?.toLowerCase?.() || '',
      actionRole: element?.getAttribute?.('role') || '',
      actionTestId: element?.getAttribute?.('data-testid') || '',
      actionAriaLabel: element?.getAttribute?.('aria-label') || '',
    };
  }

  function artifactFileName(element, root, url = '') {
    const namesFrom = (value) => {
      if (!value) return [];
      if (typeof DOM_PARSER.extractFileLikeNames === 'function') return DOM_PARSER.extractFileLikeNames(value);
      const one = DOM_PARSER.extractFileLikeName(value);
      return one ? [one] : [];
    };
    const directSignals = [
      element?.getAttribute?.('download'),
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      visibleText(element),
      guessNameFromUrl(url),
    ].filter(Boolean);
    for (const signal of directSignals) {
      const direct = namesFrom(signal);
      if (direct.length === 1) return direct[0];
      const directZip = direct.find((name) => /\.zip$/i.test(name));
      if (directZip) return directZip;
    }

    const block = artifactBlockElement(element, root);
    const nearby = [];
    if (element?.previousElementSibling) nearby.push(element.previousElementSibling);
    if (element?.nextElementSibling) nearby.push(element.nextElementSibling);
    const parentChildren = Array.from(element?.parentElement?.children || []);
    const ownIndex = parentChildren.indexOf(element);
    if (ownIndex >= 0) {
      for (const distance of [1, 2]) {
        if (parentChildren[ownIndex - distance]) nearby.push(parentChildren[ownIndex - distance]);
        if (parentChildren[ownIndex + distance]) nearby.push(parentChildren[ownIndex + distance]);
      }
    }
    for (const candidateNode of nearby) {
      const candidates = namesFrom(visibleText(candidateNode));
      if (candidates.length === 1) return candidates[0];
    }

    const blockCandidates = namesFrom(visibleText(block));
    if (blockCandidates.length === 1) return blockCandidates[0];
    if (blockCandidates.length > 1) {
      const actionSignal = artifactActionSignal(element);
      const zipCandidate = blockCandidates.find((name) => /\.zip$/i.test(name));
      if (zipCandidate && /zip|archive|архив|bundle|download|скачать/i.test(actionSignal)) return zipCandidate;
    }
    return guessNameFromUrl(url) || '';
  }

  function artifactState(element, root, extra = {}) {
    const block = artifactBlockElement(element, root);
    const busy = element?.getAttribute?.('aria-busy') === 'true' || block?.getAttribute?.('aria-busy') === 'true';
    const progressVisible = Boolean(block?.querySelector?.('[role="progressbar"], [aria-busy="true"]'));
    const disabled = Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true');
    const state = [element?.getAttribute?.('data-state'), block?.getAttribute?.('data-state')].filter(Boolean).join(' ');
    const text = normalizeText(`${artifactActionSignal(element)} ${visibleText(block)}`);
    const phase = DOM_PARSER.classifyArtifactPhase({
      state,
      text,
      busy,
      progressVisible,
      disabled,
      failed: Boolean(extra.failed),
      downloadable: Boolean(extra.downloadable),
      downloadActionPresent: Boolean(extra.downloadActionPresent),
      href: extra.href || '',
    });
    return { phase, state, busy, progressVisible, disabled, text };
  }

  function collectArtifactsFromNode(node, meta = {}) {
    const artifacts = [];
    if (!node?.querySelectorAll) return artifacts;

    const push = (artifact) => {
      const url = artifact.downloadUrl || artifact.url || artifact.src || '';
      const locator = artifact.locator || artifactLocatorMeta(artifact.element || null, node);
      const selectorHint = artifact.selectorHint || actionSelectorHint(artifact.element || null);
      const fileName = artifact.fileName || artifactFileName(artifact.element || null, node, url);
      const name = normalizeText(fileName || artifact.name || artifact.title || artifact.text || guessNameFromUrl(url) || artifact.kind || 'artifact');
      const stateInfo = artifact.stateInfo || artifactState(artifact.element || null, node, {
        downloadable: artifact.downloadable,
        downloadActionPresent: artifact.downloadActionPresent,
        href: url,
        failed: artifact.failed,
      });
      const identity = [artifact.sourceTurnKey || meta.turnKey || '', name, locator.blockStart, locator.blockEnd, locator.blockTestId, artifact.groupOrdinal ?? locator.actionOrdinal, url && !name ? url : ''].join('|');
      const id = artifact.id || `artifact_${simpleHash(identity)}`;
      const { element, locator: ignoredLocator, stateInfo: ignoredState, ...publicArtifact } = artifact;
      const record = {
        id,
        name,
        fileName: name,
        extension: name.includes('.') ? name.split('.').pop().toLowerCase() : '',
        mime: artifact.mime || guessMime(name, url),
        sourceTurnKey: artifact.sourceTurnKey || meta.turnKey || '',
        sourceTurnIndex: artifact.sourceTurnIndex ?? meta.turnIndex ?? -1,
        sourceCandidateIndex: artifact.sourceCandidateIndex ?? meta.candidateIndex ?? 0,
        selectorHint,
        phase: artifact.phase || stateInfo.phase,
        state: artifact.state || stateInfo.state || '',
        progressText: artifact.progressText || (stateInfo.phase === 'GENERATING' ? stateInfo.text.slice(0, 300) : ''),
        errorText: artifact.errorText || (stateInfo.phase === 'FAILED' ? stateInfo.text.slice(0, 300) : ''),
        downloadable: Boolean(artifact.downloadable || url || artifact.downloadActionPresent),
        downloadActionPresent: Boolean(artifact.downloadActionPresent),
        urlMayExpire: Boolean(url && (/^blob:|^data:|^sandbox:|token=|signature=/i.test(url))),
        blockStart: locator.blockStart,
        blockEnd: locator.blockEnd,
        blockTestId: locator.blockTestId,
        blockText: locator.blockText,
        actionOrdinal: locator.actionOrdinal,
        actionTag: locator.actionTag,
        actionRole: locator.actionRole,
        actionTestId: locator.actionTestId,
        actionAriaLabel: locator.actionAriaLabel,
        rawAttributes: {
          href: artifact.element?.getAttribute?.('href') || '',
          download: artifact.element?.getAttribute?.('download') || '',
          ariaLabel: artifact.element?.getAttribute?.('aria-label') || '',
          testId: artifact.element?.getAttribute?.('data-testid') || '',
          state: artifact.element?.getAttribute?.('data-state') || '',
          busy: artifact.element?.getAttribute?.('aria-busy') || '',
        },
        ...publicArtifact,
      };
      const existingIndex = artifacts.findIndex((item) => item.id === id);
      if (existingIndex >= 0) artifacts[existingIndex] = mergeArtifactRecords(artifacts[existingIndex], record);
      else artifacts.push(record);
    };

    for (const anchor of queryAllWithSelf(node, 'a[href]')) {
      if (!isVisible(anchor) || isExcludedArtifactAction(anchor)) continue;
      const href = anchor.href || anchor.getAttribute('href') || '';
      const text = visibleText(anchor);
      const download = anchor.getAttribute('download') || '';
      const descriptor = elementDescriptor(anchor);
      const fileName = artifactFileName(anchor, node, href);
      const inFileCard = Boolean(anchor.closest?.('[data-testid*="file" i], [data-testid*="artifact" i], [download]'));
      const looksDownload = Boolean(
        download
        || href.startsWith('blob:')
        || href.startsWith('data:')
        || isBrowserOnlyArtifactUrl(href)
        || /\/(?:download|files?|artifacts?)(?:\/|\?|$)/i.test(href)
        || hasStrictArtifactIntent(`${download} ${text} ${descriptor}`)
        || (inFileCard && fileName)
      );
      if (!looksDownload) continue;
      push({
        kind: isBrowserOnlyArtifactUrl(href) ? 'action' : 'file',
        url: href,
        downloadUrl: href,
        name: fileName || download || text || guessNameFromUrl(href),
        text,
        actionLabel: text || download || descriptor,
        downloadable: true,
        downloadActionPresent: true,
        element: anchor,
      });
    }

    for (const image of queryAllWithSelf(node, '[data-testid*="generated-image" i] img[src], [data-testid*="artifact" i] img[src], a[download] img[src]')) {
      if (!isVisible(image)) continue;
      const src = image.currentSrc || image.src || image.getAttribute('src') || '';
      if (!src || src.startsWith('data:image/svg')) continue;
      const alt = image.getAttribute('alt') || image.getAttribute('aria-label') || '';
      const rect = image.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      push({ kind: 'image', src, url: src, downloadUrl: src, name: DOM_PARSER.extractFileLikeName(alt) || alt || guessNameFromUrl(src) || 'image', width: Math.round(rect.width), height: Math.round(rect.height), downloadable: true, downloadActionPresent: true, element: image });
    }

    const actionElements = queryAllWithSelf(node, 'button, [role="button"], a[href]');
    for (const action of actionElements) {
      if (!isVisible(action) || isExcludedArtifactAction(action)) continue;
      const label = artifactActionSignal(action);
      const fileName = artifactFileName(action, node, action.href || action.getAttribute?.('href') || '');
      const strictIntent = hasStrictArtifactIntent(label);
      if (!strictIntent && !fileName) continue;
      if (!fileName && looksLikeThinkingProgressText(label)) continue;
      const stateInfo = artifactState(action, node, { downloadActionPresent: true, downloadable: isUsableButton(action) });
      push({
        kind: /canvas/i.test(label) ? 'canvas' : 'action',
        name: fileName || label || 'artifact action',
        text: label,
        actionLabel: label || fileName,
        phase: stateInfo.phase,
        downloadable: stateInfo.phase === 'READY' && isUsableButton(action),
        downloadActionPresent: true,
        stateInfo,
        element: action,
      });
    }

    const stateElements = queryAllWithSelf(node, '[aria-busy="true"], [role="progressbar"], [data-state]');
    for (const element of stateElements) {
      if (!isVisible(element) || isExcludedArtifactAction(element)) continue;
      const lifecycleObserved = DOM_PARSER.isArtifactLifecycleStateDescriptor({
        ariaBusy: element.getAttribute?.('aria-busy') || '',
        role: element.getAttribute?.('role') || '',
        dataState: element.getAttribute?.('data-state') || '',
        testId: element.getAttribute?.('data-testid') || '',
        className: element.getAttribute?.('class') || '',
        tagName: element.tagName || '',
        ownText: visibleText(element),
      });
      if (!lifecycleObserved) continue;
      const fileName = artifactFileName(element, node, '');
      if (!fileName) continue;
      const stateInfo = artifactState(element, node, {});
      if (!['GENERATING', 'FAILED'].includes(stateInfo.phase)) continue;
      push({
        kind: 'file',
        name: fileName,
        text: stateInfo.text,
        phase: stateInfo.phase,
        downloadable: false,
        downloadActionPresent: false,
        lifecycleObserved: true,
        stateInfo,
        element,
      });
    }

    return artifacts;
  }

  function actionSelectorHint(element) {
    if (!element) return '';
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 5; depth += 1, current = current.parentElement) {
      let part = current.tagName.toLowerCase();
      const testId = current.getAttribute('data-testid');
      if (testId) part += `[data-testid="${cssEscape(testId)}"]`;
      const role = current.getAttribute('role');
      if (role) part += `[role="${cssEscape(role)}"]`;
      const cls = Array.from(current.classList || []).filter((item) => /behavior-btn|entity-underline/.test(item)).slice(0, 2);
      if (cls.length) part += cls.map((item) => `.${cssEscape(item)}`).join('');
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function guessNameFromUrl(url) {
    try {
      if (!url || url.startsWith('blob:') || url.startsWith('data:')) return '';
      const parsed = new URL(url, location.href);
      const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last).slice(0, 120);
    } catch { return ''; }
  }

  function guessMime(name, url) {
    const source = `${name || ''} ${url || ''}`.toLowerCase();
    if (/\.png\b|image\/png/.test(source)) return 'image/png';
    if (/\.jpe?g\b|image\/jpe?g/.test(source)) return 'image/jpeg';
    if (/\.webp\b|image\/webp/.test(source)) return 'image/webp';
    if (/\.gif\b|image\/gif/.test(source)) return 'image/gif';
    if (/\.pdf\b|application\/pdf/.test(source)) return 'application/pdf';
    if (/\.csv\b/.test(source)) return 'text/csv';
    if (/\.json\b/.test(source)) return 'application/json';
    if (/\.zip(?:\b|$)|application\/zip|zip archive|архив zip/.test(source)) return 'application/zip';
    if (/\.txt\b/.test(source)) return 'text/plain';
    return 'application/octet-stream';
  }

  function simpleHash(input) {
    let hash = 2166136261;
    const text = String(input || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function findThinkingElements(root) {
    const lowerNeedle = /(thinking|reasoning|thought|дума|думаю|размыш|мысл)/i;
    const statusNeedle = /^(?:thinking|think|думаю|размышляю)\s*(?:\.|…)?$|^(?:thought for|думал|размышлял)\b/i;
    return Array.from(root.querySelectorAll('*')).filter((element) => {
      const attributes = [element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('class'), element.getAttribute('id')].filter(Boolean).join(' ');
      const text = visibleText(element);
      return lowerNeedle.test(attributes) || statusNeedle.test(text);
    });
  }

  function inlineCodeMarkdown(value) {
    const text = String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(1, longestRun + 1));
    const padded = /^(?:\s|`)|(?:\s|`)$/.test(text) && text.trim() ? ` ${text} ` : text;
    return `${fence}${padded}${fence}`;
  }

  function inlineMarkdown(element, context = null) {
    if (!element) return '';
    const preserved = [];
    const preserve = (value) => {
      const index = preserved.push(String(value || '')) - 1;
      return `\uE000${index}\uE001`;
    };
    const render = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) return String(node.textContent || '').replace(/\u00a0/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE || context?.isExcluded?.(node) || !parserElementVisible(node, context?.parserPass || null)) return '';
      const tag = node.tagName?.toLowerCase?.() || '';
      if (tag === 'br') return '\n';
      if (tag === 'code' && node.closest?.('pre') === null) return preserve(inlineCodeMarkdown(node.textContent || ''));
      const inner = Array.from(node.childNodes || []).map(render).join('');
      if (!inner) return '';
      if (tag === 'strong' || tag === 'b') return `**${inner}**`;
      if (tag === 'em' || tag === 'i') return `*${inner}*`;
      if (tag === 'del' || tag === 's') return `~~${inner}~~`;
      if (tag === 'kbd') return preserve(`<kbd>${String(node.textContent || '')}</kbd>`);
      if (tag === 'a') {
        const href = String(node.getAttribute?.('href') || '').trim();
        if (href && !/^javascript:/i.test(href)) return `[${inner}](${href})`;
      }
      return inner;
    };
    let result = render(element)
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    result = result.replace(/\uE000(\d+)\uE001/g, (_match, index) => preserved[Number(index)] || '');
    return result;
  }

  function safeOuterHtml(element, maxLength = 6000) {
    if (!element?.cloneNode) return '';
    try {
      const clone = element.cloneNode(true);
      for (const unwanted of Array.from(clone.querySelectorAll?.('script, style, svg use') || [])) unwanted.remove();
      for (const node of [clone, ...Array.from(clone.querySelectorAll?.('*') || [])]) {
        for (const attr of Array.from(node.attributes || [])) {
          if (!/^(?:id|class|role|title|aria-[\w-]+|data-testid|data-language|data-lang|data-syntax|data-state)$/i.test(attr.name)) node.removeAttribute(attr.name);
        }
      }
      const html = String(clone.outerHTML || '');
      return html.length > maxLength ? `${html.slice(0, maxLength)}…` : html;
    } catch {
      return '';
    }
  }

  function codeUiActionText(value = '') {
    return /(?:copy(?:\s+code)?|copied|run(?:\s+code)?|execute|edit|download|preview|open|save|share|full\s*screen|копировать(?:\s+код)?|скопировано|запустить(?:\s+код)?|выполнить|редактировать|скачать|предпросмотр|открыть|сохранить|поделиться|на\s+весь\s+экран|copiar(?:\s+código)?|copiado|ejecutar(?:\s+código)?|code\s+kopieren|kopiert|code\s+ausführen|ausführen|copier(?:\s+le\s+code)?|copié|exécuter(?:\s+le\s+code)?|executar(?:\s+código)?|copia(?:\s+codice)?|copiato|esegui(?:\s+codice)?|コードをコピー|コピー|実行|코드\s+복사|복사|실행|复制代码|复制|运行代码|运行)/iu.test(String(value || ''));
  }

  function domPathForNode(node, boundary = null) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return '';
    const parts = [];
    for (let current = element, depth = 0; current && current !== boundary && depth < 12; current = current.parentElement, depth += 1) {
      let part = current.tagName?.toLowerCase?.() || 'node';
      const testId = current.getAttribute?.('data-testid');
      const role = current.getAttribute?.('role');
      const id = current.id;
      if (testId) part += `[data-testid="${String(testId).replaceAll('"', '\\"')}"]`;
      else if (id && !/^radix-/i.test(id)) part += `#${cssEscape(id)}`;
      else if (role) part += `[role="${String(role).replaceAll('"', '\\"')}"]`;
      else {
        const classes = Array.from(current.classList || []).filter((value) => /^[a-zA-Z_][\w-]{1,40}$/.test(value)).slice(0, 2);
        if (classes.length) part += classes.map((value) => `.${cssEscape(value)}`).join('');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children || []).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function createResponseParserPass(root) {
    const createPass = globalThis.ChatGptResponseParserCore?.createParserPass;
    return typeof createPass === 'function' ? createPass(root) : null;
  }

  function parserElementVisible(element, pass = null) {
    const sharedVisible = globalThis.ChatGptResponseParserCore?.isVisible;
    if (typeof sharedVisible === 'function') return sharedVisible(element, pass);
    return isVisible(element);
  }

  function visibleTextLeafNodes(root, pass = null) {
    const sharedLeaves = globalThis.ChatGptResponseParserCore?.visibleTextLeafNodes;
    if (typeof sharedLeaves === 'function') return sharedLeaves(root, pass);
    const leaves = [];
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        const text = normalizeText(node.textContent || '');
        if (text && parent && parserElementVisible(parent)) leaves.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName?.toLowerCase?.() || '';
      if (/^(?:script|style|template|noscript)$/.test(tag)) return;
      if (node !== root && !parserElementVisible(node)) return;
      for (const child of Array.from(node.childNodes || [])) visit(child);
    };
    visit(root);
    return leaves;
  }

  function closestWithin(node, selector, boundary) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const match = element?.closest?.(selector) || null;
    return match && boundary?.contains?.(match) ? match : null;
  }

  function describeInterfaceElement(element, boundary, reason = 'interface-control') {
    if (!element) return null;
    return {
      kind: reason,
      tag: element.tagName?.toLowerCase?.() || '',
      role: element.getAttribute?.('role') || '',
      testId: element.getAttribute?.('data-testid') || '',
      ariaLabel: element.getAttribute?.('aria-label') || '',
      title: element.getAttribute?.('title') || '',
      text: normalizeText(visibleText(element)).slice(0, 500),
      domPath: domPathForNode(element, boundary),
    };
  }

  function codeWidgetContentSource(widget) {
    if (!widget) return { element: null, source: 'none' };
    const candidates = Array.from(widget.querySelectorAll?.('code') || []);
    if (!candidates.length && widget.matches?.('code')) candidates.push(widget);
    if (!candidates.length) {
      const editorCandidates = Array.from(widget.querySelectorAll?.('pre, [class*="cm-content" i], [data-code-block-content], [data-testid*="code-content" i]') || [])
        .filter((element) => element !== widget);
      const selectedEditor = editorCandidates.map((element, index) => {
        const signal = `${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('data-code-block-content') || ''}`;
        let score = 0;
        if (/cm-content|readonly|code-content|code-block/i.test(signal)) score += 10_000;
        if (element.matches?.('pre')) score += 2_000;
        score += Math.min(500, domPathForNode(element, widget).split('>').length * 10);
        return { element, index, score };
      }).sort((a, b) => b.score - a.score || a.index - b.index)[0];
      if (selectedEditor?.element) {
        return {
          element: selectedEditor.element,
          editorPre: selectedEditor.element.matches?.('pre') ? selectedEditor.element : selectedEditor.element.closest?.('pre') || null,
          source: /cm-content/i.test(selectedEditor.element.getAttribute?.('class') || '') ? 'codemirror-pre' : 'editor-text',
        };
      }
      return { element: widget, source: 'widget-text', editorPre: widget.matches?.('pre') ? widget : null };
    }
    const scored = candidates.map((element, index) => {
      const editorPre = element.closest?.('pre');
      const signal = `${editorPre?.getAttribute?.('class') || ''} ${element.getAttribute?.('class') || ''} ${element.closest?.('[id*="code-block" i], [class*="cm-editor" i], [class*="code" i]')?.getAttribute?.('class') || ''}`;
      let score = 0;
      if (/cm-content|cm-editor|code-block-viewer|readonly/i.test(signal)) score += 10_000;
      if (editorPre && editorPre !== widget) score += 2_000;
      if (element.parentElement === widget) score += 500;
      score += Math.min(500, domPathForNode(element, widget).split('>').length * 10);
      return { element, index, score, editorPre };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = scored[0];
    return {
      element: selected.element,
      editorPre: selected.editorPre || null,
      source: /cm-content|cm-editor/i.test(`${selected.editorPre?.className || ''} ${selected.element.className || ''}`)
        ? 'codemirror-code'
        : selected.editorPre && selected.editorPre !== widget ? 'nested-pre-code' : 'code-element',
    };
  }

  function codeWidgetInspection(widget, pass = null) {
    const sharedInspection = globalThis.ChatGptResponseParserCore?.inspectCodeWidget?.(widget, pass);
    if (sharedInspection) return sharedInspection;
    const content = codeWidgetContentSource(widget);
    const contentSource = content.element || widget;
    const leaves = visibleTextLeafNodes(widget, pass);
    const contentLeaves = [];
    const interfaceLeaves = [];
    const unknownLeaves = [];
    const languageCandidates = [];
    const interfaceElements = [];
    const seenInterfaceElements = new Set();
    const directLanguageCandidates = [];

    const addDirectLanguage = (element, sourcePrefix, score) => {
      if (!element) return;
      const values = [
        ['data-language', element.getAttribute?.('data-language')],
        ['data-lang', element.getAttribute?.('data-lang')],
        ['data-syntax', element.getAttribute?.('data-syntax')],
        ['aria-label', element.getAttribute?.('aria-label')],
        ['title', element.getAttribute?.('title')],
        ...Array.from(String(element.getAttribute?.('class') || '').matchAll(/(?:^|\s)(?:language|lang)-([\w.+#/-]+)/gi), (match) => ['class', match[1]]),
      ];
      for (const [source, rawValue] of values) {
        for (const language of DOM_PARSER.codeLanguageLabelsFromText(rawValue || '')) {
          directLanguageCandidates.push({
            language,
            source: `${sourcePrefix}-${source}`,
            confidence: 'high',
            score,
            text: String(rawValue || ''),
            domPath: domPathForNode(element, widget),
          });
        }
      }
    };

    addDirectLanguage(contentSource, 'content', 50_000);
    addDirectLanguage(content.editorPre, 'editor-pre', 45_000);
    addDirectLanguage(widget, 'widget', 40_000);

    for (const leaf of leaves) {
      const parent = leaf.parentElement;
      const text = normalizeText(leaf.textContent || '');
      if (!text || !parent) continue;
      if (contentSource === leaf || contentSource?.contains?.(leaf)) {
        contentLeaves.push(leaf);
        continue;
      }
      const actionRoot = closestWithin(leaf, 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [data-testid*="copy" i], [data-testid*="run" i], .cm-gutters, .cm-lineNumbers, [class*="line-number" i]', widget);
      const actionSignal = `${text} ${actionRoot?.getAttribute?.('aria-label') || ''} ${actionRoot?.getAttribute?.('title') || ''}`;
      if (actionRoot || codeUiActionText(actionSignal)) {
        interfaceLeaves.push(leaf);
        const owner = actionRoot || parent;
        if (!seenInterfaceElements.has(owner)) {
          seenInterfaceElements.add(owner);
          const descriptor = describeInterfaceElement(owner, widget, 'code-action');
          if (descriptor) interfaceElements.push(descriptor);
        }
        continue;
      }
      const languages = DOM_PARSER.codeLanguageLabelsFromText(text);
      if (languages.length) {
        const signal = `${parent.getAttribute?.('class') || ''} ${parent.getAttribute?.('data-testid') || ''} ${parent.getAttribute?.('role') || ''}`;
        const headerLike = /header|toolbar|language|syntax|font-medium|select-none|sticky/i.test(signal)
          || Boolean(parent.parentElement?.querySelector?.('button, [role="button"]'));
        let accepted = false;
        for (const language of languages) {
          const known = DOM_PARSER.isKnownCodeLanguageLabel(language);
          if (!known && !headerLike) continue;
          accepted = true;
          languageCandidates.push({
            language,
            source: 'widget-chrome-text',
            confidence: known ? 'high' : 'medium',
            score: (known ? 30_000 : 20_000) + (headerLike ? 2_000 : 0),
            text,
            domPath: domPathForNode(parent, widget),
            _leaf: leaf,
          });
        }
        if (accepted) {
          interfaceLeaves.push(leaf);
          continue;
        }
      }
      unknownLeaves.push(leaf);
    }

    // Include icon-only actions in diagnostics even when they have no text leaf.
    for (const action of Array.from(widget.querySelectorAll?.('button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]') || [])) {
      if (!parserElementVisible(action, pass) || seenInterfaceElements.has(action)) continue;
      seenInterfaceElements.add(action);
      const descriptor = describeInterfaceElement(action, widget, 'code-action');
      if (descriptor) interfaceElements.push(descriptor);
    }

    const ranked = [...directLanguageCandidates, ...languageCandidates]
      .sort((a, b) => b.score - a.score || a.domPath.localeCompare(b.domPath));
    const selected = ranked[0] || null;
    const language = selected?.language || '';
    const warnings = [];
    if (!language) warnings.push('code_language_unresolved');
    else if (selected?.confidence !== 'high') warnings.push('code_language_low_confidence');
    if (unknownLeaves.length) warnings.push('unclassified_code_widget_chrome');

    return {
      language,
      source: selected?.source || 'unresolved',
      confidence: selected?.confidence || 'none',
      selected: selected ? { ...selected, _leaf: undefined } : null,
      candidates: ranked.slice(0, 30).map(({ _leaf, ...candidate }) => candidate),
      contentSource,
      editorPre: content.editorPre || null,
      contentSourceKind: content.source,
      contentLeaves,
      interfaceLeaves,
      unknownLeaves,
      languageLeaves: languageCandidates.map((candidate) => candidate._leaf).filter(Boolean),
      interfaceElements,
      unknownChildren: unknownLeaves.slice(0, 40).map((leaf) => ({
        text: normalizeText(leaf.textContent || '').slice(0, 500),
        domPath: domPathForNode(leaf, widget),
        html: safeOuterHtml(leaf.parentElement, 1400),
      })),
      warnings,
      sourceRoot: domPathForNode(widget, widget.closest?.('.markdown') || null),
      contentSourcePath: domPathForNode(contentSource, widget),
      domContext: safeOuterHtml(widget, 14_000),
    };
  }

  function discoverCodeLanguage(pre, code) {
    return codeWidgetInspection(pre, code).language;
  }

  function codeTextFromPre(element, inspection = null) {
    const details = inspection || codeWidgetInspection(element);
    const code = details?.contentSource || element?.querySelector?.('code') || element;
    return String(code?.textContent || '').replace(/\r\n?/g, '\n');
  }

  function rawCodeWidgetOwnerCandidate(element, pass = null) {
    const sharedCandidate = globalThis.ChatGptResponseParserCore?.rawCodeWidgetOwnerCandidate?.(element, pass);
    if (sharedCandidate) return sharedCandidate;
    if (!element?.querySelectorAll) return null;
    const codeElements = Array.from(element.querySelectorAll('code'));
    if (element.matches?.('code')) codeElements.unshift(element);
    const uniqueCode = Array.from(new Set(codeElements));
    if (uniqueCode.length !== 1) return null;
    const content = globalThis.ChatGptResponseParserCore?.contentSourceForWidget?.(element, pass) || codeWidgetContentSource(element);
    const contentSource = content?.element || uniqueCode[0];
    if (!contentSource || !element.contains?.(contentSource)) return null;
    const tag = element.tagName?.toLowerCase?.() || '';
    const signal = `${element.getAttribute?.('id') || ''} ${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''}`;
    let chromeEvidence = false;
    for (const leaf of visibleTextLeafNodes(element, pass)) {
      if (contentSource === leaf || contentSource.contains?.(leaf)) continue;
      const parent = leaf.parentElement;
      const text = normalizeText(leaf.textContent || '');
      const interactive = Boolean(closestWithin(leaf, 'button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]', element));
      const classified = DOM_PARSER.classifyCodeWidgetChromeText?.(text, {
        interactive,
        ariaLabel: parent?.getAttribute?.('aria-label') || '',
        title: parent?.getAttribute?.('title') || '',
      });
      if (classified?.kind === 'language' || classified?.kind === 'interface_action') {
        chromeEvidence = true;
        break;
      }
    }
    const structuralEvidence = /(?:code[-_ ]?block|codeblock|cm-editor|code-viewer|syntax|highlight)/i.test(signal);
    if (tag !== 'pre' && !chromeEvidence && !structuralEvidence) return null;
    return { contentSource, chromeEvidence, structuralEvidence, tag };
  }

  function isResponseCodeWidgetOwner(element, pass = null) {
    const sharedOwner = globalThis.ChatGptResponseParserCore?.isCodeWidgetOwner?.(element, pass);
    if (typeof sharedOwner === 'boolean') return sharedOwner;
    const candidate = rawCodeWidgetOwnerCandidate(element, pass);
    if (!candidate) return false;
    if (!candidate.chromeEvidence) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const parentCandidate = rawCodeWidgetOwnerCandidate(ancestor, pass);
        if (!parentCandidate || parentCandidate.contentSource !== candidate.contentSource) continue;
        if (parentCandidate.chromeEvidence || (candidate.tag === 'pre' && parentCandidate.structuralEvidence)) return false;
      }
    }
    if (candidate.tag === 'pre' && !element.parentElement?.closest?.('pre')) {
      // React can create a response-level pre containing the complete widget,
      // including a nested CodeMirror pre. Keep the outer pre as the atomic
      // owner instead of descending into zero-box/display:contents wrappers.
      return true;
    }
    if (candidate.chromeEvidence) {
      for (const descendant of Array.from(element.querySelectorAll('*'))) {
        if (descendant === candidate.contentSource || candidate.contentSource.contains?.(descendant)) continue;
        if (!descendant.contains?.(candidate.contentSource)) continue;
        const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
        if (nested?.chromeEvidence && nested.contentSource === candidate.contentSource) return false;
      }
      return true;
    }
    if (candidate.structuralEvidence) {
      for (const descendant of Array.from(element.children || [])) {
        const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
        if (nested && nested.contentSource === candidate.contentSource && (nested.chromeEvidence || nested.structuralEvidence)) return false;
      }
      return true;
    }
    return candidate.tag === 'pre';
  }

  function semanticResponseBlockType(element, pass = null) {
    const tag = element?.tagName?.toLowerCase?.() || '';
    const signal = `${element?.getAttribute?.('data-testid') || ''} ${element?.getAttribute?.('class') || ''} ${element?.getAttribute?.('role') || ''}`;
    if (/artifact|file-card|download-card|attachment/i.test(signal)) return 'artifact';
    if (/citation|source-pill|webpage/i.test(signal)) return 'citation';
    const responseLevelPreWithCode = tag === 'pre'
      && !element?.parentElement?.closest?.('pre')
      && Boolean(element?.querySelector?.('code, pre[class*="cm-content" i], [data-code-block-content], [data-testid*="code-content" i]'));
    if (responseLevelPreWithCode || isResponseCodeWidgetOwner(element, pass)) return 'code_block';
    if (tag === 'p') return 'paragraph';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'blockquote') return 'blockquote';
    if (tag === 'hr') return 'separator';
    if (tag === 'figure' || /^(?:img|video|audio|canvas|iframe|object|embed)$/.test(tag) || element?.matches?.('[role="img"]')) return 'media';
    if (tag === 'math' || element?.matches?.('.katex, .MathJax, [data-math], [data-testid*="math" i]')) return 'math';
    if (/widget|canvas|interactive|chart|diagram/i.test(signal)) return 'rich_widget';
    return '';
  }

  function nodeDocumentOrder(left, right) {
    if (left === right) return 0;
    const relation = left?.compareDocumentPosition?.(right) || 0;
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function blockOwnsLeaf(block, leaf) {
    if (!block || !leaf) return false;
    if (Array.isArray(block._ownedLeaves)) return block._ownedLeaves.includes(leaf);
    return Boolean(block._element?.contains?.(leaf));
  }

  function fallbackUnknownOwner(leaf, root, knownElements) {
    let owner = leaf?.parentElement || null;
    if (!owner) return null;
    for (let parent = owner.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (knownElements.some((element) => parent.contains?.(element))) break;
      owner = parent;
    }
    return owner;
  }

  function responseBlockElements(root, isExcluded, pass = null) {
    const known = [];
    const sharedCollector = globalThis.ChatGptResponseParserCore?.collectCodeWidgetOwners;
    const codeWidgetOwners = new Set(typeof sharedCollector === 'function' ? sharedCollector(root, pass) : []);
    const visit = (element) => {
      if (!element || isExcluded(element) || !parserElementVisible(element, pass)) return;
      const type = codeWidgetOwners.has(element) ? 'code_block' : semanticResponseBlockType(element, pass);
      if (type) {
        known.push({ element, type, ownedLeaves: null, orderNode: element });
        return;
      }
      const children = Array.from(element.children || []).filter((child) => !isExcluded(child) && parserElementVisible(child, pass));
      if (!children.length) return;
      for (const child of children) visit(child);
    };
    for (const child of Array.from(root?.children || [])) visit(child);

    const knownElements = known.map((entry) => entry.element);
    const unownedLeaves = visibleTextLeafNodes(root, pass).filter((leaf) => {
      const parent = leaf.parentElement;
      return parent && !isExcluded(parent) && !knownElements.some((element) => element.contains?.(leaf));
    });
    const unknownGroups = new Map();
    for (const leaf of unownedLeaves) {
      const owner = fallbackUnknownOwner(leaf, root, knownElements) || leaf.parentElement;
      if (!owner) continue;
      // If the fallback parent also contains a known block, leaves before and
      // after that block must remain separate so their document order is not
      // collapsed around the known child.
      const ownerContainsKnown = knownElements.some((element) => owner.contains?.(element));
      const key = ownerContainsKnown ? leaf : owner;
      const group = unknownGroups.get(key) || { element: owner, ownedLeaves: [] };
      group.ownedLeaves.push(leaf);
      unknownGroups.set(key, group);
    }
    const unknown = Array.from(unknownGroups.values(), ({ element, ownedLeaves }) => ({
      element,
      type: 'unknown',
      ownedLeaves,
      orderNode: ownedLeaves[0] || element,
    }));
    const entries = [...known, ...unknown].sort((left, right) => nodeDocumentOrder(left.orderNode, right.orderNode));
    if (!entries.length && root && !isExcluded(root) && parserElementVisible(root, pass)) {
      const leaves = visibleTextLeafNodes(root, pass).filter((leaf) => !isExcluded(leaf.parentElement));
      if (leaves.length) entries.push({ element: root, type: 'unknown', ownedLeaves: leaves, orderNode: leaves[0] });
    }
    return entries;
  }

  function mediaBlockMarkdown(element) {
    const media = element.matches?.('img, video, audio') ? element : element.querySelector?.('img, video, audio');
    const label = normalizeText(media?.getAttribute?.('alt') || media?.getAttribute?.('aria-label') || element.getAttribute?.('aria-label') || visibleText(element) || 'media');
    const src = String(media?.getAttribute?.('src') || media?.getAttribute?.('href') || '').trim();
    if (media?.tagName?.toLowerCase?.() === 'img' && src) return `![${label || 'image'}](${src})`;
    if (src) return `[${label || 'media'}](${src})`;
    return label;
  }

  function unknownOwnedText(ownedLeaves = []) {
    const values = [];
    for (const leaf of ownedLeaves) {
      const value = String(leaf?.textContent || '').replace(/\u00a0/g, ' ');
      if (value) values.push(value);
    }
    return normalizeText(values.join(' '));
  }

  function extractResponseBlocks(root, isExcluded, pass = null) {
    return responseBlockElements(root, isExcluded, pass).map((entry, index) => {
      const element = entry.element;
      const tag = element?.tagName?.toLowerCase?.() || '';
      const type = entry.type || semanticResponseBlockType(element, pass) || 'unknown';
      const base = { index, type, tag, _element: element, _ownedLeaves: entry.ownedLeaves || null };
      if (type === 'code_block') {
        const inspection = codeWidgetInspection(element, pass);
        const code = codeTextFromPre(element, inspection);
        return {
          ...base,
          markdown: preToMarkdown(element, inspection.language, code),
          language: inspection.language,
          code,
          _codeInspection: inspection,
          _languageDiagnostic: {
            language: inspection.language,
            source: inspection.source,
            confidence: inspection.confidence,
            selected: inspection.selected,
            candidates: inspection.candidates,
            warnings: inspection.warnings,
            sourceRoot: inspection.sourceRoot,
            contentSource: inspection.contentSourceKind,
            contentSourcePath: inspection.contentSourcePath,
            excludedUi: inspection.interfaceElements,
            unknownChildren: inspection.unknownChildren,
            domContext: inspection.domContext,
          },
        };
      }
      if (type === 'unknown') {
        const text = unknownOwnedText(entry.ownedLeaves || []);
        return {
          ...base,
          markdown: text,
          text,
          inlineCode: [],
          _blockDiagnostic: {
            sourceRoot: domPathForNode(element, root),
            reason: 'unclassified-visible-content',
            ownedLeafCount: entry.ownedLeaves?.length || 0,
            domContext: safeOuterHtml(element, 5000),
          },
        };
      }
      const markdown = type === 'media'
        ? mediaBlockMarkdown(element)
        : elementToMarkdown(element, { isExcluded, listDepth: 0, parserPass: pass }) || inlineMarkdown(element, { isExcluded, parserPass: pass });
      const inlineCode = Array.from(element.querySelectorAll?.('code') || [])
        .filter((code) => !code.closest?.('pre') && !isExcluded(code) && parserElementVisible(code, pass))
        .map((code) => String(code.textContent || '').replace(/\r\n?/g, '\n'));
      return {
        ...base,
        markdown,
        text: inlineMarkdown(element, { isExcluded, parserPass: pass }),
        inlineCode,
        _blockDiagnostic: {
          sourceRoot: domPathForNode(element, root),
          domContext: safeOuterHtml(element, 5000),
        },
      };
    });
  }

  function parserAuditForRoot(root, blocks, isExcluded, pass = null) {
    const leaves = visibleTextLeafNodes(root, pass);
    const contentItems = [];
    const interfaceItems = [];
    const artifactItems = [];
    const interfaceControls = [];
    const unknownItems = [];
    const duplicateItems = [];
    const blockEntries = Array.isArray(blocks) ? blocks : [];

    const pushLeaf = (target, leaf, category, extra = {}) => {
      target.push({
        category,
        text: normalizeText(leaf.textContent || '').slice(0, 1000),
        domPath: domPathForNode(leaf, root),
        ...extra,
      });
    };

    for (const leaf of leaves) {
      const parent = leaf.parentElement;
      const owners = blockEntries.filter((block) => blockOwnsLeaf(block, leaf));
      if (owners.length > 1) {
        pushLeaf(duplicateItems, leaf, 'duplicate', { ownerIndexes: owners.map((block) => block.index) });
        continue;
      }
      const owner = owners[0] || null;
      if (owner?.type === 'code_block') {
        const inspection = owner._codeInspection;
        if (inspection?.contentSource?.contains?.(leaf) || inspection?.contentSource === leaf) {
          pushLeaf(contentItems, leaf, 'content', { blockIndex: owner.index, blockType: owner.type });
        } else if (inspection?.interfaceLeaves?.includes?.(leaf) || inspection?.languageLeaves?.includes?.(leaf)) {
          pushLeaf(interfaceItems, leaf, 'interface', { blockIndex: owner.index, reason: 'code-widget-chrome' });
        } else {
          pushLeaf(unknownItems, leaf, 'unknown', { blockIndex: owner.index, reason: 'unclassified-code-widget-chrome', html: safeOuterHtml(parent, 1600) });
        }
        continue;
      }
      if (owner) {
        if (owner.type === 'unknown') pushLeaf(unknownItems, leaf, 'unknown', { blockIndex: owner.index, reason: 'unknown-response-block', html: safeOuterHtml(parent, 1600) });
        else if (isExcluded(parent)) pushLeaf(interfaceItems, leaf, 'interface', { blockIndex: owner.index, reason: 'excluded-interface' });
        else if (owner.type === 'artifact') pushLeaf(artifactItems, leaf, 'artifact', { blockIndex: owner.index, blockType: owner.type });
        else pushLeaf(contentItems, leaf, 'content', { blockIndex: owner.index, blockType: owner.type });
        continue;
      }
      if (isExcluded(parent)) pushLeaf(interfaceItems, leaf, 'interface', { reason: 'excluded-interface' });
      else pushLeaf(unknownItems, leaf, 'unknown', { reason: 'unowned-visible-text', html: safeOuterHtml(parent, 1600) });
    }

    const seenInterfaceControls = new Set();
    const addInterfaceControl = (descriptor) => {
      if (!descriptor) return;
      const key = `${descriptor.domPath || ''}|${descriptor.role || ''}|${descriptor.ariaLabel || ''}|${descriptor.title || ''}|${descriptor.text || ''}`;
      if (seenInterfaceControls.has(key)) return;
      seenInterfaceControls.add(key);
      interfaceControls.push(descriptor);
    };
    for (const block of blockEntries) {
      for (const descriptor of block._codeInspection?.interfaceElements || []) addInterfaceControl({ ...descriptor, blockIndex: block.index });
    }
    for (const control of Array.from(root.querySelectorAll?.('button, [role="button"], [role="menuitem"], [role="menuitemradio"]') || [])) {
      if (!parserElementVisible(control, pass) || !isExcluded(control)) continue;
      addInterfaceControl(describeInterfaceElement(control, root, 'excluded-interface-control'));
    }

    const visualUnknown = [];
    for (const element of Array.from(root.querySelectorAll?.('img, video, audio, canvas, iframe, object, embed, [role="img"]') || [])) {
      if (!parserElementVisible(element, pass) || isExcluded(element)) continue;
      const owners = blockEntries.filter((block) => block._element?.contains?.(element));
      if (!owners.length) {
        visualUnknown.push({
          category: 'unknown-visual',
          tag: element.tagName?.toLowerCase?.() || '',
          domPath: domPathForNode(element, root),
          ariaLabel: element.getAttribute?.('aria-label') || '',
          alt: element.getAttribute?.('alt') || '',
          html: safeOuterHtml(element, 1600),
        });
      }
    }

    const unknownCount = unknownItems.length + visualUnknown.length;
    const classified = contentItems.length + interfaceItems.length + artifactItems.length;
    // The denominator must come from the independent full DOM walk, never from
    // parser output. Otherwise a skipped subtree can incorrectly report 100%.
    const visibleCount = leaves.length;
    const accountedLeaves = classified + unknownItems.length + duplicateItems.length;
    const coveragePercent = visibleCount > 0 ? Number(((classified / visibleCount) * 100).toFixed(2)) : 100;
    const blockDiagnostics = blockEntries.map((block) => ({
      index: block.index,
      type: block.type,
      tag: block.tag,
      sourceRoot: domPathForNode(block._element, root),
      language: block.language || '',
      languageSource: block._codeInspection?.source || '',
      languageConfidence: block._codeInspection?.confidence || '',
      unknownChildren: block._codeInspection?.unknownChildren || [],
    }));
    const warnings = [];
    if (unknownCount) warnings.push('unknown_visible_content');
    if (duplicateItems.length) warnings.push('duplicate_leaf_ownership');
    if (accountedLeaves !== visibleCount) warnings.push('leaf_accounting_gap');
    for (const block of blockEntries) for (const warning of block._codeInspection?.warnings || []) warnings.push(`block_${block.index}:${warning}`);

    return {
      version: 1,
      coverage: {
        visibleTextLeaves: visibleCount,
        contentLeaves: contentItems.length,
        interfaceLeaves: interfaceItems.length,
        artifactLeaves: artifactItems.length,
        reasoningLeaves: 0,
        unknownLeaves: unknownItems.length,
        unknownVisualElements: visualUnknown.length,
        duplicateLeaves: duplicateItems.length,
        classifiedLeaves: classified,
        accountedLeaves,
        coveragePercent,
      },
      blocks: blockDiagnostics,
      contentItems: contentItems.slice(0, 300),
      interfaceItems: interfaceItems.slice(0, 300),
      artifactItems: artifactItems.slice(0, 300),
      interfaceControls: interfaceControls.slice(0, 300),
      unknownItems: [...unknownItems, ...visualUnknown].slice(0, 120),
      duplicateItems: duplicateItems.slice(0, 120),
      warnings: Array.from(new Set(warnings)),
    };
  }

  function mergeParserAudits(audits = []) {
    const valid = (Array.isArray(audits) ? audits : []).filter(Boolean);
    const coverage = valid.reduce((result, audit) => {
      for (const key of ['visibleTextLeaves', 'contentLeaves', 'interfaceLeaves', 'artifactLeaves', 'reasoningLeaves', 'unknownLeaves', 'unknownVisualElements', 'duplicateLeaves', 'classifiedLeaves']) result[key] += Number(audit.coverage?.[key] || 0);
      return result;
    }, { visibleTextLeaves: 0, contentLeaves: 0, interfaceLeaves: 0, artifactLeaves: 0, reasoningLeaves: 0, unknownLeaves: 0, unknownVisualElements: 0, duplicateLeaves: 0, classifiedLeaves: 0 });
    coverage.coveragePercent = coverage.visibleTextLeaves > 0
      ? Number(((coverage.classifiedLeaves / coverage.visibleTextLeaves) * 100).toFixed(2))
      : 100;
    return {
      version: 1,
      coverage,
      blocks: valid.flatMap((audit) => audit.blocks || []),
      contentItems: valid.flatMap((audit) => audit.contentItems || []).slice(0, 500),
      interfaceItems: valid.flatMap((audit) => audit.interfaceItems || []).slice(0, 500),
      artifactItems: valid.flatMap((audit) => audit.artifactItems || []).slice(0, 500),
      interfaceControls: valid.flatMap((audit) => audit.interfaceControls || []).slice(0, 500),
      unknownItems: valid.flatMap((audit) => audit.unknownItems || []).slice(0, 200),
      duplicateItems: valid.flatMap((audit) => audit.duplicateItems || []).slice(0, 200),
      warnings: Array.from(new Set(valid.flatMap((audit) => audit.warnings || []))),
    };
  }

  function extractMarkdownFromElement(root, isExcluded, pass = null) {
    const blocks = [];
    for (const child of Array.from(root.children)) {
      if (isExcluded(child) || !parserElementVisible(child, pass)) continue;
      const value = elementToMarkdown(child, { isExcluded, listDepth: 0, parserPass: pass });
      if (value) blocks.push(value);
    }
    const markdown = normalizeMarkdown(blocks.join('\n\n'));
    return markdown || inlineMarkdown(root, { isExcluded, parserPass: pass });
  }

  function elementToMarkdown(element, context) {
    if (!element || context.isExcluded(element) || !parserElementVisible(element, context.parserPass)) return '';
    const tag = element.tagName.toLowerCase();
    if (tag === 'pre') return preToMarkdown(element);
    if (tag === 'table') return tableToMarkdown(element);
    if (tag === 'blockquote') return blockquoteToMarkdown(element, context);
    if (tag === 'ul' || tag === 'ol') return listToMarkdown(element, context, tag === 'ol');
    if (tag === 'li') return listItemToMarkdown(element, context, false, 1);
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${inlineMarkdown(element, context)}`.trim();
    if (tag === 'p') return inlineMarkdown(element, context);
    if (tag === 'hr') return '---';

    const childBlocks = [];
    for (const child of Array.from(element.children)) {
      if (context.isExcluded(child) || !parserElementVisible(child, context.parserPass)) continue;
      const childTag = child.tagName.toLowerCase();
      if (isBlockTag(childTag)) {
        const value = elementToMarkdown(child, context);
        if (value) childBlocks.push(value);
      }
    }
    if (childBlocks.length) return normalizeMarkdown(childBlocks.join('\n\n'));
    return inlineMarkdown(element, context);
  }

  function isBlockTag(tag) { return /^(p|div|section|article|pre|table|blockquote|ul|ol|li|h[1-6]|hr)$/i.test(tag); }
  function inlineText(element, context = null) {
    if (!context?.isExcluded) return visibleText(element).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const collect = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE || context.isExcluded(node) || !parserElementVisible(node, context.parserPass)) return '';
      return Array.from(node.childNodes || []).map(collect).join(' ');
    };
    return normalizeText(collect(element)).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  function preToMarkdown(element, resolvedLanguage = null, resolvedText = null) {
    const code = element.querySelector('code') || element;
    const language = resolvedLanguage == null ? discoverCodeLanguage(element, code) : String(resolvedLanguage || '');
    const text = resolvedText == null ? codeTextFromPre(element) : String(resolvedText || '');
    if (!text) return '';
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const suffix = text.endsWith('\n') ? '' : '\n';
    return `${fence}${language}\n${text}${suffix}${fence}`;
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => inlineText(cell).replace(/\|/g, '\\|'))).filter((cells) => cells.length);
    if (!rows.length) return visibleText(table);
    const header = rows[0];
    const separator = header.map(() => '---');
    const body = rows.slice(1);
    return [header, separator, ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
  }
  function blockquoteToMarkdown(element, context) { return (elementToMarkdownChildren(element, context) || visibleText(element)).split('\n').map((line) => `> ${line}`).join('\n'); }
  function elementToMarkdownChildren(element, context) {
    const values = [];
    for (const child of Array.from(element.children)) {
      const value = elementToMarkdown(child, context);
      if (value) values.push(value);
    }
    return normalizeMarkdown(values.join('\n\n'));
  }
  function listToMarkdown(list, context, ordered) {
    const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === 'li');
    return items.map((item, index) => listItemToMarkdown(item, context, ordered, index + 1)).filter(Boolean).join('\n');
  }
  function listItemToMarkdown(item, context, ordered, number) {
    const depth = context.listDepth || 0;
    const prefix = ordered ? `${number}. ` : '- ';
    const nestedLists = Array.from(item.children).filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()));
    const clone = item.cloneNode(true);
    for (const nested of Array.from(clone.children).filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()))) nested.remove();
    const ownText = inlineText(clone);
    const indent = '  '.repeat(depth);
    const lines = ownText ? [`${indent}${prefix}${ownText}`] : [];
    for (const nested of nestedLists) {
      if (context.isExcluded(nested)) continue;
      const nestedMarkdown = listToMarkdown(nested, { ...context, listDepth: depth + 1 }, nested.tagName.toLowerCase() === 'ol');
      if (nestedMarkdown) lines.push(nestedMarkdown);
    }
    return lines.join('\n');
  }

  function normalizeCode(value) { return String(value || '').replace(/\n+$/g, '').replace(/^\n+/g, ''); }
  function normalizeMarkdown(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let fenceChar = '';
    let fenceLength = 0;
    let outsideBlankRun = 0;
    for (const original of lines) {
      const opening = original.match(/^\s*(`{3,}|~{3,})/);
      if (fenceChar) {
        output.push(original);
        const closing = original.match(/^\s*(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
          fenceChar = '';
          fenceLength = 0;
        }
        continue;
      }
      const line = original.replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '');
      if (opening) {
        output.push(line);
        fenceChar = opening[1][0];
        fenceLength = opening[1].length;
        outsideBlankRun = 0;
        continue;
      }
      if (!line) {
        outsideBlankRun += 1;
        if (outsideBlankRun <= 1) output.push('');
      } else {
        outsideBlankRun = 0;
        output.push(line);
      }
    }
    while (output[0] === '') output.shift();
    while (output.at(-1) === '') output.pop();
    return output.join('\n');
  }

  function stripThinkingFromRaw(raw, thinking) { return thinking ? normalizeText(raw.replace(thinking, '')) : raw; }
  function isGenerating() { return Boolean(findStopButton()); }
  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if ('isConnected' in element && !element.isConnected) return false;
    try {
      if (element.closest?.('[hidden], [aria-hidden="true"]')) return false;
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && style.display !== 'none'
        && style.contentVisibility !== 'hidden'
        && Number(style.opacity) !== 0;
    } catch {
      return true;
    }
  }
  function visibleText(element) { return normalizeText(element?.innerText || element?.textContent || ''); }
  function normalizeText(value) { return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function unique(items) {
    const seen = new Set();
    const result = [];
    for (const item of items.map(normalizeText).filter(Boolean)) {
      if (seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
    return result;
  }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function getCurrentSession() {
    const id = conversationIdFromUrl(location.href) || 'new';
    return { id, url: location.href, title: document.title || id, active: true };
  }

  function conversationIdFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || '';
    } catch { return ''; }
  }

  function collectSessions() {
    const currentId = conversationIdFromUrl(location.href) || 'new';
    const map = new Map();
    map.set(currentId, getCurrentSession());

    for (const a of Array.from(document.querySelectorAll('a[href*="/c/"]'))) {
      const href = a.href || a.getAttribute('href') || '';
      const id = conversationIdFromUrl(href);
      if (!id) continue;
      const title = visibleText(a) || a.getAttribute('aria-label') || id;
      map.set(id, { id, title, url: new URL(href, location.href).toString(), active: id === currentId });
    }

    return Array.from(map.values());
  }

  function handleSessionsList(payload) {
    send({ type: 'sessions.snapshot', commandId: payload.commandId, sessions: collectSessions(), current: getCurrentSession(), url: location.href, title: document.title });
  }

  async function handleSessionsNew(payload) {
    try {
      const session = await openNewSession();
      send({ type: 'session.new', commandId: payload.commandId, session, sessions: collectSessions() });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleSessionsSelect(payload) {
    try {
      const session = await selectSessionById(String(payload.sessionId || ''));
      send({ type: 'session.selected', commandId: payload.commandId, session, sessions: collectSessions() });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleSessionsDelete(payload) {
    try {
      const result = await deleteCurrentSessionSafely({
        expectedSessionId: String(payload.sessionId || payload.expectedSessionId || ''),
        expectedUrl: String(payload.expectedUrl || ''),
      });
      send({ type: 'session.deleted', commandId: payload.commandId, ...result, session: getCurrentSession(), url: location.href, title: document.title });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleBrowserTabOpen(payload) {
    try {
      const result = await extensionRequest('bridge.tab.open', {
        url: String(payload.url || 'https://chatgpt.com/'),
        active: payload.active !== false,
        launchToken: String(payload.launchToken || ''),
        bridgeServerUrl: safeLaunchBridgeServerUrl(payload.bridgeServerUrl || CONFIG.serverUrl),
      }, Number(payload.timeoutMs) || 15_000);
      send({ type: 'browser.tab.opened', commandId: payload.commandId, ...result });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleBrowserTabClose(payload) {
    try {
      const expectedUrl = String(payload.expectedUrl || '');
      if (expectedUrl) {
        const current = DOM_PARSER.canonicalConversationUrl(location.href) || new URL(location.href).origin + new URL(location.href).pathname;
        const expected = DOM_PARSER.canonicalConversationUrl(expectedUrl) || new URL(expectedUrl, location.href).origin + new URL(expectedUrl, location.href).pathname;
        if (current !== expected) throw new Error(`Refusing to close tab because URL changed: expected ${expected}, current ${current}`);
      }
      const result = await extensionRequest('bridge.tab.close', {
        expectedLaunchToken: String(payload.expectedLaunchToken || ''),
      }, Number(payload.timeoutMs) || 10_000);
      send({ type: 'browser.tab.closing', commandId: payload.commandId, ...result, url: location.href });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  function handleBrowserTabReload(payload) {
    send({
      type: 'browser.tab.reloading',
      commandId: payload.commandId,
      url: location.href,
    });
    diagnostic('browser.tab.reload.accepted', { commandId: payload.commandId, reason: String(payload.reason || '') });
    setTimeout(() => {
      extensionRequest('bridge.tab.reload', {
        reason: String(payload.reason || ''),
      }, 5_000).catch((err) => diagnostic('browser.tab.reload.failed', { commandId: payload.commandId, message: err.message || String(err) }));
    }, 120);
  }

  function handleExtensionReload(payload) {
    send({
      type: 'extension.reload.accepted',
      commandId: payload.commandId,
      extensionVersion: EXTENSION_VERSION,
      contentVersion: CONTENT_SCRIPT_VERSION,
      url: location.href,
    });
    diagnostic('extension.reload.accepted', { commandId: payload.commandId, reloadTabs: payload.reloadTabs !== false });
    setTimeout(() => {
      extensionRequest('bridge.extension.reload', {
        reloadTabs: payload.reloadTabs !== false,
        expectedVersion: String(payload.expectedVersion || ''),
      }, 5_000).catch((err) => diagnostic('extension.reload.failed', { commandId: payload.commandId, message: err.message || String(err) }));
    }, 120);
  }

  function assertSessionDeletionTarget(expectedSessionId, expectedUrl) {
    const check = DOM_PARSER.verifySessionDeletionTarget({ currentUrl: location.href, expectedUrl, expectedSessionId });
    if (!check.ok) {
      throw new Error(`Refusing to delete ChatGPT session: ${check.reason}. Expected ${expectedSessionId || '(missing)'} at ${expectedUrl || '(missing)'}, current URL is ${location.href}.`);
    }
    return check;
  }

  function sessionRowForLink(link) {
    let current = link;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      const buttons = Array.from(current.querySelectorAll?.('button, [role="button"]') || []);
      if (buttons.length && current.querySelector?.('a[href*="/c/"]')) return current;
    }
    return link.parentElement || link;
  }

  function isStableConversationMenuTrigger(element) {
    if (!element || !isVisible(element)) return false;
    const testId = String(element.getAttribute?.('data-testid') || '').toLowerCase();
    if (/(?:conversation|chat).*(?:menu|options)|(?:menu|options).*(?:conversation|chat)/.test(testId)) return true;
    return element.getAttribute?.('aria-haspopup') === 'menu'
      || Boolean(element.getAttribute?.('aria-controls'));
  }

  function conversationMenuCandidateScore(element, source = '') {
    const testId = String(element?.getAttribute?.('data-testid') || '').toLowerCase();
    const rect = element?.getBoundingClientRect?.() || { left: 0, top: 0 };
    let score = 0;
    if (source === 'session-row') score += 500;
    if (source === 'explicit-testid') score += 400;
    if (source === 'top-menu-trigger') score += 200;
    if (/(?:conversation|chat).*(?:menu|options)|(?:menu|options).*(?:conversation|chat)/.test(testId)) score += 300;
    if (element?.getAttribute?.('aria-haspopup') === 'menu') score += 80;
    if (element?.getAttribute?.('aria-controls')) score += 60;
    if (element?.getAttribute?.('aria-expanded') === 'true') score += 20;
    score += Math.max(0, Math.min(50, Math.round((rect.left / Math.max(1, window.innerWidth)) * 50)));
    score -= Math.max(0, Math.min(30, Math.round(rect.top / 20)));
    return score;
  }

  function currentSessionMenuCandidates(sessionId) {
    const scored = [];
    const seen = new Set();
    const add = (element, source) => {
      if (!element || seen.has(element) || !isVisible(element)) return;
      seen.add(element);
      scored.push({ element, source, score: conversationMenuCandidateScore(element, source) });
    };

    const links = Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .filter((link) => conversationIdFromUrl(link.href || link.getAttribute('href')) === sessionId);
    for (const link of links) {
      const row = sessionRowForLink(link);
      try {
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
      } catch {}
      const rowButtons = Array.from(row.querySelectorAll?.('button, [role="button"]') || [])
        .filter((button) => button !== link && !button.contains?.(link));
      for (const button of rowButtons.filter(isStableConversationMenuTrigger)) add(button, 'session-row');
      // Some sidebar implementations expose the ellipsis control without
      // aria-haspopup/aria-controls. The exact session row is still a safe
      // structural scope; the opened menu must later prove the stable delete
      // action test id before anything destructive is clicked.
      for (const button of rowButtons) add(button, 'session-row');
    }

    for (const element of Array.from(document.querySelectorAll([
      '[data-testid="conversation-options-button"]',
      '[data-testid="conversation-menu-button"]',
      '[data-testid="chat-options-button"]',
      '[data-testid="chat-menu-button"]',
      '[data-testid*="conversation-options" i]',
      '[data-testid*="conversation-menu" i]',
      '[data-testid*="chat-options" i]',
      '[data-testid*="chat-menu" i]',
    ].join(', ')))) add(element, 'explicit-testid');

    // Header controls are a language-independent fallback for collapsed
    // sidebars. Only menu triggers near the top of the page are considered,
    // and the resulting menu still has to contain the exact conversation
    // delete action test id.
    const topMenuTriggers = Array.from(document.querySelectorAll([
      'header button[aria-haspopup="menu"]',
      'header [role="button"][aria-haspopup="menu"]',
      'header button[aria-controls]',
      'header [role="button"][aria-controls]',
      'main button[aria-haspopup="menu"]',
      'main [role="button"][aria-haspopup="menu"]',
      'main button[aria-controls]',
      'main [role="button"][aria-controls]',
    ].join(', '))).filter((element) => {
      if (!isStableConversationMenuTrigger(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.top <= 160;
    });
    for (const element of topMenuTriggers) add(element, 'top-menu-trigger');

    return scored
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.element);
  }

  function deleteActionDescriptor(element) {
    return {
      testId: element?.getAttribute?.('data-testid') || '',
      text: visibleText(element),
      ariaLabel: element?.getAttribute?.('aria-label') || '',
      title: element?.getAttribute?.('title') || '',
      role: element?.getAttribute?.('role') || element?.tagName?.toLowerCase?.() || '',
      dataColor: element?.getAttribute?.('data-color') || '',
      dataVariant: element?.getAttribute?.('data-variant') || '',
      dataDestructive: element?.getAttribute?.('data-destructive') || '',
    };
  }

  function visibleDeleteActions(root = document) {
    return Array.from(root.querySelectorAll?.([
      '[data-testid="delete-chat-menu-item"]',
      '[data-testid="delete-conversation-menu-item"]',
      '[data-testid*="delete-chat" i]',
      '[data-testid*="chat-delete" i]',
      '[data-testid*="delete-conversation" i]',
      '[data-testid*="conversation-delete" i]',
    ].join(', ')) || [])
      .filter(isVisible)
      .filter((element) => DOM_PARSER.isConversationDeleteActionDescriptor(deleteActionDescriptor(element)));
  }

  function visibleMenus() {
    return Array.from(document.querySelectorAll('[role="menu"], [data-radix-menu-content]')).filter(isVisible);
  }

  function visibleConversationDeleteMenus() {
    return visibleMenus().filter((menu) => visibleDeleteActions(menu).length > 0);
  }

  function menuOwnedByTrigger(menu, trigger) {
    return DOM_PARSER.menuTriggerOwnsMenu({
      triggerId: trigger?.id || '',
      triggerAriaControls: trigger?.getAttribute?.('aria-controls') || '',
      menuId: menu?.id || '',
      menuAriaLabelledby: menu?.getAttribute?.('aria-labelledby') || '',
    });
  }

  function conversationMenuCandidateDescriptors(candidates) {
    return candidates.slice(0, 12).map((element) => ({
      id: element.id || '',
      testId: element.getAttribute?.('data-testid') || '',
      ariaHaspopup: element.getAttribute?.('aria-haspopup') || '',
      ariaControls: element.getAttribute?.('aria-controls') || '',
      ariaExpanded: element.getAttribute?.('aria-expanded') || '',
      rect: (() => {
        const rect = element.getBoundingClientRect?.();
        return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
      })(),
    }));
  }

  async function openDeleteActionForCurrentSession(sessionId, expectedUrl) {
    for (let round = 1; round <= 4; round += 1) {
      assertSessionDeletionTarget(sessionId, expectedUrl);
      const candidates = currentSessionMenuCandidates(sessionId);
      diagnostic('session.delete.menu_candidates', {
        sessionId,
        round,
        count: candidates.length,
        candidates: conversationMenuCandidateDescriptors(candidates),
      });
      for (const button of candidates) {
        assertSessionDeletionTarget(sessionId, expectedUrl);
        try { button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}

        const alreadyOwnedMenu = visibleConversationDeleteMenus().find((menu) => menuOwnedByTrigger(menu, button));
        const alreadyOwnedAction = alreadyOwnedMenu ? visibleDeleteActions(alreadyOwnedMenu)[0] : null;
        if (alreadyOwnedAction) {
          diagnostic('session.delete.action_found', { sessionId, round, source: 'already_open_owned_menu', descriptor: deleteActionDescriptor(alreadyOwnedAction) });
          return alreadyOwnedAction;
        }

        const menusBeforeOpen = new Set(visibleMenus());
        try { button.click(); } catch { continue; }
        for (let attempt = 0; attempt < 24; attempt += 1) {
          await delay(150);
          const menus = visibleMenus();
          const ownedMenu = menus.find((menu) => menuOwnedByTrigger(menu, button) && visibleDeleteActions(menu).length > 0);
          const newlyOpenedMenu = menus.find((menu) => !menusBeforeOpen.has(menu) && visibleDeleteActions(menu).length > 0);
          const menu = ownedMenu || newlyOpenedMenu || null;
          const menuAction = menu ? visibleDeleteActions(menu)[0] : null;
          if (menuAction) {
            diagnostic('session.delete.action_found', {
              sessionId,
              round,
              source: ownedMenu ? 'trigger_owned_menu' : 'new_delete_menu',
              menuId: menu.id || '',
              menuLabelledBy: menu.getAttribute?.('aria-labelledby') || '',
              descriptor: deleteActionDescriptor(menuAction),
            });
            return menuAction;
          }
        }
        diagnostic('session.delete.menu_open_failed', {
          sessionId,
          round,
          trigger: conversationMenuCandidateDescriptors([button])[0],
          visibleMenus: visibleMenus().map((menu) => ({
            id: menu.id || '',
            ariaLabelledby: menu.getAttribute?.('aria-labelledby') || '',
            deleteActions: visibleDeleteActions(menu).map(deleteActionDescriptor),
          })),
        });
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
        await delay(150);
      }
      if (round < 4) {
        schedulePageStatus('page.changed', 0);
        await delay(500 * round);
      }
    }
    throw new Error(`Could not find the structurally identified delete action for current ChatGPT session ${sessionId}`);
  }

  function visibleModalDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(isVisible);
  }

  function visibleDeleteConfirmation(dialogsBefore = new Set()) {
    const candidates = visibleModalDialogs().filter((dialog) => !dialogsBefore.has(dialog));
    for (const dialog of candidates) {
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(isVisible);
      const exact = buttons.filter((button) => {
        const descriptor = deleteActionDescriptor(button);
        return DOM_PARSER.isConversationDeleteConfirmationDescriptor({ ...descriptor, dataColor: '', dataVariant: '', dataDestructive: '' });
      });
      if (exact.length === 1) return { dialog, confirm: exact[0], source: 'semantic_testid' };

      const destructive = buttons.filter((button) => DOM_PARSER.isConversationDeleteConfirmationDescriptor(deleteActionDescriptor(button)));
      if (destructive.length === 1) return { dialog, confirm: destructive[0], source: 'single_destructive_button' };
    }
    return null;
  }

  function boundedUiBackoffDelay(attempt, { initialMs = 100, factor = 1.7, maxMs = 2_000 } = {}) {
    const index = Math.max(0, Number(attempt) || 0);
    return Math.min(maxMs, Math.max(initialMs, Math.round(initialMs * (factor ** index))));
  }

  async function waitForConversationToDisappear(sessionId, timeoutMs = 12_000) {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      if (conversationIdFromUrl(location.href) !== sessionId) return true;
      const remaining = timeoutMs - (Date.now() - started);
      await delay(Math.min(remaining, boundedUiBackoffDelay(attempt++, { initialMs: 100, factor: 1.5, maxMs: 1_000 })));
    }
    return false;
  }

  async function waitForDeleteConfirmation(dialogsBefore, sessionId, timeoutMs = 10_000) {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      if (conversationIdFromUrl(location.href) !== sessionId) return { disappeared: true };
      const confirmation = visibleDeleteConfirmation(dialogsBefore);
      if (confirmation) return { confirmation };
      const waitedMs = Date.now() - started;
      if (attempt === 0 || attempt === 3 || attempt === 6) {
        diagnostic('session.delete.confirmation_waiting', {
          sessionId,
          attempt: attempt + 1,
          waitedMs,
          timeoutMs,
          visibleDialogs: visibleModalDialogs().length,
        });
      }
      const remaining = timeoutMs - waitedMs;
      await delay(Math.min(remaining, boundedUiBackoffDelay(attempt++, { initialMs: 100, factor: 1.7, maxMs: 2_000 })));
    }
    diagnostic('session.delete.confirmation_timeout', {
      sessionId,
      waitedMs: Date.now() - started,
      timeoutMs,
      visibleDialogs: visibleModalDialogs().map((dialog) => ({
        role: dialog.getAttribute?.('role') || '',
        testId: dialog.getAttribute?.('data-testid') || '',
        buttons: Array.from(dialog.querySelectorAll?.('button, [role="button"]') || []).filter(isVisible).map(deleteActionDescriptor),
      })),
    });
    return { confirmation: null, disappeared: false };
  }

  async function deleteCurrentSessionSafely({ expectedSessionId, expectedUrl }) {
    await waitForDocumentReady();
    const readyStarted = Date.now();
    while (Date.now() - readyStarted < 10_000) {
      assertSessionDeletionTarget(expectedSessionId, expectedUrl);
      const readiness = chatPageReadiness();
      if (readiness.chatMainReady) break;
      await delay(200);
    }
    const before = assertSessionDeletionTarget(expectedSessionId, expectedUrl);
    const deleteAction = await openDeleteActionForCurrentSession(before.currentId, expectedUrl);
    assertSessionDeletionTarget(expectedSessionId, expectedUrl);
    const dialogsBeforeDelete = new Set(visibleModalDialogs());
    deleteAction.click();

    const confirmationResult = await waitForDeleteConfirmation(dialogsBeforeDelete, before.currentId, 10_000);
    if (confirmationResult.disappeared) {
      return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: false };
    }

    const confirmation = confirmationResult.confirmation;
    if (!confirmation) {
      // The navigation can win the race immediately after the final confirmation probe.
      // Give URL removal one short bounded grace period before reporting a UI failure.
      const disappearedAfterTimeout = await waitForConversationToDisappear(before.currentId, 2_000);
      if (disappearedAfterTimeout) {
        diagnostic('session.delete.completed_during_confirmation_grace', {
          sessionId: before.currentId,
          waitedMs: 2_000,
        });
        return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: false };
      }
      throw new Error(`Delete confirmation dialog did not appear with a stable destructive action for ChatGPT session ${before.currentId}`);
    }
    diagnostic('session.delete.confirmation_found', {
      sessionId: before.currentId,
      source: confirmation.source || '',
      descriptor: deleteActionDescriptor(confirmation.confirm),
      waitedWithBackoff: true,
    });
    assertSessionDeletionTarget(expectedSessionId, expectedUrl);
    confirmation.confirm.click();
    const removed = await waitForConversationToDisappear(before.currentId);
    if (!removed) throw new Error(`ChatGPT session ${before.currentId} still appears in the current URL after delete confirmation`);
    return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: true };
  }

  async function openNewSession() {
    const button = Array.from(document.querySelectorAll('a, button, [role="button"]')).find((element) => {
      if (!isVisible(element)) return false;
      const text = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), visibleText(element)].filter(Boolean).join(' ');
      return /new chat|new conversation|новый чат|создать чат/i.test(text);
    });
    if (button) button.click();
    else location.href = '/';
    await waitForUrlChangeOrDelay(800);
    return getCurrentSession();
  }

  async function selectSessionById(sessionId) {
    const raw = String(sessionId || '').trim();
    const id = conversationIdFromUrl(raw) || raw;
    if (!id) throw new Error('No sessionId provided');
    if (conversationIdFromUrl(location.href) === id) return getCurrentSession();

    const sessions = collectSessions();
    const session = sessions.find((item) => item.id === id || item.url === raw || item.url.endsWith(`/c/${id}`));
    if (session) {
      const link = Array.from(document.querySelectorAll('a[href*="/c/"]')).find((a) => conversationIdFromUrl(a.href || a.getAttribute('href')) === session.id);
      if (link) link.click();
      else location.href = session.url;
    } else if (/^https?:\/\//.test(raw)) {
      location.href = raw;
    } else {
      location.href = `/c/${id}`;
    }

    await waitForUrlChangeOrDelay(1000);
    const switched = await waitForSessionId(id, 6000);
    const sessionAfterSwitch = getCurrentSession();
    if (!switched || sessionAfterSwitch.id !== id) {
      throw new Error(`Could not switch ChatGPT tab to session ${id}; current session is ${sessionAfterSwitch.id || 'unknown'}.`);
    }
    return sessionAfterSwitch;
  }

  function waitForUrlChangeOrDelay(minDelayMs = 800) {
    const before = location.href;
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (location.href !== before && document.readyState !== 'loading') {
          setTimeout(resolve, 350);
          return;
        }
        if (Date.now() - started >= minDelayMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function waitForSessionId(sessionId, timeoutMs = 6000) {
    const desired = conversationIdFromUrl(sessionId) || String(sessionId || '').trim();
    if (!desired) return Promise.resolve(false);
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (conversationIdFromUrl(location.href) === desired && document.readyState !== 'loading') {
          setTimeout(() => resolve(true), 350);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }


  const INTELLIGENCE_UI_TIMING = Object.freeze({
    focusSettleMs: 140,
    pickerOpenWaitMs: 1_300,
    pickerStableMs: 180,
    submenuInitialHoverMs: 260,
    submenuPulseMs: 280,
    submenuOpenWaitMs: 1_500,
    submenuStableMs: 220,
    beforeOptionClickMs: 180,
    selectionSettleMs: 850,
    betweenSelectionsMs: 500,
    verificationRetryMs: 650,
    menuCloseSettleMs: 180,
  });

  function visibleIntelligencePickerContent() {
    return Array.from(document.querySelectorAll('[data-testid="composer-intelligence-picker-content"]')).find(isVisible) || null;
  }

  function intelligenceOptionFromElement(element) {
    const fallbackText = normalizeText(element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || '');
    const leafTexts = Array.from(element?.querySelectorAll?.('*') || [])
      .filter((node) => !node.children?.length && isVisible(node))
      .map((node) => normalizeText(node.innerText || node.textContent || ''))
      .filter(Boolean);
    const uniqueLeafTexts = unique(leafTexts);
    const label = uniqueLeafTexts[0] || fallbackText;
    const annotationParts = uniqueLeafTexts.slice(1).filter((text) => normalizeComparable(text) !== normalizeComparable(label));
    const annotation = annotationParts.join(' · ');
    const rawText = uniqueLeafTexts.length ? uniqueLeafTexts.join('\n') : fallbackText;
    return {
      label,
      rawText,
      selected: element?.getAttribute?.('aria-checked') === 'true' || element?.getAttribute?.('data-state') === 'checked',
      ...(annotation ? { annotation } : {}),
    };
  }

  async function waitForVisibleElement(getter, timeoutMs = 1500, pollMs = 80) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = getter();
      if (value) return value;
      await delay(pollMs);
    }
    return null;
  }

  async function waitForStableVisibleElement(getter, timeoutMs, stableMs = INTELLIGENCE_UI_TIMING.pickerStableMs) {
    const started = Date.now();
    let candidate = null;
    let candidateSince = 0;
    while (Date.now() - started < timeoutMs) {
      const value = getter();
      if (value) {
        if (value !== candidate) {
          candidate = value;
          candidateSince = Date.now();
        }
        if (Date.now() - candidateSince >= stableMs) return value;
      } else {
        candidate = null;
        candidateSince = 0;
      }
      await delay(80);
    }
    return null;
  }

  function intelligencePickerCandidateRoots() {
    const roots = [];
    const add = (root) => { if (root && !roots.includes(root)) roots.push(root); };
    const composer = findComposer();
    let current = findComposerRootStrict() || composer?.parentElement || null;
    for (let depth = 0; current && depth < 5; depth += 1) {
      add(current);
      current = current.parentElement;
    }
    const form = composer?.closest?.('form');
    add(form);
    add(document.body);
    return roots;
  }

  function intelligencePickerTriggerCandidates() {
    const composer = findComposer();
    const composerRect = composer?.getBoundingClientRect?.() || null;
    const seen = new Set();
    const candidates = [];
    for (const root of intelligencePickerCandidateRoots()) {
      for (const element of Array.from(root.querySelectorAll?.('button, [role="button"], [aria-haspopup="menu"]') || [])) {
        if (seen.has(element) || !isUsableButton(element)) continue;
        seen.add(element);
        const signal = `${buttonSignalText(element)} ${element.getAttribute('aria-controls') || ''}`;
        const hasMenu = element.getAttribute('aria-haspopup') === 'menu';
        const rect = element.getBoundingClientRect?.() || null;
        const nearComposer = Boolean(composerRect && rect
          && Math.abs(rect.bottom - composerRect.bottom) < 180
          && Math.abs(rect.left - composerRect.left) < Math.max(700, composerRect.width + 250));
        let score = 0;
        if (/composer-intelligence-picker-content|intelligence|reasoning-effort/i.test(signal)) score += 100;
        if (/instant|medium|high|thinking|reasoning|model|gpt|средн|высок|размыш|модель|интеллект/i.test(signal)) score += 35;
        if (hasMenu) score += 20;
        if (element.hasAttribute('aria-expanded')) score += 8;
        if (nearComposer) score += 6;
        if (root === document.body && !nearComposer && score < 35) continue;
        if (!hasMenu && score < 35) continue;
        candidates.push({ element, score, signal: normalizeText(signal).slice(0, 240) });
      }
    }
    return candidates.sort((left, right) => right.score - left.score);
  }

  function dispatchSinglePointerClick(element, point) {
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    const common = { bubbles: true, cancelable: true, composed: true, ...point };
    try { element.dispatchEvent(new PointerCtor('pointerover', { ...common, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mouseover', { ...common, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 })); } catch {}
    try { element.dispatchEvent(new PointerCtor('pointerup', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 })); } catch {}
    try { element.dispatchEvent(new MouseEvent('click', { ...common, button: 0, buttons: 0, detail: 1 })); } catch {}
  }

  async function openIntelligencePicker() {
    const existing = visibleIntelligencePickerContent();
    if (existing) {
      diagnostic('intelligence.picker.waiting', { reason: 'existing-picker-stability', timeoutMs: INTELLIGENCE_UI_TIMING.pickerStableMs + 200, stableMs: INTELLIGENCE_UI_TIMING.pickerStableMs });
      await delay(INTELLIGENCE_UI_TIMING.pickerStableMs);
      if (visibleIntelligencePickerContent() === existing) {
        diagnostic('intelligence.picker.opened', { method: 'already-open', elapsedMs: INTELLIGENCE_UI_TIMING.pickerStableMs });
        return existing;
      }
    }
    const candidates = intelligencePickerTriggerCandidates();
    const deadline = Date.now() + 7_000;
    diagnostic('intelligence.picker.candidates', {
      count: candidates.length,
      candidates: candidates.slice(0, 12).map((item) => ({ score: item.score, signal: item.signal })),
    });

    for (const [candidateIndex, candidate] of candidates.slice(0, 2).entries()) {
      if (Date.now() >= deadline) break;
      diagnostic('intelligence.picker.candidate.selected', { index: candidateIndex + 1, score: candidate.score, signal: candidate.signal });
      try { candidate.element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
      try { candidate.element.focus?.({ preventScroll: true }); } catch {}
      await delay(INTELLIGENCE_UI_TIMING.focusSettleMs);
      const rect = candidate.element.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const point = { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2) };
      const activations = [
        { name: 'pointer-click', run: () => dispatchSinglePointerClick(candidate.element, point) },
        { name: 'keyboard-enter', run: () => {
          candidate.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          candidate.element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        } },
      ];
      for (const [activationIndex, activation] of activations.entries()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const waitMs = Math.min(INTELLIGENCE_UI_TIMING.pickerOpenWaitMs, remaining);
        const activationStarted = Date.now();
        diagnostic('intelligence.picker.activation', {
          score: candidate.score,
          signal: candidate.signal,
          method: activation.name,
          attempt: activationIndex + 1,
          waitMs,
        });
        try { activation.run(); } catch {}
        diagnostic('intelligence.picker.waiting', { reason: 'open-after-activation', timeoutMs: waitMs, stableMs: INTELLIGENCE_UI_TIMING.pickerStableMs, method: activation.name });
        const content = await waitForStableVisibleElement(
          visibleIntelligencePickerContent,
          waitMs,
          INTELLIGENCE_UI_TIMING.pickerStableMs,
        );
        if (content) {
          diagnostic('intelligence.picker.opened', { score: candidate.score, signal: candidate.signal, method: activation.name, elapsedMs: Date.now() - activationStarted });
          return content;
        }
        diagnostic('intelligence.picker.activation_timeout', { score: candidate.score, signal: candidate.signal, method: activation.name, attempt: activationIndex + 1, elapsedMs: Date.now() - activationStarted });
        if (activationIndex < activations.length - 1) await delay(240);
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(INTELLIGENCE_UI_TIMING.menuCloseSettleMs);
    }
    diagnostic('intelligence.picker.not_found', { candidateCount: candidates.length });
    return null;
  }

  function modelSubmenuOpener(pickerContent) {
    const candidates = Array.from(pickerContent?.querySelectorAll?.('[role="menuitem"]') || []).filter(isVisible);
    return [...candidates].reverse().find((element) => (
      element.hasAttribute('data-has-submenu')
      || element.getAttribute('aria-haspopup') === 'menu'
      || Boolean(element.getAttribute('aria-controls'))
    )) || null;
  }

  function effortOptionsRoot(pickerContent) {
    const directGroups = Array.from(pickerContent?.children || [])
      .filter((element) => element.getAttribute?.('role') === 'group'
        && element.querySelector?.('[role="menuitemradio"]'));
    return directGroups[0] || pickerContent;
  }

  function visibleModelSubmenu(pickerContent, opener = null) {
    const pickerMenu = pickerContent?.closest?.('[role="menu"]') || null;
    const controlledId = opener?.getAttribute?.('aria-controls') || '';
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlled && isVisible(controlled) && controlled.querySelector('[role="menuitemradio"]')) return controlled;

    const openerId = opener?.id || '';
    const menus = Array.from(document.querySelectorAll('[role="menu"]'))
      .filter((menu) => isVisible(menu)
        && menu !== pickerMenu
        && !pickerContent?.contains?.(menu)
        && menu.querySelector('[role="menuitemradio"]'));
    if (openerId) {
      const labelled = menus.find((menu) => menu.getAttribute('aria-labelledby') === openerId);
      if (labelled) return labelled;
    }
    return menus.find((menu) => /gpt|chatgpt|\bo\d\b|model|модел/i.test(visibleText(menu))) || menus[0] || null;
  }

  function modelSubmenuPoint(opener) {
    const rect = opener?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    return { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2) };
  }

  function enterModelSubmenuHover(opener) {
    if (!opener) return;
    try { opener.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
    try { opener.focus?.({ preventScroll: true }); } catch {}
    const point = modelSubmenuPoint(opener);
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
      try { opener.dispatchEvent(new PointerCtor(type, { bubbles: true, pointerType: 'mouse', isPrimary: true, ...point })); } catch {}
    }
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      try { opener.dispatchEvent(new MouseEvent(type, { bubbles: true, ...point })); } catch {}
    }
  }

  function maintainModelSubmenuHover(opener) {
    if (!opener) return;
    const point = modelSubmenuPoint(opener);
    const PointerCtor = window.PointerEvent || window.MouseEvent;
    try { opener.dispatchEvent(new PointerCtor('pointermove', { bubbles: true, pointerType: 'mouse', isPrimary: true, ...point })); } catch {}
    try { opener.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...point })); } catch {}
  }

  async function openModelSubmenu(pickerContent) {
    const opener = modelSubmenuOpener(pickerContent);
    if (!opener) return { submenu: null, opener: null };
    const trigger = intelligenceOptionFromElement(opener).rawText || '';
    diagnostic('model.submenu.search.started', { trigger });
    const existing = visibleModelSubmenu(pickerContent, opener);
    if (existing) {
      diagnostic('model.submenu.waiting', { method: 'already-open', timeoutMs: INTELLIGENCE_UI_TIMING.submenuStableMs + 300, stableMs: INTELLIGENCE_UI_TIMING.submenuStableMs });
      const stable = await waitForStableVisibleElement(
        () => visibleModelSubmenu(pickerContent, opener),
        INTELLIGENCE_UI_TIMING.submenuStableMs + 300,
        INTELLIGENCE_UI_TIMING.submenuStableMs,
      );
      if (stable) {
        diagnostic('model.submenu.opened', { method: 'already-open', count: stable.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
        return { submenu: stable, opener };
      }
    }

    diagnostic('model.submenu.hover.started', { trigger });
    enterModelSubmenuHover(opener);
    await delay(INTELLIGENCE_UI_TIMING.submenuInitialHoverMs);
    const started = Date.now();
    diagnostic('model.submenu.waiting', { method: 'hover', timeoutMs: INTELLIGENCE_UI_TIMING.submenuOpenWaitMs, stableMs: INTELLIGENCE_UI_TIMING.submenuStableMs });
    while (Date.now() - started < INTELLIGENCE_UI_TIMING.submenuOpenWaitMs) {
      const submenu = visibleModelSubmenu(pickerContent, opener);
      if (submenu) {
        const stable = await waitForStableVisibleElement(
          () => visibleModelSubmenu(pickerContent, opener),
          INTELLIGENCE_UI_TIMING.submenuStableMs + 400,
          INTELLIGENCE_UI_TIMING.submenuStableMs,
        );
        if (stable) {
          diagnostic('model.submenu.opened', { method: 'hover', elapsedMs: Date.now() - started, count: stable.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
          return { submenu: stable, opener };
        }
      }
      maintainModelSubmenuHover(opener);
      await delay(INTELLIGENCE_UI_TIMING.submenuPulseMs);
    }

    diagnostic('model.submenu.hover_timeout', { trigger });
    diagnostic('model.submenu.keyboard_retry', { trigger, elapsedMs: Date.now() - started });
    try { opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); } catch {}
    const submenu = await waitForStableVisibleElement(
      () => visibleModelSubmenu(pickerContent, opener),
      900,
      INTELLIGENCE_UI_TIMING.submenuStableMs,
    );
    if (submenu) diagnostic('model.submenu.opened', { method: 'keyboard-arrow-right', count: submenu.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
    return { submenu, opener };
  }

  function collectRadioOptions(root, kind) {
    if (!root?.querySelectorAll) return [];
    const seen = new Set();
    const elements = [];
    const descriptors = [];
    for (const element of Array.from(root.querySelectorAll('[role="menuitemradio"]')).filter(isVisible)) {
      const descriptor = intelligenceOptionFromElement(element);
      const key = normalizeComparable(descriptor.rawText || descriptor.label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      elements.push(element);
      descriptors.push(descriptor);
    }
    return DOM_PARSER.normalizeIntelligenceOptions(kind, descriptors)
      .map((option, index) => ({ ...option, element: elements[index] }));
  }


  async function waitForStableRadioOptions(rootGetter, kind, timeoutMs = 1_200) {
    const started = Date.now();
    diagnostic('intelligence.options.wait.started', { kind, timeoutMs });
    let lastSignature = '';
    let stableSince = 0;
    let lastOptions = [];
    while (Date.now() - started < timeoutMs) {
      const root = typeof rootGetter === 'function' ? rootGetter() : rootGetter;
      const options = collectRadioOptions(root, kind);
      const signature = options.map((option) => `${option.id}|${option.label}|${option.selected ? 1 : 0}`).join('\n');
      if (options.length && signature === lastSignature) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= INTELLIGENCE_UI_TIMING.submenuStableMs) {
          diagnostic('intelligence.options.stable', { kind, count: options.length, elapsedMs: Date.now() - started });
          return options;
        }
      } else {
        lastSignature = signature;
        stableSince = options.length ? Date.now() : 0;
        lastOptions = options;
      }
      await delay(90);
    }
    diagnostic('intelligence.options.timeout', { kind, count: lastOptions.length, elapsedMs: Date.now() - started });
    return lastOptions;
  }

  async function closeIntelligenceMenus(beforeActive = null) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(90);
    if (visibleIntelligencePickerContent() || Array.from(document.querySelectorAll('[role="menu"]')).some(isVisible)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await delay(INTELLIGENCE_UI_TIMING.menuCloseSettleMs);
    try { beforeActive?.focus?.({ preventScroll: true }); } catch {}
  }

  async function readIntelligenceState({ includeModels = true } = {}) {
    diagnostic('intelligence.state.read.started', { includeModels });
    const beforeActive = document.activeElement;
    const pickerContent = await openIntelligencePicker();
    if (!pickerContent) throw new Error('DOM_SCHEMA_CHANGED: intelligence picker content was not found.');

    try {
      const effortsWithElements = collectRadioOptions(effortOptionsRoot(pickerContent), 'effort');
      if (!effortsWithElements.length) throw new Error('DOM_SCHEMA_CHANGED: intelligence effort options were not found.');
      const opener = modelSubmenuOpener(pickerContent);
      const triggerDescriptor = opener ? intelligenceOptionFromElement(opener) : null;
      if (!opener) throw new Error('DOM_SCHEMA_CHANGED: current model submenu trigger was not found.');

      let modelsWithElements = [];
      if (includeModels) {
        const opened = await openModelSubmenu(pickerContent);
        if (opened.submenu) {
          const submenuResolver = () => visibleModelSubmenu(pickerContent, opener) || opened.submenu;
          modelsWithElements = await waitForStableRadioOptions(submenuResolver, 'model');
          if (!modelsWithElements.length) {
            diagnostic('model.submenu.empty_retry', {
              trigger: triggerDescriptor?.rawText || '',
              action: 'read-only-hover-and-rescan',
            });
            // Give a late Radix/React mount one extra read-only window. Do not
            // activate or click the submenu opener again in this state read.
            maintainModelSubmenuHover(opener);
            await delay(INTELLIGENCE_UI_TIMING.verificationRetryMs);
            modelsWithElements = await waitForStableRadioOptions(submenuResolver, 'model');
          }
        }
        if (!modelsWithElements.length) throw new Error('DOM_SCHEMA_CHANGED: transient model submenu was not found or contained no models.');
      }

      const efforts = effortsWithElements.map(({ element, ...option }) => option);
      const rawModels = modelsWithElements.map(({ element, ...option }) => option);
      const modelState = DOM_PARSER.resolveCurrentModel(rawModels, triggerDescriptor);
      const selectedEffort = efforts.find((option) => option.selected) || null;
      diagnostic('intelligence.state.read', {
        efforts: efforts.map((option) => ({ id: option.id, label: option.label, selected: option.selected })),
        models: modelState.models.map((option) => ({ id: option.id, label: option.label, selected: option.selected, checked: option.checked })),
        selectedEffort: selectedEffort?.id || '',
        selectedModel: modelState.current?.label || '',
        modelTrigger: triggerDescriptor?.rawText || '',
      });
      return {
        efforts,
        models: modelState.models,
        selectedEffort,
        selectedModel: modelState.current,
        modelTrigger: modelState.trigger,
        capturedAt: Date.now(),
      };
    } finally {
      await closeIntelligenceMenus(beforeActive);
    }
  }

  async function trySelectIntelligenceOption(label, kind, request) {
    const desired = normalizeComparable(label);
    if (!desired) return { matched: false, clicked: false, alreadySelected: false };
    diagnostic(`${kind}.selection.started`, { requestId: request?.requestId, kind, label });
    const pickerContent = await openIntelligencePicker();
    if (!pickerContent) {
      diagnostic(`${kind}.picker_not_found`, { requestId: request?.requestId, label });
      return { matched: false, clicked: false, alreadySelected: false };
    }

    const beforeActive = document.activeElement;
    let options = [];
    try {
      if (kind === 'model') {
        const opened = await openModelSubmenu(pickerContent);
        options = await waitForStableRadioOptions(
          () => visibleModelSubmenu(pickerContent, opened.opener) || opened.submenu,
          'model',
        );
      } else {
        options = await waitForStableRadioOptions(effortOptionsRoot(pickerContent), 'effort', 900);
      }
      const match = options.find((option) => DOM_PARSER.intelligenceOptionMatches(option, label));
      if (!match) {
        diagnostic(`${kind}.option_not_found_scoped`, {
          requestId: request?.requestId,
          label,
          available: options.map((option) => ({ id: option.id, label: option.label, rawText: option.rawText })),
        });
        return { matched: false, clicked: false, alreadySelected: false };
      }
      if (match.selected) {
        diagnostic(`${kind}.selection.already_selected`, {
          requestId: request?.requestId,
          kind,
          label,
          matchedId: match.id,
          matchedLabel: match.label,
        });
        return { matched: true, clicked: false, alreadySelected: true, option: match };
      }

      await delay(INTELLIGENCE_UI_TIMING.beforeOptionClickMs);
      diagnostic(`${kind}.selection.click`, {
        requestId: request?.requestId,
        kind,
        label,
        matchedId: match.id,
        matchedLabel: match.label,
      });
      match.element.click();
      await delay(INTELLIGENCE_UI_TIMING.selectionSettleMs);
      diagnostic(`${kind}.selection.clicked`, {
        requestId: request?.requestId,
        kind,
        label,
        matchedId: match.id,
        matchedLabel: match.label,
        settleMs: INTELLIGENCE_UI_TIMING.selectionSettleMs,
      });
      return { matched: true, clicked: true, alreadySelected: false, option: match };
    } finally {
      await closeIntelligenceMenus(beforeActive);
    }
  }


  async function handleModelsList(payload) {
    try {
      const state = await readIntelligenceState({ includeModels: true });
      send({ type: 'models.snapshot', commandId: payload.commandId, models: state.models, current: state.selectedModel, intelligence: state });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleEffortsList(payload) {
    try {
      const state = await readIntelligenceState({ includeModels: false });
      send({ type: 'efforts.snapshot', commandId: payload.commandId, efforts: state.efforts, current: state.selectedEffort, intelligence: state });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }



  function handleResponseSnapshotRequest(payload) {
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
        send({ type: 'request.snapshot', commandId, requestId: expectedRequestId, active, generating, activeRequest: status, phase, artifacts: [], answer: '', thinking: '', progress: '', terminal: false, url: location.href, title: document.title, session: getCurrentSession() });
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
          terminal: active ? snapshotTerminalForRequest(snapshot, activeRequest) : DOM_PARSER.isCompletedSnapshot(snapshot, ''),
          domPhase: snapshot.phase || '',
          messageId: snapshot.messageId || '',
          modelSlug: snapshot.modelSlug || '',
          actionBarVisible: Boolean(snapshot.actionBarVisible),
          reasoningHistory: active && Array.isArray(activeRequest?.reasoningHistory)
            ? activeRequest.reasoningHistory
            : (Array.isArray(snapshot.reasoningHistory) ? snapshot.reasoningHistory : []),
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
      const snapshot = readLatestAssistantSnapshot(index);
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

  async function handleComposerAttachmentsClear(payload) {
    try {
      const result = await clearComposerAttachments();
      send({ type: 'composer.attachments.cleared', commandId: payload.commandId, ...result });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function clearComposerAttachments() {
    const root = findComposerRoot();
    const buttons = findAttachmentRemoveButtons(root);
    let removed = 0;
    for (const button of buttons) {
      try {
        button.click();
        removed += 1;
        await delay(120);
      } catch {
        // continue with other candidates
      }
    }
    diagnostic('composer.attachments.clear', { removed });
    return { removed, message: removed ? '' : 'No visible composer attachment remove buttons found' };
  }

  function findComposerRoot() {
    const composer = findComposer();
    if (!composer) return document.body;
    return composer.closest('form') || composer.closest('[data-testid*="composer" i]') || composer.parentElement?.parentElement?.parentElement || document.body;
  }

  function findAttachmentRemoveButtons(root) {
    const candidates = Array.from((root || document.body).querySelectorAll('button, [role="button"]'));
    return candidates.filter((element) => {
      if (!isUsableButton(element)) return false;
      const attrs = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), visibleText(element)].filter(Boolean).join(' ');
      if (!/(remove|delete|clear|close|dismiss|attachment|file|удал|убрать|очист|закры)/i.test(attrs)) return false;
      const lower = attrs.toLowerCase();
      if (/send|submit|voice|microphone|settings|share|regenerate/.test(lower)) return false;
      return true;
    });
  }

  function artifactPreviewShell(container) {
    return container?.querySelector?.('[data-testid="fullscreen-shell-body"]') || container || null;
  }

  function artifactPreviewToolbar(container) {
    const shell = artifactPreviewShell(container);
    return shell?.querySelector?.('[data-testid="popcorn-toolbar"]')
      || shell?.querySelector?.('header')
      || null;
  }

  function artifactPreviewControls(container) {
    const toolbar = artifactPreviewToolbar(container);
    if (!toolbar) return [];
    const actionsRoot = toolbar.querySelector?.('[data-testid="popcorn-toolbar-actions"]') || toolbar;
    return Array.from(actionsRoot.querySelectorAll('a, button, [role="button"]')).filter(isVisible);
  }

  function artifactPreviewHasVisibleLoader(container) {
    const selectors = [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[data-state="loading"]',
      '[data-loading="true"]',
      '[data-testid*="loading" i]',
      '[data-testid*="loader" i]',
      '[data-testid*="spinner" i]',
      '[class*="animate-spin"]',
    ];
    return selectors.some((selector) => Array.from(container?.querySelectorAll?.(selector) || []).some(isVisible));
  }

  function leafTextCandidates(root) {
    if (!root) return [];
    const selector = 'span, h1, h2, h3, [role="heading"]';
    const elements = [
      ...(root.matches?.(selector) ? [root] : []),
      ...Array.from(root.querySelectorAll?.(selector) || []),
    ].filter((element) => !element.querySelector?.(selector));
    return unique(elements.map((element) => normalizeText(element.textContent || '')).filter(Boolean));
  }

  function artifactPreviewTitleMetadata(container) {
    const shell = artifactPreviewShell(container);
    const toolbar = artifactPreviewToolbar(container);
    if (!shell || !toolbar) return { fileNameCandidates: [], displayTitleCandidates: [], formatLabels: [] };

    const fileNameCandidates = [];
    const displayTitleCandidates = [];
    const formatLabels = [];
    const popcornTitle = toolbar.querySelector?.('[data-testid="popcorn-file-title"]') || null;
    if (popcornTitle) {
      const leaves = leafTextCandidates(popcornTitle);
      if (leaves[0]) displayTitleCandidates.push(leaves[0]);
      if (leaves.length > 1) formatLabels.push(...leaves.slice(1));
    }

    const titleRoots = [
      ...Array.from(toolbar.querySelectorAll?.('[data-testid*="file-title" i]') || []),
      ...Array.from(toolbar.querySelectorAll?.('h1, h2, h3, [role="heading"]') || []),
      ...Array.from(toolbar.querySelectorAll?.('[class*="text-token-text-primary"][class*="truncate"]') || []),
    ];
    for (const root of titleRoots) {
      for (const text of leafTextCandidates(root)) {
        const extracted = DOM_PARSER.extractFileLikeNames(text);
        if (extracted.length) fileNameCandidates.push(...extracted);
        else if (text.length <= 220 && !formatLabels.includes(text)) displayTitleCandidates.push(text);
      }
      const rootText = normalizeText(root.textContent || '');
      const extracted = DOM_PARSER.extractFileLikeNames(rootText);
      if (extracted.length) fileNameCandidates.push(...extracted);
    }

    return {
      fileNameCandidates: unique(fileNameCandidates),
      displayTitleCandidates: unique(displayTitleCandidates),
      formatLabels: unique(formatLabels),
    };
  }

  function artifactPreviewFileNameCandidates(container) {
    return artifactPreviewTitleMetadata(container).fileNameCandidates;
  }

  function artifactPreviewContainerKind(container) {
    if (container?.matches?.('[role="dialog"], [role="alertdialog"]')) return 'dialog';
    if (container?.matches?.('[slot="content"]')) return 'slot-content';
    return 'unknown';
  }

  function artifactPreviewIdentityContext(artifact) {
    const expectedFormat = DOM_PARSER.artifactFormatToken({
      name: artifact.name || artifact.fileName || '',
      extension: artifact.extension || '',
      mime: artifact.mime || '',
    });
    if (!expectedFormat) return { expectedFormat: '', allowFormatOnly: false, sameFormatCount: 0 };
    const root = artifactSourceRoot(artifact);
    if (!root) return { expectedFormat, allowFormatOnly: false, sameFormatCount: 0 };
    const seen = new Set();
    const sameFormat = collectArtifactsFromNode(root, { turnKey: artifact.sourceTurnKey || '' })
      .filter((item) => item.phase === 'READY')
      .filter((item) => {
        const key = item.id || `${item.name || ''}:${item.blockStart || ''}:${item.blockEnd || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return DOM_PARSER.artifactFormatToken({
          name: item.name || item.fileName || '',
          extension: item.extension || '',
          mime: item.mime || '',
        }) === expectedFormat;
      });
    return {
      expectedFormat,
      allowFormatOnly: sameFormat.length === 1,
      sameFormatCount: sameFormat.length,
    };
  }

  function artifactPreviewDescriptor(container, artifact, identityContext = null) {
    const controls = artifactPreviewControls(container);
    const desiredName = artifact.name || artifact.fileName || '';
    const desiredComparable = normalizeComparable(desiredName);
    const previewRoots = Array.from(container?.querySelectorAll?.('[id^="artifact-text-preview-"]') || []);
    const previewIds = previewRoots.map((element) => element.id || '').filter(Boolean);
    const toolbar = artifactPreviewToolbar(container);
    const heading = normalizeText(toolbar?.querySelector?.('h1, h2, h3, [role="heading"]')?.textContent || '');
    const dialogLabel = container?.getAttribute?.('aria-label') || '';
    const titleMetadata = artifactPreviewTitleMetadata(container);
    const context = identityContext || artifactPreviewIdentityContext(artifact);
    const controlDescriptors = controls.map((element) => ({
      tagName: element.tagName || '',
      testId: element.getAttribute?.('data-testid') || '',
      ariaLabel: element.getAttribute?.('aria-label') || '',
      title: element.getAttribute?.('title') || '',
      hasDownloadAttribute: element.hasAttribute?.('download') || false,
    }));
    const plan = DOM_PARSER.planArtifactPreviewDownload({
      desiredName,
      desiredExtension: artifact.extension || '',
      desiredMime: artifact.mime || '',
      dialogLabel,
      heading,
      fileNameCandidates: titleMetadata.fileNameCandidates,
      displayTitleCandidates: titleMetadata.displayTitleCandidates,
      formatLabels: titleMetadata.formatLabels,
      previewIds,
      controls: controlDescriptors,
      allowFormatOnly: context.allowFormatOnly,
    });
    const matchingTextRoot = previewRoots.find((element) => {
      const name = DOM_PARSER.artifactPreviewNameFromId(element.id || '');
      return normalizeComparable(name) === desiredComparable;
    }) || null;
    const textContentNode = matchingTextRoot?.querySelector?.('.cm-content code, pre code, code') || null;
    const action = plan.ok && Number.isInteger(plan.downloadControlIndex)
      ? controls[plan.downloadControlIndex] || null
      : null;
    const closeAction = plan.ok && Number.isInteger(plan.closeControlIndex)
      ? controls[plan.closeControlIndex] || null
      : controls.find((element, index) => DOM_PARSER.artifactPreviewActionKind(controlDescriptors[index]) === 'close') || null;
    const loaderVisible = artifactPreviewHasVisibleLoader(container);
    const readiness = DOM_PARSER.artifactPreviewReadiness({
      plan,
      downloadControlUsable: isUsableButton(action),
      textContentMounted: Boolean(textContentNode),
      loaderVisible,
    });
    const observedNames = [
      dialogLabel,
      heading,
      ...titleMetadata.fileNameCandidates,
      ...titleMetadata.displayTitleCandidates,
      ...previewIds.map((id) => DOM_PARSER.artifactPreviewNameFromId(id)),
    ].map(normalizeComparable).filter(Boolean);
    return {
      container,
      dialog: container,
      containerKind: artifactPreviewContainerKind(container),
      controls,
      controlDescriptors,
      previewIds,
      heading,
      dialogLabel,
      fileNameCandidates: titleMetadata.fileNameCandidates,
      displayTitleCandidates: titleMetadata.displayTitleCandidates,
      formatLabels: titleMetadata.formatLabels,
      observedNames,
      plan,
      action,
      closeAction,
      matchingTextRoot,
      textContentNode,
      loaderVisible,
      readiness,
      filenameMatched: Boolean(plan.ok),
      identityContext: context,
    };
  }

  function visibleArtifactPreviewContainers() {
    const isPreviewLike = (container) => {
      const metadata = artifactPreviewTitleMetadata(container);
      return Boolean(
        container.querySelector?.('[data-testid="fullscreen-shell-body"]')
        || container.querySelector?.('[data-testid="popcorn-toolbar"]')
        || container.querySelector?.('[id^="artifact-text-preview-"]')
        || metadata.fileNameCandidates.length
        || metadata.displayTitleCandidates.length,
      );
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .filter(isVisible)
      .filter(isPreviewLike);
    const slots = Array.from(document.querySelectorAll('[slot="content"]'))
      .filter(isVisible)
      .filter((container) => !dialogs.some((dialog) => dialog.contains(container)))
      .filter(isPreviewLike);
    return [...dialogs, ...slots];
  }

  async function waitForArtifactPreview(artifact, containersBefore = new Set(), timeoutMs = 45_000, control = null, previewState = null, options = {}) {
    const started = Date.now();
    const identityContext = artifactPreviewIdentityContext(artifact);
    let lastDiagnosticKey = '';
    let lastDiagnosticAt = 0;
    while (Date.now() - started < timeoutMs) {
      if (control?.cancelled) throw new Error('Artifact preview readiness wait cancelled');
      const candidates = visibleArtifactPreviewContainers()
        .filter((container) => !containersBefore.has(container))
        .map((container) => artifactPreviewDescriptor(container, artifact, identityContext));
      const likely = candidates.find((candidate) => candidate.filenameMatched)
        || (candidates.length === 1 ? candidates[0] : null);
      if (likely && previewState) previewState.preview = likely;
      const match = candidates.find((candidate) => candidate.filenameMatched && candidate.readiness.ready);
      if (match) {
        if (previewState) previewState.preview = match;
        diagnostic('artifact.preview.ready', {
          artifactId: artifact.id || '',
          name: artifact.name || '',
          elapsedMs: Date.now() - started,
          source: match.plan.source || '',
          closeSource: match.plan.closeSource || '',
          containerKind: match.containerKind,
          controlCount: match.controls.length,
          previewIds: match.previewIds,
          loaderVisible: match.loaderVisible,
          identitySource: match.plan.identitySource || '',
          expectedFormat: match.plan.expectedFormat || '',
          observedFormats: match.plan.observedFormats || [],
          displayTitles: match.plan.displayTitles || [],
          allowFormatOnly: Boolean(match.identityContext?.allowFormatOnly),
          sameFormatCount: match.identityContext?.sameFormatCount || 0,
        });
        return { status: 'ready', preview: match };
      }

      if (options.returnForeignPreview !== false) {
        const foreign = candidates.find((candidate) => !candidate.filenameMatched && candidate.observedNames.length && candidate.closeAction);
        if (foreign) {
          diagnostic('artifact.preview.foreign_detected', {
            artifactId: artifact.id || '',
            name: artifact.name || '',
            elapsedMs: Date.now() - started,
            containerKind: foreign.containerKind,
            observedNames: foreign.observedNames,
            closeSource: foreign.plan.closeSource || '',
          });
          return { status: 'foreign', preview: foreign };
        }
      }

      const diagnosticState = likely ? {
        reason: likely.readiness.reason || likely.plan.reason || 'preview_not_ready',
        filenameMatched: likely.filenameMatched,
        containerKind: likely.containerKind,
        heading: likely.heading,
        fileNameCandidates: likely.fileNameCandidates,
        previewIds: likely.previewIds,
        controlCount: likely.controls.length,
        controlLabels: likely.controlDescriptors.map((item) => ({ testId: item.testId, ariaLabel: item.ariaLabel, title: item.title })),
        loaderVisible: likely.loaderVisible,
        textContentMounted: Boolean(likely.textContentNode),
        displayTitleCandidates: likely.displayTitleCandidates,
        formatLabels: likely.formatLabels,
        expectedFormat: likely.plan.expectedFormat || likely.identityContext?.expectedFormat || '',
        observedFormats: likely.plan.observedFormats || [],
        allowFormatOnly: Boolean(likely.identityContext?.allowFormatOnly),
        sameFormatCount: likely.identityContext?.sameFormatCount || 0,
      } : {
        reason: candidates.length ? 'matching_preview_not_identified' : 'preview_container_not_visible',
        candidateCount: candidates.length,
      };
      const diagnosticKey = JSON.stringify(diagnosticState);
      if (diagnosticKey !== lastDiagnosticKey || Date.now() - lastDiagnosticAt >= 1_000) {
        diagnostic('artifact.preview.waiting', {
          artifactId: artifact.id || '',
          name: artifact.name || '',
          elapsedMs: Date.now() - started,
          ...diagnosticState,
        });
        lastDiagnosticKey = diagnosticKey;
        lastDiagnosticAt = Date.now();
      }
      await delay(150);
    }
    diagnostic('artifact.preview.readiness_timeout', {
      artifactId: artifact.id || '',
      name: artifact.name || '',
      timeoutMs,
    });
    return { status: 'timeout', preview: previewState?.preview || null };
  }

  async function waitForLateArtifactPreview(artifact, containersBefore, timeoutMs = 5_000) {
    const started = Date.now();
    const identityContext = artifactPreviewIdentityContext(artifact);
    while (Date.now() - started < timeoutMs) {
      const match = visibleArtifactPreviewContainers()
        .filter((container) => !containersBefore.has(container))
        .map((container) => artifactPreviewDescriptor(container, artifact, identityContext))
        .find((candidate) => candidate.filenameMatched && isUsableButton(candidate.closeAction));
      if (match) {
        diagnostic('artifact.preview.late_detected', {
          artifactId: artifact.id || '',
          name: artifact.name || '',
          elapsedMs: Date.now() - started,
          containerKind: match.containerKind,
          closeSource: match.plan.closeSource || '',
        });
        return match;
      }
      await delay(150);
    }
    diagnostic('artifact.preview.late_not_seen', {
      artifactId: artifact.id || '',
      name: artifact.name || '',
      timeoutMs,
    });
    return null;
  }

  function textArtifactPreviewContent(preview) {
    if (!preview?.plan?.textPreview) return null;
    const code = preview.textContentNode
      || preview.matchingTextRoot?.querySelector?.('.cm-content code, pre code, code')
      || null;
    if (!code) return null;
    return String(code.textContent || '');
  }

  async function materializeArtifactPreview(artifact, containersBefore, control, previewState) {
    const configuredTimeoutMs = Number(CONFIG.artifactDownloadTimeoutMs) || 45_000;
    const previewTimeoutMs = Math.min(30_000, Math.max(10_000, Math.floor(configuredTimeoutMs * 0.67)));
    const outcome = await waitForArtifactPreview(artifact, containersBefore, previewTimeoutMs, control, previewState, { returnForeignPreview: true });

    if (outcome?.status === 'foreign' && outcome.preview) {
      previewState.preview = outcome.preview;
      await closeArtifactPreview(outcome.preview);
      previewState.preview = null;
      const observed = outcome.preview.observedNames?.filter(Boolean).join(', ') || 'unknown file';
      const error = new Error(`Artifact action opened a different file preview (${observed}) while ${artifact.name || artifact.id || 'artifact'} was requested`);
      error.artifactFatal = true;
      error.code = 'ARTIFACT_ACTION_TARGET_MISMATCH';
      diagnostic('artifact.action.target_mismatch', {
        artifactId: artifact.id || '',
        expectedName: artifact.name || artifact.fileName || '',
        observedNames: outcome.preview.observedNames || [],
        containerKind: outcome.preview.containerKind || '',
      });
      throw error;
    }

    if (outcome?.status !== 'ready' || !outcome.preview) {
      throw new Error(`Artifact preview was not ready within ${previewTimeoutMs}ms`);
    }
    const preview = outcome.preview;
    previewState.preview = preview;
    const action = preview.action || preview.controls[preview.plan.downloadControlIndex] || null;
    if (!isUsableButton(action)) throw new Error(`Artifact preview download control is not ready for ${artifact.name || artifact.id || 'artifact'}`);

    const downloadNameAliases = Array.from(preview.plan.downloadNameAliases || []).filter(Boolean);
    if (downloadNameAliases.length && typeof control?.addExpectedNames === 'function') {
      await control.addExpectedNames(downloadNameAliases);
      diagnostic('artifact.preview.download_aliases_added', {
        artifactId: artifact.id || '',
        name: artifact.name || '',
        aliases: downloadNameAliases,
        identitySource: preview.plan.identitySource || '',
      });
    }

    action.click();
    diagnostic('artifact.preview.download_clicked', {
      artifactId: artifact.id || '',
      name: artifact.name || '',
      source: preview.plan.source || '',
      closeSource: preview.plan.closeSource || '',
      containerKind: preview.containerKind,
      controlCount: preview.controls.length,
      previewIds: preview.previewIds,
    });

    // Browser/page capture normally wins immediately. Text previews retain a
    // byte-producing DOM fallback so a UI-only preview cannot stall the whole
    // artifact fetch for the browser-download timeout.
    if (!preview.plan.textPreview) throw new Error('Artifact preview download was clicked; waiting for browser capture');
    const fallbackStarted = Date.now();
    while (Date.now() - fallbackStarted < 2_500) {
      if (control?.cancelled) throw new Error('Artifact preview materialization cancelled');
      await delay(100);
    }
    if (control?.cancelled) throw new Error('Artifact preview materialization cancelled');
    const text = textArtifactPreviewContent(preview);
    if (text == null) throw new Error('Text artifact preview did not expose readable content');
    const bytes = new TextEncoder().encode(text);
    return {
      name: artifact.name || artifact.fileName || 'artifact.txt',
      mime: artifact.mime || 'text/plain',
      size: bytes.byteLength,
      contentBase64: arrayBufferToBase64(bytes.buffer),
      captureSource: 'text-preview-dom',
    };
  }

  function currentArtifactPreviewCloseAction(preview) {
    const container = preview?.container || preview?.dialog || null;
    if (!container) return null;
    const stable = container.querySelector?.('button[data-testid="close-button"]');
    if (isUsableButton(stable)) return stable;
    const controls = artifactPreviewControls(container);
    return controls.find((element) => DOM_PARSER.artifactPreviewActionKind({
      tagName: element.tagName || '',
      testId: element.getAttribute?.('data-testid') || '',
      ariaLabel: element.getAttribute?.('aria-label') || '',
      title: element.getAttribute?.('title') || '',
      hasDownloadAttribute: element.hasAttribute?.('download') || false,
    }) === 'close') || null;
  }

  async function closeArtifactPreview(preview) {
    const container = preview?.container || preview?.dialog || null;
    if (!container || !isVisible(container)) return;

    let closeSource = '';
    const close = currentArtifactPreviewCloseAction(preview) || preview.closeAction || null;
    if (isUsableButton(close)) {
      closeSource = close.getAttribute?.('data-testid') === 'close-button' ? 'stable_close_testid' : 'localized_close_label';
      try { close.click(); } catch {}
      for (let attempt = 0; attempt < 20 && isVisible(container); attempt += 1) await delay(100);
    }

    if (isVisible(container)) {
      closeSource ||= 'escape_fallback';
      try { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
      for (let attempt = 0; attempt < 20 && isVisible(container); attempt += 1) await delay(100);
    }

    if (isVisible(container)) {
      const delayedCloseStarted = Date.now();
      while (Date.now() - delayedCloseStarted < 8_000 && isVisible(container)) {
        const delayedClose = currentArtifactPreviewCloseAction(preview);
        if (isUsableButton(delayedClose)) {
          closeSource = delayedClose.getAttribute?.('data-testid') === 'close-button' ? 'stable_close_testid_delayed' : 'localized_close_label_delayed';
          try { delayedClose.click(); } catch {}
        }
        await delay(150);
      }
    }

    const closed = !isVisible(container);
    diagnostic('artifact.preview.closed', {
      source: preview.plan?.source || '',
      closeSource,
      containerKind: preview.containerKind || artifactPreviewContainerKind(container),
      closed,
    });
    if (!closed) throw new Error('Artifact preview remained open after download materialization');
  }

  function isTextLikeArtifact(artifact) {
    return DOM_PARSER.isTextLikeArtifactDescriptor(artifact);
  }

  async function closeVisibleArtifactPreviewsBeforeAction(artifact) {
    const visible = visibleArtifactPreviewContainers();
    const identityContext = artifactPreviewIdentityContext(artifact);
    for (const container of visible) {
      const preview = artifactPreviewDescriptor(container, artifact, identityContext);
      if (!preview.closeAction && !currentArtifactPreviewCloseAction(preview)) continue;
      diagnostic('artifact.preview.preexisting_detected', {
        artifactId: artifact.id || '',
        name: artifact.name || '',
        filenameMatched: preview.filenameMatched,
        observedNames: preview.observedNames,
        containerKind: preview.containerKind,
      });
      await closeArtifactPreview(preview);
    }
  }

  async function handleArtifactFetch(payload) {
    const artifact = { ...(payload.artifact || {}) };
    const commandId = payload.commandId;
    try {
      const initialUrl = artifact.downloadUrl || artifact.url || artifact.src || '';
      const needsAction = (!initialUrl && ['action', 'canvas', 'file'].includes(artifact.kind)) || isBrowserOnlyArtifactUrl(initialUrl);
      if (needsAction) {
        const materialized = await enqueueArtifactAction(() => materializeArtifactAction(artifact));
        await streamArtifactPayload(commandId, artifact, materialized);
        return;
      }
      if (!initialUrl) throw new Error('Artifact has no downloadable URL or scoped download action');
      await streamArtifactData(commandId, artifact, initialUrl);
    } catch (err) {
      diagnostic('artifact.fetch.failed', { artifactId: artifact.id || '', name: artifact.name || '', message: err.message || String(err) });
      send({ type: 'command.error', commandId, message: err.message || String(err) });
    }
  }

  async function cancelBackgroundDownloadCapture(captureId, reason = 'another capture path completed') {
    if (!captureId || CONFIG.transport !== 'extension' || !extensionPort) return { captureId, cancelled: false, missing: true };
    return await extensionRequest('bridge.download.capture.cancel', { captureId, reason }, 5_000).catch(() => null);
  }

  async function releaseBackgroundDownloadCapture(captureId, reason = 'another capture path completed', graceMs = 1_800) {
    if (!captureId || CONFIG.transport !== 'extension' || !extensionPort) return { captureId, cancelled: false, missing: true };
    return await extensionRequest('bridge.download.capture.release', { captureId, reason, graceMs }, Math.max(5_000, graceMs + 2_000)).catch(() => null);
  }

  function materializedBrowserDownload(download = {}, artifact = {}) {
    return {
      filePath: download.filename,
      filename: download.filename,
      name: download.name || artifact.name,
      mime: download.mime || artifact.mime,
      size: download.fileSize || download.bytesReceived || 0,
      downloadId: download.id,
      downloadUrl: download.url || download.finalUrl || '',
      browserDownloadStartTime: download.startTime || '',
      browserDownloadEndTime: download.endTime || '',
      browserCaptureStartedAt: download.captureStartedAt || 0,
      browserCapturedAt: download.capturedAt || 0,
      browserExpectedNames: Array.isArray(download.expectedNames) ? download.expectedNames : [],
      captureSource: 'chrome-downloads',
    };
  }

  async function materializePageArtifactCandidate(candidate, artifact) {
    if (candidate?.blob instanceof Blob) {
      const buffer = await candidate.blob.arrayBuffer();
      return {
        name: candidate.downloadName || artifact.name || 'artifact',
        mime: candidate.mime || candidate.blob.type || artifact.mime || 'application/octet-stream',
        size: candidate.blob.size || buffer.byteLength,
        contentBase64: arrayBufferToBase64(buffer),
        captureSource: 'page-blob',
        downloadUrl: candidate.url || '',
      };
    }
    const url = String(candidate?.url || '');
    if (!url) throw new Error('Page artifact capture did not expose Blob data or URL');
    const data = await fetchArtifactData(url, {
      ...artifact,
      name: candidate.downloadName || artifact.name,
      mime: candidate.mime || artifact.mime,
    });
    return { ...data, captureSource: 'page-url', downloadUrl: url };
  }

  async function materializeArtifactAction(artifact) {
    const initialSourceRoot = artifactSourceRoot(artifact) || document.body;
    const before = new Map(collectArtifactsFromNode(initialSourceRoot, { turnKey: artifact.sourceTurnKey || '' })
      .map((item) => [item.id, item.downloadUrl || item.url || item.src || '']));
    const timeoutMs = Math.min(60_000, Math.max(15_000, Number(CONFIG.artifactDownloadTimeoutMs) || 45_000));
    const startedAt = Date.now();

    // Finish any already-visible preview before resolving the next artifact.
    // This is a state wait, not a blind retry of the file action.
    await closeVisibleArtifactPreviewsBeforeAction(artifact);
    const containersBeforeAction = new Set(visibleArtifactPreviewContainers());
    const previewState = { preview: null };

    let pageCapture = null;
    try {
      pageCapture = await armPageArtifactCapture(artifact, timeoutMs);
      diagnostic('artifact.page_capture.armed', { artifactId: artifact.id, captureId: pageCapture.captureId, timeoutMs });
    } catch (err) {
      diagnostic('artifact.page_capture.unavailable', { artifactId: artifact.id, message: err.message || String(err) });
    }

    let browserCapture = null;
    let browserDownloadPromise = null;
    let browserCaptureReleased = false;
    if (CONFIG.transport === 'extension' && extensionPort) {
      try {
        browserCapture = await extensionRequest('bridge.download.capture.begin', {
          timeoutMs,
          expectedName: artifact.name || artifact.fileName || '',
          artifact: {
            id: artifact.id,
            name: artifact.name,
            kind: artifact.kind,
            text: artifact.text,
            actionLabel: artifact.actionLabel,
            sourceTurnKey: artifact.sourceTurnKey || '',
          },
        }, 5_000);
        diagnostic('artifact.download_capture.armed', { artifactId: artifact.id, captureId: browserCapture.captureId, timeoutMs });
      } catch (err) {
        diagnostic('artifact.download_capture.unavailable', { artifactId: artifact.id, message: err.message || String(err) });
      }
    }

    let rejectFatal = null;
    const materializationControl = {
      cancelled: false,
      fatal: new Promise((_, reject) => { rejectFatal = reject; }),
      async addExpectedNames(expectedNames = []) {
        const names = Array.from(expectedNames || []).filter(Boolean);
        if (!names.length) return;
        pageCapture?.addExpectedNames?.(names);
        if (browserCapture?.captureId && CONFIG.transport === 'extension' && extensionPort) {
          await extensionRequest('bridge.download.capture.add_expected_names', {
            captureId: browserCapture.captureId,
            expectedNames: names,
          }, 5_000).catch((err) => {
            diagnostic('artifact.download_capture.alias_update_failed', {
              artifactId: artifact.id || '',
              captureId: browserCapture.captureId,
              message: err.message || String(err),
            });
          });
        }
      },
    };

    const addAttempt = (attempts, source, promise) => {
      attempts.push(Promise.resolve(promise).catch((err) => {
        diagnostic('artifact.materialization_path.failed', {
          artifactId: artifact.id || '',
          name: artifact.name || artifact.fileName || '',
          source,
          elapsedMs: Date.now() - startedAt,
          fatal: Boolean(err?.artifactFatal),
          message: err?.message || String(err),
        });
        if (err?.artifactFatal) rejectFatal?.(err);
        throw err;
      }));
    };

    try {
      const actionWaitMs = Math.min(8_000, Math.max(3_000, Math.floor(timeoutMs * 0.18)));
      const actionStartedAt = Date.now();
      let backoffMs = 100;
      let lastError = null;
      let resolvedAction = null;

      while (Date.now() - actionStartedAt < actionWaitMs) {
        if (materializationControl.cancelled) throw new Error('Artifact action wait cancelled');
        try {
          resolvedAction = findArtifactActionButton(artifact, { withResolution: true });
          if (resolvedAction && isUsableButton(resolvedAction.element)) break;
          lastError = new Error('exact filename-bound artifact action is not currently usable');
        } catch (err) {
          lastError = err;
        }
        await delay(backoffMs);
        backoffMs = Math.min(1_000, Math.ceil(backoffMs * 1.7));
      }

      if (!resolvedAction || !isUsableButton(resolvedAction.element)) {
        throw new Error(`Exact artifact action did not become ready within ${actionWaitMs}ms for ${artifact.name || artifact.id || 'artifact'}${lastError ? `: ${lastError.message || lastError}` : ''}`);
      }

      diagnostic('artifact.action.resolved', {
        artifactId: artifact.id || '',
        expectedName: artifact.name || artifact.fileName || '',
        candidateName: resolvedAction.descriptor?.name || '',
        exactName: Boolean(resolvedAction.selection?.exactName),
        locatorIdentity: Boolean(resolvedAction.selection?.locatorIdentity),
        score: resolvedAction.selection?.score || 0,
        selectorHintMatched: Boolean(resolvedAction.descriptor?.selectorMatched),
        waitedMs: Date.now() - actionStartedAt,
      });
      resolvedAction.element.click();
      diagnostic('artifact.action.clicked', {
        artifactId: artifact.id || '',
        expectedName: artifact.name || artifact.fileName || '',
        candidateName: resolvedAction.descriptor?.name || '',
        sourceTurnKey: artifact.sourceTurnKey || '',
        waitedMs: Date.now() - actionStartedAt,
      });

      const attempts = [];
      addAttempt(attempts, 'preview', materializeArtifactPreview(
        artifact,
        containersBeforeAction,
        materializationControl,
        previewState,
      ));
      if (pageCapture) {
        addAttempt(attempts, 'page-capture', pageCapture.wait.then((candidate) => materializePageArtifactCandidate(candidate, artifact)));
      }
      addAttempt(attempts, 'dom-url', waitForMaterializedArtifactData(
        artifact,
        before,
        initialSourceRoot,
        Math.min(15_000, timeoutMs),
        materializationControl,
      ));
      if (browserCapture?.captureId) {
        browserDownloadPromise = extensionRequest(
          'bridge.download.capture.wait',
          { captureId: browserCapture.captureId, timeoutMs },
          timeoutMs + 2_000,
        ).then((download) => materializedBrowserDownload(download, artifact));
        addAttempt(attempts, 'chrome-downloads', browserDownloadPromise);
      }

      let result = await Promise.race([
        Promise.any(attempts),
        materializationControl.fatal,
      ]);

      // A direct page/preview path can expose bytes before Chrome reports the
      // download started by the same click. Stop all remaining click paths,
      // then give the already-armed browser capture a short atomic grace
      // window. If a download has received a chrome.downloads id, it becomes
      // authoritative: only that path carries enough identity to import and
      // remove the exact source file from Downloads safely.
      if (result.captureSource !== 'chrome-downloads' && browserCapture?.captureId && browserDownloadPromise) {
        materializationControl.cancelled = true;
        const release = await releaseBackgroundDownloadCapture(
          browserCapture.captureId,
          `${result.captureSource || 'direct'} materialization completed`,
          1_800,
        );
        if (release?.bound) {
          diagnostic('artifact.download_capture.adopted', {
            artifactId: artifact.id || '',
            captureId: browserCapture.captureId,
            downloadId: release.item?.id ?? release.result?.id ?? null,
            directSource: result.captureSource || 'direct',
          });
          result = await browserDownloadPromise;
          browserCaptureReleased = true;
        } else {
          browserCaptureReleased = Boolean(release?.cancelled || release?.missing);
          diagnostic('artifact.download_capture.released_unbound', {
            artifactId: artifact.id || '',
            captureId: browserCapture.captureId,
            directSource: result.captureSource || 'direct',
            cancelled: Boolean(release?.cancelled),
          });
        }
      } else if (result.captureSource === 'chrome-downloads') {
        browserCaptureReleased = true;
      }
      diagnostic('artifact.materialized', {
        artifactId: artifact.id,
        expectedName: artifact.name || artifact.fileName || '',
        name: result.name || artifact.name || '',
        source: result.captureSource || 'dom',
        size: result.size || 0,
        elapsedMs: Date.now() - startedAt,
        hasFilePath: Boolean(result.filePath || result.filename),
        hasContent: Boolean(result.contentBase64),
      });

      // A page URL capture can finish slightly before a text preview mounts.
      // Observe that narrow condition briefly, then move on; the next artifact
      // also closes any pre-existing preview before its own exact action click.
      const needsLatePreviewCleanup = DOM_PARSER.shouldWaitForLateArtifactPreview({
        artifact,
        result,
        previewObserved: Boolean(previewState.preview),
      });
      if (needsLatePreviewCleanup) {
        materializationControl.cancelled = true;
        pageCapture?.cancel?.('direct text artifact capture completed');
        const latePreview = await waitForLateArtifactPreview(artifact, containersBeforeAction, 5_000);
        if (latePreview) {
          previewState.preview = latePreview;
          await closeArtifactPreview(latePreview);
          previewState.preview = null;
        }
      }
      return result;
    } catch (err) {
      // A preview/DOM path may fail after the click even though Chrome has
      // already accepted the exact same download. Recover through the bound
      // chrome.downloads capture so the bridge can import and safely remove
      // the physical source instead of leaving an unowned file behind.
      if (!browserCaptureReleased && browserCapture?.captureId && browserDownloadPromise) {
        materializationControl.cancelled = true;
        const release = await releaseBackgroundDownloadCapture(
          browserCapture.captureId,
          'recovering bound download after materialization error',
          1_800,
        );
        if (release?.bound) {
          diagnostic('artifact.download_capture.recovered_after_error', {
            artifactId: artifact.id || '',
            captureId: browserCapture.captureId,
            downloadId: release.item?.id ?? release.result?.id ?? null,
            materializationError: err?.message || String(err),
          });
          browserCaptureReleased = true;
          return await browserDownloadPromise;
        }
        browserCaptureReleased = Boolean(release?.cancelled || release?.missing);
      }
      const messages = Array.isArray(err?.errors)
        ? err.errors.map((item) => item?.message || String(item))
        : [err?.message || String(err)];
      throw new Error(`Artifact materialization failed after ${Date.now() - startedAt}ms: ${messages.join('; ')}`);
    } finally {
      materializationControl.cancelled = true;
      pageCapture?.cancel?.('materialization finished');
      if (!browserCaptureReleased) {
        const release = await releaseBackgroundDownloadCapture(browserCapture?.captureId, 'materialization finished', 1_000);
        if (release?.bound) {
          diagnostic('artifact.download_capture.bound_after_materialization', {
            artifactId: artifact.id || '',
            captureId: browserCapture?.captureId || '',
            downloadId: release.item?.id ?? release.result?.id ?? null,
          });
        }
      }
      await closeArtifactPreview(previewState.preview);
    }
  }

  function artifactSourceRoot(artifact) {
    if (!artifact?.sourceTurnKey) return null;
    return findTurnByKey(artifact.sourceTurnKey) || null;
  }

  async function waitForMaterializedArtifactData(artifact, before, root, timeoutMs = 20_000, control = null) {
    const started = Date.now();
    const desiredName = normalizeComparable(artifact.name || artifact.fileName || '');
    while (Date.now() - started < timeoutMs) {
      if (control?.cancelled) throw new Error('Artifact DOM materialization cancelled');
      await delay(250);
      if (control?.cancelled) throw new Error('Artifact DOM materialization cancelled');
      const currentRoot = artifactSourceRoot(artifact) || root;
      const candidates = collectArtifactsFromNode(currentRoot, { turnKey: artifact.sourceTurnKey || '' })
        .filter((item) => item.phase === 'READY' && (item.downloadUrl || item.url || item.src));
      const ranked = candidates
        .map((item) => {
          const url = item.downloadUrl || item.url || item.src || '';
          const oldUrl = before.get(item.id) || '';
          let score = url && url !== oldUrl ? 20 : 0;
          const candidateName = normalizeComparable(item.name || '');
          if (item.id === artifact.id) score += 100;
          if (desiredName && candidateName === desiredName) score += 80;
          else if (desiredName && (candidateName.includes(desiredName) || desiredName.includes(candidateName))) score += 30;
          return { item, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);
      if (!ranked.length) continue;
      const matched = ranked[0].item;
      const url = matched.downloadUrl || matched.url || matched.src || '';
      const data = await fetchArtifactData(url, { ...artifact, name: matched.name || artifact.name, mime: matched.mime || artifact.mime });
      return { ...data, captureSource: 'dom-url', downloadUrl: url };
    }
    throw new Error('Artifact action did not expose a readable URL in its assistant turn');
  }

  function artifactActionCandidateDescriptor(element, artifact, root, selectorMatched = false) {
    const locator = artifactLocatorMeta(element, root);
    const href = element?.href || element?.getAttribute?.('href') || '';
    return {
      name: artifactFileName(element, root, href),
      fileName: artifactFileName(element, root, href),
      blockStart: locator.blockStart,
      blockEnd: locator.blockEnd,
      blockTestId: locator.blockTestId,
      actionOrdinal: locator.actionOrdinal,
      actionTag: locator.actionTag,
      actionRole: locator.actionRole,
      actionTestId: locator.actionTestId,
      actionAriaLabel: locator.actionAriaLabel,
      selectorMatched,
    };
  }

  function artifactActionCandidateScore(element, artifact, root, selectorMatched = false) {
    if (!element || !isVisible(element) || isExcludedArtifactAction(element)) return -Infinity;
    return DOM_PARSER.scoreArtifactActionCandidate(
      artifact,
      artifactActionCandidateDescriptor(element, artifact, root, selectorMatched),
    ).score;
  }

  function findArtifactActionButton(artifact, options = {}) {
    const root = artifactSourceRoot(artifact) || document.body;
    if (artifact.sourceTurnKey && root === document.body) return null;

    const hinted = new Set();
    if (artifact.selectorHint) {
      try {
        for (const element of queryAllWithSelf(root, artifact.selectorHint)) hinted.add(element);
      } catch {
        // Dynamic selector hints can become invalid after React replacement.
      }
    }

    const entries = queryAllWithSelf(root, 'button, [role="button"], a[href]')
      .filter((element) => isVisible(element) && !isExcludedArtifactAction(element))
      .map((element) => ({
        element,
        descriptor: artifactActionCandidateDescriptor(element, artifact, root, hinted.has(element)),
      }));
    const selection = DOM_PARSER.selectArtifactActionCandidate(artifact, entries.map((entry) => entry.descriptor));
    if (!selection.ok) {
      if (selection.reason === 'artifact_action_identity_ambiguous') {
        throw new Error(`Artifact action is ambiguous for ${artifact.name || artifact.id || 'artifact'} (${selection.score} points)`);
      }
      return null;
    }
    const selected = entries[selection.index];
    if (!selected?.element) return null;
    return options.withResolution
      ? { element: selected.element, descriptor: selected.descriptor, selection }
      : selected.element;
  }

  async function streamArtifactData(commandId, artifact, url) {
    const data = await fetchArtifactData(url, artifact);
    await streamArtifactPayload(commandId, artifact, data);
  }

  async function streamArtifactPayload(commandId, artifact, data = {}) {
    if (data.filePath || data.filename) {
      await streamArtifactDownloadedFile(commandId, artifact, data);
      return;
    }
    const base64 = String(data.contentBase64 || '');
    if (!base64) throw new Error(`Artifact materialization returned no bytes: ${artifact.name || artifact.id || 'artifact'}`);
    const chunkSize = Number(artifact.chunkSize || CONFIG.artifactChunkSize) || CONFIG.artifactChunkSize;
    const totalChunks = Math.max(1, Math.ceil(base64.length / chunkSize));
    send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name: data.name || artifact.name, mime: data.mime || artifact.mime, encodedSize: base64.length, size: data.size || 0, totalChunks, captureSource: data.captureSource || '' });
    for (let offset = 0, index = 0; offset < base64.length; offset += chunkSize, index += 1) {
      send({ type: 'artifact.data.chunk', commandId, artifactId: artifact.id, index, offset, totalChunks, contentBase64: base64.slice(offset, offset + chunkSize) });
      await delay(0);
    }
    send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name: data.name || artifact.name, mime: data.mime || artifact.mime, encodedSize: base64.length, size: data.size || 0, totalChunks, captureSource: data.captureSource || '' });
  }

  async function streamArtifactDownloadedFile(commandId, artifact, download) {
    const filePath = download.filePath || download.filename || '';
    if (!filePath) throw new Error('Captured browser download has no local filename');
    const name = download.name || filePath.split(/[\/]/).pop() || artifact.name || 'artifact';
    const mime = download.mime || artifact.mime || guessMime(name, download.downloadUrl || download.url || '');
    const browserDownloadIdentity = {
      downloadId: download.downloadId ?? null,
      browserDownloadStartTime: download.browserDownloadStartTime || '',
      browserDownloadEndTime: download.browserDownloadEndTime || '',
      browserCaptureStartedAt: download.browserCaptureStartedAt || 0,
      browserCapturedAt: download.browserCapturedAt || 0,
      browserExpectedNames: Array.isArray(download.browserExpectedNames) ? download.browserExpectedNames : [],
    };
    send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0, captureSource: download.captureSource || 'chrome-downloads', ...browserDownloadIdentity });
    send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0, captureSource: download.captureSource || 'chrome-downloads', ...browserDownloadIdentity });
  }

  async function fetchArtifactData(url, artifact) {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)?;base64,(.+)$/);
      if (!match) throw new Error('Unsupported data URL artifact');
      return { name: artifact.name || 'artifact', mime: match[1] || artifact.mime || 'application/octet-stream', contentBase64: match[2] };
    }

    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const mime = response.headers.get('content-type') || artifact.mime || 'application/octet-stream';
      const contentDisposition = response.headers.get('content-disposition') || '';
      const name = filenameFromContentDisposition(contentDisposition) || artifact.name || guessNameFromUrl(url) || 'artifact';
      return { name, mime, contentBase64: arrayBufferToBase64(buffer) };
    } catch (fetchErr) {
      if (typeof GM_xmlhttpRequest !== 'function') throw new Error(`Could not fetch artifact: ${fetchErr.message || fetchErr}`);
      return await gmFetchArtifact(url, artifact, fetchErr);
    }
  }

  function gmFetchArtifact(url, artifact, originalError) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        anonymous: false,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`Could not fetch artifact with GM_xmlhttpRequest: HTTP ${response.status}; page fetch failed: ${originalError?.message || originalError}`));
            return;
          }
          const headers = parseHeaders(response.responseHeaders || '');
          const mime = headers['content-type'] || artifact.mime || 'application/octet-stream';
          const name = filenameFromContentDisposition(headers['content-disposition'] || '') || artifact.name || guessNameFromUrl(url) || 'artifact';
          resolve({ name, mime, contentBase64: arrayBufferToBase64(response.response) });
        },
        onerror() { reject(new Error(`Could not fetch artifact with GM_xmlhttpRequest; page fetch failed: ${originalError?.message || originalError}`)); },
        ontimeout() { reject(new Error('Timed out fetching artifact with GM_xmlhttpRequest')); },
      });
    });
  }

  function parseHeaders(raw) {
    const result = {};
    for (const line of String(raw || '').split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      result[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return result;
  }

  function filenameFromContentDisposition(value) {
    const match = String(value || '').match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
    if (!match) return '';
    try { return decodeURIComponent(match[1].replace(/"/g, '').trim()); } catch { return match[1].replace(/"/g, '').trim(); }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  const PASSIVE_TURN_STORAGE_PREFIX = 'chatgpt-bridge-observed-turns-v1:';
  const passiveTurnState = {
    observer: null,
    root: null,
    timer: null,
    interval: null,
    sessionId: '',
    dirtyTurns: new Map(),
    scanRunning: false,
    scanAgain: false,
    pending: new Map(),
    emitted: new Map(),
    initializedSessions: new Set(),
  };

  function passiveStorageKey(sessionId = '') {
    return `${PASSIVE_TURN_STORAGE_PREFIX}${sessionId || 'new'}`;
  }

  function loadPassiveEmitted(sessionId) {
    if (passiveTurnState.initializedSessions.has(sessionId)) return;
    passiveTurnState.initializedSessions.add(sessionId);
    while (passiveTurnState.initializedSessions.size > 12) {
      const oldest = passiveTurnState.initializedSessions.values().next().value;
      passiveTurnState.initializedSessions.delete(oldest);
      for (const key of Array.from(passiveTurnState.emitted.keys())) {
        if (key.startsWith(`${oldest}:`)) passiveTurnState.emitted.delete(key);
      }
    }
    try {
      const parsed = JSON.parse(sessionStorage.getItem(passiveStorageKey(sessionId)) || '{}');
      for (const [key, signature] of Object.entries(parsed || {})) passiveTurnState.emitted.set(`${sessionId}:${key}`, String(signature || ''));
    } catch {}
  }

  function savePassiveEmitted(sessionId) {
    try {
      const sessionEntries = Array.from(passiveTurnState.emitted.entries())
        .filter(([key]) => key.startsWith(`${sessionId}:`))
        .slice(-200);
      for (const [key] of Array.from(passiveTurnState.emitted.entries())) {
        if (key.startsWith(`${sessionId}:`) && !sessionEntries.some(([kept]) => kept === key)) passiveTurnState.emitted.delete(key);
      }
      const entries = sessionEntries
        .map(([key, value]) => [key.slice(sessionId.length + 1), value]);
      sessionStorage.setItem(passiveStorageKey(sessionId), JSON.stringify(Object.fromEntries(entries)));
    } catch {}
  }

  function passiveTerminal(snapshot = {}) {
    return Boolean(
      snapshot.turnKey
      && snapshot.phase === DOM_PARSER.PHASE.ASSISTANT_FINAL
      && snapshot.hasFinalMessage
      && snapshot.actionBarVisible
      && !snapshot.stopVisible
      && !snapshot.hasActiveTool
      && !snapshot.needsContinue
      && !snapshot.needsConfirmation
      && !snapshot.hasError
    );
  }

  function passiveSnapshotSignature(snapshot = {}) {
    return JSON.stringify([
      snapshot.signature || '',
      (snapshot.artifacts || []).map((artifact) => [artifact.id || '', artifact.name || '', artifact.phase || '', artifact.downloadable ? 1 : 0]),
    ]);
  }

  function currentAssistantTurnRefs(limit = 80) {
    const allTurns = getTurnNodes();
    const offset = Math.max(0, allTurns.length - Math.max(1, Number(limit) || 80));
    const turns = allTurns.slice(offset);
    const result = [];
    for (let localIndex = 0; localIndex < turns.length; localIndex += 1) {
      const index = offset + localIndex;
      const key = turnKey(turns[index], index);
      if (!key) continue;
      const node = getAssistantNodeFromTurn(turns[index]);
      if (!node) continue;
      result.push({ key, node, turn: turns[index], index, turnCount: allTurns.length });
    }
    return result;
  }

  function markPassiveTurnDirty(turn, reason = 'mutation') {
    if (!turn?.isConnected) return;
    const allTurns = getTurnNodes();
    const index = allTurns.indexOf(turn);
    if (index < 0) return;
    const key = turnKey(turn, index);
    const node = getAssistantNodeFromTurn(turn);
    if (!key || !node) return;
    passiveTurnState.dirtyTurns.set(key, { key, node, turn, index, turnCount: allTurns.length, reason });
  }

  function markPassiveMutationRecords(records = []) {
    const marked = new Set();
    const addNode = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const turn = element?.closest?.('[data-testid^="conversation-turn-"][data-turn], section[data-turn][data-turn-id], main section[data-turn]');
      if (!turn || marked.has(turn)) return;
      marked.add(turn);
      markPassiveTurnDirty(turn, 'mutation');
    };
    for (const record of records) {
      addNode(record.target);
      for (const node of Array.from(record.addedNodes || [])) addNode(node);
    }
  }

  function baselinePassiveTurns(reason = 'baseline') {
    const sessionId = getCurrentSession()?.id || 'new';
    loadPassiveEmitted(sessionId);
    const refs = currentAssistantTurnRefs(200);
    const latest = refs.at(-1) || null;
    for (const ref of refs) {
      const storageKey = `${sessionId}:${ref.key}`;
      if (ref !== latest) {
        passiveTurnState.emitted.set(storageKey, 'baseline');
        continue;
      }
      const finalNode = getFinalAssistantNode(ref.turn || ref.node);
      const looksTerminal = Boolean(finalNode && responseActionBarVisible(ref.turn || ref.node) && !findStopButton());
      if (looksTerminal) passiveTurnState.emitted.set(storageKey, 'baseline');
      else passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'baseline-incomplete-latest' });
    }
    savePassiveEmitted(sessionId);
    diagnostic('observed.turns.baseline', { reason, sessionId, count: refs.length });
  }

  function ensurePassiveSession(reason = 'session-check') {
    const sessionId = getCurrentSession()?.id || 'new';
    if (passiveTurnState.sessionId === sessionId) return sessionId;
    passiveTurnState.sessionId = sessionId;
    passiveTurnState.dirtyTurns.clear();
    passiveTurnState.pending.clear();
    if (passiveTurnState.timer) {
      clearTimeout(passiveTurnState.timer);
      passiveTurnState.timer = null;
    }
    const hasStoredState = (() => { try { return Boolean(sessionStorage.getItem(passiveStorageKey(sessionId))); } catch { return false; } })();
    if (hasStoredState) loadPassiveEmitted(sessionId);
    else baselinePassiveTurns(reason);
    return sessionId;
  }

  function schedulePassiveTurnScan(reason = 'mutation', delayMs = 250) {
    clearTimeout(passiveTurnState.timer);
    passiveTurnState.timer = setTimeout(() => scanPassiveTurns(reason), Math.max(0, Number(delayMs) || 0));
  }

  function scanPassiveTurns(reason = 'poll') {
    if (passiveTurnState.scanRunning) {
      passiveTurnState.scanAgain = true;
      return;
    }
    passiveTurnState.scanRunning = true;
    try {
    const session = getCurrentSession();
    const sessionId = ensurePassiveSession('scan-session-change');
    loadPassiveEmitted(sessionId);
    const refs = Array.from(passiveTurnState.dirtyTurns.values());
    passiveTurnState.dirtyTurns.clear();
    if (!refs.length) return;
    const now = Date.now();
    for (const ref of refs) {
      if (!ref.node?.isConnected) continue;
      const storageKey = `${sessionId}:${ref.key}`;
      // Passive workflows process one terminal event per assistant turn. Once a
      // turn is baselined or emitted, later toolbar/hover mutations must not
      // re-run the full response parser indefinitely.
      if (passiveTurnState.emitted.has(storageKey)) continue;
      const snapshot = readAssistantNodeSnapshot(ref.node, {
        turnCount: ref.turnCount,
        reason: `passive_observer:${ref.reason || reason}`,
        turnKey: ref.key,
        turnIndex: ref.index,
      });
      if (!passiveTerminal(snapshot)) {
        passiveTurnState.pending.delete(storageKey);
        continue;
      }
      const signature = passiveSnapshotSignature(snapshot);
      if (activeRequest) {
        passiveTurnState.pending.delete(storageKey);
        passiveTurnState.emitted.set(storageKey, signature);
        continue;
      }
      if (passiveTurnState.emitted.get(storageKey) === signature) continue;
      const pending = passiveTurnState.pending.get(storageKey);
      if (!pending || pending.signature !== signature) {
        passiveTurnState.pending.set(storageKey, { signature, since: now, ref });
        passiveTurnState.dirtyTurns.set(ref.key, ref);
        schedulePassiveTurnScan('terminal-settle', 850);
        continue;
      }
      if (now - pending.since < 800) continue;
      passiveTurnState.pending.delete(storageKey);
      passiveTurnState.emitted.set(storageKey, signature);
      savePassiveEmitted(sessionId);
      const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts.map((artifact) => ({ ...artifact, sourceClientId: getClientId(), observed: true })) : [];
      send({
        type: 'observed.turn.terminal',
        observedAt: new Date().toISOString(),
        reason,
        session,
        url: location.href,
        title: document.title,
        turnKey: snapshot.turnKey,
        turnIndex: snapshot.turnIndex,
        messageId: snapshot.messageId || '',
        modelSlug: snapshot.modelSlug || '',
        answer: snapshot.answer || '',
        responseBlocks: snapshot.responseBlocks || [],
        parserAudit: snapshot.parserAudit || null,
        artifacts,
      });
      diagnostic('observed.turn.terminal', { sessionId, turnKey: snapshot.turnKey, artifactCount: artifacts.length, answerLength: String(snapshot.answer || '').length });
    }
    for (const [key, pending] of Array.from(passiveTurnState.pending.entries())) {
      if (now - Number(pending.since || 0) > 30_000) passiveTurnState.pending.delete(key);
    }
    savePassiveEmitted(sessionId);
    } finally {
      passiveTurnState.scanRunning = false;
      if (passiveTurnState.scanAgain) {
        passiveTurnState.scanAgain = false;
        schedulePassiveTurnScan('scan-queued', 0);
      }
    }
  }

  function attachPassiveTurnObserver() {
    const root = findChatMain();
    if (!root) {
      schedulePassiveTurnScan('root-missing', 750);
      return;
    }
    if (passiveTurnState.root === root && passiveTurnState.observer) return;
    try { passiveTurnState.observer?.disconnect(); } catch {}
    passiveTurnState.root = root;
    passiveTurnState.observer = new MutationObserver((records) => {
      markPassiveMutationRecords(records);
      if (passiveTurnState.dirtyTurns.size) schedulePassiveTurnScan('mutation', 250);
    });
    passiveTurnState.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state', 'data-message-id', 'data-turn-id', 'data-testid', 'aria-label', 'aria-expanded', 'href', 'download'] });
    schedulePassiveTurnScan('observer-attached', 500);
  }

  function startPassiveTurnObserver() {
    attachPassiveTurnObserver();
    ensurePassiveSession('first-observer-start');
    if (passiveTurnState.interval) clearInterval(passiveTurnState.interval);
    passiveTurnState.interval = setInterval(() => {
      attachPassiveTurnObserver();
      const sessionIdNow = ensurePassiveSession('poll-session-change');
      const recent = currentAssistantTurnRefs(4);
      for (const ref of recent) {
        const storageKey = `${sessionIdNow}:${ref.key}`;
        if (!passiveTurnState.emitted.has(storageKey) || passiveTurnState.pending.has(storageKey)) {
          passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'poll' });
        }
      }
      if (passiveTurnState.dirtyTurns.size) schedulePassiveTurnScan('poll', 0);
    }, 5_000);
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
      const shouldWatch = (url, contentType = '') => /chatgpt|openai|conversation|backend-api|responses|stream|event-stream/i.test(String(url || '') + ' ' + String(contentType || ''));
      const post = (payload) => window.postMessage({ source: SOURCE, nonce: NONCE, ...payload }, '*');
      const watchBody = async (kind, url, response) => {
        try {
          if (!response || !response.body || !decoder) return;
          const contentType = response.headers && response.headers.get ? response.headers.get('content-type') : '';
          if (!shouldWatch(url, contentType)) return;
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) post({ type: 'network.chunk', kind, url: String(url || ''), text: decoder.decode(value, { stream: true }) });
          }
          post({ type: 'network.done', kind, url: String(url || '') });
        } catch (err) { post({ type: 'network.error', kind, url: String(url || ''), message: err && err.message ? err.message : String(err) }); }
      };
      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') {
        window.fetch = async function bridgeFetch(input, init) {
          const response = await originalFetch.apply(this, arguments);
          try { const url = typeof input === 'string' ? input : input && input.url; watchBody('fetch', url, response.clone()); } catch {}
          return response;
        };
      }
    })();`;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  }

  function handleNetworkMessage(event) {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== HOOK_SOURCE || payload.nonce !== HOOK_NONCE || !activeRequest) return;
    if (payload.type === 'network.done') {
      activeRequest.networkDone = true;
      diagnostic('network.done', { requestId: activeRequest.requestId, kind: payload.kind, url: payload.url });
      collectAndEmit(activeRequest);
    } else if (payload.type === 'network.error') {
      diagnostic('network.error', { requestId: activeRequest.requestId, kind: payload.kind, message: payload.message });
    }
  }

  function handlePageLocationChange() {
    schedulePageStatus('page.changed');
    setTimeout(syncFloatingPanelVisibility, 0);
    setTimeout(() => {
      attachPassiveTurnObserver();
      ensurePassiveSession('location-change');
      schedulePassiveTurnScan('location-change', 500);
    }, 250);
  }

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

  function handleForegroundResync(reason = 'page.foreground') {
    schedulePageStatus('page.changed', 0);
    if (!activeRequest || activeRequest.finished || document.visibilityState !== 'visible') return;
    diagnostic('request.foreground_resync', {
      requestId: activeRequest.requestId,
      reason,
      phase: activeRequest.phase || '',
    });
    attachDomObserver(activeRequest);
    scheduleCollect(activeRequest, reason, 0);
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncFloatingPanelVisibility();
      schedulePageStatus('page.changed', 0);
    }, { once: true });
  } else syncFloatingPanelVisibility();
  window.addEventListener('load', () => schedulePageStatus('page.changed', 0), { once: true });
  startPageReadinessMonitor();
  startPassiveTurnObserver();
  connect();
})();
