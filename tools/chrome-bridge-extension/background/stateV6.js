export const BACKGROUND_STATE_SCHEMA_VERSION = 6;
export const BACKGROUND_STATE_STORAGE_PREFIX = 'chatgptBridgeV6:tab:';
export const BACKGROUND_EPOCH_STORAGE_KEY = 'chatgptBridgeV6:backgroundEpoch';
export const LEGACY_BACKGROUND_STATE_PREFIXES = Object.freeze([
  'chatgptBridgeV1:',
  'chatgptBridgeV2:',
  'chatgptBridgeV3:',
  'chatgptBridgeV4:',
  'chatgptBridgeV5:',
]);

export const LeaseStatus = Object.freeze({
  IDLE: 'idle',
  CLAIMED: 'claimed',
  RECONCILING: 'reconciling',
  EXECUTING: 'executing',
  RELEASING: 'releasing',
  QUARANTINED: 'quarantined',
});

export const EffectStatus = Object.freeze({
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  ACCEPTED: 'accepted',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
  CANCELLED: 'cancelled',
});

export const CommandStatus = Object.freeze({
  REGISTERED: 'registered',
  DISPATCHED: 'dispatched',
  ACCEPTED: 'accepted',
  SUCCEEDED: 'succeeded',
  REJECTED: 'rejected',
  UNCERTAIN: 'uncertain',
});

export const DownloadStatus = Object.freeze({
  PLANNED: 'planned',
  ARMED: 'armed',
  BOUND: 'bound',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RELEASED: 'released',
});

