import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserBridge } from '../src/browserBridge.js';

class ClientSelectionHub extends EventEmitter {
  constructor(clients = []) {
    super();
    this.sent = [];
    this._clients = clients;
    this._selectedClientId = clients.find((client) => client.selected)?.id || '';
  }
  get clients() { return this._clients; }
  get selectedClientId() { return this._selectedClientId; }
  get debugEvents() { return []; }
  get needsSelection() { return !this._selectedClientId && this._clients.filter((client) => client.ready !== false).length > 1; }
  get activeClient() {
    if (this._selectedClientId) return this._clients.find((client) => client.id === this._selectedClientId && client.ready !== false) || null;
    const ready = this._clients.filter((client) => client.ready !== false);
    return ready.length === 1 ? ready[0] : null;
  }
  sendToClientWithDelivery(clientId, payload) {
    this.sent.push({ clientId, payload });
    const client = this._clients.find((item) => item.id === clientId) || { id: clientId, ready: true };
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return this._clients.find((item) => item.id === clientId) || { id: clientId, ready: true };
  }
  selectClient(clientId) { this._selectedClientId = clientId; return this._clients.find((item) => item.id === clientId); }
  clearSelectedClient() { this._selectedClientId = ''; }
}

function nextTick() { return new Promise((resolve) => setImmediate(resolve)); }

async function finishPrompt(hub, clientId, prompt, answer = 'ok') {
  hub.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId, payload: { type: 'request.terminal_snapshot', requestId: prompt.requestId, answer, session: { id: prompt.options.sessionId || 'new' } } });
}

test('prompt target prefers an idle tab already on the requested session', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-a', ready: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: null },
    { id: 'client-b', ready: true, url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null },
  ]);
  const bridge = new BrowserBridge(hub);

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'session-b' }, {}, { fullResponse: true });
  await nextTick();

  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(sent);
  assert.equal(sent.clientId, 'client-b');
  assert.equal(sent.payload.options.sessionId, 'session-b');

  await finishPrompt(hub, 'client-b', sent.payload);
  const result = await resultPromise;
  assert.equal(result.answer, 'ok');
});

test('prompt target asks before using an idle tab that must switch sessions', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-idle', ready: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null, focused: true },
    { id: 'client-busy', ready: true, url: 'https://chatgpt.com/c/wanted-session', session: { id: 'wanted-session' }, activeRequest: { requestId: 'remote-running' } },
  ]);
  const bridge = new BrowserBridge(hub);
  const confirmations = [];
  const events = [];

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, { onEvent: (event) => events.push(event) }, {
    fullResponse: true,
    confirmClientSelection: async (details) => { confirmations.push(details); return true; },
  });
  await nextTick();

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /switch/i);
  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(sent);
  assert.equal(sent.clientId, 'client-idle');
  assert.equal(sent.payload.options.sessionId, 'wanted-session');
  assert.ok(events.some((event) => event.type === 'client.selection.confirmation_required'));
  assert.ok(events.some((event) => event.type === 'session.switch.requested'));

  await finishPrompt(hub, 'client-idle', sent.payload);
  const result = await resultPromise;
  assert.equal(result.answer, 'ok');
});

test('a selected idle tab on another session still requires confirmation before switching', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-selected', ready: true, selected: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null },
    { id: 'client-other', ready: true, url: 'https://chatgpt.com/c/third-session', session: { id: 'third-session' }, activeRequest: null },
  ]);
  const bridge = new BrowserBridge(hub);
  const confirmations = [];

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, {}, {
    fullResponse: true,
    confirmClientSelection: async (details) => { confirmations.push(details); return true; },
  });
  await nextTick();

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].client.id, 'client-selected');
  assert.equal(confirmations[0].reason, 'selected_idle_session_switch');
  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.equal(sent.clientId, 'client-selected');
  assert.equal(sent.payload.options.sessionId, 'wanted-session');

  await finishPrompt(hub, 'client-selected', sent.payload);
  assert.equal((await resultPromise).answer, 'ok');
});

test('prompt target refuses idle fallback without confirmation', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-idle', ready: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null },
    { id: 'client-busy', ready: true, url: 'https://chatgpt.com/c/wanted-session', session: { id: 'wanted-session' }, activeRequest: { requestId: 'remote-running' } },
  ]);
  const bridge = new BrowserBridge(hub);

  await assert.rejects(
    bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, {}, { fullResponse: true }),
    /Use available idle tab|Run \/tabs/
  );
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.send'), false);
});

