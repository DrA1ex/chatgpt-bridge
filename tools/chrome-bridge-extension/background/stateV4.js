export const BACKGROUND_STATE_SCHEMA_VERSION = 4;
export const BACKGROUND_STATE_STORAGE_PREFIX = 'chatgptBridgeV4:tab:';
export const BACKGROUND_EPOCH_STORAGE_KEY = 'chatgptBridgeV4:backgroundEpoch';

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
    sequence: 0,
    acknowledgedSequence: 0,
    lease: null,
    effects: {},
    effectOrder: [],
    downloads: {},
    outbox: [],
    journal: [],
    updatedAt: 0,
  };
}

function rejected(state, event, reason) {
  return { accepted: false, reason, state: { ...state, journal: journal(state, event, false, reason) } };
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
      return committed(state, event, { outbox: [...state.outbox, envelope].slice(-OUTBOX_LIMIT) });
    }
    case 'outbox.acknowledged': {
      const messageId = String(event.messageId || '');
      const found = state.outbox.some((item) => item.messageId === messageId);
      if (!found) return rejected(state, event, 'outbox_message_missing');
      return committed(state, event, {
        acknowledgedSequence: Math.max(state.acknowledgedSequence, Number(event.sequence) || 0),
        outbox: state.outbox.filter((item) => item.messageId !== messageId),
      });
    }
    case 'sequence.advanced': {
      const sequence = Number(event.sequence);
      if (!Number.isInteger(sequence) || sequence <= state.sequence) return rejected(state, event, 'stale_sequence');
      return committed(state, event, { sequence });
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
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...(previous || {}),
        captureId,
        status,
        requestId: String(event.requestId || previous?.requestId || state.lease?.requestId || ''),
        leaseId: String(event.leaseId || previous?.leaseId || state.lease?.leaseId || ''),
        downloadId: event.downloadId ?? previous?.downloadId ?? null,
        expectedNames: event.expectedNames || previous?.expectedNames || [],
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
    let state = null;
    try { state = (await this.#storage?.get?.(storageKey(tabId)))?.[storageKey(tabId)] || null; } catch {}
    if (!state || state.schemaVersion !== BACKGROUND_STATE_SCHEMA_VERSION) state = createTabRuntimeState(tabId, this.#backgroundEpoch);
    if (state.backgroundEpoch !== this.#backgroundEpoch) state = { ...state, backgroundEpoch: this.#backgroundEpoch };
    this.#states.set(tabId, state);
    return state;
  }

  transition(tabId, event) {
    const previous = this.#queues.get(tabId) || Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.read(tabId);
      const outcome = reduceTabRuntimeState(current, { ...event, tabId, backgroundEpoch: this.#backgroundEpoch });
      this.#states.set(tabId, outcome.state);
      try { await this.#storage?.set?.({ [storageKey(tabId)]: outcome.state }); } catch {}
      return outcome;
    });
    this.#queues.set(tabId, next.catch(() => {}));
    return next;
  }

  async remove(tabId) {
    this.#states.delete(tabId);
    this.#queues.delete(tabId);
    try { await this.#storage?.remove?.(storageKey(tabId)); } catch {}
  }
}

export function createRuntimeEpoch(prefix = 'epoch') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
