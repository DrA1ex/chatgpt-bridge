import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { TampermonkeyBridge, browserLaunchUrl } from '../src/tampermonkeyBridge.js';
import { browserLaunchMetadataFromUrl } from '../src/browserLaunch.js';

async function loadDomCore() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context, { filename: 'domParserCore.js' });
  return context.ChatGptDomParserCore;
}

class BrowserCommandHub extends EventEmitter {
  constructor() {
    super();
    this.serverInstanceId = 'server-test';
    this.selectedClientId = 'bootstrap';
    this.needsSelection = false;
    this._clients = [{
      id: 'bootstrap',
      ready: true,
      selected: true,
      compatible: true,
      focused: true,
      visibilityState: 'visible',
      capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
      url: 'https://chatgpt.com/',
      session: { id: 'new', url: 'https://chatgpt.com/' },
    }];
    this.commands = [];
  }

  get clients() { return this._clients.map((client) => ({ ...client })); }
  get activeClient() { return this._clients.find((client) => client.id === this.selectedClientId) || null; }

  sendToClient(clientId, payload) {
    const client = this._clients.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`missing client ${clientId}`);
    this.commands.push({ clientId, payload });
    queueMicrotask(() => {
      if (payload.type === 'browser.tab.open') {
        this.emit('client.message', {
          clientId,
          payload: { type: 'browser.tab.opened', commandId: payload.commandId, tabId: 42, launchToken: payload.launchToken },
        });
        const opened = {
          id: 'opened-tab',
          ready: true,
          compatible: true,
          selected: false,
          focused: true,
          visibilityState: 'visible',
          capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
          launchToken: payload.launchToken,
          url: 'https://chatgpt.com/',
          session: { id: 'new', url: 'https://chatgpt.com/' },
        };
        this._clients.push(opened);
        this.emit('client.ready', { ...opened });
      } else if (payload.type === 'sessions.delete') {
        this.emit('client.message', {
          clientId,
          payload: {
            type: 'session.deleted',
            commandId: payload.commandId,
            deleted: true,
            deletedSessionId: payload.sessionId,
            beforeUrl: payload.expectedUrl,
            afterUrl: 'https://chatgpt.com/',
          },
        });
      } else if (payload.type === 'prompt.send') {
        client.activeRequest = { requestId: payload.requestId, phase: 'generating' };
        this.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId: payload.requestId } });
      } else if (payload.type === 'prompt.steer') {
        this.emit('client.message', { clientId, payload: { type: 'prompt.steered', commandId: payload.commandId, requestId: payload.requestId } });
      }
    });
    return client;
  }

  sendToActive(payload) { return this.sendToClient(this.selectedClientId, payload); }
  selectClient(clientId) { this.selectedClientId = clientId; return this._clients.find((client) => client.id === clientId); }
  clearSelectedClient() { this.selectedClientId = ''; }
}


class SystemLaunchHub extends EventEmitter {
  constructor() {
    super();
    this.serverInstanceId = 'server-system-launch';
    this.selectedClientId = '';
    this.needsSelection = false;
    this._clients = [];
    this.commands = [];
  }

  get clients() { return this._clients.map((client) => ({ ...client })); }
  get activeClient() { return this._clients.find((client) => client.id === this.selectedClientId) || null; }

  addClient({ id, launchToken = '', url = 'https://chatgpt.com/' }) {
    const client = {
      id,
      ready: true,
      compatible: true,
      focused: true,
      visibilityState: 'visible',
      capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
      launchToken,
      url,
      session: { id: 'new', url },
    };
    this._clients.push(client);
    this.emit('client.ready', { ...client });
    return client;
  }

  addLaunchedClient(launchToken) {
    const client = {
      id: 'system-opened-tab',
      ready: true,
      compatible: true,
      focused: true,
      visibilityState: 'visible',
      capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
      launchToken,
      url: 'https://chatgpt.com/',
      session: { id: 'new', url: 'https://chatgpt.com/' },
    };
    this._clients.push(client);
    this.emit('client.ready', { ...client });
    return client;
  }

  sendToClient(clientId, payload) {
    const client = this._clients.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`missing client ${clientId}`);
    this.commands.push({ clientId, payload });
    if (payload.type === 'prompt.send') {
      queueMicrotask(() => {
        this.emit('client.message', { clientId, payload: { type: 'prompt.accepted', requestId: payload.requestId } });
        this.emit('client.message', { clientId, payload: { type: 'done', requestId: payload.requestId, answer: 'system tab answer', artifacts: [], session: { id: 'system-session', url: 'https://chatgpt.com/c/system-session' } } });
      });
    }
    return client;
  }

  selectClient(clientId) { this.selectedClientId = clientId; return this._clients.find((client) => client.id === clientId) || null; }
  clearSelectedClient() { this.selectedClientId = ''; }
}


