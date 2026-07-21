import '../shared/commandManifest.js';
import { MessageType } from './protocolV5.js';

function commandDefinition(commandType = '') {
  return globalThis.ChatGptBridgeCommandManifest?.commandDefinition?.(commandType) || null;
}

function validateCommand(commandType, payload, requestScoped) {
  return globalThis.ChatGptBridgeCommandManifest?.validateCommandPayload?.(commandType, payload, { requestScoped })
    || { valid: false, errors: ['command manifest is unavailable'], definition: null };
}


function effectDescriptorForCommand(commandType = '', payload = {}) {
  if (commandType === 'prompt.steer' || commandType === 'prompt.cancel') {
    return payload.effect && typeof payload.effect === 'object' ? payload.effect : null;
  }
  if (commandType !== 'prompt.send') return null;
  const plan = payload.executionPlan && typeof payload.executionPlan === 'object' ? payload.executionPlan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const startAtStepId = String(plan?.startAtStepId || steps[0]?.stepId || '');
  return steps.find((step) => String(step?.stepId || '') === startAtStepId) || null;
}

function descriptorIdentityError(descriptor, request, expectedKind = '') {
  if (!descriptor || typeof descriptor !== 'object') return 'effect descriptor is missing';
  const kind = String(descriptor.kind || '');
  if (!kind || !descriptor.effectId || !descriptor.idempotencyKey || !descriptor.preconditionsHash) return 'effect descriptor identity is incomplete';
  if (expectedKind && kind !== expectedKind) return `${expectedKind} descriptor kind mismatch`;
  const preconditions = descriptor.preconditions && typeof descriptor.preconditions === 'object'
    ? descriptor.preconditions
    : {};
  if (String(preconditions.requestId || '') !== String(request?.requestId || '')
    || String(preconditions.leaseId || '') !== String(request?.leaseId || '')
    || String(preconditions.ownerServerInstanceId || '') !== String(request?.ownerServerInstanceId || '')
    || Number(preconditions.responseEpoch) !== Number(request?.responseEpoch)) {
    return `${kind || expectedKind || 'effect'} descriptor request identity mismatch`;
  }
  if (Number(descriptor.responseEpoch ?? preconditions.responseEpoch) !== Number(request?.responseEpoch)) {
    return `${kind || expectedKind || 'effect'} descriptor response epoch mismatch`;
  }
  if (!['never', 'if_unconfirmed', 'always'].includes(String(descriptor.retryPolicy || ''))) {
    return `${kind || expectedKind || 'effect'} descriptor retry policy is invalid`;
  }
  if (Math.max(1, Number(descriptor.attempt) || 1) !== Number(descriptor.attempt)) {
    return `${kind || expectedKind || 'effect'} descriptor attempt is invalid`;
  }
  return '';
}

function validateEffectBackedCommand(commandType, payload, request) {
  if (commandType === 'prompt.steer') {
    if (!String(payload.message || '').trim()) return 'prompt.steer message is empty';
    return descriptorIdentityError(payload.effect, request, 'prompt.steer');
  }
  if (commandType === 'prompt.cancel') {
    return descriptorIdentityError(payload.effect, request, 'prompt.cancel');
  }
  if (commandType !== 'prompt.send') return `unsupported effect-backed command ${commandType}`;

  const message = String(payload.message || '');
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!message.trim() && attachments.length === 0) return 'prompt.send is empty and has no attachments';
  const plan = payload.executionPlan && typeof payload.executionPlan === 'object' ? payload.executionPlan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const expectedKinds = ['page.ready.initial', 'session.apply', 'model.apply', ...(attachments.length ? ['attachments.upload'] : []), 'prompt.submit'];
  if (!plan || Number(plan.schemaVersion) !== 1 || String(plan.requestId || '') !== String(request?.requestId || '')) {
    return 'prompt.send execution plan identity is invalid';
  }
  if (steps.length !== expectedKinds.length) return 'prompt.send execution plan step count is invalid';
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const expectedKind = expectedKinds[index];
    if (String(step?.stepId || '') !== expectedKind || String(step?.kind || '') !== expectedKind || Number(step?.ordinal) !== index + 1) {
      return `prompt.send execution plan step ${index + 1} is invalid`;
    }
    const descriptorError = descriptorIdentityError(step, request, expectedKind);
    if (descriptorError) return descriptorError;
  }
  const startAtStepId = String(plan.startAtStepId || '');
  if (!startAtStepId || !steps.some((step) => String(step.stepId || '') === startAtStepId)) {
    return 'prompt.send execution plan start step is invalid';
  }
  if (payload.executionStepOnly !== true) return 'prompt.send must execute exactly one server-owned step';
  return '';
}

