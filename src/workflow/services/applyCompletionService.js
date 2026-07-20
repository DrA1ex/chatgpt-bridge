import { WorkflowEventType, WorkflowPhase, WorkflowRunKind } from '../state/workflowState.js';
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
    const completionData = {
      runId: runtime.workflowState.run.id,
      code: warnings.length ? 'completed_with_warnings' : 'completed',
      message: warnings.join('; '),
      evidence: { commit: commit.committed ? commit.sha : '', extensionUpdated: Boolean(extensionUpdate.updated), warnings },
    };
    const automation = runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION;
    // Record the post-apply project snapshot while the owning workflow run is
    // still active. Starting a second maintenance run after RUN_COMPLETED would
    // overwrite the user-visible terminal outcome and detach the LocalEffect
    // from the operation that produced the project state.
    await this.contextService.recordRemoteSnapshot(runtime, state.response || {}).catch((error) => this.publish(runtime.id, 'workflow.context.snapshot.record.failed', { message: error.message || String(error) }));
    await this.transition(runtime, automation ? WorkflowEventType.PHASE_CHANGED : WorkflowEventType.RUN_COMPLETED, automation
      ? { runId: runtime.workflowState.run.id, phase: WorkflowPhase.CHECKING, references: completionData.evidence }
      : completionData, warnings.length ? 'workflow.completed_with_warnings' : 'workflow.completed', {
        runId: runtime.workflowState.run.id,
        commit: commit.committed ? commit.sha : '',
        extensionUpdated: Boolean(extensionUpdate.updated),
        warnings,
      });
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
