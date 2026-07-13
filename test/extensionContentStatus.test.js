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
  assert.equal(manifest.version, '0.4.16');
});

test('extension content script metadata and runtime instance marker use the same version', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const metadataVersion = source.match(/@version\s+([^\s]+)/)?.[1] || '';
  const declaredVersion = source.match(/const CONTENT_SCRIPT_VERSION = '([^']+)'/)?.[1] || '';
  assert.equal(metadataVersion, '2.12.15');
  assert.equal(declaredVersion, metadataVersion);
  assert.match(source, /unsafeWindow\[INSTANCE_KEY\] = \{ version: CONTENT_SCRIPT_VERSION/);
});


test('extension arms DOM turn capture only at the exact prompt submission boundary', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const baselineIndex = source.indexOf('request.pendingSubmittedTurnBaseline = submissionBaseline');
  const armIndex = source.indexOf('request.turnCaptureArmed = true');
  const submitIndex = source.indexOf("await enterPrompt(message, request, { kind: 'prompt' })");
  assert.ok(baselineIndex >= 0 && armIndex > baselineIndex && submitIndex > armIndex);
  assert.match(source, /prompt\.turn_boundary\.armed/);
  assert.match(source, /if \(!request\.turnCaptureArmed\) return;/);
  assert.match(source, /await waitForSubmittedUserTurnAnchor\(request, submissionBaseline/);
  assert.match(source, /already_captured_by_dom_monitor/);
  assert.match(source, /if \(!key \|\| baseline\.has\(key\)\) return null/);
  assert.match(source, /if \(!request \|\| !request\.turnCaptureArmed\) return;/);
});


test('extension uses the configured short post-stop settle windows instead of a hidden 2.5 second floor', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /postStopTerminalSettleMs: 900/);
  assert.match(source, /const doneSettleMs = Math\.max\(300,/);
  assert.match(source, /const terminalSettleMs = Math\.max\(500,/);
  assert.doesNotMatch(source, /postStopTerminalSettleMs: 2_500/);
});



