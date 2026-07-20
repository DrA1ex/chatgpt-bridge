import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_RUNTIME_FILES = [
  'tools/chrome-bridge-extension/content.js',
  'tools/chrome-bridge-extension/content/domUtilities.js',
  'tools/chrome-bridge-extension/content/panelRuntime.js',
  'tools/chrome-bridge-extension/content/transportRuntime.js',
  'tools/chrome-bridge-extension/content/featureRuntime.js',
  'tools/chrome-bridge-extension/content/pageStatusRuntime.js',
  'tools/chrome-bridge-extension/content/requestTelemetry.js',
  'tools/chrome-bridge-extension/content/serverCommandRouter.js',
  'tools/chrome-bridge-extension/content/composerCommands.js',
  'tools/chrome-bridge-extension/content/attachmentCommands.js',
  'tools/chrome-bridge-extension/content/sessionCommands.js',
  'tools/chrome-bridge-extension/content/intelligenceCommands.js',
  'tools/chrome-bridge-extension/content/turnSnapshots.js',
  'tools/chrome-bridge-extension/content/artifactDom.js',
  'tools/chrome-bridge-extension/content/artifactPreview.js',
  'tools/chrome-bridge-extension/content/artifactTransfer.js',
  'tools/chrome-bridge-extension/content/requestCommands.js',
  'tools/chrome-bridge-extension/content/requestPreparation.js',
  'tools/chrome-bridge-extension/content/requestMonitor.js',
  'tools/chrome-bridge-extension/content/responseRecovery.js',
  'tools/chrome-bridge-extension/content/responseDom.js',
  'tools/chrome-bridge-extension/content/pageRuntimeObservers.js',
];

async function readContentRuntimeSource() {
  return (await Promise.all(CONTENT_RUNTIME_FILES.map((file) => fs.readFile(path.resolve(file), 'utf8')))).join('\n');
}

test('extension panel status classification does not treat disconnected/reconnecting text as connected', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /function isPanelOkStatus\(status\)/);
  assert.match(source, /isPanelOkStatus\(panelState\.status\)/);
  assert.doesNotMatch(source, /\/connected\|reachable\/i\.test\(panelState\.status\)/);
  assert.doesNotMatch(source, /\/connected\/i\.test\(status\)/);
});

test('extension Test button validates BRIDGE_TOKEN, not only setup reachability', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /function authCheckUrl\(/);
  assert.match(source, /\/extension\/auth\/check/);
  assert.match(source, /bridgeTokenAccepted/);
  assert.match(source, /connection test failed/);
});

test('Chrome extension manifest version is incremented after extension updates', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '2.2.4');
});

test('extension manifest and content runtime expose the breaking-release versions', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  const source = await readContentRuntimeSource();
  const declaredVersion = source.match(/const CONTENT_SCRIPT_VERSION = '([^']+)'/)?.[1] || '';
  assert.equal(manifest.version, '2.2.4');
  assert.equal(declaredVersion, '4.2.4');
  assert.match(source, /globalThis\[INSTANCE_KEY\] = \{ version: CONTENT_SCRIPT_VERSION/);
});

test('extension manifest loads the extension API and runtime configuration before the main content script', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  const isolatedScripts = manifest.content_scripts.find((entry) => entry.world !== 'MAIN')?.js || [];
  const apiIndex = isolatedScripts.indexOf('content/extensionApi.js');
  const configIndex = isolatedScripts.indexOf('content/runtimeConfig.js');
  const sessionIndex = isolatedScripts.indexOf('content/sessionCommands.js');
  const intelligenceIndex = isolatedScripts.indexOf('content/intelligenceCommands.js');
  const contentIndex = isolatedScripts.indexOf('content.js');
  assert.ok(apiIndex >= 0 && configIndex > apiIndex && sessionIndex > configIndex && intelligenceIndex > sessionIndex && contentIndex > intelligenceIndex);

  const source = await readContentRuntimeSource();
  assert.match(source, /const EXTENSION_API = globalThis\.ChatGptExtensionApi/);
  assert.match(source, /const RUNTIME_CONFIG = globalThis\.ChatGptContentRuntimeConfig/);
});


