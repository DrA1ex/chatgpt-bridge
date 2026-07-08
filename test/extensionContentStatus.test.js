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

test('Chrome extension manifest version is incremented after extension updates', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.5');
});

test('extension separates visible progress text from downloadable artifacts', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /collectVisibleProgressForAssistantNode/);
  assert.match(source, /assistant\.progress\.snapshot/);
  assert.match(source, /isZipLikeLabel/);
  assert.match(source, /looksLikeDownloadableAction/);
  assert.match(source, /hasStrictArtifactIntent/);
  assert.match(source, /looksLikeThinkingProgressText/);
  assert.doesNotMatch(source, /\\bzip\\b\|архив\/\.test\(source\)/);
});


test('extension finalization gate treats Steer/continuation UI as non-terminal', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function findSteerControl\(/);
  assert.match(source, /function findSendButton\(/);
  assert.match(source, /function findRegenerateButton\(/);
  assert.match(source, /function findContinueButton\(/);
  assert.match(source, /function readFinalizationSignals\(/);
  assert.match(source, /shouldDeferFinalizationForSteer/);
  assert.match(source, /generation\.steer_available/);
  assert.match(source, /steer_available/);
  assert.match(source, /continuation_wait/);
  assert.match(source, /generation\.steer_wait/);
  assert.match(source, /finalizationConfidence/);
  assert.match(source, /terminalMarkerVisible/);
  assert.match(source, /regenerateButtonVisible/);
});


test('extension coalesces active-request DOM collection and scopes Steer finalization controls', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function scheduleCollect\(/);
  assert.match(source, /collectScheduled/);
  assert.match(source, /collecting/);
  assert.match(source, /function finalizationControlRoots\(/);
  assert.match(source, /function findComposerRootStrict\(/);
  assert.match(source, /function scopedQueryAll\(/);
  assert.match(source, /findSteerControl\(roots = finalizationControlRoots\(activeRequest\)\)/);
  assert.doesNotMatch(source, /querySelectorAll\('textarea, \[contenteditable="true"\], input, button, \[role="button"\], \[aria-label\], \[placeholder\], \[data-testid\]'\)/);
});
