function createTab(options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create(options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function updateTab(tabId, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, options, (tab) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tab || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function safeChatUrl(value = '') {
  const parsed = new URL(String(value || 'https://chatgpt.com/'));
  if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(parsed.origin.toLowerCase()) || parsed.username || parsed.password) {
    throw new Error(`Refusing to open non-ChatGPT URL: ${parsed.toString()}`);
  }
  return parsed.toString();
}

export function createTabController({
  connections,
  safeBridgeServerUrl,
  rememberLaunchedTab,
  readLaunchedTab,
  forgetLaunchedTab,
  isStableLaunchToken,
} = {}) {
  if (!connections || typeof connections.get !== 'function') throw new TypeError('Tab controller requires connections');
  if (typeof safeBridgeServerUrl !== 'function') throw new TypeError('Tab controller requires safeBridgeServerUrl');
  if (typeof rememberLaunchedTab !== 'function' || typeof readLaunchedTab !== 'function' || typeof forgetLaunchedTab !== 'function') {
    throw new TypeError('Tab controller requires launched-tab storage adapters');
  }
  if (typeof isStableLaunchToken !== 'function') throw new TypeError('Tab controller requires launch-token validation');

  async function openBridgeTab(port, options = {}) {
    const requestedUrl = safeChatUrl(options.url || 'https://chatgpt.com/');
    const launchToken = String(options.launchToken || `bridge-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const connectionServerUrl = connections.get(port)?.serverUrl || '';
    const bridgeServerUrl = safeBridgeServerUrl(options.bridgeServerUrl || connectionServerUrl);
    const active = options.active !== false;
    const tab = await createTab({ url: 'about:blank', active });
    if (!Number.isInteger(tab?.id)) throw new Error('Chrome did not return a tab id for the new ChatGPT tab');
    try {
      // Persist ownership before navigation so a fast content connection cannot
      // announce without its one-time launch identity.
      await rememberLaunchedTab(tab.id, { launchToken, requestedUrl, createdAt: Date.now(), serverUrl: bridgeServerUrl });
      await updateTab(tab.id, { url: requestedUrl, active });
    } catch (error) {
      await forgetLaunchedTab(tab.id);
      await removeTab(tab.id).catch(() => {});
      throw error;
    }
    return { tabId: tab.id, launchToken, requestedUrl, bridgeServerUrl, active, openerTabId: port?.sender?.tab?.id ?? null };
  }

  async function closeOwnBridgeTab(port, options = {}) {
    const tabId = port?.sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
    const launch = await readLaunchedTab(tabId);
    const expectedLaunchToken = String(options.expectedLaunchToken || '');
    if (expectedLaunchToken && launch?.launchToken !== expectedLaunchToken) {
      throw new Error('Refusing to close tab because its launch token does not match');
    }
    setTimeout(() => { void removeTab(tabId).catch(() => {}); }, 150);
    return { tabId, closing: true, launchToken: launch?.launchToken || '' };
  }

  async function closeOwnedBridgeTab(_port, options = {}) {
    const tabId = Number(options.tabId);
    const expectedLaunchToken = String(options.expectedLaunchToken || '');
    if (!Number.isInteger(tabId)) throw new Error('A numeric owned tab id is required');
    if (!isStableLaunchToken(expectedLaunchToken)) {
      throw new Error('A stable expected launch token is required to close another owned tab');
    }
    const launch = await readLaunchedTab(tabId);
    if (!launch || launch.launchToken !== expectedLaunchToken) {
      throw new Error('Refusing to close owned tab because its launch token does not match');
    }
    setTimeout(() => { void removeTab(tabId).catch(() => {}); }, 150);
    return { tabId, closing: true, launchToken: launch.launchToken };
  }

  async function navigateTab(tabId, url) {
    if (!Number.isInteger(tabId)) throw new Error('A numeric tab id is required');
    const targetUrl = String(url || '');
    if (!targetUrl) throw new Error('A target URL is required');
    await updateTab(tabId, { url: targetUrl });
    return { tabId, url: targetUrl };
  }

  async function reloadTab(tabId) {
    if (!Number.isInteger(tabId)) throw new Error('A numeric tab id is required');
    await chrome.tabs.reload(tabId);
    return { tabId, reloading: true };
  }

  async function reloadOwnBridgeTab(port, options = {}) {
    const tabId = port?.sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error('The content-script port is not associated with a browser tab');
    setTimeout(() => { void chrome.tabs.reload(tabId).catch(() => {}); }, 150);
    return { tabId, reloading: true, reason: String(options.reason || '') };
  }

  return Object.freeze({ openBridgeTab, closeOwnBridgeTab, closeOwnedBridgeTab, navigateTab, reloadTab, reloadOwnBridgeTab });
}
