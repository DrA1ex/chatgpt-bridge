import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EXTENSION_COMPATIBILITY,
  compareVersions,
  evaluateExtensionCompatibility,
} from '../src/extensionCompatibility.js';
import { TampermonkeyHub } from '../src/tampermonkeyHub.js';

test('extension compatibility uses semantic version comparison', () => {
  assert.equal(compareVersions('0.3.0', '0.2.10'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0', '0.2.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('invalid', '0.3.0'), null);
});

test('current extension is compatible and previous v55 runtime is blocked', () => {
  const current = evaluateExtensionCompatibility({
    runtime: 'extension',
    extensionProtocolVersion: EXTENSION_COMPATIBILITY.protocolVersion,
    extensionVersion: EXTENSION_COMPATIBILITY.recommendedExtensionVersion,
    clientVersion: EXTENSION_COMPATIBILITY.minContentVersion,
  });
  assert.equal(current.compatible, true);
  assert.equal(current.status, 'compatible');

  const previous = evaluateExtensionCompatibility({
    runtime: 'extension',
    protocolVersion: 2,
    clientVersion: '2.7.1',
  });
  assert.equal(previous.compatible, false);
  assert.equal(previous.status, 'extension_outdated');
  assert.match(previous.message, /Reload extension 0\.3\.0 or newer/i);
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

test('hub keeps incompatible extension visible in diagnostics but excludes it from active selection', () => {
  const hub = new TampermonkeyHub();
  const client = hub.registerPollingClient({
    type: 'hello',
    runtime: 'extension',
    clientId: 'outdated-tab',
    url: 'https://chatgpt.com/c/test',
    protocolVersion: 2,
    clientVersion: '2.7.1',
  });
  assert.equal(client.compatible, false);
  assert.equal(client.compatibility.status, 'extension_outdated');
  assert.equal(hub.activeClient, null);
  assert.throws(() => hub.selectClient('outdated-tab'), /incompatible/i);
  hub.close();
});

test('extension handshake reports manifest/content versions and background surfaces compatibility errors', async () => {
  const content = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  assert.match(content, /extensionVersion: EXTENSION_VERSION/);
  assert.match(content, /extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION/);
  assert.match(content, /applyCompatibilityStatus/);
  assert.match(content, /extension update required/);
  assert.match(background, /payload\.type === 'extension\.status' \|\| payload\.type === 'extension\.compatibility'/);
  assert.match(background, /type: 'extension\.status'/);
});
