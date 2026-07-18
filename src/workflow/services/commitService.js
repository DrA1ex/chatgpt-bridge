import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  buildCommitContext,
  captureGitPathStates,
  createGitCommit,
  extractMarkedBlock,
  inspectGitRepository,
  restoreGitWorkflowState,
  squashGitCommits,
  verifyGitPathStates,
} from '../gitCommit.js';
import { workflowRequestEffort } from '../support/workflowIntelligence.js';
import { WorkflowEffectKind } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';

function fallbackCommitMessage(runtime, manifest, paths = []) {
  const summary = String(manifest?.summary || '').trim();
  if (summary) return summary.split('\n')[0].slice(0, 120);
  const label = String(runtime.config.ux?.label || runtime.config.id || 'workflow').trim();
  const count = Array.from(paths || []).length;
  return count ? `Update ${label.toLowerCase()} (${count} file${count === 1 ? '' : 's'})` : `Update ${label.toLowerCase()}`;
}

export class WorkflowCommitService {
  constructor({ bridge, fileStore, dataDir, store, transition, publish, persistRuntime, completeAppliedPipeline } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.dataDir = dataDir;
    this.store = store;
    this.transition = transition;
    this.publish = publish;
    this.persistRuntime = persistRuntime;
    this.completeAppliedPipeline = completeAppliedPipeline;
  }

  async restoreStartingState(runtime) {
    const paths = runtime.workflowCommitPaths || [];
    await this.publish(runtime.id, 'workflow.restore.started', { baseSha: runtime.workflowCommitBaseSha || '', paths });
    const result = await restoreGitWorkflowState({
      root: runtime.config.projectRoot,
      baseSha: runtime.workflowCommitBaseSha || '',
      commitShas: runtime.workflowCommitShas || [],
      paths,
      refName: runtime.id,
    });
    if (!result.restored) throw new Error(`The workflow starting state could not be restored safely: ${result.reason || 'unknown reason'}`);
    runtime.workflowCommitShas = [];
    runtime.workflowCommitPaths = [];
    runtime.workflowCommitPathStates = {};
    runtime.lastWorkflowCommitMessage = '';
    await this.persistRuntime(runtime);
    await this.publish(runtime.id, 'workflow.restore.completed', result);
    return result;
  }

  async approvePending(runtime, decision) {
    const pending = await this.#decision(runtime, decision);
    try {
      {
        const ownership = await verifyGitPathStates(runtime.config.projectRoot, pending.pathStates || {});
        if (!ownership.ok) {
          const paths = ownership.conflicts.map((item) => item.path);
          const error = new Error(`Workflow files changed after application and before commit approval: ${paths.join(', ')}`);
          error.code = 'WORKFLOW_LOCAL_CHANGE_CONFLICT';
          error.paths = paths;
          await this.publish(runtime.id, 'workflow.local-change.conflict', {
            pipelineId: pending.pipelineId,
            message: error.message,
            paths,
          });
          throw error;
        }
      }
      const commit = await this.#createCommitEffect(runtime, pending.message, pending.paths);
      if (!commit.committed) throw new Error(`Git commit was not created: ${commit.reason || 'unknown reason'}`);
      runtime.workflowCommitBaseSha ||= String(pending.preApplyHead || '');
      runtime.workflowCommitShas = [...(runtime.workflowCommitShas || []), commit.sha];
      runtime.workflowCommitPaths = Array.from(new Set([...(runtime.workflowCommitPaths || []), ...(pending.paths || [])]));
      runtime.workflowCommitPathStates = { ...(runtime.workflowCommitPathStates || {}), ...(pending.pathStates || {}) };
      runtime.lastWorkflowCommitMessage = pending.message;
      pending.status = 'resolved';
      pending.choice = 'commit';
      await this.store.setDecision(pending.id, pending);
      await this.publish(runtime.id, 'workflow.commit.approved', { pipelineId: pending.pipelineId, commit: commit.sha, paths: pending.paths });
      return await this.completeAppliedPipeline(runtime, pending, { commit, warnings: pending.warnings || [] });
    } catch (error) {
      await this.publish(runtime.id, 'workflow.commit.failed', {
        pipelineId: pending.pipelineId,
        message: error.message || String(error),
        code: error.code || '',
        approvalPending: true,
      });
      throw error;
    }
  }

  async skipPending(runtime, decision, reason = 'skipped by user') {
    const pending = await this.#decision(runtime, decision);
    pending.status = 'resolved';
    pending.choice = 'continue_without_commit';
    await this.store.setDecision(pending.id, pending);
    const commit = { committed: false, reason: 'skipped-by-user', message: String(reason || 'skipped by user') };
    await this.publish(runtime.id, 'workflow.commit.skipped', { pipelineId: pending.pipelineId, reason: commit.message, paths: pending.paths });
    return await this.completeAppliedPipeline(runtime, pending, { commit, warnings: pending.warnings || [] });
  }

