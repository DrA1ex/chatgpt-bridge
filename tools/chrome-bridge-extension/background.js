import {
  BackgroundStateStore,
  DownloadStatus,
  createRuntimeEpoch,
} from './background/stateV4.js';
import {
  MessageKind,
  isProtocol4Envelope,
} from './background/protocolV4.js';
import { installBackgroundPortRouter } from './background/portRouter.js';
import { createProtocolOutbox } from './background/outboxV4.js';
const connections = new Map();
const backgroundEpoch = createRuntimeEpoch('background');
const backgroundState = new BackgroundStateStore(chrome.storage?.session, backgroundEpoch);
const launchedTabs = new Map();
const LAUNCHED_TAB_STORAGE_PREFIX = 'chatgptBridgeLaunchedTab:';
const BRIDGE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);
const PENDING_EXTENSION_RELOAD_KEY = 'bridgePendingExtensionReload';
const PENDING_EXTENSION_RELOAD_TTL_MS = 2 * 60_000;
let pendingExtensionReloadRecovery = null;
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
function publicDownloadItem(item = {}, capture = null) {
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
    endTime: item.endTime || '',
    captureId: capture?.captureId || '',
    captureStartedAt: capture?.startedAt || 0,
    capturedAt: Date.now(),
    expectedNames: capture ? downloadCaptureExpectedNames(capture) : [],
  };
}
async function beginDownloadCapture(port, options = {}) {
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
    boundWaiters: new Set(),
    timer: null,
    artifact: options.artifact || null,
  };
  const runtime = await backgroundState.read(state.tabId);
  const planned = await backgroundState.transition(state.tabId, {
    type: 'download.transition',
    captureId,
    status: DownloadStatus.PLANNED,
    requestId: runtime.lease?.requestId || '',
    leaseId: runtime.lease?.leaseId || '',
    expectedNames: downloadCaptureExpectedNames(state),
    contentEpoch: runtime.contentEpoch,
  });
  if (!planned.accepted) throw new Error(`Unable to persist download capture: ${planned.reason}`);
  state.timer = setTimeout(() => rejectDownloadCapture(state, new Error(`Timed out waiting for browser download after ${timeoutMs}ms`)), timeoutMs);
  downloadCaptures.set(captureId, state);
  await backgroundState.transition(state.tabId, {
    type: 'download.transition',
    captureId,
    status: DownloadStatus.ARMED,
    expectedNames: downloadCaptureExpectedNames(state),
    contentEpoch: runtime.contentEpoch,
  });
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
function captureBindingResult(state) {
  const item = state?.item || (state?.itemId != null ? { id: state.itemId } : null);
  return {
    captureId: state?.captureId || '',
    bound: state?.itemId != null,
    complete: Boolean(state?.done && state?.result),
    failed: Boolean(state?.done && state?.error),
    item: item ? publicDownloadItem(item, state) : null,
    result: state?.result || null,
    error: state?.error?.message || '',
  };
}
function notifyDownloadCaptureBound(state) {
  if (!state?.boundWaiters?.size) return;
  const result = captureBindingResult(state);
  for (const waiter of state.boundWaiters) waiter.resolve(result);
  state.boundWaiters.clear();
}
function bindDownloadCapture(state, item = {}) {
  if (!state || state.done) return false;
  if (state.itemId == null) state.itemId = item.id;
  state.item = { ...(state.item || {}), ...item };
  void backgroundState.read(state.tabId).then((runtime) => backgroundState.transition(state.tabId, {
    type: 'download.transition',
    captureId: state.captureId,
    status: DownloadStatus.BOUND,
    downloadId: state.itemId,
    expectedNames: downloadCaptureExpectedNames(state),
    contentEpoch: runtime.contentEpoch,
  }));
  notifyDownloadCaptureBound(state);
  return true;
}
function resolveDownloadCapture(state, result) {
  if (!state || state.done) return;
  state.done = true;
  state.result = result;
  void backgroundState.read(state.tabId).then((runtime) => backgroundState.transition(state.tabId, {
    type: 'download.transition',
    captureId: state.captureId,
    status: DownloadStatus.COMPLETED,
    downloadId: state.itemId,
    contentEpoch: runtime.contentEpoch,
  }));
  clearTimeout(state.timer);
  notifyDownloadCaptureBound(state);
  const waiter = state.waiting;
  state.waiting = null;
  if (waiter) waiter.resolve(result);
  cleanupDownloadCapture(state.captureId);
}
function rejectDownloadCapture(state, err) {
  if (!state || state.done) return;
  state.done = true;
  state.error = err;
  void backgroundState.read(state.tabId).then((runtime) => backgroundState.transition(state.tabId, {
    type: 'download.transition',
    captureId: state.captureId,
    status: DownloadStatus.FAILED,
    downloadId: state.itemId,
    contentEpoch: runtime.contentEpoch,
  }));
  clearTimeout(state.timer);
  notifyDownloadCaptureBound(state);
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
  // Once chrome.downloads has assigned an id, cancelling the observer would
  // discard the only trustworthy identity for a file that is already being
  // written to the user's Downloads directory. Keep the capture alive so the
  // content script can adopt the browser result and the bridge can remove that
  // exact file after importing it.
  if (state.itemId != null) return { ...captureBindingResult(state), cancelled: false };
  rejectDownloadCapture(state, new Error(`Browser download capture ${reason}`));
  downloadCaptures.delete(captureId);
  return { captureId, cancelled: true, bound: false };
}
async function startDownloadCapture(port, captureId, url = '') {
  const state = downloadCaptures.get(captureId);
  if (!state) throw new Error(`Unknown download capture: ${captureId}`);
  if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
  const target = String(url || ''); if (!/^https:\/\//i.test(target)) throw new Error('Captured download requires an HTTPS URL');
  const id = await new Promise((resolve, reject) => chrome.downloads.download({ url: target, saveAs: false }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId == null) reject(new Error(chrome.runtime.lastError?.message || 'Chrome did not start the download'));
    else resolve(downloadId);
  }));
  const items = await new Promise((resolve, reject) => chrome.downloads.search({ id }, (found) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(found || []);
  }));
  const item = items[0] || { id, url: target, state: 'in_progress' };
  bindDownloadCapture(state, item);
  updateCaptureWithDownloadItem(item);
  return { captureId, downloadId: id, bound: true };
}
function updateCaptureWithDownloadItem(item) {
  if (!item) return;
  const state = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === item.id);
  if (!state) return;
  bindDownloadCapture(state, item);
  if (item.state === 'complete' && item.filename) resolveDownloadCapture(state, publicDownloadItem(item, state));
  if (item.state === 'interrupted') rejectDownloadCapture(state, new Error(`Browser download interrupted: ${item.error || item.danger || item.id}`));
}
function restoreDownloadCapturesForPort(port, runtime) {
  for (const persisted of Object.values(runtime?.downloads || {})) {
    if (!persisted?.captureId || [DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(persisted.status)) continue;
    if (downloadCaptures.has(persisted.captureId)) continue;
    const state = {
      captureId: persisted.captureId,
      port,
      tabId: runtime.tabId,
      startedAt: Number(persisted.updatedAt) || Date.now(),
      timeoutMs: 45_000,
      expectedName: String(persisted.expectedNames?.[0] || ''),
      expectedNames: Array.from(persisted.expectedNames || []),
      itemId: persisted.downloadId ?? null,
      item: null,
      done: false,
      result: null,
      error: null,
      waiting: null,
      boundWaiters: new Set(),
      timer: null,
      artifact: null,
    };
    state.timer = setTimeout(() => rejectDownloadCapture(state, new Error('Recovered browser download did not settle')), state.timeoutMs);
    downloadCaptures.set(state.captureId, state);
    if (state.itemId != null) {
      chrome.downloads.search({ id: state.itemId }, (items) => {
        if (chrome.runtime.lastError) return;
        if (items?.[0]) updateCaptureWithDownloadItem(items[0]);
      });
    }
  }
}
if (chrome.downloads?.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    const state = findPendingDownloadCapture(item);
    if (!state) return;
    bindDownloadCapture(state, item);
    if (item.state === 'complete' && item.filename) resolveDownloadCapture(state, publicDownloadItem(item, state));
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
      if (state.itemId == null) bindDownloadCapture(state, item);
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
function waitDownloadCaptureBound(port, captureId, timeoutMs = 1_200) {
  const state = downloadCaptures.get(captureId);
  if (!state) return Promise.resolve({ captureId, bound: false, missing: true });
  if (!portMatches(state.port, port)) return Promise.reject(new Error('Download capture belongs to another tab'));
  if (state.itemId != null || state.done) return Promise.resolve(captureBindingResult(state));
  return new Promise((resolve) => {
    const waiter = {
      resolve(value) {
        clearTimeout(timer);
        state.boundWaiters.delete(waiter);
        resolve(value);
      },
    };
    const timer = setTimeout(() => waiter.resolve(captureBindingResult(state)), Math.max(50, Number(timeoutMs) || 1_200));
    state.boundWaiters.add(waiter);
  });
}
async function releaseDownloadCapture(port, captureId, reason = 'released', graceMs = 1_500) {
  const binding = await waitDownloadCaptureBound(port, captureId, graceMs);
  if (binding.bound) return { ...binding, cancelled: false, retained: true };
  return cancelDownloadCapture(port, captureId, reason);
}

function wsUrl(serverUrl, token) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const url = new URL('/extension/ws', base);
  if (token) url.searchParams.set('token', token);
  url.searchParams.set('runtime', 'extension');
  return url.toString();
}
function httpUrl(serverUrl, pathname) {
  const base = String(serverUrl || 'http://127.0.0.1:8080').replace(/\/$/, '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  return new URL(pathname, base);
}
function bridgeAuthCheckUrl(serverUrl, token) {
  const url = httpUrl(serverUrl, '/extension/auth/check');
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
const { replayCriticalOutbox, sendProtocolPayload } = createProtocolOutbox({
  backgroundEpoch, backgroundState, post, summarize,
});
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
async function closeOwnedBridgeTab(_port, options = {}) {
  const tabId = Number(options.tabId);
  const expectedLaunchToken = String(options.expectedLaunchToken || '');
  if (!Number.isInteger(tabId)) throw new Error('A numeric owned tab id is required');
  if (!BRIDGE_LAUNCH_TOKEN_RE.test(expectedLaunchToken) || expectedLaunchToken.startsWith('bridge-reload-')) {
    throw new Error('A stable expected launch token is required to close another owned tab');
  }
  const launch = await readLaunchedTab(tabId);
  if (!launch || launch.launchToken !== expectedLaunchToken) {
    throw new Error('Refusing to close owned tab because its launch token does not match');
  }
  setTimeout(() => { void removeTab(tabId).catch(() => {}); }, 150);
  return { tabId, closing: true, launchToken: launch.launchToken };
}
async function reloadOwnBridgeTab(port, options = {}) {
  const tabId = port?.sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
  setTimeout(() => {
    void chrome.tabs.reload(tabId).catch(() => {});
  }, 150);
  return { tabId, reloading: true, reason: String(options.reason || '') };
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
    closed: false,
    tabId: port?.sender?.tab?.id ?? null,
    contentEpoch: String(config.page?.contentEpoch || ''),
    serverEpoch: '', serverSequence: 0,
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
    void Promise.all([state.launchMetaPromise, backgroundState.read(state.tabId)]).then(([launchMeta, runtime]) => {
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
          acknowledgedSequence: runtime.acknowledgedSequence,
        },
      });
    });
  });
  ws.addEventListener('message', (event) => {
    let envelope = null;
    try { envelope = JSON.parse(String(event.data)); } catch {}
    if (!isProtocol4Envelope(envelope)) {
      try { ws.close(1002, 'protocol 4 envelope required'); } catch {}
      post(state.port, { type: 'extension.error', message: 'Bridge sent an invalid protocol 4 envelope' });
      return;
    }
    const sourceEpoch = String(envelope.source.backgroundEpoch || '');
    if (state.serverEpoch && sourceEpoch !== state.serverEpoch) state.serverSequence = 0;
    state.serverEpoch = sourceEpoch;
    if (envelope.source.sequence <= state.serverSequence) return;
    state.serverSequence = envelope.source.sequence;
    const payload = envelope.payload;
    if (envelope.kind === MessageKind.TRANSPORT_ACK) {
      void (async () => {
        const runtime = await backgroundState.read(state.tabId);
        const acknowledged = runtime.outbox.find((item) => item.messageId === String(payload.ackMessageId || '')) || null;
        await backgroundState.transition(state.tabId, {
          type: 'outbox.acknowledged',
          messageId: String(payload.ackMessageId || ''),
          sequence: Number(payload.acceptedSequence) || 0,
          contentEpoch: state.contentEpoch,
        });
        if (acknowledged?.effectId && (payload.accepted !== false || payload.reason === 'duplicate_message')) {
          await backgroundState.transition(state.tabId, {
            type: 'effect.reported', effectId: acknowledged.effectId, contentEpoch: state.contentEpoch,
          });
        }
      })();
      return;
    }
    if (envelope.kind === MessageKind.COMMAND_EXECUTE && envelope.request) {
      void (async () => {
        const runtime = await backgroundState.read(state.tabId);
        if (!runtime.lease) {
          const claimed = await backgroundState.transition(state.tabId, {
            type: 'lease.claim',
            ...envelope.request,
            conversationId: String(payload.sessionId || payload.conversationId || ''),
            contentEpoch: state.contentEpoch,
          });
          if (!claimed.accepted) {
            await sendProtocolPayload(state, {
              type: 'command.error',
              commandId: payload.commandId,
              requestId: envelope.request.requestId,
              error: `Browser lease rejected: ${claimed.reason}`,
            }, { kind: MessageKind.COMMAND_REJECTED, causationId: envelope.messageId, lease: envelope.request });
            return;
          }
        } else if (payload.type === 'request.resume'
          && runtime.lease.requestId === envelope.request.requestId
          && runtime.lease.ownerServerInstanceId === String(payload.previousOwnerServerInstanceId || '')) {
          const handoff = await backgroundState.transition(state.tabId, {
            type: 'lease.handoff',
            ...envelope.request,
            previousOwnerServerInstanceId: payload.previousOwnerServerInstanceId,
            contentEpoch: state.contentEpoch,
          });
          if (!handoff.accepted) {
            await sendProtocolPayload(state, {
              type: 'command.error', commandId: payload.commandId, requestId: envelope.request.requestId,
              error: `Browser lease handoff rejected: ${handoff.reason}`,
            }, { kind: MessageKind.COMMAND_REJECTED, causationId: envelope.messageId, lease: envelope.request });
            return;
          }
        } else if (runtime.lease.requestId !== envelope.request.requestId
          || runtime.lease.leaseId !== envelope.request.leaseId
          || runtime.lease.ownerServerInstanceId !== envelope.request.ownerServerInstanceId) {
          await sendProtocolPayload(state, {
            type: 'command.error',
            commandId: payload.commandId,
            requestId: envelope.request.requestId,
            error: 'Browser lease belongs to another request or server instance',
          }, { kind: MessageKind.COMMAND_REJECTED, causationId: envelope.messageId, lease: envelope.request });
          return;
        }
        const desiredLeaseStatus = payload.type === 'request.release' ? 'releasing' : 'executing';
        const currentRuntime = await backgroundState.read(state.tabId);
        const executing = currentRuntime.lease?.status === desiredLeaseStatus
          ? { accepted: true, state: currentRuntime }
          : await backgroundState.transition(state.tabId, {
            type: `lease.${desiredLeaseStatus}`,
            ...envelope.request,
            contentEpoch: state.contentEpoch,
          });
        if (!executing.accepted) {
          await sendProtocolPayload(state, {
            type: 'command.error',
            commandId: payload.commandId,
            requestId: envelope.request.requestId,
            error: `Browser executor rejected command: ${executing.reason}`,
          }, { kind: MessageKind.COMMAND_REJECTED, causationId: envelope.messageId, lease: envelope.request });
          return;
        }
        await sendProtocolPayload(state, {
          type: 'command.accepted',
          commandId: payload.commandId,
          requestId: envelope.request.requestId,
        }, { kind: MessageKind.COMMAND_ACCEPTED, causationId: envelope.messageId, lease: envelope.request });
        post(state.port, { type: 'server.message', payload: {
          ...payload,
          leaseId: envelope.request.leaseId,
          ownerServerInstanceId: envelope.request.ownerServerInstanceId,
          protocolMessageId: envelope.messageId,
        } });
      })();
      return;
    }
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

function temporaryReloadUrl(rawUrl = '', serverUrl = '', launchToken = '') {
  try {
    const url = new URL(String(rawUrl || ''));
    const safeServerUrl = safeBridgeServerUrl(serverUrl);
    if (!safeServerUrl || !['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin)) return '';
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    const stableLaunchToken = BRIDGE_LAUNCH_TOKEN_RE.test(String(launchToken || '')) && !String(launchToken).startsWith('bridge-reload-')
      ? String(launchToken)
      : `bridge-reload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    params.set('chatgpt-bridge-launch', stableLaunchToken);
    params.set('chatgpt-bridge-server', safeServerUrl);
    url.hash = params.toString();
    return url.toString();
  } catch {
    return '';
  }
}
async function reloadTabWithTemporaryConnection(tabId, serverUrl, launchToken = '') {
  if (!Number.isInteger(tabId) || !serverUrl || !chrome.tabs?.get || !chrome.tabs?.update) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = temporaryReloadUrl(tab?.url || '', serverUrl, launchToken);
  if (!url) return false;
  try {
    await chrome.tabs.update(tabId, { url });
    return true;
  } catch {
    return false;
  }
}
function pendingLaunchRecord(pending = {}, tabId) {
  const record = pending.launchRecords?.[String(tabId)] || null;
  const launchToken = String(record?.launchToken || '');
  if (!BRIDGE_LAUNCH_TOKEN_RE.test(launchToken) || launchToken.startsWith('bridge-reload-')) return null;
  return {
    launchToken,
    requestedUrl: String(record.requestedUrl || ''),
    createdAt: Number(record.createdAt || pending.requestedAt || Date.now()),
    serverUrl: safeBridgeServerUrl(record.serverUrl || ''),
  };
}
async function restorePendingLaunchRecords(pending = {}) {
  for (const tabId of Array.isArray(pending.tabIds) ? pending.tabIds : []) {
    const record = pendingLaunchRecord(pending, tabId);
    if (record) await rememberLaunchedTab(tabId, record);
  }
}
async function reloadChatGptTabsAfterExtensionRestart() {
  const storage = chrome.storage?.local;
  if (!storage?.get || !storage?.remove) return { recovered: false, reason: 'storage_unavailable' };
  const state = await storage.get(PENDING_EXTENSION_RELOAD_KEY).catch(() => ({}));
  const pending = state?.[PENDING_EXTENSION_RELOAD_KEY];
  if (!pending || !Array.isArray(pending.tabIds)) return { recovered: false, reason: 'missing' };
  const requestedAt = Number(pending.requestedAt || 0);
  if (!requestedAt || Date.now() - requestedAt > PENDING_EXTENSION_RELOAD_TTL_MS) {
    await storage.remove(PENDING_EXTENSION_RELOAD_KEY).catch(() => {});
    return { recovered: false, reason: 'expired' };
  }
  const sourceTabId = Number.isInteger(pending.sourceTabId) ? pending.sourceTabId : null;
  const serverUrl = safeBridgeServerUrl(pending.temporaryServerUrl);
  await restorePendingLaunchRecords(pending);
  for (const tabId of pending.tabIds) {
    const launchRecord = pendingLaunchRecord(pending, tabId);
    if (tabId === sourceTabId && await reloadTabWithTemporaryConnection(tabId, serverUrl, launchRecord?.launchToken || '')) continue;
    if (chrome.tabs?.reload) await chrome.tabs.reload(tabId).catch(() => {});
  }
  await storage.remove(PENDING_EXTENSION_RELOAD_KEY).catch(() => {});
  return { recovered: true, tabCount: pending.tabIds.length, sourceTabId };
}
function recoverPendingExtensionReload() {
  if (pendingExtensionReloadRecovery) return pendingExtensionReloadRecovery;
  pendingExtensionReloadRecovery = reloadChatGptTabsAfterExtensionRestart()
    .finally(() => { pendingExtensionReloadRecovery = null; });
  return pendingExtensionReloadRecovery;
}
async function scheduleExtensionReload({
  reloadTabs = true,
  expectedVersion = '',
  sourceTabId = null,
  sourceLaunchToken = '',
  temporaryServerUrl = '',
} = {}) {
  const tabs = reloadTabs && chrome.tabs?.query
    ? await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }).catch(() => [])
    : [];
  const launchRecords = {};
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    const record = await readLaunchedTab(tab.id);
    if (record?.launchToken && !String(record.launchToken).startsWith('bridge-reload-')) launchRecords[String(tab.id)] = record;
  }
  const pending = {
    tabIds: tabs.map((tab) => tab.id).filter(Number.isInteger),
    expectedVersion: String(expectedVersion || ''),
    sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
    temporaryServerUrl: safeBridgeServerUrl(temporaryServerUrl),
    launchRecords,
    requestedAt: Date.now(),
  };
  if (Number.isInteger(pending.sourceTabId)
    && BRIDGE_LAUNCH_TOKEN_RE.test(String(sourceLaunchToken || ''))
    && !String(sourceLaunchToken).startsWith('bridge-reload-')) {
    pending.launchRecords[String(pending.sourceTabId)] ||= {
      launchToken: String(sourceLaunchToken),
      requestedUrl: '',
      createdAt: pending.requestedAt,
      serverUrl: pending.temporaryServerUrl,
    };
  }
  if (chrome.storage?.local?.set) {
    await chrome.storage.local.set({ [PENDING_EXTENSION_RELOAD_KEY]: pending });
  }
  setTimeout(() => chrome.runtime.reload(), 150);
  return { scheduled: true, reloadTabs, tabCount: tabs.length, preservedLaunchCount: Object.keys(launchRecords).length, expectedVersion };
}
chrome.runtime.onInstalled?.addListener?.((details) => {
  if (details?.reason === 'update') void recoverPendingExtensionReload();
});
void recoverPendingExtensionReload();
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
  post,
  sendProtocolPayload,
  replayCriticalOutbox,
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
  reloadOwnBridgeTab,
  scheduleExtensionReload,
  performHttp,
  downloadCaptures,
  portMatches,
  rejectDownloadCapture,
  closeConnection,
});
chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  void forgetLaunchedTab(tabId);
  void backgroundState.remove(tabId);
});
