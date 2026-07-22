import '../shared/commandManifest.js';
import { MessageType } from './protocolV5.js';

const ReloadRecovery = globalThis.ChatGptBridgeCommandManifest?.CommandReloadRecovery || {};
const MANAGED_RECOVERY = new Set([
  ReloadRecovery.OBSERVATION,
  ReloadRecovery.DOWNLOAD_CAPTURE,
  ReloadRecovery.CONTENT_EPOCH,
  ReloadRecovery.TARGET_COMMAND,
  ReloadRecovery.TYPED_UNCERTAINTY,
  ReloadRecovery.READ_PROBE,
].filter(Boolean));

function requestIdentity(record = {}) {
  return {
    requestId: String(record.requestId || ''),
    leaseId: String(record.leaseId || ''),
    ownerServerInstanceId: String(record.ownerServerInstanceId || ''),
    responseEpoch: Math.max(0, Number(record.responseEpoch) || 0),
  };
}

function commandDefinition(command = {}) {
  return globalThis.ChatGptBridgeCommandManifest?.commandDefinition?.(String(command.commandType || '')) || null;
}

export function isReloadManagedCommand(command = {}) {
  return MANAGED_RECOVERY.has(String(commandDefinition(command)?.reloadRecovery || ''));
}

function conversationIdFromUrl(url = '') {
  try { return new URL(String(url || '')).pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ''; } catch { return ''; }
}

function observedConversationIdentity(payload = {}) {
  const url = String(payload.observation?.url || payload.url || '');
  const id = String(payload.observation?.conversationId || payload.session?.id || conversationIdFromUrl(url));
  return { id, url };
}

function commandRejectedBody(command, payload = {}) {
  return {
    commandId: command.commandId,
    requestId: command.requestId,
    code: String(payload.code || 'COMMAND_REJECTED'),
    message: String(payload.message || payload.error || 'Browser command failed'),
    retryable: Boolean(payload.retryable || payload.uncertain),
    recoverable: Boolean(payload.recoverable || payload.uncertain),
    uncertain: Boolean(payload.uncertain),
    evidence: payload.evidence || null,
  };
}

async function settleRecoveredCommand(deps, state, command, outcome = {}) {
  const succeeded = outcome.status === 'succeeded';
  const provedNotStarted = outcome.status === 'proved_not_started';
  const body = succeeded
    ? {
        commandId: command.commandId,
        requestId: command.requestId,
        resultType: String(outcome.resultType || 'command.reconciled'),
        ...(outcome.result && typeof outcome.result === 'object' ? outcome.result : {}),
        reconciledAfterReload: true,
        reconciliationEvidence: outcome.evidence || null,
      }
    : commandRejectedBody(command, {
        code: String(outcome.code || (provedNotStarted ? 'COMMAND_PROVED_NOT_STARTED' : 'CONTENT_RELOAD_COMMAND_UNCERTAIN')),
        message: String(outcome.message || (provedNotStarted
          ? 'The browser command was durably registered but never dispatched and may be retried'
          : 'Content reload left the browser command outcome uncertain')),
        uncertain: provedNotStarted ? false : outcome.uncertain !== false,
        retryable: provedNotStarted || outcome.retryable === true,
        recoverable: outcome.recoverable !== false,
        evidence: outcome.evidence || null,
      });
  if (!succeeded) body.reconciliationOutcome = provedNotStarted ? 'proved_not_started' : 'unknown';
  const messageType = succeeded ? MessageType.COMMAND_RESULT : MessageType.COMMAND_REJECTED;
  const terminalEnvelope = deps.createEnvelopeDraft(state, messageType, body, {
    commandId: command.commandId,
    lease: command.scope === 'request' ? requestIdentity(command) : null,
  });
  const settled = await deps.backgroundState.transition(state.tabId, {
    type: succeeded ? 'command.succeeded' : (provedNotStarted ? 'command.rejected' : 'command.uncertain'),
    commandId: command.commandId,
    ...(command.scope === 'request' ? requestIdentity(command) : {}),
    resultType: String(body.resultType || ''),
    resultPayload: body,
    error: succeeded ? null : { code: body.code, message: body.message },
    terminalEnvelope,
    contentEpoch: state.contentEpoch,
  });
  if (!settled.accepted && settled.reason !== 'command_terminal') {
    throw new Error(`Reloaded command settlement rejected: ${settled.reason}`);
  }
  return settled;
}