test('system browser launch URL carries one safe token, isolated bridge server, and rejects unrelated origins', () => {
  const url = browserLaunchUrl('https://chatgpt.com/c/session-1?x=1', 'bridge-auto-a1b2c3d4e5f6', { bridgeServerUrl: 'http://127.0.0.1:18181' });
  const parsed = new URL(url);
  assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('chatgpt-bridge-launch'), 'bridge-auto-a1b2c3d4e5f6');
  assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('chatgpt-bridge-server'), 'http://127.0.0.1:18181');
  assert.deepEqual(browserLaunchMetadataFromUrl(url), {
    launchToken: 'bridge-auto-a1b2c3d4e5f6',
    bridgeServerUrl: 'http://127.0.0.1:18181',
    requestedUrl: 'https://chatgpt.com/c/session-1?x=1',
  });
  assert.throws(() => browserLaunchUrl('https://example.com/', 'bridge-auto-a1b2c3d4e5f6'), /non-ChatGPT URL/);
  assert.throws(() => browserLaunchUrl('https://chatgpt.com:8443/', 'bridge-auto-a1b2c3d4e5f6'), /non-ChatGPT URL/);
  assert.throws(() => browserLaunchUrl('https://user:pass@chatgpt.com/', 'bridge-auto-a1b2c3d4e5f6'), /non-ChatGPT URL/);
  assert.throws(() => browserLaunchUrl('https://chatgpt.com/', 'unsafe-token'), /safe one-time bridge launch token/);
  assert.throws(() => browserLaunchUrl('https://chatgpt.com/', 'bridge-auto-a1b2c3d4e5f6', { bridgeServerUrl: 'http://192.168.1.10:8080' }), /non-loopback bridge server URL/);
});

test('ordinary prompt auto-opens the system browser and routes only to the token-matched tab', async () => {
  const hub = new SystemLaunchHub();
  let openedUrl = '';
  const bridge = new TampermonkeyBridge(hub, null, null, {
    autoOpenTab: true,
    autoOpenTabBootstrapWaitMs: 0,
    autoOpenTabTimeoutMs: 5_000,
    publicBaseUrl: 'http://127.0.0.1:18181',
    openExternalUrl: async (url) => {
      openedUrl = url;
      queueMicrotask(() => {
        hub.addClient({ id: 'late-reconnected-old-tab', url: 'https://chatgpt.com/c/old-session' });
        hub.addClient({ id: 'system-opened-tab', url });
      });
    },
  });
  const response = await bridge.sendRequest({ requestId: 'auto-open-request', message: 'hello' }, {}, { fullResponse: true });
  assert.equal(response.answer, 'system tab answer');
  assert.match(openedUrl, /chatgpt-bridge-launch=bridge-auto-/);
  assert.match(openedUrl, /chatgpt-bridge-server=http%3A%2F%2F127\.0\.0\.1%3A18181/);
  assert.equal(hub.commands.find((entry) => entry.payload.type === 'prompt.send')?.clientId, 'system-opened-tab');
  assert.equal(hub.commands.some((entry) => entry.clientId === 'late-reconnected-old-tab'), false);
  await bridge.close();
});

test('per-request autoOpenTab false overrides the server default', async () => {
  const hub = new SystemLaunchHub();
  let opened = false;
  const bridge = new TampermonkeyBridge(hub, null, null, {
    autoOpenTab: true,
    autoOpenTabBootstrapWaitMs: 0,
    openExternalUrl: async () => { opened = true; },
  });
  await assert.rejects(
    () => bridge.sendRequest({ requestId: 'no-auto-open', message: 'hello', autoOpenTab: false }, {}, { fullResponse: true }),
    /No browser extension client connected/,
  );
  assert.equal(opened, false);
  await bridge.close();
});

