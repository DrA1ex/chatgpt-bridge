import { MessageKind } from './protocolV4.js';


function backgroundEffectReconciliationEvidence(runtime = {}, payload = {}) {
  const effectId = String(payload.effectId || '');
  const effect = effectId ? runtime.effects?.[effectId] || null : null;
  const captures = Object.values(runtime.downloads || {})
    .filter((capture) => capture && (!effectId || String(capture.effectId || '') === effectId))
    .map((capture) => ({
      captureId: String(capture.captureId || ''),
      status: String(capture.status || ''),
      downloadId: Number.isInteger(capture.downloadId) ? capture.downloadId : null,
      artifactRequirementId: String(capture.artifactRequirementId || capture.expectedArtifactIdentity?.requirementId || ''),
      artifactCandidateId: String(capture.artifactCandidateId || capture.expectedArtifactIdentity?.candidateId || ''),
      sourceTurnKey: String(capture.sourceTurnKey || capture.expectedArtifactIdentity?.sourceTurnKey || ''),
      expectedName: String(capture.expectedName || ''),
      completedAt: Number(capture.completedAt) || 0,
      failedAt: Number(capture.failedAt) || 0,
    }));
  return {
    effect: effect ? {
      effectId: String(effect.effectId || ''),
      kind: String(effect.kind || ''),
      status: String(effect.status || ''),
      idempotencyKey: String(effect.idempotencyKey || ''),
      result: effect.result || null,
      error: effect.error || null,
    } : null,
    downloads: captures,
  };
}

export async function handleServerEnvelope({
  state,
  envelope,
  backgroundState,
  sendProtocolPayload,
  post,
}) {
  const payload = envelope.payload;
  const sourceEpoch = String(envelope.source.backgroundEpoch || '');
  let runtime = await backgroundState.read(state.tabId);
  if (runtime.transport.serverEpoch !== sourceEpoch) {
    const connected = await backgroundState.transition(state.tabId, {
      type: 'transport.connected',
      connectionEpoch: state.connectionEpoch,
      serverEpoch: sourceEpoch,
      serverInstanceId: String(payload.serverInstanceId || sourceEpoch),
      contentEpoch: state.contentEpoch,
    });
    if (!connected.accepted) throw new Error(`Transport owner update rejected: ${connected.reason}`);
    runtime = connected.state;
  }
  const received = await backgroundState.transition(state.tabId, {
    type: 'transport.inbound',
    serverEpoch: sourceEpoch,
    sequence: envelope.source.sequence,
    contentEpoch: state.contentEpoch,
  });
  if (!received.accepted) {
    if (received.reason === 'stale_server_sequence') return;
    throw new Error(`Server envelope rejected: ${received.reason}`);
  }

  if (envelope.kind === MessageKind.TRANSPORT_ACK) {
    const accepted = payload.accepted !== false || payload.reason === 'duplicate_message';
    if (!accepted) {
      await backgroundState.transition(state.tabId, {
        type: 'transport.ack_rejected',
        messageId: String(payload.ackMessageId || ''),
        reason: String(payload.reason || 'server_rejected'),
        contentEpoch: state.contentEpoch,
      });
      return;
    }
    const acknowledged = received.state.outbox.find((item) => item.messageId === String(payload.ackMessageId || '')) || null;
    const ack = await backgroundState.transition(state.tabId, {
      type: 'outbox.acknowledged',
      messageId: String(payload.ackMessageId || ''),
      sequence: Number(payload.acceptedSequence) || 0,
      contentEpoch: state.contentEpoch,
    });
    if (!ack.accepted && ack.reason !== 'outbox_message_missing') throw new Error(`Transport ACK rejected: ${ack.reason}`);
    if (acknowledged?.effectId) {
      await backgroundState.transition(state.tabId, {
        type: 'effect.reported', effectId: acknowledged.effectId, contentEpoch: state.contentEpoch,
      });
    }
    return;
  }

  if (envelope.kind === MessageKind.COMMAND_EXECUTE && envelope.request) {
    await handleCommand({ state, envelope, payload, backgroundState, sendProtocolPayload, post, runtime: await backgroundState.read(state.tabId) });
    return;
  }

  if (payload.type === 'extension.status' || payload.type === 'extension.compatibility') {
    post(state.port, {
      type: 'extension.status',
      status: payload.status || (payload.compatible === false ? 'extension update required' : 'compatible'),
      detail: payload.detail || payload.compatibility?.message || '',
      compatibility: payload.compatibility || null,
    });
  }
  post(state.port, { type: 'server.message', payload });
}

