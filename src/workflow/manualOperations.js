import path from 'node:path';
import { workflowId as createWorkflowId } from './support/workflowValues.js';

export class WorkflowManualOperations {
  constructor({ bridge, fileStore, verifier, extensionDeployer, enqueue, event, processArtifact } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.verifier = verifier;
    this.extensionDeployer = extensionDeployer;
    this.enqueue = enqueue;
    this.event = event;
    this.processArtifact = processArtifact;
  }

  async verify(runtime, { artifactId = '', fileId = '' } = {}) {
    return await this.enqueue(runtime.id, async () => {
      const pipelineId = createWorkflowId('verify');
      let resolvedFileId = String(fileId || '');
      if (!resolvedFileId) {
        if (!artifactId) throw new Error('artifactId or fileId is required');
        const fetched = await this.bridge.fetchArtifact(artifactId, {
          sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
        });
        resolvedFileId = fetched.id || artifactId;
      }
      const readable = await this.fileStore.getReadable(resolvedFileId);
      if (!readable?.absolutePath) throw new Error(`Artifact file cannot be opened from FileStore: ${resolvedFileId}`);
      await this.event(runtime.id, 'workflow.manual.verify.started', { pipelineId, artifactId, fileId: resolvedFileId });
      const verification = await this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId });
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
      return verification;
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
        sourceClientId: String(sourceClientId || runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || ''),
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
        sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
        pipelineId,
        backup,
      });
      await this.event(runtime.id, 'workflow.extension.update.completed', result);
      return result;
    });
  }
}
