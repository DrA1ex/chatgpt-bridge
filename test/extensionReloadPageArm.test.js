import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function makeWindow() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    postMessage(data) {
      for (const fn of [...(listeners.get('message') || [])]) fn({ source: this, data });
      if (data?.type === 'page.reload.arm') {
        const ack = {
          source: 'chatgpt-browser-bridge-artifact-main-v1',
          type: 'page.reload.armed',
          reloadId: data.reloadId,
          delayMs: data.delayMs,
        };
        for (const fn of [...(listeners.get('message') || [])]) fn({ source: this, data: ack });
      }
    },
  };
}

test('content runtime arms a page-owned reload before restarting the extension', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  const window = makeWindow();
  const timers = [];
  const sent = [];
  const extensionRequests = [];
  const context = vm.createContext({
    globalThis: null,
    window,
    location: new URL('https://chatgpt.com/'),
    document: { title: 'ChatGPT', querySelectorAll() { return []; } },
    URL,
    Date,
    Math,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'sessionCommands.js' });
  const commands = context.ChatGptSessionCommands.createSessionCommands({
    CONFIG: { serverUrl: 'http://127.0.0.1:18181', token: '' },
    CONTENT_SCRIPT_VERSION: '3.0.19',
    EXTENSION_VERSION: '1.0.19',
    safeLaunchBridgeServerUrl(value) { return value; },
    stageTemporaryConnectionOverride() { return { staged: true, reason: 'differs_from_saved', serverUrl: 'http://127.0.0.1:18181' }; },
    send(payload) { sent.push(payload); },
    diagnostic() {},
    async extensionRequest(type, payload) { extensionRequests.push({ type, payload }); return { scheduled: true }; },
  });

  await commands.handleExtensionReload({
    commandId: 'reload-command', reloadTabs: true,
    expectedVersion: '1.0.19', connection: { serverUrl: 'http://127.0.0.1:18181' },
  });

  const accepted = sent.find((payload) => payload.type === 'extension.reload.accepted');
  assert.ok(accepted);
  assert.equal(accepted.pageReload.armed, true);
  assert.equal(accepted.pageReload.delayMs, 900);
  const dispatchTimer = timers.find((timer) => timer.delay === 40);
  assert.ok(dispatchTimer);
  await dispatchTimer.fn();
  assert.equal(extensionRequests.length, 1);
  assert.equal(extensionRequests[0].type, 'bridge.extension.reload');
  assert.equal(extensionRequests[0].payload.reloadTabs, true);
  assert.equal(extensionRequests[0].payload.expectedVersion, '1.0.19');
});
