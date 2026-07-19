import { MessageKind } from './protocolV4.js';


function normalizeCommandResultPayload(payload = {}) {
  const commandId = String(payload?.commandId || '');
  const type = String(payload?.type || '');
  if (!commandId) return payload;
  if (type === 'command.result' || type === 'command.progress' || type === 'command.error' || type === 'command.rejected') return payload;
  if (type === 'request.release.completed' || type.startsWith('request.effect.')
    || type === 'prompt.accepted' || type === 'prompt.cancelled') return payload;
  if (type === 'artifact.data.started' || type === 'artifact.data.chunk') {
    return { ...payload, type: 'command.progress', progressType: type };
  }
  return { ...payload, type: 'command.result', resultType: type };
}

async function settlePersistedCommand(backgroundState, state, payload) {
  const commandId = String(payload?.commandId || '');
  if (!commandId || payload.type === 'command.progress') return null;
  const runtime = await backgroundState.read(state.tabId);
  const command = runtime.commands?.[commandId] || null;
  if (!command) return null;
  const rejected = payload.type === 'command.error' || payload.type === 'command.rejected' || Boolean(payload.error);
  const outcome = await backgroundState.transition(state.tabId, {
    type: rejected ? 'command.rejected' : 'command.succeeded',
    commandId,
    resultType: String(payload.resultType || payload.type || ''),
    error: rejected ? { code: String(payload.code || 'COMMAND_REJECTED'), message: String(payload.message || payload.error || 'Command rejected') } : null,
    contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted && outcome.reason !== 'command_terminal') {
    throw new Error(`Browser command settlement rejected: ${outcome.reason}`);
  }
  return outcome.state.commands?.[commandId] || command;
}

async function reportPersistedCommand(backgroundState, state, commandId) {
  if (!commandId) return;
  const outcome = await backgroundState.transition(state.tabId, {
    type: 'command.reported', commandId, contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted && !['command_already_reported', 'command_missing'].includes(outcome.reason)) {
    throw new Error(`Browser command report rejected: ${outcome.reason}`);
  }
}

async function releaseCommandScopedLease(backgroundState, state, command) {
  if (!command?.releaseOnResult) return;
  const runtime = await backgroundState.read(state.tabId);
  if (!runtime.lease || runtime.lease.requestId !== command.requestId || runtime.lease.leaseId !== command.leaseId) return;
  const outcome = await backgroundState.transition(state.tabId, {
    type: 'lease.release',
    requestId: command.requestId,
    leaseId: command.leaseId,
    ownerServerInstanceId: command.ownerServerInstanceId,
    contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted) throw new Error(`Command-scoped lease release rejected: ${outcome.reason}`);
}

function reply(post, port, requestId, result, error = null, type = 'extension.response') {
  post(port, error
    ? { type, requestId, error: error.message || String(error) }
    : { type, requestId, result });
}

function conversationIdFromUrl(url = '') {
  try { return new URL(String(url || '')).pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ''; } catch { return ''; }
}

function observedConversationIdentity(payload = {}) {
  const url = String(payload.observation?.url || payload.url || '');
  const id = String(payload.observation?.conversationId
    || payload.session?.id
    || conversationIdFromUrl(url));
  return { id, url };
}

async function reconcileReloadedNavigationCommands(backgroundState, state, payload, sendProtocolPayload) {
  if (!['hello', 'tab.observation'].includes(String(payload?.type || ''))) return;
  const current = observedConversationIdentity(payload);
  if (!current.id && !current.url) return;
  const runtime = await backgroundState.read(state.tabId);
  for (const command of (runtime.commandOrder || []).map((id) => runtime.commands?.[id]).filter(Boolean)) {
    if (command.status !== 'dispatched' || command.reportedAt || command.commandType !== 'sessions.delete') continue;
    const expectedConversationId = String(command.preconditions?.conversationId || '');
    if (!expectedConversationId || current.id === expectedConversationId || conversationIdFromUrl(current.url) === expectedConversationId) continue;
    const settled = await backgroundState.transition(state.tabId, {
      type: 'command.succeeded',
      commandId: command.commandId,
      resultType: 'session.deleted',
      contentEpoch: state.contentEpoch,
    });
    if (!settled.accepted) throw new Error(`Reloaded session deletion settlement rejected: ${settled.reason}`);
    await sendProtocolPayload(state, {
      type: 'command.result',
      commandId: command.commandId,
      requestId: command.requestId,
      resultType: 'session.deleted',
      deleted: true,
      deletedSessionId: expectedConversationId,
      afterSessionId: current.id,
      url: current.url,
      releaseLease: Boolean(command.releaseOnResult),
      reconciledAfterReload: true,
    }, {
      kind: MessageKind.COMMAND_RESULT,
      lease: {
        requestId: command.requestId,
        leaseId: command.leaseId,
        ownerServerInstanceId: command.ownerServerInstanceId,
      },
    });
    await reportPersistedCommand(backgroundState, state, command.commandId);
    await releaseCommandScopedLease(backgroundState, state, command);
  }
}

export const handlePayload = async function handlePayload(deps, port, state, payload) {
  const { backgroundState, post, sendProtocolPayload } = deps;
  if (payload.type !== 'hello' && !state.protocolReady) {
    state.preHelloPayloads = [...(state.preHelloPayloads || []), payload].slice(-100);
    return;
  }
  if (payload.type === 'request.release.completed') {
    const runtime = await backgroundState.read(state.tabId);
    const requestId = String(payload.requestId || '');
    const releaseLease = {
      requestId,
      leaseId: String(payload.leaseId || runtime.lease?.leaseId || ''),
      ownerServerInstanceId: String(payload.ownerServerInstanceId || runtime.lease?.ownerServerInstanceId || ''),
    };
    if (runtime.lease && runtime.lease.requestId !== requestId) {
      await sendProtocolPayload(state, {
        type: 'command.error', commandId: payload.commandId, requestId,
        error: 'Browser lease belongs to another request',
      }, { kind: MessageKind.COMMAND_REJECTED, lease: releaseLease });
      return;
    }
    const settledCommand = await settlePersistedCommand(backgroundState, state, {
      type: 'command.result', commandId: payload.commandId, requestId, resultType: 'request.release.completed',
    });
    if (runtime.lease) {
      const released = await backgroundState.transition(state.tabId, {
        type: 'lease.release', requestId,
        leaseId: runtime.lease.leaseId,
        ownerServerInstanceId: runtime.lease.ownerServerInstanceId,
        contentEpoch: state.contentEpoch,
      });
      if (!released.accepted) throw new Error(`Browser lease release rejected: ${released.reason}`);
    }
    await sendProtocolPayload(state, {
      type: 'command.result', commandId: payload.commandId, requestId,
      resultType: 'request.release.completed', releaseLease: true,
      released: payload.released !== false, activeRequest: null,
    }, { kind: MessageKind.COMMAND_RESULT, lease: releaseLease });
    await reportPersistedCommand(backgroundState, state, settledCommand?.commandId || String(payload.commandId || ''));
    return;
  }
  await reconcileReloadedNavigationCommands(backgroundState, state, payload, sendProtocolPayload);
  let outboundPayload = normalizeCommandResultPayload(payload);
  const settledCommand = await settlePersistedCommand(backgroundState, state, outboundPayload);
  if (settledCommand?.releaseOnResult) outboundPayload = { ...outboundPayload, releaseLease: true };
  await sendProtocolPayload(state, outboundPayload);
  if (settledCommand) {
    await reportPersistedCommand(backgroundState, state, settledCommand.commandId);
    await releaseCommandScopedLease(backgroundState, state, settledCommand);
  }
  if (payload.type === 'hello') {
    await deps.replayCriticalOutbox(state);
    state.protocolReady = true;
    const queued = state.preHelloPayloads || [];
    state.preHelloPayloads = [];
    for (const queuedPayload of queued) {
      let queuedOutbound = normalizeCommandResultPayload(queuedPayload);
      const queuedCommand = await settlePersistedCommand(backgroundState, state, queuedOutbound);
      if (queuedCommand?.releaseOnResult) queuedOutbound = { ...queuedOutbound, releaseLease: true };
      await sendProtocolPayload(state, queuedOutbound);
      if (queuedCommand) {
        await reportPersistedCommand(backgroundState, state, queuedCommand.commandId);
        await releaseCommandScopedLease(backgroundState, state, queuedCommand);
      }
    }
    const runtime = await backgroundState.read(state.tabId);
    for (const effect of runtime.effectOrder.map((id) => runtime.effects[id]).filter(Boolean)) {
      let recovered = effect;
      if (effect.status === 'dispatched') {
        const uncertain = await backgroundState.transition(state.tabId, {
          type: 'effect.uncertain',
          requestId: runtime.lease?.requestId || effect.requestId,
          leaseId: runtime.lease?.leaseId || effect.leaseId,
          ownerServerInstanceId: runtime.lease?.ownerServerInstanceId || '',
          effectId: effect.effectId,
          idempotencyKey: effect.idempotencyKey,
          error: { code: 'CONTENT_RELOADED_DURING_EFFECT', message: 'Content runtime reloaded before the browser effect result was confirmed' },
          contentEpoch: state.contentEpoch,
        });
        if (!uncertain.accepted) continue;
        recovered = uncertain.state.effects[effect.effectId];
      }
      if (!['succeeded', 'failed', 'uncertain'].includes(recovered.status) || recovered.reportedAt) continue;
      const uncertain = recovered.status === 'uncertain';
      await sendProtocolPayload(state, {
        type: `request.effect.${recovered.status}`,
        requestId: effect.requestId,
        effectId: effect.effectId,
        effectType: effect.kind,
        idempotencyKey: effect.idempotencyKey,
        retryPolicy: effect.retryPolicy,
        preconditions: effect.preconditions || {},
        evidence: effect.evidence || null,
        result: recovered.result || null,
        ...(recovered.status === 'succeeded' ? {} : {
          code: String(recovered.error?.code || (uncertain ? 'CONTENT_RELOADED_DURING_EFFECT' : 'BROWSER_EFFECT_FAILED')),
          message: String(recovered.error?.message || (uncertain ? 'Content runtime reloaded before the browser effect result was confirmed' : 'Browser effect failed')),
        }),
        recoverable: uncertain,
      }, { kind: uncertain ? MessageKind.EFFECT_UNCERTAIN : MessageKind.EFFECT_RESULT });
    }
    const commandRuntime = await backgroundState.read(state.tabId);
    for (const command of (commandRuntime.commandOrder || []).map((id) => commandRuntime.commands?.[id]).filter(Boolean)) {
      let recovered = command;
      if (command.status === 'dispatched' && command.commandType === 'sessions.delete') {
        continue;
      }
      if (command.status === 'dispatched') {
        const uncertain = await backgroundState.transition(state.tabId, {
          type: 'command.uncertain', commandId: command.commandId,
          error: { code: 'CONTENT_RELOADED_DURING_COMMAND', message: 'Content runtime reloaded before command completion was confirmed' },
          contentEpoch: state.contentEpoch,
        });
        if (!uncertain.accepted) continue;
        recovered = uncertain.state.commands?.[command.commandId] || command;
      }
      if (recovered.status !== 'uncertain' || recovered.reportedAt) continue;
      await sendProtocolPayload(state, {
        type: 'command.error',
        commandId: recovered.commandId,
        requestId: recovered.requestId,
        code: 'CONTENT_RELOADED_DURING_COMMAND',
        message: 'Content runtime reloaded before command completion was confirmed',
        releaseLease: Boolean(recovered.releaseOnResult),
      }, {
        kind: MessageKind.COMMAND_REJECTED,
        lease: {
          requestId: recovered.requestId,
          leaseId: recovered.leaseId,
          ownerServerInstanceId: recovered.ownerServerInstanceId,
        },
      });
      await reportPersistedCommand(backgroundState, state, recovered.commandId);
      await releaseCommandScopedLease(backgroundState, state, recovered);
    }
  }
  return;
};

async function handleEffect(deps, state, message) {
  const runtime = await deps.backgroundState.read(state.tabId);
  if (message.type === 'bridge.effect.plan') {
    const planned = await deps.backgroundState.transition(state.tabId, {
      type: 'effect.planned',
      requestId: String(message.browserRequestId || runtime.lease?.requestId || ''),
      leaseId: String(message.leaseId || runtime.lease?.leaseId || ''),
      ownerServerInstanceId: String(message.ownerServerInstanceId || runtime.lease?.ownerServerInstanceId || ''),
      effectId: String(message.effectId || ''),
      idempotencyKey: String(message.idempotencyKey || ''),
      kind: String(message.kind || message.effectType || ''),
      retryPolicy: String(message.retryPolicy || ''),
      preconditions: message.preconditions || {},
      evidence: message.evidence || null,
      contentEpoch: state.contentEpoch,
    });
    if (!planned.accepted) throw new Error(`Browser effect plan rejected: ${planned.reason}`);
    const dispatched = await deps.backgroundState.transition(state.tabId, {
      type: 'effect.dispatched',
      requestId: planned.state.lease?.requestId || '',
      leaseId: planned.state.lease?.leaseId || '',
      ownerServerInstanceId: planned.state.lease?.ownerServerInstanceId || '',
      effectId: String(message.effectId || ''),
      idempotencyKey: String(message.idempotencyKey || ''),
      contentEpoch: state.contentEpoch,
    });
    if (!dispatched.accepted) throw new Error(`Browser effect dispatch rejected: ${dispatched.reason}`);
    return { persisted: true, effect: dispatched.state.effects[message.effectId] };
  }
  const status = ['succeeded', 'failed', 'uncertain'].includes(message.status) ? message.status : 'uncertain';
  const outcome = await deps.backgroundState.transition(state.tabId, {
    type: `effect.${status}`,
    requestId: runtime.lease?.requestId || '',
    leaseId: runtime.lease?.leaseId || '',
    ownerServerInstanceId: runtime.lease?.ownerServerInstanceId || '',
    effectId: String(message.effectId || ''),
    idempotencyKey: String(message.idempotencyKey || ''),
    result: message.result || null,
    error: message.error || null,
    contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted) throw new Error(`Browser effect result rejected: ${outcome.reason}`);
  return { persisted: true, effect: outcome.state.effects[message.effectId] };
}

export function installBackgroundPortRouter(deps) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chatgpt-bridge-tab') return;
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      const tabId = port?.sender?.tab?.id ?? null;
      void deps.tabOperations.run(tabId, async () => {
      if (message.type === 'bridge.connect') {
        const adopted = await deps.adoptPageLaunchMetadata(port, message.page || {});
        const launch = adopted || await deps.readLaunchedTab(port?.sender?.tab?.id ?? null);
        deps.connectWebSocket(port, { ...message, serverUrl: deps.safeBridgeServerUrl(launch?.serverUrl || message.serverUrl) || message.serverUrl });
        return;
      }
      try {
        if (message.type === 'bridge.payload') {
          const state = deps.connections.get(port);
          if (!state) throw new Error('Extension transport is not connected');
          await handlePayload(deps, port, state, message.payload || {});
          return;
        }
        if (message.type === 'bridge.effect.plan' || message.type === 'bridge.effect.settle') {
          const state = deps.connections.get(port);
          if (!state) throw new Error('Extension transport is not connected');
          reply(deps.post, port, message.requestId, await handleEffect(deps, state, message));
          return;
        }
        const operation = {
          'bridge.download.capture.begin': () => deps.beginDownloadCapture(port, message),
          'bridge.download.capture.add_expected_names': () => deps.addDownloadCaptureExpectedNames(port, String(message.captureId || ''), message.expectedNames || []),
          'bridge.download.capture.start': () => deps.startDownloadCapture(port, String(message.captureId || ''), message.url),
          'bridge.download.capture.wait': () => deps.waitDownloadCapture(port, String(message.captureId || ''), message.timeoutMs),
          'bridge.download.capture.wait_bound': () => deps.waitDownloadCaptureBound(port, String(message.captureId || ''), message.timeoutMs),
          'bridge.download.capture.release': () => deps.releaseDownloadCapture(port, String(message.captureId || ''), String(message.reason || 'released'), message.graceMs),
          'bridge.download.capture.cancel': () => deps.cancelDownloadCapture(port, String(message.captureId || ''), String(message.reason || 'cancelled')),
          'bridge.tab.open': () => deps.openBridgeTab(port, message),
          'bridge.tab.close': () => deps.closeOwnBridgeTab(port, message),
          'bridge.tab.close-owned': () => deps.closeOwnedBridgeTab(port, message),
          'bridge.tab.reload': () => deps.reloadOwnBridgeTab(port, message),
          'bridge.extension.reload': () => deps.scheduleExtensionReload(message),
        }[message.type];
        if (operation) {
          reply(deps.post, port, message.requestId, await operation());
          return;
        }
        if (message.type === 'bridge.http') {
          reply(deps.post, port, message.requestId, await deps.performHttp(message.request || {}), null, 'bridge.http.result');
        }
      } catch (error) {
        reply(deps.post, port, message.requestId, null, error, message.type === 'bridge.http' ? 'bridge.http.result' : 'extension.response');
      }
      }, { label: `content:${message.type || 'unknown'}` }).catch((error) => {
        reply(deps.post, port, message.requestId, null, error, message.type === 'bridge.http' ? 'bridge.http.result' : 'extension.response');
      });
    });

    port.onDisconnect.addListener(() => {
      const state = deps.connections.get(port);
      if (state) state.closed = true;
      for (const capture of deps.downloadCaptures.values()) {
        if (!capture.done && deps.portMatches(capture.port, port)) capture.port = null;
      }
      deps.closeConnection(port, 'content-disconnected');
    });
  });
}
