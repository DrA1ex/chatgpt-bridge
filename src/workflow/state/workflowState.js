export const WORKFLOW_STATE_SCHEMA_VERSION = 1;

export const WorkflowWatcherStatus = Object.freeze({
  RUNNING: 'running',
  STOPPED: 'stopped',
});

export const WorkflowPipelineStatus = Object.freeze({
  IDLE: 'idle',
  OBSERVED: 'observed',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting_approval',
  APPLYING: 'applying',
  REMEDIATING: 'remediating',
  RECOVERING: 'recovering',
  ROLLING_BACK: 'rolling_back',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
});

export const WorkflowStateEventType = Object.freeze({
  WATCHER_STARTED: 'watcher.started',
  WATCHER_STOPPED: 'watcher.stopped',
  PIPELINE_STARTED: 'pipeline.started',
  PIPELINE_STAGE_CHANGED: 'pipeline.stage_changed',
  PIPELINE_COMPLETED: 'pipeline.completed',
  PIPELINE_FAILED: 'pipeline.failed',
  PIPELINE_REJECTED: 'pipeline.rejected',
});

const TERMINAL_PIPELINE_STATUSES = new Set([
  WorkflowPipelineStatus.COMPLETED,
  WorkflowPipelineStatus.FAILED,
  WorkflowPipelineStatus.REJECTED,
]);

const ACTIVE_PIPELINE_STATUSES = new Set([
  WorkflowPipelineStatus.OBSERVED,
  WorkflowPipelineStatus.DOWNLOADING,
  WorkflowPipelineStatus.VERIFYING,
  WorkflowPipelineStatus.PLANNING,
  WorkflowPipelineStatus.AWAITING_APPROVAL,
  WorkflowPipelineStatus.APPLYING,
  WorkflowPipelineStatus.REMEDIATING,
  WorkflowPipelineStatus.RECOVERING,
  WorkflowPipelineStatus.ROLLING_BACK,
]);

function timestamp(value = '') {
  return String(value || new Date().toISOString());
}

function pipeline(status = WorkflowPipelineStatus.IDLE, options = {}) {
  const idle = status === WorkflowPipelineStatus.IDLE;
  return {
    id: idle ? '' : String(options.id || ''),
    status,
    revision: Math.max(0, Number(options.revision) || 0),
    startedAt: idle ? '' : timestamp(options.startedAt),
    updatedAt: timestamp(options.updatedAt),
    approvalId: String(options.approvalId || ''),
    terminal: options.terminal && typeof options.terminal === 'object' ? { ...options.terminal } : null,
    evidence: options.evidence && typeof options.evidence === 'object' ? { ...options.evidence } : {},
  };
}

export function createWorkflowState(options = {}) {
  const watcherStatus = options.watcherStatus === WorkflowWatcherStatus.STOPPED
    ? WorkflowWatcherStatus.STOPPED
    : WorkflowWatcherStatus.RUNNING;
  const pipelineStatus = Object.values(WorkflowPipelineStatus).includes(options.pipelineStatus)
    ? options.pipelineStatus
    : WorkflowPipelineStatus.IDLE;
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    revision: Math.max(0, Number(options.revision) || 0),
    watcher: {
      status: watcherStatus,
      updatedAt: timestamp(options.updatedAt),
    },
    pipeline: pipeline(pipelineStatus, {
      id: options.pipelineId,
      revision: options.pipelineRevision,
      startedAt: options.pipelineStartedAt,
      updatedAt: options.updatedAt,
      approvalId: options.approvalId,
      terminal: options.pipelineTerminal,
      evidence: options.pipelineEvidence,
    }),
    lastOutcome: options.lastOutcome && typeof options.lastOutcome === 'object'
      ? { ...options.lastOutcome }
      : null,
  };
}

