import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const WORKFLOW_STORE_SCHEMA_VERSION = 3;
const MAX_EVENTS = 2000;
const MAX_TRANSITIONS = 1000;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export class WorkflowStore {
  constructor(rootDir = config.dataDir) {
    this.dir = path.join(rootDir, 'workflows');
    this.file = path.join(this.dir, 'state.json');
    this.state = { schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION, workflows: {}, decisions: {}, artifacts: {}, events: [], transitions: [] };
    this.writeChain = Promise.resolve();
    this.saveSequence = 0;
    this.ready = this.#load();
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const hasLegacySnapshot = Number(parsed.schemaVersion || 0) !== WORKFLOW_STORE_SCHEMA_VERSION
        || Object.values(parsed.workflows || {}).some((workflow) => Number(workflow?.workflowStateSchemaVersion || workflow?.execution?.schemaVersion || 0) !== WORKFLOW_STORE_SCHEMA_VERSION);
      if (hasLegacySnapshot) {
        await this.#archive('v2');
        this.state = { schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION, workflows: {}, decisions: {}, artifacts: {}, events: [], transitions: [] };
        await this.#save();
        return;
      }
      this.state = {
        schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
        workflows: parsed.workflows && typeof parsed.workflows === 'object' ? parsed.workflows : {},
        decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
        artifacts: parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {},
        events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
        transitions: Array.isArray(parsed.transitions) ? parsed.transitions.slice(-MAX_TRANSITIONS) : [],
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') await this.#archive('corrupt');
      await this.#save();
    }
  }

  async #archive(label) {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    let archive = path.join(this.dir, `state.${label}-${stamp}.json`);
    for (let suffix = 1; ; suffix += 1) {
      try { await fs.rename(this.file, archive); return archive; }
      catch (error) {
        if (error?.code === 'ENOENT') return '';
        if (error?.code !== 'EEXIST') throw error;
        archive = path.join(this.dir, `state.${label}-${stamp}-${suffix}.json`);
      }
    }
  }

  async #save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const sequence = ++this.saveSequence;
    const operation = this.writeChain.catch(() => {}).then(async () => {
      const temp = `${this.file}.tmp-${process.pid}-${sequence}`;
      const handle = await fs.open(temp, 'w');
      try { await handle.writeFile(snapshot, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, this.file);
      const directory = await fs.open(this.dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.writeChain = operation;
    return await operation;
  }

  async commit({ workflows = {}, decisions = {}, artifacts = {} } = {}) {
    await this.ready;
    for (const [id, value] of Object.entries(workflows)) this.state.workflows[id] = clone(value);
    for (const [id, value] of Object.entries(decisions)) this.state.decisions[id] = clone(value);
    for (const [key, value] of Object.entries(artifacts)) this.state.artifacts[key] = clone(value);
    await this.#save();
    return {
      workflows: clone(workflows),
      decisions: clone(decisions),
      artifacts: clone(artifacts),
    };
  }

  async commitWorkflow(id, value, { decisions = {}, artifacts = {} } = {}) { return await this.commit({ workflows: { [id]: value }, decisions, artifacts }); }
  async commitTransition(id, workflow, transition, { decisions = {}, artifacts = {} } = {}) {
    await this.ready;
    this.state.workflows[id] = clone(workflow);
    for (const [key, value] of Object.entries(decisions)) this.state.decisions[key] = clone(value);
    for (const [key, value] of Object.entries(artifacts)) this.state.artifacts[key] = clone(value);
    this.state.transitions.push(clone(transition));
    this.state.transitions = this.state.transitions.slice(-MAX_TRANSITIONS);
    await this.#save();
    return clone(transition);
  }
  async setWorkflow(id, value) { await this.ready; this.state.workflows[id] = clone(value); await this.#save(); return clone(value); }
  async getWorkflow(id) { await this.ready; return this.state.workflows[id] ? clone(this.state.workflows[id]) : null; }
  async listWorkflows() { await this.ready; return Object.values(this.state.workflows).map(clone); }
  async removeWorkflow(id) { await this.ready; delete this.state.workflows[id]; await this.#save(); }
  async setDecision(id, value) { await this.ready; this.state.decisions[id] = clone(value); await this.#save(); return clone(value); }
  async getDecision(id) { await this.ready; return this.state.decisions[id] ? clone(this.state.decisions[id]) : null; }
  async listDecisions({ status = '' } = {}) { await this.ready; return Object.values(this.state.decisions).filter((item) => !status || item.status === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone); }
  async setArtifact(key, value) { await this.ready; this.state.artifacts[key] = clone(value); await this.#save(); return clone(value); }
  async getArtifact(key) { await this.ready; return this.state.artifacts[key] ? clone(this.state.artifacts[key]) : null; }
  async appendEvent(event) { await this.ready; this.state.events.push(clone(event)); this.state.events = this.state.events.slice(-MAX_EVENTS); await this.#save(); return clone(event); }
  async listEvents({ workflowId = '', limit = 200 } = {}) { await this.ready; return this.state.events.filter((event) => !workflowId || event.workflowId === workflowId).slice(-Math.max(1, Number(limit) || 200)).map(clone); }
  async listTransitions({ workflowId = '', limit = 100 } = {}) { await this.ready; return this.state.transitions.filter((item) => !workflowId || item.workflowId === workflowId).slice(-Math.max(1, Number(limit) || 100)).map(clone); }
}
