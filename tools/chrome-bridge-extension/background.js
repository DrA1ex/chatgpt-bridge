const connections = new Map();

const downloadCaptures = new Map();
let downloadCaptureSeq = 0;

function makeDownloadCaptureId() {
  downloadCaptureSeq += 1;
  return `dl-${Date.now().toString(36)}-${downloadCaptureSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function portMatches(a, b) {
  return a === b;
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
  };
}

function beginDownloadCapture(port, options = {}) {
  if (!chrome.downloads?.onCreated || !chrome.downloads?.search) {
    throw new Error('chrome.downloads API is unavailable; add the downloads permission');
  }
  const captureId = makeDownloadCaptureId();
  const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || 120_000, 15 * 60_000));
  const state = {
    captureId,
    port,
    startedAt: Date.now(),
    timeoutMs,
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
  return { captureId, timeoutMs };
}

function findPendingDownloadCapture() {
  const pending = [...downloadCaptures.values()]
    .filter((state) => !state.done && !state.itemId)
    .sort((a, b) => a.startedAt - b.startedAt);
  return pending[0] || null;
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
    const state = findPendingDownloadCapture();
    if (!state) return;
    state.itemId = item.id;
    state.item = item;
    if (item.state === 'complete' && item.filename) resolveDownloadCapture(state, publicDownloadItem(item));
  });
}

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    const state = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === delta.id);
    if (!state) return;
    chrome.downloads.search({ id: delta.id }, (items) => {
      if (chrome.runtime.lastError) {
        rejectDownloadCapture(state, new Error(chrome.runtime.lastError.message));
        return;
      }
      updateCaptureWithDownloadItem(items?.[0] || { id: delta.id, state: delta.state?.current || '' });
    });
  });
}

function waitDownloadCapture(port, captureId, timeoutMs = 120_000) {
  const state = downloadCaptures.get(captureId);
  if (!state) return Promise.reject(new Error(`Unknown download capture: ${captureId}`));
  if (!portMatches(state.port, port)) return Promise.reject(new Error('Download capture belongs to another tab'));
  if (state.done) return state.error ? Promise.reject(state.error) : Promise.resolve(state.result);
  return new Promise((resolve, reject) => {
    const waitTimer = setTimeout(() => {
      if (state.waiting?.resolve === resolve) state.waiting = null;
      reject(new Error(`Timed out waiting for captured download: ${captureId}`));
    }, Math.max(1_000, Number(timeoutMs) || 120_000));
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
  clearTimeout(state.reconnectTimer);
  try { state.ws?.close?.(1000, reason); } catch {}
  connections.delete(port);
}

function post(port, message) {
  try { port.postMessage(message); } catch {}
}

function connectWebSocket(port, config) {
  closeConnection(port, 'replace');

  const state = {
    port,
    serverUrl: String(config.serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, ''),
    token: String(config.token || ''),
    clientId: String(config.clientId || ''),
    reconnectTimer: null,
    ws: null,
    queue: [],
    closed: false,
  };
  connections.set(port, state);

  const open = () => {
    if (state.closed) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl(state.serverUrl, state.token));
      state.ws = ws;
    } catch (err) {
      post(port, { type: 'extension.error', message: err.message || String(err) });
      scheduleReconnect(state);
      return;
    }

    ws.addEventListener('open', () => {
      post(port, { type: 'extension.connected', serverUrl: state.serverUrl });
      while (state.queue.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state.queue.shift()));
    });

    ws.addEventListener('message', (event) => {
      let payload = null;
      try { payload = JSON.parse(String(event.data)); } catch {}
      if (!payload || typeof payload !== 'object') return;
      post(port, { type: 'server.message', payload });
    });

    ws.addEventListener('close', () => {
      if (state.closed) return;
      post(port, { type: 'extension.status', status: 'extension disconnected', detail: 'WebSocket closed; reconnecting' });
      scheduleReconnect(state);
    });

    ws.addEventListener('error', () => {
      post(port, { type: 'extension.status', status: 'extension websocket error', detail: 'Check bridge server URL/token' });
    });
  };

  open();
}

function scheduleReconnect(state) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (state.closed || !connections.has(state.port)) return;
    try { state.ws?.close?.(); } catch {}
    state.ws = null;
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
      post(state.port, { type: 'extension.connected', serverUrl: state.serverUrl });
      while (state.queue.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state.queue.shift()));
    });
    ws.addEventListener('message', (event) => {
      let payload = null;
      try { payload = JSON.parse(String(event.data)); } catch {}
      if (payload && typeof payload === 'object') post(state.port, { type: 'server.message', payload });
    });
    ws.addEventListener('close', () => scheduleReconnect(state));
    ws.addEventListener('error', () => post(state.port, { type: 'extension.status', status: 'extension websocket error', detail: 'reconnecting' }));
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
      connectWebSocket(port, message);
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
    if (message.type === 'bridge.download.capture.wait') {
      waitDownloadCapture(port, String(message.captureId || ''), message.timeoutMs)
        .then((result) => post(port, { type: 'extension.response', requestId: message.requestId, result }))
        .catch((err) => post(port, { type: 'extension.response', requestId: message.requestId, error: err.message || String(err) }));
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
