import { createHash } from 'node:crypto';
import path from 'node:path';
import { workflowId as createWorkflowId } from './support/workflowValues.js';
import { workflowSourceClientId } from './support/workflowBinding.js';
import { executeLocalEffect } from './state/localEffects.js';
import {
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  WorkflowRunKind,
} from './state/workflowState.js';

export class WorkflowManualOperations {
  constructor({ bridge, fileStore, verifier, extensionDeployer, enqueue, event, transition, processArtifact } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.verifier = verifier;
    this.extensionDeployer = extensionDeployer;
    this.enqueue = enqueue;
    this.event = event;
    this.transition = transition;
    this.processArtifact = processArtifact;
  }

  async verify(runtime, { artifactId = '', fileId = '' } = {}) {
    return await this.enqueue(runtime.id, async () => {
      if (runtime.workflowState.lifecycle !== WorkflowLifecycle.READY) {
        throw Object.assign(new Error(`Workflow ${runtime.id} must be ready before manual verification`), {
          code: 'WORKFLOW_MANUAL_VERIFY_NOT_READY',
        });
      }
      const pipelineId = createWorkflowId('verify');
      await this.transition(runtime, WorkflowEventType.RUN_STARTED, {
        runId: pipelineId,
        kind: WorkflowRunKind.MANUAL,
        phase: WorkflowPhase.VERIFYING,
        references: { operation: 'manual_verify', artifactId: String(artifactId || ''), fileId: String(fileId || '') },
      });
      let resolvedFileId = String(fileId || '');
      try {
        if (!resolvedFileId) {
          if (!artifactId) throw new Error('artifactId or fileId is required');
          const fetched = await this.bridge.fetchArtifact(artifactId, {
            sourceClientId: workflowSourceClientId(runtime),
          });
          resolvedFileId = fetched.id || artifactId;
        }
        const readable = await this.fileStore.getReadable(resolvedFileId);
        if (!readable?.absolutePath) throw new Error(`Artifact file cannot be opened from FileStore: ${resolvedFileId}`);
        const references = {
          projectFingerprint: String(runtime.workflowState.project?.fingerprintSha256 || ''),
          artifactId: String(artifactId || ''),
          fileId: resolvedFileId,
          fileSha256: String(readable.sha256 || ''),
          fileSize: Math.max(0, Number(readable.size) || 0),
        };
        const preconditionsHash = createHash('sha256').update(JSON.stringify(references)).digest('hex');
        const effectId = `${pipelineId}:verify:${preconditionsHash.slice(0, 20)}`;
        await this.event(runtime.id, 'workflow.manual.verify.started', { pipelineId, artifactId, fileId: resolvedFileId });
        const verification = await executeLocalEffect({
          transition: (target, type, data) => this.transition(target, type, data),
          runtime,
          effect: {
            id: effectId,
            kind: WorkflowLocalEffectKind.VERIFY,
            safe: true,
            idempotencyKey: effectId,
            preconditionsHash,
            references,
          },
          execute: () => this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId }),
        });
        await this.event(runtime.id, verification.ok ? 'workflow.manual.verify.completed' : 'workflow.manual.verify.failed', {
          pipelineId,
          artifactId,
          fileId: resolvedFileId,
          ok: verification.ok,
          reasons: verification.reasons,
          sha256: verification.zip?.sha256 || '',
          entries: verification.zip?.entries || 0,
          overlapScore: verification.overlapScore,
        });
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: pipelineId,
          code: verification.ok ? 'manual_verification_passed' : 'manual_verification_failed',
          evidence: {
            fileId: resolvedFileId,
            artifactId: String(artifactId || ''),
            sha256: String(verification.zip?.sha256 || ''),
            reasons: Array.isArray(verification.reasons) ? verification.reasons : [],
          },
        });
        return verification;
      } catch (error) {
        if (runtime.workflowState.run?.id === pipelineId) {
          await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
            runId: pipelineId,
            code: String(error?.code || 'manual_verification_error').toLowerCase(),
            message: error?.message || String(error),
          });
        }
        throw error;
      }
    });
  }

  async processFileResult(runtime, {
    fileId = '',
    answer = '',
    turnId = '',
    turnKey = '',
    sessionId = '',
    sourceClientId = '',
  } = {}) {
    return await this.enqueue(runtime.id, async () => {
      const resolvedFileId = String(fileId || '').trim();
      if (!resolvedFileId) throw new Error('fileId is required');
      const readable = await this.fileStore.getReadable(resolvedFileId);
      if (!readable?.absolutePath) throw new Error(`Artifact file cannot be opened from FileStore: ${resolvedFileId}`);
      const response = {
        answer: String(answer || ''),
        turnKey: String(turnKey || turnId || `direct-${resolvedFileId}`),
        sessionId: String(sessionId || ''),
        session: sessionId ? { id: String(sessionId) } : undefined,
        sourceClientId: workflowSourceClientId(runtime, sourceClientId),
      };
      const artifact = {
        id: `stored:${resolvedFileId}`,
        storedFileId: resolvedFileId,
        name: readable.name || path.basename(readable.absolutePath),
        mime: readable.mime || 'application/zip',
        size: readable.size || 0,
        kind: 'file',
        phase: 'READY',
        downloadable: true,
        sourceTurnKey: response.turnKey,
        sourceClientId: response.sourceClientId,
        sessionId: response.sessionId,
      };
      await this.event(runtime.id, 'workflow.direct.result.received', {
        fileId: resolvedFileId,
        turnId: String(turnId || ''),
        turnKey: response.turnKey,
        sessionId: response.sessionId,
        sourceClientId: response.sourceClientId,
        name: artifact.name,
        size: artifact.size,
      });
      return await this.processArtifact(runtime, response, artifact, {
        source: 'direct-file',
        remediationAttempt: 0,
        localFileId: resolvedFileId,
      });
    });
  }

  async deployExtension(runtime) {
    return await this.enqueue(runtime.id, async () => {
      await this.event(runtime.id, 'workflow.extension.update.started', {});
      const pipelineId = createWorkflowId('extension');
      const backup = await this.extensionDeployer.prepareBackup(runtime.config, { pipelineId });
      const result = await this.extensionDeployer.deploy(runtime.config, {
        sourceClientId: workflowSourceClientId(runtime),
        pipelineId,
        backup,
      });
      await this.event(runtime.id, 'workflow.extension.update.completed', result);
      return result;
    });
  }
}
