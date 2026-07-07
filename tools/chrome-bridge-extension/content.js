// Extension content-script compatibility layer. The main companion code is
// intentionally kept close to userscripts/chatgpt-bridge.user.js.
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
      const event = {
        status: result.status || 0,
        response: body,
        responseText: typeof body === 'string' ? body : '',
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
// @version      2.5.0
// @description  Sends prompts/files to ChatGPT, streams chat events, extracts sessions and artifacts, and downloads artifacts through a local Node.js bridge.
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
  try {
    if (unsafeWindow && unsafeWindow[INSTANCE_KEY]) return;
    if (unsafeWindow) unsafeWindow[INSTANCE_KEY] = { version: '2.5.0', startedAt: Date.now() };
  } catch {}

  const CONFIG_VERSION = 7;

  const DEFAULT_CONFIG = {
    serverUrl: 'http://127.0.0.1:8080',
    token: '',
    transport: 'polling',
    reconnectMs: 1500,
    pollTimeoutMs: 25_000,
    pollActiveTimeoutMs: 300,
    pollIdleDelayMs: 0,
    domPollMs: 250,
    defaultAnswerSettleMs: 1500,
    defaultAnswerDoneSettleMs: 600,
    attachmentUploadTimeoutMs: 90_000,
    generationStartTimeoutMs: 30_000,
    firstOutputTimeoutMs: 75_000,
    maxRequestTimeoutMs: 0,
    artifactChunkSize: 256 * 1024,
    artifactDownloadTimeoutMs: 120_000,
    networkStreamEnabled: false,
    debug: false,
  };

  const CONFIG = loadConfig();
  const HOOK_SOURCE = 'chatgpt-browser-bridge-network-hook';
  const HOOK_NONCE = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const CLIENT_ID_STORAGE_KEY = 'chatgptBridgeTabClientId';
  let fallbackClientId = '';

  let ws = null;
  let extensionPort = null;
  let extensionRequestSeq = 0;
  const extensionRequests = new Map();
  let reconnectTimer = null;
  let pollAbort = false;
  let pollingStarted = false;
  let activeRequest = null;
  let networkHookInjected = false;
  let panelState = { status: 'starting', lastError: '', connectedAt: 0, busy: '' };
  const localLogs = [];
  let pollingOutbox = [];
  let pollingFlushInFlight = false;
  let pollingFlushTimer = null;
  let pollingExchangeController = null;
  let pollingExchangeInFlight = false;
  let pageStatusTimer = null;
  let lastPageStatusSignature = '';
  let lastPageStatusAt = 0;

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
    return {
      ...DEFAULT_CONFIG,
      serverUrl: String(gmGet('bridge.serverUrl', DEFAULT_CONFIG.serverUrl) || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''),
      token: String(gmGet('bridge.token', DEFAULT_CONFIG.token) || DEFAULT_CONFIG.token),
      transport: String(gmGet('bridge.transport', defaultTransport) || defaultTransport),
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
    if (CONFIG.debug) console.log('[chatgpt-bridge-userscript]', ...args);
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
    return {
      visibilityState: document.visibilityState || '',
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
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

  function sendPageStatus(type = 'page.status') {
    const presence = pagePresence();
    const payload = { type, url: location.href, title: document.title, time: Date.now(), session: getCurrentSession(), activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null, ...presence };
    const signature = JSON.stringify([type, payload.url, payload.title, payload.visibilityState, payload.focused, payload.session?.id || '', payload.activeRequest?.requestId || '']);
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

  function helloPayload() {
    return {
      type: 'hello',
      protocolVersion: 2,
      clientId: getClientId(),
      url: location.href,
      title: document.title,
      ...pagePresence(),
      capabilities: {
        dom: true,
        network: CONFIG.networkStreamEnabled,
        promptInput: true,
        cancel: true,
        markdown: true,
        diagnostics: true,
        sessions: true,
        fileUpload: true,
        artifacts: true,
        artifactDownload: true,
        modelSelection: true,
        effortSelection: true,
        chunkedArtifactDownload: true,
        requestRecoveryStatus: true,
        pollingTransport: true,
        websocketTransport: true,
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
    if (CONFIG.transport === 'extension') connectExtensionTransport();
    else if (CONFIG.transport === 'websocket') connectWebSocket();
    else startPollingTransport();
  }

  function hasExtensionRuntime() {
    try { return Boolean(globalThis.chrome?.runtime?.id && typeof chrome.runtime.connect === 'function'); } catch { return false; }
  }

  function connectExtensionTransport() {
    if (!hasExtensionRuntime()) {
      setPanelStatus('extension unavailable', 'Install/load the ChatGPT Bridge extension or switch to polling');
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
        setPanelStatus('connected', 'Extension WebSocket connected');
        send(helloPayload());
        return;
      }
      if (message.type === 'extension.status') {
        setPanelStatus(message.status || 'extension status', message.detail || '');
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
    if (/connected/i.test(status)) panelState.connectedAt = Date.now();
    if (changed) {
      localLogs.push({ time: new Date().toISOString(), type: 'status', details: { status, lastError } });
      while (localLogs.length > 200) localLogs.shift();
    }
    updatePanel();
  }

  function initFloatingPanel() {
    if (document.getElementById('chatgpt-bridge-panel-root')) return;
    const root = document.createElement('div');
    root.id = 'chatgpt-bridge-panel-root';
    root.innerHTML = `
      <style>
        #chatgpt-bridge-panel-root{position:fixed;right:0;bottom:96px;z-index:2147483647;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111}
        #cgb-tab{position:absolute;right:0;bottom:0;min-height:40px;transform:translateX(calc(100% - 34px));transition:transform .25s ease,box-shadow .25s ease;background:linear-gradient(135deg,#111,#2a2a2a);color:#fff;border:1px solid rgba(255,255,255,.14);border-right:0;border-radius:18px 0 0 18px;padding:10px 13px 10px 12px;box-shadow:0 6px 22px rgba(0,0,0,.28),inset 1px 0 0 rgba(255,255,255,.12);cursor:pointer;user-select:none;display:flex;gap:9px;align-items:center;overflow:hidden}
        #cgb-tab::before{content:'';position:absolute;left:5px;top:7px;bottom:7px;width:2px;border-radius:2px;background:rgba(255,255,255,.28)}
        #cgb-tab span:last-child{white-space:nowrap}
        #cgb-dot{width:9px;height:9px;border-radius:50%;background:#fff;box-shadow:0 0 0 0 rgba(255,255,255,.7);margin-left:3px;flex:0 0 auto}
        #cgb-tab.cgb-ok #cgb-dot{background:#21c45d;box-shadow:0 0 0 2px rgba(33,196,93,.18)}
        #cgb-tab.cgb-bad #cgb-dot{background:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.18)}
        #cgb-tab.cgb-unconfigured #cgb-dot{background:#fff;animation:cgb-pulse 1.2s ease infinite}
        #cgb-tab.cgb-busy #cgb-dot{background:#fbbf24;animation:cgb-pulse 1s ease infinite}
        @keyframes cgb-pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.75)}70%{box-shadow:0 0 0 8px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
        #chatgpt-bridge-panel-root:hover #cgb-tab,#chatgpt-bridge-panel-root.cgb-open #cgb-tab,#chatgpt-bridge-panel-root.cgb-peek #cgb-tab{transform:translateX(0)}
        #cgb-panel{display:none;position:absolute;right:8px;bottom:44px;width:360px;background:#fff;border:1px solid #ddd;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:14px}
        #chatgpt-bridge-panel-root.cgb-open #cgb-panel{display:block}
        #cgb-panel h3{margin:0 0 10px;font-size:15px}#cgb-panel label{display:block;margin:8px 0 4px;color:#555;font-size:12px}
        #cgb-panel input,#cgb-panel select{box-sizing:border-box;width:100%;padding:7px;border:1px solid #ccc;border-radius:8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
        #cgb-panel button{margin:8px 6px 0 0;padding:7px 10px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer}
        #cgb-panel button:disabled{opacity:.62;cursor:wait}.cgb-loading::before{content:'⟳ ';display:inline-block;animation:cgb-spin .9s linear infinite}@keyframes cgb-spin{to{transform:rotate(360deg)}}
        #cgb-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}#cgb-header h3{margin:0;font-size:15px}#cgb-close{margin:0;padding:4px 8px}
        #cgb-status{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:8px;margin-top:8px;max-height:170px;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
        #cgb-log{white-space:pre-wrap;background:#101010;color:#d6f7d6;border-radius:8px;padding:8px;margin-top:8px;max-height:150px;overflow:auto;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
      </style>
      <div id="cgb-tab"><span id="cgb-dot"></span><span>Bridge</span></div>
      <div id="cgb-panel">
        <div id="cgb-header"><h3>ChatGPT Bridge</h3><button id="cgb-close" title="Close">×</button></div>
        <label>Server URL</label><input id="cgb-server" value="${escapeHtml(CONFIG.serverUrl)}">
        <label>Bridge token</label><input id="cgb-token" value="${escapeHtml(CONFIG.token)}" placeholder="Paste BRIDGE_TOKEN from /setup">
        <label>Transport</label><select id="cgb-transport"><option value="extension">Extension WebSocket</option><option value="polling">HTTP polling</option><option value="websocket">Page WebSocket</option></select>
        <button id="cgb-save">Save & Connect</button><button id="cgb-test">Test</button><button id="cgb-setup">Open setup</button><button id="cgb-diag">Diagnostics</button><button id="cgb-copy">Copy diagnostics</button>
        <div id="cgb-status"></div>
        <div id="cgb-log"></div>
      </div>`;
    (document.documentElement || document.body).appendChild(root);
    root.querySelector('#cgb-transport').value = CONFIG.transport;
    root.querySelector('#cgb-tab').addEventListener('click', () => root.classList.toggle('cgb-open'));
    root.querySelector('#cgb-close').addEventListener('click', () => root.classList.remove('cgb-open'));
    root.querySelector('#cgb-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setButtonBusy(button, true, 'Connecting');
      setPanelBusy('connecting');
      try {
        saveConfigPatch({
          serverUrl: root.querySelector('#cgb-server').value.trim() || DEFAULT_CONFIG.serverUrl,
          token: root.querySelector('#cgb-token').value.trim(),
          transport: root.querySelector('#cgb-transport').value,
        });
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
      setPanelBusy('testing');
      try {
        const result = await gmRequestJson({ method: 'GET', url: new URL('/setup/status', CONFIG.serverUrl).toString(), timeout: 5000 });
        setPanelStatus('setup reachable', JSON.stringify({ clients: result.clients?.length || 0, transport: result.recommendedTransport }, null, 2));
        recordLocalLog('ui.test.ok', { clients: result.clients?.length || 0 });
      } catch (err) { setPanelStatus('setup test failed', err.message || String(err)); recordLocalLog('ui.test.failed', { error: err.message || String(err) }); }
      finally { setButtonBusy(button, false); setPanelBusy(''); }
    });
    root.querySelector('#cgb-setup').addEventListener('click', () => window.open(new URL('/setup', CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-diag').addEventListener('click', () => window.open(new URL('/diagnostics', CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-copy').addEventListener('click', async () => {
      const text = JSON.stringify({ config: { serverUrl: CONFIG.serverUrl, transport: CONFIG.transport, hasToken: Boolean(CONFIG.token) }, status: panelState, url: location.href, clientId: getClientId(), activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null }, null, 2);
      try { await navigator.clipboard.writeText(text); } catch {}
    });
    setTimeout(() => { root.classList.add('cgb-peek'); setTimeout(() => root.classList.remove('cgb-peek'), 1600); }, 700);
    updatePanel();
  }

  function updatePanel() {
    const status = document.getElementById('cgb-status');
    const tab = document.getElementById('cgb-tab');
    const logNode = document.getElementById('cgb-log');
    if (tab) {
      tab.classList.remove('cgb-ok', 'cgb-bad', 'cgb-unconfigured', 'cgb-busy');
      if (panelState.busy) tab.classList.add('cgb-busy');
      else if (!CONFIG.token) tab.classList.add('cgb-unconfigured');
      else if (/connected|reachable/i.test(panelState.status)) tab.classList.add('cgb-ok');
      else tab.classList.add('cgb-bad');
      tab.title = `ChatGPT Bridge: ${panelState.status}`;
    }
    if (status) {
      status.textContent = JSON.stringify({
        status: panelState.status,
        busy: panelState.busy || undefined,
        last: panelState.lastError,
        transport: CONFIG.transport,
        serverUrl: CONFIG.serverUrl,
        hasToken: Boolean(CONFIG.token),
        outbox: pollingOutbox.length,
        exchangeInFlight: pollingExchangeInFlight,
        clientId: getClientId(),
        activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null,
        page: location.href,
      }, null, 2);
    }
    if (logNode) {
      logNode.textContent = localLogs.slice(-30).map((entry) => `${entry.time} ${entry.type} ${JSON.stringify(entry.details || {})}`).join('\n') || 'No local userscript logs yet.';
      logNode.scrollTop = logNode.scrollHeight;
    }
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
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
    if (payload.type === 'server.hello') return;

    if (payload.type === 'ping') {
      send({ type: 'pong', time: Date.now(), url: location.href, title: document.title, session: getCurrentSession(), activeRequest: activeRequest ? publicRequestStatus(activeRequest) : null, ...pagePresence() });
      return;
    }

    if (payload.type === 'prompt.send') {
      void handlePromptSend(payload);
      return;
    }

    if (payload.type === 'prompt.cancel') {
      handlePromptCancel(payload);
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

    if (payload.type === 'artifact.fetch') {
      void handleArtifactFetch(payload);
      return;
    }

    if (payload.type === 'response.recover.latest') {
      handleResponseRecoverLatest(payload);
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
      send({ type: 'error', requestId, message: `Another prompt is active: ${activeRequest.requestId}` });
      diagnostic('prompt.rejected_busy', { requestId, activeRequestId: activeRequest.requestId });
      return;
    }

    const request = createRequestState(requestId, options);
    activeRequest = request;

    try {
      send({ type: 'prompt.accepted', requestId }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('prompt.accepted', { requestId });
      emitChatEvent(request, 'prompt.accepted');

      await waitForDocumentReady();
      await applySessionOptions(options, request);
      await applyModelOptions(options, request);

      request.baselineAssistantCount = getAssistantNodes().length;
      request.baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)));
      request.promptHash = simpleHash(message);
      request.promptPreview = message.slice(0, 160);
      startDomMonitor(request);
      send({ type: 'session.snapshot', requestId, session: getCurrentSession() }, { priority: true, immediatePost: true, timeout: 5_000 });
      emitChatEvent(request, 'session.snapshot', { session: getCurrentSession() });

      if (attachments.length) await attachFiles(attachments, request);
      await enterPrompt(message, request);
      request.sentAt = Date.now();
      refreshRequestTurnAnchors(request);
      send({ type: 'status', requestId, status: 'sent' }, { priority: true, immediatePost: true, timeout: 5_000 });
      diagnostic('prompt.sent', { requestId });
      emitChatEvent(request, 'prompt.sent', { attachmentCount: attachments.length });

      collectAndEmit(request);
    } catch (err) {
      finishRequest(request, err);
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

  function createRequestState(requestId, options) {
    return {
      requestId,
      startedAt: Date.now(),
      options,
      baselineAssistantCount: 0,
      baselineTurnKeys: new Set(),
      submittedUserTurnKey: '',
      submittedUserTurnIndex: -1,
      submittedUserTurnLogged: false,
      assistantTurnMissingLogged: false,
      assistantTurnMissingSince: 0,
      promptHash: '',
      promptPreview: '',
      lastAnswer: '',
      lastThinking: '',
      lastRaw: '',
      lastArtifactsFingerprint: '',
      artifacts: [],
      stableSince: 0,
      generationIdleSince: 0,
      sawAnswer: false,
      sawGenerating: false,
      generationStoppedSent: false,
      networkDone: false,
      observer: null,
      pollTimer: null,
      finishTimer: null,
      generationStartWarningSent: false,
      firstOutputWarningSent: false,
      maxRequestTimeoutWarningSent: false,
      sentAt: 0,
      finished: false,
    };
  }

  function publicRequestStatus(request) {
    if (!request) return null;
    return {
      requestId: request.requestId,
      startedAt: request.startedAt,
      sentAt: request.sentAt || 0,
      sawGenerating: request.sawGenerating,
      sawAnswer: request.sawAnswer,
      lastAnswerLength: request.lastAnswer.length,
      lastThinkingLength: request.lastThinking.length,
      artifactCount: request.artifacts.length,
      submittedUserTurnKey: request.submittedUserTurnKey || '',
      submittedUserTurnIndex: request.submittedUserTurnIndex,
      url: location.href,
      title: document.title,
    };
  }

  function waitForDocumentReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
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

    if (model) {
      result.modelApplied = await trySelectChatOption(model, {
        request,
        eventPrefix: 'model',
        openerNeedle: /(model|chatgpt|gpt-|o\d|reasoning|режим|модель)/i,
      });
      if (!result.modelApplied) result.warnings.push(`Could not confirm model selection: ${model}`);
    }

    if (effort) {
      const effortLabel = effortLabelFromValue(effort);
      result.effortApplied = await trySelectChatOption(effortLabel, {
        request,
        eventPrefix: 'effort',
        openerNeedle: /(model|chatgpt|gpt-|thinking|reasoning|think|effort|дума|размыш)/i,
      });
      if (!result.effortApplied) result.warnings.push(`Could not confirm effort selection: ${effort}`);
    }

    send({ type: 'chat.event', requestId: request.requestId, event: { type: 'model.apply.done', requestId: request.requestId, time: new Date().toISOString(), ...result } });
    diagnostic('model.apply.done', { requestId: request.requestId, ...result });
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

  async function trySelectChatOption(label, { request, eventPrefix, openerNeedle }) {
    const desired = normalizeComparable(label);
    if (!desired) return false;

    const opener = findLikelyOptionOpener(openerNeedle);
    if (!opener) {
      diagnostic(`${eventPrefix}.opener_not_found`, { requestId: request.requestId, label });
      return false;
    }

    const beforeLabel = normalizeText(visibleText(opener) || opener.getAttribute('aria-label') || opener.getAttribute('title') || '');
    opener.click();
    await delay(450);

    const scope = findActivePickerScope() || document.body;
    const option = findClickableByText(desired, scope);
    if (!option) {
      diagnostic(`${eventPrefix}.option_not_found_scoped`, { requestId: request.requestId, label, beforeLabel });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    option.click();
    await delay(650);
    const afterLabel = normalizeText(visibleText(opener) || opener.getAttribute('aria-label') || opener.getAttribute('title') || '');
    const verified = normalizeComparable(afterLabel).includes(desired) || beforeLabel !== afterLabel || isOptionSelectedByLabel(desired);
    diagnostic(`${eventPrefix}.option_clicked`, { requestId: request.requestId, label, verified, beforeLabel, afterLabel });
    if (!verified && request.options?.strictModelSelection) {
      throw new Error(`Could not verify ${eventPrefix} selection: ${label}`);
    }
    return verified || true;
  }

  function findActivePickerScope() {
    const candidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-headlessui-state], div[class*="popover" i], div[class*="menu" i]'))
      .filter(isVisible)
      .sort((a, b) => area(b) - area(a));
    return candidates.find((el) => area(el) > 50) || null;
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isOptionSelectedByLabel(normalizedNeedle) {
    const scope = findActivePickerScope() || document.body;
    const selected = Array.from(scope.querySelectorAll('[aria-selected="true"], [aria-checked="true"], [data-state="checked"], [data-selected="true"]'));
    return selected.some((element) => normalizeComparable(visibleText(element) || element.getAttribute('aria-label') || '').includes(normalizedNeedle));
  }

  function findLikelyOptionOpener(needle) {
    const elements = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isUsableButton);
    return elements.find((element) => {
      const text = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.innerText || element.textContent || '',
      ].filter(Boolean).join(' ');
      return needle.test(text);
    }) || null;
  }

  function findClickableByText(normalizedNeedle, root) {
    const elements = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], a, div[tabindex], span[tabindex]'));
    return elements.find((element) => {
      if (!isVisible(element)) return false;
      const text = normalizeComparable([
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.innerText || element.textContent || '',
      ].filter(Boolean).join(' '));
      return text.includes(normalizedNeedle);
    }) || null;
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

  async function enterPrompt(message, request) {
    const composer = await waitForComposer(request);
    if (message.trim()) {
      await focusAndSetComposerText(composer, message, request);
      diagnostic('composer.filled', { requestId: request.requestId, length: message.length });
    } else {
      composer.focus();
    }

    await delay(120);

    const button = findSendButton();
    if (button) {
      diagnostic('send_button.found', { requestId: request.requestId, label: button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || '' });
      button.click();
      return;
    }

    diagnostic('send_button.not_found_keyboard_fallback', { requestId: request.requestId });
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
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
          reject(new Error('ChatGPT composer not found. Are you logged in and on the ChatGPT page?'));
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function findComposer() {
    const selectors = ['#prompt-textarea', '[data-testid="composer"] [contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]', 'textarea[data-id="root"]', 'textarea', '.ProseMirror[contenteditable="true"]'];
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const visible = elements.find((element) => isVisible(element) && !element.disabled && !element.readOnly);
      if (visible) return visible;
    }
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

  function findSendButton() {
    const selectors = ['[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', 'button[data-testid*="send"]'];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (isUsableButton(element)) return element;
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find((button) => {
      if (!isUsableButton(button)) return false;
      const text = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.innerText || button.textContent || ''].filter(Boolean).join(' ');
      return /send|отправить|submit/i.test(text);
    }) || null;
  }

  function findStopButton() {
    const buttonLike = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttonLike.find((element) => {
      if (!isUsableButton(element)) return false;
      const text = [element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText || element.textContent || ''].filter(Boolean).join(' ');
      return /stop[-_ ]?(button|generating|streaming)|\bstop\b|остановить|停止/i.test(text);
    }) || null;
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

  function startDomMonitor(request) {
    const listener = () => collectAndEmit(request);
    request.observer = new MutationObserver(listener);
    request.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'data-testid', 'disabled', 'aria-disabled', 'href', 'src'] });
    request.pollTimer = setInterval(listener, CONFIG.domPollMs);
    diagnostic('dom_monitor.started', { requestId: request.requestId });
  }

  function collectAndEmit(request) {
    if (request.finished) return;

    refreshRequestTurnAnchors(request);
    const snapshot = readAssistantSnapshot(request);
    const generating = isGenerating();
    const now = Date.now();

    if (generating) {
      if (!request.sawGenerating) {
        send({ type: 'status', requestId: request.requestId, status: 'generating' });
        diagnostic('generation.started', { requestId: request.requestId });
        emitChatEvent(request, 'generation.started');
      }
      request.sawGenerating = true;
      request.generationIdleSince = 0;
    } else if (!request.generationIdleSince) {
      request.generationIdleSince = now;
      if (request.sawGenerating && !request.generationStoppedSent) {
        request.generationStoppedSent = true;
        send({ type: 'status', requestId: request.requestId, status: 'idle' });
        diagnostic('generation.stopped', { requestId: request.requestId });
        emitChatEvent(request, 'generation.stopped');
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

    if (snapshot.thinking && snapshot.thinking !== request.lastThinking) {
      request.lastThinking = snapshot.thinking;
      send({ type: 'thinking.snapshot', requestId: request.requestId, text: snapshot.thinking });
      diagnostic('thinking.snapshot', { requestId: request.requestId, length: snapshot.thinking.length });
    }

    if (snapshot.answer && snapshot.answer !== request.lastAnswer) {
      request.lastAnswer = snapshot.answer;
      request.sawAnswer = true;
      request.stableSince = now;
      send({ type: 'answer.snapshot', requestId: request.requestId, text: snapshot.answer });
      diagnostic('answer.snapshot', { requestId: request.requestId, length: snapshot.answer.length, format: snapshot.format });
    }

    const artifactFingerprint = JSON.stringify(snapshot.artifacts.map((artifact) => [artifact.id, artifact.kind, artifact.name, artifact.url || artifact.src || artifact.downloadUrl]));
    if (artifactFingerprint !== request.lastArtifactsFingerprint) {
      request.lastArtifactsFingerprint = artifactFingerprint;
      request.artifacts = snapshot.artifacts;
      send({ type: 'artifact.snapshot', requestId: request.requestId, artifacts: snapshot.artifacts });
      diagnostic('artifact.snapshot', { requestId: request.requestId, count: snapshot.artifacts.length });
      emitChatEvent(request, 'artifact.snapshot', { artifacts: snapshot.artifacts });
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

    const answerSettleMs = Number(request.options.answerSettleMs) || CONFIG.defaultAnswerSettleMs;
    const doneSettleMs = Number(request.options.answerDoneSettleMs) || CONFIG.defaultAnswerDoneSettleMs;
    const stableForMs = request.stableSince ? now - request.stableSince : 0;
    const generationIdleForMs = request.generationIdleSince ? now - request.generationIdleSince : 0;
    const oldEnough = now - request.startedAt >= 1000;
    const hasOutput = request.sawAnswer || request.artifacts.length > 0;

    const doneByNetwork = request.networkDone && hasOutput && stableForMs >= doneSettleMs;
    const doneByDom = oldEnough && hasOutput && !generating && (stableForMs >= answerSettleMs || generationIdleForMs >= doneSettleMs);

    if (doneByNetwork || doneByDom) {
      diagnostic(doneByNetwork ? 'done.by_network' : 'done.by_dom', { requestId: request.requestId, stableForMs, generationIdleForMs });
      finishRequest(request, null, request.lastAnswer);
    }
  }

  function finishRequest(request, err, answer = '') {
    if (!request || request.finished) return;
    request.finished = true;

    try { request.observer?.disconnect(); } catch {}
    if (request.pollTimer) clearInterval(request.pollTimer);
    if (request.finishTimer) clearTimeout(request.finishTimer);
    if (activeRequest === request) activeRequest = null;

    if (err) {
      diagnostic('request.error', { requestId: request.requestId, message: err.message || String(err) });
      send({ type: 'error', requestId: request.requestId, message: err.message || String(err) });
      return;
    }

    const finalSnapshot = readAssistantSnapshot(request);
    const finalAnswer = finalSnapshot.answer || answer || request.lastAnswer || '';
    const finalThinking = finalSnapshot.thinking || request.lastThinking || '';
    const finalArtifacts = finalSnapshot.artifacts.length ? finalSnapshot.artifacts : request.artifacts;
    const session = getCurrentSession();

    if (finalAnswer && finalAnswer !== request.lastAnswer) send({ type: 'answer.snapshot', requestId: request.requestId, text: finalAnswer });
    if (finalThinking && finalThinking !== request.lastThinking) send({ type: 'thinking.snapshot', requestId: request.requestId, text: finalThinking });
    if (JSON.stringify(finalArtifacts) !== JSON.stringify(request.artifacts)) send({ type: 'artifact.snapshot', requestId: request.requestId, artifacts: finalArtifacts });

    diagnostic('request.done', { requestId: request.requestId, answerLength: finalAnswer.length, thinkingLength: finalThinking.length, artifacts: finalArtifacts.length, session });
    send({ type: 'done', requestId: request.requestId, answer: finalAnswer, thinking: finalThinking, artifacts: finalArtifacts, session, url: location.href, title: document.title, finishReason: 'stop' });
  }

  function getTurnNodes() {
    return Array.from(document.querySelectorAll('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]'));
  }

  function turnKey(turn, index = -1) {
    if (!turn) return '';
    return turn.getAttribute('data-turn-id') || turn.getAttribute('data-testid') || turn.getAttribute('data-turn-id-container') || (index >= 0 ? `turn-index-${index}` : '');
  }

  function turnRole(turn) {
    if (!turn) return '';
    const direct = turn.getAttribute('data-turn');
    if (direct) return direct;
    const msg = turn.querySelector('[data-message-author-role]');
    return msg?.getAttribute('data-message-author-role') || '';
  }

  function getAssistantNodes() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function getAssistantNodeFromTurn(turn) {
    if (!turn) return null;
    return turn.matches?.('[data-message-author-role="assistant"]') ? turn : turn.querySelector('[data-message-author-role="assistant"]') || (turnRole(turn) === 'assistant' ? turn : null);
  }

  function refreshRequestTurnAnchors(request) {
    if (!request || request.submittedUserTurnKey) return;
    const turns = getTurnNodes();
    const baseline = request.baselineTurnKeys instanceof Set ? request.baselineTurnKeys : new Set();
    const newUserTurns = turns
      .map((turn, index) => ({ turn, index, key: turnKey(turn, index), role: turnRole(turn), text: visibleText(turn) }))
      .filter((item) => item.role === 'user' && item.key && !baseline.has(item.key));

    const candidate = newUserTurns[newUserTurns.length - 1];
    if (!candidate) return;
    request.submittedUserTurnKey = candidate.key;
    request.submittedUserTurnIndex = candidate.index;
    if (!request.submittedUserTurnLogged) {
      request.submittedUserTurnLogged = true;
      diagnostic('submitted_user_turn.captured', {
        requestId: request.requestId,
        turnKey: candidate.key,
        turnIndex: candidate.index,
        textLength: candidate.text.length,
        textHash: simpleHash(candidate.text),
        promptHash: request.promptHash || '',
      });
    }
  }

  function findAssistantTurnAfterSubmittedUser(request) {
    const turns = getTurnNodes();
    if (!turns.length) return { node: null, turns, reason: 'no_turns' };
    if (!request?.submittedUserTurnKey) return { node: null, turns, reason: 'no_submitted_user_turn' };

    const startIndex = turns.findIndex((turn, index) => turnKey(turn, index) === request.submittedUserTurnKey);
    if (startIndex < 0) return { node: null, turns, reason: 'submitted_user_turn_not_found' };

    for (const turn of turns.slice(startIndex + 1)) {
      if (turnRole(turn) !== 'assistant') continue;
      const node = getAssistantNodeFromTurn(turn);
      if (node) return { node, turns, reason: 'selected_after_submitted_user' };
    }
    return { node: null, turns, reason: 'no_assistant_turn_after_submitted_user', startIndex };
  }

  function findAssistantTurns(limit = 5) {
    const turns = getTurnNodes();
    const result = [];
    for (let index = turns.length - 1; index >= 0 && result.length < limit; index -= 1) {
      const turn = turns[index];
      if (turnRole(turn) !== 'assistant') continue;
      const node = getAssistantNodeFromTurn(turn);
      if (node) result.push({ node, turn, turns, index, key: turnKey(turn, index), reason: 'assistant_turn' });
    }

    if (!result.length) {
      const nodes = getAssistantNodes();
      for (let index = nodes.length - 1; index >= 0 && result.length < limit; index -= 1) {
        const node = nodes[index];
        result.push({ node, turn: null, turns, index: -1, key: '', reason: 'assistant_node_fallback' });
      }
    }
    return result;
  }

  function findLatestAssistantTurn(index = 1) {
    const candidates = findAssistantTurns(Math.max(1, Number(index) || 1));
    return candidates[Math.max(0, (Number(index) || 1) - 1)] || { node: null, turn: null, turns: getTurnNodes(), index: -1, key: '', reason: 'no_assistant_node' };
  }

  function readLatestAssistantSnapshot(index = 1) {
    const selected = findLatestAssistantTurn(index);
    if (!selected.node) return { answer: '', thinking: '', raw: '', count: getAssistantNodes().length, turnCount: selected.turns?.length || 0, format: 'none', artifacts: [], reason: selected.reason || 'no_assistant_node' };
    const snapshot = readAssistantNodeSnapshot(selected.node, { count: getAssistantNodes().length, turnCount: selected.turns.length, reason: selected.reason });
    return { ...snapshot, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex: Number(index) || 1 };
  }

  function readRecentAssistantSnapshots(limit = 5) {
    return findAssistantTurns(limit).map((selected, index) => {
      const snapshot = readAssistantNodeSnapshot(selected.node, { count: getAssistantNodes().length, turnCount: selected.turns.length, reason: selected.reason });
      return { ...snapshot, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex: index + 1 };
    });
  }

  function readAssistantSnapshot(requestOrBaseline) {
    if (requestOrBaseline && typeof requestOrBaseline === 'object') {
      const request = requestOrBaseline;
      const selected = findAssistantTurnAfterSubmittedUser(request);
      if (selected.node) return readAssistantNodeSnapshot(selected.node, { turnCount: selected.turns.length, reason: selected.reason });

      // Before the submitted user turn is visible, do not fall back to an older
      // assistant response. Virtualized ChatGPT DOM can reorder text and keeps
      // old assistant nodes around; old fallbacks caused stale answers and hangs.
      const nodes = getAssistantNodes();
      return { answer: '', thinking: '', raw: '', count: nodes.length, format: 'none', artifacts: [], reason: selected.reason, turnCount: selected.turns.length };
    }

    const nodes = getAssistantNodes();
    if (!nodes.length) return { answer: '', thinking: '', raw: '', count: 0, format: 'none', artifacts: [], reason: 'no_nodes' };
    const safeBaselineCount = Math.max(0, Number(requestOrBaseline) || 0);
    if (nodes.length <= safeBaselineCount) return { answer: '', thinking: '', raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'baseline_not_exceeded' };
    const candidateNodes = nodes.slice(safeBaselineCount);
    const node = candidateNodes[candidateNodes.length - 1];
    if (!node) return { answer: '', thinking: '', raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'no_candidate' };
    return readAssistantNodeSnapshot(node, { count: nodes.length, reason: 'baseline_candidate' });
  }

  function readAssistantNodeSnapshot(node, meta = {}) {
    if (!node) return { answer: '', thinking: '', raw: '', count: meta.count || 0, format: 'none', artifacts: [], reason: meta.reason || 'no_node' };
    const raw = visibleText(node);
    const thinkingElements = findThinkingElements(node);
    const thinking = unique(thinkingElements.map(visibleText)).join('\n');
    const isThinkingChild = (element) => thinkingElements.some((thinkingElement) => thinkingElement === element || thinkingElement.contains(element));
    const artifacts = collectArtifactsFromNode(node);

    const markdownNodes = Array.from(node.querySelectorAll('.markdown, [data-message-id] .markdown')).filter((element) => !isThinkingChild(element));
    if (markdownNodes.length) {
      const answer = unique(markdownNodes.map((element) => extractMarkdownFromElement(element, isThinkingChild))).join('\n\n');
      if (answer) return { answer, thinking, raw, count: meta.count || 0, turnCount: meta.turnCount || 0, format: 'markdown', artifacts, reason: meta.reason || 'markdown' };
    }

    const contentNodes = Array.from(node.querySelectorAll('p, li, pre, blockquote, table')).filter((element) => !isThinkingChild(element));
    const answer = contentNodes.length ? unique(contentNodes.map((element) => elementToMarkdown(element, { isExcluded: isThinkingChild, listDepth: 0 }))).join('\n') : stripThinkingFromRaw(raw, thinking);
    return { answer, thinking, raw, count: meta.count || 0, turnCount: meta.turnCount || 0, format: contentNodes.length ? 'structured' : 'raw', artifacts, reason: meta.reason || (contentNodes.length ? 'structured' : 'raw') };
  }

  function collectArtifactsFromNode(node) {
    const artifacts = [];
    const push = (artifact) => {
      const url = artifact.downloadUrl || artifact.url || artifact.src || '';
      const name = normalizeText(artifact.name || artifact.title || artifact.text || guessNameFromUrl(url) || artifact.kind || 'artifact');
      const id = artifact.id || `artifact_${simpleHash([artifact.kind, url, name].join('|'))}`;
      if (artifacts.some((item) => item.id === id)) return;
      artifacts.push({ id, name, mime: artifact.mime || guessMime(name, url), ...artifact });
    };

    for (const a of Array.from(node.querySelectorAll('a[href]'))) {
      const href = a.href || a.getAttribute('href') || '';
      const text = visibleText(a);
      const download = a.getAttribute('download') || '';
      const looksDownload = download || /download|attachment|file|sandbox|blob:|\/mnt\/data|\/download|\/api\/.*file/i.test(href) || /download|скачать|file|attachment|artifact|image/i.test(text);
      if (!looksDownload && !href.startsWith('blob:') && !href.startsWith('data:')) continue;
      push({ kind: 'file', url: href, downloadUrl: href, name: download || text || guessNameFromUrl(href), text });
    }

    for (const img of Array.from(node.querySelectorAll('img[src]'))) {
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:image/svg')) continue;
      const alt = img.getAttribute('alt') || img.getAttribute('aria-label') || '';
      const rect = img.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue;
      push({ kind: 'image', src, url: src, downloadUrl: src, name: alt || guessNameFromUrl(src) || 'image', width: Math.round(rect.width), height: Math.round(rect.height) });
    }

    for (const button of Array.from(node.querySelectorAll('button, [role="button"]'))) {
      const text = visibleText(button);
      const attrs = [button.getAttribute('data-testid'), button.getAttribute('aria-label'), button.getAttribute('title'), text].filter(Boolean).join(' ');
      if (/canvas|artifact|download|скачать|open in canvas|edit in canvas/i.test(attrs)) {
        push({ kind: /canvas/i.test(attrs) ? 'canvas' : 'action', name: text || attrs, text, actionLabel: attrs, actionId: `action_${simpleHash(attrs)}` });
      }
    }

    return artifacts;
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
    if (/\.zip\b/.test(source)) return 'application/zip';
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

  function extractMarkdownFromElement(root, isExcluded) {
    const blocks = [];
    for (const child of Array.from(root.children)) {
      if (isExcluded(child) || !isVisible(child)) continue;
      const value = elementToMarkdown(child, { isExcluded, listDepth: 0 });
      if (value) blocks.push(value);
    }
    const markdown = normalizeMarkdown(blocks.join('\n\n'));
    return markdown || visibleText(root);
  }

  function elementToMarkdown(element, context) {
    if (!element || context.isExcluded(element) || !isVisible(element)) return '';
    const tag = element.tagName.toLowerCase();
    if (tag === 'pre') return preToMarkdown(element);
    if (tag === 'table') return tableToMarkdown(element);
    if (tag === 'blockquote') return blockquoteToMarkdown(element, context);
    if (tag === 'ul' || tag === 'ol') return listToMarkdown(element, context, tag === 'ol');
    if (tag === 'li') return listItemToMarkdown(element, context, false, 1);
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${inlineText(element)}`.trim();
    if (tag === 'p') return inlineText(element);
    if (tag === 'hr') return '---';

    const childBlocks = [];
    for (const child of Array.from(element.children)) {
      if (context.isExcluded(child) || !isVisible(child)) continue;
      const childTag = child.tagName.toLowerCase();
      if (isBlockTag(childTag)) {
        const value = elementToMarkdown(child, context);
        if (value) childBlocks.push(value);
      }
    }
    if (childBlocks.length) return normalizeMarkdown(childBlocks.join('\n\n'));
    return inlineText(element);
  }

  function isBlockTag(tag) { return /^(p|div|section|article|pre|table|blockquote|ul|ol|li|h[1-6]|hr)$/i.test(tag); }
  function inlineText(element) { return visibleText(element).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
  function preToMarkdown(element) {
    const code = element.querySelector('code') || element;
    const className = code.getAttribute('class') || '';
    const language = className.match(/language-([\w-]+)/)?.[1] || '';
    const text = normalizeCode(code.innerText || code.textContent || '');
    if (!text) return '';
    return `\`\`\`${language}\n${text}\n\`\`\``;
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
  function normalizeMarkdown(value) { return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function stripThinkingFromRaw(raw, thinking) { return thinking ? normalizeText(raw.replace(thinking, '')) : raw; }
  function isGenerating() { return Boolean(findStopButton()); }
  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
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
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('No sessionId provided');
    if (conversationIdFromUrl(location.href) === id) return getCurrentSession();

    const sessions = collectSessions();
    const session = sessions.find((item) => item.id === id || item.url === id || item.url.endsWith(`/c/${id}`));
    if (session) {
      const link = Array.from(document.querySelectorAll('a[href*="/c/"]')).find((a) => conversationIdFromUrl(a.href || a.getAttribute('href')) === session.id);
      if (link) link.click();
      else location.href = session.url;
    } else if (/^https?:\/\//.test(id)) {
      location.href = id;
    } else {
      location.href = `/c/${id}`;
    }

    await waitForUrlChangeOrDelay(1000);
    return getCurrentSession();
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


  async function handleModelsList(payload) {
    try {
      const result = await collectPickerOptions({
        openerNeedle: /(model|chatgpt|gpt-|o\d|reasoning|режим|модель)/i,
        optionNeedle: /(gpt|chatgpt|o\d|auto|instant|thinking|reason|research|legacy|temporary|mini|модель|авто)/i,
        diagnosticPrefix: 'models',
      });
      send({ type: 'models.snapshot', commandId: payload.commandId, models: result.options, current: result.current });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function handleEffortsList(payload) {
    try {
      const result = await collectPickerOptions({
        openerNeedle: /(thinking|reasoning|effort|дума|размыш|model|chatgpt|gpt-)/i,
        optionNeedle: /\b(auto|instant|low|medium|high|xhigh|x-high|thinking|reasoning|fast)\b|дума|размыш|быстр|низк|средн|высок/i,
        diagnosticPrefix: 'efforts',
      });
      const fallback = ['auto', 'instant', 'low', 'medium', 'high', 'xhigh'].map((label) => ({ id: `effort_${label}`, label, selected: false }));
      send({ type: 'efforts.snapshot', commandId: payload.commandId, efforts: result.options.length ? result.options : fallback, current: result.current });
    } catch (err) {
      send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
    }
  }

  async function collectPickerOptions({ openerNeedle, optionNeedle, diagnosticPrefix }) {
    const beforeActive = document.activeElement;
    const opener = findLikelyOptionOpener(openerNeedle);
    let opened = false;

    if (opener) {
      opener.click();
      opened = true;
      diagnostic(`${diagnosticPrefix}.opener_clicked`, { label: visibleText(opener) || opener.getAttribute('aria-label') || '' });
      await delay(450);
    } else {
      diagnostic(`${diagnosticPrefix}.opener_not_found`);
    }

    const options = collectVisibleOptions(optionNeedle, findActivePickerScope() || document.body);
    const current = guessCurrentOption(opener, optionNeedle);

    if (opened) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(100);
      try { beforeActive?.focus?.(); } catch {}
    }

    diagnostic(`${diagnosticPrefix}.snapshot`, { count: options.length, current: current?.label || '' });
    return { options, current };
  }

  function collectVisibleOptions(optionNeedle, root = document.body) {
    const seen = new Set();
    const result = [];
    const elements = Array.from((root || document.body).querySelectorAll('[role="menuitem"], [role="option"], button, [role="button"], a'));

    for (const element of elements) {
      if (!isVisible(element)) continue;
      const label = normalizeText(visibleText(element) || element.getAttribute('aria-label') || element.getAttribute('title') || '');
      if (!label || label.length > 120) continue;
      const attrs = [label, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid')].filter(Boolean).join(' ');
      if (!optionNeedle.test(attrs)) continue;
      const key = normalizeComparable(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: `option_${simpleHash(label)}`,
        label,
        selected: element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' || /selected|active|checked/i.test(element.getAttribute('data-testid') || ''),
      });
    }

    return result;
  }

  function guessCurrentOption(opener, optionNeedle) {
    const candidates = [];
    if (opener) candidates.push(opener);
    candidates.push(...Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible));
    for (const element of candidates) {
      const label = normalizeText(visibleText(element) || element.getAttribute('aria-label') || element.getAttribute('title') || '');
      if (label && label.length <= 120 && optionNeedle.test(label)) return { id: `option_${simpleHash(label)}`, label, selected: true };
    }
    return null;
  }

  function responsePayloadFromSnapshot(snapshot, commandId, extra = {}) {
    return {
      commandId,
      answer: snapshot.answer || snapshot.raw || '',
      thinking: snapshot.thinking || '',
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
      preview: normalizeText(snapshot.answer || snapshot.raw || snapshot.thinking || '').slice(0, 260),
      answerLength: (snapshot.answer || snapshot.raw || '').length,
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
      const hasContent = Boolean(snapshot.answer || snapshot.thinking || snapshot.raw || snapshot.artifacts.length);
      if (!hasContent) throw new Error(`No assistant response #${index} is visible in the current ChatGPT tab`);
      const session = getCurrentSession();
      send({ type: 'response.recovered', ...responsePayloadFromSnapshot(snapshot, commandId, { session, source: index === 1 ? 'latest-assistant-turn' : `assistant-turn-${index}` }) });
      diagnostic('response.recovered', { commandId, index, answerLength: (snapshot.answer || snapshot.raw || '').length, artifacts: snapshot.artifacts.length, turnKey: snapshot.turnKey || '', turnIndex: snapshot.turnIndex ?? -1 });
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
        .filter((item) => item.answer || item.thinking || (Array.isArray(item.artifacts) && item.artifacts.length));
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

  async function handleArtifactFetch(payload) {
    const artifact = payload.artifact || {};
    const commandId = payload.commandId;
    try {
      let url = artifact.downloadUrl || artifact.url || artifact.src || '';
      let materialized = null;
      if (!url && (artifact.kind === 'action' || artifact.kind === 'canvas')) {
        materialized = await materializeArtifactAction(artifact);
        url = materialized.downloadUrl || materialized.url || materialized.src || '';
        artifact.name = materialized.name || artifact.name;
        artifact.mime = materialized.mime || artifact.mime;
      }
      if (materialized?.filePath || materialized?.filename) {
        await streamArtifactDownloadedFile(commandId, artifact, materialized);
        return;
      }
      if (!url) throw new Error('Artifact has no downloadable URL');
      await streamArtifactData(commandId, artifact, url);
    } catch (err) {
      send({ type: 'command.error', commandId, message: err.message || String(err) });
    }
  }

  async function materializeArtifactAction(artifact) {
    const before = new Set(collectArtifactsFromNode(document.body).map((item) => item.id));
    const button = findArtifactActionButton(artifact);
    if (!button) throw new Error('Artifact action button not found');

    let capture = null;
    if (CONFIG.transport === 'extension' && extensionPort) {
      try {
        capture = await extensionRequest('bridge.download.capture.begin', {
          timeoutMs: Number(CONFIG.artifactDownloadTimeoutMs) || 120_000,
          artifact: { id: artifact.id, name: artifact.name, kind: artifact.kind, text: artifact.text, actionLabel: artifact.actionLabel },
        }, 5_000);
        diagnostic('artifact.download_capture.armed', { artifactId: artifact.id, captureId: capture.captureId });
      } catch (err) {
        diagnostic('artifact.download_capture.unavailable', { artifactId: artifact.id, message: err.message || String(err) });
      }
    }

    button.click();
    diagnostic('artifact.action.clicked', { artifactId: artifact.id, label: artifact.actionLabel || artifact.name || '' });

    const domWait = waitForMaterializedArtifactUrl(before, 15_000);
    const downloadWait = capture?.captureId
      ? extensionRequest('bridge.download.capture.wait', { captureId: capture.captureId, timeoutMs: Number(CONFIG.artifactDownloadTimeoutMs) || 120_000 }, (Number(CONFIG.artifactDownloadTimeoutMs) || 120_000) + 5_000)
          .then((download) => ({ filePath: download.filename, filename: download.filename, name: download.name, mime: download.mime, size: download.fileSize || download.bytesReceived || 0, downloadId: download.id, downloadUrl: download.url || download.finalUrl || '' }))
      : null;

    if (downloadWait) {
      // Some artifact buttons start a browser download without adding a new
      // downloadable URL to the DOM. Do not let the short DOM wait reject before
      // the extension download watcher has a chance to finish.
      const domAttempt = domWait.catch(() => new Promise(() => {}));
      try {
        return await Promise.race([domAttempt, downloadWait]);
      } catch (err) {
        const domResult = await domWait.catch(() => null);
        if (domResult) return domResult;
        throw err;
      }
    }

    return await domWait;
  }

  async function waitForMaterializedArtifactUrl(before, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await delay(500);
      const candidates = collectArtifactsFromNode(document.body).filter((item) => (item.downloadUrl || item.url || item.src) && !before.has(item.id));
      if (candidates.length) return candidates[0];
    }
    throw new Error('Artifact action did not expose a downloadable URL');
  }

  function findArtifactActionButton(artifact) {
    const desired = normalizeComparable(artifact.actionLabel || artifact.name || artifact.text || '');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isUsableButton);
    return buttons.find((button) => {
      const attrs = normalizeComparable([button.getAttribute('data-testid'), button.getAttribute('aria-label'), button.getAttribute('title'), visibleText(button)].filter(Boolean).join(' '));
      return desired ? attrs.includes(desired.slice(0, 80)) || desired.includes(attrs.slice(0, 80)) : /download|artifact|canvas|скачать/i.test(attrs);
    }) || null;
  }

  async function streamArtifactData(commandId, artifact, url) {
    const data = await fetchArtifactData(url, artifact);
    if (data.filePath || data.filename) {
      await streamArtifactDownloadedFile(commandId, artifact, data);
      return;
    }
    const base64 = data.contentBase64 || '';
    const chunkSize = Number(artifact.chunkSize || CONFIG.artifactChunkSize) || CONFIG.artifactChunkSize;
    const totalChunks = Math.max(1, Math.ceil(base64.length / chunkSize));
    send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name: data.name, mime: data.mime, encodedSize: base64.length, totalChunks });
    for (let offset = 0, index = 0; offset < base64.length; offset += chunkSize, index += 1) {
      send({ type: 'artifact.data.chunk', commandId, artifactId: artifact.id, index, offset, totalChunks, contentBase64: base64.slice(offset, offset + chunkSize) });
      await delay(0);
    }
    send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name: data.name, mime: data.mime, encodedSize: base64.length, totalChunks });
  }

  async function streamArtifactDownloadedFile(commandId, artifact, download) {
    const filePath = download.filePath || download.filename || '';
    if (!filePath) throw new Error('Captured browser download has no local filename');
    const name = download.name || filePath.split(/[\/]/).pop() || artifact.name || 'artifact';
    const mime = download.mime || artifact.mime || guessMime(name, download.downloadUrl || download.url || '');
    send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0 });
    send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0 });
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

  const originalPushState = history.pushState;
  history.pushState = function bridgePushState() {
    const result = originalPushState.apply(this, arguments);
    schedulePageStatus('page.changed');
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function bridgeReplaceState() {
    const result = originalReplaceState.apply(this, arguments);
    schedulePageStatus('page.changed');
    return result;
  };

  window.addEventListener('popstate', () => schedulePageStatus('page.changed'));
  document.addEventListener('visibilitychange', () => schedulePageStatus('page.changed'));
  window.addEventListener('focus', () => schedulePageStatus('page.changed'));
  window.addEventListener('blur', () => schedulePageStatus('page.changed'));
  window.addEventListener('message', handleNetworkMessage);
  injectNetworkHook();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFloatingPanel, { once: true });
  else initFloatingPanel();
  connect();
})();
