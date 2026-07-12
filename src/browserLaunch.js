const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export const BROWSER_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch';
export const BROWSER_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server';
export const BROWSER_LAUNCH_TOKEN_RE = /^bridge-[a-z0-9][a-z0-9_-]{7,127}$/i;

export function safeChatGptUrl(value = 'https://chatgpt.com/') {
  const parsed = new URL(String(value || 'https://chatgpt.com/'));
  if (!CHATGPT_ORIGINS.has(parsed.origin.toLowerCase()) || parsed.username || parsed.password) {
    throw new Error(`Refusing to open non-ChatGPT URL: ${parsed.toString()}`);
  }
  return parsed.toString();
}

export function safeBridgeServerUrl(value = '') {
  const parsed = new URL(String(value || ''));
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(hostname) || parsed.username || parsed.password) {
    throw new Error(`Refusing to use non-loopback bridge server URL: ${parsed.toString()}`);
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error(`Bridge server URL must not contain a path: ${parsed.toString()}`);
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function browserLaunchMetadataFromUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const launchToken = String(params.get(BROWSER_LAUNCH_HASH_KEY) || '');
    const rawServerUrl = String(params.get(BROWSER_LAUNCH_SERVER_HASH_KEY) || '');
    const safeToken = BROWSER_LAUNCH_TOKEN_RE.test(launchToken) ? launchToken : '';
    let bridgeServerUrl = '';
    if (safeToken && rawServerUrl) {
      try { bridgeServerUrl = safeBridgeServerUrl(rawServerUrl); } catch {}
    }
    params.delete(BROWSER_LAUNCH_HASH_KEY);
    params.delete(BROWSER_LAUNCH_SERVER_HASH_KEY);
    parsed.hash = params.toString();
    return {
      launchToken: safeToken,
      bridgeServerUrl,
      requestedUrl: parsed.toString(),
    };
  } catch {
    return { launchToken: '', bridgeServerUrl: '', requestedUrl: '' };
  }
}

export function browserLaunchUrl(value, launchToken, options = {}) {
  const token = String(launchToken || '').trim();
  if (!BROWSER_LAUNCH_TOKEN_RE.test(token)) {
    throw new Error('System browser launch requires a safe one-time bridge launch token');
  }
  const url = new URL(safeChatGptUrl(value));
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  params.set(BROWSER_LAUNCH_HASH_KEY, token);
  const bridgeServerUrl = String(options.bridgeServerUrl || '').trim();
  if (bridgeServerUrl) params.set(BROWSER_LAUNCH_SERVER_HASH_KEY, safeBridgeServerUrl(bridgeServerUrl));
  url.hash = params.toString();
  return url.toString();
}
