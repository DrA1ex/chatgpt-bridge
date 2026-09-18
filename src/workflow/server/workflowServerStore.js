import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import {
  normalizeWorkflowServerState,
  patchWorkflowServerState,
} from './workflowServerState.js';
import { syncDirectoryBestEffort, syncHandleBestEffort } from '../safeDirectorySync.js';

export const WORKFLOW_SERVER_STORE_SCHEMA_VERSION = 1;

function clone(value) {
  return structuredClone(value);
}

function initialStoreState() {
  return {
    schemaVersion: WORKFLOW_SERVER_STORE_SCHEMA_VERSION,
    workflows: {},
  };
}

function workflowKey(value) {
  const key = String(value || '').trim();
  if (!key) throw Object.assign(new Error('Workflow ID is required'), { code: 'WORKFLOW_ID_REQUIRED' });
  return key;
}

function storeError(code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export class WorkflowServerStore {
  constructor(rootDir = config.dataDir, { filePath = '' } = {}) {
    this.dir = path.join(path.resolve(rootDir), 'workflows');
    this.file = path.resolve(filePath || path.join(this.dir, 'server-state-v1.json'));
    this.dir = path.dirname(this.file);
    this.state = initialStoreState();
    this.writeChain = Promise.resolve();
    this.sequence = 0;
    this.ready = this.#load();
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true });
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this.#writeSnapshot(this.state);
        return;
      }
      throw storeError(
        'WORKFLOW_SERVER_STORE_CORRUPT',
        `Workflow server state is unreadable: ${this.file}`,
        error,
      );
    }

    if (Number(parsed?.schemaVersion) !== WORKFLOW_SERVER_STORE_SCHEMA_VERSION) {
      throw storeError(
        'WORKFLOW_SERVER_STORE_INCOMPATIBLE',
        `Workflow server store must use schema v${WORKFLOW_SERVER_STORE_SCHEMA_VERSION}`,
      );
    }
    const workflows = parsed.workflows && typeof parsed.workflows === 'object' && !Array.isArray(parsed.workflows)
      ? parsed.workflows
      : {};
    this.state = initialStoreState();
    for (const [id, value] of Object.entries(workflows)) {
      this.state.workflows[workflowKey(id)] = normalizeWorkflowServerState(value);
    }
  }

  async #writeSnapshot(state) {
    const sequence = ++this.sequence;
    const temporary = `${this.file}.tmp-${process.pid}-${sequence}`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const handle = await fs.open(temporary, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await syncHandleBestEffort(handle);
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.file);
      await syncDirectoryBestEffort(fs, this.dir);
    } catch (error) {
      await fs.unlink(temporary).catch(() => null);
      throw error;
    }
  }

  async #readBarrier() {
    await this.ready;
    await this.writeChain;
  }

  async #mutate(operation) {
    await this.ready;
    const pending = this.writeChain
      .catch(() => {})
      .then(async () => {
        const draft = clone(this.state);
        const result = await operation(draft);
        await this.#writeSnapshot(draft);
        this.state = draft;
        return clone(result);
      });
    this.writeChain = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  async get(workflowId) {
    await this.#readBarrier();
    const value = this.state.workflows[workflowKey(workflowId)];
    return value ? clone(value) : null;
  }

  async list() {
    await this.#readBarrier();
    return Object.entries(this.state.workflows).map(([workflowId, state]) => ({
      workflowId,
      state: clone(state),
    }));
  }

  async set(workflowId, value) {
    const id = workflowKey(workflowId);
    const normalized = normalizeWorkflowServerState(value);
    return await this.#mutate((draft) => {
      draft.workflows[id] = normalized;
      return normalized;
    });
  }

  async update(workflowId, patchOrUpdater) {
    const id = workflowKey(workflowId);
    return await this.#mutate(async (draft) => {
      const current = draft.workflows[id] || normalizeWorkflowServerState();
      const candidate = typeof patchOrUpdater === 'function'
        ? await patchOrUpdater(clone(current))
        : patchWorkflowServerState(current, patchOrUpdater);
      const normalized = normalizeWorkflowServerState(candidate);
      draft.workflows[id] = normalized;
      return normalized;
    });
  }

  async remove(workflowId) {
    const id = workflowKey(workflowId);
    return await this.#mutate((draft) => {
      const existed = Boolean(draft.workflows[id]);
      delete draft.workflows[id];
      return existed;
    });
  }

  async close() {
    await this.#readBarrier();
  }
}
