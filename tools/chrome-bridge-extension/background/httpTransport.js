const PRIVATE_BRIDGE_FILE_PATH = /^\/extension\/files\/[^/]+\/download$/;

export function authorizeBridgeHttpRequest(request = {}, connection = null) {
  const headers = { ...(request.headers || {}) };
  if (!connection?.token) return { ...request, headers };
  try {
    const target = new URL(String(request.url || ''));
    const bridge = new URL(String(connection.serverUrl || ''));
    const hasBridgeToken = Object.keys(headers).some((key) => key.toLowerCase() === 'x-bridge-token');
    if (target.origin === bridge.origin && PRIVATE_BRIDGE_FILE_PATH.test(target.pathname) && !hasBridgeToken) {
      headers['x-bridge-token'] = String(connection.token);
    }
  } catch {
    // performHttp owns malformed URL reporting.
  }
  return { ...request, headers };
}

export async function performHttp(request, fetchImpl = fetch) {
  const method = request.method || 'GET';
  const headers = request.headers || {};
  const body = request.data === undefined ? undefined : (typeof request.data === 'string' ? request.data : JSON.stringify(request.data));
  if (body !== undefined && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  const response = await fetchImpl(request.url, { method, headers, body,
    credentials: request.anonymous === false ? 'include' : 'omit' });
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