export function restoreWorkflowState(saved = {}, options = {}) {
  const legacyStatus = String(saved?.status || options.status || 'watching');
  if (saved?.watcher && saved?.pipeline) {
    const structured = createWorkflowState({
      watcherStatus: legacyStatus === 'stopped' ? WorkflowWatcherStatus.STOPPED : saved.watcher.status,
      pipelineStatus: saved.pipeline.status,
      pipelineId: saved.pipeline.id,
      pipelineRevision: saved.pipeline.revision,
      pipelineStartedAt: saved.pipeline.startedAt,
      pipelineTerminal: saved.pipeline.terminal,
      pipelineEvidence: saved.pipeline.evidence,
      approvalId: saved.pipeline.approvalId,
      lastOutcome: saved.lastOutcome,
      revision: saved.revision,
      updatedAt: saved.pipeline.updatedAt || saved.watcher.updatedAt || options.updatedAt,
    });
    const legacyPipelineId = String(saved.lastPipelineId || saved.pipeline.id || options.pipelineId || '');
    if ((legacyStatus === 'processing' || legacyStatus === 'recovering')
      && (!isWorkflowPipelineActive(structured) || isWorkflowPipelineTerminal(structured))) {
      return createWorkflowState({
        watcherStatus: WorkflowWatcherStatus.RUNNING,
        pipelineStatus: WorkflowPipelineStatus.RECOVERING,
        pipelineId: legacyPipelineId,
        lastOutcome: structured.lastOutcome,
        revision: structured.revision,
        updatedAt: saved.updatedAt || options.updatedAt,
      });
    }
    if (legacyStatus === 'awaiting-approval'
      && structured.pipeline.status !== WorkflowPipelineStatus.AWAITING_APPROVAL) {
      return createWorkflowState({
        watcherStatus: WorkflowWatcherStatus.RUNNING,
        pipelineStatus: WorkflowPipelineStatus.AWAITING_APPROVAL,
        pipelineId: legacyPipelineId,
        approvalId: saved.approvalId || structured.pipeline.approvalId,
        lastOutcome: structured.lastOutcome,
        revision: structured.revision,
        updatedAt: saved.updatedAt || options.updatedAt,
      });
    }
    return structured;
  }

  const watcherStatus = legacyStatus === 'stopped'
    ? WorkflowWatcherStatus.STOPPED
    : WorkflowWatcherStatus.RUNNING;
  let pipelineStatus = WorkflowPipelineStatus.IDLE;
  if (legacyStatus === 'awaiting-approval') pipelineStatus = WorkflowPipelineStatus.AWAITING_APPROVAL;
  else if (legacyStatus === 'recovering') pipelineStatus = WorkflowPipelineStatus.RECOVERING;
  else if (legacyStatus === 'processing') pipelineStatus = WorkflowPipelineStatus.RECOVERING;
  return createWorkflowState({
    watcherStatus,
    pipelineStatus,
    pipelineId: saved?.lastPipelineId || options.pipelineId,
    approvalId: saved?.approvalId,
    updatedAt: saved?.updatedAt || options.updatedAt,
  });
}

export function isWorkflowPipelineTerminal(state) {
  return TERMINAL_PIPELINE_STATUSES.has(state?.pipeline?.status);
}

export function isWorkflowPipelineActive(state) {
  return ACTIVE_PIPELINE_STATUSES.has(state?.pipeline?.status);
}

export function legacyWorkflowStatus(state) {
  if (state?.watcher?.status === WorkflowWatcherStatus.STOPPED) return 'stopped';
  if (state?.pipeline?.status === WorkflowPipelineStatus.AWAITING_APPROVAL) return 'awaiting-approval';
  if (state?.pipeline?.status === WorkflowPipelineStatus.RECOVERING
    || state?.pipeline?.status === WorkflowPipelineStatus.ROLLING_BACK) return 'recovering';
  if (isWorkflowPipelineActive(state)) return 'processing';
  return 'watching';
}

function rejected(state, code, message) {
  return { accepted: false, state, diagnostics: [{ code, message }] };
}

