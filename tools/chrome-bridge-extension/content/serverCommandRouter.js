(() => {
  'use strict';

  function createServerCommandRouter(deps = {}) {
    const {
      CONTENT_SCRIPT_VERSION, EXTENSION_VERSION, applyCompatibilityStatus, compareVersionStrings,
      getActiveRequest, getBridgeVersion, getCurrentSession, handleArtifactFetch, handleBrowserTabClose,
      handleBrowserOwnedTabClose, handleBrowserTabOpen, handleBrowserTabReload, handleComposerAttachmentsClear, handleEffortsList, handleIntelligenceApply,
      handleExtensionReload, handleModelsList, handlePassivePromptSubmit, handlePromptCancel, handlePromptSend,
      handlePromptSteer, handleRequestRelease, handleRequestResume, handleEffectReconcile, handleResponseRecoverLatest,
      handleResponseRecoverList, handleResponseRecoverTurnKey, handleResponseSnapshotRequest, handleSessionsDelete,
      handleSessionsList, handleSessionsNew, handleSessionsSelect, pagePresence, publicRequestStatus, schedulePageStatus,
      send, setBridgeVersion, setConnectedServerInstanceId, updatePanel,
    } = deps;

  function handleServerMessage(payload) {
    if (payload.type === 'server.hello') {
      setConnectedServerInstanceId(String(payload.serverInstanceId || ''));
      setBridgeVersion(String(payload.bridgeVersion || ''));
      const requirements = payload.extensionCompatibility && typeof payload.extensionCompatibility === 'object' ? payload.extensionCompatibility : null;
      if (requirements?.minExtensionVersion) {
        const extensionComparison = compareVersionStrings(EXTENSION_VERSION, requirements.minExtensionVersion);
        const contentComparison = compareVersionStrings(CONTENT_SCRIPT_VERSION, requirements.minContentVersion || '0.0.0');
        if (extensionComparison == null || extensionComparison < 0 || contentComparison == null || contentComparison < 0) {
          applyCompatibilityStatus({
            compatible: false,
            status: 'extension_outdated',
            message: `Extension ${EXTENSION_VERSION || 'unknown'} is older than required ${requirements.minExtensionVersion}. Reload the extension package from bridge ${getBridgeVersion() || 'server'}.`,
            ...requirements,
            extensionVersion: EXTENSION_VERSION,
            contentVersion: CONTENT_SCRIPT_VERSION,
          }, 'extension update required');
        }
      }
      schedulePageStatus('page.status', 0);
      updatePanel();
      return;
    }

    if (payload.type === 'extension.compatibility' || payload.type === 'extension.status') {
      applyCompatibilityStatus(payload.compatibility || {
        compatible: payload.compatible !== false,
        status: payload.status || '',
        message: payload.detail || '',
      }, payload.status || 'extension status');
      return;
    }

    if (payload.type === 'ping') {
      send({ type: 'pong', time: Date.now(), url: location.href, title: document.title, session: getCurrentSession(), activeRequest: getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null, ...pagePresence() });
      return;
    }

    if (payload.type === 'request.resume') {
      handleRequestResume(payload);
      return;
    }

    if (payload.type === 'request.effect.reconcile') {
      void handleEffectReconcile(payload);
      return;
    }

    if (payload.type === 'prompt.send') {
      void handlePromptSend(payload);
      return;
    }

    if (payload.type === 'passive.prompt.submit') {
      void handlePassivePromptSubmit(payload);
      return;
    }

    if (payload.type === 'prompt.cancel') {
      handlePromptCancel(payload);
      return;
    }

    if (payload.type === 'request.release') {
      handleRequestRelease(payload);
      return;
    }

    if (payload.type === 'prompt.steer') {
      void handlePromptSteer(payload);
      return;
    }

    if (payload.type === 'sessions.list') {
      handleSessionsList(payload);
      return;
    }

    if (payload.type === 'sessions.new') {
      void handleSessionsNew(payload);
      return;
    }

    if (payload.type === 'sessions.select') {
      void handleSessionsSelect(payload);
      return;
    }

    if (payload.type === 'sessions.delete') {
      void handleSessionsDelete(payload);
      return;
    }

    if (payload.type === 'browser.tab.open') {
      void handleBrowserTabOpen(payload);
      return;
    }

    if (payload.type === 'browser.tab.close') {
      void handleBrowserTabClose(payload);
      return;
    }

    if (payload.type === 'browser.tab.close-owned') {
      void handleBrowserOwnedTabClose(payload);
      return;
    }

    if (payload.type === 'browser.tab.reload') {
      handleBrowserTabReload(payload);
      return;
    }

    if (payload.type === 'extension.reload') {
      void handleExtensionReload(payload);
      return;
    }

    if (payload.type === 'artifact.fetch') {
      void handleArtifactFetch(payload);
      return;
    }

    if (payload.type === 'response.snapshot.request') {
      handleResponseSnapshotRequest(payload);
      return;
    }

    if (payload.type === 'response.recover.latest') {
      handleResponseRecoverLatest(payload);
      return;
    }

    if (payload.type === 'response.recover.turnKey') {
      handleResponseRecoverTurnKey(payload);
      return;
    }

    if (payload.type === 'response.recover.list') {
      handleResponseRecoverList(payload);
      return;
    }

    if (payload.type === 'models.list') {
      void handleModelsList(payload);
      return;
    }

    if (payload.type === 'efforts.list') {
      void handleEffortsList(payload);
      return;
    }

    if (payload.type === 'intelligence.apply') {
      void handleIntelligenceApply(payload);
      return;
    }

    if (payload.type === 'composer.attachments.clear') {
      void handleComposerAttachmentsClear(payload);
    }
  }


    return Object.freeze({ handleServerMessage });
  }

  globalThis.ChatGptServerCommandRouter = Object.freeze({ createServerCommandRouter });
})();