test('extension records the prompt boundary before submit and exposes it through the shared observation kernel', async () => {
  const source = await readContentRuntimeSource();
  const commands = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestCommands.js'), 'utf8');
  const monitor = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8');
  const baselineIndex = commands.indexOf('pendingSubmittedTurnBaseline: submissionBaseline');
  const armIndex = commands.indexOf('turnCaptureArmed: true');
  const submitIndex = commands.indexOf("await enterPrompt(message, request, { kind: 'prompt' })");
  assert.ok(baselineIndex >= 0 && armIndex > baselineIndex && submitIndex > armIndex);
  assert.match(commands, /await waitForSubmittedUserTurnAnchor\(request, submissionBaseline/);
  assert.match(source, /promptBoundary/);
  assert.match(monitor, /refreshRequestTurnAnchors\(request\)/);
  assert.match(monitor, /scheduleTabObservation\(reason, 0\)/);
  assert.doesNotMatch(monitor, /request\.terminal_/);
});


test('shared observation stability uses bounded milestones instead of a hidden terminal timer', async () => {
  const runtimeConfig = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/runtimeConfig.js'), 'utf8');
  const observer = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObserver.js'), 'utf8');
  assert.match(runtimeConfig, /postStopTerminalSettleMs: 900/);
  assert.match(observer, /options\.stabilityMilestones \|\| \[750, 2_000\]/);
  assert.match(observer, /scheduleStabilityMilestones\(\)/);
  assert.match(observer, /reason: 'stability\.milestone'/);
  assert.doesNotMatch(observer, /terminalSettle|terminalCandidate/);
});



test('extension waits for stable readiness and never retries an unconfirmed prompt write', async () => {
  const source = await readContentRuntimeSource();
  const composerSource = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'), 'utf8');
  const runtimeConfig = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/runtimeConfig.js'), 'utf8');
  assert.match(runtimeConfig, /pageReadyTimeoutMs: 45_000/);
  assert.doesNotMatch(runtimeConfig, /promptSubmitRetries|promptSubmitRetryDelayMs/);
  assert.match(source, /function chatPageReadiness\(/);
  assert.match(source, /async function waitForChatPageReady\(/);
  assert.match(composerSource, /async function waitForPromptSubmissionEvidence\(/);
  assert.doesNotMatch(composerSource, /prompt\.submit\.retry|PROMPT_SUBMIT_NOT_CONFIRMED|retryCount/);
  assert.match(composerSource, /prompt\.submit\.uncertain/);
  assert.match(composerSource, /PROMPT_SUBMIT_UNCERTAIN/);
  assert.match(composerSource, /automatic retry is forbidden/);
  assert.match(source, /startPageReadinessMonitor\(\)/);
});

test('extension separates visible progress text from downloadable artifacts', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /readAssistantVisibleBlocks/);
  assert.doesNotMatch(source, /assistant\.progress\.snapshot/);
  assert.match(source, /type: 'tab\.observation'/);
  assert.match(source, /progressItems/);
  assert.match(source, /artifacts/);
  assert.match(source, /isZipLikeLabel/);
  assert.match(source, /artifactActionSignal/);
  assert.match(source, /hasStrictArtifactIntent/);
  assert.match(source, /looksLikeThinkingProgressText/);
  assert.doesNotMatch(source, /\\bzip\\b\|архив\/\.test\(source\)/);
});


test('extension finalization gate treats Steer/continuation UI as non-terminal', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'), 'utf8');
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


test('extension coalesces DOM reads in the shared tab observer and scopes Steer controls', async () => {
  const observer = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObserver.js'), 'utf8');
  const monitor = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8');
  const composerSource = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'), 'utf8');
  assert.match(observer, /let collecting = false/);
  assert.match(observer, /let collectAgain = false/);
  assert.match(observer, /function schedule/);
  assert.match(monitor, /scheduleTabObservation/);
  assert.doesNotMatch(monitor, /MutationObserver/);
  assert.match(composerSource, /function finalizationControlRoots\(/);
  assert.match(composerSource, /function findComposerRootStrict\(/);
  assert.match(composerSource, /function scopedQueryAll\(/);
  assert.match(composerSource, /findSteerControl\(roots = finalizationControlRoots\(getActiveRequest\(\)\)\)/);
});


test('extension extracts visible reasoning and action-status steps into the immutable observation output', async () => {
  const source = await readContentRuntimeSource();
  const observation = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObservationCore.js'), 'utf8');
  assert.match(source, /function readAssistantVisibleBlocks\(/);
  assert.match(source, /function readVisibleBlock\(/);
  assert.match(source, /DOM_PARSER\.groupVisibleBlocks/);
  assert.match(source, /progressItems/);
  assert.match(source, /tool_status/);
  assert.match(source, /action_status/);
  assert.match(source, /collectExplicitThinkingCandidates/);
  assert.match(observation, /progressItems/);
  assert.match(observation, /reasoningHistory/);
});


test('extension uses layered scoped artifact materialization for button-only generated files', async () => {
  const source = await readContentRuntimeSource();
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
  const source = await readContentRuntimeSource();
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
  const source = await readContentRuntimeSource();
  assert.match(source, /function isChatConversationUrl\(/);
  assert.match(source, /\^\\\/c\\\/\[\^\/\]\+\$/);
  assert.match(source, /\^\\\/g\\\/\[\^\/\]\+/);
  assert.match(source, /if \(!isChatConversationUrl\(\)\) return;/);
  assert.match(source, /root\?\.remove\(\)/);
  assert.match(source, /syncFloatingPanelVisibility/);
  assert.match(source, /\(document\.body \|\| document\.documentElement\)\.appendChild\(root\)/);
});


test('extension ignores generic closed controls when scanning artifact lifecycle state', async () => {
  const source = await readContentRuntimeSource();
  const core = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8');
  assert.match(source, /isArtifactLifecycleStateDescriptor/);
  assert.match(source, /isExcludedArtifactAction\(element\)/);
  assert.match(source, /lifecycleObserved: true/);
  assert.match(core, /function artifactBlocksCompletion/);
  assert.match(core, /phase === 'READY' \|\| phase === 'FAILED'/);
});

test('extension reports browser facts while the server owns completion and required-artifact policy', async () => {
  const source = await readContentRuntimeSource();
  const adapter = await fs.readFile(path.resolve('src/bridge/adapters/tabObservationAdapter.js'), 'utf8');
  const evidence = await fs.readFile(path.resolve('src/bridge/observation/turnEvidence.js'), 'utf8');
  assert.match(source, /type: 'tab\.observation'/);
  assert.doesNotMatch(source, /request\.terminal_snapshot|request\.terminal_failure|snapshotTerminalForRequest/);
  assert.doesNotMatch(source, /function requiredArtifactPending\(/);
  assert.match(adapter, /completionCandidate/);
  assert.match(adapter, /classifyTurnObservation/);
  assert.match(evidence, /stableForMs/);
});


test('extension immediately resyncs the shared observation on foreground return without publishing lifecycle status', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/pageRuntimeObservers.js'), 'utf8');
  assert.match(source, /function handleForegroundResync\(/);
  assert.match(source, /scheduleTabObservation\(reason, 0\)/);
  assert.match(source, /scheduleCollect\(request, reason, 0\)/);
  assert.match(source, /window\.addEventListener\('pageshow'/);
  assert.doesNotMatch(source, /status: 'finalizing'|status: 'idle'/);
});


test('extension session cleanup is URL-bound and uses stable non-localized DOM identity', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
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


test('required generic downloadable-file policy is owned by the server request state layer', async () => {
  const content = await readContentRuntimeSource();
  const requestState = await fs.readFile(path.resolve('src/bridge/requestState.js'), 'utf8');
  const artifactPolicy = await fs.readFile(path.resolve('src/results/artifacts.js'), 'utf8');
  assert.doesNotMatch(content, /const expectsFile = contract\.required/);
  assert.match(requestState, /function requiredOutputArtifactMissing/);
  assert.match(requestState, /\['file', 'artifact', 'download'\]\.includes\(expected\)/);
  assert.match(requestState, /selectRequiredZipCompletionCandidate/);
  assert.match(artifactPolicy, /selectRequiredZipCompletionCandidate/);
  assert.match(artifactPolicy, /explicitNonZip|explicit non-ZIP/i);
});


test('extension content script adopts and removes one-time OS launch tokens for E2E and normal auto-open', async () => {
  const source = await readContentRuntimeSource();
  const runtimeConfig = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/runtimeConfig.js'), 'utf8');
  assert.match(runtimeConfig, /URL_LAUNCH_HASH_KEY = 'chatgpt-bridge-launch'/);
  assert.match(runtimeConfig, /URL_LAUNCH_SERVER_HASH_KEY = 'chatgpt-bridge-server'/);
  assert.match(runtimeConfig, /function safeLaunchBridgeServerUrl\(/);
  assert.match(runtimeConfig, /function readBrowserLaunchMetadataFromUrl\(\)/);
  assert.match(runtimeConfig, /BRIDGE_LAUNCH_TOKEN_RE/);
  assert.match(runtimeConfig, /\^bridge-\[a-z0-9\]/);
  assert.match(runtimeConfig, /history\.replaceState\(history\.state/);
  assert.match(source, /browserLaunchToken\.startsWith\('bridge-reload-'\)/);
  assert.match(source, /message\.requestedUrl \|\| browserRequestedUrl/);
  assert.match(source, /initialBrowserLaunch\.launchServerUrl/);
  assert.match(source, /getBrowserLaunchServerUrl|launchServerUrl: browserLaunchServerUrl/);
});


test('extension reanchors active request tracking after a real steer user turn', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /pendingSubmittedTurnBaseline/);
  assert.match(source, /waitForSubmittedUserTurnAnchor/);
  assert.match(source, /resetAssistantAnchorAfterSteer/);
  assert.match(source, /steer\.turn\.reanchored/);
  assert.match(source, /steer_user_turn\.captured/);
  assert.match(source, /DOM_PARSER\.selectLatestMatchingNewTurnRecord/);
  assert.match(source, /pendingSubmittedTurnExpectedText/);
  assert.match(source, /user_turn_text_mismatch/);
  assert.match(source, /send_button\.not_found_form_submit_fallback/);
  assert.match(source, /form\.requestSubmit\(\)/);
  assert.match(source, /DOM_PARSER\.selectLatestTurnAfterRecord/);
});

test('extension scopes deletion to the trigger-owned Radix menu and recognizes delete-chat-menu-item directly', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
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
  const source = await readContentRuntimeSource();
  const core = await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8');
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
  const source = await readContentRuntimeSource();
  assert.match(source, /DOM_PARSER\.selectArtifactActionCandidate/);
  assert.match(source, /artifact\.action\.resolved/);
  assert.match(source, /artifact\.action\.target_mismatch/);
  assert.match(source, /ARTIFACT_ACTION_TARGET_MISMATCH/);
  assert.match(source, /backoffMs = Math\.min\(1_000, Math\.ceil\(backoffMs \* 1\.7\)\)/);
  assert.doesNotMatch(source, /document\.querySelector\(artifact\.selectorHint\)/);
  assert.doesNotMatch(source, /artifact\.action\.retry_clicked/);
  assert.doesNotMatch(source, /artifact\.action\.retried_after_foreign_preview/);
  assert.match(source, /const currentRoot = artifactSourceRoot\(artifact\) \|\| root/);
  assert.match(source, /findTurnByKey\(artifact\.sourceTurnKey, artifact\.sourceTurnIndex\)/);
});

test('artifact materialization uses bounded per-stage waits instead of a 120 second fallback', async () => {
  const content = await readContentRuntimeSource();
  const runtimeConfig = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/runtimeConfig.js'), 'utf8');
  const downloads = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background/downloadCoordinator.js'), 'utf8');
  const config = await fs.readFile(path.resolve('src/config.js'), 'utf8');
  assert.match(runtimeConfig, /artifactDownloadTimeoutMs: 45_000/);
  assert.match(content, /Math\.min\(60_000, Math\.max\(15_000/);
  assert.match(content, /Math\.min\(30_000, Math\.max\(10_000/);
  assert.match(downloads, /timeoutMs = 45_000/);
  assert.match(config, /ARTIFACT_CHUNK_TIMEOUT_MS', 60_000/);
  assert.doesNotMatch(runtimeConfig, /artifactDownloadTimeoutMs: 120_000/);
});

test('extension preserves structured response blocks, inline code, exact code text, and optional DOM timelines', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /function inlineCodeMarkdown\(/);
  assert.match(source, /function inlineMarkdown\(/);
  assert.match(source, /function extractResponseBlocks\(/);
  assert.match(source, /function codeTextFromPre\(/);
  assert.match(source, /function codeWidgetInspection\(/);
  assert.match(source, /function codeWidgetContentSource\(/);
  assert.match(source, /function rawCodeWidgetOwnerCandidate\(/);
  assert.match(source, /function isResponseCodeWidgetOwner\(/);
  assert.match(source, /codemirror-code/);
  assert.match(source, /isAssistantAuthorLabel/);
  assert.match(source, /code\?\.textContent/);
  const observation = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObservationCore.js'), 'utf8');
  assert.match(observation, /responseBlocks/);
  assert.match(observation, /codeBlocks/);
  assert.match(observation, /codeBlockDiagnostics/);
  assert.match(observation, /parserAudit/);
  assert.match(source, /unknownChildren/);
  assert.match(source, /parserAuditForRoot/);
  assert.match(source, /duplicate_leaf_ownership/);
  assert.match(source, /unclassified-visible-content/);
  assert.match(source, /interfaceControls/);
  assert.match(source, /request\.options\?\.captureDomTimeline/);
  assert.doesNotMatch(source, /assistant\.dom\.snapshot/);
  assert.doesNotMatch(source, /normalizeCode\(code\.innerText \|\| code\.textContent/);
});

test('extension adopts an already-bound Chrome download instead of abandoning its cleanup identity', async () => {
  const content = await readContentRuntimeSource();
  const downloads = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background/downloadCoordinator.js'), 'utf8');
  assert.match(content, /bridge\.download\.capture\.release/);
  assert.match(content, /artifact\.download_capture\.adopted/);
  assert.match(content, /artifact\.download_capture\.recovered_after_error/);
  assert.match(content, /result = await browserDownloadPromise/);
  assert.match(downloads, /function waitDownloadCaptureBound\(/);
  assert.match(downloads, /function releaseDownloadCapture\(/);
  assert.match(downloads, /if \(state\.itemId != null\) return \{ \.\.\.bindingResult\(state\), cancelled: false \}/);
});

test('response Markdown extraction protects inline whitespace and chooses safe code fences', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /const preserved = \[\]/);
  assert.match(source, /longestRun = Math\.max/);
  assert.match(source, /const fence = '`'\.repeat\(Math\.max\(3, longestRun \+ 1\)\)/);
  assert.match(source, /codeWidgetInspection\(/);
  assert.match(source, /contentSource\?\.contains\?\.\(leaf\)/);
  assert.match(source, /codeBlockDiagnostics/);
  assert.match(source, /function isCodeBlockChromeElement/);
  assert.match(source, /function codeUiActionText/);
  assert.match(source, /unclassified-code-widget-chrome/);
  assert.match(source, /function mergeParserAudits/);
});


test('extension paces intelligence picker actions and verifies without repeated option clicks', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/intelligenceCommands.js'), 'utf8');
  const contentSource = await readContentRuntimeSource();
  assert.match(source, /const INTELLIGENCE_UI_TIMING = Object\.freeze/);
  assert.match(source, /pickerStableMs: 180/);
  assert.match(source, /submenuPulseMs: 280/);
  assert.match(source, /beforeOptionClickMs: 180/);
  assert.match(source, /selectionSettleMs: 850/);
  assert.match(source, /betweenSelectionsMs: 500/);
  assert.match(source, /dispatchSinglePointerClick/);
  assert.match(source, /name: 'pointer-click'/);
  assert.match(source, /name: 'keyboard-enter'/);
  assert.match(source, /model\.submenu\.keyboard_retry/);
  assert.doesNotMatch(source, /One final click fallback is allowed/);
  assert.equal((source.match(/match\.element\.click\(\)/g) || []).length, 1);
  assert.match(contentSource, /model\.apply\.verification\.started/);
  assert.match(contentSource, /model\.apply\.verification\.retry/);
  assert.doesNotMatch(source, /await delay\(55\)/);
});


test('response parser traverses display-contents wrappers and audits the full DOM leaf denominator', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /function parserElementVisible\(/);
  assert.match(source, /ChatGptResponseParserCore\?\.collectCodeWidgetOwners/);
  assert.match(source, /const visibleCount = leaves\.length;/);
  assert.match(source, /if \(accountedLeaves !== visibleCount\) warnings\.push\('leaf_accounting_gap'\)/);
});

test('active and passive modes share one observation scheduler and response parsing avoids forced layout loops', async () => {
  const observer = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObserver.js'), 'utf8');
  const passive = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/pageRuntimeObservers.js'), 'utf8');
  const monitor = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8');
  const parser = await fs.readFile(path.resolve('tools/chrome-bridge-extension/responseParserCore.js'), 'utf8');
  assert.match(passive, /scheduleTabObservation/);
  assert.match(monitor, /scheduleTabObservation/);
  assert.doesNotMatch(passive, /dirtyTurns|pendingTerminal|observed\.turn\./);
  assert.match(observer, /MutationObserver/);
  assert.doesNotMatch(parser, /getBoundingClientRect/);
  assert.match(parser, /createParserPass/);
  assert.match(parser, /computedStyleReads/);
  assert.match(parser, /ownerCandidatesEnumerated/);
});

test('request preparation stages publish typed effect observations to the canonical server lifecycle', async () => {
  const source = await readContentRuntimeSource();
  assert.match(source, /async function runObservedRequestEffect\(/);
  assert.match(source, /type: 'request\.effect\.started'/);
  const reporter = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background/unreportedCriticalReporter.js'), 'utf8');
  assert.match(reporter, /type: `request\.effect\.\$\{effect\.status\}`/);
  assert.doesNotMatch(source, /type: 'request\.effect\.succeeded'/);
  assert.doesNotMatch(source, /type: `request\.effect\.\$\{status\}`/);
  assert.match(source, /cancelled \? 'cancelled' : \(uncertain \? 'uncertain' : 'failed'\)/);
  assert.match(source, /const writeEffect = descriptor\.write === true/);
  assert.match(source, /retryPolicy: String\(descriptor\.retryPolicy \|\| 'never'\)/);
  assert.match(source, /effectId: String\(descriptor\.effectId\)/);
  assert.match(source, /ownerServerInstanceId: String\(request\.ownerServerInstanceId/);
  assert.match(source, /const currentStep = planSteps\[startAtIndex\]/);
  assert.match(source, /currentStepKind === 'page\.ready\.initial'/);
  assert.match(source, /currentStepKind === 'session\.apply'/);
  assert.match(source, /currentStepKind === 'model\.apply'/);
  assert.match(source, /currentStepKind === 'attachments\.upload'/);
  assert.match(source, /currentStepKind !== 'prompt\.submit'/);
  assert.match(source, /runObservedRequestEffect\(request, currentStepKind/);
  assert.doesNotMatch(source, /for\s*\([^)]*planSteps|planSteps\.slice\(startAtIndex\)/);
  assert.doesNotMatch(source, /send\(\{ type: 'request.terminal_snapshot'/);
});


test('extension delegates missing assistant output to canonical forced-snapshot deadlines', async () => {
  const source = await readContentRuntimeSource();
  const recovery = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/responseRecovery.js'), 'utf8');
  assert.doesNotMatch(source, /ASSISTANT_RESPONSE_MISSING|request\.terminal_failure/);
  assert.match(recovery, /readLatestAssistantSnapshot/);
  assert.match(recovery, /readAssistantSnapshotByTurnKey/);
  assert.match(recovery, /responsePayloadFromSnapshot/);
});

test('extension schedules bounded stability milestones without materializing terminal state', async () => {
  const observer = await fs.readFile(path.resolve('tools/chrome-bridge-extension/observation/tabObserver.js'), 'utf8');
  const monitor = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8');
  assert.match(observer, /options\.stabilityMilestones \|\| \[750, 2_000\]/);
  assert.match(observer, /scheduleStabilityMilestones\(\)/);
  assert.match(observer, /reason: 'stability\.milestone'/);
  assert.match(observer, /setTimeout/);
  assert.doesNotMatch(monitor, /terminalCandidate|request\.terminal_/);
});


test('request-scoped model and effort effects return verified picker state through canonical effect results', async () => {
  const requestCommands = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestCommands.js'), 'utf8');
  const requestPreparation = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestPreparation.js'), 'utf8');
  const resultMappings = requestCommands.match(/result:\s*\(applied\)\s*=>\s*applied/g) || [];
  assert.equal(resultMappings.length, 1, 'The request-scoped model.apply step must persist its verified result exactly once');
  assert.match(requestCommands, /const applied = await applyModelOptions\(options, request\)/);
  assert.doesNotMatch(requestPreparation, /type:\s*'chat\.event'/, 'Content must not publish a parallel model lifecycle message');
});

test('general chat controls exclude the history sidebar and extension-owned panel', async () => {
  const utilities = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/domUtilities.js'), 'utf8');
  const intelligence = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/intelligenceCommands.js'), 'utf8');
  const composer = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'), 'utf8');
  assert.match(utilities, /PRIMARY_CHAT_EXCLUSION_SELECTOR/);
  assert.match(utilities, /\[data-sidebar-item\]/);
  assert.match(utilities, /#chatgpt-bridge-panel-root/);
  assert.match(intelligence, /isComposerIntelligenceTriggerCandidate/);
  assert.match(intelligence, /element\.closest\?\.\('\[data-turn\], \[data-message-author-role\]'\)/);
  assert.match(composer, /isPrimaryChatSurfaceElement/);
});
