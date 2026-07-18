import { config } from '../../config.js';
import { makeRequestId } from '../../protocol.js';
import {
  BROWSER_LAUNCH_TOKEN_RE,
  browserLaunchMetadataFromUrl,
  browserLaunchUrl,
  safeChatGptUrl,
} from '../../browserLaunch.js';
import {
  busyClientLabel,
  clientDisplayLabel,
  clientMatchesSession,
  makeClientSelectionError,
  normalizeConversationId,
  normalizeLaunchedClient,
} from '../clientSelection.js';
import { makeEvent } from '../requestState.js';

/**
 * Owns prompt-tab selection, automatic tab creation, browser-control routing,
 * and extension reload/reconnect waits. It does not own request lifecycle state;
 * request-visible decisions are emitted through the injected lifecycle.
 */
export class BrowserClientCoordinator {
  constructor({ hub, pending, lifecycle, runtimeOptions, sendCommand }) {
    this.hub = hub;
    this.pending = pending;
    this.lifecycle = lifecycle;
    this.runtimeOptions = runtimeOptions;
    this.sendCommand = sendCommand;
  }

canAutoOpenPromptTab(options = {}) {
  if (typeof options.autoOpenTab === 'boolean') return options.autoOpenTab;
  return Boolean(this.runtimeOptions.autoOpenTab);
}

activeRequestCandidates() {
  return Array.from(this.hub.clients || [])
    .filter((client) => client?.ready && client.compatible !== false && client.compatibility?.compatible !== false && client.activeRequest?.requestId)
    .map((client) => ({
      clientId: client.id,
      client,
      activeRequest: client.activeRequest,
      selected: Boolean(client.selected),
    }));
}

findActiveRequest(options = {}) {
  return this.resolveResumeTarget(options, { throwOnMissing: false });
}

pendingUsesClient(clientId = '') {
  const id = String(clientId || '');
  if (!id) return false;
  return Array.from(this.pending.values()).some((state) => !state.done && state.clientId === id);
}

isPromptClientIdle(client = {}) {
  if (!client?.ready && client.ready !== undefined) return false;
  if (client.compatible === false || client.compatibility?.compatible === false) return false;
  if (client.releasingRequestId) return false;
  if (client.activeRequest?.requestId) return false;
  if (this.pendingUsesClient(client.id)) return false;
  return true;
}

async waitForPromptClientRelease(state, client, options = {}, reason = 'release_pending') {
  const requestId = String(client?.releasingRequestId || '');
  if (!requestId || typeof this.hub.waitForClientRelease !== 'function') return false;
  const waitDepth = Number(options.__releaseWaitDepth) || 0;
  if (waitDepth >= 3) {
    throw new Error(`Browser extension client ${client.id} remained in release-pending state for ${requestId}.`);
  }
  const timeoutMs = Math.max(1_000, Number(options.releaseWaitTimeoutMs) || 10_500);
  this.lifecycle.emitRequestEvent(state, makeEvent('client.release.wait_started', {
    requestId: state.requestId,
    clientId: client.id,
    releasingRequestId: requestId,
    reason,
    timeoutMs,
  }));
  try {
    await this.hub.waitForClientRelease(client.id, requestId, timeoutMs);
    this.lifecycle.emitRequestEvent(state, makeEvent('client.release.wait_completed', {
      requestId: state.requestId,
      clientId: client.id,
      releasingRequestId: requestId,
      reason,
    }));
    return true;
  } catch (error) {
    this.lifecycle.emitRequestEvent(state, makeEvent('client.release.wait_failed', {
      requestId: state.requestId,
      clientId: client.id,
      releasingRequestId: requestId,
      reason,
      message: error?.message || String(error),
    }));
    throw new Error(`Browser extension client ${client.id} could not finish releasing ${requestId}: ${error?.message || String(error)}`);
  }
}

rankPromptClients(clients = []) {
  return clients.slice().sort((a, b) => {
    const selectedScore = Number(Boolean(b.selected)) - Number(Boolean(a.selected));
    if (selectedScore) return selectedScore;
    const focusedScore = Number(Boolean(b.focused)) - Number(Boolean(a.focused));
    if (focusedScore) return focusedScore;
    const visibleScore = Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible');
    if (visibleScore) return visibleScore;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

async confirmPromptClient(state, client, details = {}) {
  const confirm = details.options?.confirmClientSelection;
  const sessionId = normalizeConversationId(details.sessionId || '');
  const message = details.message || `Use available ChatGPT tab ${clientDisplayLabel(client)}${sessionId ? ` and switch it to session ${sessionId}` : ''}? [y/N] `;
  this.lifecycle.emitRequestEvent(state, makeEvent('client.selection.confirmation_required', {
    requestId: state.requestId,
    clientId: client.id,
    sessionId: sessionId || undefined,
    reason: details.reason || 'idle_fallback',
    message,
  }));
  if (typeof confirm !== 'function') {
    throw makeClientSelectionError(`${message}\nRun /tabs and /tab <clientId>, or retry from interactive mode to confirm this tab.`, [client]);
  }
  const accepted = await confirm({ message, client, sessionId, reason: details.reason || 'idle_fallback' });
  if (!accepted) throw makeClientSelectionError('No ChatGPT tab selected for this request.', [client]);
  return client;
}

autoOpenPromptEnabled(chatOptions = {}, options = {}) {
  if (typeof options.autoOpenTab === 'boolean') return options.autoOpenTab;
  if (typeof chatOptions.autoOpenTab === 'boolean') return chatOptions.autoOpenTab;
  return Boolean(this.runtimeOptions.autoOpenTab);
}

promptTargetUrl(chatOptions = {}) {
  const sessionId = !chatOptions.newSession ? normalizeConversationId(chatOptions.sessionId || '') : '';
  return sessionId
    ? `https://chatgpt.com/c/${encodeURIComponent(sessionId)}`
    : 'https://chatgpt.com/';
}

async autoOpenPromptClient(state, chatOptions = {}, options = {}, reason = 'no_prompt_client') {
  const timeoutMs = Math.max(5_000, Number(options.autoOpenTabTimeoutMs) || this.runtimeOptions.autoOpenTabTimeoutMs);
  const launchToken = `bridge-auto-${makeRequestId()}`;
  const url = this.promptTargetUrl(chatOptions);
  this.lifecycle.emitRequestEvent(state, makeEvent('client.auto_open.requested', {
    requestId: state.requestId,
    reason,
    url,
    launchToken,
  }));
  try {
    const opened = await this.openBrowserTab({
      url,
      active: options.autoOpenTabActive !== false,
      launchToken,
      timeoutMs,
      bootstrapWaitMs: Number(options.autoOpenTabBootstrapWaitMs ?? this.runtimeOptions.autoOpenTabBootstrapWaitMs),
      allowSystemFallback: true,
    });
    const client = opened.client;
    if (!client?.id || !this.isPromptClientIdle(client)) {
      throw new Error(`Auto-opened ChatGPT tab is not idle: ${client?.id || 'unknown client'}`);
    }
    this.lifecycle.emitRequestEvent(state, makeEvent('client.auto_open.completed', {
      requestId: state.requestId,
      reason,
      clientId: client.id,
      launchToken,
      openedBy: opened.openedBy || 'extension',
      sourceClientId: opened.sourceClientId || '',
      url: client.url || url,
    }));
    return {
      client,
      reason: opened.openedBy === 'system' ? 'auto_opened_system_tab' : 'auto_opened_extension_tab',
      sessionSwitch: false,
      autoOpened: true,
      launchToken,
    };
  } catch (err) {
    this.lifecycle.emitRequestEvent(state, makeEvent('client.auto_open.failed', {
      requestId: state.requestId,
      reason,
      url,
      launchToken,
      message: err.message || String(err),
    }));
    throw new Error(`Could not automatically open a ChatGPT tab: ${err.message || String(err)}`);
  }
}

async resolvePromptClient(state, chatOptions = {}, options = {}) {
  const explicitClientId = String(options.sourceClientId || options.clientId || chatOptions.sourceClientId || chatOptions.clientId || '').trim();
  const retryAfterRelease = async (client, reason) => {
    const waited = await this.waitForPromptClientRelease(state, client, options, reason);
    if (!waited) return null;
    return await this.resolvePromptClient(state, chatOptions, {
      ...options,
      __releaseWaitDepth: (Number(options.__releaseWaitDepth) || 0) + 1,
    });
  };
  const allClients = Array.from(this.hub.clients || []).filter((client) => client?.ready || client?.id);
  const incompatibleClients = allClients.filter((client) => client.compatible === false || client.compatibility?.compatible === false);
  const clients = allClients.filter((client) => client.compatible !== false && client.compatibility?.compatible !== false);
  const idleClients = clients.filter((client) => this.isPromptClientIdle(client));
  const desiredSessionId = !chatOptions.newSession ? normalizeConversationId(chatOptions.sessionId || '') : '';
  const autoOpenEnabled = this.autoOpenPromptEnabled(chatOptions, options);

  if (explicitClientId) {
    const client = clients.find((candidate) => candidate.id === explicitClientId);
    if (!client) throw new Error(`Browser extension client not found or not ready: ${explicitClientId}`);
    if (client.releasingRequestId) return await retryAfterRelease(client, 'explicit_client_release');
    if (!this.isPromptClientIdle(client)) throw new Error(`Browser extension client ${explicitClientId} is busy with ${client.activeRequest?.requestId || 'another local request'}.`);
    return { client, reason: 'explicit_client', sessionSwitch: Boolean(desiredSessionId && !clientMatchesSession(client, desiredSessionId)) };
  }

  if (desiredSessionId) {
    const exactIdle = this.rankPromptClients(idleClients.filter((client) => clientMatchesSession(client, desiredSessionId)));
    if (exactIdle.length === 1) return { client: exactIdle[0], reason: 'session_match', sessionSwitch: false };
    if (exactIdle.length > 1) {
      const selected = exactIdle.find((client) => client.selected) || exactIdle.find((client) => client.focused) || null;
      if (selected) return { client: selected, reason: selected.selected ? 'selected_session_match' : 'focused_session_match', sessionSwitch: false };
      throw makeClientSelectionError(`Multiple idle ChatGPT tabs already have session ${desiredSessionId}. Use /tab <clientId>.`, exactIdle);
    }

    const exactBusy = clients.filter((client) => clientMatchesSession(client, desiredSessionId) && !this.isPromptClientIdle(client));
    const exactReleasing = this.rankPromptClients(exactBusy.filter((client) => client.releasingRequestId));
    if (exactReleasing.length) return await retryAfterRelease(exactReleasing[0], 'session_match_release');
    if (autoOpenEnabled && exactBusy.length) {
      const busy = exactBusy.map((client) => busyClientLabel(client, this.hub.serverInstanceId)).join(', ');
      throw new Error(`Session ${desiredSessionId} is open, but its tab is busy (${busy}). Wait or /resume; auto-open will not duplicate an actively used conversation.`);
    }
    if (!clients.length && incompatibleClients.length) {
      const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
      throw new Error(`Connected browser extension is incompatible. ${details}`);
    }
    if (autoOpenEnabled) return await this.autoOpenPromptClient(state, chatOptions, options, 'requested_session_not_connected');

    const selectedIdle = idleClients.find((client) => client.selected);
    if (selectedIdle) {
      const client = await this.confirmPromptClient(state, selectedIdle, {
        options,
        sessionId: desiredSessionId,
        reason: 'selected_idle_session_switch',
        message: `Selected tab ${clientDisplayLabel(selectedIdle)} is not on session ${desiredSessionId}. Switch this idle tab before sending? [y/N] `,
      });
      return { client, reason: 'confirmed_selected_session_switch', sessionSwitch: true };
    }

    const fallbackIdle = this.rankPromptClients(idleClients);
    if (fallbackIdle.length === 1) {
      const client = await this.confirmPromptClient(state, fallbackIdle[0], {
        options,
        sessionId: desiredSessionId,
        reason: 'idle_session_switch',
        message: `No connected tab is currently on session ${desiredSessionId}. Use available idle tab ${clientDisplayLabel(fallbackIdle[0])} and switch it before sending? [y/N] `,
      });
      return { client, reason: 'confirmed_idle_session_switch', sessionSwitch: true };
    }
    if (fallbackIdle.length > 1) {
      throw makeClientSelectionError(`No connected tab is currently on session ${desiredSessionId}, and multiple idle tabs are available. Use /tabs and /tab <clientId>.`, fallbackIdle);
    }
    if (exactBusy.length) {
      const busy = exactBusy.map((client) => busyClientLabel(client, this.hub.serverInstanceId)).join(', ');
      throw new Error(`Session ${desiredSessionId} is open, but its tab is busy (${busy}). Wait, /resume, or select another idle tab to switch.`);
    }

  }

  const activeReference = this.hub.activeClient;
  const active = clients.find((client) => client.id === activeReference?.id) || activeReference;
  if (active?.releasingRequestId) return await retryAfterRelease(active, active.selected ? 'selected_client_release' : 'active_client_release');
  if (active && this.isPromptClientIdle(active)) return { client: active, reason: active.selected ? 'selected_client' : 'active_client', sessionSwitch: false };

  const rankedIdle = this.rankPromptClients(idleClients);
  const releasingClients = this.rankPromptClients(clients.filter((client) => client.releasingRequestId));
  if (!rankedIdle.length && releasingClients.length) return await retryAfterRelease(releasingClients[0], 'no_idle_client_release');
  if (rankedIdle.length === 1 && clients.length === 1) return { client: rankedIdle[0], reason: 'single_client', sessionSwitch: false };
  if (!clients.length && incompatibleClients.length) {
    const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
    throw new Error(`Connected browser extension is incompatible. ${details}`);
  }
  if (autoOpenEnabled && (rankedIdle.length !== 1 || clients.length !== 1)) {
    const reason = rankedIdle.length > 1
      ? 'multiple_unselected_idle_tabs'
      : rankedIdle.length === 1
        ? 'unselected_idle_tab'
        : clients.length
          ? 'all_connected_tabs_busy'
          : 'no_connected_tabs';
    return await this.autoOpenPromptClient(state, chatOptions, options, reason);
  }
  if (rankedIdle.length === 1) {
    const client = await this.confirmPromptClient(state, rankedIdle[0], {
      options,
      reason: 'idle_fallback',
      message: `No ChatGPT tab is selected. Use available idle tab ${clientDisplayLabel(rankedIdle[0])}? [y/N] `,
    });
    return { client, reason: 'confirmed_idle_fallback', sessionSwitch: false };
  }
  if (rankedIdle.length > 1) {
    throw makeClientSelectionError('Multiple idle ChatGPT tabs are connected. Use /tabs and /tab <clientId>.', rankedIdle);
  }

  const busy = clients.filter((client) => !this.isPromptClientIdle(client));
  if (busy.length) {
    const details = busy.map((client) => busyClientLabel(client, this.hub.serverInstanceId)).join(', ');
    throw new Error(`No idle ChatGPT tab is available. Busy tabs: ${details}. Wait for the current request, use /resume, or open another ChatGPT tab.`);
  }
  if (incompatibleClients.length) {
    const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
    throw new Error(`Connected browser extension is incompatible. ${details}`);
  }
  throw new Error('No browser extension client connected. Open ChatGPT with the ChatGPT Bridge extension enabled.');
}

sendPromptToClient(client, payload, options = {}) {
  if (!client?.id) throw new Error('No idle browser extension client was resolved for this prompt.');
  if (typeof this.hub.sendToClientWithDelivery === 'function') {
    return this.hub.sendToClientWithDelivery(client.id, payload, { timeoutMs: config.promptDeliveryTimeoutMs });
  }
  if (typeof this.hub.sendToClient === 'function') {
    const sentClient = this.hub.sendToClient(client.id, payload);
    return { client: sentClient && typeof sentClient === 'object' ? sentClient : client, delivered: Promise.resolve({ clientId: client.id, deliveredAt: Date.now() }) };
  }
  throw new Error(`Browser extension transport cannot send directly to resolved client ${client.id}.`);
}

resolveResumeTarget(options = {}, { throwOnMissing = true } = {}) {
  const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
  const expectedRequestId = String(options.expectedRequestId || '').trim();
  const preferredRequestId = String(options.preferredRequestId || '').trim();
  const clients = Array.from(this.hub.clients || []).filter((client) => client.compatible !== false && client.compatibility?.compatible !== false);
  const candidates = clients
    .filter((client) => client?.ready && client.activeRequest?.requestId)
    .map((client) => ({ clientId: client.id, client, activeRequest: client.activeRequest, selected: Boolean(client.selected) }));

  const fail = (message) => {
    if (!throwOnMissing) return null;
    throw new Error(message);
  };

  if (sourceClientId) {
    const client = clients.find((candidate) => candidate.id === sourceClientId && candidate.ready);
    if (!client) return fail(`Browser extension client not found or not ready: ${sourceClientId}`);
    if (!client.activeRequest?.requestId) return fail(`Browser extension client ${sourceClientId} has no active ChatGPT prompt to resume.`);
    if (expectedRequestId && client.activeRequest.requestId !== expectedRequestId) {
      return fail(`Client ${sourceClientId} is running ${client.activeRequest.requestId}, not ${expectedRequestId}.`);
    }
    return { clientId: client.id, client, activeRequest: client.activeRequest, selected: Boolean(client.selected) };
  }

  if (expectedRequestId) {
    const matches = candidates.filter((candidate) => candidate.activeRequest.requestId === expectedRequestId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return fail(`Multiple browser extension clients report active prompt ${expectedRequestId}; select one with /tab <clientId>.`);
    return fail(`No connected ChatGPT tab reports active prompt ${expectedRequestId}.`);
  }

  if (preferredRequestId) {
    const preferred = candidates.filter((candidate) => candidate.activeRequest.requestId === preferredRequestId);
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return fail(`Multiple browser extension clients report active prompt ${preferredRequestId}; select one with /tab <clientId>.`);
  }

  const active = this.hub.activeClient;
  if (active?.activeRequest?.requestId) return { clientId: active.id, client: active, activeRequest: active.activeRequest, selected: true };

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const list = candidates.map((candidate) => `${candidate.clientId}:${candidate.activeRequest.requestId}`).join(', ');
    return fail(`Multiple ChatGPT prompts are running (${list}). Select the source tab with /tab <clientId> or use /resume after closing other running prompts.`);
  }

  return fail('No active ChatGPT prompt is running in any connected tab.');
}

browserControlClients() {
  return Array.from(this.hub.clients || [])
    .filter((client) => client?.ready
      && client.compatible !== false
      && client.compatibility?.compatible !== false
      && client.capabilities?.browserTabs === true);
}

browserControlClient(options = {}) {
  const explicitClientId = String(options.sourceClientId || options.clientId || '').trim();
  const clients = Array.from(this.hub.clients || [])
    .filter((client) => client?.ready && client.compatible !== false && client.compatibility?.compatible !== false);
  if (explicitClientId) {
    const client = clients.find((candidate) => candidate.id === explicitClientId);
    if (!client) throw new Error(`Browser extension client not found or not ready: ${explicitClientId}`);
    if (client.capabilities?.browserTabs !== true) {
      throw new Error(`Browser extension client ${explicitClientId} does not support browser tab automation. Reload the extension packaged with this bridge.`);
    }
    return client;
  }
  const capable = clients.filter((client) => client.capabilities?.browserTabs === true);
  if (!capable.length) {
    if (clients.length) throw new Error('Connected extension does not support browser tab automation. Reload the extension packaged with this bridge.');
    throw new Error('No browser extension client connected.');
  }
  return this.rankPromptClients(capable)[0];
}

async waitForBrowserClient(predicate, timeoutMs = 20_000) {
  const find = () => Array.from(this.hub.clients || []).find(predicate) || null;
  const existing = find();
  if (existing) return existing;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const event of events) this.hub.off(event, handler);
      if (err) reject(err);
      else resolve(value);
    };
    const handler = () => {
      const match = find();
      if (match) finish(null, match);
    };
    const events = ['client.ready', 'client.changed', 'client.activity'];
    for (const event of events) this.hub.on(event, handler);
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for the new ChatGPT browser tab after ${timeoutMs}ms`)), Math.max(250, Number(timeoutMs) || 20_000));
    timer.unref?.();
    handler();
  });
}

async waitForBrowserControlClient(timeoutMs = 0) {
  const existing = this.rankPromptClients(this.browserControlClients())[0] || null;
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
    throw new Error(`${err.message}. The default browser must have ChatGPT Bridge extension 2.0.3 with content runtime 4.0.3 installed and configured for this server. Protocol 4 is required; clients that do not complete its handshake are rejected. Reload the unpacked extension and then reload the ChatGPT tab.${suffix}`);
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
    source = this.rankPromptClients(this.browserControlClients())[0] || null;
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
  // `bridge-reload-*` is reserved for temporary connection handoff tokens and is
  // deliberately stripped by the extension. A replacement tab needs a stable
  // ownership token so the coordinator can correlate it and cleanup can close it.
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