const JOURNAL_LIMIT = 200;
const OUTBOX_LIMIT = 1_000;
const OUTBOX_RESERVED_CRITICAL = 64;
const EFFECT_LIMIT = 200;
const COMMAND_LIMIT = 200;
const COMMAND_RESULT_LIMIT_BYTES = 512 * 1024;
const LEASE_TRANSITIONS = Object.freeze({
  [LeaseStatus.CLAIMED]: new Set([LeaseStatus.RECONCILING, LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.RECONCILING]: new Set([LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.EXECUTING]: new Set([LeaseStatus.RECONCILING, LeaseStatus.RELEASING]),
  [LeaseStatus.RELEASING]: new Set([LeaseStatus.QUARANTINED]),
  [LeaseStatus.QUARANTINED]: new Set(),
});
const EFFECT_TRANSITIONS = Object.freeze({
  [EffectStatus.PLANNED]: new Set([EffectStatus.DISPATCHED, EffectStatus.CANCELLED, EffectStatus.FAILED, EffectStatus.UNCERTAIN]),
  [EffectStatus.DISPATCHED]: new Set([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED]),
});
const COMMAND_TRANSITIONS = Object.freeze({
  [CommandStatus.REGISTERED]: new Set([CommandStatus.DISPATCHED, CommandStatus.ACCEPTED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN]),
  [CommandStatus.DISPATCHED]: new Set([CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN]),
});
const DOWNLOAD_TRANSITIONS = Object.freeze({
  [DownloadStatus.PLANNED]: new Set([DownloadStatus.ARMED, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
  [DownloadStatus.ARMED]: new Set([DownloadStatus.BOUND, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
  [DownloadStatus.BOUND]: new Set([DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
});

function now(event) {
  return Number(event?.at) || Date.now();
}

function canonicalValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function stableHash(value) {
  const input = JSON.stringify(canonicalValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function journal(state, event, accepted, reason = '') {
  const entry = {
    revision: state.revision + (accepted ? 1 : 0),
    type: String(event?.type || 'unknown'),
    eventId: String(event?.eventId || ''),
    accepted,
    reason,
    at: now(event),
  };
  return [...state.journal, entry].slice(-JOURNAL_LIMIT);
}

export function createTabRuntimeState(tabId, backgroundEpoch = '') {
  return {
    schemaVersion: BACKGROUND_STATE_SCHEMA_VERSION,
    tabId: Number.isInteger(tabId) ? tabId : null,
    revision: 0,
    backgroundEpoch: String(backgroundEpoch || ''),
    contentEpoch: '',
    transport: {
      connectionEpoch: '',
      serverInstanceId: '',
      serverEpoch: '',
      connected: false,
      inboundSequence: 0,
      outboundSequence: 0,
      ackCursor: 0,
      rejectedAckCount: 0,
      lastRejectedAck: null,
      updatedAt: 0,
    },
    lease: null,
    commands: {},
    commandOrder: [],
    effects: {},
    effectOrder: [],
    downloads: {},
    outbox: [],
    metrics: { observationCoalesced: 0, outboxRejected: 0, outboxHighWater: 0, releaseBlocked: 0, releaseCompleted: 0 },
    journal: [],
    updatedAt: 0,
  };
}

function rejected(state, event, reason, patch = {}) {
  return { accepted: false, reason, state: { ...state, ...patch, journal: journal(state, event, false, reason) } };
}

function storedCommandResult(value) {
  if (value == null) return null;
  let clone;
  try { clone = JSON.parse(JSON.stringify(value)); } catch { return null; }
  const encoded = JSON.stringify(clone);
  if (encoded.length > COMMAND_RESULT_LIMIT_BYTES) {
    return {
      type: 'command.error',
      code: 'COMMAND_RESULT_PERSISTENCE_LIMIT',
      message: `Command result exceeded the durable ${COMMAND_RESULT_LIMIT_BYTES}-byte limit`,
      uncertain: true,
      omittedBytes: encoded.length,
    };
  }
  return clone;
}

function enqueueEnvelopePatch(state, envelope) {
  if (!envelope?.messageId || envelope.protocolVersion !== 5 || !envelope.messageType || !envelope.body) {
    return { accepted: false, reason: 'outbox_message_invalid' };
  }
  if (state.outbox.some((item) => item.messageId === envelope.messageId)) {
    return { accepted: false, reason: 'duplicate_outbox_message' };
  }
  const isObservation = envelope.messageType === 'tab.observation';
  const observationKey = isObservation
    ? [String(envelope.request?.requestId || 'passive'), String(envelope.request?.leaseId || ''), String(envelope.source?.contentEpoch || '')].join(':')
    : '';
  const retained = isObservation
    ? state.outbox.filter((item) => !(item.messageType === 'tab.observation'
      && [String(item.request?.requestId || 'passive'), String(item.request?.leaseId || ''), String(item.source?.contentEpoch || '')].join(':') === observationKey))
    : state.outbox;
  const terminalCritical = new Set(['command.rejected', 'command.result', 'effect.succeeded', 'effect.failed', 'effect.uncertain', 'effect.cancelled', 'lease.released', 'lease.quarantined']);
  const correctnessCritical = terminalCritical.has(String(envelope.messageType || ''));
  const capacity = correctnessCritical ? OUTBOX_LIMIT : Math.max(1, OUTBOX_LIMIT - OUTBOX_RESERVED_CRITICAL);
  if (retained.length >= capacity) return { accepted: false, reason: correctnessCritical ? 'critical_outbox_full' : 'outbox_reserved_capacity' };
  const outbox = [...retained, envelope];
  return {
    accepted: true,
    patch: {
      outbox,
      metrics: {
        ...state.metrics,
        observationCoalesced: (Number(state.metrics?.observationCoalesced) || 0) + Math.max(0, state.outbox.length - retained.length),
        outboxHighWater: Math.max(Number(state.metrics?.outboxHighWater) || 0, outbox.length),
      },
    },
  };
}

function settleReadyRelease(state, at) {
  const lease = state.lease;
  if (!lease || lease.status !== LeaseStatus.RELEASING) return state;
  const releaseCommand = (state.commandOrder || [])
    .map((id) => state.commands?.[id])
    .find((command) => command
      && command.scope === 'request'
      && command.commandType === 'request.release'
      && command.status === CommandStatus.DISPATCHED
      && command.releaseReadyAt
      && matchingPersistedRequestIdentity(command, lease, { requireResponseEpoch: true }));
  if (!releaseCommand) return state;
  const active = activeRequestChildren(state, lease);
  if (active.commands.length || active.effects.length || active.downloads.length) return state;
  const queued = enqueueEnvelopePatch(state, releaseCommand.terminalEnvelope);
  if (!queued.accepted) {
    return {
      ...state,
      lease: { ...lease, status: LeaseStatus.QUARANTINED, quarantineReason: queued.reason, quarantinedAt: at, updatedAt: at },
      metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
    };
  }
  return {
    ...state,
    ...queued.patch,
    lease: null,
    commands: {
      ...state.commands,
      [releaseCommand.commandId]: {
        ...releaseCommand,
        status: CommandStatus.SUCCEEDED,
        resultType: 'lease.released',
        releaseCompletedAt: at,
        updatedAt: at,
      },
    },
    metrics: {
      ...queued.patch.metrics,
      releaseCompleted: (Number(state.metrics?.releaseCompleted) || 0) + 1,
    },
  };
}
function committed(state, event, patch) {
  const at = now(event);
  const committedState = {
    ...state,
    ...patch,
    revision: state.revision + 1,
    journal: journal(state, event, true),
    updatedAt: at,
  };
  return { accepted: true, state: settleReadyRelease(committedState, at) };
}

function leaseIdentity(value = {}) {
  return {
    requestId: String(value.requestId || ''),
    leaseId: String(value.leaseId || ''),
    ownerServerInstanceId: String(value.ownerServerInstanceId || ''),
    responseEpoch: Math.max(0, Number(value.responseEpoch) || 0),
  };
}

function matchingLease(state, value, { requireResponseEpoch = false } = {}) {
  const lease = state.lease;
  if (!lease) return false;
  const identity = leaseIdentity(value);
  if (!identity.requestId || !identity.leaseId || !identity.ownerServerInstanceId) return false;
  if (requireResponseEpoch && value?.responseEpoch == null) return false;
  return identity.requestId === lease.requestId
    && identity.leaseId === lease.leaseId
    && identity.ownerServerInstanceId === lease.ownerServerInstanceId
    && (!requireResponseEpoch || identity.responseEpoch === Math.max(0, Number(lease.responseEpoch) || 0));
}

function matchingPersistedRequestIdentity(record, value, { requireResponseEpoch = true } = {}) {
  if (!record) return false;
  const identity = leaseIdentity(value);
  if (!identity.requestId || !identity.leaseId || !identity.ownerServerInstanceId) return false;
  if (requireResponseEpoch && value?.responseEpoch == null) return false;
  return identity.requestId === String(record.requestId || '')
    && identity.leaseId === String(record.leaseId || '')
    && identity.ownerServerInstanceId === String(record.ownerServerInstanceId || '')
    && (!requireResponseEpoch || identity.responseEpoch === Math.max(0, Number(record.responseEpoch) || 0));
}

function activeRequestChildren(state, lease) {
  const requestId = String(lease?.requestId || '');
  const leaseId = String(lease?.leaseId || '');
  const commands = Object.values(state.commands || {}).filter((command) => command
    && command.scope === 'request'
    && command.requestId === requestId
    && command.leaseId === leaseId
    && [CommandStatus.REGISTERED, CommandStatus.DISPATCHED, CommandStatus.ACCEPTED].includes(command.status)
    && command.commandType !== 'request.release');
  const effects = Object.values(state.effects || {}).filter((effect) => effect
    && effect.requestId === requestId
    && effect.leaseId === leaseId
    && [EffectStatus.PLANNED, EffectStatus.DISPATCHED].includes(effect.status));
  const downloads = Object.values(state.downloads || {}).filter((download) => download
    && download.requestId === requestId
    && download.leaseId === leaseId
    && [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND].includes(download.status));
  return { commands, effects, downloads };
}

function boundedCommands(commands, order) {
  const nextOrder = order.slice(-COMMAND_LIMIT);
  const keep = new Set(nextOrder);
  return {
    commands: Object.fromEntries(Object.entries(commands).filter(([id]) => keep.has(id))),
    commandOrder: nextOrder,
  };
}

function boundedEffects(effects, order) {
  const nextOrder = order.slice(-EFFECT_LIMIT);
  const keep = new Set(nextOrder);
  return {
    effects: Object.fromEntries(Object.entries(effects).filter(([id]) => keep.has(id))),
    effectOrder: nextOrder,
  };
}

export function reduceTabRuntimeState(state, event) {
  if (!state || state.schemaVersion !== BACKGROUND_STATE_SCHEMA_VERSION) return rejected(createTabRuntimeState(event?.tabId), event, 'invalid_state');
  if (!event || typeof event.type !== 'string') return rejected(state, event, 'invalid_event');
  if (event.tabId != null && event.tabId !== state.tabId) return rejected(state, event, 'tab_mismatch');
  if (event.backgroundEpoch && event.backgroundEpoch !== state.backgroundEpoch) return rejected(state, event, 'background_epoch_mismatch');
  if (event.contentEpoch && state.contentEpoch && event.contentEpoch !== state.contentEpoch && event.type !== 'content.attached') {
    return rejected(state, event, 'content_epoch_mismatch');
  }

  switch (event.type) {
    case 'content.attached': {
      const contentEpoch = String(event.contentEpoch || '');
      if (!contentEpoch) return rejected(state, event, 'content_epoch_missing');
      const lease = state.lease && state.lease.status !== LeaseStatus.IDLE
        ? { ...state.lease, status: state.lease.status === LeaseStatus.RELEASING ? LeaseStatus.RELEASING : LeaseStatus.RECONCILING, contentEpoch, updatedAt: now(event) }
        : state.lease;
      return committed(state, event, { contentEpoch, lease });
    }
    case 'lease.claim': {
      const requestId = String(event.requestId || '');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      if (!requestId || !leaseId || !ownerServerInstanceId) return rejected(state, event, 'lease_identity_missing');
      if (state.lease && state.lease.status !== LeaseStatus.IDLE) {
        if (matchingLease(state, event)) return rejected(state, event, 'duplicate_lease');
        return rejected(state, event, 'lease_conflict');
      }
      return committed(state, event, {
        lease: {
          requestId,
          leaseId,
          ownerServerInstanceId,
          responseEpoch: Math.max(0, Number(event.responseEpoch) || 0),
          conversationId: String(event.conversationId || ''),
          contentEpoch: state.contentEpoch,
          status: LeaseStatus.CLAIMED,
          claimedAt: now(event),
          updatedAt: now(event),
        },
      });
    }
    case 'lease.handoff': {
      if (!state.lease || state.lease.requestId !== String(event.requestId || '')) return rejected(state, event, 'lease_mismatch');
      if (!String(event.previousLeaseId || '') || state.lease.leaseId !== String(event.previousLeaseId || '')) return rejected(state, event, 'previous_lease_mismatch');
      if (event.previousResponseEpoch == null || Math.max(0, Number(event.previousResponseEpoch) || 0) !== Math.max(0, Number(state.lease.responseEpoch) || 0)) return rejected(state, event, 'previous_response_epoch_mismatch');
      if (state.lease.ownerServerInstanceId !== String(event.previousOwnerServerInstanceId || '')) return rejected(state, event, 'previous_owner_mismatch');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      if (!leaseId || !ownerServerInstanceId) return rejected(state, event, 'lease_identity_missing');
      return committed(state, event, { lease: {
        ...state.lease,
        leaseId,
        ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        status: LeaseStatus.RECONCILING,
        contentEpoch: state.contentEpoch,
        updatedAt: now(event),
      } });
    }
    case 'lease.executing':
    case 'lease.reconciling':
    case 'lease.releasing': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      const status = event.type.split('.')[1];
      if (!LEASE_TRANSITIONS[state.lease.status]?.has(status)) return rejected(state, event, 'lease_transition_invalid');
      return committed(state, event, { lease: { ...state.lease, status, updatedAt: now(event) } });
    }
    case 'lease.epoch_adopted': {
      if (!state.lease) return rejected(state, event, 'lease_missing');
      const previous = Math.max(0, Number(event.previousResponseEpoch) || 0);
      const target = Math.max(0, Number(event.responseEpoch) || 0);
      if (String(event.requestId || '') !== state.lease.requestId
        || String(event.leaseId || '') !== state.lease.leaseId
        || String(event.ownerServerInstanceId || '') !== state.lease.ownerServerInstanceId) return rejected(state, event, 'lease_mismatch');
      if (previous !== Math.max(0, Number(state.lease.responseEpoch) || 0)) return rejected(state, event, 'previous_response_epoch_mismatch');
      if (target !== previous + 1) return rejected(state, event, 'response_epoch_not_monotonic');
      return committed(state, event, { lease: { ...state.lease, responseEpoch: target, updatedAt: now(event) } });
    }
    case 'lease.quarantine': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      return committed(state, event, { lease: { ...state.lease, status: LeaseStatus.QUARANTINED, quarantineReason: String(event.reason || 'release_unproven'), quarantinedAt: now(event), updatedAt: now(event) } });
    }
    case 'lease.release': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (state.lease.status !== LeaseStatus.RELEASING) return rejected(state, event, 'lease_not_releasing');
      const active = activeRequestChildren(state, state.lease);
      if (active.commands.length || active.effects.length || active.downloads.length) {
        return rejected(state, event, 'lease_children_active', {
          metrics: {
            ...state.metrics,
            releaseBlocked: (Number(state.metrics?.releaseBlocked) || 0) + 1,
          },
        });
      }
      return committed(state, event, { lease: null });
    }
    case 'effect_command.dispatched': {
      const commandId = String(event.commandId || '');
      const effectId = String(event.effectId || '');
      const idempotencyKey = String(event.idempotencyKey || '');
      const kind = String(event.kind || '');
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (!commandId || !effectId || !idempotencyKey || !kind) return rejected(state, event, 'effect_command_identity_missing');
      if (state.commands?.[commandId]) return rejected(state, event, 'duplicate_command');
      if (state.effects?.[effectId]) return rejected(state, event, 'duplicate_effect');
      const queued = enqueueEnvelopePatch(state, event.acceptedEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const at = now(event);
      const preconditions = event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {};
      const preconditionsHash = String(event.preconditionsHash || stableHash(preconditions));
      const command = {
        commandId,
        commandType: String(event.commandType || ''),
        causationId: String(event.causationId || ''),
        scope: 'request',
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(state.lease.responseEpoch) || 0),
        idempotencyKey,
        preconditions,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'never',
        mode: 'effect',
        status: CommandStatus.ACCEPTED,
        physicalEffectId: effectId,
        createdAt: at,
        dispatchedAt: at,
        updatedAt: at,
      };
      const effect = {
        effectId,
        kind,
        idempotencyKey,
        commandId,
        causationId: String(event.causationId || commandId),
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        preconditions,
        preconditionsHash,
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : null,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'if_unconfirmed',
        attempt: Math.max(1, Number(event.attempt) || 1),
        status: EffectStatus.DISPATCHED,
        plannedAt: at,
        dispatchedAt: at,
        settledAt: 0,
        reconciliationEvidence: null,
        result: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      return committed(state, event, {
        ...queued.patch,
        ...boundedCommands({ ...(state.commands || {}), [commandId]: command }, [...(state.commandOrder || []), commandId]),
        ...boundedEffects({ ...(state.effects || {}), [effectId]: effect }, [...(state.effectOrder || []), effectId]),
      });
    }
    case 'command.registered': {
      const scope = event.scope === 'standalone' ? 'standalone' : 'request';
      if (scope === 'request' && !matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      const commandId = String(event.commandId || '');
      if (!commandId) return rejected(state, event, 'command_identity_missing');
      if (state.commands?.[commandId]) return rejected(state, event, 'duplicate_command');
      const commands = { ...(state.commands || {}), [commandId]: {
        commandId,
        commandType: String(event.commandType || ''),
        causationId: String(event.causationId || ''),
        scope,
        requestId: scope === 'request' ? state.lease.requestId : '',
        leaseId: scope === 'request' ? state.lease.leaseId : '',
        ownerServerInstanceId: scope === 'request' ? state.lease.ownerServerInstanceId : '',
        responseEpoch: scope === 'request' ? Math.max(0, Number(state.lease.responseEpoch) || 0) : 0,
        idempotencyKey: String(event.idempotencyKey || commandId),
        preconditions: event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {},
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'never',
        reconcilePolicy: String(event.reconcilePolicy || ''),
        operation: String(event.operation || ''),
        mode: ['effect', 'result', 'release'].includes(event.mode) ? event.mode : 'result',
        terminalEnvelope: event.terminalEnvelope || null,
        status: CommandStatus.REGISTERED,
        createdAt: now(event),
        updatedAt: now(event),
      } };
      return committed(state, event, boundedCommands(commands, [...(state.commandOrder || []), commandId]));
    }
    case 'command.dispatched': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.scope !== 'standalone') {
        if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
        if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      }
      if (command.status !== CommandStatus.REGISTERED) return rejected(state, event, 'command_transition_invalid');
      const queued = enqueueEnvelopePatch(state, event.acceptedEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const status = command.mode === 'effect' ? CommandStatus.ACCEPTED : CommandStatus.DISPATCHED;
      return committed(state, event, {
        ...queued.patch,
        commands: { ...state.commands, [command.commandId]: { ...command, status, dispatchedAt: now(event), updatedAt: now(event) } },
      });
    }
    case 'command.succeeded':
    case 'command.rejected':
    case 'command.uncertain': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.mode === 'effect') return rejected(state, event, 'effect_backed_command_has_no_terminal_result');
      if (command.scope !== 'standalone') {
        if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
        if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      }
      if (command.commandType === 'request.release' && event.type === 'command.succeeded') return rejected(state, event, 'release_requires_barrier');
      if ([CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN].includes(command.status)) return rejected(state, event, 'command_terminal');
      const status = event.type.split('.')[1];
      if (!COMMAND_TRANSITIONS[command.status]?.has(status)) return rejected(state, event, 'command_transition_invalid');
      const resultPayload = storedCommandResult(event.resultPayload ?? event.result ?? null);
      const resultTooLarge = resultPayload?.code === 'COMMAND_RESULT_PERSISTENCE_LIMIT';
      const settledStatus = resultTooLarge ? CommandStatus.UNCERTAIN : status;
      const queued = enqueueEnvelopePatch(state, event.terminalEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const releaseFailed = command.mode === 'release' && event.type !== 'command.succeeded';
      return committed(state, event, {
        ...queued.patch,
        lease: releaseFailed && state.lease ? {
          ...state.lease,
          status: LeaseStatus.QUARANTINED,
          quarantineReason: String(event.error?.message || event.resultPayload?.message || 'release_cleanup_failed'),
          quarantinedAt: now(event),
          updatedAt: now(event),
        } : state.lease,
        commands: { ...state.commands, [command.commandId]: {
          ...command,
          status: settledStatus,
          resultType: resultTooLarge ? 'command.result.persistence_limit' : String(event.resultType || ''),
          resultPayload,
          error: resultTooLarge ? { code: resultPayload.code, message: resultPayload.message } : (event.error || null),
          updatedAt: now(event),
        } },
      });
    }
    case 'command.release_ready': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.scope !== 'request' || command.commandType !== 'request.release') return rejected(state, event, 'command_not_release');
      if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
      if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (command.status !== CommandStatus.DISPATCHED) return rejected(state, event, 'release_command_not_dispatched');
      if (state.lease.status !== LeaseStatus.RELEASING) return rejected(state, event, 'lease_not_releasing');
      if (command.releaseReadyAt) return rejected(state, event, 'release_already_ready');
      return committed(state, event, { commands: { ...state.commands, [command.commandId]: {
        ...command,
        releaseReadyAt: now(event),
        resultType: 'lease.released',
        updatedAt: now(event),
      } } });
    }
    case 'effect.planned': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const effectId = String(event.effectId || '');
      const idempotencyKey = String(event.idempotencyKey || '');
      if (!effectId || !idempotencyKey) return rejected(state, event, 'effect_identity_missing');
      if (state.effects[effectId]) return rejected(state, event, 'duplicate_effect');
      const preconditions = event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {};
      const computedPreconditionsHash = stableHash(preconditions);
      // The canonical server owns semantic effect identity and may provide a
      // stronger hash algorithm than the background reducer. Background stores
      // that immutable guard verbatim and enforces it on every later transition;
      // it computes its local deterministic fallback only for non-server tests
      // and legacy internal callers that omit a hash.
      const preconditionsHash = String(event.preconditionsHash || computedPreconditionsHash);
      if (!preconditionsHash) return rejected(state, event, 'preconditions_hash_missing');
      const plannedAt = now(event);
      const effects = { ...state.effects, [effectId]: {
        effectId,
        kind: String(event.kind || ''),
        idempotencyKey,
        commandId: String(event.commandId || ''),
        causationId: String(event.causationId || event.commandId || ''),
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        preconditions,
        preconditionsHash,
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : null,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'if_unconfirmed',
        attempt: Math.max(1, Number(event.attempt) || 1),
        status: EffectStatus.PLANNED,
        plannedAt,
        dispatchedAt: 0,
        settledAt: 0,
        reconciliationEvidence: null,
        result: null,
        error: null,
        createdAt: plannedAt,
        updatedAt: plannedAt,
      } };
      return committed(state, event, boundedEffects(effects, [...state.effectOrder, effectId]));
    }
    case 'effect.dispatched':
    case 'effect.succeeded':
    case 'effect.failed':
    case 'effect.uncertain':
    case 'effect.cancelled': {
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (!matchingPersistedRequestIdentity(effect, event, { requireResponseEpoch: true })) return rejected(state, event, 'effect_identity_mismatch');
      if (!matchingLease(state, effect, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (event.idempotencyKey && event.idempotencyKey !== effect.idempotencyKey) return rejected(state, event, 'idempotency_key_mismatch');
      if ([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED].includes(effect.status)) return rejected(state, event, 'effect_terminal');
      const status = event.type.split('.')[1];
      if (!EFFECT_TRANSITIONS[effect.status]?.has(status)) return rejected(state, event, 'effect_transition_invalid');
      if (status === EffectStatus.CANCELLED && effect.status === EffectStatus.DISPATCHED && event.provenNotExecuted !== true) {
        return rejected(state, event, 'effect_cancellation_unproven');
      }
      if (event.preconditionsHash && event.preconditionsHash !== effect.preconditionsHash) return rejected(state, event, 'preconditions_hash_mismatch');
      const transitionAt = now(event);
      const terminal = [EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED].includes(status);
      const queued = terminal ? enqueueEnvelopePatch(state, event.terminalEnvelope) : { accepted: true, patch: {} };
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const linkedCommand = effect.commandId ? state.commands?.[effect.commandId] || null : null;
      const linkedCommandStatus = status === EffectStatus.SUCCEEDED
        ? CommandStatus.SUCCEEDED
        : status === EffectStatus.UNCERTAIN
          ? CommandStatus.UNCERTAIN
          : CommandStatus.REJECTED;
      const commandPatch = terminal && linkedCommand?.mode === 'effect'
        ? { ...state.commands, [linkedCommand.commandId]: {
          ...linkedCommand,
          status: linkedCommandStatus,
          physicalEffectId: effect.effectId,
          physicalEffectStatus: status,
          updatedAt: transitionAt,
        } }
        : state.commands;
      return committed(state, event, { ...queued.patch, commands: commandPatch, effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        status,
        attempt: Math.max(effect.attempt || 1, Number(event.attempt) || effect.attempt || 1),
        dispatchedAt: status === EffectStatus.DISPATCHED ? transitionAt : effect.dispatchedAt,
        settledAt: terminal ? transitionAt : effect.settledAt,
        result: event.result || null,
        error: event.error || null,
        reconciliationEvidence: event.reconciliationEvidence && typeof event.reconciliationEvidence === 'object'
          ? event.reconciliationEvidence
          : effect.reconciliationEvidence,
        cancellationEvidence: status === EffectStatus.CANCELLED
          ? (event.cancellationEvidence && typeof event.cancellationEvidence === 'object' ? event.cancellationEvidence : null)
          : effect.cancellationEvidence || null,
        updatedAt: transitionAt,
      } } });
    }
    case 'effect.reconciliation_recorded': {
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (!matchingPersistedRequestIdentity(effect, event, { requireResponseEpoch: true })) return rejected(state, event, 'effect_identity_mismatch');
      if (event.idempotencyKey !== effect.idempotencyKey) return rejected(state, event, 'idempotency_key_mismatch');
      if (event.preconditionsHash !== effect.preconditionsHash) return rejected(state, event, 'preconditions_hash_mismatch');
      const evidence = event.reconciliationEvidence && typeof event.reconciliationEvidence === 'object'
        ? event.reconciliationEvidence
        : null;
      if (!evidence) return rejected(state, event, 'reconciliation_evidence_missing');
      return committed(state, event, { effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        reconciliationEvidence: evidence,
        reconciledAt: now(event),
        updatedAt: now(event),
      } } });
    }
    case 'outbox.enqueued': {
      const queued = enqueueEnvelopePatch(state, event.envelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      return committed(state, event, queued.patch);
    }
    case 'outbox.acknowledged': {
      const messageId = String(event.messageId || '');
      const found = state.outbox.some((item) => item.messageId === messageId);
      if (!found) return rejected(state, event, 'outbox_message_missing');
      return committed(state, event, {
        transport: {
          ...state.transport,
          ackCursor: Math.max(Number(state.transport?.ackCursor) || 0, Number(event.sequence) || 0),
          updatedAt: now(event),
        },
        outbox: state.outbox.filter((item) => item.messageId !== messageId),
      });
    }
    case 'transport.ack_rejected': {
      const messageId = String(event.messageId || '');
      if (!messageId) return rejected(state, event, 'outbox_message_missing');
      const found = state.outbox.some((item) => item.messageId === messageId);
      if (!found) return rejected(state, event, 'outbox_message_missing');
      return committed(state, event, {
        transport: {
          ...state.transport,
          rejectedAckCount: (Number(state.transport?.rejectedAckCount) || 0) + 1,
          lastRejectedAck: {
            messageId,
            reason: String(event.reason || 'server_rejected'),
            at: now(event),
          },
          updatedAt: now(event),
        },
      });
    }
    case 'outbox.resequenced': {
      const envelope = event.envelope;
      if (!envelope?.messageId) return rejected(state, event, 'outbox_message_missing');
      const index = state.outbox.findIndex((item) => item.messageId === envelope.messageId);
      if (index < 0) return rejected(state, event, 'outbox_message_missing');
      const outbox = state.outbox.slice();
      outbox[index] = envelope;
      return committed(state, event, { outbox });
    }
    case 'transport.connected': {
      const connectionEpoch = String(event.connectionEpoch || '');
      const serverEpoch = String(event.serverEpoch || '');
      const serverInstanceId = String(event.serverInstanceId || '');
      if (!connectionEpoch) return rejected(state, event, 'connection_epoch_missing');
      const epochChanged = Boolean(serverEpoch && serverEpoch !== state.transport?.serverEpoch);
      return committed(state, event, { transport: {
        ...(state.transport || {}),
        connectionEpoch,
        serverEpoch: serverEpoch || state.transport?.serverEpoch || '',
        serverInstanceId: serverInstanceId || state.transport?.serverInstanceId || '',
        connected: true,
        inboundSequence: epochChanged ? 0 : Number(state.transport?.inboundSequence) || 0,
        updatedAt: now(event),
      } });
    }
    case 'transport.disconnected':
      return committed(state, event, { transport: {
        ...(state.transport || {}), connected: false, updatedAt: now(event),
      } });
    case 'transport.inbound': {
      const serverEpoch = String(event.serverEpoch || '');
      const sequence = Number(event.sequence);
      if (!serverEpoch) return rejected(state, event, 'server_epoch_missing');
      if (state.transport?.serverEpoch && state.transport.serverEpoch !== serverEpoch) return rejected(state, event, 'server_epoch_mismatch');
      if (!Number.isInteger(sequence) || sequence <= (Number(state.transport?.inboundSequence) || 0)) return rejected(state, event, 'stale_server_sequence');
      return committed(state, event, { transport: {
        ...(state.transport || {}), serverEpoch, inboundSequence: sequence, connected: true, updatedAt: now(event),
      } });
    }
    case 'transport.outbound.next':
      return committed(state, event, { transport: {
        ...(state.transport || {}), outboundSequence: (Number(state.transport?.outboundSequence) || 0) + 1, updatedAt: now(event),
      } });
    case 'download.identity_updated': {
      const captureId = String(event.captureId || '');
      const previous = state.downloads[captureId] || null;
      if (!previous) return rejected(state, event, 'download_missing');
      if ([DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(previous.status)) return rejected(state, event, 'download_terminal');
      if (previous.scope === 'standalone') {
        if (!event.commandId || String(event.commandId) !== String(previous.commandId || '')) {
          return rejected(state, event, 'download_identity_mismatch');
        }
      } else if (!matchingPersistedRequestIdentity(previous, event, { requireResponseEpoch: true })) {
        return rejected(state, event, 'download_identity_mismatch');
      }
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...previous,
        expectedNames: [...new Set([...(previous.expectedNames || []), ...(event.expectedNames || [])].map(String).filter(Boolean))],
        expectedArtifactIdentity: event.expectedArtifactIdentity || previous.expectedArtifactIdentity || null,
        updatedAt: now(event),
      } } });
    }
    case 'download.transition': {
      const captureId = String(event.captureId || '');
      const status = String(event.status || '');
      if (!captureId || !Object.values(DownloadStatus).includes(status)) return rejected(state, event, 'download_transition_invalid');
      const previous = state.downloads[captureId] || null;
      if (previous && [DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(previous.status)) {
        return rejected(state, event, 'download_terminal');
      }
      if (!previous && status !== DownloadStatus.PLANNED) return rejected(state, event, 'download_transition_invalid');
      if (previous && !DOWNLOAD_TRANSITIONS[previous.status]?.has(status)) return rejected(state, event, 'download_transition_invalid');
      const scope = previous?.scope || (event.scope === 'standalone' ? 'standalone' : 'request');
      const commandId = String(event.commandId || previous?.commandId || '');
      const requestId = String(event.requestId || '');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      const responseEpoch = Math.max(0, Number(event.responseEpoch) || 0);
      if (scope === 'request') {
        if (!requestId || !leaseId || !ownerServerInstanceId || event.responseEpoch == null) return rejected(state, event, 'download_identity_missing');
        if (previous && !matchingPersistedRequestIdentity(previous, event, { requireResponseEpoch: true })) return rejected(state, event, 'download_identity_mismatch');
        if (!previous && !matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
        if (status !== DownloadStatus.PLANNED && !matchingLease(state, previous, { requireResponseEpoch: true })) return rejected(state, event, 'download_lease_inactive');
      } else {
        if (!commandId) return rejected(state, event, 'download_identity_missing');
        if (previous && (previous.scope !== 'standalone' || previous.commandId !== commandId)) return rejected(state, event, 'download_identity_mismatch');
      }
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...(previous || {}),
        captureId,
        status,
        scope,
        commandId,
        requestId: scope === 'request' ? requestId : '',
        leaseId: scope === 'request' ? leaseId : '',
        ownerServerInstanceId: scope === 'request' ? ownerServerInstanceId : '',
        responseEpoch: scope === 'request' ? responseEpoch : 0,
        effectId: String(event.effectId || previous?.effectId || ''),
        artifactRequirementId: String(event.artifactRequirementId || previous?.artifactRequirementId || ''),
        artifactCandidateId: String(event.artifactCandidateId || previous?.artifactCandidateId || ''),
        expectedArtifactIdentity: event.expectedArtifactIdentity || previous?.expectedArtifactIdentity || null,
        downloadId: event.downloadId ?? previous?.downloadId ?? null,
        expectedNames: event.expectedNames || previous?.expectedNames || [],
        bindingSource: String(event.bindingSource || previous?.bindingSource || ''),
        result: event.result && typeof event.result === 'object' ? event.result : previous?.result || null,
        error: event.error && typeof event.error === 'object' ? event.error : previous?.error || null,
        updatedAt: now(event),
      } } });
    }
    default:
      return rejected(state, event, 'unknown_event');
  }
}

