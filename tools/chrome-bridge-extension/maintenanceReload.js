const CONFIRMATION = 'chatgpt-bridge-maintenance-reload-v1';
const PENDING_RELOAD_KEY = 'bridgePendingExtensionReload';
const RELOAD_PAGE_GUARD_KEY = 'bridgeMaintenanceReloadPageGuard';
const LAUNCHED_TAB_STORAGE_PREFIX = 'chatgptBridgeLaunchedTab:';
const CHATGPT_URL_PATTERNS = Object.freeze(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
const STABLE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const BACKGROUND_STATE_PREFIX = 'chatgptBridgeV6:tab:';

function text(value = '') { return String(value ?? '').trim(); }

export function safeLoopbackServerUrl(value = '') {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return '';
    if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/')) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function stableLaunchToken(value = '') {
  const token = text(value);
  return STABLE_LAUNCH_TOKEN_RE.test(token) && !token.startsWith('bridge-reload-') ? token : '';
}

export function parseMaintenanceReloadUrl(href = '') {
  const url = new URL(String(href || 'chrome-extension://invalid/maintenance-reload.html'));
  const rawSourceTabId = text(url.searchParams.get('sourceTabId'));
  const sourceTabId = rawSourceTabId ? Number(rawSourceTabId) : Number.NaN;
  return Object.freeze({
    confirmed: url.searchParams.get('confirm') === CONFIRMATION,
    expectedVersion: text(url.searchParams.get('expectedVersion')),
    reloadTabs: url.searchParams.get('reloadTabs') !== '0',
    sourceTabId: Number.isInteger(sourceTabId) && sourceTabId >= 0 ? sourceTabId : null,
    sourceLaunchToken: stableLaunchToken(url.searchParams.get('sourceLaunchToken')),
    requestedUrl: text(url.searchParams.get('requestedUrl')),
    temporaryServerUrl: safeLoopbackServerUrl(url.searchParams.get('serverUrl')),
    commandId: text(url.searchParams.get('commandId')) || `maintenance-bootstrap-${Date.now().toString(36)}`,
  });
}

async function launchedRecords(chromeApi, tabIds, options) {
  const keys = tabIds.map((tabId) => `${LAUNCHED_TAB_STORAGE_PREFIX}${tabId}`);
  const stored = keys.length && chromeApi.storage?.session?.get
    ? await chromeApi.storage.session.get(keys).catch(() => ({}))
    : {};
  const records = {};
  for (const tabId of tabIds) {
    const current = stored?.[`${LAUNCHED_TAB_STORAGE_PREFIX}${tabId}`] || null;
    const token = stableLaunchToken(current?.launchToken || (tabId === options.sourceTabId ? options.sourceLaunchToken : ''));
    if (!token) continue;
    records[String(tabId)] = {
      launchToken: token,
      requestedUrl: text(current?.requestedUrl || (tabId === options.sourceTabId ? options.requestedUrl : '')),
      createdAt: Math.max(1, Number(current?.createdAt) || Date.now()),
      serverUrl: safeLoopbackServerUrl(current?.serverUrl || options.temporaryServerUrl),
    };
  }
  if (Number.isInteger(options.sourceTabId) && options.sourceLaunchToken && !records[String(options.sourceTabId)]) {
    records[String(options.sourceTabId)] = {
      launchToken: options.sourceLaunchToken,
      requestedUrl: options.requestedUrl,
      createdAt: Date.now(),
      serverUrl: options.temporaryServerUrl,
    };
  }
  return records;
}

export async function prepareMaintenanceReload(chromeApi, options) {
  if (!options?.confirmed) throw new Error('Maintenance reload confirmation is missing');
  if (!chromeApi?.runtime?.reload || !chromeApi.storage?.local?.set) throw new Error('Extension maintenance APIs are unavailable');
  const sessionState = chromeApi.storage?.session?.get ? await chromeApi.storage.session.get(null).catch(() => ({})) : {};
  const activeLeases = Object.entries(sessionState || {}).filter(([key, value]) =>
    String(key).startsWith(BACKGROUND_STATE_PREFIX) && value?.lease);
  if (activeLeases.length) throw new Error('Extension maintenance is blocked while browser leases are active');
  const tabs = options.reloadTabs && chromeApi.tabs?.query
    ? await chromeApi.tabs.query({ url: CHATGPT_URL_PATTERNS }).catch(() => [])
    : [];
  const tabIds = [...new Set(tabs.map((tab) => tab?.id).filter(Number.isInteger))];
  if (Number.isInteger(options.sourceTabId) && !tabIds.includes(options.sourceTabId)) tabIds.push(options.sourceTabId);
  const launchRecords = await launchedRecords(chromeApi, tabIds, options);
  const pending = {
    tabIds,
    expectedVersion: options.expectedVersion,
    sourceTabId: Number.isInteger(options.sourceTabId) ? options.sourceTabId : null,
    temporaryServerUrl: options.temporaryServerUrl,
    launchRecords,
    requestedAt: Date.now(),
    operationId: '',
    commandId: options.commandId,
    bootstrapPage: true,
  };
  await chromeApi.storage.local.set({
    [PENDING_RELOAD_KEY]: pending,
    [RELOAD_PAGE_GUARD_KEY]: { commandId: options.commandId, requestedAt: pending.requestedAt },
  });
  return pending;
}

async function closeMaintenancePage(chromeApi) {
  if (!chromeApi.tabs?.getCurrent || !chromeApi.tabs?.remove) return false;
  const current = await chromeApi.tabs.getCurrent().catch(() => null);
  if (!Number.isInteger(current?.id)) return false;
  await chromeApi.tabs.remove(current.id).catch(() => {});
  return true;
}

export async function runMaintenanceReload({
  chromeApi = globalThis.chrome,
  href = globalThis.location?.href || '',
  setStatus = () => {},
  delayMs = 120,
} = {}) {
  const options = parseMaintenanceReloadUrl(href);
  const guardState = chromeApi.storage?.local?.get
    ? await chromeApi.storage.local.get(RELOAD_PAGE_GUARD_KEY).catch(() => ({}))
    : {};
  const guard = guardState?.[RELOAD_PAGE_GUARD_KEY] || null;
  if (guard?.commandId === options.commandId) {
    setStatus('Extension updated. Closing maintenance page…');
    await closeMaintenancePage(chromeApi);
    return { alreadyReloaded: true, commandId: options.commandId };
  }
  setStatus('Preparing extension handoff…');
  const pending = await prepareMaintenanceReload(chromeApi, options);
  setStatus(`Reloading extension${options.expectedVersion ? ` to ${options.expectedVersion}` : ''}…`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
  chromeApi.runtime.reload();
  return pending;
}

if (typeof window !== 'undefined' && globalThis.chrome?.runtime?.id) {
  const statusNode = document.getElementById('status');
  runMaintenanceReload({
    setStatus: (message) => { if (statusNode) statusNode.textContent = message; },
  }).catch((error) => {
    if (statusNode) statusNode.textContent = `Extension reload failed: ${error?.message || String(error)}`;
  });
}
