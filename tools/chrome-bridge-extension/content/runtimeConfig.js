(() => {
  'use strict';

  const CONFIG_VERSION = 9;
  const URL_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch';
  const URL_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server';
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

  function loadConfig(api) {
    const config = {
      ...DEFAULT_CONFIG,
      serverUrl: String(api.getValue('bridge.serverUrl', DEFAULT_CONFIG.serverUrl) || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''),
      token: String(api.getValue('bridge.token', DEFAULT_CONFIG.token) || DEFAULT_CONFIG.token),
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
    loadConfig,
    saveConfigPatch,
  });
})();
