import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { BrowserBridge, browserLaunchUrl } from '../src/browserBridge.js';
import { browserLaunchMetadataFromUrl } from '../src/browserLaunch.js';
import { commandResult, emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

async function readRealE2eSource() {
  const files = [path.resolve('scripts/e2e-real.js')];
  const collect = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  };
  await collect(path.resolve('scripts/e2e'));
  return (await Promise.all(files.sort().map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

async function loadDomCore() {
  const [artifactSource, source] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8'),
  ]);
  const context = vm.createContext({ URL });
  vm.runInContext(artifactSource, context, { filename: 'artifactParserCore.js' });
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

  sendToClientWithDelivery(clientId, payload, options = {}) {
    return { client: this.sendToClient(clientId, payload, options), delivered: Promise.resolve() };
  }

  sendToClient(clientId, payload, options = {}) {
    const client = this._clients.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`missing client ${clientId}`);
    this.commands.push({ clientId, payload, options });
    queueMicrotask(() => {
      if (payload.type === 'browser.tab.open') {
        this.emit('client.message', {
          clientId,
          payload: commandResult(payload.commandId, 'browser.tab.opened', { tabId: 42, launchToken: payload.launchToken }),
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
          payload: commandResult(payload.commandId, 'session.deleted', {
            deleted: true,
            deletedSessionId: payload.sessionId,
            beforeUrl: payload.expectedUrl,
            afterUrl: 'https://chatgpt.com/',
          }),
        });
      } else if (payload.type === 'prompt.send') {
        client.activeRequest = { requestId: payload.requestId, responseEpoch: Number(payload.responseEpoch) || 0 };
      } else if (payload.type === 'browser.tab.reload') {
        this.emit('client.message', { clientId, payload: commandResult(payload.commandId, 'browser.tab.reloading', { requestId: payload.requestId }) });
      } else if (payload.type === 'prompt.steer') {
        this.emit('client.message', {
          clientId,
          payload: {
            type: 'request.effect.succeeded',
            commandId: payload.commandId,
            requestId: payload.requestId,
            effectId: payload.effect.effectId,
            effectType: 'prompt.steer',
            responseEpoch: Number(payload.effect.responseEpoch) || 0,
            result: { submittedUserTurnKey: 'user-steered' },
          },
        });
      } else if (payload.type === 'passive.prompt.submit') {
        this.emit('client.message', { clientId, payload: { type: 'command.progress', commandId: payload.commandId, progressType: 'passive.prompt.submit.started' } });
        this.emit('client.message', { clientId, payload: commandResult(payload.commandId, 'passive.prompt.submitted', { submittedUserTurnKey: 'passive-user-turn', session: { id: 'passive-session' } }) });
      }
    });
    return client;
  }

  sendToActive(payload, options = {}) { return this.sendToClient(this.selectedClientId, payload, options); }
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
      setImmediate(() => {
        emitPromptSubmitted(this, { requestId: payload.requestId, clientId });
        queueMicrotask(() => emitTabObservation(this, {
          requestId: payload.requestId,
          clientId,
          conversationId: 'system-session',
          answer: 'system tab answer',
          session: { id: 'system-session', url: 'https://chatgpt.com/c/system-session' },
        }));
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
  const bridge = new BrowserBridge(hub, null, null, {
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
  const bridge = new BrowserBridge(hub, null, null, {
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
  const bridge = new BrowserBridge(hub, null, null, { autoOpenTab: true, autoOpenTabTimeoutMs: 5_000 });
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
  const bridge = new BrowserBridge(hub, null, null, { autoOpenTab: true, autoOpenTabTimeoutMs: 5_000 });
  const pending = bridge.sendRequest({ requestId: 'auto-open-extension', message: 'hello' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = hub.commands.find((entry) => entry.payload.type === 'prompt.send');
  assert.equal(hub.commands[0].payload.type, 'browser.tab.open');
  assert.equal(prompt?.clientId, 'opened-tab');
  emitPromptSubmitted(hub, { requestId: 'auto-open-extension', clientId: 'opened-tab' });
  emitTabObservation(hub, { requestId: 'auto-open-extension', clientId: 'opened-tab', conversationId: 's2', answer: 'extension tab answer', session: { id: 's2' } });
  assert.equal((await pending).answer, 'extension tab answer');
  await bridge.close();
});

test('passive prompt submission uses a browser command without creating a pending request', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new BrowserBridge(hub, null, null);
  const result = await bridge.submitPassivePrompt({ message: 'create an artifact', sessionId: 'passive-session', effort: 'instant', sourceClientId: 'bootstrap' });
  assert.equal(result.submittedUserTurnKey, 'passive-user-turn');
  const command = hub.commands.find((entry) => entry.payload.type === 'passive.prompt.submit');
  assert.equal(command.payload.options.sessionId, 'passive-session');
  assert.equal(command.payload.options.effort, 'instant');
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
  const bridge = new BrowserBridge(hub);
  const result = await bridge.openBrowserTab({ launchToken: 'real-e2e-token', timeoutMs: 5_000 });
  assert.equal(result.launchToken, 'real-e2e-token');
  assert.equal(result.client.id, 'opened-tab');
  assert.equal(hub.commands[0].payload.type, 'browser.tab.open');
  assert.equal(hub.commands[0].payload.launchToken, 'real-e2e-token');
  await bridge.close();
});

test('bridge session deletion always sends both expected session id and URL to one source tab', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new BrowserBridge(hub);
  const result = await bridge.deleteSession('session-123', 'https://chatgpt.com/c/session-123', { sourceClientId: 'bootstrap', timeoutMs: 5_000 });
  assert.equal(result.deletedSessionId, 'session-123');
  assert.equal(hub.commands[0].clientId, 'bootstrap');
  assert.deepEqual(hub.commands[0].payload, {
    type: 'sessions.delete',
    commandId: hub.commands[0].payload.commandId,
    sessionId: 'session-123',
    expectedUrl: 'https://chatgpt.com/c/session-123',
  });
  assert.equal(hub.commands[0].options.request, null);
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
  const bridge = new BrowserBridge(hub);
  const pending = bridge.sendRequest({ requestId: 'explicit-source', message: 'target', sourceClientId: 'explicit-tab' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.commands.find((entry) => entry.payload.type === 'prompt.send')?.clientId, 'explicit-tab');
  emitPromptSubmitted(hub, { requestId: 'explicit-source', clientId: 'explicit-tab' });
  emitTabObservation(hub, { requestId: 'explicit-source', clientId: 'explicit-tab', conversationId: 'source-session', answer: 'targeted', session: { id: 'source-session' } });
  assert.equal((await pending).answer, 'targeted');
  await bridge.close();
});

test('bridge sends steer to the source tab of a tracked active request', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new BrowserBridge(hub);
  const request = bridge.sendRequest({ requestId: 'steer-request', message: 'start', sourceClientId: 'bootstrap' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  emitPromptSubmitted(hub, { requestId: 'steer-request', clientId: 'bootstrap' });
  emitTabObservation(hub, {
    requestId: 'steer-request',
    clientId: 'bootstrap',
    conversationId: 's1',
    generation: 'active',
    outputState: 'streaming',
    answer: 'partial',
    finalMessage: false,
    stableForMs: 0,
  });
  const steered = await bridge.steerRequest('steer-request', 'change direction', { timeoutMs: 5_000 });
  assert.equal(steered.requestId, 'steer-request');
  const steerCommand = hub.commands.find((entry) => entry.payload.type === 'prompt.steer');
  assert.equal(steerCommand?.clientId, 'bootstrap');
  assert.equal(steerCommand?.payload.effect?.kind, 'prompt.steer');
  assert.equal(steerCommand?.payload.effect?.retryPolicy, 'never');
  assert.match(String(steerCommand?.payload.effect?.preconditionsHash || ''), /^[a-f0-9]{64}$/);
  assert.equal(steerCommand?.options?.request?.requestId, 'steer-request');
  emitTabObservation(hub, { requestId: 'steer-request', clientId: 'bootstrap', responseEpoch: 1, conversationId: 's1', userTurnKey: 'user-steered', assistantTurnKey: 'assistant-steered', answer: 'done', session: { id: 's1' } });
  await request;
  await bridge.close();
});


test('bridge sends active-request reload with the canonical request lease identity', async () => {
  const hub = new BrowserCommandHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ requestId: 'reload-request', message: 'start', sourceClientId: 'bootstrap' }, {}, { fullResponse: true });
  await new Promise((resolve) => setImmediate(resolve));
  emitPromptSubmitted(hub, { requestId: 'reload-request', clientId: 'bootstrap' });
  emitTabObservation(hub, {
    requestId: 'reload-request', clientId: 'bootstrap', conversationId: 'reload-session',
    generation: 'active', outputState: 'streaming', answer: 'partial', finalMessage: false,
  });
  const result = await bridge.reloadBrowserTab({ sourceClientId: 'bootstrap', requestId: 'reload-request', timeoutMs: 5_000 });
  assert.equal(result.requestId, 'reload-request');
  const reload = hub.commands.find((entry) => entry.payload.type === 'browser.tab.reload');
  assert.equal(reload?.options?.request?.requestId, 'reload-request');
  assert.ok(reload?.options?.request?.leaseId);
  assert.equal(reload?.options?.request?.ownerServerInstanceId, 'server-test');
  emitTabObservation(hub, { requestId: 'reload-request', clientId: 'bootstrap', conversationId: 'reload-session', answer: 'done', session: { id: 'reload-session' } });
  await requestPromise;
  await bridge.close();
});

test('real E2E runner covers reasoning, steer, files, ZIP, project context, reuse, reports, and safe cleanup', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  const source = await readRealE2eSource();
  const liveDebugSource = await fs.readFile(path.resolve('scripts/e2e/live-debug.js'), 'utf8');
  const scenarioSource = await fs.readFile(path.resolve('scripts/e2e-scenarios.js'), 'utf8');
  const requestStateWaitSource = await fs.readFile(path.resolve('scripts/e2e/request-state-wait.js'), 'utf8');
  assert.equal(packageJson.scripts['test:e2e:real'], 'node scripts/e2e-real.js');
  assert.match(source, /process\.env\.BRIDGE_DISABLE_NOTIFICATIONS = '1'/);
  assert.match(source, /BRIDGE_DISABLE_NOTIFICATIONS: '1'/);
  assert.equal(packageJson.scripts['test:e2e:capture-dom'], `node -e "require('node:fs').rmSync('test/fixtures/chat-dom/captured/generated',{recursive:true,force:true})" && node scripts/e2e-real.js --scenario response-markdown --scenario reasoning-lifecycle --scenario zip-artifact --capture-dom-fixtures --fixture-output-dir test/fixtures/chat-dom/captured/generated`);
  assert.equal(packageJson.scripts['test:e2e:local'], 'npm run test:e2e:local:fixtures && npm run test:e2e:mock');
  assert.match(packageJson.scripts['test:e2e:local:fixtures'], /mockChatGptLayout\.test\.js/);
  assert.equal(packageJson.scripts['test:e2e:mock'], 'node scripts/e2e-real.js --mock-chatgpt --no-reload-extension');
  assert.equal(packageJson.scripts['test:e2e:response-markdown'], 'node scripts/e2e-real.js --scenario response-markdown');
  assert.equal(packageJson.scripts['test:e2e:reasoning-lifecycle'], 'node scripts/e2e-real.js --scenario reasoning-lifecycle');
  assert.equal(packageJson.scripts['test:e2e:model-effort'], 'node scripts/e2e-real.js --scenario model-effort');
  assert.equal(packageJson.scripts['test:parser-fixture'], 'node --test test/responseParserDomFixture.test.js test/responseParserBrowserFixture.test.js');
  assert.equal(packageJson.scripts['test:e2e:project'], 'node scripts/e2e-real.js --scenario project');
  assert.match(source, /--keep-session/);
  assert.match(source, /--scenario/);
  assert.match(source, /--list-scenarios/);
  assert.match(source, /options\.scenarioIds\.includes\(id\)/);
  assert.match(source, /session\.bootstrapped/);
  assert.match(source, /--strict-reasoning/);
  assert.match(source, /--capture-dom-fixtures/);
  assert.match(source, /--capture-page-layout/);
  assert.match(source, /startMockChatGptRuntime/);
  assert.match(source, /options\.mockChatGpt/);
  assert.match(source, /path\.join\(directory, 'index\.json'\)/);
  assert.match(source, /requestId: turnId/);
  assert.match(source, /--fixture-output-dir/);
  assert.match(source, /Captured sanitized DOM fixtures for offline parser\/reducer tests/);
  assert.match(source, /bootstrapWaitMs: 0/);
  assert.match(source, /findFreeLoopbackPort/);
  assert.match(source, /bridgeServerUrl: options\.baseUrl/);
  assert.match(source, /Starting isolated bridge/);
  assert.match(source, /allowSystemFallback: options\.autoOpenBrowser/);
  assert.match(source, /assert\.equal\(opened\.client\.launchToken, launchToken/);
  assert.doesNotMatch(source, /More than one new ChatGPT tab appeared/);
  assert.match(scenarioSource, /visible reasoning items, finalization and steer/);
  assert.match(scenarioSource, /response Markdown parsing/);
  assert.match(scenarioSource, /visible reasoning lifecycle/);
  assert.match(source, /raw-dom-timeline\.json/);
  assert.match(source, /parsed-timeline\.json/);
  assert.match(source, /stored-items\.json/);
  assert.match(source, /public-progress-events\.json/);
  assert.match(source, /response-parsing-diff\.json/);
  assert.match(source, /captureDomTimeline: true/);
  assert.match(source, /Browser download cleanup reported success, but the captured file still exists/);
  assert.match(source, /verifyRemovedDownloadSourcesRemainAbsent/);
  assert.match(source, /finalDownloadCleanupVerification/);
  assert.match(source, /Waiting for ChatGPT composer/);
  assert.match(source, /!candidate\.pageReady \|\| !candidate\.composerReady \|\| !candidate\.chatMainReady/);
  assert.match(source, /allowIncompatibleClient:\s*true/);
  assert.match(source, /extensionStartupReload/);
  assert.match(source, /EXTENSION_COMPATIBILITY\.minContentVersion/);
  assert.equal(packageJson.scripts['test:e2e:passive-workflow'], 'node scripts/e2e-real.js --scenario passive-workflow');
  assert.equal(packageJson.scripts['test:e2e:workflow-approval'], 'node scripts/e2e-real.js --scenario workflow-approval');
  assert.equal(packageJson.scripts['test:e2e:workflow-remediation'], 'node scripts/e2e-real.js --scenario workflow-remediation');
  assert.equal(packageJson.scripts['test:e2e:workflows'], 'node scripts/e2e-real.js --scenario workflows');
  assert.equal(packageJson.scripts['test:e2e:workflow-multi-bridge'], 'node scripts/e2e-real.js --scenario workflow-multi-bridge');
  assert.equal(packageJson.scripts['test:workflow:multi-bridge'], 'node --test test/workflowMultiBridge.integration.test.js');
  assert.equal(packageJson.scripts['workflow:worker'], 'node scripts/workflow-worker.js');
  assert.match(source, /Submitting prompt directly through the browser command without a bridge request/);
  assert.match(source, /Project remains unchanged while the verified artifact is pending approval/);
  assert.match(source, /workflow\.remediation\.response\.completed/);
  assert.match(source, /workflow-events\.json/);
  assert.match(source, /workflow-progress\.json/);
  assert.match(source, /Synchronizing one shared project context for all workflow scenarios/);
  assert.match(source, /Workflow cannot reach \${target}/);
  assert.doesNotMatch(source, /fatalTypes:/);
  assert.match(source, /successOutcomeStatuses/);
  assert.match(source, /workflowStateRevision/);
  assert.match(source, /buildPassivePromptBody\(\{ message: prompt, sessionId, sourceClientId, effort, timeoutMs: commandTimeoutMs \}\)/);
  assert.match(source, /markReportInterrupted/);
  assert.match(source, /--model/);
  assert.match(source, /--effort/);
  assert.match(source, /timeoutMs: 30_000/);
  assert.match(source, /promptTimeoutMs: 360_000/);
  assert.match(source, /resultIdleTimeoutMs: 300_000/);
  assert.match(source, /pipelineIdleTimeoutMs: 60_000/);
  assert.match(source, /workflowWaitTimeoutMs: 120_000/);
  assert.match(source, /turnMaxTimeoutMs: 360_000/);
  assert.match(source, /turnProgressSignature/);
  assert.match(source, /made no semantic/);
  assert.match(requestStateWaitSource, /result_active/);
  assert.match(source, /post-generation pipeline/);
  assert.match(source, /diagnostics\/request-state/);
  assert.match(source, /writeFailedRequestStateTrace/);
  assert.match(requestStateWaitSource, /canonicalTerminalFailure/);
  assert.match(source, /REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS/);
  assert.match(source, /--result-idle-timeout-ms/);
  assert.match(source, /--pipeline-idle-timeout-ms/);
  assert.match(source, /--turn-max-timeout-ms/);
  assert.match(source, /--prompt-timeout-ms/);
  assert.match(source, /artifactTimeoutMs: 45_000/);
  assert.match(source, /--artifact-timeout-ms/);
  assert.doesNotMatch(source, /timeoutMs: (?:90|120|300)_000/);
  assert.doesNotMatch(source, /timeoutMs: options\.timeoutMs, intervalMs: 750, message: `turn/);
  assert.match(source, /E2E_HTTP_TIMEOUT/);
  assert.match(source, /REQUIRED_ARTIFACT_SETTLE_MS: String\(Math\.min\(30_000, options\.artifactTimeoutMs\)\)/);
  assert.match(source, /model and effort selection with deterministic answer|MODEL_EFFORT_OK/);
  assert.match(source, /mustChangeModel: true/);
  assert.match(source, /mustChangeEffort: true/);
  assert.match(source, /MODEL_EFFORT_RESTORED/);
  assert.match(source, /scenarioDiagnosticDir/);
  assert.match(source, /model\.apply\.started/);
  assert.match(source, /model\.apply\.done/);
  assert.match(source, /readIntelligenceSnapshot/);
  assert.match(source, /afterState\.currentModel/);
  assert.match(source, /afterState\.currentEffort/);
  assert.match(source, /startLiveDebugTrace/);
  assert.match(liveDebugSource, /modelPickerDebugMessage/);
  assert.match(liveDebugSource, /browserDebugMessage/);
  assert.match(liveDebugSource, /compactBrowserDebugFields/);
  assert.match(liveDebugSource, /Browser diagnostic: \$\{name\}/);
  assert.match(source, /Waiting for prompt completion/);
  assert.match(source, /No terminal result yet; continuing to monitor the pipeline/);
  assert.match(source, /Looking for .* in the scoped assistant result/);
  assert.match(source, /Artifact candidates returned by the completed prompt/);
  assert.match(source, /Downloading the selected artifact/);
  assert.match(source, /FAST_EFFORT = 'instant'/);
  assert.match(source, /reasoningTestPrompt/);
  assert.match(source, /TEST_\$\{testId\}_BEGIN/);
  assert.match(source, /REASONING_PROGRESS_PERCENTAGES/);
  assert.match(liveDebugSource, /return \['retry'/);
  assert.match(source, /--no-color/);
  assert.match(source, /STEER_RESULT RED/);
  assert.match(source, /STEER_RESULT BLUE/);
  assert.match(source, /waitForSteerWindow/);
  assert.match(source, /generationObserved/);
  assert.match(source, /currentGenerationActive/);
  assert.match(source, /only in this conversation/);
  assert.match(source, /Do not add it to ChatGPT account-wide memory/);
  assert.match(source, /report\.partial\.json/);
  assert.match(source, /timeline\.partial\.ndjson/);
  assert.match(source, /path\.join\(process\.cwd\(\), '\.bridge-data', 'e2e', 'last-real-e2e'\)/);
  assert.match(scenarioSource, /multiple downloadable files/);
  assert.match(scenarioSource, /single deterministic ZIP artifact/);
  assert.match(source, /auditArtifactSourceCleanup/);
  assert.match(source, /artifact\.download\.source_removed/);
  assert.match(source, /artifact\.download\.source_cleanup_skipped/);
  assert.match(source, /The file was left untouched/);
  assert.match(source, /downloadCleanupAudits/);
  assert.match(scenarioSource, /project AGENT\.md, skill, multi-turn edit and snapshot reuse/);
  assert.match(scenarioSource, /project without AGENT\.md or skills remains functional/);
  assert.match(source, /prompt\.steer\.accepted/);
  assert.match(source, /package2\.attached === false/);
  assert.match(source, /timeline\.ndjson/);
  assert.match(source, /Diagnostic bundle/);
  assert.match(source, /sourceClientId: testClient\.id/);
  assert.match(source, /expectedUrl: sessionUrl/);
  assert.match(source, /Cleanup refused/);
  assert.doesNotMatch(packageJson.scripts.test, /e2e-real/);
});

test('real E2E aggregates scenario failures and preserves code-block DOM diagnostics', async () => {
  const source = await readRealE2eSource();
  assert.match(source, /const scenarioFailures = \[\]/);
  assert.match(source, /scenarioFailures\.push\(\{ id, name: definition\.name, error \}\)/);
  assert.match(source, /infrastructureGate\.blockedScenario\(id\)/);
  assert.match(source, /entry\.status = 'blocked'/);
  assert.match(source, /E2EScenarioAggregateError/);
  assert.match(source, /code-block-dom-context\.json/);
  assert.match(source, /diagnosticSnapshot = \[\.\.\.parserDom\]\.reverse\(\)\.find/);
  assert.match(source, /storedCodeBlockDiagnostics/);
  assert.match(source, /const validationFailures = \[\]/);
  assert.match(source, /ResponseMarkdownValidationError/);
  assert.match(source, /progressRevisionTimeline/);
  assert.match(source, /no complete 0%-100% visible progress sequence/);
  assert.match(source, /Array\.isArray\(dom\.progressItems\) \? dom\.progressItems : \[\]/);
  assert.doesNotMatch(source, /catch \(err\) \{ entry\.status = 'failed'; entry\.error = \{ message: err\.message, stack: err\.stack \}; throw err; \}/);
});

test('real E2E defers noisy bridge and debug output until startup extension confirmation is complete', async () => {
  const source = await fs.readFile(path.resolve('scripts/e2e-real.js'), 'utf8');
  const bridgeStart = source.indexOf('startBridgeIfNeeded(options, { deferConsoleOutput: true })');
  const startup = source.indexOf('prepareIsolatedE2eTab(options');
  const release = source.indexOf('releaseConsoleOutput?.()');
  const liveDebug = source.indexOf('startLiveDebugTrace(options, testLog)');
  assert(bridgeStart >= 0 && startup > bridgeStart, 'isolated bridge must start before startup tab preparation');
  assert(release > startup, 'buffered bridge output must be released after startup confirmation');
  assert(liveDebug > release, 'live debug logging must start only after startup confirmation');
});


test('response parser E2E writes a live lossless observation and strict terminal coverage reports', async () => {
  const source = await readRealE2eSource();
  assert.match(source, /parser-observation\.txt/);
  assert.match(source, /Live parser transcript:/);
  assert.match(source, /createParserObservationWriter/);
  assert.match(source, /UNKNOWN VISIBLE CONTENT/);
  assert.match(source, /FINAL TERMINAL SNAPSHOT/);
  assert.match(source, /ARTIFACT CONTENT/);
  assert.match(source, /interfaceControls/);
  assert.match(source, /parser-audit\.json/);
  assert.match(source, /terminal-dom\.html/);
  assert.match(source, /unknown-nodes\.json/);
  assert.match(source, /coveragePercent/);
  assert.match(source, /duplicateLeaves/);
  assert.doesNotMatch(source, /lost or rewrote streamed text/);
});

test('browser command correlation is registered before a synchronous extension response', async () => {
  const hub = new BrowserCommandHub();
  hub.sendToClient = function sendSynchronously(clientId, payload) {
    const client = this._clients.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`missing client ${clientId}`);
    this.commands.push({ clientId, payload });
    if (payload.type === 'passive.prompt.submit') {
      this.emit('client.message', { clientId, payload: commandResult(payload.commandId, 'passive.prompt.submitted', { submittedUserTurnKey: 'sync-turn' }) });
    }
    return client;
  };
  const bridge = new BrowserBridge(hub, null, null);
  const result = await bridge.submitPassivePrompt({ message: 'sync response', sourceClientId: 'bootstrap', timeoutMs: 1_000 });
  assert.equal(result.submittedUserTurnKey, 'sync-turn');
  await bridge.close();
});


test('real E2E cleanup settles canonical lease ownership before retrying a conflicting conversation delete', async () => {
  const source = await fs.readFile(path.resolve('scripts/e2e-real.js'), 'utf8');
  assert.match(source, /leaseConflict = \/Browser lease belongs to another request or server instance/);
  assert.match(source, /await quiesceBrowserWork\(\{/);
  assert.match(source, /sourceClientId,/);
});
