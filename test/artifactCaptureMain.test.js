import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function makeWindow() {
  const listeners = new Map();
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage(data) {
      for (const fn of listeners.get('message') || []) fn({ source: window, data });
    },
    open(url) { return { url }; },
  };
  return window;
}

test('main-world artifact capture returns generated Blob bytes and suppresses duplicate browser download', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactCaptureMain.js'), 'utf8');
  const window = makeWindow();
  const messages = [];
  window.addEventListener('message', (event) => messages.push(event.data));

  class FakeAnchor {
    constructor() {
      this.href = '';
      this.download = '';
      this.textContent = '';
      this.originalClicks = 0;
    }
    getAttribute(name) { return this[name] || ''; }
    click() { this.originalClicks += 1; }
  }

  const document = {
    addEventListener() {},
  };
  let objectUrlCounter = 0;
  const URLObject = {
    createObjectURL() { objectUrlCounter += 1; return `blob:test-${objectUrlCounter}`; },
    revokeObjectURL() {},
  };
  const context = vm.createContext({
    window,
    document,
    HTMLAnchorElement: FakeAnchor,
    URL: URLObject,
    Blob,
    Date,
    console,
  });
  vm.runInContext(source, context, { filename: 'artifactCaptureMain.js' });

  window.postMessage({
    source: 'chatgpt-browser-bridge-artifact-content-v1',
    type: 'artifact.capture.arm',
    captureId: 'capture-1',
    expectedName: 'report.csv',
    timeoutMs: 10_000,
  });
  assert.ok(messages.some((message) => message.type === 'artifact.capture.armed' && message.captureId === 'capture-1'));

  const unrelatedBlob = new Blob(['not the requested file'], { type: 'text/plain' });
  const unrelatedUrl = context.URL.createObjectURL(unrelatedBlob);
  const unrelatedAnchor = new context.HTMLAnchorElement();
  unrelatedAnchor.href = unrelatedUrl;
  unrelatedAnchor.download = 'unrelated.txt';
  unrelatedAnchor.click();
  assert.equal(unrelatedAnchor.originalClicks, 1, 'An unrelated Blob download must not be suppressed');
  assert.equal(messages.some((message) => message.type === 'artifact.capture.candidate' && message.url === unrelatedUrl), false);

  const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
  const url = context.URL.createObjectURL(blob);
  assert.equal(messages.some((message) => message.type === 'artifact.capture.candidate' && message.url === url), false, 'Blob creation alone is not enough to bind the artifact');

  const anchor = new context.HTMLAnchorElement();
  anchor.href = url;
  anchor.download = 'report.csv';
  anchor.click();

  const generated = messages.find((message) => message.type === 'artifact.capture.candidate' && message.captureId === 'capture-1' && message.url === url);
  assert.ok(generated);
  assert.equal(generated.downloadName, 'report.csv');
  assert.equal(generated.blob.size, blob.size);
  assert.equal(anchor.originalClicks, 0, 'Matched Blob download should be captured without polluting Downloads');
});