test('extension waits for stable ChatGPT readiness and retries unconfirmed prompt submissions', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /pageReadyTimeoutMs: 45_000/);
  assert.match(source, /promptSubmitRetries: 3/);
  assert.match(source, /function chatPageReadiness\(/);
  assert.match(source, /async function waitForChatPageReady\(/);
  assert.match(source, /async function waitForPromptSubmissionEvidence\(/);
  assert.match(source, /prompt\.submit\.retry/);
  assert.match(source, /PROMPT_SUBMIT_NOT_CONFIRMED/);
  assert.match(source, /startPageReadinessMonitor\(\)/);
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


test('extension ignores generic closed controls when scanning artifact lifecycle state', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const core = await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8');
  assert.match(source, /isArtifactLifecycleStateDescriptor/);
  assert.match(source, /isExcludedArtifactAction\(element\)/);
  assert.match(source, /lifecycleObserved: true/);
  assert.match(source, /artifact\.nonblocking_candidates_ignored/);
  assert.match(core, /function artifactBlocksCompletion/);
  assert.match(core, /phase === 'READY' \|\| phase === 'FAILED'/);
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


test('extension session cleanup is URL-bound and uses stable non-localized DOM identity', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /verifySessionDeletionTarget/);
  assert.match(source, /expectedSessionId/);
  assert.match(source, /expectedUrl/);
  assert.match(source, /data-testid=\"delete-chat-menu-item\"/);
  assert.match(source, /menuOwnedByTrigger/);
  assert.match(source, /menusBeforeOpen = new Set\(visibleMenus\(\)\)/);
  assert.match(source, /!menusBeforeOpen\.has\(menu\)/);
  assert.match(source, /dialogsBeforeDelete = new Set\(visibleModalDialogs\(\)\)/);
  assert.match(source, /single_destructive_button/);
  const deletionSlice = source.slice(source.indexOf('function currentSessionMenuCandidates'), source.indexOf('async function waitForConversationToDisappear'));
  assert.doesNotMatch(deletionSlice, /[А-Яа-яЁё]/);
  assert.doesNotMatch(deletionSlice, /aria-label\*=/);
});


test('extension completion gate also waits for required generic downloadable files', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /const expectsFile = contract\.required && \['file', 'artifact', 'download'\]\.includes\(contract\.expected\)/);
  assert.match(source, /const hasRequiredArtifact = expectsFile/);
  assert.match(source, /readyArtifacts\.length > 0/);
  assert.match(source, /oneSafeGenericZipAction/);
  assert.match(source, /explicitNonZip/);
});


test('extension content script adopts and removes one-time OS launch tokens for E2E and normal auto-open', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /URL_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch'/);
  assert.match(source, /URL_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server'/);
  assert.match(source, /function safeLaunchBridgeServerUrl\(/);
  assert.match(source, /function readBrowserLaunchMetadataFromUrl\(\)/);
  assert.match(source, /BRIDGE_LAUNCH_TOKEN_RE/);
  assert.match(source, /\^bridge-\[a-z0-9\]/);
  assert.match(source, /history\.replaceState\(history\.state/);
  assert.match(source, /message\.launchToken \|\| browserLaunchToken/);
  assert.match(source, /message\.requestedUrl \|\| browserRequestedUrl/);
  assert.match(source, /initialBrowserLaunch\.launchServerUrl/);
  assert.match(source, /launchServerUrl: browserLaunchServerUrl/);
});


test('extension reanchors active request tracking after a real steer user turn', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /pendingSubmittedTurnBaseline/);
  assert.match(source, /waitForSubmittedUserTurnAnchor/);
  assert.match(source, /resetAssistantAnchorAfterSteer/);
  assert.match(source, /steer\.turn\.reanchored/);
  assert.match(source, /steer_user_turn\.captured/);
  assert.match(source, /DOM_PARSER\.selectLatestMatchingNewTurnRecord/);
  assert.match(source, /pendingSubmittedTurnExpectedText/);
  assert.match(source, /user_turn_text_mismatch/);
  assert.match(source, /DOM_PARSER\.selectFirstTurnAfterRecord/);
});

test('extension scopes deletion to the trigger-owned Radix menu and recognizes delete-chat-menu-item directly', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /\[data-testid="delete-chat-menu-item"\]/);
  assert.match(source, /visibleConversationDeleteMenus/);
  assert.match(source, /menuOwnedByTrigger/);
  assert.match(source, /DOM_PARSER\.isConversationDeleteActionDescriptor/);
  assert.match(source, /session\.delete\.action_found/);
  assert.match(source, /menuAriaLabelledby/);
  assert.match(source, /boundedUiBackoffDelay/);
  assert.match(source, /waitForDeleteConfirmation/);
  assert.match(source, /session\.delete\.confirmation_waiting/);
  assert.match(source, /session\.delete\.confirmation_timeout/);
  assert.match(source, /session\.delete\.completed_during_confirmation_grace/);
});

