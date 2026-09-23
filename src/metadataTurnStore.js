function nowIso() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value) { return JSON.stringify(value ?? null); }
function parse(raw, fallback = null) {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
}

// Turn persistence is kept separate from the general metadata store so the
// durable request reservation path remains a focused, independently reviewed
// stateful surface.
export class MetadataTurnStore {
  #jsonMutation = Promise.resolve();

  constructor(store, saveJson) {
    this.store = store;
    this.saveJson = saveJson;
  }

  async createTurn(turn = {}) {
    const store = this.store;
    await store.ready;
    const now = nowIso();
    const record = {
      id: turn.id,
      threadId: turn.threadId,
      idempotencyKey: turn.idempotencyKey || '',
      status: turn.status || 'queued',
      createdAt: turn.createdAt || now,
      updatedAt: turn.updatedAt || now,
      startedAt: turn.startedAt || '',
      completedAt: turn.completedAt || '',
      input: turn.input || {},
      output: turn.output || null,
      error: turn.error || null,
    };
    if (store.mode === 'sqlite') {
      await store.db.run(`INSERT INTO turns (id, thread_id, idempotency_key, status, created_at, updated_at, started_at, completed_at, input_json, output_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.threadId, record.idempotencyKey || null, record.status, record.createdAt, record.updatedAt, record.startedAt || null, record.completedAt || null, json(record.input), json(record.output), json(record.error));
    } else {
      store.state.turns[record.id] = clone(record);
      if (record.idempotencyKey) store.state.turns[`idempotency:${record.idempotencyKey}`] = { ref: record.id };
      store.state.turnEvents[record.id] = store.state.turnEvents[record.id] || [];
      await this.saveJson();
    }
    return clone(record);
  }

  /** Atomically reserve an idempotency key for a durable operation. */
  async reserveTurn(turn = {}) {
    const store = this.store;
    await store.ready;
    const idempotencyKey = String(turn.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new Error('A turn idempotencyKey is required for atomic reservation');
    const record = {
      id: String(turn.id || `turn_${idempotencyKey}`),
      threadId: String(turn.threadId || 'passive-prompt'),
      idempotencyKey,
      status: String(turn.status || 'INFLIGHT'),
      createdAt: turn.createdAt || nowIso(),
      updatedAt: turn.updatedAt || turn.createdAt || nowIso(),
      startedAt: turn.startedAt || '',
      completedAt: turn.completedAt || '',
      input: turn.input || {},
      output: turn.output || null,
      error: turn.error || null,
    };
    if (store.mode === 'sqlite') {
      const result = await store.db.run(`INSERT OR IGNORE INTO turns
        (id, thread_id, idempotency_key, status, created_at, updated_at, started_at, completed_at, input_json, output_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id, record.threadId, record.idempotencyKey, record.status, record.createdAt, record.updatedAt,
      record.startedAt || null, record.completedAt || null, json(record.input), json(record.output), json(record.error));
      const row = await store.db.get('SELECT * FROM turns WHERE idempotency_key = ?', idempotencyKey);
      return {
        created: Number(result?.changes || 0) === 1,
        turn: row ? this.#turnFromRow(row) : null,
      };
    }

    return await this.#withJsonMutation(async () => {
      const existing = await this.getTurnByIdempotencyKey(idempotencyKey);
      if (existing) return { created: false, turn: existing };
      store.state.turns[record.id] = clone(record);
      store.state.turns[`idempotency:${idempotencyKey}`] = { ref: record.id };
      store.state.turnEvents[record.id] = store.state.turnEvents[record.id] || [];
      await this.saveJson();
      return { created: true, turn: clone(record) };
    });
  }

  /** Atomically transition a reserved turn from one or more allowed states. */
  async updateTurnByIdempotencyKey(key, { fromStatuses = [], patch = {} } = {}) {
    const store = this.store;
    await store.ready;
    const idempotencyKey = String(key || '').trim();
    if (!idempotencyKey) return null;
    const allowed = Array.isArray(fromStatuses)
      ? fromStatuses.map((status) => String(status || '')).filter(Boolean)
      : [];
    if (store.mode === 'sqlite') {
      const current = await store.db.get('SELECT * FROM turns WHERE idempotency_key = ?', idempotencyKey);
      if (!current) return null;
      if (allowed.length && !allowed.includes(String(current.status || ''))) return this.#turnFromRow(current);
      const next = {
        status: patch.status !== undefined ? String(patch.status) : current.status,
        updatedAt: patch.updatedAt || nowIso(),
        startedAt: patch.startedAt !== undefined ? patch.startedAt : (current.started_at || ''),
        completedAt: patch.completedAt !== undefined ? patch.completedAt : (current.completed_at || ''),
        input: patch.input !== undefined ? patch.input : parse(current.input_json, {}),
        output: patch.output !== undefined ? patch.output : parse(current.output_json, null),
        error: patch.error !== undefined ? patch.error : parse(current.error_json, null),
      };
      const placeholders = allowed.map(() => '?').join(', ');
      const whereStatus = allowed.length ? ` AND status IN (${placeholders})` : '';
      await store.db.run(`UPDATE turns SET status = ?, updated_at = ?, started_at = ?, completed_at = ?, input_json = ?, output_json = ?, error_json = ?
        WHERE idempotency_key = ?${whereStatus}`,
      next.status, next.updatedAt, next.startedAt || null, next.completedAt || null,
      json(next.input), json(next.output), json(next.error), idempotencyKey, ...allowed);
      const row = await store.db.get('SELECT * FROM turns WHERE idempotency_key = ?', idempotencyKey);
      return row ? this.#turnFromRow(row) : null;
    }

    return await this.#withJsonMutation(async () => {
      const ref = store.state.turns[`idempotency:${idempotencyKey}`]?.ref;
      const current = ref ? store.state.turns[ref] : null;
      if (!current) return null;
      if (allowed.length && !allowed.includes(String(current.status || ''))) return clone(current);
      const next = {
        ...current,
        ...patch,
        status: patch.status !== undefined ? String(patch.status) : current.status,
        updatedAt: patch.updatedAt || nowIso(),
        input: patch.input !== undefined ? patch.input : current.input,
        output: patch.output !== undefined ? patch.output : current.output,
        error: patch.error !== undefined ? patch.error : current.error,
      };
      store.state.turns[ref] = clone(next);
      await this.saveJson();
      return clone(next);
    });
  }

  async getTurn(id) {
    const store = this.store;
    await store.ready;
    if (store.mode === 'sqlite') {
      const row = await store.db.get('SELECT * FROM turns WHERE id = ?', id);
      return row ? this.#turnFromRow(row) : null;
    }
    const record = store.state.turns[id];
    return record && !record.ref ? clone(record) : null;
  }

  async getTurnByIdempotencyKey(key) {
    const store = this.store;
    await store.ready;
    if (!key) return null;
    if (store.mode === 'sqlite') {
      const row = await store.db.get('SELECT * FROM turns WHERE idempotency_key = ?', key);
      return row ? this.#turnFromRow(row) : null;
    }
    const ref = store.state.turns[`idempotency:${key}`]?.ref;
    return ref ? this.getTurn(ref) : null;
  }

  async listTurns({ threadId = '', limit = 100, status = '' } = {}) {
    const store = this.store;
    await store.ready;
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    if (store.mode === 'sqlite') {
      let rows;
      if (threadId && status) rows = await store.db.all('SELECT * FROM turns WHERE thread_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?', threadId, status, safeLimit);
      else if (threadId) rows = await store.db.all('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?', threadId, safeLimit);
      else if (status) rows = await store.db.all('SELECT * FROM turns WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, safeLimit);
      else rows = await store.db.all('SELECT * FROM turns ORDER BY created_at DESC LIMIT ?', safeLimit);
      return rows.map((row) => this.#turnFromRow(row));
    }
    let turns = Object.values(store.state.turns || {}).filter((turn) => turn && !turn.ref);
    if (threadId) turns = turns.filter((turn) => turn.threadId === threadId);
    if (status) turns = turns.filter((turn) => turn.status === status);
    return turns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, safeLimit).map(clone);
  }

  async updateTurn(id, patch = {}) {
    const store = this.store;
    await store.ready;
    const current = await this.getTurn(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt || nowIso(),
      input: patch.input !== undefined ? patch.input : current.input,
      output: patch.output !== undefined ? patch.output : current.output,
      error: patch.error !== undefined ? patch.error : current.error,
    };
    if (store.mode === 'sqlite') {
      await store.db.run('UPDATE turns SET status = ?, updated_at = ?, started_at = ?, completed_at = ?, input_json = ?, output_json = ?, error_json = ? WHERE id = ?', next.status, next.updatedAt, next.startedAt || null, next.completedAt || null, json(next.input), json(next.output), json(next.error), id);
    } else {
      store.state.turns[id] = clone(next);
      await this.saveJson();
    }
    if (next.threadId) await store.updateThread(next.threadId, { updatedAt: next.updatedAt }).catch(() => null);
    return clone(next);
  }

  async #withJsonMutation(operation) {
    const previous = this.#jsonMutation;
    let release;
    this.#jsonMutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #turnFromRow(row) {
    return {
      id: row.id,
      threadId: row.thread_id,
      idempotencyKey: row.idempotency_key || '',
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at || '',
      completedAt: row.completed_at || '',
      input: parse(row.input_json, {}),
      output: parse(row.output_json, null),
      error: parse(row.error_json, null),
    };
  }
}
