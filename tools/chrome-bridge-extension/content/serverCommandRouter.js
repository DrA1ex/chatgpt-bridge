(() => {
  'use strict';

  function createServerCommandRouter(deps = {}) {
    const {
      CONTENT_SCRIPT_VERSION, EXTENSION_VERSION, applyCompatibilityStatus, compareVersionStrings,
      getActiveRequest, getBridgeVersion, getCurrentSession, handleArtifactFetch, handleBrowserTabClose,
      handleBrowserOwnedTabClose, handleBrowserTabOpen, handleBrowserTabReload, handleComposerAttachmentsClear, handleEffortsList, handleIntelligenceApply,
      handleExtensionReload, handleLayoutCapture, handleModelsList, handlePassivePromptSubmit, handlePromptCancel, handlePromptSend,
      handlePromptSteer, handleRequestRelease, handleRequestResume, handleEffectReconcile, handleResponseRecoverLatest,
      handleResponseRecoverList, handleResponseRecoverTurnKey, handleResponseSnapshotRequest, handleSessionsDelete,
      handleSessionsList, handleSessionsNew, handleSessionsSelect, pagePresence, publicRequestStatus, schedulePageStatus,
      send, setBridgeVersion, setConnectedServerInstanceId, updatePanel,
    } = deps;

  const runningCommands = new Map();

  function runAsyncCommand(handler, payload, options = {}) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const commandId = String(input.commandId || '');
    const controller = new AbortController();
    if (commandId) runningCommands.set(commandId, controller);
    Promise.resolve()
      .then(() => handler({ ...input, signal: controller.signal }))
      .catch((error) => {
        const requestId = String(input.requestId || '');
        if (options.effectBacked === true) {
          send({
            type: 'diagnostic',
            diagnosticType: 'effect.command.unhandled_error',
            commandId,
            requestId,
            code: error?.name === 'AbortError' ? 'COMMAND_CANCELLED' : '',
            message: error?.message || String(error || 'Unknown content effect command error'),
          });
          return;
        }
        send({
          type: 'command.error',
          commandId,
          requestId,
          code: error?.name === 'AbortError' ? 'COMMAND_CANCELLED' : '',
          message: error?.message || String(error || 'Unknown content command error'),
        });
      })
      .finally(() => {
        if (commandId && runningCommands.get(commandId) === controller) runningCommands.delete(commandId);
      });
  }

  function handleCommandCancel(payload) {
    const commandId = String(payload.commandId || '');
    const targetCommandId = String(payload.targetCommandId || '');
    const controller = runningCommands.get(targetCommandId) || null;
    if (controller && !controller.signal.aborted) controller.abort(String(payload.reason || 'Command cancelled by server'));
    send({
      type: 'command.result',
      commandId,
      resultType: 'command.cancelled',
      targetCommandId,
      cancelled: Boolean(controller),
    });
  }

  function handleServerMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
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

    if (payload.type === 'command.cancel') {
      handleCommandCancel(payload);
      return;
    }

    if (payload.type === 'request.resume') {
      runAsyncCommand(handleRequestResume, payload);
      return;
    }

    if (payload.type === 'request.effect.reconcile') {
      runAsyncCommand(handleEffectReconcile, payload);
      return;
    }

    if (payload.type === 'prompt.send') {
      runAsyncCommand(handlePromptSend, payload, { effectBacked: true });
      return;
    }

    if (payload.type === 'passive.prompt.submit') {
      runAsyncCommand(handlePassivePromptSubmit, payload);
      return;
    }

    if (payload.type === 'prompt.cancel') {
      runAsyncCommand(handlePromptCancel, payload, { effectBacked: true });
      return;
    }

    if (payload.type === 'request.release') {
      runAsyncCommand(handleRequestRelease, payload);
      return;
    }

    if (payload.type === 'prompt.steer') {
      runAsyncCommand(handlePromptSteer, payload, { effectBacked: true });
      return;
    }

    if (payload.type === 'sessions.list') {
      runAsyncCommand(handleSessionsList, payload);
      return;
    }

    if (payload.type === 'sessions.new') {
      runAsyncCommand(handleSessionsNew, payload);
      return;
    }

    if (payload.type === 'sessions.select') {
      runAsyncCommand(handleSessionsSelect, payload);
      return;
    }

    if (payload.type === 'sessions.delete') {
      runAsyncCommand(handleSessionsDelete, payload);
      return;
    }

    if (payload.type === 'browser.tab.open') {
      runAsyncCommand(handleBrowserTabOpen, payload);
      return;
    }

    if (payload.type === 'browser.tab.close') {
      runAsyncCommand(handleBrowserTabClose, payload);
      return;
    }

    if (payload.type === 'browser.tab.close-owned') {
      runAsyncCommand(handleBrowserOwnedTabClose, payload);
      return;
    }

    if (payload.type === 'browser.tab.reload') {
      runAsyncCommand(handleBrowserTabReload, payload);
      return;
    }

    if (payload.type === 'debug.layout.capture') {
      runAsyncCommand(handleLayoutCapture, payload);
      return;
    }

    if (payload.type === 'extension.reload') {
      runAsyncCommand(handleExtensionReload, payload);
      return;
    }

    if (payload.type === 'artifact.fetch') {
      runAsyncCommand(handleArtifactFetch, payload);
      return;
    }

    if (payload.type === 'response.snapshot.request') {
      runAsyncCommand(handleResponseSnapshotRequest, payload);
      return;
    }

    if (payload.type === 'response.recover.latest') {
      runAsyncCommand(handleResponseRecoverLatest, payload);
      return;
    }

    if (payload.type === 'response.recover.turnKey') {
      runAsyncCommand(handleResponseRecoverTurnKey, payload);
      return;
    }

    if (payload.type === 'response.recover.list') {
      runAsyncCommand(handleResponseRecoverList, payload);
      return;
    }

    if (payload.type === 'models.list') {
      runAsyncCommand(handleModelsList, payload);
      return;
    }

    if (payload.type === 'efforts.list') {
      runAsyncCommand(handleEffortsList, payload);
      return;
    }

    if (payload.type === 'intelligence.apply') {
      runAsyncCommand(handleIntelligenceApply, payload);
      return;
    }

    if (payload.type === 'composer.attachments.clear') {
      runAsyncCommand(handleComposerAttachmentsClear, payload);
    }
  }


    return Object.freeze({ handleServerMessage });
  }

  globalThis.ChatGptServerCommandRouter = Object.freeze({ createServerCommandRouter });
})();