function requestIdentity(record = {}) {
  return {
    requestId: String(record.requestId || ''),
    leaseId: String(record.leaseId || ''),
    ownerServerInstanceId: String(record.ownerServerInstanceId || ''),
    responseEpoch: Math.max(0, Number(record.responseEpoch) || 0),
  };
}

function commandMode(commandType = '') {
  return commandDefinition(commandType)?.mode || '';
}

function backgroundEffectReconciliationEvidence(runtime = {}, payload = {}) {
  const effectId = String(payload.effectId || '');
  const effect = effectId ? runtime.effects?.[effectId] || null : null;
  const captures = Object.values(runtime.downloads || {})
    .filter((capture) => capture && (!effectId || String(capture.effectId || '') === effectId))
    .map((capture) => ({
      captureId: String(capture.captureId || ''), status: String(capture.status || ''),
      downloadId: Number.isInteger(capture.downloadId) ? capture.downloadId : null,
      artifactRequirementId: String(capture.artifactRequirementId || capture.expectedArtifactIdentity?.requirementId || ''),
      artifactCandidateId: String(capture.artifactCandidateId || capture.expectedArtifactIdentity?.candidateId || ''),
      sourceTurnKey: String(capture.sourceTurnKey || capture.expectedArtifactIdentity?.sourceTurnKey || ''),
      expectedName: String(capture.expectedName || ''), completedAt: Number(capture.completedAt) || 0, failedAt: Number(capture.failedAt) || 0,
    }));
  return {
    effect: effect ? {
      effectId: String(effect.effectId || ''), kind: String(effect.kind || ''), status: String(effect.status || ''),
      idempotencyKey: String(effect.idempotencyKey || ''), commandId: String(effect.commandId || ''), causationId: String(effect.causationId || ''),
      requestId: String(effect.requestId || ''), leaseId: String(effect.leaseId || ''), ownerServerInstanceId: String(effect.ownerServerInstanceId || ''),
      responseEpoch: Math.max(0, Number(effect.responseEpoch) || 0), preconditionsHash: String(effect.preconditionsHash || ''),
      attempt: Math.max(1, Number(effect.attempt) || 1), plannedAt: Number(effect.plannedAt) || 0, dispatchedAt: Number(effect.dispatchedAt) || 0,
      settledAt: Number(effect.settledAt) || 0, reconciliationEvidence: effect.reconciliationEvidence || null,
      cancellationEvidence: effect.cancellationEvidence || null, result: effect.result || null, error: effect.error || null,
    } : null,
    downloads: captures,
  };
}