function storageKey(tabId) {
  return `${BACKGROUND_STATE_STORAGE_PREFIX}${tabId}`;
}

export class BackgroundStateStore {
  #storage;
  #states = new Map();
  #queues = new Map();
  #backgroundEpoch;

  constructor(storage, backgroundEpoch) {
    this.#storage = storage;
    this.#backgroundEpoch = String(backgroundEpoch || '');
  }

  get backgroundEpoch() { return this.#backgroundEpoch; }

  async read(tabId) {
    if (this.#states.has(tabId)) return this.#states.get(tabId);
    if (typeof this.#storage?.get !== 'function') {
      const error = new Error(`Background state storage is unavailable for tab ${tabId}`);
      error.code = 'BACKGROUND_STATE_READ_UNAVAILABLE';
      error.tabId = tabId;
      throw error;
    }
    let state = null;
    try {
      state = (await this.#storage.get(storageKey(tabId)))?.[storageKey(tabId)] || null;
    } catch (cause) {
      const error = new Error(`Background state read failed for tab ${tabId}: ${cause?.message || cause}`);
      error.code = 'BACKGROUND_STATE_READ_FAILED';
      error.tabId = tabId;
      error.cause = cause;
      throw error;
    }
    const defaults = createTabRuntimeState(tabId, this.#backgroundEpoch);
    if (!state || state.schemaVersion !== BACKGROUND_STATE_SCHEMA_VERSION || !state.transport) state = defaults;
    else state = {
      ...defaults,
      ...state,
      backgroundEpoch: this.#backgroundEpoch,
      transport: { ...defaults.transport, ...(state.transport || {}) },
      metrics: { ...defaults.metrics, ...(state.metrics || {}) },
      commands: state.commands || {},
      commandOrder: Array.isArray(state.commandOrder) ? state.commandOrder : [],
      effects: state.effects || {},
      effectOrder: Array.isArray(state.effectOrder) ? state.effectOrder : [],
      downloads: state.downloads || {},
      outbox: Array.isArray(state.outbox) ? state.outbox : [],
      journal: Array.isArray(state.journal) ? state.journal : [],
    };
    this.#states.set(tabId, state);
    return state;
  }

  transition(tabId, event) {
    const previous = this.#queues.get(tabId) || Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.read(tabId);
      const outcome = reduceTabRuntimeState(current, { ...event, tabId, backgroundEpoch: this.#backgroundEpoch });
      if (typeof this.#storage?.set !== 'function') {
        const error = new Error(`Background state persistence is unavailable for tab ${tabId}`);
        error.code = 'BACKGROUND_STATE_PERSIST_UNAVAILABLE';
        error.tabId = tabId;
        error.eventType = String(event?.type || '');
        throw error;
      }
      try {
        await this.#storage.set({ [storageKey(tabId)]: outcome.state });
      } catch (cause) {
        const error = new Error(`Background state persistence failed for tab ${tabId}: ${cause?.message || cause}`);
        error.code = 'BACKGROUND_STATE_PERSIST_FAILED';
        error.tabId = tabId;
        error.eventType = String(event?.type || '');
        error.cause = cause;
        throw error;
      }
      this.#states.set(tabId, outcome.state);
      return outcome;
    });
    this.#queues.set(tabId, next.catch(() => {}));
    return next;
  }


  async cleanupLegacyStateIfIdle() {
    if (typeof this.#storage?.get !== 'function' || typeof this.#storage?.remove !== 'function') return { removed: [], reason: 'storage_unavailable' };
    const all = await this.#storage.get(null);
    const stateEntries = Object.entries(all || {})
      .filter(([key, value]) => value && (
        key.startsWith(BACKGROUND_STATE_STORAGE_PREFIX)
        || LEGACY_BACKGROUND_STATE_PREFIXES.some((prefix) => key.startsWith(`${prefix}tab:`))
      ));
    const busy = stateEntries.some(([, state]) => state.lease
      || (state.outbox || []).length
      || Object.values(state.commands || {}).some((command) => [CommandStatus.REGISTERED, CommandStatus.DISPATCHED, CommandStatus.UNCERTAIN].includes(command?.status))
      || Object.values(state.effects || {}).some((effect) => [EffectStatus.PLANNED, EffectStatus.DISPATCHED, EffectStatus.UNCERTAIN].includes(effect?.status))
      || Object.values(state.downloads || {}).some((download) => [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND].includes(download?.status)));
    if (busy) return { removed: [], reason: 'active_background_state' };
    const legacyKeys = Object.keys(all || {}).filter((key) => LEGACY_BACKGROUND_STATE_PREFIXES.some((prefix) => key.startsWith(prefix)));
    if (legacyKeys.length) await this.#storage.remove(legacyKeys);
    return { removed: legacyKeys, reason: legacyKeys.length ? 'removed' : 'none' };
  }

  async remove(tabId) {
    if (typeof this.#storage?.remove !== 'function') {
      const error = new Error(`Background state removal is unavailable for tab ${tabId}`);
      error.code = 'BACKGROUND_STATE_REMOVE_UNAVAILABLE';
      error.tabId = tabId;
      throw error;
    }
    try {
      await this.#storage.remove(storageKey(tabId));
    } catch (cause) {
      const error = new Error(`Background state removal failed for tab ${tabId}: ${cause?.message || cause}`);
      error.code = 'BACKGROUND_STATE_REMOVE_FAILED';
      error.tabId = tabId;
      error.cause = cause;
      throw error;
    }
    this.#states.delete(tabId);
    this.#queues.delete(tabId);
  }
}

export function createRuntimeEpoch(prefix = 'epoch') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
