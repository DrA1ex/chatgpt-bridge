import { config as defaultConfig } from './config.js';
import { HttpError } from './httpError.js';

function normaliseBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function safeUpstreamDetail(value, fallback) {
  if (value && typeof value === 'object') {
    const detail = value.error || value.detail || value.message;
    if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 2000);
  }
  return fallback;
}

export function fullPowerBridgeEnabled(config = defaultConfig) {
  return Boolean(normaliseBaseUrl(config.fullPowerBridgeUrl) && String(config.fullPowerBridgeToken || '').trim());
}

export async function forwardFullPowerRequest(pathname, {
  method = 'GET',
  body,
  authToken,
  config = defaultConfig,
  fetchImpl = globalThis.fetch,
} = {}) {
  const baseUrl = normaliseBaseUrl(config.fullPowerBridgeUrl);
  const token = String(authToken || config.fullPowerBridgeToken || '').trim();
  if (!baseUrl || !token) {
    throw new HttpError(503, 'Full-Power Bridge is not configured on this Bridge');
  }
  if (typeof fetchImpl !== 'function') throw new HttpError(503, 'Fetch is unavailable for the Full-Power Bridge adapter');

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(config.fullPowerRequestTimeoutMs) || 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(`${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { detail: text.slice(0, 2000) }; }
    if (!response.ok) {
      const error = new HttpError(response.status, safeUpstreamDetail(value, `Full-Power Bridge returned HTTP ${response.status}`));
      error.upstream = value;
      throw error;
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'AbortError') throw new HttpError(504, 'Full-Power Bridge request timed out');
    throw new HttpError(503, `Full-Power Bridge is unavailable: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}