export async function handleServerEnvelope({
  state, envelope, backgroundState, sendProtocolMessage, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post,
}) {
  const payload = envelope.body;
  const sourceEpoch = String(envelope.source.backgroundEpoch || '');
  let runtime = await backgroundState.read(state.tabId);
  if (runtime.transport.serverEpoch !== sourceEpoch) {
    const connected = await backgroundState.transition(state.tabId, {
      type: 'transport.connected', connectionEpoch: state.connectionEpoch, serverEpoch: sourceEpoch,
      serverInstanceId: String(payload.serverInstanceId || sourceEpoch), contentEpoch: state.contentEpoch,
    });
    if (!connected.accepted) throw new Error(`Transport owner update rejected: ${connected.reason}`);
    runtime = connected.state;
  }
  const received = await backgroundState.transition(state.tabId, {
    type: 'transport.inbound', serverEpoch: sourceEpoch, sequence: envelope.source.sequence, contentEpoch: state.contentEpoch,
  });
  if (!received.accepted) {
    if (received.reason === 'stale_server_sequence') return;
    throw new Error(`Server envelope rejected: ${received.reason}`);
  }

  if (envelope.messageType === MessageType.TRANSPORT_ACK) {
    const accepted = payload.accepted !== false || payload.reason === 'duplicate_message';
    if (!accepted) {
      await backgroundState.transition(state.tabId, {
        type: 'transport.ack_rejected', messageId: String(payload.ackMessageId || ''),
        reason: String(payload.reason || 'server_rejected'), contentEpoch: state.contentEpoch,
      });
      return;
    }
    const ack = await backgroundState.transition(state.tabId, {
      type: 'outbox.acknowledged', messageId: String(payload.ackMessageId || ''),
      sequence: Number(payload.acceptedSequence) || 0, contentEpoch: state.contentEpoch,
    });
    if (!ack.accepted && ack.reason !== 'outbox_message_missing') throw new Error(`Transport ACK rejected: ${ack.reason}`);
    await flushCriticalOutbox(state);
    return;
  }

  if (envelope.messageType === MessageType.COMMAND_EXECUTE) {
    await handleCommand({ state, envelope, payload, backgroundState, sendProtocolMessage, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post, runtime: await backgroundState.read(state.tabId) });
    return;
  }

  if (payload.type === 'extension.status' || payload.type === 'extension.compatibility') {
    post(state.port, {
      type: 'extension.status', status: payload.status || (payload.compatible === false ? 'extension update required' : 'compatible'),
      detail: payload.detail || payload.compatibility?.message || '', compatibility: payload.compatibility || null,
    });
  }
  post(state.port, { type: 'server.message', payload });
}

function activeStandaloneWrite(runtime = {}) {
  return (runtime.commandOrder || []).map((id) => runtime.commands?.[id]).find((command) => {
    const definition = commandDefinition(String(command?.commandType || ''));
    return command && command.scope === 'standalone' && command.status === 'dispatched'
      && definition?.operation !== 'read' && definition?.operation !== 'control';
  }) || null;
}

