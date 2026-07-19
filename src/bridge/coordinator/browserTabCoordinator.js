import { makeRequestId } from '../../protocol.js';
import {
  BROWSER_LAUNCH_TOKEN_RE,
  browserLaunchMetadataFromUrl,
  browserLaunchUrl,
  safeChatGptUrl,
} from '../../browserLaunch.js';
import { normalizeLaunchedClient } from '../clientSelection.js';

/**
 * Owns server-side browser tab operations and extension reload handoff. Prompt
 * selection remains in BrowserClientCoordinator and calls this controller only
 * after deciding that a new tab is required.
 */
export class BrowserTabCoordinator {
  constructor({ hub, runtimeOptions, sendCommand, rankClients }) {
    this.hub = hub;
    this.runtimeOptions = runtimeOptions;
    this.sendCommand = sendCommand;
    this.rankClients = rankClients;
  }

  browserControlClients() {
    return Array.from(this.hub.clients || []).filter((client) => client?.ready
      && client.compatible !== false
      && client.compatibility?.compatible !== false
      && client.capabilities?.browserTabs === true);
  }

  browserControlClient(options = {}) {
    const explicitClientId = String(options.sourceClientId || options.clientId || '').trim();
    const clients = this.browserControlClients();
    if (explicitClientId) {
      const explicit = clients.find((client) => client.id === explicitClientId);
      if (!explicit) throw new Error(`Browser extension client cannot control tabs: ${explicitClientId}`);
      return explicit;
    }
    const active = this.hub.activeClient;
    if (active && clients.some((client) => client.id === active.id)) return active;
    if (clients.length === 1) return clients[0];
    throw new Error(clients.length
      ? 'Multiple extension clients can control tabs. Select one with /tab <clientId>.'
      : 'No connected extension client supports browser tab control.');
  }

