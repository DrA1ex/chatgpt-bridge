const connections = new Map();
const launchedTabs = new Map();
const LAUNCHED_TAB_STORAGE_PREFIX = 'chatgptBridgeLaunchedTab:';
const BRIDGE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);

function safeBridgeServerUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' || !LOOPBACK_BRIDGE_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) return '';
    if (parsed.pathname && parsed.pathname !== '/') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

const downloadCaptures = new Map();
let downloadCaptureSeq = 0;

function makeDownloadCaptureId() {
  downloadCaptureSeq += 1;
  return `dl-${Date.now().toString(36)}-${downloadCaptureSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function portMatches(a, b) {
  return a === b;
}

function normalizeDownloadName(value = '') {
  const raw = String(value || '').split(/[\\/]/).pop() || '';
  try { return decodeURIComponent(raw).trim().toLowerCase(); } catch { return raw.trim().toLowerCase(); }
}

function normalizeConflictName(value = '') {
  const name = normalizeDownloadName(value);
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  return `${stem.replace(/ \([0-9]+\)$/i, '')}${ext}`;
}

function downloadCandidateNames(item = {}) {
  const values = [item.filename, item.url, item.finalUrl]
    .filter(Boolean)
    .map((value) => normalizeDownloadName(value));
  return [...new Set(values.filter(Boolean))];
}

function downloadCaptureExpectedNames(state = {}) {
  return [...new Set([
    state.expectedName,
    state.artifact?.name,
    ...(Array.isArray(state.expectedNames) ? state.expectedNames : []),
  ].map(normalizeConflictName).filter(Boolean))];
}

function scoreDownloadCapture(state, item = {}) {
  if (!state || state.done || state.itemId) return -Infinity;
  const expectedNames = downloadCaptureExpectedNames(state);
  const candidates = downloadCandidateNames(item);
  if (!expectedNames.length) return 1;
  let best = -Infinity;
  for (const expected of expectedNames) {
    for (const candidate of candidates) {
      const normalized = normalizeConflictName(candidate);
      if (normalized === expected) best = Math.max(best, 300);
      else if (normalized.endsWith(`/${expected}`) || normalized.includes(expected)) best = Math.max(best, 220);
      else {
        const expectedStem = expected.replace(/\.[^.]+$/, '');
        const candidateStem = normalized.replace(/\.[^.]+$/, '');
        if (expectedStem && candidateStem && (candidateStem.includes(expectedStem) || expectedStem.includes(candidateStem))) best = Math.max(best, 120);
      }
    }
  }
  return best;
}

function cleanupDownloadCapture(captureId, delayMs = 30_000) {
  setTimeout(() => {
    const state = downloadCaptures.get(captureId);
    if (!state || state.waiting) return;
    downloadCaptures.delete(captureId);
  }, delayMs);
}

function publicDownloadItem(item = {}) {
  return {
    id: item.id,
    url: item.url || '',
    finalUrl: item.finalUrl || '',
    filename: item.filename || '',
    name: item.filename ? item.filename.split(/[\\/]/).pop() : '',
    mime: item.mime || '',
    fileSize: item.fileSize || 0,
    bytesReceived: item.bytesReceived || 0,
    state: item.state || '',
    danger: item.danger || '',
    exists: item.exists !== false,
    startTime: item.startTime || '',
  };
}

function beginDownloadCapture(port, options = {}) {
  if (!chrome.downloads?.onCreated || !chrome.downloads?.search) {
    throw new Error('chrome.downloads API is unavailable; add the downloads permission');
  }
  const captureId = makeDownloadCaptureId();
  const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || 45_000, 15 * 60_000));
  const state = {
    captureId,
    port,
    tabId: port?.sender?.tab?.id ?? null,
    startedAt: Date.now(),
    timeoutMs,
    expectedName: String(options.expectedName || options.artifact?.name || ''),
    expectedNames: Array.from(options.expectedNames || []).map(String).filter(Boolean),
    itemId: null,
    item: null,
    done: false,
    result: null,
    error: null,
    waiting: null,
    timer: null,
    artifact: options.artifact || null,
  };
  state.timer = setTimeout(() => rejectDownloadCapture(state, new Error(`Timed out waiting for browser download after ${timeoutMs}ms`)), timeoutMs);
  downloadCaptures.set(captureId, state);
  return { captureId, timeoutMs, expectedName: state.expectedName, expectedNames: state.expectedNames };
}

function findPendingDownloadCapture(item = {}) {
  const ranked = [...downloadCaptures.values()]
    .filter((state) => !state.done && !state.itemId)
    .map((state) => ({ state, score: scoreDownloadCapture(state, item) }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.state.startedAt - b.state.startedAt);
  return ranked[0]?.state || null;
}

function resolveDownloadCapture(state, result) {
  if (!state || state.done) return;
  state.done = true;
  state.result = result;
  clearTimeout(state.timer);
  const waiter = state.waiting;
  state.waiting = null;
  if (waiter) waiter.resolve(result);
  cleanupDownloadCapture(state.captureId);
}

function rejectDownloadCapture(state, err) {
  if (!state || state.done) return;
  state.done = true;
  state.error = err;
  clearTimeout(state.timer);
  const waiter = state.waiting;
  state.waiting = null;
  if (waiter) waiter.reject(err);
  cleanupDownloadCapture(state.captureId);
}

function addDownloadCaptureExpectedNames(port, captureId, expectedNames = []) {
  const state = downloadCaptures.get(captureId);
  if (!state) throw new Error(`Unknown download capture: ${captureId}`);
  if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
  if (state.done || state.itemId) return { captureId, updated: false, expectedNames: downloadCaptureExpectedNames(state) };
  state.expectedNames = [...new Set([
    ...(state.expectedNames || []),
    ...Array.from(expectedNames || []).map(String).filter(Boolean),
  ])];
  return { captureId, updated: true, expectedNames: downloadCaptureExpectedNames(state) };
}

function cancelDownloadCapture(port, captureId, reason = 'cancelled') {
  const state = downloadCaptures.get(captureId);
  if (!state) return { captureId, cancelled: false, missing: true };
  if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
  rejectDownloadCapture(state, new Error(`Browser download capture ${reason}`));
  downloadCaptures.delete(captureId);
  return { captureId, cancelled: true };
}

function updateCaptureWithDownloadItem(item) {
  if (!item) return;
  const state = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === item.id);
  if (!state) return;
  state.item = { ...(state.item || {}), ...item };
  if (item.state === 'complete' && item.filename) resolveDownloadCapture(state, publicDownloadItem(item));
  if (item.state === 'interrupted') rejectDownloadCapture(state, new Error(`Browser download interrupted: ${item.error || item.danger || item.id}`));
}

if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    const state = findPendingDownloadCapture(item);
    if (!state) return;
    state.itemId = item.id;
    state.item = item;
    if (item.state === 'complete' && item.filename) resolveDownloadCapture(state, publicDownloadItem(item));
  });
}

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    chrome.downloads.search({ id: delta.id }, (items) => {
      const knownState = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === delta.id);
      if (chrome.runtime.lastError) {
        if (knownState) rejectDownloadCapture(knownState, new Error(chrome.runtime.lastError.message));
        return;
      }
      const item = items?.[0] || { id: delta.id, state: delta.state?.current || '' };
      const state = knownState || findPendingDownloadCapture(item);
      if (!state) return;
      if (!state.itemId) state.itemId = delta.id;
      updateCaptureWithDownloadItem(item);
    });
  });
}

function waitDownloadCapture(port, captureId, timeoutMs = 45_000) {
  const state = downloadCaptures.get(captureId);
  if (!state) return Promise.reject(new Error(`Unknown download capture: ${captureId}`));
  if (!portMatches(state.port, port)) return Promise.reject(new Error('Download capture belongs to another tab'));
  if (state.done) return state.error ? Promise.reject(state.error) : Promise.resolve(state.result);
  return new Promise((resolve, reject) => {
    const waitTimer = setTimeout(() => {
      if (state.waiting?.resolve === resolve) state.waiting = null;
      reject(new Error(`Timed out waiting for captured download: ${captureId}`));
    }, Math.max(1_000, Number(timeoutMs) || 45_000));
    state.waiting = {
      resolve(value) { clearTimeout(waitTimer); resolve(value); },
      reject(err) { clearTimeout(waitTimer); reject(err); },
    };
  });
}


function wsUrl(serverUrl, token) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = new URL('/tm/ws', base);
  if (token) url.searchParams.set('token', token);
  url.searchParams.set('runtime', 'extension');
  return url.toString();
}

function httpUrl(serverUrl, pathname) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  return new URL(pathname, base);
}

function bridgeAuthCheckUrl(serverUrl, token) {
  const url = httpUrl(serverUrl, '/tm/auth/check');
  if (token) url.searchParams.set('token', token);
  url.searchParams.set('runtime', 'extension');
  return url.toString();
}

function responseDetailText(status, bodyText = '') {
  const text = String(bodyText || '').trim();
  if (!text) return `HTTP ${status}`;
  try {
    const json = JSON.parse(text);
    return String(json.detail || json.error || json.message || text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function checkBridgeAuth(state) {
  const url = bridgeAuthCheckUrl(state.serverUrl, state.token);
  try {
    const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => '');
    const detail = responseDetailText(response.status, text);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        authError: true,
        status: response.status,
        message: `BRIDGE_TOKEN was rejected by the bridge server (${response.status}). ${detail}`,
      };
    }
    return { ok: false, status: response.status, message: `Bridge auth preflight failed: ${detail}` };
  } catch (err) {
    return { ok: false, offline: true, message: err?.message || String(err) };
  }
}

function summarize(payload = {}) {
  return {
    type: payload.type || 'unknown',
    requestId: payload.requestId,
    commandId: payload.commandId,
    eventType: payload.event?.type,
  };
}

function closeConnection(port, reason = 'reconnect') {
  const state = connections.get(port);
  if (!state) return;
  state.closed = true;
  clearTimeout(state.reconnectTimer);
  try { state.ws?.close?.(1000, reason); } catch {}
  connections.delete(port);
}

function post(port, message) {
  try { port.postMessage(message); } catch {}
}

function launchedTabStorageKey(tabId) {
  return `${LAUNCHED_TAB_STORAGE_PREFIX}${tabId}`;
}

async function rememberLaunchedTab(tabId, meta = {}) {
  if (!Number.isInteger(tabId)) return;
  const record = {
    launchToken: String(meta.launchToken || ''),
    requestedUrl: String(meta.requestedUrl || ''),
    createdAt: Number(meta.createdAt || Date.now()),
    serverUrl: safeBridgeServerUrl(meta.serverUrl || ''),
  };
  launchedTabs.set(tabId, record);
  try { await chrome.storage.session?.set?.({ [launchedTabStorageKey(tabId)]: record }); } catch {}
}

async function readLaunchedTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const memory = launchedTabs.get(tabId);
  if (memory) return memory;
  try {
    const stored = await chrome.storage.session?.get?.(launchedTabStorageKey(tabId));
    const record = stored?.[launchedTabStorageKey(tabId)] || null;
    if (record) launchedTabs.set(tabId, record);
    return record;
  } catch {
    return null;
  }
}

async function forgetLaunchedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  launchedTabs.delete(tabId);
  try { await chrome.storage.session?.remove?.(launchedTabStorageKey(tabId)); } catch {}
}

async function adoptPageLaunchMetadata(port, page = {}) {
  const tabId = port?.sender?.tab?.id;
  const launchToken = String(page.launchToken || '');
  if (!Number.isInteger(tabId) || !BRIDGE_LAUNCH_TOKEN_RE.test(launchToken)) return null;
  const existing = await readLaunchedTab(tabId);
  if (existing?.launchToken) {
    const merged = {
      ...existing,
      requestedUrl: existing.requestedUrl || String(page.requestedUrl || page.url || ''),
      serverUrl: existing.serverUrl || safeBridgeServerUrl(page.launchServerUrl || page.serverUrl || ''),
    };
    if (merged.requestedUrl !== existing.requestedUrl || merged.serverUrl !== existing.serverUrl) await rememberLaunchedTab(tabId, merged);
    return merged;
  }
  const record = {
    launchToken,
    requestedUrl: String(page.requestedUrl || page.url || ''),
    createdAt: Date.now(),
    serverUrl: safeBridgeServerUrl(page.launchServerUrl || page.serverUrl || ''),
  };
  await rememberLaunchedTab(tabId, record);
  return record;
}

function createTab(options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create(options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function updateTab(tabId, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function safeChatUrl(value = '') {
  const parsed = new URL(String(value || 'https://chatgpt.com/'));
  if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(parsed.origin.toLowerCase()) || parsed.username || parsed.password) {
    throw new Error(`Refusing to open non-ChatGPT URL: ${parsed.toString()}`);
  }
  return parsed.toString();
}

async function openBridgeTab(port, options = {}) {
  const requestedUrl = safeChatUrl(options.url || 'https://chatgpt.com/');
  const launchToken = String(options.launchToken || `bridge-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const connectionServerUrl = connections.get(port)?.serverUrl || '';
  const bridgeServerUrl = safeBridgeServerUrl(options.bridgeServerUrl || connectionServerUrl);
  const active = options.active !== false;
  const tab = await createTab({ url: 'about:blank', active });
  if (!Number.isInteger(tab?.id)) throw new Error('Chrome did not return a tab id for the new ChatGPT tab');
  try {
    // Persist the launch identity before navigating. Otherwise a very fast content-script
    // connection can win the race and announce itself without the one-time token.
    await rememberLaunchedTab(tab.id, { launchToken, requestedUrl, createdAt: Date.now(), serverUrl: bridgeServerUrl });
    await updateTab(tab.id, { url: requestedUrl, active });
  } catch (err) {
    await forgetLaunchedTab(tab.id);
    await removeTab(tab.id).catch(() => {});
    throw err;
  }
  return { tabId: tab.id, launchToken, requestedUrl, bridgeServerUrl, active, openerTabId: port?.sender?.tab?.id ?? null };
}

