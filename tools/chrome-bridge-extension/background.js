import {
  BackgroundStateStore,
  createRuntimeEpoch,
} from './background/stateV4.js';
import {
  MessageKind,
  isProtocol4Envelope,
} from './background/protocolV4.js';
import { installBackgroundPortRouter } from './background/portRouter.js';
import { createProtocolOutbox } from './background/outboxV4.js';
import { createUnreportedCriticalReporter } from './background/unreportedCriticalReporter.js';
import { TabOperationPriority, TabOperationQueue } from './background/tabOperationQueue.js';
import { serverEnvelopeQueueOptions } from './background/operationPriorityPolicy.js';
import { handleServerEnvelope } from './background/serverEnvelopeRouter.js';
import { createDownloadCoordinator } from './background/downloadCoordinator.js';
import { createMaintenanceOperationStore } from './background/maintenanceOperations.js';
import { createExtensionReloadCoordinator } from './background/extensionReloadCoordinator.js';
import { createTabController } from './background/tabController.js';
import { checkBridgeAuth } from './background/authPreflight.js';
const connections = new Map();
const backgroundEpoch = createRuntimeEpoch('background');
const backgroundState = new BackgroundStateStore(chrome.storage?.session, backgroundEpoch);
void backgroundState.cleanupLegacyStateIfIdle().catch((error) => console.warn('[chatgpt-bridge] background legacy-state cleanup failed', error));
const tabOperations = new TabOperationQueue({ maxPending: 250, reservedCritical: 16 });
const maintenanceOperations = createMaintenanceOperationStore(chrome.storage?.local);
const launchedTabs = new Map();
const LAUNCHED_TAB_STORAGE_PREFIX = 'chatgptBridgeLaunchedTab:';
const BRIDGE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);
let notifyBackgroundStateChanged = async () => {};
const {
  downloadCaptures,
  portMatches,
  beginDownloadCapture,
  addDownloadCaptureExpectedNames,
  startDownloadCapture,
  waitDownloadCapture,
  waitDownloadCaptureBound,
  releaseDownloadCapture,
  cancelDownloadCapture,
  restoreDownloadCapturesForPort,
  rejectDownloadCapture,
} = createDownloadCoordinator({
  backgroundState,
  onStateChanged: (tabId, runtime) => notifyBackgroundStateChanged(tabId, runtime),
});
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
function wsUrl(serverUrl, token) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = new URL('/extension/ws', base);
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
const { replayCriticalOutbox, sendProtocolPayload } = createProtocolOutbox({
  backgroundEpoch, backgroundState, post, summarize,
});
const { flush: flushUnreportedCritical } = createUnreportedCriticalReporter({ backgroundState, sendProtocolPayload });
notifyBackgroundStateChanged = async (tabId) => {
  const state = [...connections.values()].find((candidate) => candidate.tabId === tabId && !candidate.closed) || null;
  if (state) await flushUnreportedCritical(state);
};

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
  if (launchToken.startsWith('bridge-reload-')) {
    const existing = await readLaunchedTab(tabId);
    if (existing?.launchToken && !existing.launchToken.startsWith('bridge-reload-')) {
      return {
        ...existing,
        requestedUrl: existing.requestedUrl || String(page.requestedUrl || page.url || ''),
        serverUrl: safeBridgeServerUrl(page.launchServerUrl || page.serverUrl || '') || existing.serverUrl,
      };
    }
    return {
      launchToken: '',
      requestedUrl: String(page.requestedUrl || page.url || ''),
      createdAt: Date.now(),
      serverUrl: safeBridgeServerUrl(page.launchServerUrl || page.serverUrl || ''),
    };
  }
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
const {
  openBridgeTab,
  closeOwnBridgeTab,
  closeOwnedBridgeTab,
  navigateTab,
  reloadTab,
  reloadOwnBridgeTab,
} = createTabController({
  connections,
  safeBridgeServerUrl,
  rememberLaunchedTab,
  readLaunchedTab,
  forgetLaunchedTab,
  isStableLaunchToken: (value) => BRIDGE_LAUNCH_TOKEN_RE.test(String(value || '')) && !String(value).startsWith('bridge-reload-'),
});

