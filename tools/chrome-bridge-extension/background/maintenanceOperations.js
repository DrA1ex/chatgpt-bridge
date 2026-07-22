export const MAINTENANCE_STATE_STORAGE_KEY = 'chatgptBridgeV6:maintenance';
export const LEGACY_MAINTENANCE_STATE_STORAGE_KEY = 'chatgptBridgeV5:maintenance';

const TERMINAL = new Set(['succeeded', 'failed', 'uncertain']);
const TRANSITIONS = Object.freeze({
  planned: new Set(['dispatched', 'failed']),
  dispatched: new Set(['succeeded', 'failed', 'uncertain']),
});

function initialState() {
  return { schemaVersion: 2, revision: 0, active: null, history: [], journal: [], updatedAt: 0 };
}

function operationId(prefix = 'maintenance') {
  try { return crypto.randomUUID(); } catch {}
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function storageError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export function createMaintenanceOperationStore(storage) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw storageError('MAINTENANCE_STORAGE_UNAVAILABLE', 'Maintenance operations require durable extension storage');
  }
  let cached = null;
  let queue = Promise.resolve();

  async function read() {
    if (cached) return cached;
    let value;
    try { value = await storage.get(MAINTENANCE_STATE_STORAGE_KEY); }
    catch (cause) { throw storageError('MAINTENANCE_STORAGE_READ_FAILED', `Unable to read maintenance state: ${cause?.message || cause}`, cause); }
    cached = value?.[MAINTENANCE_STATE_STORAGE_KEY];
    if (!cached || cached.schemaVersion !== 2) {
      let legacyValue;
      try { legacyValue = await storage.get(LEGACY_MAINTENANCE_STATE_STORAGE_KEY); }
      catch (cause) { throw storageError('MAINTENANCE_STORAGE_READ_FAILED', `Unable to read legacy maintenance state: ${cause?.message || cause}`, cause); }
      const legacy = legacyValue?.[LEGACY_MAINTENANCE_STATE_STORAGE_KEY];
      if (legacy?.schemaVersion === 2) {
        cached = structuredClone(legacy);
        await persist(cached);
        try { await storage.remove?.(LEGACY_MAINTENANCE_STATE_STORAGE_KEY); } catch {}
      } else {
        cached = initialState();
      }
    }
    return cached;
  }

  async function persist(next) {
    try { await storage.set({ [MAINTENANCE_STATE_STORAGE_KEY]: next }); }
    catch (cause) { throw storageError('MAINTENANCE_STORAGE_WRITE_FAILED', `Unable to persist maintenance state: ${cause?.message || cause}`, cause); }
  }

  async function commit(event, mutate) {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await read();
      const outcome = mutate(state);
      const entry = {
        revision: state.revision + (outcome.accepted ? 1 : 0),
        type: event.type,
        operationId: String(event.operationId || ''),
        accepted: outcome.accepted,
        reason: outcome.reason || '',
        at: Date.now(),
      };
      const next = {
        ...state,
        ...(outcome.patch || {}),
        revision: state.revision + (outcome.accepted ? 1 : 0),
        journal: [...state.journal, entry].slice(-100),
        updatedAt: Date.now(),
      };
      await persist(next);
      cached = next;
      return { accepted: outcome.accepted, reason: outcome.reason || '', state: next };
    } finally {
      release();
    }
  }

  async function plan(kind, details = {}) {
    const id = operationId('maintenance');
    const outcome = await commit({ type: 'maintenance.planned', operationId: id }, (state) => {
      if (state.active && !TERMINAL.has(state.active.status)) return { accepted: false, reason: 'maintenance_conflict' };
      const at = Date.now();
      return { accepted: true, patch: { active: {
        operationId: id,
        kind: String(kind || ''),
        idempotencyKey: String(details.idempotencyKey || id),
        preconditions: details.preconditions && typeof details.preconditions === 'object' ? structuredClone(details.preconditions) : {},
        expectedResult: details.expectedResult && typeof details.expectedResult === 'object' ? structuredClone(details.expectedResult) : {},
        status: 'planned',
        plannedAt: at,
        dispatchedAt: 0,
        settledAt: 0,
        createdAt: at,
        updatedAt: at,
      } } };
    });
    if (!outcome.accepted) throw storageError('MAINTENANCE_PLAN_REJECTED', `Maintenance plan rejected: ${outcome.reason}`);
    return outcome;
  }

  async function transition(id, status, details = {}) {
    const outcome = await commit({ type: `maintenance.${status}`, operationId: id }, (state) => {
      const active = state.active;
      if (!active || active.operationId !== id) return { accepted: false, reason: 'maintenance_missing' };
      if (TERMINAL.has(active.status)) return { accepted: false, reason: 'maintenance_terminal' };
      if (!TRANSITIONS[active.status]?.has(status)) return { accepted: false, reason: 'maintenance_transition_invalid' };
      const at = Date.now();
      const next = {
        ...active,
        status,
        result: details.result || null,
        error: details.error || null,
        dispatchedAt: status === 'dispatched' ? at : active.dispatchedAt,
        settledAt: TERMINAL.has(status) ? at : active.settledAt,
        updatedAt: at,
      };
      return { accepted: true, patch: { active: next, history: TERMINAL.has(status) ? [...state.history, next].slice(-50) : state.history } };
    });
    if (!outcome.accepted) throw storageError('MAINTENANCE_TRANSITION_REJECTED', `Maintenance ${status} rejected: ${outcome.reason}`);
    return outcome;
  }

  async function recover(verify = null) {
    const state = await read();
    if (state.active?.status !== 'dispatched') return { accepted: false, reason: 'nothing_to_recover', state };
    if (typeof verify === 'function') {
      const result = await verify(structuredClone(state.active));
      if (result?.outcome === 'succeeded') return await transition(state.active.operationId, 'succeeded', { result: result.result || result });
      if (result?.outcome === 'failed') return await transition(state.active.operationId, 'failed', { error: result.error || result });
    }
    return await transition(state.active.operationId, 'uncertain', {
      error: { code: 'MAINTENANCE_RESTARTED', message: 'Background restarted before maintenance completion was confirmed' },
    });
  }

  return Object.freeze({
    read,
    plan,
    dispatch: (id) => transition(id, 'dispatched'),
    succeed: (id, result) => transition(id, 'succeeded', { result }),
    fail: (id, error) => transition(id, 'failed', { error }),
    uncertain: (id, error) => transition(id, 'uncertain', { error }),
    recover,
  });
}