  async waitForBrowserClient(predicate, timeoutMs = 20_000) {
    const existing = Array.from(this.hub.clients || []).find(predicate);
    if (existing) return existing;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, client = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.hub.off?.('client.ready', handler);
        if (err) reject(err);
        else resolve(client);
      };
      const handler = (client) => {
        if (!predicate(client)) return;
        finish(null, client);
      };
      this.hub.on?.('client.ready', handler);
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for the new ChatGPT browser tab after ${timeoutMs}ms`)), Math.max(250, Number(timeoutMs) || 20_000));
      timer.unref?.();
      handler();
    });
  }

  async waitForBrowserControlClient(timeoutMs = 0) {
    const existing = this.rankClients(this.browserControlClients())[0] || null;
    if (existing || timeoutMs <= 0) return existing;
    try {
      return await this.waitForBrowserClient(
        (client) => client?.ready
          && client.compatible !== false
          && client.compatibility?.compatible !== false
          && client.capabilities?.browserTabs === true,
        timeoutMs,
      );
    } catch {
      return null;
    }
  }

  async openSystemBrowserTab({ url, launchToken, timeoutMs, bridgeServerUrl, allowIncompatibleClient = false }) {
    const targetUrl = browserLaunchUrl(url, launchToken, { bridgeServerUrl: bridgeServerUrl || this.runtimeOptions.publicBaseUrl });
    await this.runtimeOptions.openExternalUrl(targetUrl);
    const client = await this.waitForBrowserClient(
      (candidate) => candidate?.ready
        && ((candidate.compatible !== false && candidate.compatibility?.compatible !== false)
          || (allowIncompatibleClient && Number(candidate.extensionProtocolVersion) === 4))
        && (candidate.launchToken === launchToken || browserLaunchMetadataFromUrl(candidate.url).launchToken === launchToken),
      timeoutMs,
    ).catch((err) => {
      const observed = Array.from(this.hub.clients || []).map((candidate) => {
        const urlToken = browserLaunchMetadataFromUrl(candidate.url).launchToken;
        return `${candidate.id || 'unknown'} url=${candidate.url || '(empty)'} reportedToken=${candidate.launchToken ? 'yes' : 'no'} urlToken=${urlToken ? 'yes' : 'no'} extension=${candidate.extensionVersion || '?'} content=${candidate.clientVersion || '?'}`;
      });
      const suffix = observed.length ? ` Observed clients: ${observed.join('; ')}` : ' No clients connected to this bridge instance.';
      throw new Error(`${err.message}. The default browser must have ChatGPT Bridge extension 2.0.18 with content runtime 4.0.18 installed and configured for this server. Protocol 4 is required; clients that do not complete its handshake are rejected. Reload the unpacked extension and then reload the ChatGPT tab.${suffix}`);
    });
    const launchedClient = normalizeLaunchedClient(client, launchToken);
    return {
      tabId: launchedClient.browserTabId ?? null,
      launchToken,
      requestedUrl: url,
      targetUrl,
      active: true,
      openedBy: 'system',
      sourceClientId: '',
      client: launchedClient,
    };
  }

  async openBrowserTab(options = {}) {
    const url = safeChatGptUrl(options.url || 'https://chatgpt.com/');
    const launchToken = String(options.launchToken || `bridge-tab-${makeRequestId()}`);
    const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || this.runtimeOptions.autoOpenTabTimeoutMs || 30_000);
    const explicitClientId = String(options.sourceClientId || options.clientId || '').trim();
    let source = null;

    if (explicitClientId) {
      source = this.browserControlClient({ sourceClientId: explicitClientId });
    } else {
      source = this.rankClients(this.browserControlClients())[0] || null;
      if (!source && options.allowSystemFallback) {
        const bootstrapWaitMs = Math.max(0, Math.min(timeoutMs, Number(options.bootstrapWaitMs ?? this.runtimeOptions.autoOpenTabBootstrapWaitMs) || 0));
        source = await this.waitForBrowserControlClient(bootstrapWaitMs);
      }
      if (!source && !options.allowSystemFallback) source = this.browserControlClient(options);
    }

    if (!source) return await this.openSystemBrowserTab({
      url,
      launchToken,
      timeoutMs,
      bridgeServerUrl: options.bridgeServerUrl || this.runtimeOptions.publicBaseUrl,
      allowIncompatibleClient: options.allowIncompatibleClient === true,
    });

    const response = await this.sendCommand('browser.tab.open', {
      url,
      active: options.active !== false,
      launchToken,
      timeoutMs,
      bridgeServerUrl: options.bridgeServerUrl || this.runtimeOptions.publicBaseUrl,
    }, { sourceClientId: source.id, timeoutMs: Math.min(timeoutMs, 15_000) });
    const client = await this.waitForBrowserClient(
      (candidate) => candidate?.ready
        && candidate.compatible !== false
        && candidate.compatibility?.compatible !== false
        && (candidate.launchToken === launchToken || browserLaunchMetadataFromUrl(candidate.url).launchToken === launchToken),
      timeoutMs,
    );
    return { ...response, launchToken, client: normalizeLaunchedClient(client, launchToken), sourceClientId: source.id, openedBy: 'extension' };
  }

  async closeBrowserTab(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
    if (!sourceClientId) throw new Error('sourceClientId is required to close a browser tab safely');
    return await this.sendCommand('browser.tab.close', {
      expectedLaunchToken: String(options.expectedLaunchToken || ''),
      expectedUrl: String(options.expectedUrl || ''),
      timeoutMs: Number(options.timeoutMs) || 10_000,
    }, { sourceClientId, timeoutMs: Number(options.timeoutMs) || 10_000 });
  }

  async reloadExtension(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '');
    const before = sourceClientId
      ? (this.hub.clients || []).find((client) => client.id === sourceClientId)
      : this.hub.activeClient;
    if (!before?.id) throw new Error('No browser extension client is available for reload');
    const expectedVersion = String(options.expectedVersion || '');
    const timeoutMs = Math.max(2_000, Number(options.timeoutMs) || 20_000);
    const requestedAt = Date.now();
    let cancelWait = () => {};
    const reconnectPromise = new Promise((resolve, reject) => {
      const check = (client) => {
        if (!client?.ready) return false;
        if (expectedVersion && String(client.extensionVersion || '') !== expectedVersion) return false;
        return client.id === before.id || Number(client.browserTabId) === Number(before.browserTabId);
      };
      const handler = (client) => {
        if (!check(client)) return;
        cleanup();
        resolve(client);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for extension ${expectedVersion || '(any version)'} to reconnect after reload`));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); this.hub.off?.('client.ready', handler); };
      cancelWait = cleanup;
      this.hub.on?.('client.ready', handler);
      const existing = (this.hub.clients || []).find((client) => check(client) && Date.parse(client.connectedAt || 0) >= requestedAt);
      if (existing) {
        cleanup();
        resolve(existing);
      }
    });
    let accepted;
    const reloadServerUrl = options.serverUrl || this.runtimeOptions.publicBaseUrl;
    try {
      accepted = await this.sendCommand('extension.reload', {
        reloadTabs: options.reloadTabs !== false,
        expectedVersion,
        sourceTabId: Number.isInteger(before.browserTabId) ? before.browserTabId : null,
        sourceLaunchToken: BROWSER_LAUNCH_TOKEN_RE.test(String(before.launchToken || '')) ? before.launchToken : '',
        temporaryServerUrl: String(reloadServerUrl || ''),
        connection: { serverUrl: reloadServerUrl },
        pageReloadDelayMs: 900,
      }, {
        sourceClientId: before.id,
        timeoutMs: Math.min(timeoutMs, 8_000),
        allowIncompatibleReload: true,
      });
    } catch (error) {
      cancelWait();
      reconnectPromise.catch(() => {});
      throw error;
    }

    const ownedTabRecovery = options.reloadTabs !== false
      && Number.isInteger(Number(before.browserTabId))
      && BROWSER_LAUNCH_TOKEN_RE.test(String(before.launchToken || ''));
    if (!ownedTabRecovery) return { accepted, reconnected: await reconnectPromise };

    const pageReloadArmed = accepted?.pageReload?.armed === true;
    const graceMs = Math.max(1_500, Math.min(timeoutMs - 1_000, pageReloadArmed ? 12_000 : 3_000));
    const originalReconnect = await Promise.race([
      reconnectPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), graceMs)),
    ]);
    if (originalReconnect) return { accepted, reconnected: originalReconnect };

    cancelWait();
    reconnectPromise.catch(() => {});
    const recoveryLaunchToken = `bridge-recovery-${makeRequestId()}`;
    const parsedBefore = browserLaunchMetadataFromUrl(before.url || '');
    const recoveryUrl = safeChatGptUrl(parsedBefore.requestedUrl || before.requestedUrl || before.url || 'https://chatgpt.com/');
    const elapsedMs = Date.now() - requestedAt;
    const replacement = await this.openSystemBrowserTab({
      url: recoveryUrl,
      launchToken: recoveryLaunchToken,
      timeoutMs: Math.max(5_000, timeoutMs - elapsedMs),
      bridgeServerUrl: reloadServerUrl,
    });
    if (expectedVersion && String(replacement.client?.extensionVersion || '') !== expectedVersion) {
      throw new Error(`Replacement tab connected with extension ${replacement.client?.extensionVersion || 'unknown'}, expected ${expectedVersion}`);
    }
    await this.sendCommand('browser.tab.close-owned', {
      tabId: Number(before.browserTabId),
      expectedLaunchToken: String(before.launchToken || ''),
      timeoutMs: 10_000,
    }, {
      sourceClientId: replacement.client.id,
      timeoutMs: 10_000,
    });
    return {
      accepted,
      reconnected: replacement.client,
      recovery: {
        used: true,
        reason: pageReloadArmed ? 'owned_tab_did_not_reconnect' : 'page_reload_not_armed',
        replacedTabId: Number(before.browserTabId),
        replacementTabId: Number(replacement.client.browserTabId),
        launchToken: recoveryLaunchToken,
      },
    };
  }
}
