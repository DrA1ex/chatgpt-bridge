export function getClientIp(req) {
  return req?.socket?.remoteAddress || '';
}

export function isLocalAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', ''].includes(address) || String(address).endsWith(':127.0.0.1');
}

export function isAllowedExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(origin || ''));
}

export function tokenFromRequest(req) {
  try { return new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch { return ''; }
}

export function runtimeFromRequest(req) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    return url.searchParams.get('runtime') || (isAllowedExtensionOrigin(req.headers.origin || '') ? 'extension' : 'browser');
  } catch {
    return isAllowedExtensionOrigin(req?.headers?.origin || '') ? 'extension' : 'browser';
  }
}

export function normalizeDebugPayload(payload) {
  const clone = { ...payload };
  for (const key of ['message', 'text', 'answer', 'contentBase64']) {
    if (typeof clone[key] === 'string' && clone[key].length > 500) clone[key] = `${clone[key].slice(0, 500)}…`;
  }
  return clone;
}

export function makeFallbackId() {
  return `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isClientCompatible(client) {
  return client?.compatibility?.compatible !== false;
}
