import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function makeHarness() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const messages = [];
  const timers = [];
  let reloads = 0;
  let objectUrlCounter = 0;
  let revokeCalls = 0;

  const window = {
    location: { reload() { reloads += 1; }, href: 'https://chatgpt.com/' },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type) || [];
      windowListeners.set(type, list.filter((item) => item !== fn));
    },
    postMessage(data) {
      messages.push(data);
      for (const fn of windowListeners.get('message') || []) fn({ source: window, data });
    },
    open(url) { return { url }; },
  };
  class FakeAnchor {
    constructor() { this.href = ''; this.download = ''; this.textContent = ''; this.originalClicks = 0; }
    getAttribute(name) { return this[name] || ''; }
    click() { this.originalClicks += 1; }
  }
  const document = {
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type) || [];
      documentListeners.set(type, list.filter((item) => item !== fn));
    },
  };
  const URLObject = {
    createObjectURL() { objectUrlCounter += 1; return `blob:test-${objectUrlCounter}`; },
    revokeObjectURL() { revokeCalls += 1; },
  };
  const originals = {
    anchorClick: FakeAnchor.prototype.click,
    createObjectURL: URLObject.createObjectURL,
    revokeObjectURL: URLObject.revokeObjectURL,
    open: window.open,
  };
  const context = vm.createContext({
    window,
    document,
    HTMLAnchorElement: FakeAnchor,
    URL: URLObject,
    Blob,
    Date,
    console,
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  return {
    context, window, document, messages, timers, originals,
    get reloads() { return reloads; },
    get revokeCalls() { return revokeCalls; },
  };
}

async function loadHarness() {
  const harness = makeHarness();
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactCaptureMain.js'), 'utf8');
  vm.runInContext(source, harness.context, { filename: 'artifactCaptureMain.js' });
  return harness;
}

test('main-world artifact bridge leaves Blob URLs, clicks, and window.open untouched while no capture is armed', async () => {
  const harness = await loadHarness();
  const { context, originals } = harness;
  assert.equal(context.HTMLAnchorElement.prototype.click, originals.anchorClick);
  assert.equal(context.URL.createObjectURL, originals.createObjectURL);
  assert.equal(context.URL.revokeObjectURL, originals.revokeObjectURL);
  assert.equal(context.window.open, originals.open);

  const audio = new Blob(['voice bytes'], { type: 'audio/webm' });
  const url = context.URL.createObjectURL(audio);
  context.URL.revokeObjectURL(url);
  const anchor = new context.HTMLAnchorElement();
  anchor.href = url;
  anchor.click();
  assert.equal(anchor.originalClicks, 1);
  assert.equal(harness.revokeCalls, 1, 'Voice-recording Blob URLs must be revoked by ChatGPT normally');
  assert.equal(harness.messages.some((message) => message.type === 'artifact.capture.candidate'), false);
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), false);
});

test('armed artifact capture returns generated Blob bytes, suppresses only the matched download, then restores page APIs', async () => {
  const harness = await loadHarness();
  const { context, window, originals, messages } = harness;
  window.postMessage({
    source: 'chatgpt-browser-bridge-artifact-content-v1',
    type: 'artifact.capture.arm',
    captureId: 'capture-1',
    expectedName: 'report.csv',
    timeoutMs: 10_000,
  });
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), true);
  assert.notEqual(context.URL.createObjectURL, originals.createObjectURL);
  assert.equal(context.URL.revokeObjectURL, originals.revokeObjectURL, 'revokeObjectURL must never be monkeypatched');

  const unrelatedBlob = new Blob(['not requested'], { type: 'text/plain' });
  const unrelatedUrl = context.URL.createObjectURL(unrelatedBlob);
  const unrelatedAnchor = new context.HTMLAnchorElement();
  unrelatedAnchor.href = unrelatedUrl;
  unrelatedAnchor.download = 'unrelated.txt';
  unrelatedAnchor.click();
  assert.equal(unrelatedAnchor.originalClicks, 1);

  const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
  const url = context.URL.createObjectURL(blob);
  context.URL.revokeObjectURL(url);
  const anchor = new context.HTMLAnchorElement();
  anchor.href = url;
  anchor.download = 'report.csv';
  anchor.click();

  const generated = messages.find((message) => message.type === 'artifact.capture.candidate' && message.captureId === 'capture-1');
  assert.ok(generated);
  assert.equal(generated.blob.size, blob.size);
  assert.equal(anchor.originalClicks, 0);
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.activeCaptureCount(), 0);
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), false);
  assert.equal(context.HTMLAnchorElement.prototype.click, originals.anchorClick);
  assert.equal(context.URL.createObjectURL, originals.createObjectURL);
  assert.equal(context.window.open, originals.open);
  assert.equal(harness.revokeCalls, 1);
});