async function handleCommand(deps) {
  let { runtime } = deps;
  const { state, envelope, payload, backgroundState, sendProtocolMessage, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post } = deps;
  const requestScoped = Boolean(envelope.request);
  const commandType = String(payload.type || '');
  const validation = validateCommand(commandType, payload, requestScoped);
  if (!validation.valid) {
    return rejectCommand({
      state, envelope, payload, sendProtocolMessage,
      code: 'BROWSER_COMMAND_INVALID',
      message: validation.errors.join('; '),
    });
  }
  const definition = validation.definition;
  const activeStandalone = activeStandaloneWrite(runtime);
  if (!requestScoped) {
    if (activeStandalone && commandType !== 'command.cancel') return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser tab is executing standalone command ${activeStandalone.commandId}` });
    if (runtime.lease && definition.allowDuringLease !== true && commandType !== 'command.cancel') {
      const reason = runtime.lease.status === 'quarantined'
        ? `Browser tab is quarantined: ${runtime.lease.quarantineReason || 'release outcome is unresolved'}`
        : `Browser tab is leased by active request ${runtime.lease.requestId}`;
      return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: reason, code: runtime.lease.status === 'quarantined' ? 'BROWSER_TAB_QUARANTINED' : 'BROWSER_TAB_LEASED' });
    }
    return registerAndDispatchCommand({ state, envelope, payload, backgroundState, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post, scope: 'standalone', request: null });
  }

  if (activeStandalone) return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser tab is executing standalone command ${activeStandalone.commandId}` });
  if (runtime.lease?.status === 'quarantined') return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser tab is quarantined: ${runtime.lease.quarantineReason || 'release outcome is unresolved'}`, code: 'BROWSER_TAB_QUARANTINED' });
  if (definition.mode === 'effect') {
    const descriptorError = validateEffectBackedCommand(commandType, payload, envelope.request);
    if (descriptorError) return rejectCommand({ state, envelope, payload, sendProtocolMessage, code: 'REQUEST_EXECUTION_PLAN_INVALID', message: descriptorError });
  }

  if (!runtime.lease) {
    const claimed = await backgroundState.transition(state.tabId, { type: 'lease.claim', ...envelope.request, conversationId: String(payload.sessionId || payload.conversationId || ''), contentEpoch: state.contentEpoch });
    if (!claimed.accepted) return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser lease rejected: ${claimed.reason}` });
    runtime = claimed.state;
  } else if (payload.type === 'request.resume' && runtime.lease.requestId === envelope.request.requestId
    && runtime.lease.ownerServerInstanceId === String(payload.previousOwnerServerInstanceId || '')) {
    const handoff = await backgroundState.transition(state.tabId, {
      type: 'lease.handoff', ...envelope.request, previousLeaseId: runtime.lease.leaseId,
      previousResponseEpoch: runtime.lease.responseEpoch, previousOwnerServerInstanceId: payload.previousOwnerServerInstanceId,
      contentEpoch: state.contentEpoch,
    });
    if (!handoff.accepted) return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser lease handoff rejected: ${handoff.reason}` });
    runtime = handoff.state;
  } else if (runtime.lease.requestId === envelope.request.requestId
    && runtime.lease.leaseId === envelope.request.leaseId
    && runtime.lease.ownerServerInstanceId === envelope.request.ownerServerInstanceId
    && Number(envelope.request.responseEpoch) === Number(runtime.lease.responseEpoch) + 1) {
    const adopted = await backgroundState.transition(state.tabId, {
      type: 'lease.epoch_adopted', ...envelope.request, previousResponseEpoch: runtime.lease.responseEpoch, contentEpoch: state.contentEpoch,
    });
    if (!adopted.accepted) return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Canonical response epoch adoption rejected: ${adopted.reason}` });
    runtime = adopted.state;
  } else if (runtime.lease.requestId !== envelope.request.requestId || runtime.lease.leaseId !== envelope.request.leaseId
    || runtime.lease.ownerServerInstanceId !== envelope.request.ownerServerInstanceId || runtime.lease.responseEpoch !== envelope.request.responseEpoch) {
    return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: 'Browser lease belongs to another request, server instance, or response epoch' });
  }

  const desiredLeaseStatus = payload.type === 'request.release' ? 'releasing' : 'executing';
  const currentRuntime = await backgroundState.read(state.tabId);
  const executing = currentRuntime.lease?.status === desiredLeaseStatus
    ? { accepted: true, state: currentRuntime }
    : await backgroundState.transition(state.tabId, { type: `lease.${desiredLeaseStatus}`, ...envelope.request, contentEpoch: state.contentEpoch });
  if (!executing.accepted) return rejectCommand({ state, envelope, payload, sendProtocolMessage, message: `Browser executor rejected command: ${executing.reason}` });

  if (definition.mode === 'effect') {
    return registerAndDispatchEffectCommand({ state, envelope, payload, backgroundState, createEnvelopeDraft, flushCriticalOutbox, post, request: envelope.request, sendProtocolMessage });
  }
  return registerAndDispatchCommand({ state, envelope, payload, backgroundState, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post, scope: 'request', request: envelope.request });
}

async function registerAndDispatchEffectCommand({ state, envelope, payload, backgroundState, createEnvelopeDraft, flushCriticalOutbox, post, request, sendProtocolMessage }) {
  const commandId = String(payload.commandId || envelope.commandId || '');
  const commandType = String(payload.type || '');
  const descriptor = effectDescriptorForCommand(commandType, payload);
  const descriptorError = validateEffectBackedCommand(commandType, payload, request);
  if (descriptorError) throw new Error(descriptorError);
  const acceptedBody = { commandId, requestId: request.requestId, commandScope: 'request', commandMode: 'effect', effectId: String(descriptor.effectId), effectType: String(descriptor.kind) };
  const acceptedEnvelope = createEnvelopeDraft(state, MessageType.COMMAND_ACCEPTED, acceptedBody, {
    commandId, causationId: envelope.messageId, lease: request,
  });
  const dispatched = await backgroundState.transition(state.tabId, {
    type: 'effect_command.dispatched',
    commandId,
    commandType,
    effectId: String(descriptor.effectId),
    kind: String(descriptor.kind),
    idempotencyKey: String(descriptor.idempotencyKey),
    retryPolicy: String(descriptor.retryPolicy || payload.retryPolicy || 'never'),
    preconditions: descriptor.preconditions && typeof descriptor.preconditions === 'object' ? descriptor.preconditions : {},
    preconditionsHash: String(descriptor.preconditionsHash || ''),
    evidence: descriptor.evidence && typeof descriptor.evidence === 'object' ? descriptor.evidence : null,
    attempt: Math.max(1, Number(descriptor.attempt) || 1),
    causationId: String(descriptor.causationId || envelope.messageId),
    acceptedEnvelope,
    ...request,
    contentEpoch: state.contentEpoch,
  });
  if (!dispatched.accepted) throw new Error(`Effect-backed browser command dispatch rejected: ${dispatched.reason}`);
  await flushCriticalOutbox(state);
  post(state.port, { type: 'server.message', payload: {
    ...payload,
    requestId: request.requestId,
    responseEpoch: Number(request.responseEpoch) || 0,
    commandScope: 'request',
    commandMode: 'effect',
    leaseId: request.leaseId,
    ownerServerInstanceId: request.ownerServerInstanceId,
    protocolMessageId: envelope.messageId,
  } });
}