function commandCaptures(deps, runtime, commandId) {
  const persisted = Object.values(runtime.downloads || {}).filter((capture) => String(capture?.commandId || '') === commandId);
  const live = [...(deps.downloadCaptures?.values?.() || [])].filter((capture) => String(capture?.commandId || '') === commandId);
  return { persisted, live };
}

export async function beginReloadCommandReconciliation(deps, state) {
  const runtime = await deps.backgroundState.read(state.tabId);
  const commands = (runtime.commandOrder || [])
    .map((id) => runtime.commands?.[id])
    .filter((command) => ['registered', 'dispatched'].includes(command?.status) && isReloadManagedCommand(command));
  state.reloadReconciliationCommandIds = new Set(commands.map((command) => command.commandId));
  if (state.reloadReconciliationCommandIds.size === 0) {
    state.reloadReconciliationCommandIds = null;
    return;
  }
  for (const command of commands.filter((candidate) => candidate.status === 'registered')) {
    await settleRecoveredCommand(deps, state, command, {
      status: 'proved_not_started',
      code: 'COMMAND_PROVED_NOT_STARTED',
      message: 'The browser command was durably registered but never dispatched and may be retried',
      evidence: { source: 'background.state', status: 'registered', dispatchedContentEpoch: '' },
    });
    completeReloadCommand(state, command.commandId);
  }
  for (const command of commands.filter((candidate) => candidate.status === 'dispatched')) {
    if (String(commandDefinition(command)?.reloadRecovery || '') !== ReloadRecovery.READ_PROBE) continue;
    deps.post?.(state.port, {
      type: 'server.message',
      payload: {
        type: 'standalone.reconcile',
        commandId: command.commandId,
        commandType: command.commandType,
        preconditions: command.preconditions || {},
      },
    });
  }
}

function isCurrentReloadCommand(state, command) {
  return state.reloadReconciliationCommandIds instanceof Set
    && state.reloadReconciliationCommandIds.has(String(command?.commandId || ''));
}

function completeReloadCommand(state, commandId) {
  if (!(state.reloadReconciliationCommandIds instanceof Set)) return;
  state.reloadReconciliationCommandIds.delete(String(commandId || ''));
  if (state.reloadReconciliationCommandIds.size === 0) state.reloadReconciliationCommandIds = null;
}

async function reconcilePassivePrompt(deps, state, command, payload) {
  if (payload.type !== 'tab.observation') return false;
  const expected = String(command.preconditions?.message || '').trim();
  const observation = payload.observation || {};
  const actual = String(observation.turn?.userPrompt || '').trim();
  const userTurnKey = String(observation.turn?.userKey || '');
  if (expected && actual === expected && userTurnKey) {
    await settleRecoveredCommand(deps, state, command, {
      status: 'succeeded',
      resultType: 'passive.prompt.submitted',
      result: { submitted: true, submittedUserTurnKey: userTurnKey, conversationId: String(observation.conversationId || '') },
      evidence: { source: 'tab.observation', userTurnKey, promptMatched: true },
    });
  } else {
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'PASSIVE_PROMPT_SUBMIT_UNCERTAIN',
      message: 'The reloaded tab does not prove whether the passive prompt was submitted',
      evidence: { source: 'tab.observation', expectedLength: expected.length, observedLength: actual.length, userTurnKey },
    });
  }
  return true;
}