async function handleCommand({ state, envelope, payload, backgroundState, sendProtocolPayload, post, runtime }) {
  if (!runtime.lease) {
    const claimed = await backgroundState.transition(state.tabId, {
      type: 'lease.claim',
      ...envelope.request,
      conversationId: String(payload.sessionId || payload.conversationId || ''),
      contentEpoch: state.contentEpoch,
    });
    if (!claimed.accepted) {
      await rejectCommand({ state, envelope, payload, sendProtocolPayload, message: `Browser lease rejected: ${claimed.reason}` });
      return;
    }
    runtime = claimed.state;
  } else if (payload.type === 'request.resume'
    && runtime.lease.requestId === envelope.request.requestId
    && runtime.lease.ownerServerInstanceId === String(payload.previousOwnerServerInstanceId || '')) {
    const handoff = await backgroundState.transition(state.tabId, {
      type: 'lease.handoff', ...envelope.request,
      previousOwnerServerInstanceId: payload.previousOwnerServerInstanceId,
      contentEpoch: state.contentEpoch,
    });
    if (!handoff.accepted) {
      await rejectCommand({ state, envelope, payload, sendProtocolPayload, message: `Browser lease handoff rejected: ${handoff.reason}` });
      return;
    }
    runtime = handoff.state;
  } else if (runtime.lease.requestId !== envelope.request.requestId
    || runtime.lease.leaseId !== envelope.request.leaseId
    || runtime.lease.ownerServerInstanceId !== envelope.request.ownerServerInstanceId) {
    await rejectCommand({ state, envelope, payload, sendProtocolPayload, message: 'Browser lease belongs to another request or server instance' });
    return;
  }

  const desiredLeaseStatus = payload.type === 'request.release' ? 'releasing' : 'executing';
  const currentRuntime = await backgroundState.read(state.tabId);
  const executing = currentRuntime.lease?.status === desiredLeaseStatus
    ? { accepted: true, state: currentRuntime }
    : await backgroundState.transition(state.tabId, {
      type: `lease.${desiredLeaseStatus}`, ...envelope.request, contentEpoch: state.contentEpoch,
    });
  if (!executing.accepted) {
    await rejectCommand({ state, envelope, payload, sendProtocolPayload, message: `Browser executor rejected command: ${executing.reason}` });
    return;
  }

  const releaseOnResult = payload.leaseScope === 'command' || payload.type === 'passive.prompt.submit';
  const registered = await backgroundState.transition(state.tabId, {
    type: 'command.registered',
    commandId: String(payload.commandId || envelope.commandId || ''),
    commandType: String(payload.type || ''),
    causationId: envelope.messageId,
    releaseOnResult,
    idempotencyKey: String(payload.idempotencyKey || payload.commandId || envelope.commandId || ''),
    retryPolicy: String(payload.retryPolicy || 'never'),
    preconditions: payload.preconditions && typeof payload.preconditions === 'object'
      ? payload.preconditions
      : {
          commandType: String(payload.type || ''),
          conversationId: String(payload.sessionId || payload.conversationId || ''),
          protocolMessageId: envelope.messageId,
        },
    ...envelope.request,
    contentEpoch: state.contentEpoch,
  });
  if (!registered.accepted) {
    await rejectCommand({ state, envelope, payload, sendProtocolPayload, message: `Browser command registration rejected: ${registered.reason}` });
    return;
  }
  await sendProtocolPayload(state, {
    type: 'command.accepted', commandId: payload.commandId, requestId: envelope.request.requestId,
  }, { kind: MessageKind.COMMAND_ACCEPTED, causationId: envelope.messageId, lease: envelope.request });
  const dispatched = await backgroundState.transition(state.tabId, {
    type: 'command.dispatched',
    commandId: String(payload.commandId || envelope.commandId || ''),
    contentEpoch: state.contentEpoch,
  });
  if (!dispatched.accepted) throw new Error(`Browser command dispatch rejected: ${dispatched.reason}`);
  const commandPayload = payload.type === 'request.effect.reconcile'
    ? { ...payload, backgroundEvidence: backgroundEffectReconciliationEvidence(await backgroundState.read(state.tabId), payload) }
    : payload;
  post(state.port, { type: 'server.message', payload: {
    ...commandPayload,
    requestId: envelope.request.requestId,
    responseEpoch: Number(envelope.request.responseEpoch) || 0,
    leaseScope: releaseOnResult ? 'command' : String(payload.leaseScope || 'request'),
    leaseId: envelope.request.leaseId,
    ownerServerInstanceId: envelope.request.ownerServerInstanceId,
    protocolMessageId: envelope.messageId,
  } });
}

async function rejectCommand({ state, envelope, payload, sendProtocolPayload, message }) {
  await sendProtocolPayload(state, {
    type: 'command.error', commandId: payload.commandId, requestId: envelope.request.requestId, error: message,
  }, { kind: MessageKind.COMMAND_REJECTED, causationId: envelope.messageId, lease: envelope.request });
}
