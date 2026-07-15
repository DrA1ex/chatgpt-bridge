import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function createTransfer() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/artifactTransfer.js'), 'utf8');
  const context = vm.createContext({
    console,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob,
    URL,
    atob,
    btoa,
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'artifactTransfer.js' });
  return context.ChatGptArtifactTransfer.createArtifactTransfer({
    guessNameFromUrl(url = '') { return String(url).split('/').pop() || ''; },
    isBrowserOnlyArtifactUrl() { return false; },
    isCurrentPageNavigationUrl() { return false; },
  });
}

function bytes(...values) {
  return new Uint8Array(values);
}

test('artifact transfer rejects HTML and arbitrary bytes masquerading as ZIP', async () => {
  const transfer = await createTransfer();
  const html = new TextEncoder().encode('<!doctype html><html><body>not a zip</body></html>');
  assert.throws(
    () => transfer.validateArtifactBytes(html, { name: 'result.zip', mime: 'application/octet-stream' }, 'https://chatgpt.com/download'),
    /invalid ZIP bytes|HTML\/JSON instead of binary content/,
  );
  assert.throws(
    () => transfer.validateArtifactBytes(bytes(1, 2, 3, 4), { name: 'result.zip' }),
    /invalid ZIP bytes/,
  );
});

test('artifact transfer accepts standard ZIP signatures', async () => {
  const transfer = await createTransfer();
  for (const signature of [
    bytes(0x50, 0x4b, 0x03, 0x04, 1),
    bytes(0x50, 0x4b, 0x05, 0x06, 0),
    bytes(0x50, 0x4b, 0x07, 0x08, 1),
  ]) {
    assert.doesNotThrow(() => transfer.validateArtifactBytes(signature, { name: 'result.zip' }));
  }
});

test('artifact transfer infers ZIP intent from an action label even without a ZIP filename', async () => {
  const transfer = await createTransfer();
  assert.throws(
    () => transfer.validateArtifactBytes(bytes(1, 2, 3, 4), {
      name: 'conversation-id',
      mime: 'text/html; charset=utf-8',
      actionLabel: 'Download the complete updated project ZIP',
    }),
    /invalid ZIP bytes/,
  );
});