async function closeOwnBridgeTab(port, options = {}) {
  const tabId = port?.sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
  const launch = await readLaunchedTab(tabId);
  const expectedLaunchToken = String(options.expectedLaunchToken || '');
  if (expectedLaunchToken && launch?.launchToken !== expectedLaunchToken) {
    throw new Error('Refusing to close tab because its launch token does not match');
  }
  setTimeout(() => {
    void removeTab(tabId).catch(() => {});
  }, 150);
  return { tabId, closing: true, launchToken: launch?.launchToken || '' };
}

function connectWebSocket(port, config) {
  closeConnection(port, 'replace');

  const state = {
    port,
    serverUrl: safeBridgeServerUrl(config.serverUrl) || 'http://127.0.0.1:8080',
    token: String(config.token || ''),
    clientId: String(config.clientId || ''),
    reconnectTimer: null,
    ws: null,
    queue: [],
    closed: false,
    tabId: port?.sender?.tab?.id ?? null,
    launchMetaPromise: readLaunchedTab(port?.sender?.tab?.id ?? null),
  };
  connections.set(port, state);

  void openConnection(state);
}

async function openConnection(state) {
  if (state.closed || !connections.has(state.port)) return;

  post(state.port, { type: 'extension.status', status: 'checking bridge token', detail: 'Validating BRIDGE_TOKEN before opening WebSocket' });
  const auth = await checkBridgeAuth(state);
  if (state.closed || !connections.has(state.port)) return;
  if (!auth.ok) {
    if (auth.authError) {
      post(state.port, { type: 'extension.auth_error', status: 'auth failed', detail: auth.message, httpStatus: auth.status });
      return;
    }
    post(state.port, { type: 'extension.status', status: auth.offline ? 'server unreachable' : 'bridge auth check failed', detail: `${auth.message}; reconnecting` });
    scheduleReconnect(state);
    return;
  }

  let ws;
  try {
    ws = new WebSocket(wsUrl(state.serverUrl, state.token));
    state.ws = ws;
  } catch (err) {
    post(state.port, { type: 'extension.error', message: err.message || String(err) });
    scheduleReconnect(state);
    return;
  }

  ws.addEventListener('open', () => {
    void Promise.resolve(state.launchMetaPromise).then((launchMeta) => {
      post(state.port, {
        type: 'extension.connected',
        serverUrl: state.serverUrl,
        browserTabId: state.tabId,
        launchToken: launchMeta?.launchToken || '',
        requestedUrl: launchMeta?.requestedUrl || '',
      });
      while (state.queue.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state.queue.shift()));
    });
  });

  ws.addEventListener('message', (event) => {
    let payload = null;
    try { payload = JSON.parse(String(event.data)); } catch {}
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'extension.status' || payload.type === 'extension.compatibility') {
      post(state.port, {
        type: 'extension.status',
        status: payload.status || (payload.compatible === false ? 'extension update required' : 'compatible'),
        detail: payload.detail || payload.compatibility?.message || '',
        compatibility: payload.compatibility || null,
      });
    }
    post(state.port, { type: 'server.message', payload });
  });

  ws.addEventListener('close', (event) => {
    if (state.closed) return;
    post(state.port, { type: 'extension.status', status: 'extension disconnected', detail: `WebSocket closed${event?.code ? ` (${event.code})` : ''}; reconnecting` });
    scheduleReconnect(state);
  });

  ws.addEventListener('error', () => {
    post(state.port, { type: 'extension.status', status: 'extension websocket error', detail: 'WebSocket failed after token preflight; reconnecting' });
  });
}