  async maybeCommit(runtime, sourceResponse, pipelineId, { preApplyGit = null, verification = null, workflowPaths = [] } = {}) {
    const cfg = runtime.config.commit;
    if (cfg.mode === 'none') {
      const pathStates = await captureGitPathStates(runtime.config.projectRoot, workflowPaths);
      runtime.workflowCommitBaseSha ||= String(preApplyGit?.head || '');
      runtime.workflowCommitPaths = Array.from(new Set([...(runtime.workflowCommitPaths || []), ...workflowPaths]));
      runtime.workflowCommitPathStates = { ...(runtime.workflowCommitPathStates || {}), ...pathStates };
      await this.persistRuntime(runtime);
      return { committed: false, reason: 'disabled', paths: workflowPaths, pathStates };
    }
    const gitInfo = await inspectGitRepository(runtime.config.projectRoot);
    if (!gitInfo.available) {
      const reason = gitInfo.reason || 'git-unavailable';
      if (cfg.required) throw new Error(`Git commit is required but the repository is unavailable: ${reason}`);
      return { committed: false, reason };
    }
    if (!gitInfo.dirty) {
      await this.publish(runtime.id, 'workflow.commit.skipped', { pipelineId, committed: false, reason: 'no-changes' });
      return { committed: false, reason: 'no-changes' };
    }
    const pathStates = await captureGitPathStates(runtime.config.projectRoot, workflowPaths);
    let answer = String(sourceResponse.answer || '');
    if (cfg.mode === 'same-chat' || cfg.mode === 'new-chat') {
      const prompt = cfg.prompt || [
        'Write a Git commit message for the completed project changes.',
        `Return only the message between exact markers ${cfg.beginMarker} and ${cfg.endMarker}.`,
        cfg.style === 'short' ? 'Use one concise subject line.' : 'Use a concise subject line and an optional explanatory body.',
      ].join('\n');
      if (cfg.mode === 'same-chat') {
        const response = await this.#sendCommitPrompt(runtime, pipelineId, 'same-chat', { message: prompt, sessionId: sourceResponse.session?.id || sourceResponse.sessionId || runtime.config.watch.sessionId || '', sourceClientId: sourceResponse.sourceClientId || runtime.config.watch.clientId || '', effort: workflowRequestEffort(runtime.config), fullResponse: true });
        answer = response.answer || '';
      } else {
        const contextPath = path.join(this.dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'commit-context.txt');
        await buildCommitContext(runtime.config.projectRoot, contextPath, { maxBytes: cfg.maxContextBytes });
        const attachment = await this.fileStore.importLocalPath({ filePath: contextPath, name: 'commit-context.txt', mime: 'text/plain' });
        const response = await this.#sendCommitPrompt(runtime, pipelineId, 'new-chat', { message: prompt, attachments: [attachment.id], newSession: true, effort: workflowRequestEffort(runtime.config), fullResponse: true });
        answer = response.answer || '';
        if (response.session?.id && response.session.id !== 'new') await this.bridge.deleteSession(response.session.id, { sourceClientId: response.sourceClientId || runtime.config.watch.clientId, expectedUrl: response.session.url || response.url || '' }).catch(() => {});
      }
    }
    const manifest = verification?.resultProtocol?.manifest || null;
    const message = String(manifest?.commitMessage || '').trim()
      || extractMarkedBlock(answer, cfg.beginMarker, cfg.endMarker)
      || fallbackCommitMessage(runtime, manifest, workflowPaths);
    if (!message) {
      if (cfg.required) throw new Error(`Commit message is required but missing (${cfg.beginMarker} ... ${cfg.endMarker})`);
      return { committed: false, reason: 'commit-message-missing' };
    }
    if (cfg.policy?.iterationStrategy === 'final-only' && runtime.config.preset === 'fix-until-pass') {
      runtime.workflowCommitBaseSha ||= String(preApplyGit?.head || gitInfo.head || '');
      runtime.workflowCommitPaths = Array.from(new Set([...(runtime.workflowCommitPaths || []), ...workflowPaths]));
      runtime.workflowCommitPathStates = { ...(runtime.workflowCommitPathStates || {}), ...pathStates };
      runtime.lastWorkflowCommitMessage = message;
      await this.persistRuntime(runtime);
      await this.publish(runtime.id, 'workflow.commit.deferred', { pipelineId, message, paths: workflowPaths });
      return { committed: false, reason: 'deferred-final', message, paths: workflowPaths };
    }
    if (cfg.policy?.mode === 'ask') return { committed: false, reason: 'approval-required', message, paths: workflowPaths, pathStates };
    {
      const ownership = await verifyGitPathStates(runtime.config.projectRoot, pathStates);
      if (!ownership.ok) {
        const paths = ownership.conflicts.map((item) => item.path);
        const error = new Error(`Workflow files changed before the commit could be created: ${paths.join(', ')}`);
        error.code = 'WORKFLOW_LOCAL_CHANGE_CONFLICT';
        error.paths = paths;
        throw error;
      }
    }
    const result = await this.#createCommitEffect(runtime, message, workflowPaths);
    if (!result.committed && cfg.required) throw new Error(`Git commit is required but was not created: ${result.reason || 'unknown reason'}`);
    if (result.committed) {
      runtime.workflowCommitBaseSha ||= String(preApplyGit?.head || '');
      runtime.workflowCommitShas = [...(runtime.workflowCommitShas || []), result.sha];
      runtime.workflowCommitPaths = Array.from(new Set([...(runtime.workflowCommitPaths || []), ...workflowPaths]));
      runtime.workflowCommitPathStates = { ...(runtime.workflowCommitPathStates || {}), ...pathStates };
      runtime.lastWorkflowCommitMessage = message;
      await this.persistRuntime(runtime);
    }
    await this.publish(runtime.id, result.committed ? 'workflow.commit.completed' : 'workflow.commit.skipped', { pipelineId, ...result });
    return result;
  }

