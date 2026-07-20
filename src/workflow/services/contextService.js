import { createHash } from 'node:crypto';
import { bindVerifiedSource } from '../context/bindVerifiedSource.js';
import { syncProjectContext } from '../context/syncProjectContext.js';
import { acknowledgeRestartIntent } from '../recovery/acknowledgeRestartIntent.js';
import { recoverInterruptedPipeline } from '../recovery/recoverInterruptedPipeline.js';
import { workflowSessionId, workflowSourceClientId } from '../support/workflowBinding.js';
import { executeLocalEffect } from '../state/localEffects.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';
import {
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  WorkflowRunKind,
} from '../state/workflowState.js';

export class WorkflowContextService {
  constructor({ dataDir, fileStore, bridge, projectService, applier, getRuntime, persistRuntime, transition, publish, syncRefreshTimer } = {}) {
    this.dataDir = dataDir;
    this.fileStore = fileStore;
    this.bridge = bridge;
    this.projectService = projectService;
    this.applier = applier;
    this.getRuntime = getRuntime;
    this.persistRuntime = persistRuntime;
    this.transition = transition;
    this.publish = publish;
    this.syncRefreshTimer = syncRefreshTimer;
  }


  async #withOwnedContextRun(runtime, reason, task, binding = {}) {
    const config = runtime.config.projectContext;
    const sessionId = workflowSessionId(runtime, binding.sessionId || '', { allowLast: false });
    const sourceClientId = workflowSourceClientId(runtime, binding.sourceClientId || '', { allowLast: false });
    if (!config?.enabled || !sessionId || !sourceClientId) return await task();

    let ownedRun = false;
    let runId = String(runtime.workflowState?.run?.id || '');
    if (runtime.workflowState.lifecycle === WorkflowLifecycle.READY) {
      ownedRun = true;
      runId = createWorkflowId('run');
      await this.transition(runtime, WorkflowEventType.RUN_STARTED, {
        runId,
        kind: WorkflowRunKind.MANUAL,
        phase: WorkflowPhase.CONTEXT_SYNC,
        source: { clientId: sourceClientId, sessionId },
        references: { trigger: 'context-sync', reason },
      });
    }

    try {
      const result = await task();
      if (ownedRun && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING
        && runtime.workflowState.run?.id === runId) {
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId,
          code: result?.synced === false ? `context_${String(result.reason || 'skipped').replace(/[^a-z0-9]+/gi, '_')}` : 'context_synced',
          message: result?.synced === false ? `Project context synchronization skipped: ${result.reason || 'no change'}` : 'Project context synchronized',
          evidence: {
            reason,
            sessionId,
            sourceClientId,
            synced: result?.synced !== false,
            fingerprintSha256: String(result?.fingerprintSha256 || ''),
          },
        });
      }
      return result;
    } catch (error) {
      if (ownedRun && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING
        && runtime.workflowState.run?.id === runId) {
        await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
          runId,
          code: String(error?.code || 'context_sync_failed'),
          message: error?.message || String(error),
          evidence: { reason, sessionId, sourceClientId },
        }).catch(() => {});
      }
      throw error;
    }
  }

  async packProject(runtime, options = {}, purpose = 'context-sync') {
    if (!this.projectService) return null;
    const runId = String(runtime.workflowState?.run?.id || '');
    if (!runId) throw Object.assign(new Error('Project snapshot requires an active workflow run'), { code: 'WORKFLOW_RUN_REQUIRED' });
    const normalized = {
      force: Boolean(options.force),
      useGitignore: options.useGitignore !== false,
      snapshotPolicy: String(options.snapshotPolicy || 'reuse'),
    };
    const preconditionsHash = createHash('sha256').update(JSON.stringify({
      projectRoot: runtime.config.projectRoot,
      purpose,
      normalized,
      bindingEpoch: runtime.workflowState.binding?.epoch || 0,
      projectFingerprintSha256: runtime.projectFingerprintSha256 || '',
    })).digest('hex');
    const effectId = `${runId}:project-snapshot:${purpose}:${preconditionsHash.slice(0, 16)}`;
    return await executeLocalEffect({
      transition: this.transition,
      runtime,
      effect: {
        id: effectId,
        kind: WorkflowLocalEffectKind.PROJECT_SNAPSHOT,
        safe: true,
        idempotencyKey: `${runId}:project-snapshot:${purpose}:${preconditionsHash}`,
        preconditionsHash,
        references: { projectRoot: runtime.config.projectRoot, purpose, options: normalized },
      },
      execute: async () => await this.projectService.pack(runtime.config.projectRoot, normalized),
    });
  }

  async recordRemoteSnapshot(runtime, response = {}) {
    const responseSessionId = String(response.session?.id || response.sessionId || '');
    const responseSourceClientId = String(response.sourceClientId || '');
    return await this.#withOwnedContextRun(runtime, 'remote-snapshot', async () => {
      if (!this.projectService) return { recorded: false, reason: 'project-service-unavailable' };
      const sessionId = workflowSessionId(runtime, response.session?.id || response.sessionId, { allowLast: false });
      if (!sessionId) return { recorded: false, reason: 'session-unbound' };
      const packed = await this.packProject(runtime, { force: false, useGitignore: true, snapshotPolicy: 'reuse' }, 'remote-snapshot');
      runtime.contextSyncedSessionId = sessionId;
      runtime.contextSyncFingerprint = packed.snapshotId;
      runtime.projectFingerprintSha256 = packed.snapshotId;
      await this.persistRuntime(runtime);
      return { recorded: true, synced: true, sessionId, fingerprintSha256: packed.snapshotId };
    }, { sessionId: responseSessionId, sourceClientId: responseSourceClientId });
  }

  async bindVerified(runtime, response, artifact = {}) {
    return bindVerifiedSource({
      runtime,
      response,
      artifact,
      persistRuntime: this.persistRuntime,
      transition: this.transition,
      publish: this.publish,
      syncRefreshTimer: this.syncRefreshTimer,
      syncProjectContext: (target, options) => this.sync(target, options),
    });
  }

  async sync(runtime, { reason = 'manual', sessionId = '', sourceClientId = '' } = {}) {
    return await this.#withOwnedContextRun(runtime, reason, async () => await syncProjectContext({
      runtime,
      reason,
      sessionId,
      sourceClientId,
      dataDir: this.dataDir,
      fileStore: this.fileStore,
      bridge: this.bridge,
      projectService: this.projectService,
      persistRuntime: this.persistRuntime,
      transition: this.transition,
      publish: this.publish,
      packProject: (target, options) => this.packProject(target, options, `context-${reason}`),
    }), { sessionId, sourceClientId });
  }

  async acknowledgeRestart() {
    return acknowledgeRestartIntent({ dataDir: this.dataDir, getRuntime: this.getRuntime, publish: this.publish });
  }

  async recoverInterrupted(runtime) {
    return recoverInterruptedPipeline({
      runtime,
      dataDir: this.dataDir,
      applier: this.applier,
      persistRuntime: this.persistRuntime,
      transition: this.transition,
      publish: this.publish,
      syncRefreshTimer: this.syncRefreshTimer,
    });
  }
}
