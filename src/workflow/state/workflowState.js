export const WORKFLOW_STATE_SCHEMA_VERSION = 2;

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

export const WorkflowAutomationStatus = Object.freeze({
  IDLE: 'idle',
  VALIDATING: 'validating',
  WAITING_TURN: 'waiting_turn',
  APPLYING: 'applying',
  AWAITING_APPROVAL: 'awaiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

export const WorkflowStateEventType = Object.freeze({
  WATCHER_STARTED: 'watcher.started',
  WATCHER_STOPPED: 'watcher.stopped',
  PIPELINE_STARTED: 'pipeline.started',
  PIPELINE_STAGE_CHANGED: 'pipeline.stage_changed',
  PIPELINE_COMPLETED: 'pipeline.completed',
  PIPELINE_FAILED: 'pipeline.failed',
  PIPELINE_REJECTED: 'pipeline.rejected',
  AUTOMATION_STARTED: 'automation.started',
  AUTOMATION_STAGE_CHANGED: 'automation.stage_changed',
  AUTOMATION_COMPLETED: 'automation.completed',
  AUTOMATION_FAILED: 'automation.failed',
  AUTOMATION_STOPPED: 'automation.stopped',
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

const TERMINAL_AUTOMATION_STATUSES = new Set([
  WorkflowAutomationStatus.COMPLETED,
  WorkflowAutomationStatus.FAILED,
  WorkflowAutomationStatus.STOPPED,
]);

const ACTIVE_AUTOMATION_STATUSES = new Set([
  WorkflowAutomationStatus.VALIDATING,
  WorkflowAutomationStatus.WAITING_TURN,
  WorkflowAutomationStatus.APPLYING,
  WorkflowAutomationStatus.AWAITING_APPROVAL,
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

function automation(status = WorkflowAutomationStatus.IDLE, options = {}) {
  const idle = status === WorkflowAutomationStatus.IDLE;
  return {
    id: idle ? '' : String(options.id || ''),
    status,
    revision: Math.max(0, Number(options.revision) || 0),
    cycle: Math.max(0, Number(options.cycle) || 0),
    maxCycles: Math.max(0, Number(options.maxCycles) || 0),
    startedAt: idle ? '' : timestamp(options.startedAt),
    updatedAt: timestamp(options.updatedAt),
    completedAt: String(options.completedAt || ''),
    threadId: String(options.threadId || ''),
    turnId: String(options.turnId || ''),
    reportDir: String(options.reportDir || ''),
    approvalId: String(options.approvalId || ''),
    error: String(options.error || ''),
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
  const automationStatus = Object.values(WorkflowAutomationStatus).includes(options.automationStatus)
    ? options.automationStatus
    : WorkflowAutomationStatus.IDLE;
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
    automation: automation(automationStatus, {
      id: options.automationId,
      revision: options.automationRevision,
      cycle: options.automationCycle,
      maxCycles: options.automationMaxCycles,
      startedAt: options.automationStartedAt,
      updatedAt: options.automationUpdatedAt || options.updatedAt,
      completedAt: options.automationCompletedAt,
      threadId: options.automationThreadId,
      turnId: options.automationTurnId,
      reportDir: options.automationReportDir,
      approvalId: options.automationApprovalId,
      error: options.automationError,
      evidence: options.automationEvidence,
    }),
    lastOutcome: options.lastOutcome && typeof options.lastOutcome === 'object'
      ? { ...options.lastOutcome }
      : null,
  };
}

export function restoreWorkflowState(saved = {}, options = {}) {
  if (!saved?.watcher || !saved?.pipeline) {
    throw new Error('Workflow state is missing the structured watcher/pipeline snapshot');
  }
  const savedAutomation = saved.automation && typeof saved.automation === 'object'
    ? saved.automation
    : automation(WorkflowAutomationStatus.IDLE, { updatedAt: options.updatedAt });
  return createWorkflowState({
    watcherStatus: saved.watcher.status,
    pipelineStatus: saved.pipeline.status,
    pipelineId: saved.pipeline.id,
    pipelineRevision: saved.pipeline.revision,
    pipelineStartedAt: saved.pipeline.startedAt,
    pipelineTerminal: saved.pipeline.terminal,
    pipelineEvidence: saved.pipeline.evidence,
    approvalId: saved.pipeline.approvalId,
    automationStatus: savedAutomation.status,
    automationId: savedAutomation.id,
    automationRevision: savedAutomation.revision,
    automationCycle: savedAutomation.cycle,
    automationMaxCycles: savedAutomation.maxCycles,
    automationStartedAt: savedAutomation.startedAt,
    automationUpdatedAt: savedAutomation.updatedAt,
    automationCompletedAt: savedAutomation.completedAt,
    automationThreadId: savedAutomation.threadId,
    automationTurnId: savedAutomation.turnId,
    automationReportDir: savedAutomation.reportDir,
    automationApprovalId: savedAutomation.approvalId,
    automationError: savedAutomation.error,
    automationEvidence: savedAutomation.evidence,
    lastOutcome: saved.lastOutcome,
    revision: saved.revision ?? saved.workflowStateRevision,
    updatedAt: saved.pipeline.updatedAt || saved.watcher.updatedAt || options.updatedAt,
  });
}

export function isWorkflowPipelineTerminal(state) {
  return TERMINAL_PIPELINE_STATUSES.has(state?.pipeline?.status);
}

export function isWorkflowPipelineActive(state) {
  return ACTIVE_PIPELINE_STATUSES.has(state?.pipeline?.status);
}

export function isWorkflowAutomationTerminal(state) {
  return TERMINAL_AUTOMATION_STATUSES.has(state?.automation?.status);
}

export function isWorkflowAutomationActive(state) {
  return ACTIVE_AUTOMATION_STATUSES.has(state?.automation?.status);
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
  if (patch.automation) {
    next.automation = {
      ...state.automation,
      ...patch.automation,
      revision: Number(state.automation?.revision || 0) + 1,
      updatedAt: at,
    };
  }
  return { accepted: true, state: next, diagnostics: [] };
}

function reduceAutomationState(state, event, type, data) {
  const automationId = String(data.automationId || state.automation.id || '');
  if (type === WorkflowStateEventType.AUTOMATION_STARTED) {
    if (!automationId) return rejected(state, 'automation_id_required', 'An automation id is required');
    if (isWorkflowAutomationActive(state)) {
      return rejected(state, 'automation_already_active', `Automation ${state.automation.id} is still ${state.automation.status}`);
    }
    return committed(state, event, {
      automation: {
        ...automation(data.status || WorkflowAutomationStatus.VALIDATING, {
          id: automationId,
          cycle: data.cycle,
          maxCycles: data.maxCycles,
          startedAt: event.at,
          updatedAt: event.at,
          threadId: data.threadId,
          evidence: data.evidence,
        }),
        revision: Number(state.automation?.revision || 0),
      },
    });
  }
  if (!automationId || automationId !== state.automation.id) {
    return rejected(state, 'automation_id_mismatch', `Automation ${automationId || '<missing>'} does not match ${state.automation.id || '<none>'}`);
  }
  if (type === WorkflowStateEventType.AUTOMATION_STAGE_CHANGED) {
    if (isWorkflowAutomationTerminal(state)) {
      return rejected(state, 'automation_already_terminal', `Automation ${automationId} is already ${state.automation.status}`);
    }
    const status = String(data.status || '');
    if (!ACTIVE_AUTOMATION_STATUSES.has(status)) return rejected(state, 'invalid_automation_stage', `Invalid active automation stage: ${status}`);
    return committed(state, event, {
      automation: {
        status,
        cycle: data.cycle == null ? state.automation.cycle : Math.max(0, Number(data.cycle) || 0),
        maxCycles: data.maxCycles == null ? state.automation.maxCycles : Math.max(0, Number(data.maxCycles) || 0),
        threadId: String(data.threadId ?? state.automation.threadId ?? ''),
        turnId: String(data.turnId ?? state.automation.turnId ?? ''),
        reportDir: String(data.reportDir ?? state.automation.reportDir ?? ''),
        approvalId: String(data.approvalId ?? state.automation.approvalId ?? ''),
        error: String(data.error || ''),
        evidence: { ...state.automation.evidence, ...(data.evidence || {}) },
      },
    });
  }
  const terminalStatus = type === WorkflowStateEventType.AUTOMATION_COMPLETED
    ? WorkflowAutomationStatus.COMPLETED
    : type === WorkflowStateEventType.AUTOMATION_FAILED
      ? WorkflowAutomationStatus.FAILED
      : type === WorkflowStateEventType.AUTOMATION_STOPPED
        ? WorkflowAutomationStatus.STOPPED
        : '';
  if (!terminalStatus) return null;
  return committed(state, event, {
    automation: {
      status: terminalStatus,
      completedAt: timestamp(event.at),
      error: String(data.error || data.message || ''),
      evidence: { ...state.automation.evidence, ...(data.evidence || {}) },
    },
  });
}

export function reduceWorkflowState(current, event = {}) {
  const state = current || createWorkflowState({ updatedAt: event.at });
  const type = String(event.type || '');
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  if (type.startsWith('automation.')) {
    const result = reduceAutomationState(state, event, type, data);
    return result || rejected(state, 'unknown_workflow_state_event', `Unknown workflow state event: ${type}`);
  }

  const pipelineId = String(data.pipelineId || state.pipeline.id || '');
  if (type === WorkflowStateEventType.WATCHER_STARTED) {
    return committed(state, event, { watcher: { status: WorkflowWatcherStatus.RUNNING } });
  }
  if (type === WorkflowStateEventType.WATCHER_STOPPED) {
    return committed(state, event, { watcher: { status: WorkflowWatcherStatus.STOPPED } });
  }
  if (type === WorkflowStateEventType.PIPELINE_STARTED) {
    if (!pipelineId) return rejected(state, 'pipeline_id_required', 'A pipeline id is required');
    if (isWorkflowPipelineActive(state)) {
      return rejected(state, 'pipeline_already_active', `Pipeline ${state.pipeline.id} is still ${state.pipeline.status}`);
    }
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
