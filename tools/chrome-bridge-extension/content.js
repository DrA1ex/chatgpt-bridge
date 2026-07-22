(() => {
  'use strict';
  if (window.top !== window.self) return;
  const EXTENSION_API = globalThis.ChatGptExtensionApi;
  const RUNTIME_CONFIG = globalThis.ChatGptContentRuntimeConfig;
  if (!EXTENSION_API || !RUNTIME_CONFIG) throw new Error('ChatGPT extension runtime modules were not loaded before content.js');
  const { DEFAULT_CONFIG, readBrowserLaunchMetadataFromUrl, safeLaunchBridgeServerUrl } = RUNTIME_CONFIG;
  const INSTANCE_KEY = '__chatgptBrowserBridgeCompanionInstance';
  const CONTENT_SCRIPT_VERSION = '4.3.1';
  const EXTENSION_PROTOCOL_VERSION = 5;
  const CONTENT_EPOCH = `content-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const EXTENSION_VERSION = (() => {
    try { return String(chrome.runtime.getManifest()?.version || ''); } catch { return ''; }
  })();
  try {
    if (globalThis[INSTANCE_KEY]) return;
    globalThis[INSTANCE_KEY] = { version: CONTENT_SCRIPT_VERSION, startedAt: Date.now() };
  } catch {}
  const initialBrowserLaunch = readBrowserLaunchMetadataFromUrl();
  const CONFIG = RUNTIME_CONFIG.loadConfig(EXTENSION_API);
  const temporaryConnectionOverride = RUNTIME_CONFIG.applyTemporaryConnectionOverride(EXTENSION_API, CONFIG);
  if (initialBrowserLaunch.launchServerUrl) { CONFIG.serverUrl = initialBrowserLaunch.launchServerUrl; if (temporaryConnectionOverride.applied && temporaryConnectionOverride.serverUrl !== CONFIG.serverUrl) RUNTIME_CONFIG.removeTemporaryConnectionOverride(); }
  const DOM_PARSER = globalThis.ChatGptDomParserCore;
  if (!DOM_PARSER) throw new Error('ChatGPT DOM parser core was not loaded before content.js');
  const TAB_OBSERVATION_CORE = globalThis.ChatGptTabObservationCore;
  const TAB_OBSERVER_FACTORY = globalThis.ChatGptTabObserver;
  if (!TAB_OBSERVATION_CORE || !TAB_OBSERVER_FACTORY) throw new Error('ChatGPT tab observer modules were not loaded before content.js');
  const DOM_UTILITIES = globalThis.ChatGptDomUtilities;
  if (!DOM_UTILITIES) throw new Error('ChatGPT DOM utility module was not loaded before content.js');
  const { delay, isPrimaryChatSurfaceElement, isVisible, normalizeComparable, normalizeText, unique, visibleText } = DOM_UTILITIES;
  const CLIENT_ID_STORAGE_KEY = 'chatgptBridgeTabClientId';
  let fallbackClientId = '';
  let transportRuntime = null;
  let pageRuntimeController = null;
  const thinkingStateByTurn = new Map();
  const thinkingNodeTokens = new WeakMap();
  let thinkingNodeTokenSequence = 1;
  const REQUEST_STATE_FACTORY = globalThis.ChatGptRequestState;
  const RECONNECT_RUNTIME = globalThis.ChatGptReconnectRuntime;
  const EXECUTION_STATE_FACTORY = globalThis.ChatGptRequestExecutionState;
  if (!REQUEST_STATE_FACTORY) throw new Error('ChatGPT request state module was not loaded before content.js');
  if (!RECONNECT_RUNTIME) throw new Error('ChatGPT reconnect runtime module was not loaded before content.js');
  if (!EXECUTION_STATE_FACTORY) throw new Error('ChatGPT request execution state was not loaded before content.js');
  const executionStore = EXECUTION_STATE_FACTORY.createRequestExecutionStore({
    recoverRequest: (...args) => REQUEST_STATE_FACTORY.recoverRequestState(...args),
  });
  const getActiveRequest = () => executionStore.getCurrent();
  let connectedServerInstanceId = '';
  let requestCommandsApi = null;
  let featureRuntime = null;
  function publicRequestStatus(...args) { return requestCommandsApi?.publicRequestStatus?.(...args) ?? null; }
  function isGenerating(...args) { return featureRuntime?.isGenerating(...args) ?? false; }
  function saveConfigPatch(patch) {
    RUNTIME_CONFIG.saveConfigPatch(EXTENSION_API, CONFIG, patch);
  }
  function getClientId() {
    let id = '';
    try { id = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY) || ''; } catch {}
    if (!id) {
      id = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try { sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id); } catch { fallbackClientId = id; }
    }
    return id || fallbackClientId;
  }
  function authCheckUrl(serverUrl = CONFIG.serverUrl, token = CONFIG.token) {
    const url = new URL('/extension/auth/check', String(serverUrl || DEFAULT_CONFIG.serverUrl).replace(/\/$/, ''));
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('runtime', 'extension');
    return url.toString();
  }
  const PANEL_RUNTIME_FACTORY = globalThis.ChatGptPanelRuntime;
  if (!PANEL_RUNTIME_FACTORY) throw new Error('ChatGPT panel runtime module was not loaded before content.js');
  const {
    applyCompatibilityStatus,
    compareVersionStrings,
    getBridgeVersion,
    openFloatingPanel,
    recordLocalLog,
    removeFloatingPanel,
    safeJsonParse,
    safeUrlPath,
    setBridgeVersion,
    setPanelStatus,
    summarizePayload,
    syncFloatingPanelVisibility,
    updatePanel,
  } = PANEL_RUNTIME_FACTORY.createPanelRuntime({
    CONFIG,
    CONTENT_SCRIPT_VERSION,
    DEFAULT_CONFIG,
    EXTENSION_VERSION,
    authCheckUrl: (...args) => authCheckUrl(...args),
    connect: (...args) => connect(...args),
    disconnectTransport: (...args) => disconnectTransport(...args),
    extensionHttpJson: (...args) => extensionHttpJson(...args),
    getActiveRequest,
    getClientId,
    getCurrentSession: (...args) => getCurrentSession(...args),
    publicRequestStatus: (...args) => publicRequestStatus(...args),
    saveConfigPatch,
  });
  function send(payload) { return transportRuntime?.send(payload) ?? false; }
  function connect(...args) { return transportRuntime?.connect(...args); }
  function disconnectTransport(...args) { return transportRuntime?.disconnectTransport(...args); }
  function extensionHttpJson(...args) { return transportRuntime.extensionHttpJson(...args); }
  function extensionRequest(...args) { return transportRuntime.extensionRequest(...args); }
  function armPageArtifactCapture(...args) { return transportRuntime.armPageArtifactCapture(...args); }
  function enqueueArtifactAction(...args) { return transportRuntime.enqueueArtifactAction(...args); }
  function hasExtensionRuntime() { return transportRuntime?.hasExtensionRuntime() ?? false; }
  function getExtensionPort() { return transportRuntime?.getExtensionPort() ?? null; }
  function diagnostic(name, details = {}) {
    send({
      type: 'diagnostic',
      name,
      requestId: details.requestId,
      url: location.href,
      title: document.title,
      time: Date.now(),
      ...details,
    });
  }
  let readUnifiedObservedTurnContext = () => null; const PAGE_STATUS_RUNTIME_FACTORY = globalThis.ChatGptPageStatusRuntime;
  if (!PAGE_STATUS_RUNTIME_FACTORY) throw new Error('ChatGPT page status runtime module was not loaded before content.js');
  const {
    getLastTabObservation,
    pagePresence,
    schedulePageStatus,
    scheduleTabObservation,
    sendPageStatus,
    startPageReadinessMonitor,
    startTabObserver,
    stopPageReadinessMonitor,
    stopTabObserver,
    subscribeTabObservation,
  } = PAGE_STATUS_RUNTIME_FACTORY.createPageStatusRuntime({
    CONFIG,
    TAB_OBSERVATION_CORE,
    TAB_OBSERVER_FACTORY,
    chatPageReadiness: (...args) => chatPageReadiness(...args),
    diagnostic,
    findChatMain: (...args) => findChatMain(...args),
    getActiveRequest,
    getCurrentSession: (...args) => getCurrentSession(...args),
    isGenerating: (...args) => isGenerating(...args),
    publicRequestStatus: (...args) => publicRequestStatus(...args),
    readObservedTurnContext: (...args) => readUnifiedObservedTurnContext(...args),
    readAssistantSnapshot: (...args) => readAssistantSnapshot(...args),
    readLatestAssistantSnapshot: (...args) => readLatestAssistantSnapshot(...args),
    send,
  });
  const REQUEST_TELEMETRY_FACTORY = globalThis.ChatGptRequestTelemetry;
  if (!REQUEST_TELEMETRY_FACTORY) throw new Error('ChatGPT request telemetry module was not loaded before content.js');
  const {
    emitChatEvent,
    emitRequestProgress,
    markRequestProgress,
    runObservedRequestEffect,
    settleUnexecutableEffect,
    setRequestPhase,
  } = REQUEST_TELEMETRY_FACTORY.createRequestTelemetry({
    diagnostic,
    findStopButton: (...args) => findStopButton(...args),
    getAssistantNodes: (...args) => getAssistantNodes(...args),
    getCurrentSession: (...args) => getCurrentSession(...args),
    getTurnNodes: (...args) => getTurnNodes(...args),
    pagePresence,
    planEffect: (effect) => extensionRequest('bridge.effect.begin', { ...effect, browserRequestId: effect.requestId }, 5_000),
    send,
    settleEffect: (effect) => extensionRequest('bridge.effect.settle', { ...effect, browserRequestId: effect.requestId }, 5_000),
  });
  function helloPayload() {
    return {
      type: 'hello',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      clientVersion: CONTENT_SCRIPT_VERSION,
      clientId: getClientId(),
      contentEpoch: CONTENT_EPOCH,
      browserTabId: transportRuntime?.getBrowserTabId() ?? null,
      launchToken: transportRuntime?.getBrowserLaunchToken() || initialBrowserLaunch.launchToken,
      requestedUrl: transportRuntime?.getBrowserRequestedUrl() || initialBrowserLaunch.requestedUrl,
      launchServerUrl: transportRuntime?.getBrowserLaunchServerUrl() || initialBrowserLaunch.launchServerUrl,
      url: location.href,
      title: document.title,
      session: getCurrentSession(),
      ...pagePresence(),
      capabilities: {
        dom: true,
        network: CONFIG.networkStreamEnabled,
        promptInput: true,
        passivePromptSubmission: true,
        cancel: true,
        markdown: true,
        diagnostics: true,
        sessions: true,
        sessionDeletion: true,
        browserTabs: true,
        promptSteering: true,
        fileUpload: true,
        artifacts: true,
        artifactDownload: true,
        modelSelection: true,
        effortSelection: true,
        chunkedArtifactDownload: true,
        requestRecoveryStatus: true,
        extensionTransport: hasExtensionRuntime(),
        extensionDownloads: hasExtensionRuntime(),
      },
      activeRequest: getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null,
      tabObservation: getLastTabObservation(),
    };
  }
  const TRANSPORT_RUNTIME_FACTORY = globalThis.ChatGptContentTransportRuntime;
  if (!TRANSPORT_RUNTIME_FACTORY) throw new Error('ChatGPT content transport runtime was not loaded before content.js');
  transportRuntime = TRANSPORT_RUNTIME_FACTORY.createTransportRuntime({
    CONFIG, EXTENSION_API, RECONNECT_RUNTIME, RUNTIME_CONFIG, applyCompatibilityStatus, executionStore, getClientId,
    helloPayload: (...args) => helloPayload(...args),
    handleServerMessage: (...args) => handleServerMessage(...args),
    onBridgeConnectionChange: (connected, reason) => {
      if (connected) pageRuntimeController?.start?.();
      else pageRuntimeController?.stop?.(reason);
    },
    recordLocalLog, safeJsonParse, safeLaunchBridgeServerUrl, safeUrlPath, setPanelStatus, summarizePayload, temporaryConnectionOverride,
  });
  transportRuntime.initializeLaunchMetadata(initialBrowserLaunch);
  const COMPOSER_COMMANDS_FACTORY = globalThis.ChatGptComposerCommands;
  const ATTACHMENT_COMMANDS_FACTORY = globalThis.ChatGptAttachmentCommands;
  if (!COMPOSER_COMMANDS_FACTORY || !ATTACHMENT_COMMANDS_FACTORY) {
    throw new Error('ChatGPT composer command modules were not loaded before content.js');
  }
  const {
    enterPrompt,
    findComposer,
    buttonSignalText,
    findChatMain,
    findTurnByKey,
    findComposerRootStrict,
    finalizationControlRoots,
    findStopButton,
    findSendButton,
    findContinueButton,
    readFinalizationSignals,
    shouldDeferFinalizationForSteer,
    clickStopButton,
    isUsableButton,
  } = COMPOSER_COMMANDS_FACTORY.createComposerCommands({
    CONFIG,
    conversationIdFromUrl: (...args) => conversationIdFromUrl(...args),
    delay,
    diagnostic,
    domPathForNode: (...args) => domPathForNode(...args),
    emitChatEvent,
    emitRequestProgress,
    getActiveRequest,
    getTurnNodes: (...args) => getTurnNodes(...args),
    isGenerating,
    isPrimaryChatSurfaceElement,
    isVisible,
    normalizeComparable,
    setRequestPhase,
    turnKey: (...args) => turnKey(...args),
    turnRole: (...args) => turnRole(...args),
    visibleText,
    waitForChatPageReady: (...args) => waitForChatPageReady(...args),
  });
  const { attachFiles, handleComposerAttachmentsClear, readComposerAttachmentState } = ATTACHMENT_COMMANDS_FACTORY.createAttachmentCommands({
    CONFIG,
    EXTENSION_API,
    delay,
    diagnostic,
    domPathForNode: (...args) => domPathForNode(...args),
    emitChatEvent,
    findComposerRoot: () => {
      const composer = findComposer();
      return composer?.closest('form')
        || composer?.closest('[data-testid*="composer" i]')
        || composer?.parentElement?.parentElement?.parentElement
        || document.body;
    },
    findSendButton,
    isUsableButton,
    isVisible,
    send,
    visibleText,
  });
  const REQUEST_SNAPSHOT_POLICY = globalThis.ChatGptRequestSnapshotPolicy;
  const FEATURE_RUNTIME_FACTORY = globalThis.ChatGptContentFeatureRuntime;
  if (!FEATURE_RUNTIME_FACTORY) throw new Error('ChatGPT content feature runtime was not loaded before content.js');
  featureRuntime = FEATURE_RUNTIME_FACTORY.createFeatureRuntime({
    CONFIG, CONTENT_SCRIPT_VERSION, DOM_PARSER, EXTENSION_API, EXTENSION_VERSION,
    REQUEST_SNAPSHOT_POLICY, RUNTIME_CONFIG, armPageArtifactCapture,
    buttonSignalText, clickStopButton, delay, diagnostic, emitChatEvent, emitRequestProgress, enqueueArtifactAction,
    executionStore, extensionRequest, finalizationControlRoots, findChatMain, findComposer, findComposerRootStrict,
    findContinueButton, findSendButton, findStopButton, findTurnByKey, getActiveRequest, getExtensionPort,
    isUsableButton, isPrimaryChatSurfaceElement, isVisible, markRequestProgress, nextThinkingNodeToken: () => `node-${thinkingNodeTokenSequence++}`,
    normalizeComparable, normalizeText, publicRequestStatus: (...args) => publicRequestStatus(...args),
    readFinalizationSignals, readObservedTurnContext: (...args) => readUnifiedObservedTurnContext(...args),
    runObservedRequestEffect, safeLaunchBridgeServerUrl, schedulePageStatus, scheduleTabObservation, send, setRequestPhase,
    shouldDeferFinalizationForSteer, subscribeTabObservation, thinkingNodeTokens, thinkingStateByTurn, unique, visibleText,
  });
  const {
    simpleHash, domPathForNode, getTurnNodes, turnKey, turnRole, getAssistantNodes, getAssistantNodeFromTurn,
    waitForSubmittedUserTurnAnchor, refreshRequestTurnAnchors, readLatestAssistantSnapshot, readAssistantSnapshotByTurnKey,
    readRecentAssistantSnapshots, readAssistantSnapshot, readAssistantNodeSnapshot, attachDomObserver, collectAndEmit,
    releaseRequest, scheduleCollect, startDomMonitor, getCurrentSession,
    conversationIdFromUrl, handleSessionsList, handleSessionsNew, handleSessionsSelect, handleSessionsDelete,
    handleBrowserTabOpen, handleBrowserTabClose, handleBrowserOwnedTabClose, handleBrowserTabReload, handleExtensionReload,
    applyModelOptions, applySessionOptions, chatPageReadiness, waitForChatPageReady, waitForDocumentReady, readIntelligenceState, handleModelsList,
    handleEffortsList, handleIntelligenceApply, handleResponseRecoverLatest, handleResponseRecoverList,
    handleResponseRecoverTurnKey, handleResponseSnapshotRequest, handleArtifactFetch,
  } = featureRuntime;
  const PAGE_RUNTIME_OBSERVERS_FACTORY = globalThis.ChatGptPageRuntimeObservers;
  if (!PAGE_RUNTIME_OBSERVERS_FACTORY) throw new Error('ChatGPT page runtime observer module was not loaded before content.js');
  pageRuntimeController = PAGE_RUNTIME_OBSERVERS_FACTORY.createPageRuntimeObservers({
    CONFIG,
    DOM_PARSER,
    REQUEST_SNAPSHOT_POLICY,
    attachDomObserver,
    collectAndEmit,
    diagnostic,
    findChatMain,
    getActiveRequest,
    getAssistantNodeFromTurn,
    getClientId,
    getCurrentSession,
    getTurnNodes,
    readAssistantNodeSnapshot,
    removeFloatingPanel,
    scheduleCollect,
    schedulePageStatus,
    scheduleTabObservation,
    send,
    startPageReadinessMonitor,
    startTabObserver,
    stopPageReadinessMonitor,
    stopTabObserver,
    subscribeTabObservation,
    syncFloatingPanelVisibility,
    turnKey,
    turnRole,
    visibleText,
  });
  const { baselinePassiveTurns, readObservedTurnContext, registerPassivePromptBoundary, schedulePassiveTurnScan } = pageRuntimeController;
  readUnifiedObservedTurnContext = readObservedTurnContext;
  const REQUEST_COMMANDS_FACTORY = globalThis.ChatGptRequestCommands;
  if (!REQUEST_COMMANDS_FACTORY) throw new Error('ChatGPT request command module was not loaded before content.js');
  requestCommandsApi = REQUEST_COMMANDS_FACTORY.createRequestCommands({
    DOM_PARSER,
    REQUEST_STATE: REQUEST_STATE_FACTORY,
    applyModelOptions,
    applySessionOptions,
    attachFiles,
    baselinePassiveTurns,
    clickStopButton,
    collectAndEmit,
    conversationIdFromUrl,
    delay,
    diagnostic,
    domPathForNode,
    emitChatEvent,
    enterPrompt,
    findStopButton,
    findComposer,
    findComposerRootStrict,
    getActiveRequest,
    getAssistantNodes,
    getConnectedServerInstanceId: () => connectedServerInstanceId,
    getCurrentSession,
    getTurnNodes,
    isGenerating,
    markRequestProgress,
    normalizeText,
    refreshRequestTurnAnchors,
    registerPassivePromptBoundary,
    releaseRequest,
    settleEffectReconciliation: (result) => extensionRequest('bridge.effect.reconcile_result', result, 5_000),
    settleReleaseCleanup: (result) => extensionRequest('bridge.release.cleanup_settled', result, 5_000),
    runObservedRequestEffect,
    settleUnexecutableEffect,
    schedulePageStatus,
    schedulePassiveTurnScan,
    scheduleTabObservation,
    send,
    setActiveRequest: (request) => { executionStore.setCurrent(request); },
    setRequestPhase,
    simpleHash,
    startDomMonitor,
    turnKey,
    waitForChatPageReady,
    waitForDocumentReady,
    waitForSubmittedUserTurnAnchor,
    pagePresence,
    readIntelligenceState,
  });
  const { handlePassivePromptSubmit, handlePromptCancel, handlePromptSend, handlePromptSteer,
    handleRequestRelease, handleRequestResume, handleEffectReconcile } = requestCommandsApi;

  const LAYOUT_CAPTURE_FACTORY = globalThis.ChatGptLayoutCapture;
  if (!LAYOUT_CAPTURE_FACTORY) throw new Error('ChatGPT layout capture module was not loaded before content.js');
  const { handleLayoutCapture } = LAYOUT_CAPTURE_FACTORY.createLayoutCapture({
    isVisible,
    normalizeText,
    send,
  });


  async function handleStandaloneReconcile(payload) {
    const commandId = String(payload.commandId || '');
    const commandType = String(payload.commandType || '');
    const preconditions = payload.preconditions && typeof payload.preconditions === 'object' ? payload.preconditions : {};
    try {
      if (commandType === 'intelligence.apply') {
        const state = await readIntelligenceState({ includeModels: Boolean(String(preconditions.model || '')) });
        const expectedModel = String(preconditions.model || '');
        const expectedEffort = String(preconditions.effort || '');
        const modelMatches = !expectedModel || DOM_PARSER.intelligenceOptionMatches(state.selectedModel || {}, expectedModel);
        const effortMatches = !expectedEffort || DOM_PARSER.intelligenceOptionMatches(state.selectedEffort || {}, expectedEffort);
        send({
          type: 'standalone.reconciliation', commandId, commandType,
          outcome: modelMatches && effortMatches ? 'proved_succeeded' : 'unknown',
          evidence: {
            source: 'content.read_probe', modelMatches, effortMatches,
            selectedModel: state.selectedModel || null, selectedEffort: state.selectedEffort || null,
          },
        });
        return;
      }
      if (commandType === 'composer.attachments.clear') {
        const state = readComposerAttachmentState();
        send({
          type: 'standalone.reconciliation', commandId, commandType,
          outcome: state.known && state.count === 0 ? 'proved_succeeded' : 'unknown',
          evidence: { source: 'content.read_probe', attachmentState: state },
        });
        return;
      }
      send({ type: 'standalone.reconciliation', commandId, commandType, outcome: 'unknown', evidence: { source: 'content.read_probe', reason: 'unsupported_probe' } });
    } catch (error) {
      send({ type: 'standalone.reconciliation', commandId, commandType, outcome: 'unknown', evidence: { source: 'content.read_probe', error: error?.message || String(error) } });
    }
  }

  const SERVER_COMMAND_ROUTER_FACTORY = globalThis.ChatGptServerCommandRouter;
  if (!SERVER_COMMAND_ROUTER_FACTORY) throw new Error('ChatGPT server command router module was not loaded before content.js');
  const { handleServerMessage } = SERVER_COMMAND_ROUTER_FACTORY.createServerCommandRouter({
    CONTENT_SCRIPT_VERSION,
    EXTENSION_VERSION,
    applyCompatibilityStatus,
    compareVersionStrings,
    getActiveRequest,
    getBridgeVersion,
    getCurrentSession,
    handleArtifactFetch,
    handleBrowserTabClose, handleBrowserOwnedTabClose,
    handleBrowserTabOpen,
    handleBrowserTabReload,
    handleComposerAttachmentsClear,
    handleEffortsList,
    handleIntelligenceApply,
    handleStandaloneReconcile,
    handleExtensionReload,
    handleLayoutCapture,
    handleModelsList,
    handlePassivePromptSubmit,
    handlePromptCancel,
    handlePromptSend,
    handlePromptSteer,
    handleRequestRelease,
    handleRequestResume,
    handleEffectReconcile,
    handleResponseRecoverLatest,
    handleResponseRecoverList,
    handleResponseRecoverTurnKey,
    handleResponseSnapshotRequest,
    handleSessionsDelete,
    handleSessionsList,
    handleSessionsNew,
    handleSessionsSelect,
    pagePresence,
    publicRequestStatus,
    schedulePageStatus,
    send,
    setBridgeVersion,
    setConnectedServerInstanceId: (value) => { connectedServerInstanceId = value; },
    settleUnexecutableEffect,
    updatePanel,
  });

  try {
    chrome.runtime.onMessage?.addListener?.((message) => {
      if (message?.type !== 'extension.ui.open') return false;
      openFloatingPanel();
      return false;
    });
  } catch {}
  connect();
})();