test('artifact capture cancellation and expiry restore temporary page hooks', async () => {
  const harness = await loadHarness();
  const { context, window, timers } = harness;
  window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'artifact.capture.arm', captureId: 'cancel-me', timeoutMs: 5_000 });
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), true);
  window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'artifact.capture.cancel', captureId: 'cancel-me' });
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), false);

  window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'artifact.capture.arm', captureId: 'expire-me', timeoutMs: 5_000 });
  const timer = timers.at(-1);
  timer.fn();
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.activeCaptureCount(), 0);
  assert.equal(context.window.__chatgptBridgeArtifactCaptureMainV1.hooksInstalled(), false);
});

test('main-world artifact capture accepts a preview display-title alias added before download', async () => {
  const harness = await loadHarness();
  const { context, window, messages } = harness;
  window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'artifact.capture.arm', captureId: 'capture-alias', expectedName: 'project-result.zip', timeoutMs: 10_000 });
  window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'artifact.capture.expect', captureId: 'capture-alias', expectedNames: ['Release bundle.zip'] });
  const blob = new Blob(['zip bytes'], { type: 'application/zip' });
  const url = context.URL.createObjectURL(blob);
  const anchor = new context.HTMLAnchorElement();
  anchor.href = url;
  anchor.download = 'Release bundle.zip';
  anchor.click();
  const generated = messages.find((message) => message.type === 'artifact.capture.candidate' && message.captureId === 'capture-alias');
  assert.ok(generated);
  assert.equal(generated.downloadName, 'Release bundle.zip');
  assert.equal(anchor.originalClicks, 0);
});

test('main-world bridge arms a page-owned reload that survives extension runtime teardown', async () => {
  const harness = await loadHarness();
  harness.window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'page.reload.arm', reloadId: 'reload-1', delayMs: 900 });
  const armed = harness.messages.find((message) => message.type === 'page.reload.armed' && message.reloadId === 'reload-1');
  assert.ok(armed);
  assert.equal(armed.delayMs, 900);
  const timer = harness.timers.find((entry) => entry.delay === 900);
  timer.fn();
  assert.equal(harness.reloads, 1);
});

test('main-world bridge preserves the 12 second extension-reload fallback delay', async () => {
  const harness = await loadHarness();
  harness.window.postMessage({ source: 'chatgpt-browser-bridge-artifact-content-v1', type: 'page.reload.arm', reloadId: 'reload-12s', delayMs: 12_000 });
  const armed = harness.messages.find((message) => message.type === 'page.reload.armed' && message.reloadId === 'reload-12s');
  assert.ok(armed);
  assert.equal(armed.delayMs, 12_000);
  const timer = harness.timers.find((entry) => entry.delay === 12_000);
  assert.ok(timer);
});

test('artifact main source never overrides URL.revokeObjectURL', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactCaptureMain.js'), 'utf8');
  assert.doesNotMatch(source, /URL\.revokeObjectURL\s*=/);
  assert.match(source, /function installHooks/);
  assert.match(source, /function uninstallHooksIfIdle/);
});
