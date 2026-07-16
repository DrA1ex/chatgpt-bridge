(() => {
  'use strict';

  const CONFIG_VERSION = 10;
  const URL_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch';
  const URL_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server';
  const TEMPORARY_CONNECTION_STORAGE_KEY = 'chatgptBridgeTemporaryConnection';
  const TEMPORARY_CONNECTION_TTL_MS = 5 * 60_000;
  const BRIDGE_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;
  const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost']);

  const DEFAULT_CONFIG = {
    serverUrl: 'http://127.0.0.1:8080',
    token: '',
    reconnectMs: 1500,
    domPollMs: 250,
    defaultAnswerSettleMs: 1500,
    defaultAnswerDoneSettleMs: 600,
    steerContinuationSettleMs: 90_000,
    postStopTerminalSettleMs: 900,
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

  function readSavedConnection(api) {
    return {
      serverUrl: safeLaunchBridgeServerUrl(api.getValue('bridge.serverUrl', DEFAULT_CONFIG.serverUrl)) || DEFAULT_CONFIG.serverUrl,
      token: String(api.getValue('bridge.token', DEFAULT_CONFIG.token) || DEFAULT_CONFIG.token),
    };
  }

  function sameConnection(left = {}, right = {}) {
    return String(left.serverUrl || '') === String(right.serverUrl || '')
      && String(left.token || '') === String(right.token || '');
  }

  function connectionStorage(storage) {
    if (storage) return storage;
    try { return globalThis.sessionStorage || null; } catch { return null; }
  }

  function removeTemporaryConnectionOverride(storage) {
    try { connectionStorage(storage)?.removeItem?.(TEMPORARY_CONNECTION_STORAGE_KEY); } catch {}
  }

  function stageTemporaryConnectionOverride(api, config, requestedConnection = {}, storage, now = Date.now()) {
    const savedConnection = readSavedConnection(api);
    const connection = {
      serverUrl: safeLaunchBridgeServerUrl(requestedConnection.serverUrl || config?.serverUrl),
      token: String(requestedConnection.token ?? config?.token ?? ''),
    };
    if (!connection.serverUrl) {
      removeTemporaryConnectionOverride(storage);
      return { staged: false, reason: 'invalid_server_url' };
    }
    if (sameConnection(connection, savedConnection)) {
      removeTemporaryConnectionOverride(storage);
      return { staged: false, reason: 'matches_saved', serverUrl: connection.serverUrl, tokenChanged: false };
    }
    const target = connectionStorage(storage);
    if (!target?.setItem) return { staged: false, reason: 'storage_unavailable' };
    const record = {
      version: 1,
      connection,
      savedConnection,
      createdAt: now,
      expiresAt: now + TEMPORARY_CONNECTION_TTL_MS,
    };
    try {
      target.setItem(TEMPORARY_CONNECTION_STORAGE_KEY, JSON.stringify(record));
      return {
        staged: true,
        reason: 'differs_from_saved',
        serverUrl: connection.serverUrl,
        tokenChanged: connection.token !== savedConnection.token,
      };
    } catch {
      return { staged: false, reason: 'storage_failed' };
    }
  }

  function applyTemporaryConnectionOverride(api, config, storage, now = Date.now()) {
    const target = connectionStorage(storage);
    let record = null;
    try { record = JSON.parse(target?.getItem?.(TEMPORARY_CONNECTION_STORAGE_KEY) || 'null'); } catch {}
    if (!record || record.version !== 1 || Number(record.expiresAt) <= now) {
      removeTemporaryConnectionOverride(target);
      return { applied: false, reason: record ? 'expired_or_invalid' : 'missing' };
    }
    const savedConnection = readSavedConnection(api);
    if (!sameConnection(savedConnection, record.savedConnection)) {
      removeTemporaryConnectionOverride(target);
      return { applied: false, reason: 'saved_connection_changed' };
    }
    const connection = {
      serverUrl: safeLaunchBridgeServerUrl(record.connection?.serverUrl),
      token: String(record.connection?.token ?? ''),
    };
    if (!connection.serverUrl || sameConnection(connection, savedConnection)) {
      removeTemporaryConnectionOverride(target);
      return { applied: false, reason: connection.serverUrl ? 'matches_saved' : 'invalid_server_url' };
    }
    Object.assign(config, connection);
    return {
      applied: true,
      reason: 'temporary_reload_connection',
      serverUrl: connection.serverUrl,
      tokenChanged: connection.token !== savedConnection.token,
    };
  }

  function loadConfig(api) {
    const savedConnection = readSavedConnection(api);
    const config = {
      ...DEFAULT_CONFIG,
      ...savedConnection,
      debug: Boolean(api.getValue('bridge.debug', DEFAULT_CONFIG.debug)),
    };
    api.setValue('bridge.configVersion', CONFIG_VERSION);
    return config;
  }

  function saveConfigPatch(api, config, patch = {}) {
    Object.assign(config, patch);
    if (patch.serverUrl != null) api.setValue('bridge.serverUrl', String(patch.serverUrl).replace(/\/$/, ''));
    if (patch.token != null) api.setValue('bridge.token', String(patch.token));
    if (patch.debug != null) api.setValue('bridge.debug', Boolean(patch.debug));
    return config;
  }

  globalThis.ChatGptContentRuntimeConfig = Object.freeze({
    DEFAULT_CONFIG,
    readBrowserLaunchMetadataFromUrl,
    safeLaunchBridgeServerUrl,
    readSavedConnection,
    stageTemporaryConnectionOverride,
    applyTemporaryConnectionOverride,
    removeTemporaryConnectionOverride,
    loadConfig,
    saveConfigPatch,
  });
})();
