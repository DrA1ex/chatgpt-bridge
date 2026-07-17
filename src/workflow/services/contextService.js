import { bindVerifiedSource } from '../context/bindVerifiedSource.js';
import { syncProjectContext } from '../context/syncProjectContext.js';
import { acknowledgeRestartIntent } from '../recovery/acknowledgeRestartIntent.js';
import { recoverInterruptedPipeline } from '../recovery/recoverInterruptedPipeline.js';

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

  async recordRemoteSnapshot(runtime, response = {}) {
    if (!this.projectService) return { recorded: false, reason: 'project-service-unavailable' };
    const sessionId = String(response.session?.id || response.sessionId || runtime.config.watch.sessionId || runtime.boundSessionId || '');
    if (!sessionId) return { recorded: false, reason: 'session-unbound' };
    const packed = await this.projectService.pack(runtime.config.projectRoot, { force: false, useGitignore: true, snapshotPolicy: 'reuse' });
    runtime.contextSyncedSessionId = sessionId;
    runtime.contextSyncFingerprint = packed.snapshotId;
    runtime.projectFingerprintSha256 = packed.snapshotId;
    await this.persistRuntime(runtime);
    return { recorded: true, sessionId, fingerprintSha256: packed.snapshotId };
  }

  async bindVerified(runtime, response, artifact = {}) {
    return bindVerifiedSource({
      runtime,
      response,
      artifact,
      persistRuntime: this.persistRuntime,
      publish: this.publish,
      syncRefreshTimer: this.syncRefreshTimer,
      syncProjectContext: (target, options) => this.sync(target, options),
    });
  }

  async sync(runtime, { reason = 'manual', sessionId = '', sourceClientId = '' } = {}) {
    return syncProjectContext({
      runtime,
      reason,
      sessionId,
      sourceClientId,
      dataDir: this.dataDir,
      fileStore: this.fileStore,
      bridge: this.bridge,
      projectService: this.projectService,
      persistRuntime: this.persistRuntime,
      publish: this.publish,
    });
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
