(() => {
  'use strict';

  function createFeatureRuntime(deps = {}) {
    const {
      CONFIG, CONTENT_SCRIPT_VERSION, DOM_PARSER, EXTENSION_API, EXTENSION_VERSION, REQUEST_SNAPSHOT_POLICY, RUNTIME_CONFIG,
      armPageArtifactCapture, buttonSignalText, clickStopButton, delay, diagnostic, emitChatEvent, emitRequestProgress,
      enqueueArtifactAction, executionStore, extensionRequest, finalizationControlRoots, findChatMain, findComposer,
      findComposerRootStrict, findContinueButton, findSendButton, findStopButton, findTurnByKey, getActiveRequest,
      getExtensionPort, isUsableButton, isVisible, markRequestProgress, nextThinkingNodeToken, normalizeComparable,
      normalizeText, publicRequestStatus, readFinalizationSignals, readObservedTurnContext, runObservedRequestEffect,
      safeLaunchBridgeServerUrl, schedulePageStatus, scheduleTabObservation, send, setRequestPhase,
      shouldDeferFinalizationForSteer, subscribeTabObservation, thinkingNodeTokens, thinkingStateByTurn, unique, visibleText,
    } = deps;
    const RESPONSE_DOM_FACTORY = globalThis.ChatGptResponseDom;
    const ARTIFACT_DOM_FACTORY = globalThis.ChatGptArtifactDom;
    const TURN_SNAPSHOTS_FACTORY = globalThis.ChatGptTurnSnapshots;
    const REQUEST_MONITOR_FACTORY = globalThis.ChatGptRequestMonitor;
    const SESSION_COMMANDS_FACTORY = globalThis.ChatGptSessionCommands;
    const INTELLIGENCE_COMMANDS_FACTORY = globalThis.ChatGptIntelligenceCommands;
    const REQUEST_PREPARATION_FACTORY = globalThis.ChatGptRequestPreparation;
    const RESPONSE_RECOVERY_FACTORY = globalThis.ChatGptResponseRecovery;
    const ARTIFACT_PREVIEW_FACTORY = globalThis.ChatGptArtifactPreview;
    const ARTIFACT_TRANSFER_FACTORY = globalThis.ChatGptArtifactTransfer;
    if (![RESPONSE_DOM_FACTORY, ARTIFACT_DOM_FACTORY, TURN_SNAPSHOTS_FACTORY, REQUEST_MONITOR_FACTORY, SESSION_COMMANDS_FACTORY,
      INTELLIGENCE_COMMANDS_FACTORY, REQUEST_PREPARATION_FACTORY, RESPONSE_RECOVERY_FACTORY, ARTIFACT_PREVIEW_FACTORY,
      ARTIFACT_TRANSFER_FACTORY].every(Boolean)) throw new Error('ChatGPT feature runtime dependencies were not loaded before content.js');

    const responseDom = RESPONSE_DOM_FACTORY.createResponseDom({ DOM_PARSER, isVisible, normalizeText, visibleText });
    const artifactDom = ARTIFACT_DOM_FACTORY.createArtifactDom({
      DOM_PARSER,
      actionSelectorHint: responseDom.actionSelectorHint,
      guessMime: responseDom.guessMime,
      guessNameFromUrl: responseDom.guessNameFromUrl,
      isUsableButton,
      isVisible,
      normalizeText,
      simpleHash: responseDom.simpleHash,
      visibleText,
    });
    let sessionApi = null;
    let preparationApi = null;
    let transferApi = null;
    const turnApi = TURN_SNAPSHOTS_FACTORY.createTurnSnapshots({
      DOM_PARSER,
      buttonSignalText,
      collectArtifactsForAssistantNode: artifactDom.collectArtifactsForAssistantNode,
      collectArtifactsFromNode: artifactDom.collectArtifactsFromNode,
      codeUiActionText: responseDom.codeUiActionText,
      conversationIdFromUrl: (...args) => sessionApi?.conversationIdFromUrl(...args),
      createResponseParserPass: responseDom.createResponseParserPass,
      delay,
      diagnostic,
      domPathForNode: responseDom.domPathForNode,
      emitChatEvent,
      extractResponseBlocks: responseDom.extractResponseBlocks,
      finalizationControlRoots,
      findChatMain,
      findContinueButton,
      findSendButton,
      findStopButton,
      getActiveRequest,
      isVisible,
      mergeParserAudits: responseDom.mergeParserAudits,
      nextThinkingNodeToken,
      normalizeMarkdown: responseDom.normalizeMarkdown,
      normalizeText,
      parserAuditForRoot: responseDom.parserAuditForRoot,
      safeOuterHtml: responseDom.safeOuterHtml,
      setRequestPhase,
      simpleHash: responseDom.simpleHash,
      thinkingNodeTokens,
      thinkingStateByTurn,
      visibleText,
    });
    const isGenerating = () => Boolean(findStopButton());
    const monitorApi = REQUEST_MONITOR_FACTORY.createRequestMonitor({
      CONFIG,
      DOM_PARSER,
      REQUEST_SNAPSHOT_POLICY,
      conversationIdFromUrl: (...args) => sessionApi?.conversationIdFromUrl(...args),
      diagnostic,
      domPathForNode: responseDom.domPathForNode,
      emitChatEvent,
      emitRequestProgress,
      findChatMain,
      findTurnByKey,
      getActiveRequest,
      getAssistantNodes: turnApi.getAssistantNodes,
      getCurrentSession: (...args) => sessionApi?.getCurrentSession(...args),
      getTurnNodes: turnApi.getTurnNodes,
      isGenerating,
      markRequestProgress,
      readAssistantSnapshot: turnApi.readAssistantSnapshot,
      readRecentAssistantSnapshots: turnApi.readRecentAssistantSnapshots,
      readFinalizationSignals,
      refreshRequestTurnAnchors: turnApi.refreshRequestTurnAnchors,
      schedulePageStatus,
      scheduleTabObservation,
      send,
      setActiveRequest: (request) => executionStore.setCurrent(request),
      setRequestPhase,
      shouldDeferFinalizationForSteer,
      subscribeTabObservation,
    });
    sessionApi = SESSION_COMMANDS_FACTORY.createSessionCommands({
      CONFIG,
      CONTENT_SCRIPT_VERSION,
      DOM_PARSER,
      EXTENSION_VERSION,
      chatPageReadiness: (...args) => preparationApi?.chatPageReadiness(...args),
      delay,
      diagnostic,
      extensionRequest,
      isVisible,
      safeLaunchBridgeServerUrl,
      schedulePageStatus,
      stageTemporaryConnectionOverride: (...args) => RUNTIME_CONFIG.stageTemporaryConnectionOverride(EXTENSION_API, CONFIG, ...args),
      send,
      visibleText,
      waitForDocumentReady: (...args) => preparationApi?.waitForDocumentReady(...args),
    });
    const intelligenceApi = INTELLIGENCE_COMMANDS_FACTORY.createIntelligenceCommands({
      DOM_PARSER, buttonSignalText, delay, diagnostic, findComposer, findComposerRootStrict, isUsableButton, isVisible,
      normalizeComparable, normalizeText, send, unique, visibleText,
    });
    preparationApi = REQUEST_PREPARATION_FACTORY.createRequestPreparation({
      CONFIG,
      DOM_PARSER,
      INTELLIGENCE_UI_TIMING: intelligenceApi.INTELLIGENCE_UI_TIMING,
      delay,
      diagnostic,
      domPathForNode: responseDom.domPathForNode,
      emitChatEvent,
      findChatMain,
      findComposer,
      isVisible,
      openNewSession: sessionApi.openNewSession,
      readIntelligenceState: intelligenceApi.readIntelligenceState,
      schedulePageStatus,
      selectSessionById: sessionApi.selectSessionById,
      send,
      trySelectIntelligenceOption: intelligenceApi.trySelectIntelligenceOption,
    });
    async function handleIntelligenceApply(payload) {
      try {
        const result = await preparationApi.applyModelOptions(payload.options || {}, { requestId: `intelligence-${payload.commandId || Date.now()}` }, { emitEvents: false });
        send({ type: 'intelligence.applied', commandId: payload.commandId, ...result });
      } catch (err) {
        send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
      }
    }
    const recoveryApi = RESPONSE_RECOVERY_FACTORY.createResponseRecovery({
      DOM_PARSER,
      REQUEST_SNAPSHOT_POLICY,
      diagnostic,
      findStopButton,
      getActiveRequest,
      getCurrentSession: sessionApi.getCurrentSession,
      isGenerating,
      normalizeText,
      publicRequestStatus,
      readObservedTurnContext,
      readAssistantSnapshot: turnApi.readAssistantSnapshot,
      readAssistantSnapshotByTurnKey: turnApi.readAssistantSnapshotByTurnKey,
      readLatestAssistantSnapshot: turnApi.readLatestAssistantSnapshot,
      readRecentAssistantSnapshots: turnApi.readRecentAssistantSnapshots,
      refreshRequestTurnAnchors: turnApi.refreshRequestTurnAnchors,
      send,
    });
    const previewApi = ARTIFACT_PREVIEW_FACTORY.createArtifactPreview({
      CONFIG,
      DOM_PARSER,
      arrayBufferToBase64: (...args) => transferApi?.arrayBufferToBase64(...args),
      artifactSourceRoot: (...args) => transferApi?.artifactSourceRoot(...args),
      collectArtifactsFromNode: artifactDom.collectArtifactsFromNode,
      delay,
      diagnostic,
      isUsableButton,
      isVisible,
      normalizeComparable,
      normalizeText,
      unique,
    });
    transferApi = ARTIFACT_TRANSFER_FACTORY.createArtifactTransfer({
      CONFIG,
      DOM_PARSER,
      EXTENSION_API,
      armPageArtifactCapture,
      artifactFileName: artifactDom.artifactFileName,
      artifactLocatorMeta: artifactDom.artifactLocatorMeta,
      closeArtifactPreview: previewApi.closeArtifactPreview,
      closeVisibleArtifactPreviewsBeforeAction: previewApi.closeVisibleArtifactPreviewsBeforeAction,
      collectArtifactsFromNode: artifactDom.collectArtifactsFromNode,
      delay,
      diagnostic,
      enqueueArtifactAction,
      extensionRequest,
      findTurnByKey,
      getActiveRequest,
      getExtensionPort,
      guessMime: responseDom.guessMime,
      guessNameFromUrl: responseDom.guessNameFromUrl,
      isBrowserOnlyArtifactUrl: artifactDom.isBrowserOnlyArtifactUrl,
      isCurrentPageNavigationUrl: artifactDom.isCurrentPageNavigationUrl,
      isExcludedArtifactAction: artifactDom.isExcludedArtifactAction,
      isUsableButton,
      isVisible,
      materializeArtifactPreview: previewApi.materializeArtifactPreview,
      normalizeComparable,
      queryAllWithSelf: artifactDom.queryAllWithSelf,
      runObservedRequestEffect,
      send,
      visibleArtifactPreviewContainers: previewApi.visibleArtifactPreviewContainers,
      waitForLateArtifactPreview: previewApi.waitForLateArtifactPreview,
    });
    return Object.freeze({
      ...responseDom,
      ...artifactDom,
      ...turnApi,
      ...monitorApi,
      ...sessionApi,
      ...intelligenceApi,
      ...preparationApi,
      ...recoveryApi,
      ...transferApi,
      handleIntelligenceApply,
      isGenerating,
    });
  }

  globalThis.ChatGptContentFeatureRuntime = Object.freeze({ createFeatureRuntime });
})();