function committed(state, event, patch) {
  const at = timestamp(event.at);
  const next = {
    ...state,
    ...patch,
    revision: Number(state.revision || 0) + 1,
  };
  if (patch.watcher) next.watcher = { ...state.watcher, ...patch.watcher, updatedAt: at };
  if (patch.pipeline) {
    next.pipeline = {
      ...state.pipeline,
      ...patch.pipeline,
      revision: Number(state.pipeline?.revision || 0) + 1,
      updatedAt: at,
    };
  }
  return { accepted: true, state: next, diagnostics: [] };
}

export function reduceWorkflowState(current, event = {}) {
  const state = current || createWorkflowState({ updatedAt: event.at });
  const type = String(event.type || '');
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const pipelineId = String(data.pipelineId || state.pipeline.id || '');

  if (type === WorkflowStateEventType.WATCHER_STARTED) {
    return committed(state, event, { watcher: { status: WorkflowWatcherStatus.RUNNING } });
  }
  if (type === WorkflowStateEventType.WATCHER_STOPPED) {
    return committed(state, event, { watcher: { status: WorkflowWatcherStatus.STOPPED } });
  }
  if (type === WorkflowStateEventType.PIPELINE_STARTED) {
    if (!pipelineId) return rejected(state, 'pipeline_id_required', 'A pipeline id is required');
    return committed(state, event, {
      pipeline: {
        ...pipeline(data.status || WorkflowPipelineStatus.OBSERVED, {
          id: pipelineId,
          startedAt: event.at,
          updatedAt: event.at,
          evidence: data.evidence,
        }),
        revision: Number(state.pipeline?.revision || 0),
      },
    });
  }
  if (type === WorkflowStateEventType.PIPELINE_STAGE_CHANGED) {
    if (!pipelineId || pipelineId !== state.pipeline.id) {
      return rejected(state, 'pipeline_id_mismatch', `Pipeline ${pipelineId || '<missing>'} does not match ${state.pipeline.id || '<none>'}`);
    }
    if (isWorkflowPipelineTerminal(state)) {
      return rejected(state, 'pipeline_already_terminal', `Pipeline ${pipelineId} is already ${state.pipeline.status}`);
    }
    const status = String(data.status || '');
    if (!ACTIVE_PIPELINE_STATUSES.has(status)) return rejected(state, 'invalid_pipeline_stage', `Invalid active pipeline stage: ${status}`);
    return committed(state, event, {
      pipeline: {
        status,
        approvalId: String(data.approvalId || state.pipeline.approvalId || ''),
        evidence: { ...state.pipeline.evidence, ...(data.evidence || {}) },
      },
    });
  }

  const terminalStatus = type === WorkflowStateEventType.PIPELINE_COMPLETED
    ? WorkflowPipelineStatus.COMPLETED
    : type === WorkflowStateEventType.PIPELINE_FAILED
      ? WorkflowPipelineStatus.FAILED
      : type === WorkflowStateEventType.PIPELINE_REJECTED
        ? WorkflowPipelineStatus.REJECTED
        : '';
  if (terminalStatus) {
    if (!pipelineId || pipelineId !== state.pipeline.id) {
      return rejected(state, 'pipeline_id_mismatch', `Pipeline ${pipelineId || '<missing>'} does not match ${state.pipeline.id || '<none>'}`);
    }
    const terminal = {
      status: terminalStatus,
      code: String(data.code || terminalStatus),
      message: String(data.message || ''),
      at: timestamp(event.at),
      evidence: data.evidence && typeof data.evidence === 'object' ? { ...data.evidence } : {},
    };
    return committed(state, event, {
      pipeline: { status: terminalStatus, terminal, approvalId: String(data.approvalId || state.pipeline.approvalId || '') },
      lastOutcome: { pipelineId, ...terminal },
    });
  }

  return rejected(state, 'unknown_workflow_state_event', `Unknown workflow state event: ${type}`);
}