async function reconcileArtifactFetch(deps, state, runtime, command, payload) {
  const captures = commandCaptures(deps, runtime, command.commandId);
  const completed = captures.live.find((capture) => capture.done && capture.result)
    || captures.persisted.find((capture) => capture.status === 'completed' && capture.result);
  const failed = captures.live.find((capture) => capture.done && capture.error)
    || captures.persisted.find((capture) => capture.status === 'failed');
  const active = captures.live.some((capture) => !capture.done)
    || captures.persisted.some((capture) => ['planned', 'armed', 'bound'].includes(capture.status));
  if (completed) {
    const result = completed.result || {};
    await settleRecoveredCommand(deps, state, command, {
      status: 'succeeded',
      resultType: 'artifact.data.done',
      result: {
        artifactId: String(command.preconditions?.artifactId || ''),
        name: String(result.name || command.preconditions?.expectedName || ''),
        mime: String(result.mime || 'application/octet-stream'),
        filePath: String(result.filePath || result.filename || ''),
        size: Number(result.size || result.fileSize || result.bytesReceived) || 0,
        captureSource: String(result.captureSource || 'chrome-downloads'),
        downloadId: result.downloadId ?? result.id ?? completed.downloadId ?? null,
      },
      evidence: { source: 'download.capture', captureId: String(completed.captureId || ''), status: 'completed' },
    });
    return true;
  }
  if (failed) {
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'ARTIFACT_CAPTURE_FAILED',
      message: String(failed.error?.message || 'Artifact download capture failed after content reload'),
      evidence: { source: 'download.capture', captureId: String(failed.captureId || ''), status: 'failed' },
    });
    return true;
  }
  if (!active && payload.type === 'hello') {
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'ARTIFACT_FETCH_UNCERTAIN',
      message: 'No persisted download capture proves whether artifact fetching completed before reload',
      evidence: { source: 'content.reload', captureCount: captures.persisted.length + captures.live.length },
    });
    return true;
  }
  return false;
}

async function reconcileSessionCommand(deps, state, command, payload) {
  const current = observedConversationIdentity(payload);
  if (!current.id && !current.url) return false;
  const expectedConversationId = String(command.preconditions?.conversationId || '');
  if (!expectedConversationId) return false;
  const observedId = current.id || conversationIdFromUrl(current.url);
  if (command.commandType === 'sessions.select') {
    if (observedId === expectedConversationId) {
      await settleRecoveredCommand(deps, state, command, {
        status: 'succeeded',
        resultType: 'session.selected',
        result: { selected: true, sessionId: expectedConversationId, url: current.url },
        evidence: { source: payload.type, conversationMatched: true },
      });
      return true;
    }
    if (payload.type !== 'tab.observation') return false;
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'SESSION_SELECT_NOT_CONFIRMED',
      message: 'The reloaded tab does not show the session targeted for selection',
      evidence: { source: 'tab.observation', expectedConversationId, observedConversationId: observedId, url: current.url },
    });
    return true;
  }
  if (payload.type !== 'tab.observation') return false;
  await settleRecoveredCommand(deps, state, command, {
    status: 'uncertain',
    code: 'SESSION_DELETE_NOT_CONFIRMED',
    message: 'Changing away from the target conversation does not prove that the session was deleted',
    evidence: { source: 'tab.observation', expectedConversationId, observedConversationId: observedId, url: current.url },
  });
  return true;
}

async function reconcileContentEpoch(deps, state, command, payload) {
  if (payload.type !== 'hello') return false;
  const before = String(command.dispatchedContentEpoch || command.registeredContentEpoch || '');
  const after = String(state.contentEpoch || '');
  if (before && after && before !== after) {
    await settleRecoveredCommand(deps, state, command, {
      status: 'succeeded',
      resultType: 'browser.tab.reloaded',
      result: { reloaded: true, previousContentEpoch: before, contentEpoch: after },
      evidence: { source: 'content.hello', contentEpochChanged: true },
    });
  } else {
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'TAB_RELOAD_NOT_CONFIRMED',
      message: 'The content epoch does not prove that the requested tab reload occurred',
      evidence: { source: 'content.hello', previousContentEpoch: before, contentEpoch: after },
    });
  }
  return true;
}

