const PENDING_EXTENSION_RELOAD_KEY = 'bridgePendingExtensionReload';
const PENDING_EXTENSION_RELOAD_TTL_MS = 2 * 60_000;

export function createExtensionReloadCoordinator({
  backgroundState,
  maintenanceOperations,
  safeBridgeServerUrl,
  readLaunchedTab,
  rememberLaunchedTab,
  navigateTab,
  reloadTab,
  launchTokenPattern,
  reloadRuntime = () => chrome.runtime.reload(),
  ackTimeoutMs = 7_000,
} = {}) {
  let pendingRecovery = null;

  function temporaryReloadUrl(rawUrl = '', serverUrl = '', launchToken = '') {
    try {
      const url = new URL(String(rawUrl || ''));
      const safeServerUrl = safeBridgeServerUrl(serverUrl);
      if (!safeServerUrl || !['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin)) return '';
      const params = new URLSearchParams(url.hash.replace(/^#/, ''));
      const stableLaunchToken = launchTokenPattern.test(String(launchToken || '')) && !String(launchToken).startsWith('bridge-reload-')
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
      await navigateTab(tabId, url);
      return true;
    } catch {
      return false;
    }
  }

  function pendingLaunchRecord(pending = {}, tabId) {
    const record = pending.launchRecords?.[String(tabId)] || null;
    const launchToken = String(record?.launchToken || '');
    if (!launchTokenPattern.test(launchToken) || launchToken.startsWith('bridge-reload-')) return null;
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
    if (!storage?.get || !storage?.remove || !storage?.set) {
      const error = new Error('Extension reload recovery requires durable local storage');
      error.code = 'MAINTENANCE_STORAGE_UNAVAILABLE';
      throw error;
    }
    const stored = await storage.get(PENDING_EXTENSION_RELOAD_KEY);
    const pending = stored?.[PENDING_EXTENSION_RELOAD_KEY];
    if (!pending || !Array.isArray(pending.tabIds)) return { recovered: false, reason: 'missing' };
    const requestedAt = Number(pending.requestedAt || 0);
    if (!requestedAt || Date.now() - requestedAt > PENDING_EXTENSION_RELOAD_TTL_MS) {
      await storage.remove(PENDING_EXTENSION_RELOAD_KEY);
      if (pending.operationId) await maintenanceOperations.fail(pending.operationId, {
        code: 'MAINTENANCE_EXPIRED',
        message: 'Extension reload maintenance expired before recovery',
      });
      return { recovered: false, reason: 'expired' };
    }
    const sourceTabId = Number.isInteger(pending.sourceTabId) ? pending.sourceTabId : null;
    const serverUrl = safeBridgeServerUrl(pending.temporaryServerUrl);
    await restorePendingLaunchRecords(pending);
    for (const tabId of pending.tabIds) {
      const launchRecord = pendingLaunchRecord(pending, tabId);
      if (tabId === sourceTabId && await reloadTabWithTemporaryConnection(tabId, serverUrl, launchRecord?.launchToken || '')) continue;
      if (chrome.tabs?.reload) await reloadTab(tabId);
    }
    await storage.remove(PENDING_EXTENSION_RELOAD_KEY);
    const result = { recovered: true, tabCount: pending.tabIds.length, sourceTabId };
    if (pending.operationId) await maintenanceOperations.succeed(pending.operationId, result);
    return result;
  }

  function recoverPendingExtensionReload() {
    if (pendingRecovery) return pendingRecovery;
    pendingRecovery = reloadChatGptTabsAfterExtensionRestart().finally(() => { pendingRecovery = null; });
    return pendingRecovery;
  }

  async function clearPendingExtensionReload() {
    try {
      await chrome.storage?.local?.remove?.(PENDING_EXTENSION_RELOAD_KEY);
    } catch {}
  }

  async function reloadAfterTerminalAck({ tabId, commandId, operationId }) {
    const deadline = Date.now() + Math.max(1_000, Number(ackTimeoutMs) || 7_000);
    while (Date.now() < deadline) {
      const runtime = await backgroundState.read(tabId);
      const command = runtime.commands?.[commandId] || null;
      const terminalCommitted = command?.status === 'succeeded';
      const terminalFailed = ['rejected', 'uncertain'].includes(String(command?.status || ''));
      const terminalPending = runtime.outbox.some((entry) => String(entry.commandId || '') === commandId && entry.messageType === 'command.result');
      if (terminalCommitted && !terminalPending) {
        reloadRuntime();
        return { reloading: true };
      }
      if (terminalFailed) {
        const error = new Error('Extension reload command settled without a successful terminal result');
        error.code = 'MAINTENANCE_COMMAND_REJECTED';
        await clearPendingExtensionReload();
        await maintenanceOperations.fail(operationId, { code: error.code, message: error.message });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const error = new Error('Extension reload was not started because the terminal command result was not acknowledged by the server');
    error.code = 'MAINTENANCE_ACK_TIMEOUT';
    await clearPendingExtensionReload();
    await maintenanceOperations.fail(operationId, { code: error.code, message: error.message });
    throw error;
  }

  async function scheduleExtensionReload({
    reloadTabs = true,
    expectedVersion = '',
    sourceTabId = null,
    sourceLaunchToken = '',
    temporaryServerUrl = '',
    commandId = '',
  } = {}) {
    const terminalCommandId = String(commandId || '');
    if (!Number.isInteger(sourceTabId) || !terminalCommandId) {
      const error = new Error('Extension reload requires the source tab and correlated command identity');
      error.code = 'MAINTENANCE_COMMAND_IDENTITY_REQUIRED';
      throw error;
    }
    const tabs = reloadTabs && chrome.tabs?.query
      ? await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }).catch(() => [])
      : [];
    const activeLeases = [];
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id)) continue;
      const runtime = await backgroundState.read(tab.id);
      if (runtime.lease) activeLeases.push({ tabId: tab.id, requestId: runtime.lease.requestId, leaseId: runtime.lease.leaseId });
    }
    if (activeLeases.length) {
      const error = new Error('Extension maintenance is blocked while browser leases are active');
      error.code = 'MAINTENANCE_BLOCKED_BY_ACTIVE_LEASE';
      error.activeLeases = activeLeases;
      throw error;
    }
    const planned = await maintenanceOperations.plan('extension.reload', {
      preconditions: { expectedVersion: String(expectedVersion || ''), tabIds: tabs.map((tab) => tab.id).filter(Number.isInteger) },
    });
    if (!planned.accepted) throw new Error(`Extension maintenance plan rejected: ${planned.reason}`);
    const operationId = planned.state.active.operationId;
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
      operationId,
      commandId: terminalCommandId,
    };
    if (Number.isInteger(pending.sourceTabId)
      && launchTokenPattern.test(String(sourceLaunchToken || ''))
      && !String(sourceLaunchToken).startsWith('bridge-reload-')) {
      pending.launchRecords[String(pending.sourceTabId)] ||= {
        launchToken: String(sourceLaunchToken),
        requestedUrl: '',
        createdAt: pending.requestedAt,
        serverUrl: pending.temporaryServerUrl,
      };
    }
    if (!chrome.storage?.local?.set) {
      const error = new Error('Extension reload scheduling requires durable local storage');
      error.code = 'MAINTENANCE_STORAGE_UNAVAILABLE';
      await maintenanceOperations.fail(operationId, { code: error.code, message: error.message });
      throw error;
    }
    try {
      await chrome.storage.local.set({ [PENDING_EXTENSION_RELOAD_KEY]: pending });
    } catch (error) {
      await maintenanceOperations.fail(operationId, { code: 'MAINTENANCE_PENDING_WRITE_FAILED', message: error?.message || String(error) });
      throw error;
    }
    const dispatched = await maintenanceOperations.dispatch(operationId);
    if (!dispatched.accepted) throw new Error(`Extension maintenance dispatch rejected: ${dispatched.reason}`);
    void reloadAfterTerminalAck({ tabId: sourceTabId, commandId: terminalCommandId, operationId })
      .catch((error) => console.error('[chatgpt-bridge] extension reload acknowledgement barrier failed', error));
    return {
      operationId,
      scheduled: true,
      reloadTabs,
      tabCount: tabs.length,
      preservedLaunchCount: Object.keys(launchRecords).length,
      expectedVersion,
    };
  }

  return Object.freeze({ recoverPendingExtensionReload, scheduleExtensionReload });
}