test('extension materializes delayed text previews across dialog and slot-content layouts', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const core = await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8');
  assert.match(source, /function artifactPreviewControls\(/);
  assert.match(source, /function visibleArtifactPreviewContainers\(/);
  assert.match(source, /\[slot="content"\]/);
  assert.match(source, /function waitForArtifactPreview\(/);
  assert.match(source, /function waitForLateArtifactPreview\(/);
  assert.match(source, /artifactPreviewHasVisibleLoader/);
  assert.match(source, /DOM_PARSER\.planArtifactPreviewDownload/);
  assert.match(source, /DOM_PARSER\.artifactPreviewReadiness/);
  assert.match(source, /artifact\.preview\.waiting/);
  assert.match(source, /artifact\.preview\.ready/);
  assert.match(source, /artifact\.preview\.foreign_detected/);
  assert.match(source, /artifact\.action\.target_mismatch/);
  assert.match(source, /artifact\.preview\.late_detected/);
  assert.match(source, /popcorn-toolbar/);
  assert.match(source, /popcorn-file-title/);
  assert.match(source, /popcorn-toolbar-actions/);
  assert.match(source, /artifactPreviewIdentityContext/);
  assert.match(source, /artifact\.preview\.download_aliases_added/);
  assert.match(source, /bridge\.download\.capture\.add_expected_names/);
  assert.match(source, /artifact\.preview\.download_clicked/);
  assert.match(source, /captureSource: 'text-preview-dom'/);
  assert.match(source, /await closeArtifactPreview\(previewState\.preview\)/);
  assert.match(source, /DOM_PARSER\.shouldWaitForLateArtifactPreview/);
  assert.match(core, /\['page-url', 'dom-url'\]/);
  assert.match(core, /скачать/i);
  assert.match(core, /download/i);
  assert.match(core, /telecharger/i);
  assert.match(core, /data-testid.*close-button|close-button/);
});

test('extension waits for one exact artifact action and fails fast when another file preview opens', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /DOM_PARSER\.selectArtifactActionCandidate/);
  assert.match(source, /artifact\.action\.resolved/);
  assert.match(source, /artifact\.action\.target_mismatch/);
  assert.match(source, /ARTIFACT_ACTION_TARGET_MISMATCH/);
  assert.match(source, /backoffMs = Math\.min\(1_000, Math\.ceil\(backoffMs \* 1\.7\)\)/);
  assert.doesNotMatch(source, /document\.querySelector\(artifact\.selectorHint\)/);
  assert.doesNotMatch(source, /artifact\.action\.retry_clicked/);
  assert.doesNotMatch(source, /artifact\.action\.retried_after_foreign_preview/);
  assert.match(source, /const currentRoot = artifactSourceRoot\(artifact\) \|\| root/);
});

test('artifact materialization uses bounded per-stage waits instead of a 120 second fallback', async () => {
  const content = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  const config = await fs.readFile(path.resolve('src/config.js'), 'utf8');
  assert.match(content, /artifactDownloadTimeoutMs: 45_000/);
  assert.match(content, /Math\.min\(60_000, Math\.max\(15_000/);
  assert.match(content, /Math\.min\(30_000, Math\.max\(10_000/);
  assert.match(background, /timeoutMs = 45_000/);
  assert.match(config, /ARTIFACT_CHUNK_TIMEOUT_MS', 60_000/);
  assert.doesNotMatch(content, /artifactDownloadTimeoutMs: 120_000/);
});

test('extension preserves structured response blocks, inline code, exact code text, and optional DOM timelines', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /function inlineCodeMarkdown\(/);
  assert.match(source, /function inlineMarkdown\(/);
  assert.match(source, /function extractResponseBlocks\(/);
  assert.match(source, /function codeTextFromPre\(/);
  assert.match(source, /selectCodeLanguageCandidate/);
  assert.match(source, /renders the language label and code actions in a sibling header|document-order interval after the previous <pre>/);
  assert.match(source, /isAssistantAuthorLabel/);
  assert.match(source, /code\?\.textContent/);
  assert.match(source, /responseBlocks: finalSnapshot\.responseBlocks \|\| \[\]/);
  assert.match(source, /codeBlocks: finalSnapshot\.codeBlocks \|\| \[\]/);
  assert.match(source, /codeBlockDiagnostics: finalSnapshot\.codeBlockDiagnostics \|\| \[\]/);
  assert.match(source, /rankCodeLanguageCandidates/);
  assert.match(source, /direct text node of the wrapper/);
  assert.match(source, /following siblings/);
  assert.match(source, /request\.options\?\.captureDomTimeline/);
  assert.match(source, /assistant\.dom\.snapshot/);
  assert.doesNotMatch(source, /normalizeCode\(code\.innerText \|\| code\.textContent/);
});

test('extension adopts an already-bound Chrome download instead of abandoning its cleanup identity', async () => {
  const content = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  assert.match(content, /bridge\.download\.capture\.release/);
  assert.match(content, /artifact\.download_capture\.adopted/);
  assert.match(content, /artifact\.download_capture\.recovered_after_error/);
  assert.match(content, /result = await browserDownloadPromise/);
  assert.match(background, /function waitDownloadCaptureBound\(/);
  assert.match(background, /function releaseDownloadCapture\(/);
  assert.match(background, /if \(state\.itemId != null\) return \{ \.\.\.captureBindingResult\(state\), cancelled: false \}/);
});

test('response Markdown extraction protects inline whitespace and chooses safe code fences', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /const preserved = \[\]/);
  assert.match(source, /longestRun = Math\.max/);
  assert.match(source, /const fence = '`'\.repeat\(Math\.max\(3, longestRun \+ 1\)\)/);
  assert.match(source, /codeLanguageDetails\(/);
  assert.match(source, /element\?\.contains\?\.\(pre\)/);
  assert.match(source, /codeBlockDiagnostics/);
  assert.match(source, /function isCodeBlockChromeElement/);
  assert.match(source, /Node\.DOCUMENT_POSITION_PRECEDING/);
  assert.match(source, /function codeUiActionText/);
  assert.match(source, /wrapperDirect = directLanguage\(wrapper, 'wrapper'\)/);
  assert.match(source, /following siblings/);
});
