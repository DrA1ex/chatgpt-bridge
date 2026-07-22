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
