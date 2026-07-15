import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export class WorkflowStore {
  constructor(rootDir = config.dataDir) {
    this.dir = path.join(rootDir, 'workflows');
    this.file = path.join(this.dir, 'state.json');
    this.state = { workflows: {}, approvals: {}, artifacts: {}, events: [] };
    this.writeChain = Promise.resolve();
    this.saveSequence = 0;
    this.ready = this.#load();
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = {
        workflows: parsed.workflows && typeof parsed.workflows === 'object' ? parsed.workflows : {},
        approvals: parsed.approvals && typeof parsed.approvals === 'object' ? parsed.approvals : {},
        artifacts: parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {},
        events: Array.isArray(parsed.events) ? parsed.events.slice(-2000) : [],
      };
    } catch {
      await this.#save();
    }
  }

  async #save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const sequence = ++this.saveSequence;
    const operation = this.writeChain.catch(() => {}).then(async () => {
      const temp = `${this.file}.tmp-${process.pid}-${sequence}`;
      await fs.writeFile(temp, snapshot, 'utf8');
      await fs.rename(temp, this.file);
    });
    this.writeChain = operation;
    return await operation;
  }

  async commit({ workflows = {}, approvals = {}, artifacts = {} } = {}) {
    await this.ready;
    for (const [id, value] of Object.entries(workflows)) this.state.workflows[id] = clone(value);
    for (const [id, value] of Object.entries(approvals)) this.state.approvals[id] = clone(value);
    for (const [key, value] of Object.entries(artifacts)) this.state.artifacts[key] = clone(value);
    await this.#save();
    return {
      workflows: clone(workflows),
      approvals: clone(approvals),
      artifacts: clone(artifacts),
    };
  }

  async commitWorkflow(id, value, { approvals = {}, artifacts = {} } = {}) { return await this.commit({ workflows: { [id]: value }, approvals, artifacts }); }
  async setWorkflow(id, value) { await this.ready; this.state.workflows[id] = clone(value); await this.#save(); return clone(value); }
  async getWorkflow(id) { await this.ready; return this.state.workflows[id] ? clone(this.state.workflows[id]) : null; }
  async listWorkflows() { await this.ready; return Object.values(this.state.workflows).map(clone); }
  async removeWorkflow(id) { await this.ready; delete this.state.workflows[id]; await this.#save(); }
  async setApproval(id, value) { await this.ready; this.state.approvals[id] = clone(value); await this.#save(); return clone(value); }
  async getApproval(id) { await this.ready; return this.state.approvals[id] ? clone(this.state.approvals[id]) : null; }
  async listApprovals({ status = '' } = {}) { await this.ready; return Object.values(this.state.approvals).filter((item) => !status || item.status === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone); }
  async setArtifact(key, value) { await this.ready; this.state.artifacts[key] = clone(value); await this.#save(); return clone(value); }
  async getArtifact(key) { await this.ready; return this.state.artifacts[key] ? clone(this.state.artifacts[key]) : null; }
  async appendEvent(event) { await this.ready; this.state.events.push(clone(event)); this.state.events = this.state.events.slice(-2000); await this.#save(); return clone(event); }
  async listEvents({ workflowId = '', limit = 200 } = {}) { await this.ready; return this.state.events.filter((event) => !workflowId || event.workflowId === workflowId).slice(-Math.max(1, Number(limit) || 200)).map(clone); }
}
