function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function publicWorkflowSnapshot(runtime) {
  return {
    id: runtime.id,
    configPath: runtime.configPath,
    projectRoot: runtime.config.projectRoot,
    mode: runtime.config.watch.mode,
    status: String(runtime.workflowState?.watcher?.status || 'stopped'),
    sessionPolicy: runtime.config.automation?.session?.policy || 'current',
    pinnedSessionId: runtime.config.automation?.session?.id || '',
    restartPolicy: runtime.config.automation?.restartPolicy || 'ask',
    automationInterrupted: Boolean(runtime.automationInterrupted),
    clientId: runtime.config.watch.clientId,
    sessionId: runtime.config.watch.sessionId,
    watcher: clone(runtime.workflowState?.watcher || {}),
    pipeline: clone(runtime.workflowState?.pipeline || {}),
    automation: clone(runtime.workflowState?.automation || {}),
    workflowStateSchemaVersion: Number(runtime.workflowState?.schemaVersion || 0),
    lastOutcome: clone(runtime.workflowState?.lastOutcome || null),
    workflowStateRevision: Number(runtime.workflowState?.revision || 0),
    loadedAt: runtime.loadedAt,
    updatedAt: runtime.updatedAt,
    lastObservedTurnKey: runtime.lastObservedTurnKey,
    lastSourceClientId: runtime.lastSourceClientId,
    lastSessionId: runtime.lastSessionId,
    boundSourceClientId: runtime.boundSourceClientId,
    boundSessionId: runtime.boundSessionId,
    lastPipelineId: runtime.lastPipelineId,
    lastError: runtime.lastError,
    projectId: runtime.projectId || '',
    projectFingerprintSha256: runtime.projectFingerprintSha256 || '',
    contextSyncedSessionId: runtime.contextSyncedSessionId || '',
    contextSyncFingerprint: runtime.contextSyncFingerprint || '',
  };
}
