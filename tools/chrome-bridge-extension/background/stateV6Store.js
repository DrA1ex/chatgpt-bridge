import {
  BACKGROUND_EPOCH_STORAGE_KEY,
  BACKGROUND_STATE_SCHEMA_VERSION,
  BACKGROUND_STATE_STORAGE_PREFIX,
  CommandStatus,
  DownloadStatus,
  EffectStatus,
  LEGACY_BACKGROUND_STATE_PREFIXES,
  createTabRuntimeState,
} from './stateV6Core.js';
import { reduceTabRuntimeState } from './stateV6Reducer.js';
import {
  BackgroundStateCompaction,
  compactRuntimeState,
  estimateRuntimeStateBytes,
  hasRecoveryCriticalState,
} from './stateV6Compaction.js';


function isStorageCapacityError(error) {
  const text = [error?.name, error?.code, error?.message, error?.cause?.message]
    .filter(Boolean).join(' ').toLowerCase();
  return /quota|quota_bytes|max write|storage.*bytes|exceeded.*storage|too large/.test(text);
}

function storageKey(tabId) {
  return `${BACKGROUND_STATE_STORAGE_PREFIX}${tabId}`;
}

function tabIdFromStorageKey(key = '') {
  if (!String(key).startsWith(BACKGROUND_STATE_STORAGE_PREFIX)) return null;
  const value = Number(String(key).slice(BACKGROUND_STATE_STORAGE_PREFIX.length));
  return Number.isInteger(value) ? value : null;
}

function stateEntriesFromStorage(all = {}) {
  return Object.entries(all || {}).filter(([key, value]) => value && (
    key.startsWith(BACKGROUND_STATE_STORAGE_PREFIX)
    || LEGACY_BACKGROUND_STATE_PREFIXES.some((prefix) => key.startsWith(`${prefix}tab:`))
  ));
}

function storageStateBytes(entries = []) {
  return entries.reduce((total, [, value]) => {
    const bytes = estimateRuntimeStateBytes(value);
    return total + (Number.isFinite(bytes) ? bytes : 0);
  }, 0);
}

export class BackgroundStateStore {
  #storage;
  #states = new Map();
  #queues = new Map();
  #backgroundEpoch;
  #targetBytes;

  constructor(storage, backgroundEpoch, options = {}) {
    this.#storage = storage;
    this.#backgroundEpoch = String(backgroundEpoch || '');
    this.#targetBytes = Math.max(256_000, Number(options.targetBytes) || BackgroundStateCompaction.DEFAULT_TARGET_BYTES);
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
      const recoveryCritical = hasRecoveryCriticalState(outcome.state);
      let persisted = compactRuntimeState(outcome.state, {
        targetBytes: recoveryCritical ? this.#targetBytes : BackgroundStateCompaction.AGGRESSIVE_TARGET_BYTES,
        aggressive: !recoveryCritical,
      });
      let reclaimed = { removed: [], removedBytes: 0, examinedBytes: 0 };
      let firstCause = null;
      let reclaimRetryCause = null;
      try {
        await this.#storage.set({ [storageKey(tabId)]: persisted.state });
      } catch (cause) {
        firstCause = cause;
        if (!isStorageCapacityError(cause)) {
          throw this.#persistenceError(tabId, event, persisted, cause);
        }
        reclaimed = await this.#reclaimIdleStoredStates(tabId).catch(() => reclaimed);
        try {
          await this.#storage.set({ [storageKey(tabId)]: persisted.state });
        } catch (causeAfterReclaim) {
          reclaimRetryCause = causeAfterReclaim;
          if (!isStorageCapacityError(causeAfterReclaim)) {
            throw this.#persistenceError(tabId, event, persisted, causeAfterReclaim, {
              firstCause,
              reclaimed,
            });
          }
          const retry = compactRuntimeState(persisted.state, {
            targetBytes: BackgroundStateCompaction.AGGRESSIVE_TARGET_BYTES,
            aggressive: true,
          });
          try {
            await this.#storage.set({ [storageKey(tabId)]: retry.state });
            persisted = retry;
          } catch (finalCause) {
            throw this.#persistenceError(tabId, event, retry, finalCause, {
              firstCause,
              reclaimRetryCause,
              reclaimed,
              compactedFromBytes: persisted.beforeBytes,
            });
          }
        }
      }
      this.#states.set(tabId, persisted.state);
      return {
        ...outcome,
        state: persisted.state,
        persistence: {
          beforeBytes: persisted.beforeBytes,
          afterBytes: persisted.afterBytes,
          compacted: persisted.changed,
          reclaimedKeys: reclaimed.removed,
          reclaimedBytes: reclaimed.removedBytes,
        },
      };
    });
    this.#queues.set(tabId, next.catch(() => {}));
    return next;
  }

  #persistenceError(tabId, event, persisted, cause, details = {}) {
    const error = new Error(`Background state persistence failed for tab ${tabId}: ${cause?.message || cause}`);
    error.code = 'BACKGROUND_STATE_PERSIST_FAILED';
    error.tabId = tabId;
    error.eventType = String(event?.type || '');
    error.stateBytes = Number.isFinite(persisted?.afterBytes) ? persisted.afterBytes : 0;
    error.compactedFromBytes = Number.isFinite(details.compactedFromBytes)
      ? details.compactedFromBytes
      : Number.isFinite(persisted?.beforeBytes) ? persisted.beforeBytes : 0;
    error.reclaimedKeys = Array.isArray(details.reclaimed?.removed) ? details.reclaimed.removed : [];
    error.reclaimedBytes = Math.max(0, Number(details.reclaimed?.removedBytes) || 0);
    error.storageExaminedBytes = Math.max(0, Number(details.reclaimed?.examinedBytes) || 0);
    error.firstCause = details.firstCause || null;
    error.reclaimRetryCause = details.reclaimRetryCause || null;
    error.cause = cause;
    return error;
  }

  async #reclaimIdleStoredStates(currentTabId = null) {
    if (typeof this.#storage?.get !== 'function' || typeof this.#storage?.remove !== 'function') {
      return { removed: [], removedBytes: 0, examinedBytes: 0, reason: 'storage_unavailable' };
    }
    const all = await this.#storage.get(null);
    const entries = stateEntriesFromStorage(all);
    const removable = entries
      .filter(([key, state]) => {
        const tabId = tabIdFromStorageKey(key);
        if (tabId != null && tabId === currentTabId) return false;
        return !hasRecoveryCriticalState(state);
      })
      .sort((left, right) => (Number(left[1]?.updatedAt) || 0) - (Number(right[1]?.updatedAt) || 0));
    const keys = removable.map(([key]) => key);
    if (keys.length) await this.#storage.remove(keys);
    return {
      removed: keys,
      removedBytes: storageStateBytes(removable),
      examinedBytes: storageStateBytes(entries),
      reason: keys.length ? 'idle_states_removed' : 'none',
    };
  }


  async cleanupLegacyStateIfIdle() {
    if (typeof this.#storage?.get !== 'function' || typeof this.#storage?.remove !== 'function') {
      return { removed: [], reason: 'storage_unavailable' };
    }
    const all = await this.#storage.get(null);
    const entries = stateEntriesFromStorage(all);
    const removable = entries.filter(([, state]) => !hasRecoveryCriticalState(state));
    const keys = removable.map(([key]) => key);
    if (keys.length) await this.#storage.remove(keys);
    return {
      removed: keys,
      removedBytes: storageStateBytes(removable),
      retainedCritical: entries.length - removable.length,
      reason: keys.length ? 'idle_states_removed' : 'none',
    };
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
