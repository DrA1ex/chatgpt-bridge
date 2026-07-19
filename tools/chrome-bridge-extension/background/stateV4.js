export const BACKGROUND_STATE_SCHEMA_VERSION = 4;
export const BACKGROUND_STATE_STORAGE_PREFIX = 'chatgptBridgeV4:tab:';
export const BACKGROUND_EPOCH_STORAGE_KEY = 'chatgptBridgeV4:backgroundEpoch';
export const LEGACY_BACKGROUND_STATE_PREFIXES = Object.freeze(['chatgptBridgeV1:', 'chatgptBridgeV2:', 'chatgptBridgeV3:']);

export const LeaseStatus = Object.freeze({
  IDLE: 'idle',
  CLAIMED: 'claimed',
  RECONCILING: 'reconciling',
  EXECUTING: 'executing',
  RELEASING: 'releasing',
});

export const EffectStatus = Object.freeze({
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
});

export const CommandStatus = Object.freeze({
  REGISTERED: 'registered',
  DISPATCHED: 'dispatched',
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
const EFFECT_LIMIT = 200;
const COMMAND_LIMIT = 200;
const LEASE_TRANSITIONS = Object.freeze({
  [LeaseStatus.CLAIMED]: new Set([LeaseStatus.RECONCILING, LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.RECONCILING]: new Set([LeaseStatus.EXECUTING, LeaseStatus.RELEASING]),
  [LeaseStatus.EXECUTING]: new Set([LeaseStatus.RECONCILING, LeaseStatus.RELEASING]),
  [LeaseStatus.RELEASING]: new Set(),
});
const EFFECT_TRANSITIONS = Object.freeze({
  [EffectStatus.PLANNED]: new Set([EffectStatus.DISPATCHED, EffectStatus.FAILED, EffectStatus.UNCERTAIN]),
  [EffectStatus.DISPATCHED]: new Set([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN]),
});
const COMMAND_TRANSITIONS = Object.freeze({
  [CommandStatus.REGISTERED]: new Set([CommandStatus.DISPATCHED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN]),
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
    metrics: { observationCoalesced: 0, outboxRejected: 0, outboxHighWater: 0 },
    journal: [],
    updatedAt: 0,
  };
}

function rejected(state, event, reason, patch = {}) {
  return { accepted: false, reason, state: { ...state, ...patch, journal: journal(state, event, false, reason) } };
}

function committed(state, event, patch) {
  return {
    accepted: true,
    state: {
      ...state,
      ...patch,
      revision: state.revision + 1,
      journal: journal(state, event, true),
      updatedAt: now(event),
    },
  };
}

function matchingLease(state, event) {
  const lease = state.lease;
  if (!lease) return false;
  return (!event.requestId || event.requestId === lease.requestId)
    && (!event.leaseId || event.leaseId === lease.leaseId)
    && (!event.ownerServerInstanceId || event.ownerServerInstanceId === lease.ownerServerInstanceId);
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
      if (state.lease.ownerServerInstanceId !== String(event.previousOwnerServerInstanceId || '')) return rejected(state, event, 'previous_owner_mismatch');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      if (!leaseId || !ownerServerInstanceId) return rejected(state, event, 'lease_identity_missing');
      return committed(state, event, { lease: {
        ...state.lease,
        leaseId,
        ownerServerInstanceId,
        status: LeaseStatus.RECONCILING,
        contentEpoch: state.contentEpoch,
        updatedAt: now(event),
      } });
    }
    case 'lease.executing':
    case 'lease.reconciling':
    case 'lease.releasing': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const status = event.type.split('.')[1];
      if (!LEASE_TRANSITIONS[state.lease.status]?.has(status)) return rejected(state, event, 'lease_transition_invalid');
      return committed(state, event, { lease: { ...state.lease, status, updatedAt: now(event) } });
    }
    case 'lease.release': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      return committed(state, event, { lease: null });
    }
    case 'command.registered': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const commandId = String(event.commandId || '');
      if (!commandId) return rejected(state, event, 'command_identity_missing');
      if (state.commands?.[commandId]) return rejected(state, event, 'duplicate_command');
      const commands = { ...(state.commands || {}), [commandId]: {
        commandId,
        commandType: String(event.commandType || ''),
        causationId: String(event.causationId || ''),
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        releaseOnResult: Boolean(event.releaseOnResult),
        idempotencyKey: String(event.idempotencyKey || commandId),
        preconditions: event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {},
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'never',
        status: CommandStatus.REGISTERED,
        createdAt: now(event),
        updatedAt: now(event),
        reportedAt: 0,
      } };
      return committed(state, event, boundedCommands(commands, [...(state.commandOrder || []), commandId]));
    }
    case 'command.dispatched':
    case 'command.succeeded':
    case 'command.rejected':
    case 'command.uncertain': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (!matchingLease(state, command)) return rejected(state, event, 'lease_mismatch');
      if ([CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN].includes(command.status)) {
        return rejected(state, event, 'command_terminal');
      }
      const status = event.type.split('.')[1];
      if (!COMMAND_TRANSITIONS[command.status]?.has(status)) return rejected(state, event, 'command_transition_invalid');
      return committed(state, event, { commands: { ...state.commands, [command.commandId]: {
        ...command,
        status,
        resultType: String(event.resultType || ''),
        error: event.error || null,
        updatedAt: now(event),
      } } });
    }
    case 'command.reported': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (![CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN].includes(command.status)) {
        return rejected(state, event, 'command_not_terminal');
      }
      if (command.reportedAt) return rejected(state, event, 'command_already_reported');
      return committed(state, event, { commands: { ...state.commands, [command.commandId]: {
        ...command, reportedAt: now(event),
      } } });
    }
    case 'effect.planned': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const effectId = String(event.effectId || '');
      const idempotencyKey = String(event.idempotencyKey || '');
      if (!effectId || !idempotencyKey) return rejected(state, event, 'effect_identity_missing');
      if (state.effects[effectId]) return rejected(state, event, 'duplicate_effect');
      const effects = { ...state.effects, [effectId]: {
        effectId,
        kind: String(event.kind || ''),
        idempotencyKey,
        preconditions: event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {},
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : null,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'if_unconfirmed',
        status: EffectStatus.PLANNED,
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        createdAt: now(event),
        updatedAt: now(event),
      } };
      return committed(state, event, boundedEffects(effects, [...state.effectOrder, effectId]));
    }
    case 'effect.dispatched':
    case 'effect.succeeded':
    case 'effect.failed':
    case 'effect.uncertain': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (event.idempotencyKey && event.idempotencyKey !== effect.idempotencyKey) return rejected(state, event, 'idempotency_key_mismatch');
      if ([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN].includes(effect.status)) return rejected(state, event, 'effect_terminal');
      const status = event.type.split('.')[1];
      if (!EFFECT_TRANSITIONS[effect.status]?.has(status)) return rejected(state, event, 'effect_transition_invalid');
      return committed(state, event, { effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        status,
        result: event.result || null,
        error: event.error || null,
        updatedAt: now(event),
      } } });
    }
    case 'effect.reported': {
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (![EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN].includes(effect.status)) {
        return rejected(state, event, 'effect_not_terminal');
      }
      if (effect.reportedAt) return rejected(state, event, 'effect_already_reported');
      return committed(state, event, { effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        reportedAt: now(event),
      } } });
    }
    case 'outbox.enqueued': {
      const envelope = event.envelope;
      if (!envelope?.messageId) return rejected(state, event, 'outbox_message_missing');
      if (state.outbox.some((item) => item.messageId === envelope.messageId)) return rejected(state, event, 'duplicate_outbox_message');
      const isObservation = envelope.kind === 'request.observation'
        && (envelope.payload?.type === 'tab.observation' || envelope.payload?.type === 'request.observation');
      const observationKey = isObservation
        ? [
            String(envelope.request?.requestId || 'passive'),
            String(envelope.request?.leaseId || ''),
            String(envelope.source?.contentEpoch || ''),
          ].join(':')
        : '';
      // Revisioned observations are full snapshots, so an unacknowledged older
      // snapshot for the same lease/runtime is replaceable. Effect and command
      // results are never coalesced or evicted.
      const retained = isObservation
        ? state.outbox.filter((item) => !(
            item.kind === 'request.observation'
            && (item.payload?.type === 'tab.observation' || item.payload?.type === 'request.observation')
            && [
              String(item.request?.requestId || 'passive'),
              String(item.request?.leaseId || ''),
              String(item.source?.contentEpoch || ''),
            ].join(':') === observationKey
          ))
        : state.outbox;
      const coalesced = Math.max(0, state.outbox.length - retained.length);
      if (retained.length >= OUTBOX_LIMIT) return rejected(state, event, 'outbox_full', {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const outbox = [...retained, envelope];
      return committed(state, event, {
        outbox,
        metrics: {
          ...state.metrics,
          observationCoalesced: (Number(state.metrics?.observationCoalesced) || 0) + coalesced,
          outboxHighWater: Math.max(Number(state.metrics?.outboxHighWater) || 0, outbox.length),
        },
      });
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
      if (event.requestId && event.requestId !== previous.requestId) return rejected(state, event, 'download_request_mismatch');
      if (event.leaseId && event.leaseId !== previous.leaseId) return rejected(state, event, 'download_lease_mismatch');
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
      const requestId = String(event.requestId || previous?.requestId || state.lease?.requestId || '');
      const leaseId = String(event.leaseId || previous?.leaseId || state.lease?.leaseId || '');
      if (previous?.requestId && requestId !== previous.requestId) return rejected(state, event, 'download_request_mismatch');
      if (previous?.leaseId && leaseId !== previous.leaseId) return rejected(state, event, 'download_lease_mismatch');
      if (status !== DownloadStatus.PLANNED && previous?.requestId && state.lease?.requestId !== previous.requestId) return rejected(state, event, 'download_lease_inactive');
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...(previous || {}),
        captureId,
        status,
        requestId,
        leaseId,
        effectId: String(event.effectId || previous?.effectId || ''),
        artifactRequirementId: String(event.artifactRequirementId || previous?.artifactRequirementId || ''),
        artifactCandidateId: String(event.artifactCandidateId || previous?.artifactCandidateId || ''),
        expectedArtifactIdentity: event.expectedArtifactIdentity || previous?.expectedArtifactIdentity || null,
        downloadId: event.downloadId ?? previous?.downloadId ?? null,
        expectedNames: event.expectedNames || previous?.expectedNames || [],
        bindingSource: String(event.bindingSource || previous?.bindingSource || ''),
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
    const currentStates = Object.entries(all || {})
      .filter(([key]) => key.startsWith(BACKGROUND_STATE_STORAGE_PREFIX))
      .map(([, value]) => value)
      .filter((value) => value && value.schemaVersion === BACKGROUND_STATE_SCHEMA_VERSION);
    const busy = currentStates.some((state) => state.lease
      || (state.outbox || []).length
      || Object.values(state.commands || {}).some((command) => [CommandStatus.REGISTERED, CommandStatus.DISPATCHED, CommandStatus.UNCERTAIN].includes(command?.status))
      || Object.values(state.effects || {}).some((effect) => [EffectStatus.PLANNED, EffectStatus.DISPATCHED, EffectStatus.UNCERTAIN].includes(effect?.status))
      || Object.values(state.downloads || {}).some((download) => [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND].includes(download?.status)));
    if (busy) return { removed: [], reason: 'active_v4_state' };
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