test('auto-open refuses to duplicate a requested conversation that is already busy', async () => {
  const hub = new BrowserCommandHub();
  hub._clients[0].url = 'https://chatgpt.com/c/busy-session';
  hub._clients[0].session = { id: 'busy-session', url: 'https://chatgpt.com/c/busy-session' };
  hub._clients[0].activeRequest = { requestId: 'other-request', phase: 'generating' };
  hub._clients.push({
    id: 'other-idle', ready: true, compatible: true, focused: false, visibilityState: 'visible',
    capabilities: { browserTabs: true }, url: 'https://chatgpt.com/', session: { id: 'new', url: 'https://chatgpt.com/' },
  });
  const bridge = new TampermonkeyBridge(hub, null, null, { autoOpenTab: true, autoOpenTabTimeoutMs: 5_000 });
  await assert.rejects(
    () => bridge.sendRequest({ requestId: 'busy-session-auto-open', message: 'hello', sessionId: 'busy-session' }, {}, { fullResponse: true }),
    /auto-open will not duplicate an actively used conversation/,
  );
  assert.equal(hub.commands.some((entry) => entry.payload.type === 'browser.tab.open'), false);
  await bridge.close();
});

test('ordinary prompt uses extension tab creation when connected tabs are busy', async () => {
  const hub = new BrowserCommandHub();
  hub._clients[0].activeRequest = { requestId: 'other-request', phase: 'generating' };
  const bridge = new TampermonkeyBridge(hub, null, null, { autoOpenTab: true, autoOpenTabTimeoutMs: 5_000 });
  const pending = bridge.sendRequest({ requestId: 'auto-open-extension', message: 'hello' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = hub.commands.find((entry) => entry.payload.type === 'prompt.send');
  assert.equal(hub.commands[0].payload.type, 'browser.tab.open');
  assert.equal(prompt?.clientId, 'opened-tab');
  hub.emit('client.message', { clientId: 'opened-tab', payload: { type: 'done', requestId: 'auto-open-extension', answer: 'extension tab answer', artifacts: [], session: { id: 's2' } } });
  assert.equal((await pending).answer, 'extension tab answer');
  await bridge.close();
});

test('safe session deletion requires the current conversation id and canonical URL to match', async () => {
  const core = await loadDomCore();
  assert.deepEqual(
    { ...core.verifySessionDeletionTarget({
      currentUrl: 'https://chatgpt.com/c/session-123?temporary=1',
      expectedUrl: 'https://chatgpt.com/c/session-123#inspection',
      expectedSessionId: 'session-123',
    }) },
    {
      ok: true,
      currentId: 'session-123',
      expectedId: 'session-123',
      currentCanonical: 'https://chatgpt.com/c/session-123',
      expectedCanonical: 'https://chatgpt.com/c/session-123',
    },
  );
  assert.equal(core.verifySessionDeletionTarget({
    currentUrl: 'https://chatgpt.com/c/other',
    expectedUrl: 'https://chatgpt.com/c/session-123',
    expectedSessionId: 'session-123',
  }).reason, 'current_session_mismatch');
  assert.equal(core.verifySessionDeletionTarget({
    currentUrl: 'https://chatgpt.com/',
    expectedUrl: 'https://chatgpt.com/c/session-123',
    expectedSessionId: 'session-123',
  }).reason, 'current_url_is_not_a_conversation');
  assert.equal(core.verifySessionDeletionTarget({
    currentUrl: 'https://chatgpt.com/c/session-123',
    expectedUrl: 'https://example.com/c/session-123',
    expectedSessionId: 'session-123',
  }).reason, 'expected_url_is_not_a_conversation');
});

test('bridge opens an isolated browser tab and waits for its launch token client', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new TampermonkeyBridge(hub);
  const result = await bridge.openBrowserTab({ launchToken: 'real-e2e-token', timeoutMs: 5_000 });
  assert.equal(result.launchToken, 'real-e2e-token');
  assert.equal(result.client.id, 'opened-tab');
  assert.equal(hub.commands[0].payload.type, 'browser.tab.open');
  assert.equal(hub.commands[0].payload.launchToken, 'real-e2e-token');
  await bridge.close();
});

test('bridge session deletion always sends both expected session id and URL to one source tab', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new TampermonkeyBridge(hub);
  const result = await bridge.deleteSession('session-123', 'https://chatgpt.com/c/session-123', { sourceClientId: 'bootstrap', timeoutMs: 5_000 });
  assert.equal(result.deletedSessionId, 'session-123');
  assert.deepEqual(hub.commands[0], {
    clientId: 'bootstrap',
    payload: {
      type: 'sessions.delete',
      commandId: hub.commands[0].payload.commandId,
      sessionId: 'session-123',
      expectedUrl: 'https://chatgpt.com/c/session-123',
    },
  });
  await assert.rejects(() => bridge.deleteSession('session-123', '', { sourceClientId: 'bootstrap' }), /expectedUrl is required/);
  await bridge.close();
});