function scheduleReconnect(state) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (state.closed || !connections.has(state.port)) return;
    try { state.ws?.close?.(); } catch {}
    state.ws = null;
    void openConnection(state);
  }, 1500);
}

async function performHttp(request) {
  const method = request.method || 'GET';
  const headers = request.headers || {};
  const body = request.data === undefined ? undefined : (typeof request.data === 'string' ? request.data : JSON.stringify(request.data));
  if (body !== undefined && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(request.url, { method, headers, body, credentials: 'omit' });
  const contentType = response.headers.get('content-type') || '';
  if (request.responseType === 'arraybuffer' || request.responseType === 'blob') {
    const buffer = await response.arrayBuffer();
    return { status: response.status, ok: response.ok, responseType: 'arraybuffer', data: Array.from(new Uint8Array(buffer)), contentType };
  }
  const text = await response.text();
  let json = null;
  if (/json/i.test(contentType)) {
    try { json = JSON.parse(text); } catch {}
  }
  return { status: response.status, ok: response.ok, responseType: json ? 'json' : 'text', data: json || text, contentType };
}


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.type !== 'bridge.http') return false;
  performHttp(message.request || {})
    .then((result) => sendResponse({ requestId: message.requestId, result }))
    .catch((err) => sendResponse({ requestId: message.requestId, error: err.message || String(err) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chatgpt-bridge-tab') return;

  port.onMessage.addListener(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'bridge.connect') {
      const adopted = await adoptPageLaunchMetadata(port, message.page || {});
      const launchMeta = adopted || await readLaunchedTab(port?.sender?.tab?.id ?? null);
      connectWebSocket(port, {
        ...message,
        serverUrl: safeBridgeServerUrl(launchMeta?.serverUrl || message.serverUrl) || message.serverUrl,
      });
      return;
    }
    if (message.type === 'bridge.payload') {
      const state = connections.get(port);
      if (!state) {
        post(port, { type: 'extension.error', message: 'Extension transport is not connected' });
        return;
      }
      const payload = message.payload || {};
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
      else {
        state.queue.push(payload);
        while (state.queue.length > 1000) state.queue.shift();
        post(port, { type: 'extension.status', status: 'extension queueing', detail: JSON.stringify(summarize(payload)) });
      }
      return;
    }
    if (message.type === 'bridge.download.capture.begin') {
      try {
        const result = beginDownloadCapture(port, message || {});
        post(port, { type: 'extension.response', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) });
      }
      return;
    }
    if (message.type === 'bridge.download.capture.add_expected_names') {
      try {
        const result = addDownloadCaptureExpectedNames(port, String(message.captureId || ''), message.expectedNames || []);
        post(port, { type: 'extension.response', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) });
      }
      return;
    }
    if (message.type === 'bridge.download.capture.wait') {
      waitDownloadCapture(port, String(message.captureId || ''), message.timeoutMs)
        .then((result) => post(port, { type: 'extension.response', requestId: message.requestId, result }))
        .catch((err) => post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) }));
      return;
    }
    if (message.type === 'bridge.download.capture.cancel') {
      try {
        const result = cancelDownloadCapture(port, String(message.captureId || ''), String(message.reason || 'cancelled'));
        post(port, { type: 'extension.response', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) });
      }
      return;
    }
    if (message.type === 'bridge.tab.open') {
      try {
        const result = await openBridgeTab(port, message || {});
        post(port, { type: 'extension.response', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) });
      }
      return;
    }
    if (message.type === 'bridge.tab.close') {
      try {
        const result = await closeOwnBridgeTab(port, message || {});
        post(port, { type: 'extension.response', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) });
      }
      return;
    }
    if (message.type === 'bridge.http') {
      try {
        const result = await performHttp(message.request || {});
        post(port, { type: 'bridge.http.result', requestId: message.requestId, result });
      } catch (err) {
        post(port, { type: 'bridge.http.result', requestId: message.requestId, error: err.message || String(err) });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const state = connections.get(port);
    if (state) state.closed = true;
    for (const capture of downloadCaptures.values()) {
      if (!capture.done && portMatches(capture.port, port)) rejectDownloadCapture(capture, new Error('Content script disconnected while waiting for download'));
    }
    closeConnection(port, 'content-disconnected');
  });
});

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  void forgetLaunchedTab(tabId);
});
