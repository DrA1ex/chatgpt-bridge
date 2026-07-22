import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadArtifactTransfer() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/artifactTransfer.js'), 'utf8');
  const context = {
    URL,
    Blob,
    Response,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    location: new URL('https://chatgpt.com/c/session-test'),
    document: { body: {} },
    fetch: async () => { throw new Error('page fetch should not run'); },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout,
    clearTimeout,
    console,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'artifactTransfer.js' });
  return context.ChatGptArtifactTransfer;
}

test('artifact transfer starts an exact HTTPS download through the background without clicking the same-tab anchor', async () => {
  const factory = await loadArtifactTransfer();
  const root = {};
  const url = 'https://chatgpt.com/backend-api/estuary/content?id=file-test&fn=workflow-fixed.zip&cd=attachment';
  let clicks = 0;
  const anchor = {
    href: url,
    getAttribute(name) { return name === 'href' ? url : null; },
    matches(selector) { return selector === 'a[href]'; },
    closest(selector) { return selector === 'a[href]' ? this : null; },
    click() { clicks += 1; },
  };
  const requests = [];
  const sent = [];
  let resolveDownload;
  const download = new Promise((resolve) => { resolveDownload = resolve; });
  const transfer = factory.createArtifactTransfer({
    CONFIG: { artifactDownloadTimeoutMs: 15_000, artifactChunkSize: 1024 },
    DOM_PARSER: {
      selectArtifactActionCandidate() {
        return { ok: true, index: 0, score: 500, exactName: true, locatorIdentity: true };
      },
      shouldWaitForLateArtifactPreview() { return false; },
    },
    EXTENSION_API: {},
    async armPageArtifactCapture() {
      return { captureId: 'page-capture', wait: new Promise(() => {}), cancel() {}, addExpectedNames() {} };
    },
    artifactFileName() { return 'workflow-fixed.zip'; },
    artifactLocatorMeta() {
      return { blockStart: 0, blockEnd: 1, blockTestId: 'artifact-card', actionOrdinal: 0, actionTag: 'a', actionRole: '', actionTestId: '', actionAriaLabel: '' };
    },
    async closeArtifactPreview() {},
    async closeVisibleArtifactPreviewsBeforeAction() {},
    collectArtifactsFromNode() { return []; },
    async delay() {},
    diagnostic() {},
    async enqueueArtifactAction(fn) { return await fn(); },
    async extensionRequest(type, payload) {
      requests.push({ type, payload });
      if (type === 'bridge.download.capture.begin') return { captureId: 'download-capture' };
      if (type === 'bridge.download.capture.wait') return await download;
      if (type === 'bridge.download.capture.activate') {
        return { captureId: 'download-capture', actionActivationId: 'activation-1', actionActivatedAt: Date.now() };
      }
      if (type === 'bridge.download.capture.start') {
        assert.equal(payload.url, url);
        resolveDownload({
          id: 41,
          filename: '/Downloads/workflow-fixed.zip',
          name: 'workflow-fixed.zip',
          state: 'complete',
          fileSize: 512,
          expectedNames: ['workflow-fixed.zip'],
        });
        return { captureId: 'download-capture', downloadId: 41, bound: true };
      }
      if (type === 'bridge.download.capture.release') return { captureId: 'download-capture', bound: false, cancelled: true };
      if (type === 'bridge.download.capture.cancel') return { captureId: 'download-capture', cancelled: true };
      throw new Error(`Unexpected extension request: ${type}`);
    },
    findTurnByKey() { return root; },
    getExtensionPort() { return {}; },
    guessMime() { return 'application/zip'; },
    guessNameFromUrl() { return 'workflow-fixed.zip'; },
    isBrowserOnlyArtifactUrl() { return true; },
    isCurrentPageNavigationUrl(candidate) { return candidate === 'https://chatgpt.com/c/session-test'; },
    isExcludedArtifactAction() { return false; },
    isUsableButton() { return true; },
    isVisible() { return true; },
    materializeArtifactPreview() { return new Promise(() => {}); },
    normalizeComparable(value) { return String(value || '').trim().toLowerCase(); },
    queryAllWithSelf(_node, selector) { return selector === 'button, [role="button"], a[href]' ? [anchor] : []; },
    send(payload) { sent.push(payload); },
    visibleArtifactPreviewContainers() { return []; },
    async waitForLateArtifactPreview() { return null; },
  });

  await transfer.handleArtifactFetch({
    commandId: 'artifact-command',
    artifact: {
      id: 'artifact-direct-download',
      kind: 'action',
      name: 'workflow-fixed.zip',
      sourceTurnKey: 'assistant-turn',
    },
  });

  assert.equal(clicks, 0);
  assert.ok(requests.some((entry) => entry.type === 'bridge.download.capture.start'));
  const done = sent.find((entry) => entry.type === 'artifact.data.done');
  assert.equal(done?.filePath, '/Downloads/workflow-fixed.zip');
  assert.equal(done?.captureSource, 'chrome-downloads');
  assert.equal(sent.some((entry) => entry.type === 'command.error'), false);
});
