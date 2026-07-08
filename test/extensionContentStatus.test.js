import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('extension panel status classification does not treat disconnected/reconnecting text as connected', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function isPanelOkStatus\(status\)/);
  assert.match(source, /isPanelOkStatus\(panelState\.status\)/);
  assert.doesNotMatch(source, /\/connected\|reachable\/i\.test\(panelState\.status\)/);
  assert.doesNotMatch(source, /\/connected\/i\.test\(status\)/);
});

test('extension Test button validates BRIDGE_TOKEN, not only setup reachability', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function authCheckUrl\(/);
  assert.match(source, /\/tm\/auth\/check/);
  assert.match(source, /bridgeTokenAccepted/);
  assert.match(source, /setup\/token test failed/);
});