async function reconcileTargetCommand(deps, state, runtime, command, payload) {
  if (payload.type !== 'hello') return false;
  const targetId = String(command.preconditions?.targetCommandId || '');
  const target = targetId ? runtime.commands?.[targetId] || null : null;
  const terminal = target && ['succeeded', 'rejected', 'uncertain'].includes(String(target.status || ''));
  if (terminal) {
    await settleRecoveredCommand(deps, state, command, {
      status: 'succeeded',
      resultType: 'command.cancelled',
      result: { targetCommandId: targetId, targetStatus: target.status },
      evidence: { source: 'background.command_state', targetStatus: target.status },
    });
    return true;
  }
  await settleRecoveredCommand(deps, state, command, {
    status: 'uncertain',
    code: 'COMMAND_CANCEL_UNCERTAIN',
    message: 'The target command state does not prove whether cancellation completed',
    evidence: { source: 'background.command_state', targetCommandId: targetId, targetStatus: String(target?.status || 'missing') },
  });
  return true;
}

async function reconcileReadProbe(deps, state, command, payload) {
  if (payload.type !== 'standalone.reconciliation') return false;
  if (String(payload.commandId || '') !== String(command.commandId || '')) return false;
  if (String(payload.commandType || '') !== String(command.commandType || '')) return false;
  if (payload.outcome === 'proved_succeeded') {
    const resultType = command.commandType === 'intelligence.apply' ? 'intelligence.applied' : 'composer.attachments.cleared';
    const result = command.commandType === 'intelligence.apply'
      ? { applied: true, options: { model: String(command.preconditions?.model || ''), effort: String(command.preconditions?.effort || '') } }
      : { cleared: true, removed: null };
    await settleRecoveredCommand(deps, state, command, {
      status: 'succeeded', resultType, result,
      evidence: payload.evidence || { source: 'content.read_probe' },
    });
  } else {
    await settleRecoveredCommand(deps, state, command, {
      status: 'uncertain',
      code: 'COMMAND_READ_PROBE_UNCERTAIN',
      message: `${command.commandType} could not be proved from the post-reload read probe`,
      evidence: payload.evidence || { source: 'content.read_probe' },
    });
  }
  return true;
}

async function settleTypedUncertainty(deps, state, command, payload) {
  if (payload.type !== 'hello') return false;
  await settleRecoveredCommand(deps, state, command, {
    status: 'uncertain',
    code: 'COMMAND_OUTCOME_UNCERTAIN_AFTER_RELOAD',
    message: `${command.commandType} cannot be safely repeated or proved from the available reload evidence`,
    evidence: {
      source: 'content.reload',
      commandType: command.commandType,
      retryPolicy: command.retryPolicy,
      reconcilePolicy: command.reconcilePolicy,
    },
  });
  return true;
}

export async function reconcileReloadedCommands(deps, state, payload) {
  const payloadType = String(payload?.type || '');
  if (!['hello', 'tab.observation', 'standalone.reconciliation'].includes(payloadType)) return;
  const runtime = await deps.backgroundState.read(state.tabId);
  for (const command of (runtime.commandOrder || []).map((id) => runtime.commands?.[id]).filter(Boolean)) {
    if (command.status !== 'dispatched' || !isCurrentReloadCommand(state, command)) continue;
    const recovery = String(commandDefinition(command)?.reloadRecovery || '');
    let completed = false;
    if (command.commandType === 'passive.prompt.submit') completed = await reconcilePassivePrompt(deps, state, command, payload);
    else if (command.commandType === 'artifact.fetch') completed = await reconcileArtifactFetch(deps, state, runtime, command, payload);
    else if (command.commandType === 'sessions.select') completed = await reconcileSessionCommand(deps, state, command, payload);
    else if (recovery === ReloadRecovery.CONTENT_EPOCH) completed = await reconcileContentEpoch(deps, state, command, payload);
    else if (recovery === ReloadRecovery.TARGET_COMMAND) completed = await reconcileTargetCommand(deps, state, runtime, command, payload);
    else if (recovery === ReloadRecovery.READ_PROBE) completed = await reconcileReadProbe(deps, state, command, payload);
    else if (recovery === ReloadRecovery.TYPED_UNCERTAINTY) completed = await settleTypedUncertainty(deps, state, command, payload);
    if (completed) completeReloadCommand(state, command.commandId);
  }
  await deps.flushCriticalOutbox(state);
}
