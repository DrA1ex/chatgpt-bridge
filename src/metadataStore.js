import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

function nowIso() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value) { return JSON.stringify(value ?? null); }
function parse(raw, fallback = null) {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
}

export class MetadataStore {
  constructor(rootDir = config.dataDir) {
    this.rootDir = rootDir;
    this.dbPath = path.join(rootDir, 'metadata.sqlite');
    this.jsonPath = path.join(rootDir, 'metadata.json');
    this.mode = 'pending';
    this.db = null;
    this.state = { downloads: {}, threads: {}, turns: {}, items: {}, turnEvents: {} };
    this.ready = this.#init();
  }

  async #init() {
    await fs.mkdir(this.rootDir, { recursive: true });
    try {
      const sqlite = await import('sqlite');
      const sqlite3 = await import('sqlite3');
      const driver = sqlite3.default?.Database || sqlite3.Database;
      this.db = await sqlite.open({ filename: this.dbPath, driver });
      this.mode = 'sqlite';
      await this.#initSqlite();
    } catch {
      this.mode = 'json';
      await this.#initJson();
    }
  }

  async #initSqlite() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        artifact_id TEXT,
        file_id TEXT,
        name TEXT,
        mime TEXT,
        size INTEGER,
        sha256 TEXT,
        path TEXT,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT,
        session_id TEXT,
        status TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_turns_thread_id_created_at ON turns(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_json TEXT,
        artifact_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_turn_id_created_at ON items(turn_id, created_at);
      CREATE TABLE IF NOT EXISTS turn_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_events_turn_id_id ON turn_events(turn_id, id);
    `);

    const downloadColumns = await this.db.all('PRAGMA table_info(downloads)');
    const downloadColumnNames = new Set(downloadColumns.map((column) => column.name));
    if (!downloadColumnNames.has('owner_id')) {
      const error = new Error('Unsupported metadata schema: downloads.owner_id is missing. Start version 5 with a fresh data directory or migrate the database explicitly.');
      error.code = 'METADATA_SCHEMA_UNSUPPORTED';
      throw error;
    }
  }

  async #initJson() {
    try {
      const raw = await fs.readFile(this.jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        downloads: parsed.downloads && typeof parsed.downloads === 'object' ? parsed.downloads : {},
        threads: parsed.threads && typeof parsed.threads === 'object' ? parsed.threads : {},
        turns: parsed.turns && typeof parsed.turns === 'object' ? parsed.turns : {},
        items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
        turnEvents: parsed.turnEvents && typeof parsed.turnEvents === 'object' ? parsed.turnEvents : {},
      };
    } catch {
      await this.#saveJson();
    }
  }

  async #saveJson() {
    await fs.writeFile(this.jsonPath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async createDownload(download) {
    await this.ready;
    const record = {
      id: download.id,
      ownerId: download.ownerId || '',
      artifactId: download.artifactId || '',
      fileId: download.fileId || '',
      name: download.name || '',
      mime: download.mime || 'application/octet-stream',
      size: Number(download.size) || 0,
      sha256: download.sha256 || '',
      path: download.path || '',
      createdAt: download.createdAt || nowIso(),
      metadata: download.metadata || {},
    };
    if (this.mode === 'sqlite') {
      await this.db.run(`INSERT OR REPLACE INTO downloads (id, owner_id, artifact_id, file_id, name, mime, size, sha256, path, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.ownerId, record.artifactId, record.fileId, record.name, record.mime, record.size, record.sha256, record.path, record.createdAt, json(record.metadata));

    } else {
      this.state.downloads[record.id] = clone(record);
      await this.#saveJson();
    }
    return clone(record);
  }

  async getDownload(id) {
    await this.ready;
    if (this.mode === 'sqlite') {
      const row = await this.db.get('SELECT * FROM downloads WHERE id = ?', id);
      return row ? this.#downloadFromRow(row) : null;
    }
    return this.state.downloads[id] ? clone(this.state.downloads[id]) : null;
  }

  async listDownloads({ ownerId = '', limit = 100 } = {}) {
    await this.ready;
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    if (this.mode === 'sqlite') {
      const rows = ownerId
        ? await this.db.all('SELECT * FROM downloads WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?', ownerId, safeLimit)
        : await this.db.all('SELECT * FROM downloads ORDER BY created_at DESC LIMIT ?', safeLimit);
      return rows.map((row) => this.#downloadFromRow(row));
    }
    let downloads = Object.values(this.state.downloads);
    if (ownerId) downloads = downloads.filter((item) => item.ownerId === ownerId);
    return downloads.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, safeLimit).map(clone);
  }


  async createThread(thread = {}) {
    await this.ready;
    const now = nowIso();
    const record = {
      id: thread.id,
      title: thread.title || 'New thread',
      cwd: thread.cwd || '',
      sessionId: thread.sessionId || '',
      status: thread.status || 'active',
      archived: Boolean(thread.archived),
      createdAt: thread.createdAt || now,
      updatedAt: thread.updatedAt || now,
      metadata: thread.metadata || {},
    };
    if (this.mode === 'sqlite') {
      await this.db.run(`INSERT INTO threads (id, title, cwd, session_id, status, archived, created_at, updated_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.title, record.cwd, record.sessionId, record.status, record.archived ? 1 : 0, record.createdAt, record.updatedAt, json(record.metadata));
    } else {
      this.state.threads[record.id] = clone(record);
      await this.#saveJson();
    }
    return clone(record);
  }

  async getThread(id) {
    await this.ready;
    if (this.mode === 'sqlite') {
      const row = await this.db.get('SELECT * FROM threads WHERE id = ?', id);
      return row ? this.#threadFromRow(row) : null;
    }
    return this.state.threads[id] ? clone(this.state.threads[id]) : null;
  }

  async listThreads({ limit = 100, includeArchived = false, cwd = '' } = {}) {
    await this.ready;
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    if (this.mode === 'sqlite') {
      let rows;
      if (cwd) {
        rows = includeArchived
          ? await this.db.all('SELECT * FROM threads WHERE cwd = ? ORDER BY updated_at DESC LIMIT ?', cwd, safeLimit)
          : await this.db.all('SELECT * FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC LIMIT ?', cwd, safeLimit);
      } else {
        rows = includeArchived
          ? await this.db.all('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?', safeLimit)
          : await this.db.all('SELECT * FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?', safeLimit);
      }
      return rows.map((row) => this.#threadFromRow(row));
    }
    let threads = Object.values(this.state.threads || {});
    if (!includeArchived) threads = threads.filter((thread) => !thread.archived);
    if (cwd) threads = threads.filter((thread) => thread.cwd === cwd);
    return threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, safeLimit).map(clone);
  }

  async updateThread(id, patch = {}) {
    await this.ready;
    const current = await this.getThread(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt || nowIso(), metadata: patch.metadata !== undefined ? patch.metadata : current.metadata };
    if (this.mode === 'sqlite') {
      await this.db.run('UPDATE threads SET title = ?, cwd = ?, session_id = ?, status = ?, archived = ?, updated_at = ?, metadata_json = ? WHERE id = ?', next.title, next.cwd || '', next.sessionId || '', next.status || 'active', next.archived ? 1 : 0, next.updatedAt, json(next.metadata || {}), id);
    } else {
      this.state.threads[id] = clone(next);
      await this.#saveJson();
    }
    return clone(next);
  }

  async createTurn(turn = {}) {
    await this.ready;
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
    if (this.mode === 'sqlite') {
      await this.db.run(`INSERT INTO turns (id, thread_id, idempotency_key, status, created_at, updated_at, started_at, completed_at, input_json, output_json, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.threadId, record.idempotencyKey || null, record.status, record.createdAt, record.updatedAt, record.startedAt || null, record.completedAt || null, json(record.input), json(record.output), json(record.error));
    } else {
      this.state.turns[record.id] = clone(record);
      if (record.idempotencyKey) this.state.turns[`idempotency:${record.idempotencyKey}`] = { ref: record.id };
      this.state.turnEvents[record.id] = this.state.turnEvents[record.id] || [];
      await this.#saveJson();
    }
    return clone(record);
  }

  async getTurn(id) {
    await this.ready;
    if (this.mode === 'sqlite') {
      const row = await this.db.get('SELECT * FROM turns WHERE id = ?', id);
      return row ? this.#turnFromRow(row) : null;
    }
    const record = this.state.turns[id];
    return record && !record.ref ? clone(record) : null;
  }

  async getTurnByIdempotencyKey(key) {
    await this.ready;
    if (!key) return null;
    if (this.mode === 'sqlite') {
      const row = await this.db.get('SELECT * FROM turns WHERE idempotency_key = ?', key);
      return row ? this.#turnFromRow(row) : null;
    }
    const ref = this.state.turns[`idempotency:${key}`]?.ref;
    return ref ? this.getTurn(ref) : null;
  }

  async listTurns({ threadId = '', limit = 100, status = '' } = {}) {
    await this.ready;
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    if (this.mode === 'sqlite') {
      let rows;
      if (threadId && status) rows = await this.db.all('SELECT * FROM turns WHERE thread_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?', threadId, status, safeLimit);
      else if (threadId) rows = await this.db.all('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?', threadId, safeLimit);
      else if (status) rows = await this.db.all('SELECT * FROM turns WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, safeLimit);
      else rows = await this.db.all('SELECT * FROM turns ORDER BY created_at DESC LIMIT ?', safeLimit);
      return rows.map((row) => this.#turnFromRow(row));
    }
    let turns = Object.values(this.state.turns || {}).filter((turn) => turn && !turn.ref);
    if (threadId) turns = turns.filter((turn) => turn.threadId === threadId);
    if (status) turns = turns.filter((turn) => turn.status === status);
    return turns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, safeLimit).map(clone);
  }

  async updateTurn(id, patch = {}) {
    await this.ready;
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
    if (this.mode === 'sqlite') {
      await this.db.run('UPDATE turns SET status = ?, updated_at = ?, started_at = ?, completed_at = ?, input_json = ?, output_json = ?, error_json = ? WHERE id = ?', next.status, next.updatedAt, next.startedAt || null, next.completedAt || null, json(next.input), json(next.output), json(next.error), id);
    } else {
      this.state.turns[id] = clone(next);
      await this.#saveJson();
    }
    if (next.threadId) await this.updateThread(next.threadId, { updatedAt: next.updatedAt }).catch(() => null);
    return clone(next);
  }

  async createItem(item = {}) {
    await this.ready;
    const now = nowIso();
    const record = {
      id: item.id,
      threadId: item.threadId,
      turnId: item.turnId,
      type: item.type || 'item',
      status: item.status || 'completed',
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      content: item.content || {},
      artifactId: item.artifactId || '',
    };
    if (this.mode === 'sqlite') {
      await this.db.run(`INSERT INTO items (id, thread_id, turn_id, type, status, created_at, updated_at, content_json, artifact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, record.threadId, record.turnId, record.type, record.status, record.createdAt, record.updatedAt, json(record.content), record.artifactId || null);
    } else {
      this.state.items[record.id] = clone(record);
      await this.#saveJson();
    }
    return clone(record);
  }

  async getItem(id) {
    await this.ready;
    if (this.mode === 'sqlite') {
      const row = await this.db.get('SELECT * FROM items WHERE id = ?', id);
      return row ? this.#itemFromRow(row) : null;
    }
    return this.state.items[id] ? clone(this.state.items[id]) : null;
  }

  async listItems({ turnId = '', threadId = '', limit = 1000 } = {}) {
    await this.ready;
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
    if (this.mode === 'sqlite') {
      let rows;
      if (turnId) rows = await this.db.all('SELECT * FROM items WHERE turn_id = ? ORDER BY created_at ASC LIMIT ?', turnId, safeLimit);
      else if (threadId) rows = await this.db.all('SELECT * FROM items WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?', threadId, safeLimit);
      else rows = await this.db.all('SELECT * FROM items ORDER BY created_at ASC LIMIT ?', safeLimit);
      return rows.map((row) => this.#itemFromRow(row));
    }
    let items = Object.values(this.state.items || {});
    if (turnId) items = items.filter((item) => item.turnId === turnId);
    if (threadId) items = items.filter((item) => item.threadId === threadId);
    return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, safeLimit).map(clone);
  }

  async updateItem(id, patch = {}) {
    await this.ready;
    const current = await this.getItem(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt || nowIso(), content: patch.content !== undefined ? patch.content : current.content };
    if (this.mode === 'sqlite') {
      await this.db.run('UPDATE items SET status = ?, updated_at = ?, content_json = ?, artifact_id = ? WHERE id = ?', next.status, next.updatedAt, json(next.content || {}), next.artifactId || null, id);
    } else {
      this.state.items[id] = clone(next);
      await this.#saveJson();
    }
    return clone(next);
  }

  async addTurnEvent(turnId, event = {}) {
    await this.ready;
    const normalized = {
      time: event.time || nowIso(),
      type: String(event.type || 'event'),
      level: event.level || 'info',
      data: event.data && typeof event.data === 'object' ? event.data : {},
    };
    if (this.mode === 'sqlite') {
      await this.db.run('INSERT INTO turn_events (turn_id, time, type, level, data_json) VALUES (?, ?, ?, ?, ?)', turnId, normalized.time, normalized.type, normalized.level, json(normalized.data));
    } else {
      this.state.turnEvents[turnId] = this.state.turnEvents[turnId] || [];
      this.state.turnEvents[turnId].push(clone(normalized));
      await this.#saveJson();
    }
    return clone(normalized);
  }

  async listTurnEvents(turnId, { limit = 1000 } = {}) {
    await this.ready;
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
    if (this.mode === 'sqlite') {
      const rows = await this.db.all('SELECT * FROM turn_events WHERE turn_id = ? ORDER BY id ASC LIMIT ?', turnId, safeLimit);
      return rows.map((row) => ({ id: row.id, time: row.time, type: row.type, level: row.level, data: parse(row.data_json, {}) }));
    }
    return (this.state.turnEvents[turnId] || []).slice(0, safeLimit).map(clone);
  }

  #threadFromRow(row) {
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd || '',
      sessionId: row.session_id || '',
      status: row.status || 'active',
      archived: Boolean(row.archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: parse(row.metadata_json, {}),
    };
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

  #itemFromRow(row) {
    return {
      id: row.id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: parse(row.content_json, {}),
      artifactId: row.artifact_id || '',
    };
  }

  #downloadFromRow(row) {
    return {
      id: row.id,
      ownerId: row.owner_id || '',
      artifactId: row.artifact_id || '',
      fileId: row.file_id || '',
      name: row.name || '',
      mime: row.mime || 'application/octet-stream',
      size: Number(row.size) || 0,
      sha256: row.sha256 || '',
      path: row.path || '',
      createdAt: row.created_at,
      metadata: parse(row.metadata_json, {}),
    };
  }
}
