(() => {
  'use strict';

  const STORAGE_PREFIX = 'chatgptBridge:';
  // BRIDGE_TOKEN must not be persisted in chatgpt.com localStorage. Keep only
  // an opaque marker in page storage so the synchronous content-runtime config
  // can tell that a token has been configured; the secret itself lives in the
  // extension's chrome.storage.local namespace.
  const BRIDGE_TOKEN_KEY = 'bridge.token';
  const BRIDGE_TOKEN_MARKER = '__chatgpt_bridge_secret_in_extension_storage_v1__';
  const BRIDGE_TOKEN_STORAGE_KEY = 'chatgptBridge:secret:bridge.token';
  const DEFAULT_BRIDGE_ORIGIN = 'http://127.0.0.1:8080';
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
  const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
  let privilegedBridgeOrigin = '';

  function pageStorageKey(key) {
    return STORAGE_PREFIX + key;
  }

  function persistBridgeToken(secret) {
    try {
      if (!chrome?.storage?.local) return;
      if (secret) void chrome.storage.local.set({ [BRIDGE_TOKEN_STORAGE_KEY]: String(secret) });
      else void chrome.storage.local.remove(BRIDGE_TOKEN_STORAGE_KEY);
    } catch {}
  }

  async function readPrivateBridgeToken() {
    try {
      const stored = await chrome.storage?.local?.get?.(BRIDGE_TOKEN_STORAGE_KEY);
      return String(stored?.[BRIDGE_TOKEN_STORAGE_KEY] || '');
    } catch {
      return '';
    }
  }

  function configuredBridgeOrigin() {
    try {
      const raw = localStorage.getItem(pageStorageKey('bridge.serverUrl'));
      const saved = raw == null ? DEFAULT_BRIDGE_ORIGIN : JSON.parse(raw);
      const parsed = new URL(String(saved || DEFAULT_BRIDGE_ORIGIN));
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) {
        return DEFAULT_BRIDGE_ORIGIN;
      }
      return parsed.origin;
    } catch {
      return DEFAULT_BRIDGE_ORIGIN;
    }
  }

  function setPrivilegedBridgeOrigin(value = '') {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) return false;
      privilegedBridgeOrigin = parsed.origin;
      return true;
    } catch {
      return false;
    }
  }

  function isAllowedPrivilegedRequestUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      if (CHATGPT_ORIGINS.has(parsed.origin)) return true;
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
      return parsed.origin === (privilegedBridgeOrigin || configuredBridgeOrigin());
    } catch {
      return false;
    }
  }

  async function resolvePrivilegedRequestUrl(value) {
    const parsed = new URL(String(value || ''));
    if (
      parsed.origin === (privilegedBridgeOrigin || configuredBridgeOrigin())
      && parsed.pathname === '/extension/auth/check'
      && parsed.searchParams.get('token') === BRIDGE_TOKEN_MARKER
    ) {
      const secret = await readPrivateBridgeToken();
      if (!secret) throw new Error('BRIDGE_TOKEN is not configured in extension-private storage');
      parsed.searchParams.set('token', secret);
    }
    return parsed.toString();
  }

  async function resolvePrivilegedRequestHeaders(value, headers = {}) {
    const parsed = new URL(String(value || ''));
    const resolved = { ...(headers || {}) };
    const hasBridgeToken = Object.keys(resolved).some((key) => key.toLowerCase() === 'x-bridge-token');
    const isPrivateBridgeFile = parsed.origin === (privilegedBridgeOrigin || configuredBridgeOrigin())
      && /^\/extension\/files\/[^/]+\/download$/.test(parsed.pathname);
    if (isPrivateBridgeFile && !hasBridgeToken) {
      const secret = await readPrivateBridgeToken();
      if (!secret) throw new Error('BRIDGE_TOKEN is not configured in extension-private storage');
      resolved['x-bridge-token'] = secret;
    }
    return resolved;
  }

  function getValue(key, fallback) {
    try {
      const raw = localStorage.getItem(pageStorageKey(key));
      const value = raw == null ? fallback : JSON.parse(raw);
      if (key !== BRIDGE_TOKEN_KEY) return value;

      if (value === BRIDGE_TOKEN_MARKER) return BRIDGE_TOKEN_MARKER;

      // One-time migration from pre-hardening versions. Return the legacy value
      // for this in-memory session so the current connection can succeed, but
      // immediately remove the plaintext from the ChatGPT origin.
      const legacySecret = typeof value === 'string' ? value : '';
      if (legacySecret) {
        persistBridgeToken(legacySecret);
        localStorage.setItem(pageStorageKey(key), JSON.stringify(BRIDGE_TOKEN_MARKER));
        return legacySecret;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (key === BRIDGE_TOKEN_KEY) {
        const secret = String(value || '');
        if (secret && secret !== BRIDGE_TOKEN_MARKER) persistBridgeToken(secret);
        else if (!secret) persistBridgeToken('');
        localStorage.setItem(
          pageStorageKey(key),
          JSON.stringify(secret ? BRIDGE_TOKEN_MARKER : ''),
        );
        return true;
      }
      localStorage.setItem(pageStorageKey(key), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function httpRequest(details = {}) {
    const requestId = `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let aborted = false;
    let timer = null;

    const finish = (callback, value) => {
      if (aborted) return;
      if (timer) clearTimeout(timer);
      try {
        callback?.(value);
      } catch (err) {
        console.error('[chatgpt-bridge-extension] HTTP callback failed', err);
      }
    };

    if (!isAllowedPrivilegedRequestUrl(details.url)) {
      queueMicrotask(() => finish(details.onerror, {
        error: 'Extension refused privileged request outside configured bridge/ChatGPT origins',
      }));
      return {
        abort() {
          aborted = true;
          try { details.onabort?.(); } catch {}
        },
      };
    }

    if (details.timeout) {
      timer = setTimeout(() => {
        aborted = true;
        try { details.ontimeout?.(); } catch {}
      }, Number(details.timeout) || 0);
    }

    void Promise.all([
      resolvePrivilegedRequestUrl(details.url),
      resolvePrivilegedRequestHeaders(details.url, details.headers),
    ]).then(([resolvedUrl, resolvedHeaders]) => {
      if (aborted) return;
      chrome.runtime.sendMessage({
        type: 'bridge.http',
        requestId,
        request: {
          method: details.method || 'GET',
          url: resolvedUrl,
          headers: resolvedHeaders,
          data: details.data,
          responseType: details.responseType || 'text',
          anonymous: details.anonymous !== false,
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
        const responseText = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
        finish(details.onload, {
          status: result.status || 0,
          response: body,
          responseText,
          responseHeaders: result.contentType ? `content-type: ${result.contentType}` : '',
        });
      });
    }).catch((error) => finish(details.onerror, { error: error?.message || String(error) }));

    return {
      abort() {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { details.onabort?.(); } catch {}
      },
    };
  }

  globalThis.ChatGptExtensionApi = Object.freeze({
    getValue,
    setValue,
    httpRequest,
    setPrivilegedBridgeOrigin,
    BRIDGE_TOKEN_MARKER,
  });
})();
