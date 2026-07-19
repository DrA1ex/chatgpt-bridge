function httpUrl(serverUrl, pathname) {
  const base = String(serverUrl || 'http://127.0.0.1:8080')
    .replace(/\/$/, '')
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:');
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

export async function checkBridgeAuth(state, fetchImpl = globalThis.fetch) {
  const url = bridgeAuthCheckUrl(state.serverUrl, state.token);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    });
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
    return {
      ok: false,
      status: response.status,
      message: `Bridge auth preflight failed: ${detail}`,
    };
  } catch (err) {
    return { ok: false, offline: true, message: err?.message || String(err) };
  }
}
