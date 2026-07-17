import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../support/workflowValues.js';

export class WorkflowDaemonRestartService {
  constructor({ dataDir, restartHandler, publish } = {}) {
    this.dataDir = dataDir;
    this.restartHandler = restartHandler;
    this.publish = publish;
  }

  async request(runtime, state, { extensionUpdate = null, warnings = [] } = {}) {
    const cfg = runtime.config.daemonRestart;
    if (!cfg?.enabled) return { requested: false, reason: 'disabled' };
    if (!this.restartHandler) {
      const message = 'Daemon restart is enabled, but no restart handler is configured';
      await this.publish(runtime.id, 'workflow.daemon.restart.failed', { pipelineId: state.pipelineId, message });
      if (cfg.required) throw new Error(message);
      return { requested: false, reason: 'handler-unavailable', message };
    }
    const request = {
      workflowId: runtime.id,
      pipelineId: state.pipelineId,
      mode: cfg.mode,
      command: cfg.command,
      delayMs: cfg.delayMs,
      exitCode: cfg.exitCode,
      projectRoot: runtime.config.projectRoot,
      expectedPackageVersion: await fs.readFile(path.join(runtime.config.projectRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version || '').catch(() => ''),
      extensionUpdated: Boolean(extensionUpdate?.updated),
      warnings,
      requestedAt: nowIso(),
    };
    const intentPath = path.join(this.dataDir, 'workflows', 'restart-request.json');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(intentPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await this.publish(runtime.id, 'workflow.daemon.restart.requested', request);
    await this.restartHandler(request);
    return { requested: true, mode: cfg.mode, delayMs: cfg.delayMs, exitCode: cfg.exitCode, intentPath };
  }
}
