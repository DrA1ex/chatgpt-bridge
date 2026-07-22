import { MessageType } from './protocolV5.js';
import { contentMessageQueueOptions } from './operationPriorityPolicy.js';
import {
  beginReloadCommandReconciliation,
  isReloadManagedCommand,
  reconcileReloadedCommands,
} from './standaloneCommandRecovery.js';

const NON_BLOCKING_CONTENT_OPERATIONS = new Set(['bridge.download.capture.wait', 'bridge.download.capture.wait_bound']);
const DIAGNOSTIC_TYPES = new Set(['diagnostic', 'page.status', 'page.changed', 'status', 'chat.event']);
const COMMAND_PROGRESS_TYPES = new Set(['artifact.data.started', 'artifact.data.chunk']);

function requestIdentity(record = {}) {
  return {
    requestId: String(record.requestId || ''), leaseId: String(record.leaseId || ''),
    ownerServerInstanceId: String(record.ownerServerInstanceId || ''), responseEpoch: Math.max(0, Number(record.responseEpoch) || 0),
  };
}
function withoutType(payload = {}) { const { type: _type, ...rest } = payload; return rest; }
function reply(post, port, requestId, result, error = null, type = 'extension.response') {
  post(port, error ? { type, requestId, error: error.message || String(error) } : { type, requestId, result });
}
function effectMessageType(status) {
  return {
    succeeded: MessageType.EFFECT_SUCCEEDED,
    failed: MessageType.EFFECT_FAILED,
    uncertain: MessageType.EFFECT_UNCERTAIN,
    cancelled: MessageType.EFFECT_CANCELLED,
  }[status] || MessageType.EFFECT_UNCERTAIN;
}
function effectOutcomeBody(effect, status, event = {}) {
  return {
    requestId: effect.requestId, effectId: effect.effectId, effectType: effect.kind,
    idempotencyKey: effect.idempotencyKey, retryPolicy: effect.retryPolicy,
    preconditions: effect.preconditions || {}, preconditionsHash: effect.preconditionsHash || '',
    responseEpoch: effect.responseEpoch || 0, attempt: Math.max(1, Number(event.attempt) || effect.attempt || 1),
    commandId: effect.commandId || '', causationId: effect.causationId || '', result: event.result || null,
    reconciliationEvidence: event.reconciliationEvidence || effect.reconciliationEvidence || null,
    cancellationEvidence: event.cancellationEvidence || effect.cancellationEvidence || null,
    provenNotExecuted: status === 'cancelled',
    ...(status === 'succeeded' ? {} : {
      code: String(event.error?.code || effect.error?.code || (status === 'uncertain' ? 'BROWSER_EFFECT_UNCERTAIN' : status === 'cancelled' ? 'BROWSER_EFFECT_CANCELLED' : 'BROWSER_EFFECT_FAILED')),
      message: String(event.error?.message || effect.error?.message || event.error || effect.error || `Browser effect ${status}`),
      recoverable: status === 'uncertain', uncertain: status === 'uncertain',
    }),
  };
}
function commandRejectedBody(command, payload = {}) {
  return {
    commandId: command.commandId, requestId: command.requestId,
    code: String(payload.code || 'COMMAND_REJECTED'),
    message: String(payload.message || payload.error || 'Browser command failed'),
    retryable: Boolean(payload.retryable || payload.uncertain), recoverable: Boolean(payload.recoverable || payload.uncertain),
    uncertain: Boolean(payload.uncertain), evidence: payload.evidence || null,
  };
}
function commandResultBody(command, payload = {}) {
  const semanticType = String(payload.resultType || payload.type || 'command.completed');
  return { ...withoutType(payload), commandId: command.commandId, requestId: command.requestId, resultType: semanticType };
}