test('request sourceClientId is preserved from the request body instead of falling back to selected tab', async () => {
  const hub = new BrowserCommandHub();
  hub._clients.push({
    id: 'explicit-tab', ready: true, compatible: true, focused: false, visibilityState: 'visible',
    capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
    url: 'https://chatgpt.com/', session: { id: 'new', url: 'https://chatgpt.com/' },
  });
  const bridge = new TampermonkeyBridge(hub);
  const pending = bridge.sendRequest({ requestId: 'explicit-source', message: 'target', sourceClientId: 'explicit-tab' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.commands.find((entry) => entry.payload.type === 'prompt.send')?.clientId, 'explicit-tab');
  hub.emit('client.message', { clientId: 'explicit-tab', payload: { type: 'done', requestId: 'explicit-source', answer: 'targeted', artifacts: [], session: { id: 'source-session' } } });
  assert.equal((await pending).answer, 'targeted');
  await bridge.close();
});

test('bridge sends steer to the source tab of a tracked active request', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new TampermonkeyBridge(hub);
  const request = bridge.sendRequest({ requestId: 'steer-request', message: 'start', sourceClientId: 'bootstrap' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  const steered = await bridge.steerRequest('steer-request', 'change direction', { timeoutMs: 5_000 });
  assert.equal(steered.requestId, 'steer-request');
  assert.equal(hub.commands.find((entry) => entry.payload.type === 'prompt.steer')?.clientId, 'bootstrap');
  hub.emit('client.message', { clientId: 'bootstrap', payload: { type: 'done', requestId: 'steer-request', answer: 'done', artifacts: [], session: { id: 's1' } } });
  await request;
  await bridge.close();
});

test('real E2E runner covers reasoning, steer, files, ZIP, project context, reuse, reports, and safe cleanup', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  const source = await fs.readFile(path.resolve('scripts/e2e-real.js'), 'utf8');
  assert.equal(packageJson.scripts['test:e2e:real'], 'node scripts/e2e-real.js');
  assert.match(source, /--keep-session/);
  assert.match(source, /bootstrapWaitMs: 0/);
  assert.match(source, /findFreeLoopbackPort/);
  assert.match(source, /bridgeServerUrl: options\.baseUrl/);
  assert.match(source, /Starting isolated bridge/);
  assert.match(source, /allowSystemFallback: options\.autoOpenBrowser/);
  assert.match(source, /opened\.client\.launchToken === launchToken/);
  assert.doesNotMatch(source, /More than one new ChatGPT tab appeared/);
  assert.match(source, /visible reasoning items, finalization and steer/);
  assert.match(source, /Waiting for ChatGPT composer/);
  assert.match(source, /pageReady && client\.composerReady && client\.chatMainReady/);
  assert.match(source, /content runtime 2\.12\.5\+/);
  assert.match(source, /--model/);
  assert.match(source, /--effort/);
  assert.match(source, /requested model and effort matrix/);
  assert.match(source, /STEER_RESULT RED/);
  assert.match(source, /STEER_RESULT BLUE/);
  assert.match(source, /waitForSteerWindow/);
  assert.match(source, /generationObserved/);
  assert.match(source, /currentGenerationActive/);
  assert.match(source, /only in the context of this conversation/);
  assert.match(source, /Do not add it to ChatGPT account-wide memory/);
  assert.doesNotMatch(source, /[\u0400-\u04ff]/);
  assert.match(source, /report\.partial\.json/);
  assert.match(source, /timeline\.partial\.ndjson/);
  assert.match(source, /path\.join\(process\.cwd\(\), '\.bridge-data', 'e2e', 'last-real-e2e'\)/);
  assert.match(source, /multiple downloadable files/);
  assert.match(source, /single deterministic ZIP artifact/);
  assert.match(source, /project AGENT\.md, skill, multi-turn edit and snapshot reuse/);
  assert.match(source, /project without AGENT\.md or skills remains functional/);
  assert.match(source, /prompt\.steer\.accepted/);
  assert.match(source, /package2\.attached === false/);
  assert.match(source, /timeline\.ndjson/);
  assert.match(source, /Diagnostic bundle/);
  assert.match(source, /sourceClientId: testClient\.id/);
  assert.match(source, /expectedUrl: sessionUrl/);
  assert.match(source, /Cleanup refused/);
  assert.doesNotMatch(packageJson.scripts.test, /e2e-real/);
});
