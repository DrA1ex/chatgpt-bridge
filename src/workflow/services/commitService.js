import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
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
import { workflowSessionId, workflowSourceClientId } from '../support/workflowBinding.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';
import { WorkflowActionKind, WorkflowEffectKind, WorkflowEventType, WorkflowLifecycle, WorkflowLocalEffectKind, WorkflowPhase, WorkflowRunKind } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { executeLocalEffect } from '../state/localEffects.js';
import {
  clearWorkflowGitState,
  mergeWorkflowGitState,
  replaceWorkflowGitState,
  workflowGitState,
} from '../state/workflowGitState.js';


async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}
`, 'utf8');
  await fs.rename(temp, file);
}

function localEffectReceiptPath(service, runtime, effectId) {
  const safe = String(effectId || 'effect').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(service.dataDir, 'workflows', runtime.id, 'local-effects', `${safe}.json`);
}

function fallbackCommitMessage(runtime, manifest, paths = []) {
  const summary = String(manifest?.summary || '').trim();
  if (summary) return summary.split('\n')[0].slice(0, 120);
  const label = String(runtime.config.ux?.label || runtime.config.id || 'workflow').trim();
  const count = Array.from(paths || []).length;
  return count ? `Update ${label.toLowerCase()} (${count} file${count === 1 ? '' : 's'})` : `Update ${label.toLowerCase()}`;
}

export class WorkflowCommitService {
  constructor({ bridge, fileStore, dataDir, store, transition, publish, completeAppliedPipeline } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.dataDir = dataDir;
    this.store = store;
    this.transition = transition;
    this.publish = publish;
    this.completeAppliedPipeline = completeAppliedPipeline;
  }

  async restoreStartingState(runtime) {
    let ownedRun = false;
    if (runtime.workflowState.lifecycle === WorkflowLifecycle.READY) {
      ownedRun = true;
      await this.transition(runtime, WorkflowEventType.RUN_STARTED, {
        runId: createWorkflowId('run'),
        kind: WorkflowRunKind.MANUAL,
        phase: WorkflowPhase.ROLLING_BACK,
        references: { trigger: 'restore-starting-state' },
      });
    }
    try {
      const git = workflowGitState(runtime);
      const paths = git.ownedPaths;
      const baseSha = git.baseSha;
      const commitShas = git.checkpointShas;
      const preconditionsHash = createHash('sha256')
        .update(JSON.stringify({ baseSha, commitShas, paths: [...paths].sort() }))
        .digest('hex');
      const effectId = `${runtime.workflowState.run?.id || runtime.id}:git-restore:${preconditionsHash.slice(0, 16)}`;
      const receiptPath = localEffectReceiptPath(this, runtime, effectId);
      const preRestore = await inspectGitRepository(runtime.config.projectRoot);
      await this.publish(runtime.id, 'workflow.restore.started', { baseSha, paths });
      const result = await executeLocalEffect({
        transition: this.transition,
        runtime,
        effect: {
          id: effectId,
          kind: WorkflowLocalEffectKind.ROLLBACK,
          safe: false,
          idempotencyKey: effectId,
          preconditionsHash,
          references: {
            mode: 'git_restore',
            receiptPath,
            baseSha,
            checkpointShas: commitShas,
            paths,
            preCommitHead: preRestore.head || '',
            refName: runtime.id,
          },
        },
        execute: async () => {
          const restored = await restoreGitWorkflowState({
            root: runtime.config.projectRoot,
            baseSha,
            commitShas,
            paths,
            refName: runtime.id,
          });
          if (!restored.restored) {
            throw new Error(`The workflow starting state could not be restored safely: ${restored.reason || 'unknown reason'}`);
          }
          await writeJsonAtomic(receiptPath, { schemaVersion: 1, effectId, restoredAt: Date.now(), ...restored });
          return restored;
        },
      });
      await clearWorkflowGitState(this.transition, runtime, { baseSha }, 'starting state restored');
      await this.publish(runtime.id, 'workflow.restore.completed', result);
      if (ownedRun) {
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: runtime.workflowState.run.id,
          code: 'starting_state_restored',
          message: 'Workflow starting state restored',
          evidence: { baseSha, paths, restored: true },
        });
      }
      return result;
    } catch (error) {
      if (ownedRun && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) {
        await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
          runId: runtime.workflowState.run.id,
          message: error?.message || String(error),
          evidence: { operation: 'restore-starting-state' },
        }).catch(() => {});
      }
      throw error;
    }
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
      await mergeWorkflowGitState(this.transition, runtime, {
        baseSha: String(pending.preApplyHead || ''),
        checkpointShas: [commit.sha],
        ownedPaths: pending.paths || [],
        pathStates: pending.pathStates || {},
        lastCommitMessage: pending.message,
      }, 'approved checkpoint commit recorded');
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
    const commit = { committed: false, reason: 'skipped-by-user', message: String(reason || 'skipped by user') };
    await this.publish(runtime.id, 'workflow.commit.skipped', { pipelineId: pending.pipelineId, reason: commit.message, paths: pending.paths });
    return await this.completeAppliedPipeline(runtime, pending, { commit, warnings: pending.warnings || [] });
  }

  async maybeCommit(runtime, sourceResponse, pipelineId, { preApplyGit = null, verification = null, workflowPaths = [] } = {}) {
    const cfg = runtime.config.commit;
    if (cfg.mode === 'none') {
      const pathStates = await captureGitPathStates(runtime.config.projectRoot, workflowPaths);
      await mergeWorkflowGitState(this.transition, runtime, {
        baseSha: String(preApplyGit?.head || ''),
        ownedPaths: workflowPaths,
        pathStates,
      }, 'workflow-owned paths recorded without commit');
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
        const response = await this.#sendCommitPrompt(runtime, pipelineId, 'same-chat', { message: prompt, sessionId: workflowSessionId(runtime, sourceResponse.session?.id || sourceResponse.sessionId, { allowLast: false }), sourceClientId: workflowSourceClientId(runtime, sourceResponse.sourceClientId, { allowLast: false }), effort: workflowRequestEffort(runtime.config), fullResponse: true });
        answer = response.answer || '';
      } else {
        const contextPath = path.join(this.dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'commit-context.txt');
        await buildCommitContext(runtime.config.projectRoot, contextPath, { maxBytes: cfg.maxContextBytes });
        const attachment = await this.fileStore.importLocalPath({ filePath: contextPath, name: 'commit-context.txt', mime: 'text/plain' });
        const response = await this.#sendCommitPrompt(runtime, pipelineId, 'new-chat', { message: prompt, attachments: [attachment.id], newSession: true, effort: workflowRequestEffort(runtime.config), fullResponse: true });
        answer = response.answer || '';
        if (response.session?.id && response.session.id !== 'new') await this.bridge.deleteSession(response.session.id, { sourceClientId: workflowSourceClientId(runtime, response.sourceClientId, { allowLast: false }), expectedUrl: response.session.url || response.url || '' }).catch(() => {});
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
      await mergeWorkflowGitState(this.transition, runtime, {
        baseSha: String(preApplyGit?.head || gitInfo.head || ''),
        ownedPaths: workflowPaths,
        pathStates,
        lastCommitMessage: message,
      }, 'final-only commit deferred');
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
      await mergeWorkflowGitState(this.transition, runtime, {
        baseSha: String(preApplyGit?.head || ''),
        checkpointShas: [result.sha],
        ownedPaths: workflowPaths,
        pathStates,
        lastCommitMessage: message,
      }, 'checkpoint commit recorded');
    }
    await this.publish(runtime.id, result.committed ? 'workflow.commit.completed' : 'workflow.commit.skipped', { pipelineId, ...result });
    return result;
  }

  async finalize(runtime, { automationId = '' } = {}) {
    const policy = runtime.config.commit?.policy || {};
    const git = workflowGitState(runtime);
    const shas = git.checkpointShas;
    const paths = git.ownedPaths;
    if (policy.mode !== 'automatic') return { committed: false, reason: 'policy' };
    if (paths.length) {
      const ownership = await verifyGitPathStates(runtime.config.projectRoot, git.pathStates);
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
      const message = git.lastCommitMessage || fallbackCommitMessage(runtime, null, paths);
      await this.publish(runtime.id, 'workflow.commit.final.started', { automationId, paths, message });
      const result = await this.#createCommitEffect(runtime, message, paths);
      if (result.committed) {
        await replaceWorkflowGitState(this.transition, runtime, {
          ...git,
          checkpointShas: [result.sha],
          lastCommitMessage: message,
        }, 'final commit recorded');
        await this.publish(runtime.id, 'workflow.commit.final.completed', { automationId, ...result, paths });
      } else await this.publish(runtime.id, 'workflow.commit.final.skipped', { automationId, ...result, paths });
      return result;
    }
    if (policy.completionStrategy !== 'squash' || shas.length < 2) return { squashed: false, reason: shas.length < 2 ? 'not-enough-checkpoints' : 'policy' };
    const baseSha = git.baseSha;
    const message = git.lastCommitMessage || fallbackCommitMessage(runtime, null, paths);
    const refName = `${runtime.id}/${automationId || 'latest'}`;
    const safeRef = String(refName).replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '') || 'workflow';
    const backupRef = `refs/bridge/workflows/${safeRef}`;
    const preconditionsHash = createHash('sha256').update(JSON.stringify({ baseSha, shas, message, paths: [...paths].sort(), refName })).digest('hex');
    const effectId = `${runtime.workflowState.run?.id || runtime.id}:squash:${preconditionsHash.slice(0, 16)}`;
    const receiptPath = localEffectReceiptPath(this, runtime, effectId);
    const preSquash = await inspectGitRepository(runtime.config.projectRoot);
    await this.publish(runtime.id, 'workflow.commit.squash.started', { automationId, checkpoints: shas.length });
    const result = await executeLocalEffect({
      transition: this.transition,
      runtime,
      effect: {
        id: effectId,
        kind: WorkflowLocalEffectKind.SQUASH,
        safe: false,
        idempotencyKey: effectId,
        preconditionsHash,
        references: {
          receiptPath, expectedMessage: message, preCommitHead: preSquash.head || '',
          baseSha, checkpointShas: shas, paths, backupRef, refName,
        },
      },
      execute: async () => {
        const squashed = await squashGitCommits({
          root: runtime.config.projectRoot,
          baseSha,
          commitShas: shas,
          message,
          paths,
          refName,
          authorName: runtime.config.commit.authorName,
          authorEmail: runtime.config.commit.authorEmail,
        });
        if (squashed.squashed) await writeJsonAtomic(receiptPath, { schemaVersion: 1, effectId, squashedAt: Date.now(), ...squashed });
        return squashed;
      },
    });
    if (result.squashed) {
      await replaceWorkflowGitState(this.transition, runtime, {
        ...git,
        checkpointShas: [result.sha],
        lastCommitMessage: result.message,
      }, 'squashed checkpoint graph recorded');
      await this.publish(runtime.id, 'workflow.commit.squash.completed', { automationId, ...result });
    } else await this.publish(runtime.id, 'workflow.commit.squash.skipped', { automationId, ...result });
    return result;
  }

  async #decision(runtime, value) {
    const pending = typeof value === 'string' ? await this.store.getActionPayload(value) : value;
    if (!pending || pending.workflowId !== runtime.id || pending.kind !== WorkflowActionKind.COMMIT) throw new Error(`Workflow ${runtime.id} has no matching pending commit decision`);
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
    const preCommit = await inspectGitRepository(runtime.config.projectRoot);
    return await executeLocalEffect({
      transition: this.transition,
      runtime,
      effect: { id: effectId, kind: WorkflowLocalEffectKind.COMMIT, safe: false, idempotencyKey: effectId, preconditionsHash, references: { paths, expectedMessage: message, preCommitHead: preCommit.head || '' } },
      execute: () => createGitCommit({ root: runtime.config.projectRoot, message, paths, authorName: runtime.config.commit.authorName, authorEmail: runtime.config.commit.authorEmail }),
    });
  }
}