async function registerAndDispatchCommand({ state, envelope, payload, backgroundState, createEnvelopeDraft, flushCriticalOutbox, scheduleReleaseDeadline, post, scope, request }) {
  const commandId = String(payload.commandId || envelope.commandId || '');
  const definition = commandDefinition(String(payload.type || ''));
  if (!definition) throw new Error(`Unsupported browser command type: ${String(payload.type || 'missing')}`);
  const mode = definition.mode;
  const releaseBody = mode === 'release' ? {
    commandId, requestId: request?.requestId || '', released: true, activeRequest: null,
  } : null;
  const terminalEnvelope = releaseBody ? createEnvelopeDraft(state, MessageType.LEASE_RELEASED, releaseBody, {
    commandId, causationId: envelope.messageId, lease: request,
  }) : null;
  const registered = await backgroundState.transition(state.tabId, {
    type: 'command.registered', scope, commandId, commandType: String(payload.type || ''), mode,
    terminalEnvelope, causationId: envelope.messageId, idempotencyKey: String(payload.idempotencyKey || commandId),
    retryPolicy: String(definition.retryPolicy),
    reconcilePolicy: String(definition.reconcile || ''),
    operation: String(definition.operation || ''),
    preconditions: payload.preconditions && typeof payload.preconditions === 'object' ? payload.preconditions : {
      commandType: String(payload.type || ''), conversationId: String(payload.sessionId || payload.conversationId || ''), protocolMessageId: envelope.messageId,
    },
    ...(request || {}), contentEpoch: state.contentEpoch,
  });
  if (!registered.accepted) throw new Error(`Browser command registration rejected: ${registered.reason}`);

  const acceptedBody = { commandId, requestId: request?.requestId || '', commandScope: scope, commandMode: mode };
  const acceptedEnvelope = createEnvelopeDraft(state, MessageType.COMMAND_ACCEPTED, acceptedBody, {
    commandId, causationId: envelope.messageId, lease: request,
  });
  const dispatched = await backgroundState.transition(state.tabId, {
    type: 'command.dispatched', commandId, acceptedEnvelope, ...(scope === 'request' ? request : {}), contentEpoch: state.contentEpoch,
  });
  if (!dispatched.accepted) throw new Error(`Browser command dispatch rejected: ${dispatched.reason}`);
  await flushCriticalOutbox(state);
  if (mode === 'release') scheduleReleaseDeadline?.(state, commandId, Number(payload.releaseCleanupTimeoutMs) || 8_000);

  const commandPayload = payload.type === 'request.effect.reconcile'
    ? { ...payload, backgroundEvidence: backgroundEffectReconciliationEvidence(await backgroundState.read(state.tabId), payload) }
    : payload;
  post(state.port, { type: 'server.message', payload: {
    ...commandPayload, requestId: request?.requestId || '', responseEpoch: Number(request?.responseEpoch) || 0,
    commandScope: scope, commandMode: mode, leaseId: request?.leaseId || '', ownerServerInstanceId: request?.ownerServerInstanceId || '',
    protocolMessageId: envelope.messageId,
  } });
}

async function rejectCommand({ state, envelope, payload, sendProtocolMessage, message, code = 'BROWSER_COMMAND_REJECTED' }) {
  await sendProtocolMessage(state, MessageType.COMMAND_REJECTED, {
    commandId: payload.commandId, requestId: envelope.request?.requestId || '', code, message, error: message,
  }, { commandId: payload.commandId, causationId: envelope.messageId, lease: envelope.request || null });
}