test('extension advertises session presence and verifies session switching before prompt send', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const sessionCommands = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  assert.match(source, /session: getCurrentSession\(\)/);
  assert.match(source, /createSessionCommands/);
  assert.match(sessionCommands, /waitForSessionId/);
  assert.match(sessionCommands, /Could not switch ChatGPT tab to session/);
});

test('prompt target never falls back to a busy active tab when no idle tab exists', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-busy', ready: true, selected: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: { requestId: 'other-running', ownerServerInstanceId: 'other-server' } },
  ]);
  const bridge = new BrowserBridge(hub);

  await assert.rejects(
    bridge.sendRequest({ message: 'must not be sent' }, {}, { fullResponse: true }),
    (err) => {
      assert.match(err.message, /No idle ChatGPT tab is available|Busy tabs/);
      assert.match(err.message, /other-running@server:other-server/);
      return true;
    }
  );
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.send'), false);
});

test('prompt is resent to the same tab after session navigation reloads the content script', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-a', ready: true, selected: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: null },
  ]);
  hub.serverInstanceId = 'server-test';
  const bridge = new BrowserBridge(hub);
  const events = [];

  const resultPromise = bridge.sendRequest(
    { message: 'continue in another session', sessionId: 'session-b' },
    { onEvent: (event) => events.push(event) },
    { fullResponse: true, sourceClientId: 'client-a' }
  );
  await nextTick();

  const firstPrompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(firstPrompt);
  assert.equal(firstPrompt.payload.serverInstanceId, 'server-test');
  hub.emit('client.message', { clientId: 'client-a', payload: { type: 'prompt.accepted', requestId: firstPrompt.payload.requestId } });
  hub.emit('client.message', { clientId: 'client-a', payload: {
    type: 'request.effect.started', requestId: firstPrompt.payload.requestId,
    effectId: `${firstPrompt.payload.requestId}:session.apply:2`, effectType: 'session.apply',
  } });

  const reloadedClient = { id: 'client-a', ready: true, selected: true, url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null };
  hub._clients[0] = reloadedClient;
  hub.emit('client.ready', reloadedClient);
  await nextTick();

  const prompts = hub.sent.filter((entry) => entry.payload.type === 'prompt.send');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].clientId, 'client-a');
  assert.equal(prompts[1].payload.requestId, firstPrompt.payload.requestId);
  assert.ok(events.some((event) => event.type === 'prompt.resent_after_navigation'));
  assert.ok(events.some((event) => event.type === 'request.effect.reset_after_navigation'));
  assert.equal(bridge.requestStateDiagnostics(firstPrompt.payload.requestId).state.effect.activeId, null);

  hub.emit('client.message', { clientId: 'client-a', payload: {
    type: 'request.effect.started', requestId: firstPrompt.payload.requestId,
    effectId: `${firstPrompt.payload.requestId}:page.ready.initial:1`, effectType: 'page.ready.initial',
  } });
  assert.equal(bridge.requestStateDiagnostics(firstPrompt.payload.requestId).state.effect.activeType, 'page.ready.initial');
  hub.emit('client.message', { clientId: 'client-a', payload: {
    type: 'request.effect.succeeded', requestId: firstPrompt.payload.requestId,
    effectId: `${firstPrompt.payload.requestId}:page.ready.initial:1`, effectType: 'page.ready.initial',
  } });
  hub.emit('client.message', { clientId: 'client-a', payload: { type: 'status', requestId: firstPrompt.payload.requestId, status: 'sent' } });
  hub.emit('client.message', { clientId: 'client-a', payload: { type: 'request.terminal_snapshot', requestId: firstPrompt.payload.requestId, answer: 'session-safe result', session: { id: 'session-b' } } });
  const result = await resultPromise;
  assert.equal(result.answer, 'session-safe result');
});

test('extension keeps request ownership and duplicate prompt delivery idempotent', async () => {
  const files = [
    'tools/chrome-bridge-extension/content.js',
    'tools/chrome-bridge-extension/content/requestCommands.js',
  ];
  const source = (await Promise.all(files.map((file) => fs.readFile(path.resolve(file), 'utf8')))).join('\n');
  assert.match(source, /ownerServerInstanceId/);
  assert.match(source, /prompt\.duplicate_ignored/);
  assert.match(source, /activeRequest\.requestId === requestId/);
  assert.match(source, /generating,/);
  assert.match(source, /stopButtonVisible/);
});

