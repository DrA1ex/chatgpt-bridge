export const MAINTENANCE_STATE_STORAGE_KEY = 'chatgptBridgeV5:maintenance';

const TERMINAL = new Set(['succeeded', 'failed', 'uncertain']);
const TRANSITIONS = Object.freeze({
  planned: new Set(['dispatched', 'failed']),
  dispatched: new Set(['succeeded', 'failed', 'uncertain']),
});

function initialState() {
  return { schemaVersion: 1, revision: 0, active: null, history: [], journal: [], updatedAt: 0 };
}

function id(prefix = 'maintenance') {
  try { return crypto.randomUUID(); } catch {}
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMaintenanceOperationStore(storage) {
  let cached = null;
  let queue = Promise.resolve();

  async function read() {
    if (cached) return cached;
    const value = await storage?.get?.(MAINTENANCE_STATE_STORAGE_KEY).catch(() => ({}));
    cached = value?.[MAINTENANCE_STATE_STORAGE_KEY];
    if (!cached || cached.schemaVersion !== 1) cached = initialState();
    return cached;
  }

  async function commit(event, mutate) {
    const previous = queue;
    let resolveQueue;
    queue = new Promise((resolve) => { resolveQueue = resolve; });
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
      cached = {
        ...state,
        ...(outcome.patch || {}),
        revision: state.revision + (outcome.accepted ? 1 : 0),
        journal: [...state.journal, entry].slice(-100),
        updatedAt: Date.now(),
      };
      await storage?.set?.({ [MAINTENANCE_STATE_STORAGE_KEY]: cached });
      return { accepted: outcome.accepted, reason: outcome.reason || '', state: cached };
    } finally {
      resolveQueue();
    }
  }

  function plan(kind, details = {}) {
    const operationId = id('maintenance');
    return commit({ type: 'maintenance.planned', operationId }, (state) => {
      if (state.active && !TERMINAL.has(state.active.status)) return { accepted: false, reason: 'maintenance_conflict' };
      return { accepted: true, patch: { active: {
        operationId,
        kind: String(kind || ''),
        idempotencyKey: String(details.idempotencyKey || operationId),
        preconditions: details.preconditions && typeof details.preconditions === 'object' ? details.preconditions : {},
        status: 'planned',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } } };
    });
  }

  function transition(operationId, status, details = {}) {
    return commit({ type: `maintenance.${status}`, operationId }, (state) => {
      const active = state.active;
      if (!active || active.operationId !== operationId) return { accepted: false, reason: 'maintenance_missing' };
      if (TERMINAL.has(active.status)) return { accepted: false, reason: 'maintenance_terminal' };
      if (!TRANSITIONS[active.status]?.has(status)) return { accepted: false, reason: 'maintenance_transition_invalid' };
      const next = {
        ...active,
        status,
        result: details.result || null,
        error: details.error || null,
        updatedAt: Date.now(),
      };
      return {
        accepted: true,
        patch: {
          active: next,
          history: TERMINAL.has(status) ? [...state.history, next].slice(-50) : state.history,
        },
      };
    });
  }

  async function recover() {
    const state = await read();
    if (state.active?.status !== 'dispatched') return { accepted: false, reason: 'nothing_to_recover', state };
    return transition(state.active.operationId, 'uncertain', {
      error: { code: 'MAINTENANCE_RESTARTED', message: 'Background restarted before maintenance completion was confirmed' },
    });
  }

  return Object.freeze({
    read,
    plan,
    dispatch: (operationId) => transition(operationId, 'dispatched'),
    succeed: (operationId, result) => transition(operationId, 'succeeded', { result }),
    fail: (operationId, error) => transition(operationId, 'failed', { error }),
    uncertain: (operationId, error) => transition(operationId, 'uncertain', { error }),
    recover,
  });
}