async function settleResultCommand(deps, state, payload) {
  const payloadType = String(payload?.type || '');
  if (payloadType === 'standalone.reconciliation' || payloadType === 'command.progress' || COMMAND_PROGRESS_TYPES.has(payloadType)) return false;
  const commandId = String(payload.commandId || '');
  if (!commandId) return false;
  const runtime = await deps.backgroundState.read(state.tabId);
  const command = runtime.commands?.[commandId] || null;
  if (!command) return false;
  if (command.mode === 'effect') return false;
  const rejected = payload.type === 'command.error' || payload.type === 'command.rejected' || Boolean(payload.error);
  const releaseRejected = rejected && command.mode === 'release';
  const messageType = releaseRejected ? MessageType.LEASE_QUARANTINED : rejected ? MessageType.COMMAND_REJECTED : MessageType.COMMAND_RESULT;
  const body = releaseRejected
    ? { ...commandRejectedBody(command, payload), reason: String(payload.message || payload.error || 'release cleanup failed') }
    : rejected ? commandRejectedBody(command, payload) : commandResultBody(command, payload);
  const terminalEnvelope = deps.createEnvelopeDraft(state, messageType, body, {
    commandId, lease: command.scope === 'request' ? requestIdentity(command) : null,
  });
  const outcome = await deps.backgroundState.transition(state.tabId, {
    type: rejected ? (payload.uncertain ? 'command.uncertain' : 'command.rejected') : 'command.succeeded',
    commandId, ...(command.scope === 'request' ? requestIdentity(command) : {}),
    resultType: String(body.resultType || payload.type || ''), resultPayload: body,
    error: rejected ? { code: body.code, message: body.message } : null,
    terminalEnvelope, contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted && outcome.reason !== 'command_terminal') throw new Error(`Browser command settlement rejected: ${outcome.reason}`);
  await deps.flushCriticalOutbox(state);
  return true;
}

async function sendEphemeralPayload(deps, state, payload) {
  const type = String(payload.type || '');
  if (type === 'hello') return deps.sendProtocolMessage(state, MessageType.TRANSPORT_HELLO, withoutType(payload));
  if (type === 'pong') return deps.sendProtocolMessage(state, MessageType.TRANSPORT_PONG, withoutType(payload));
  if (type === 'tab.observation') return deps.sendProtocolMessage(state, MessageType.TAB_OBSERVATION, withoutType(payload));
  if (DIAGNOSTIC_TYPES.has(type)) return deps.sendProtocolMessage(state, MessageType.TRANSPORT_DIAGNOSTIC, { ...withoutType(payload), diagnosticType: type });
  if (type === 'command.progress' || COMMAND_PROGRESS_TYPES.has(type)) {
    return deps.sendProtocolMessage(state, MessageType.COMMAND_PROGRESS, {
      ...withoutType(payload), progressType: String(payload.progressType || type),
    }, { commandId: payload.commandId, lease: null });
  }
  return null;
}

export async function handleEffectBegin(deps, state, message) {
  const result = await handleEffect(deps, state, { ...message, type: 'bridge.effect.begin' });
  const effect = result.effect;
  await deps.sendProtocolMessage(state, MessageType.EFFECT_STARTED, {
    requestId: effect.requestId,
    effectId: effect.effectId,
    effectType: effect.kind,
    commandId: effect.commandId || '',
    idempotencyKey: effect.idempotencyKey,
    responseEpoch: effect.responseEpoch,
    attempt: effect.attempt,
    retryPolicy: effect.retryPolicy,
    preconditions: effect.preconditions || {},
    preconditionsHash: effect.preconditionsHash || '',
  }, { effectId: effect.effectId, commandId: effect.commandId || null, lease: requestIdentity(effect) });
  return result;
}

export async function handleReleaseCleanupSettlement(deps, state, message) {
  const runtime = await deps.backgroundState.read(state.tabId);
  const command = runtime.commands?.[String(message.commandId || '')] || null;
  if (!command || command.commandType !== 'request.release') throw new Error('Release cleanup settlement did not match a persisted release command');
  if (message.status === 'completed') {
    const ready = await deps.backgroundState.transition(state.tabId, {
      type: 'command.release_ready', commandId: command.commandId, ...requestIdentity(command), contentEpoch: state.contentEpoch,
    });
    if (!ready.accepted && ready.reason !== 'release_already_ready') throw new Error(`Browser release barrier rejected: ${ready.reason}`);
    await deps.flushCriticalOutbox(state);
    return { persisted: true, released: true, commandId: command.commandId };
  }
  const body = {
    commandId: command.commandId,
    requestId: command.requestId,
    code: String(message.code || 'RELEASE_CLEANUP_FAILED'),
    message: String(message.message || 'Content runtime could not prove request cleanup'),
    reason: String(message.reason || message.message || 'Content runtime could not prove request cleanup'),
    recoverable: false,
    uncertain: true,
    evidence: message.evidence && typeof message.evidence === 'object' ? message.evidence : null,
  };
  const terminalEnvelope = deps.createEnvelopeDraft(state, MessageType.LEASE_QUARANTINED, body, {
    commandId: command.commandId,
    lease: requestIdentity(command),
  });
  const quarantined = await deps.backgroundState.transition(state.tabId, {
    type: 'command.uncertain', commandId: command.commandId, ...requestIdentity(command),
    error: { code: body.code, message: body.message }, resultPayload: body,
    terminalEnvelope, contentEpoch: state.contentEpoch,
  });
  if (!quarantined.accepted && quarantined.reason !== 'command_terminal') throw new Error(`Browser release quarantine rejected: ${quarantined.reason}`);
  await deps.flushCriticalOutbox(state);
  return { persisted: true, released: false, quarantined: true, commandId: command.commandId };
}

export async function handleEffectReconciliationSettlement(deps, state, message) {
  const runtime = await deps.backgroundState.read(state.tabId);
  const effect = runtime.effects?.[String(message.effectId || '')] || null;
  const recorded = await deps.backgroundState.transition(state.tabId, {
    type: 'effect.reconciliation_recorded', effectId: String(message.effectId || ''), ...(effect ? requestIdentity(effect) : {}),
    idempotencyKey: String(message.idempotencyKey || effect?.idempotencyKey || ''),
    preconditionsHash: String(message.preconditionsHash || effect?.preconditionsHash || ''),
    reconciliationEvidence: {
      outcome: String(message.reconciliationOutcome || 'unknown'),
      reason: String(message.reconciliationReason || ''),
      evidence: message.evidence || {},
      commandId: String(message.commandId || ''),
    },
    contentEpoch: state.contentEpoch,
  });
  if (!recorded.accepted && recorded.reason !== 'effect_missing') throw new Error(`Browser effect reconciliation evidence rejected: ${recorded.reason}`);
  return { persisted: recorded.accepted, effect: recorded.state?.effects?.[String(message.effectId || '')] || null };
}

export async function handlePayload(deps, _port, state, payload) {
  if (payload.type !== 'hello' && !state.protocolReady) {
    state.preHelloPayloads = [...(state.preHelloPayloads || []), payload].slice(-100);
    return;
  }

  if (payload.type === 'hello') await beginReloadCommandReconciliation(deps, state);
  if (state.reloadReconciliationCommandIds instanceof Set) {
    await reconcileReloadedCommands(deps, state, payload);
  }

  const settled = await settleResultCommand(deps, state, payload);
  if (!settled) await sendEphemeralPayload(deps, state, payload);

  if (payload.type === 'hello') {
    await deps.replayCriticalOutbox(state);
    state.protocolReady = true;
    const queued = state.preHelloPayloads || [];
    state.preHelloPayloads = [];
    for (const queuedPayload of queued) {
      if (state.reloadReconciliationCommandIds instanceof Set) {
        await reconcileReloadedCommands(deps, state, queuedPayload);
      }
      const queuedSettled = await settleResultCommand(deps, state, queuedPayload);
      if (!queuedSettled) await sendEphemeralPayload(deps, state, queuedPayload);
    }
    await recoverAfterContentReload(deps, state);
  }
}

async function recoverAfterContentReload(deps, state) {
  let runtime = await deps.backgroundState.read(state.tabId);
  for (const effect of runtime.effectOrder.map((id) => runtime.effects[id]).filter(Boolean)) {
    if (effect.status !== 'dispatched') continue;
    const body = effectOutcomeBody(effect, 'uncertain', { error: { code: 'CONTENT_RELOADED_DURING_EFFECT', message: 'Content runtime reloaded before the browser effect result was confirmed' } });
    const terminalEnvelope = deps.createEnvelopeDraft(state, MessageType.EFFECT_UNCERTAIN, body, { effectId: effect.effectId, commandId: effect.commandId || null, lease: requestIdentity(effect) });
    const uncertain = await deps.backgroundState.transition(state.tabId, {
      type: 'effect.uncertain', ...requestIdentity(effect), effectId: effect.effectId, idempotencyKey: effect.idempotencyKey,
      preconditionsHash: effect.preconditionsHash, attempt: effect.attempt,
      error: { code: 'CONTENT_RELOADED_DURING_EFFECT', message: 'Content runtime reloaded before the browser effect result was confirmed' },
      terminalEnvelope, contentEpoch: state.contentEpoch,
    });
    if (!uncertain.accepted && uncertain.reason !== 'effect_terminal') continue;
  }
  runtime = await deps.backgroundState.read(state.tabId);
  for (const command of (runtime.commandOrder || []).map((id) => runtime.commands?.[id]).filter(Boolean)) {
    if (command.status !== 'dispatched') continue;
    if (isReloadManagedCommand(command)) continue;
    if (command.mode !== 'result' && command.mode !== 'release') continue;
    const release = command.mode === 'release';
    const body = commandRejectedBody(command, {
      code: release ? 'RELEASE_CLEANUP_UNPROVEN' : 'CONTENT_RELOADED_DURING_COMMAND',
      message: release ? 'Content runtime reloaded before request cleanup was proven' : 'Content runtime reloaded before command completion was confirmed',
      uncertain: true,
      recoverable: !release,
    });
    const terminalEnvelope = deps.createEnvelopeDraft(state, release ? MessageType.LEASE_QUARANTINED : MessageType.COMMAND_REJECTED, body, {
      commandId: command.commandId,
      lease: command.scope === 'request' ? requestIdentity(command) : null,
    });
    await deps.backgroundState.transition(state.tabId, {
      type: 'command.uncertain', commandId: command.commandId, ...(command.scope === 'request' ? requestIdentity(command) : {}),
      error: { code: body.code, message: body.message }, resultPayload: body, terminalEnvelope, contentEpoch: state.contentEpoch,
    });
  }
  await deps.flushCriticalOutbox(state);
}

async function handleEffect(deps, state, message) {
  const runtime = await deps.backgroundState.read(state.tabId);
  if (message.type === 'bridge.effect.begin') {
    const effect = runtime.effects?.[String(message.effectId || '')] || null;
    if (!effect || effect.status !== 'dispatched') throw new Error('Browser effect was not dispatched atomically with its server command');
    const exact = effect.requestId === String(message.browserRequestId || '')
      && effect.leaseId === String(message.leaseId || '')
      && effect.ownerServerInstanceId === String(message.ownerServerInstanceId || '')
      && effect.idempotencyKey === String(message.idempotencyKey || '')
      && effect.kind === String(message.kind || message.effectType || '')
      && effect.preconditionsHash === String(message.preconditionsHash || '')
      && effect.responseEpoch === Math.max(0, Number(message.responseEpoch) || 0)
      && effect.commandId === String(message.commandId || '');
    if (!exact) throw new Error('Content effect descriptor does not match the atomically dispatched BrowserEffect');
    return { persisted: true, effect };
  }
  const status = ['succeeded', 'failed', 'uncertain', 'cancelled'].includes(message.status) ? message.status : 'uncertain';
  const effect = runtime.effects?.[String(message.effectId || '')] || null;
  if (!effect) throw new Error('Browser effect result has no persisted effect');
  const body = effectOutcomeBody(effect, status, message);
  const terminalEnvelope = deps.createEnvelopeDraft(state, effectMessageType(status), body, {
    effectId: effect.effectId, commandId: effect.commandId || null, causationId: effect.causationId || null, lease: requestIdentity(effect),
  });
  const outcome = await deps.backgroundState.transition(state.tabId, {
    type: `effect.${status}`, ...requestIdentity(effect), effectId: effect.effectId,
    idempotencyKey: String(message.idempotencyKey || effect.idempotencyKey), result: message.result || null, error: message.error || null,
    attempt: Math.max(1, Number(message.attempt) || effect.attempt || 1), preconditionsHash: String(message.preconditionsHash || effect.preconditionsHash),
    provenNotExecuted: message.provenNotExecuted === true, cancellationEvidence: message.cancellationEvidence || null,
    reconciliationEvidence: message.reconciliationEvidence || null, terminalEnvelope, contentEpoch: state.contentEpoch,
  });
  if (!outcome.accepted) throw new Error(`Browser effect result rejected: ${outcome.reason}`);
  await deps.flushCriticalOutbox(state);
  return { persisted: true, effect: outcome.state.effects[message.effectId] };
}

export function installBackgroundPortRouter(deps) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chatgpt-bridge-tab') return;
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      const tabId = port?.sender?.tab?.id ?? null;
      const executeMessage = async () => {
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
          if (message.type === 'bridge.effect.begin' || message.type === 'bridge.effect.settle'
            || message.type === 'bridge.effect.reconcile_result' || message.type === 'bridge.release.cleanup_settled') {
            const state = deps.connections.get(port);
            if (!state) throw new Error('Extension transport is not connected');
            const result = message.type === 'bridge.effect.begin'
              ? await handleEffectBegin(deps, state, message)
              : message.type === 'bridge.effect.reconcile_result'
                ? await handleEffectReconciliationSettlement(deps, state, message)
                : message.type === 'bridge.release.cleanup_settled'
                  ? await handleReleaseCleanupSettlement(deps, state, message)
                  : await handleEffect(deps, state, message);
            reply(deps.post, port, message.requestId, result);
            return;
          }
          const operation = {
            'bridge.download.capture.begin': () => deps.beginDownloadCapture(port, message),
            'bridge.download.capture.add_expected_names': () => deps.addDownloadCaptureExpectedNames(port, String(message.captureId || ''), message.expectedNames || []),
            'bridge.download.capture.activate': () => deps.activateDownloadCapture(port, String(message.captureId || '')),
            'bridge.download.capture.start': () => deps.startDownloadCapture(port, String(message.captureId || ''), message.url),
            'bridge.download.capture.wait': () => deps.waitDownloadCapture(port, String(message.captureId || ''), message.timeoutMs),
            'bridge.download.capture.wait_bound': () => deps.waitDownloadCaptureBound(port, String(message.captureId || ''), message.timeoutMs),
            'bridge.download.capture.release': () => deps.releaseDownloadCapture(port, String(message.captureId || ''), String(message.reason || 'released'), message.graceMs),
            'bridge.download.capture.cancel': () => deps.cancelDownloadCapture(port, String(message.captureId || ''), String(message.reason || 'cancelled')),
            'bridge.tab.open': () => deps.openBridgeTab(port, message), 'bridge.tab.close': () => deps.closeOwnBridgeTab(port, message),
            'bridge.tab.close-owned': () => deps.closeOwnedBridgeTab(port, message), 'bridge.tab.reload': () => deps.reloadOwnBridgeTab(port, message),
            'bridge.extension.reload': () => deps.scheduleExtensionReload(message),
          }[message.type];
          if (operation) { reply(deps.post, port, message.requestId, await operation()); return; }
          if (message.type === 'bridge.http') reply(deps.post, port, message.requestId, await deps.performHttp(message.request || {}), null, 'bridge.http.result');
        } catch (error) {
          reply(deps.post, port, message.requestId, null, error, message.type === 'bridge.http' ? 'bridge.http.result' : 'extension.response');
        }
      };
      if (NON_BLOCKING_CONTENT_OPERATIONS.has(String(message.type || ''))) { void executeMessage(); return; }
      void deps.tabOperations.run(tabId, executeMessage, contentMessageQueueOptions(message)).catch((error) => {
        reply(deps.post, port, message.requestId, null, error, message.type === 'bridge.http' ? 'bridge.http.result' : 'extension.response');
      });
    });
    port.onDisconnect.addListener(() => {
      const state = deps.connections.get(port); if (state) state.closed = true;
      for (const capture of deps.downloadCaptures.values()) if (!capture.done && deps.portMatches(capture.port, port)) capture.port = null;
      deps.closeConnection(port, 'content-disconnected');
    });
  });
}