  async finalize(runtime, { automationId = '' } = {}) {
    const policy = runtime.config.commit?.policy || {};
    const shas = runtime.workflowCommitShas || [];
    const paths = runtime.workflowCommitPaths || [];
    if (policy.mode !== 'automatic') return { committed: false, reason: 'policy' };
    if (paths.length) {
      const ownership = await verifyGitPathStates(runtime.config.projectRoot, runtime.workflowCommitPathStates || {});
      if (!ownership.ok) {
        const conflictPaths = ownership.conflicts.map((item) => item.path);
        const error = new Error(`Workflow-owned files changed before final commit: ${conflictPaths.join(', ')}`);
        error.code = 'WORKFLOW_LOCAL_CHANGE_CONFLICT';
        error.paths = conflictPaths;
        await this.publish(runtime.id, 'workflow.local-change.conflict', {
          automationId,
          message: error.message,
          paths: conflictPaths,
        });
        throw error;
      }
    }
    if (policy.iterationStrategy === 'final-only') {
      if (!paths.length) return { committed: false, reason: 'no-workflow-changes' };
      const message = runtime.lastWorkflowCommitMessage || fallbackCommitMessage(runtime, null, paths);
      await this.publish(runtime.id, 'workflow.commit.final.started', { automationId, paths, message });
      const result = await this.#createCommitEffect(runtime, message, paths);
      if (result.committed) {
        runtime.workflowCommitShas = [result.sha];
        runtime.lastWorkflowCommitMessage = message;
        await this.persistRuntime(runtime);
        await this.publish(runtime.id, 'workflow.commit.final.completed', { automationId, ...result, paths });
      } else await this.publish(runtime.id, 'workflow.commit.final.skipped', { automationId, ...result, paths });
      return result;
    }
    if (policy.completionStrategy !== 'squash' || shas.length < 2) return { squashed: false, reason: shas.length < 2 ? 'not-enough-checkpoints' : 'policy' };
    await this.publish(runtime.id, 'workflow.commit.squash.started', { automationId, checkpoints: shas.length });
    const result = await squashGitCommits({
      root: runtime.config.projectRoot,
      baseSha: runtime.workflowCommitBaseSha,
      commitShas: shas,
      message: runtime.lastWorkflowCommitMessage || fallbackCommitMessage(runtime, null, paths),
      paths,
      refName: `${runtime.id}/${automationId || 'latest'}`,
      authorName: runtime.config.commit.authorName,
      authorEmail: runtime.config.commit.authorEmail,
    });
    if (result.squashed) {
      runtime.workflowCommitShas = [result.sha];
      runtime.lastWorkflowCommitMessage = result.message;
      await this.persistRuntime(runtime);
      await this.publish(runtime.id, 'workflow.commit.squash.completed', { automationId, ...result });
    } else await this.publish(runtime.id, 'workflow.commit.squash.skipped', { automationId, ...result });
    return result;
  }

  async #decision(runtime, value) {
    const pending = typeof value === 'string' ? await this.store.getDecision(value) : value;
    if (!pending || pending.workflowId !== runtime.id || pending.status !== 'pending') throw new Error(`Workflow ${runtime.id} has no matching pending commit decision`);
    return pending;
  }

  async #sendCommitPrompt(runtime, pipelineId, mode, request) {
    const preconditionsHash = createHash('sha256').update(JSON.stringify({ mode, request })).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:prompt:commit:${preconditionsHash.slice(0, 16)}`;
    return await executeWorkflowEffect({
      transition: this.transition,
      runtime,
      effect: { id: effectId, kind: WorkflowEffectKind.PROMPT, safe: false, idempotencyKey: effectId, preconditionsHash, references: { pipelineId, mode } },
      execute: () => this.bridge.sendRequest(request),
    });
  }

  async #createCommitEffect(runtime, message, paths) {
    const preconditionsHash = createHash('sha256').update(JSON.stringify({
      project: runtime.workflowState.project.fingerprintSha256,
      message,
      paths: [...paths].sort(),
    })).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:commit:${preconditionsHash.slice(0, 16)}`;
    return await executeWorkflowEffect({
      transition: this.transition,
      runtime,
      effect: { id: effectId, kind: WorkflowEffectKind.COMMIT, safe: false, idempotencyKey: effectId, preconditionsHash, references: { paths } },
      execute: () => createGitCommit({ root: runtime.config.projectRoot, message, paths, authorName: runtime.config.commit.authorName, authorEmail: runtime.config.commit.authorEmail }),
    });
  }
}