test('extension reload observes a reconnect that arrives immediately after command acknowledgement', async () => {
  const original = {
    id: 'client-reload',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-wiretoken123',
    extensionVersion: '0.4.20',
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => {
        hub.emit('client.message', {
          clientId,
          payload: {
            type: 'extension.reload.scheduled',
            commandId: payload.commandId,
            scheduled: true,
          },
        });
        const reconnected = {
          ...original,
          extensionVersion: '0.6.1',
          connectedAt: new Date().toISOString(),
        };
        hub._clients[0] = reconnected;
        hub.emit('client.ready', reconnected);
      });
    }
    return client;
  };

  const bridge = new BrowserBridge(hub, null, null, { publicBaseUrl: 'http://127.0.0.1:18181' });
  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '0.6.1',
    timeoutMs: 2_000,
  });

  assert.equal(result.accepted.scheduled, true);
  assert.equal(result.reconnected.extensionVersion, '0.6.1');
  const reloadCommands = hub.sent.filter((entry) => entry.payload.type === 'extension.reload');
  assert.equal(reloadCommands.length, 1);
  assert.deepEqual(reloadCommands[0].payload.connection, { serverUrl: 'http://127.0.0.1:18181' });
  assert.equal(reloadCommands[0].payload.expectedVersion, '0.6.1');
  assert.equal(reloadCommands[0].payload.sourceTabId, 42);
  assert.equal(reloadCommands[0].payload.sourceLaunchToken, 'bridge-real-e2e-wiretoken123');
  assert.equal(reloadCommands[0].payload.temporaryServerUrl, 'http://127.0.0.1:18181');
});

test('extension reload replaces an owned tab when page-owned reload cannot be armed', async () => {
  const original = {
    id: 'client-page-reload-fallback',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-fallback123',
    url: 'https://chatgpt.com/c/session-a',
    extensionVersion: '1.0.14',
    clientVersion: '3.0.14',
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const openedUrls = [];
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: { type: 'extension.reload.scheduled', commandId: payload.commandId, scheduled: true },
      }));
    }
    if (payload.type === 'browser.tab.close-owned') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: {
          type: 'browser.tab.owned_closing', commandId: payload.commandId,
          tabId: payload.tabId, launchToken: payload.expectedLaunchToken, closing: true,
        },
      }));
    }
    return client;
  };

  const bridge = new BrowserBridge(hub, null, null, {
    publicBaseUrl: 'http://127.0.0.1:18181',
    openExternalUrl: async (url) => {
      openedUrls.push(url);
      const launchToken = new URLSearchParams(new URL(url).hash.replace(/^#/, '')).get('chatgpt-bridge-launch');
      assert.match(launchToken, /^bridge-recovery-/);
      assert.equal(launchToken.startsWith('bridge-reload-'), false, 'replacement ownership must not use the temporary reload-token namespace');
      // Match the real extension contract: every bridge-reload-* token is treated
      // as temporary connection metadata and omitted from the hello handshake.
      const reportedLaunchToken = launchToken.startsWith('bridge-reload-') ? '' : launchToken;
      const replacement = {
        id: 'client-replacement', ready: true, selected: false, browserTabId: 77,
        launchToken: reportedLaunchToken, url: 'https://chatgpt.com/c/session-a', extensionVersion: '2.0.0', clientVersion: '4.0.0',
        connectedAt: new Date().toISOString(), compatible: true, compatibility: { compatible: true },
      };
      hub._clients.push(replacement);
      setImmediate(() => hub.emit('client.ready', replacement));
    },
  });

  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '2.0.0',
    timeoutMs: 2_000,
  });

  assert.equal(result.recovery.used, true);
  assert.equal(result.recovery.reason, 'page_reload_not_armed');
  assert.equal(result.reconnected.id, 'client-replacement');
  assert.equal(openedUrls.length, 1);
  const close = hub.sent.find((entry) => entry.payload.type === 'browser.tab.close-owned');
  assert.ok(close);
  assert.equal(close.clientId, 'client-replacement');
  assert.equal(close.payload.tabId, 42);
  assert.equal(close.payload.expectedLaunchToken, 'bridge-real-e2e-fallback123');
});