function connectWebSocket(port, config) {
  closeConnection(port, 'replace');
  const state = {
    port,
    serverUrl: safeBridgeServerUrl(config.serverUrl) || 'http://127.0.0.1:8080',
    token: String(config.token || ''),
    clientId: String(config.clientId || ''),
    reconnectTimer: null,
    ws: null,
    closed: false,
    tabId: port?.sender?.tab?.id ?? null,
    contentEpoch: String(config.page?.contentEpoch || ''),
    connectionEpoch: createRuntimeEpoch('connection'),
    protocolReady: false, preHelloPayloads: [],
    launchMetaPromise: readLaunchedTab(port?.sender?.tab?.id ?? null),
  };
  connections.set(port, state);
  void backgroundState.transition(state.tabId, {
    type: 'content.attached',
    contentEpoch: state.contentEpoch,
  }).then((outcome) => {
    if (!outcome.accepted) throw new Error(`Unable to attach content runtime: ${outcome.reason}`);
    restoreDownloadCapturesForPort(port, outcome.state);
    return openConnection(state);
  }).catch((err) => post(port, { type: 'extension.error', message: err.message || String(err) }));
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
  let ws; try {
    state.protocolReady = false;
    ws = new WebSocket(wsUrl(state.serverUrl, state.token));
    state.ws = ws;
  } catch (err) {
    post(state.port, { type: 'extension.error', message: err.message || String(err) });
    scheduleReconnect(state);
    return;
  }
  ws.addEventListener('open', () => {
    void tabOperations.run(state.tabId, async () => {
      const connected = await backgroundState.transition(state.tabId, {
        type: 'transport.connected', connectionEpoch: state.connectionEpoch, contentEpoch: state.contentEpoch,
      });
      if (!connected.accepted) throw new Error(`Unable to persist transport connection: ${connected.reason}`);
      const [launchMeta, runtime] = await Promise.all([state.launchMetaPromise, backgroundState.read(state.tabId)]);
      post(state.port, {
        type: 'extension.connected',
        serverUrl: state.serverUrl,
        browserTabId: state.tabId,
        launchToken: launchMeta?.launchToken || '',
        requestedUrl: launchMeta?.requestedUrl || '',
        backgroundEpoch,
        contentEpoch: runtime.contentEpoch,
        recovery: {
          lease: runtime.lease,
          effects: runtime.effectOrder.map((id) => runtime.effects[id]).filter(Boolean),
          acknowledgedSequence: runtime.transport.ackCursor,
        },
        health: {
          outbox: { size: runtime.outbox.length, ...runtime.metrics },
          tabQueue: tabOperations.metrics(state.tabId),
        },
      });
    }, { label: 'transport.open', priority: TabOperationPriority.OWNER_INVALIDATION, critical: true }).catch((error) => post(state.port, { type: 'extension.error', message: error.message || String(error) }));
  });
  ws.addEventListener('message', (event) => {
    let envelope = null;
    try { envelope = JSON.parse(String(event.data)); } catch {}
    if (!isProtocol4Envelope(envelope)) {
      try { ws.close(1002, 'protocol 4 envelope required'); } catch {}
      post(state.port, { type: 'extension.error', message: 'Bridge sent an invalid protocol 4 envelope' });
      return;
    }
    void tabOperations.run(state.tabId, () => handleServerEnvelope({
      state,
      envelope,
      backgroundState,
      sendProtocolPayload,
      flushUnreportedCritical,
      post,
    }), serverEnvelopeQueueOptions(envelope)).catch((error) => {
      post(state.port, { type: 'extension.error', message: error.message || String(error) });
    });
  });
  ws.addEventListener('close', (event) => {
    void tabOperations.run(state.tabId, () => backgroundState.transition(state.tabId, {
      type: 'transport.disconnected', contentEpoch: state.contentEpoch,
    }), { label: 'transport.close', priority: TabOperationPriority.OWNER_INVALIDATION, critical: true }).catch(() => {});
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

const { recoverPendingExtensionReload, scheduleExtensionReload } = createExtensionReloadCoordinator({
  backgroundState,
  maintenanceOperations,
  safeBridgeServerUrl,
  readLaunchedTab,
  rememberLaunchedTab,
  navigateTab,
  reloadTab,
  launchTokenPattern: BRIDGE_LAUNCH_TOKEN_RE,
});
function reportMaintenanceRecoveryFailure(error) {
  console.error('[chatgpt-bridge] maintenance recovery failed', error);
}
chrome.runtime.onInstalled?.addListener?.((details) => {
  if (details?.reason === 'update') void recoverPendingExtensionReload()
    .then(async (result) => { if (result?.reason === 'missing') await maintenanceOperations.recover(); })
    .catch(reportMaintenanceRecoveryFailure);
});
void recoverPendingExtensionReload()
  .then(async (result) => { if (result?.reason === 'missing') await maintenanceOperations.recover(); })
  .catch(reportMaintenanceRecoveryFailure);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.type !== 'bridge.http') return false;
  performHttp(message.request || {})
    .then((result) => sendResponse({ requestId: message.requestId, result }))
    .catch((err) => sendResponse({ requestId: message.requestId, error: err.message || String(err) }));
  return true;
});
installBackgroundPortRouter({
  connections,
  backgroundState,
  tabOperations,
  post,
  sendProtocolPayload,
  replayCriticalOutbox,
  flushUnreportedCritical,
  adoptPageLaunchMetadata,
  readLaunchedTab,
  safeBridgeServerUrl,
  connectWebSocket,
  beginDownloadCapture,
  addDownloadCaptureExpectedNames,
  startDownloadCapture,
  waitDownloadCapture,
  waitDownloadCaptureBound,
  releaseDownloadCapture,
  cancelDownloadCapture,
  openBridgeTab,
  closeOwnBridgeTab,
  closeOwnedBridgeTab,
  navigateTab,
  reloadTab,
  reloadOwnBridgeTab,
  scheduleExtensionReload,
  performHttp,
  downloadCaptures,
  portMatches,
  rejectDownloadCapture,
  closeConnection,
});
chrome.action?.onClicked?.addListener?.((tab) => {
  if (!Number.isInteger(tab?.id)) return;
  const url = String(tab.url || '');
  if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(url)) return;
  void chrome.tabs.sendMessage(tab.id, { type: 'extension.ui.open' }).catch(() => {});
});
chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  void forgetLaunchedTab(tabId);
  tabOperations.clear(tabId);
  void backgroundState.remove(tabId).catch((error) => console.warn(`[chatgpt-bridge] background state cleanup failed for tab ${tabId}`, error));
});
