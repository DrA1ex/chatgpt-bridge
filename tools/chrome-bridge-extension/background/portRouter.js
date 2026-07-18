import { MessageKind } from './protocolV4.js';

function reply(post, port, requestId, result, error = null, type = 'extension.response') {
  post(port, error
    ? { type, requestId, error: error.message || String(error) }
    : { type, requestId, result });
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
      released: payload.released !== false, activeRequest: null,
    }, { kind: MessageKind.COMMAND_RESULT, lease: releaseLease });
    return;
  }
  await sendProtocolPayload(state, payload);
  if (payload.type === 'hello') {
    await deps.replayCriticalOutbox(state);
    state.protocolReady = true;
    const queued = state.preHelloPayloads || [];
    state.preHelloPayloads = [];
    for (const queuedPayload of queued) await sendProtocolPayload(state, queuedPayload);
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
        result: recovered.result || null,
        ...(recovered.status === 'succeeded' ? {} : {
          code: String(recovered.error?.code || (uncertain ? 'CONTENT_RELOADED_DURING_EFFECT' : 'BROWSER_EFFECT_FAILED')),
          message: String(recovered.error?.message || (uncertain ? 'Content runtime reloaded before the browser effect result was confirmed' : 'Browser effect failed')),
        }),
        recoverable: uncertain,
      }, { kind: uncertain ? MessageKind.EFFECT_UNCERTAIN : MessageKind.EFFECT_RESULT });
    }
  }
  const contentReleased = payload.type === 'diagnostic' && payload.name === 'request.released' && payload.requestId;
  const passiveSubmitted = payload.type === 'passive.prompt.submitted';
  if (!contentReleased && !passiveSubmitted) return;
  const runtime = await backgroundState.read(state.tabId);
  const requestId = String(payload.requestId || `passive_${payload.commandId || ''}`);
  if (runtime.lease?.requestId !== requestId) return;
  // An explicit request.release command owns the release handshake. Its content
  // diagnostic may arrive before request.release.completed and must not erase
  // the lease identity needed by the correlated command result.
  if (contentReleased && runtime.lease.status === 'releasing') return;
  await backgroundState.transition(state.tabId, {
    type: 'lease.release',
    requestId: runtime.lease.requestId,
    leaseId: runtime.lease.leaseId,
    ownerServerInstanceId: runtime.lease.ownerServerInstanceId,
    contentEpoch: state.contentEpoch,
  });
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
    port.onMessage.addListener(async (message) => {
      if (!message || typeof message !== 'object') return;
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
    });

    port.onDisconnect.addListener(() => {
      const state = deps.connections.get(port);
      if (state) state.closed = true;
      for (const capture of deps.downloadCaptures.values()) {
        if (!capture.done && deps.portMatches(capture.port, port)) deps.rejectDownloadCapture(capture, new Error('Content script disconnected while waiting for download'));
      }
      deps.closeConnection(port, 'content-disconnected');
    });
  });
}
