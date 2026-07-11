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
  assert.match(source, /connection test failed/);
});

test('Chrome extension manifest version is incremented after extension updates', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.4');
});

test('extension content script metadata and runtime instance marker use the same version', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const metadataVersion = source.match(/@version\s+([^\s]+)/)?.[1] || '';
  const declaredVersion = source.match(/const CONTENT_SCRIPT_VERSION = '([^']+)'/)?.[1] || '';
  assert.equal(metadataVersion, '2.8.4');
  assert.equal(declaredVersion, metadataVersion);
  assert.match(source, /unsafeWindow\[INSTANCE_KEY\] = \{ version: CONTENT_SCRIPT_VERSION/);
});

test('extension separates visible progress text from downloadable artifacts', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /readAssistantVisibleBlocks/);
  assert.match(source, /assistant\.progress\.snapshot/);
  assert.match(source, /isZipLikeLabel/);
  assert.match(source, /artifactActionSignal/);
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


test('extension extracts visible reasoning/action-status steps as progress items', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function readAssistantVisibleBlocks\(/);
  assert.match(source, /function readVisibleBlock\(/);
  assert.match(source, /DOM_PARSER\.groupVisibleBlocks/);
  assert.match(source, /progressItems/);
  assert.match(source, /items: snapshot\.progressItems \|\| \[\]/);
  assert.match(source, /tool_status/);
  assert.match(source, /action_status/);
  assert.match(source, /collectExplicitThinkingCandidates/);
  assert.match(source, /loading-shimmer-tertiary/);
  assert.match(source, /text-token-text-tertiary/);
  assert.match(source, /reconcileThinkingCandidates/);
});


test('extension uses layered scoped artifact materialization for button-only generated files', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const mainSource = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactCaptureMain.js'), 'utf8');
  assert.match(source, /DOM_PARSER\.extractFileLikeName/);
  assert.match(source, /classifyArtifactPhase/);
  assert.match(source, /armPageArtifactCapture/);
  assert.match(source, /Promise\.any\(attempts\)/);
  assert.match(source, /bridge\.download\.capture\.cancel/);
  assert.match(source, /artifactActionCandidateScore/);
  assert.match(mainSource, /URL\.createObjectURL/);
  assert.match(mainSource, /HTMLAnchorElement\.prototype\.click/);
  assert.match(mainSource, /if \(safelyCaptured\) return undefined/);
});


test('extension settings UI is onboarding-first, hides raw diagnostics, and has no old vertical tab stripe', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /Connect this ChatGPT tab/);
  assert.match(source, /Open setup guide/);
  assert.match(source, /<details id="cgb-advanced">/);
  assert.match(source, /Advanced & diagnostics/);
  assert.match(source, /function panelStatusView\(/);
  assert.doesNotMatch(source, /#cgb-tab::before/);
  assert.match(source, /#cgb-mark/);
  assert.match(source, /#cgb-launcher\{[^}]*translateX\(calc\(100% - 38px\)\)/);
  assert.match(source, /#cgb-launcher:hover,#cgb-launcher:focus-within,#chatgpt-bridge-panel-root\.cgb-open #cgb-launcher/);
  assert.match(source, /#cgb-label\{[^}]*opacity:0[^}]*visibility:hidden/);
  assert.match(source, /#cgb-mark[^}]*position:relative/);
  assert.match(source, /#cgb-dot\{position:absolute/);
  assert.match(source, /ChatGPT Bridge: \$\{view\.title\}\. Open settings/);
  assert.match(source, /aria-expanded=\"false\"/);
  assert.match(source, /function setFloatingPanelOpen\(open\)/);
  assert.match(source, /event\.key === 'Escape'/);
});

test('floating extension button is mounted only on ChatGPT conversation routes', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function isChatConversationUrl\(/);
  assert.match(source, /\^\\\/c\\\/\[\^\/\]\+\$/);
  assert.match(source, /\^\\\/g\\\/\[\^\/\]\+/);
  assert.match(source, /if \(!isChatConversationUrl\(\)\) return;/);
  assert.match(source, /root\?\.remove\(\)/);
  assert.match(source, /syncFloatingPanelVisibility/);
});


test('extension waits for required ZIP artifacts and tracks artifact readiness changes', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function requiredArtifactPending\(/);
  assert.match(source, /artifact\.required_wait_started/);
  assert.match(source, /requiredArtifactSettleMs/);
  assert.match(source, /artifact\.downloadActionPresent \? 'action' : ''/);
  assert.match(source, /request\.stableSince = now;\n\s+request\.lastSnapshotChangedAt = now;/);
  assert.match(source, /snapshotTerminalForRequest/);
  assert.match(source, /lastProgressItemsFingerprint/);
  assert.match(source, /progressItemsFingerprint/);
});


test('extension exposes finalizing and immediately resyncs active requests on foreground return', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /status: 'finalizing'/);
  assert.doesNotMatch(source, /status: 'idle'/);
  assert.match(source, /function handleForegroundResync\(/);
  assert.match(source, /request\.foreground_resync/);
  assert.match(source, /scheduleCollect\(activeRequest, reason, 0\)/);
  assert.match(source, /window\.addEventListener\('pageshow'/);
});
