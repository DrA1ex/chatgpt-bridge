import { publicWorkflowState } from './workflowState.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * This is the only workflow state exposed to HTTP/RPC/interactive consumers.
 * Runtime helpers and service objects must not leak into this projection.
 */
export function publicWorkflowSnapshot(runtime) {
  const execution = publicWorkflowState(runtime.executionState || runtime.workflowState);
  return {
    id: runtime.id,
    preset: runtime.config.preset || '',
    label: runtime.config.ux?.label || '',
    configPath: runtime.configPath,
    projectRoot: runtime.config.projectRoot,
    mode: runtime.config.watch.mode,
    sessionPolicy: runtime.config.automation?.session?.policy || 'current',
    pinnedSessionId: runtime.config.automation?.session?.id || '',
    restartPolicy: runtime.config.automation?.restartPolicy || 'ask',
    execution,
    workflowStateSchemaVersion: execution.schemaVersion,
    workflowStateRevision: execution.revision,
    lifecycle: execution.lifecycle,
    phase: execution.run.phase,
    nextAction: clone(execution.nextAction),
    lastOutcome: clone(execution.lastOutcome),
    project: clone(execution.project),
    binding: clone(execution.binding),
    run: clone(execution.run),
    effects: clone(execution.effects),
    retries: clone(execution.retries),
    retryPolicy: clone(execution.retryPolicy),
    loadedAt: runtime.loadedAt,
    updatedAt: runtime.updatedAt,
    ux: clone(runtime.config.ux || {}),
    resultProtocol: clone(runtime.config.resultProtocol || {}),
    intelligence: {
      model: String(runtime.config.ux?.intelligence?.model ?? runtime.config.automation?.turn?.model ?? ''),
      effort: String(runtime.config.ux?.intelligence?.effort ?? runtime.config.automation?.turn?.effort ?? ''),
    },
    checks: runtime.config.preset === 'apply-changes'
      ? clone(runtime.config.apply?.commands || [])
      : clone((runtime.config.automation?.steps || []).map((item) => item.command).filter(Boolean)),
    settings: {
      sessionExhaustion: runtime.config.ux?.sessionExhaustion || 'start-new-chat',
      session: clone(runtime.config.ux?.session || {}),
      invalidResponseAction: runtime.config.ux?.invalidResponseAction || 'repair',
      invalidResponseAttempts: Number(runtime.config.ux?.invalidResponseAttempts || 0),
      notifications: clone(runtime.config.ux?.notifications || {}),
      commits: clone(runtime.config.commit?.policy || {}),
      checks: {
        maxAttempts: Number(runtime.config.automation?.maxCycles || 8),
        noProgressLimit: Number(runtime.config.automation?.noProgressLimit || 3),
      },
    },
  };
}
