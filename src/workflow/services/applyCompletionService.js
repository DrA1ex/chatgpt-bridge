import { WorkflowStateEventType } from '../state/workflowState.js';
import { nowIso } from '../support/workflowValues.js';

export class WorkflowApplyCompletionService {
  constructor({ store, transition, contextService, daemonRestartService, syncRefresh, publish } = {}) {
    this.store = store;
    this.transition = transition;
    this.contextService = contextService;
    this.daemonRestartService = daemonRestartService;
    this.syncRefresh = syncRefresh;
    this.publish = publish;
  }

  async complete(runtime, state, { commit = { committed: false, reason: 'disabled' }, warnings = [] } = {}) {
    const extensionUpdate = state.extensionUpdate || { updated: false };
    runtime.pendingCommit = null;
    await this.store.setArtifact(state.artifactKey, {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'applied',
      appliedAt: nowIso(),
      applied: state.applied,
      commit,
      extensionUpdate,
      warnings,
    });
    runtime.lastError = warnings.join('; ');
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
      pipelineId: state.pipelineId,
      code: warnings.length ? 'completed_with_warnings' : 'completed',
      message: warnings.join('; '),
      evidence: { commit: commit.committed ? commit.sha : '', extensionUpdated: Boolean(extensionUpdate.updated), warnings },
    }, warnings.length ? 'workflow.completed_with_warnings' : 'workflow.completed', {
      pipelineId: state.pipelineId,
      commit: commit.committed ? commit.sha : '',
      extensionUpdated: Boolean(extensionUpdate.updated),
      warnings,
    });
    await this.contextService.recordRemoteSnapshot(runtime, state.response || {}).catch((error) => this.publish(runtime.id, 'workflow.context.snapshot.record.failed', { message: error.message || String(error) }));
    this.syncRefresh(runtime);
    const daemonRestart = await this.daemonRestartService.request(runtime, state, { extensionUpdate, warnings });
    if (daemonRestart.requested) {
      await this.store.setArtifact(state.artifactKey, {
        ...(await this.store.getArtifact(state.artifactKey)),
        daemonRestart: {
          requested: true,
          mode: daemonRestart.mode,
          delayMs: daemonRestart.delayMs,
          exitCode: daemonRestart.exitCode,
          requestedAt: nowIso(),
        },
      });
    }
    return {
      status: warnings.length ? 'applied-with-warnings' : 'applied',
      applied: state.applied,
      commit,
      extensionUpdate,
      daemonRestart,
      warnings,
    };
  }
}
