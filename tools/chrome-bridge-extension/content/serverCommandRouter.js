(() => {
  'use strict';

  const COMMAND_HANDLER_DEPENDENCIES = Object.freeze({
    'request.resume': 'handleRequestResume',
    'request.effect.reconcile': 'handleEffectReconcile',
    'prompt.send': 'handlePromptSend',
    'passive.prompt.submit': 'handlePassivePromptSubmit',
    'prompt.cancel': 'handlePromptCancel',
    'request.release': 'handleRequestRelease',
    'prompt.steer': 'handlePromptSteer',
    'sessions.list': 'handleSessionsList',
    'sessions.new': 'handleSessionsNew',
    'sessions.select': 'handleSessionsSelect',
    'sessions.delete': 'handleSessionsDelete',
    'browser.tab.open': 'handleBrowserTabOpen',
    'browser.tab.close': 'handleBrowserTabClose',
    'browser.tab.close-owned': 'handleBrowserOwnedTabClose',
    'browser.tab.reload': 'handleBrowserTabReload',
    'debug.layout.capture': 'handleLayoutCapture',
    'extension.reload': 'handleExtensionReload',
    'artifact.fetch': 'handleArtifactFetch',
    'response.snapshot.request': 'handleResponseSnapshotRequest',
    'response.recover.latest': 'handleResponseRecoverLatest',
    'response.recover.turnKey': 'handleResponseRecoverTurnKey',
    'response.recover.list': 'handleResponseRecoverList',
    'models.list': 'handleModelsList',
    'efforts.list': 'handleEffortsList',
    'intelligence.apply': 'handleIntelligenceApply',
    'composer.attachments.clear': 'handleComposerAttachmentsClear',
  });
  const ROUTED_COMMAND_TYPES = Object.freeze([...Object.keys(COMMAND_HANDLER_DEPENDENCIES), 'command.cancel']);

  function effectDescriptorFromPayload(input = {}) {
    if (input.effect && typeof input.effect === 'object') return input.effect;
    const plan = input.executionPlan && typeof input.executionPlan === 'object' ? input.executionPlan : null;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const startAtStepId = String(plan?.startAtStepId || '');
    return steps.find((step) => String(step?.stepId || '') === startAtStepId) || steps[0] || null;
  }

  function createServerCommandRouter(deps = {}) {
    const COMMAND_MANIFEST = globalThis.ChatGptBridgeCommandManifest;
    if (!COMMAND_MANIFEST) throw new Error('Browser command manifest was not loaded before serverCommandRouter');
    const {
      CONTENT_SCRIPT_VERSION, EXTENSION_VERSION, applyCompatibilityStatus, compareVersionStrings,
      getActiveRequest, getBridgeVersion, getCurrentSession, handleArtifactFetch, handleBrowserTabClose,
      handleBrowserOwnedTabClose, handleBrowserTabOpen, handleBrowserTabReload, handleComposerAttachmentsClear, handleEffortsList, handleIntelligenceApply, handleStandaloneReconcile,
      handleExtensionReload, handleLayoutCapture, handleModelsList, handlePassivePromptSubmit, handlePromptCancel, handlePromptSend,
      handlePromptSteer, handleRequestRelease, handleRequestResume, handleEffectReconcile, handleResponseRecoverLatest,
      handleResponseRecoverList, handleResponseRecoverTurnKey, handleResponseSnapshotRequest, handleSessionsDelete,
      handleSessionsList, handleSessionsNew, handleSessionsSelect, pagePresence, publicRequestStatus, schedulePageStatus,
      send, setBridgeVersion, setConnectedServerInstanceId, settleUnexecutableEffect, updatePanel,
    } = deps;

  const handlers = Object.freeze(Object.fromEntries(Object.entries(COMMAND_HANDLER_DEPENDENCIES)
    .map(([type, dependency]) => [type, deps[dependency]])));
  for (const [type, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') throw new Error(`Missing content command handler dependency for ${type}`);
  }
  const runtimeHandlerTypes = [...Object.keys(handlers), 'command.cancel'].sort();
  const manifestHandlerTypes = [...COMMAND_MANIFEST.commandTypes()].sort();
  if (runtimeHandlerTypes.length !== manifestHandlerTypes.length
    || runtimeHandlerTypes.some((type, index) => type !== manifestHandlerTypes[index])) {
    throw new Error(`Content command handlers do not match the shared command manifest: handlers=${runtimeHandlerTypes.join(',')} manifest=${manifestHandlerTypes.join(',')}`);
  }

  const runningCommands = new Map();

  function runAsyncCommand(handler, payload, options = {}) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const commandId = String(input.commandId || '');
    const controller = new AbortController();
    if (commandId) runningCommands.set(commandId, controller);
    Promise.resolve()
      .then(() => handler({ ...input, signal: controller.signal }))
      .catch(async (error) => {
        const requestId = String(input.requestId || '');
        if (options.effectBacked === true) {
          const descriptor = effectDescriptorFromPayload(input);
          let persisted = Boolean(error?.bridgeEffectReported);
          let settlementError = null;
          if (!persisted && !error?.bridgeEffectPersistenceFailure && typeof settleUnexecutableEffect === 'function' && descriptor) {
            try {
              await settleUnexecutableEffect({
                requestId,
                leaseId: String(input.leaseId || descriptor.preconditions?.leaseId || ''),
                ownerServerInstanceId: String(input.ownerServerInstanceId || descriptor.preconditions?.ownerServerInstanceId || ''),
                responseEpoch: Math.max(0, Number(input.responseEpoch ?? descriptor.responseEpoch ?? descriptor.preconditions?.responseEpoch) || 0),
                commandId,
                phase: 'content_handler_unhandled',
              }, String(descriptor.kind || input.type || ''), descriptor, error, {
                provenNotExecuted: false,
                evidence: { source: 'server_command_router', reason: 'unhandled_effect_handler_exception' },
              });
              persisted = true;
            } catch (cause) {
              settlementError = cause;
            }
          }
          send({
            type: 'diagnostic',
            diagnosticType: persisted ? 'effect.command.unhandled_error_settled' : 'effect.command.unhandled_error',
            commandId,
            requestId,
            effectId: String(descriptor?.effectId || ''),
            effectType: String(descriptor?.kind || input.type || ''),
            code: error?.name === 'AbortError' ? 'COMMAND_CANCELLED' : String(error?.code || ''),
            message: error?.message || String(error || 'Unknown content effect command error'),
            settlementError: settlementError?.message || '',
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

    if (payload.type === 'standalone.reconcile') {
      runAsyncCommand(handleStandaloneReconcile, payload);
      return;
    }

    const commandType = String(payload.type || '');
    const validation = COMMAND_MANIFEST.validateCommandPayload(commandType, payload, {
      requestScoped: payload.commandScope === 'request',
    });
    if (!validation.valid) {
      send({
        type: 'command.error',
        commandId: String(payload.commandId || ''),
        requestId: String(payload.requestId || ''),
        code: 'CONTENT_COMMAND_INVALID',
        message: validation.errors.join('; '),
      });
      return;
    }

    if (commandType === 'command.cancel') {
      handleCommandCancel(payload);
      return;
    }

    const handler = handlers[commandType];
    if (!handler) {
      send({
        type: 'command.error',
        commandId: String(payload.commandId || ''),
        requestId: String(payload.requestId || ''),
        code: 'CONTENT_COMMAND_HANDLER_MISSING',
        message: `No content handler exists for ${commandType}`,
      });
      return;
    }
    runAsyncCommand(handler, payload, { effectBacked: validation.definition.mode === 'effect' });
  }


    return Object.freeze({ handleServerMessage });
  }

  globalThis.ChatGptServerCommandRouter = Object.freeze({
    createServerCommandRouter,
    commandTypes: () => Object.freeze([...ROUTED_COMMAND_TYPES]),
  });
})();
