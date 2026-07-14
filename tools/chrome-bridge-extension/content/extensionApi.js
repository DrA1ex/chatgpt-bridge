(() => {
  'use strict';

  const STORAGE_PREFIX = 'chatgptBridge:';

  function getValue(key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
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
      const responseText = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
      finish(details.onload, {
        status: result.status || 0,
        response: body,
        responseText,
        responseHeaders: result.contentType ? `content-type: ${result.contentType}` : '',
      });
    });

    return {
      abort() {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { details.onabort?.(); } catch {}
      },
    };
  }

  globalThis.ChatGptExtensionApi = Object.freeze({ getValue, setValue, httpRequest });
})();
