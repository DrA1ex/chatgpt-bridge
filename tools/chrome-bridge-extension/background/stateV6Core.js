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
export const LEASE_TRANSITIONS = Object.freeze({
  [LeaseStatus.CLAIMED]: new Set([LeaseStatus.RECONCILING, LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.RECONCILING]: new Set([LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.EXECUTING]: new Set([LeaseStatus.RECONCILING, LeaseStatus.RELEASING]),
  [LeaseStatus.RELEASING]: new Set([LeaseStatus.QUARANTINED]),
  [LeaseStatus.QUARANTINED]: new Set(),
});
export const EFFECT_TRANSITIONS = Object.freeze({
  [EffectStatus.PLANNED]: new Set([EffectStatus.DISPATCHED, EffectStatus.CANCELLED, EffectStatus.FAILED, EffectStatus.UNCERTAIN]),
  [EffectStatus.DISPATCHED]: new Set([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED]),
});
export const COMMAND_TRANSITIONS = Object.freeze({
  [CommandStatus.REGISTERED]: new Set([CommandStatus.DISPATCHED, CommandStatus.ACCEPTED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN]),
  [CommandStatus.DISPATCHED]: new Set([CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN]),
});
export const DOWNLOAD_TRANSITIONS = Object.freeze({
  [DownloadStatus.PLANNED]: new Set([DownloadStatus.ARMED, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
  [DownloadStatus.ARMED]: new Set([DownloadStatus.BOUND, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
  [DownloadStatus.BOUND]: new Set([DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED]),
});

export function now(event) {
  return Number(event?.at) || Date.now();
}

function canonicalValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function stableHash(value) {
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

export function rejected(state, event, reason, patch = {}) {
  return { accepted: false, reason, state: { ...state, ...patch, journal: journal(state, event, false, reason) } };
}

export function storedCommandResult(value) {
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

export function enqueueEnvelopePatch(state, envelope) {
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
export function committed(state, event, patch) {
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

export function matchingLease(state, value, { requireResponseEpoch = false } = {}) {
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

export function matchingPersistedRequestIdentity(record, value, { requireResponseEpoch = true } = {}) {
  if (!record) return false;
  const identity = leaseIdentity(value);
  if (!identity.requestId || !identity.leaseId || !identity.ownerServerInstanceId) return false;
  if (requireResponseEpoch && value?.responseEpoch == null) return false;
  return identity.requestId === String(record.requestId || '')
    && identity.leaseId === String(record.leaseId || '')
    && identity.ownerServerInstanceId === String(record.ownerServerInstanceId || '')
    && (!requireResponseEpoch || identity.responseEpoch === Math.max(0, Number(record.responseEpoch) || 0));
}

export function activeRequestChildren(state, lease) {
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

export function boundedCommands(commands, order) {
  const nextOrder = order.slice(-COMMAND_LIMIT);
  const keep = new Set(nextOrder);
  return {
    commands: Object.fromEntries(Object.entries(commands).filter(([id]) => keep.has(id))),
    commandOrder: nextOrder,
  };
}

export function boundedEffects(effects, order) {
  const nextOrder = order.slice(-EFFECT_LIMIT);
  const keep = new Set(nextOrder);
  return {
    effects: Object.fromEntries(Object.entries(effects).filter(([id]) => keep.has(id))),
    effectOrder: nextOrder,
  };
}
