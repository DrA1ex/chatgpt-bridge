import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EXTENSION_COMPATIBILITY,
  compareVersions,
  evaluateExtensionCompatibility,
} from '../src/extensionCompatibility.js';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { connectExtensionClient } from './helpers/extensionClient.js';

async function readExtensionContentRuntime() {
  const root = path.resolve('tools/chrome-bridge-extension');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  return (await Promise.all(manifest.content_scripts[1].js.map((file) => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
}

test('extension compatibility uses semantic version comparison', () => {
  assert.equal(compareVersions('0.3.0', '0.2.10'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.2.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('invalid', '0.3.0'), null);
});

test('current extension is compatible and unsupported older runtimes are blocked', () => {
  const current = evaluateExtensionCompatibility({
    runtime: 'extension',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.protocolVersion,
    extensionVersion: EXTENSION_COMPATIBILITY.recommendedExtensionVersion,
    clientVersion: EXTENSION_COMPATIBILITY.minContentVersion,
  });
  assert.equal(current.compatible, true);
  assert.equal(current.status, 'compatible');

  const previousPatch = evaluateExtensionCompatibility({
    runtime: 'extension',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.protocolVersion,
    extensionVersion: '2.0.1',
    clientVersion: '4.0.1',
  });
  assert.equal(previousPatch.compatible, false);
  assert.equal(previousPatch.status, 'extension_outdated');

  const previous = evaluateExtensionCompatibility({
    runtime: 'extension',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.minProtocolVersion - 1,
    extensionVersion: '0.7.0',
    clientVersion: '2.16.0',
  });
  assert.equal(previous.compatible, false);
  assert.equal(previous.status, 'extension_outdated');
  assert.match(previous.message, new RegExp(`Reload extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion.replaceAll('.', '\\.')}`,'i'));
});

test('newer unsupported extension protocol tells the user to update the bridge', () => {
  const result = evaluateExtensionCompatibility({
    runtime: 'extension',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.maxProtocolVersion + 1,
    extensionVersion: '0.3.0',
    clientVersion: '3.0.0',
  });
  assert.equal(result.compatible, false);
  assert.equal(result.status, 'bridge_outdated');
  assert.match(result.message, /Update ChatGPT Browser Bridge/i);
});

test('hub keeps incompatible older extensions visible in diagnostics but excludes them from active selection', async () => {
  const hub = new BrowserExtensionHub();
  const connection = await connectExtensionClient(hub, {
    clientId: 'outdated-tab',
    url: 'https://chatgpt.com/c/test',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.minProtocolVersion - 1,
    extensionVersion: '0.7.0',
    clientVersion: '2.16.0',
  });
  try {
    const client = hub.clients.find((item) => item.id === 'outdated-tab');
    assert.equal(client.compatible, false);
    assert.equal(client.compatibility.status, 'extension_outdated');
    assert.equal(hub.activeClient, null);
    assert.throws(() => hub.selectClient('outdated-tab'), /incompatible/i);
  } finally {
    await connection.close();
  }
});

test('extension handshake reports manifest/content versions and background surfaces compatibility errors', async () => {
  const content = await readExtensionContentRuntime();
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  assert.match(content, /extensionVersion: EXTENSION_VERSION/);
  assert.match(content, /extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION/);
  assert.match(content, /applyCompatibilityStatus/);
  assert.match(content, /extension update required/);
  assert.match(background, /payload\.type === 'extension\.status' \|\| payload\.type === 'extension\.compatibility'/);
  assert.match(background, /type: 'extension\.status'/);
});
