import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { syncHandleBestEffort } from '../safeDirectorySync.js';

const SCHEMA_VERSION = 1;
const PRESETS = new Set(['apply-changes', 'fix-until-pass', 'guided-task']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalize(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const preset = String(source.preset || '').trim();
  if (preset && !PRESETS.has(preset)) {
    throw Object.assign(new Error(`Unknown workflow preset: ${preset}`), {
      code: 'WORKFLOW_PRESET_INVALID',
    });
  }
  return {
    preset,
    binding: clone(source.binding || {}),
    intelligence: clone(source.intelligence || {}),
    remediation: clone(source.remediation || {}),
    attempts: clone(source.attempts || {}),
    sessionExhaustion: String(source.sessionExhaustion || ''),
    session: clone(source.session || {}),
    notifications: clone(source.notifications || {}),
    noProgressLimit: Math.max(0, Number(source.noProgressLimit) || 0),
    series: clone(source.series || null),
  };
}

export class WorkflowOrchestrationStore {
  constructor(rootDir = config.dataDir, { filePath = '' } = {}) {
    this.file = path.resolve(
      filePath || path.join(rootDir, 'workflows', 'orchestration-v1.json'),
    );
    this.state = { schemaVersion: SCHEMA_VERSION, workflows: {} };
    this.chain = Promise.resolve();
    this.sequence = 0;
    this.ready = this.#load();
  }

  async #load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error('schema version mismatch');
      for (const [id, value] of Object.entries(parsed.workflows || {})) {
        this.state.workflows[id] = normalize(value);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw Object.assign(new Error(`Workflow orchestration state is unreadable: ${this.file}`, {
          cause: error,
        }), { code: 'WORKFLOW_ORCHESTRATION_STORE_CORRUPT' });
      }
      await this.#write(this.state);
    }
  }

  async #write(state) {
    const temporary = `${this.file}.tmp-${process.pid}-${++this.sequence}`;
    const handle = await fs.open(temporary, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await syncHandleBestEffort(handle);
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.file);
  }

  async get(workflowId) {
    await this.ready;
    await this.chain;
    return clone(this.state.workflows[String(workflowId || '')] || null);
  }

  async set(workflowId, value) {
    const id = String(workflowId || '').trim();
    if (!id) throw new Error('Workflow ID is required');
    const normalized = normalize(value);
    const pending = this.chain.catch(() => {}).then(async () => {
      const next = clone(this.state);
      next.workflows[id] = normalized;
      await this.#write(next);
      this.state = next;
      return clone(normalized);
    });
    this.chain = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  async close() {
    await this.ready;
    await this.chain;
  }
}
