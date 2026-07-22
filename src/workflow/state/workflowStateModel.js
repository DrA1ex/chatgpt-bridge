import { normalizeWorkflowRetryPolicy, workflowEffectRetryMode, workflowLocalEffectRetryMode } from './workflowRetryPolicy.js';
export { workflowEffectRetryMode, workflowLocalEffectRetryMode } from './workflowRetryPolicy.js';

/** Canonical persisted workflow state. No service-owned lifecycle fields exist outside this record. */
export const WORKFLOW_STATE_SCHEMA_VERSION = 3;

export const WorkflowLifecycle = Object.freeze({
  STOPPED: 'stopped',
  READY: 'ready',
  RUNNING: 'running',
  WAITING_ACTION: 'waiting_action',
  RECOVERING: 'recovering',
  PAUSED: 'paused',
});

export const WorkflowPhase = Object.freeze({
  NONE: 'none',
  OBSERVING: 'observing',
  CONTEXT_SYNC: 'context_sync',
  CHECKING: 'checking',
  PROMPTING: 'prompting',
  WAITING_RESPONSE: 'waiting_response',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PLANNING: 'planning',
  APPLYING: 'applying',
  COMMITTING: 'committing',
  REMEDIATING: 'remediating',
  ROLLING_BACK: 'rolling_back',
});

export const WorkflowRunKind = Object.freeze({
  PASSIVE: 'passive',
  AUTOMATION: 'automation',
  GUIDED: 'guided',
  MANUAL: 'manual',
});

export const WorkflowEffectKind = Object.freeze({
  CONTEXT_SYNC: 'context_sync',
  CHECKS: 'checks',
  PROMPT: 'prompt',
  DOWNLOAD: 'download',
  VERIFY: 'verify',
  PLAN: 'plan',
  APPLY: 'apply',
  COMMIT: 'commit',
  ROLLBACK: 'rollback',
  SESSION_HANDOFF: 'session_handoff',
});

export const WorkflowLocalEffectKind = Object.freeze({
  PROJECT_SNAPSHOT: 'project_snapshot',
  CHECKS: 'checks',
  VERIFY: 'verify',
  PLAN: 'plan',
  APPLY: 'apply',
  ROLLBACK: 'rollback',
  COMMIT: 'commit',
  SQUASH: 'squash',
  CLEANUP: 'cleanup',
  EXTENSION_DEPLOY: 'extension_deploy',
});

export const WorkflowEffectStatus = Object.freeze({
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
  CANCELLED: 'cancelled',
});

export const WorkflowActionKind = Object.freeze({
  APPLY: 'apply',
  COMMIT: 'commit',
  FAILED_CHECKS: 'failed_checks',
  SESSION_RECOVERY: 'session_recovery',
  LOCAL_CONFLICT: 'local_conflict',
  NO_PROGRESS: 'no_progress',
  INVALID_RESULT: 'invalid_result',
  RECOVERY: 'recovery',
  REMOTE_TRANSPORT: 'remote_transport',
});

export const WorkflowActionTransition = Object.freeze({
  CONTINUE: 'continue',
  RECOVER: 'recover',
  FINISH: 'finish',
  STOP: 'stop',
});

export const WorkflowEventType = Object.freeze({
  COMMAND_ACCEPTED: 'command.accepted',
  ACTIVATED: 'workflow.activated',
  DEACTIVATED: 'workflow.deactivated',
  BINDING_CHANGED: 'workflow.binding_changed',
  GIT_STATE_UPDATED: 'workflow.git_state_updated',
  INPUT_ENQUEUED: 'input.enqueued',
  INPUT_DISCARDED: 'input.discarded',
  RUN_STARTED: 'run.started',
  PHASE_CHANGED: 'run.phase_changed',
  EFFECT_PLANNED: 'effect.planned',
  EFFECT_DISPATCHED: 'effect.dispatched',
  EFFECT_RETRY_PLANNED: 'effect.retry_planned',
  EFFECT_SUCCEEDED: 'effect.succeeded',
  EFFECT_FAILED: 'effect.failed',
  EFFECT_UNCERTAIN: 'effect.uncertain',
  EFFECT_CANCELLED: 'effect.cancelled',
  LOCAL_EFFECT_PLANNED: 'local_effect.planned',
  LOCAL_EFFECT_DISPATCHED: 'local_effect.dispatched',
  LOCAL_EFFECT_RETRY_PLANNED: 'local_effect.retry_planned',
  LOCAL_EFFECT_SUCCEEDED: 'local_effect.succeeded',
  LOCAL_EFFECT_FAILED: 'local_effect.failed',
  LOCAL_EFFECT_UNCERTAIN: 'local_effect.uncertain',
  LOCAL_EFFECT_CANCELLED: 'local_effect.cancelled',
  LOCAL_EFFECT_RECONCILED: 'local_effect.reconciled',
  ACTION_REQUIRED: 'action.required',
  ACTION_RESOLVED: 'action.resolved',
  ACTION_EXPIRED: 'action.expired',
  RECOVERY_STARTED: 'recovery.started',
  RECOVERY_RESUMED: 'recovery.resumed',
  PAUSE_REQUESTED: 'workflow.pause_requested',
  PAUSED: 'workflow.paused',
  RESUMED: 'workflow.resumed',
  STOP_REQUESTED: 'workflow.stop_requested',
  STOPPED: 'workflow.stopped',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',
});

export const ACTIVE_LIFECYCLES = new Set([
  WorkflowLifecycle.RUNNING,
  WorkflowLifecycle.WAITING_ACTION,
  WorkflowLifecycle.RECOVERING,
  WorkflowLifecycle.PAUSED,
]);
export const RUN_RESULT_LIFECYCLES = new Set([WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING]);
export const ACTIVE_PHASES = new Set(Object.values(WorkflowPhase).filter((phase) => phase !== WorkflowPhase.NONE));
export const TERMINAL_EFFECTS = new Set([
  WorkflowEffectStatus.SUCCEEDED,
  WorkflowEffectStatus.FAILED,
  WorkflowEffectStatus.UNCERTAIN,
  WorkflowEffectStatus.CANCELLED,
]);
const MAX_SEEN_IDS = 512;
const DEFAULT_QUEUE_LIMIT = 100;

export function asText(value = '') { return String(value || '').trim(); }
export function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {}; }
export function asTime(value = '') { return asText(value) || new Date().toISOString(); }
export function asCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
export function bounded(items, limit = MAX_SEEN_IDS) { return items.slice(-limit); }

export function emptyWorkflowRun() {
  return {
    id: '',
    inputId: '',
    kind: '',
    phase: WorkflowPhase.NONE,
    startedAt: '',
    updatedAt: '',
    source: { clientId: '', sessionId: '' },
    request: { requestId: '', turnId: '', turnKey: '' },
    artifact: { id: '', fileId: '', key: '' },
    cycle: 0,
    maxCycles: 0,
    references: {},
  };
}

export function normalizeRun(data, at, input = null) {
  const phase = asText(data.phase || WorkflowPhase.OBSERVING);
  return {
    ...emptyWorkflowRun(),
    id: asText(data.runId),
    inputId: asText(input?.id || data.inputId),
    kind: Object.values(WorkflowRunKind).includes(data.kind) ? data.kind : WorkflowRunKind.MANUAL,
    phase: ACTIVE_PHASES.has(phase) ? phase : WorkflowPhase.OBSERVING,
    startedAt: at,
    updatedAt: at,
    source: {
      clientId: asText(data.source?.clientId || data.clientId || input?.source?.clientId),
      sessionId: asText(data.source?.sessionId || data.sessionId || input?.source?.sessionId),
    },
    request: {
      requestId: asText(data.request?.requestId || data.requestId || input?.references?.requestId),
      turnId: asText(data.request?.turnId || data.turnId || input?.references?.turnId),
      turnKey: asText(data.request?.turnKey || data.turnKey || input?.references?.turnKey),
    },
    artifact: {
      id: asText(data.artifact?.id || data.artifactId),
      fileId: asText(data.artifact?.fileId || data.fileId),
      key: asText(data.artifact?.key || data.artifactKey),
    },
    cycle: asCount(data.cycle),
    maxCycles: asCount(data.maxCycles),
    references: { ...asRecord(input?.references), ...(input?.payload ? { inputPayload: asRecord(input.payload) } : {}), ...asRecord(data.references) },
  };
}

export function normalizeInput(data, at) {
  return {
    id: asText(data.inputId || data.id),
    kind: asText(data.kind || 'observed_turn'),
    deduplicationKey: asText(data.deduplicationKey || data.turnKey || data.inputId || data.id),
    source: { clientId: asText(data.source?.clientId || data.clientId), sessionId: asText(data.source?.sessionId || data.sessionId) },
    bindingEpoch: asCount(data.bindingEpoch),
    observation: { streamEpoch: asText(data.observation?.streamEpoch || data.streamEpoch), sequence: asCount(data.observation?.sequence || data.sequence), revision: asCount(data.observation?.revision || data.observationRevision) },
    projectFingerprintSha256: asText(data.projectFingerprintSha256),
    observedAt: asTime(data.observedAt || at),
    references: asRecord(data.references),
    payload: asRecord(data.payload),
  };
}

export function normalizeGitState(value = {}) {
  const source = asRecord(value);
  return {
    baseSha: asText(source.baseSha),
    checkpointShas: Array.isArray(source.checkpointShas) ? source.checkpointShas.map(asText).filter(Boolean) : [],
    ownedPaths: Array.isArray(source.ownedPaths) ? Array.from(new Set(source.ownedPaths.map(asText).filter(Boolean))).sort() : [],
    pathStates: asRecord(source.pathStates),
    lastCommitMessage: asText(source.lastCommitMessage),
  };
}

export function nextBinding(current, update = {}) {
  const clientId = asText(update.clientId || current.clientId);
  const sessionId = asText(update.sessionId || current.sessionId);
  const changed = clientId !== current.clientId || sessionId !== current.sessionId;
  return { clientId, sessionId, epoch: changed ? Math.max(1, asCount(current.epoch) + 1) : asCount(current.epoch) };
}

function inferredTransition(choiceId) {
  if (choiceId === 'stop') return WorkflowActionTransition.STOP;
  if (choiceId === 'recover' || choiceId === 'retry') return WorkflowActionTransition.RECOVER;
  if (choiceId === 'reject' || choiceId === 'cancel') return WorkflowActionTransition.FINISH;
  return WorkflowActionTransition.CONTINUE;
}

function normalizeChoice(value) {
  const source = typeof value === 'string' ? { id: value } : asRecord(value);
  const id = asText(source.id);
  const transition = Object.values(WorkflowActionTransition).includes(source.transition)
    ? source.transition
    : inferredTransition(id);
  return {
    id,
    label: asText(source.label || id),
    transition,
    phase: asText(source.phase),
    outcome: asRecord(source.outcome),
  };
}

export function normalizeAction(data, at, runId) {
  const choices = Array.isArray(data.choices) ? data.choices.map(normalizeChoice).filter((choice) => choice.id) : [];
  return {
    id: asText(data.actionId || data.id),
    kind: asText(data.kind),
    runId,
    reason: asText(data.reason || data.message),
    choices,
    references: asRecord(data.references),
    createdAt: at,
    expiresAt: asText(data.expiresAt),
    defaultOnExpiry: asText(data.defaultOnExpiry),
    safeContinuation: asText(data.safeContinuation),
  };
}

export function createWorkflowState(options = {}) {
  const now = asTime(options.updatedAt || options.timestamps?.updatedAt);
  const lifecycle = Object.values(WorkflowLifecycle).includes(options.lifecycle) ? options.lifecycle : WorkflowLifecycle.STOPPED;
  const run = { ...emptyWorkflowRun(), ...asRecord(options.run) };
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    revision: asCount(options.revision),
    lifecycle,
    subscription: { enabled: Boolean(options.subscription?.enabled ?? options.observing) },
    project: {
      id: asText(options.project?.id || options.projectId),
      root: asText(options.project?.root || options.projectRoot),
      fingerprintSha256: asText(options.project?.fingerprintSha256 || options.projectFingerprintSha256),
    },
    binding: {
      clientId: asText(options.binding?.clientId),
      sessionId: asText(options.binding?.sessionId),
      epoch: Math.max(0, asCount(options.binding?.epoch, (options.binding?.clientId || options.binding?.sessionId) ? 1 : 0)),
    },
    git: normalizeGitState(options.git),
    run,
    inputs: Array.isArray(options.inputs) ? structuredClone(options.inputs).slice(0, asCount(options.queueLimit, DEFAULT_QUEUE_LIMIT)) : [],
    inputHistory: bounded(Array.isArray(options.inputHistory) ? options.inputHistory.map(asText).filter(Boolean) : []),
    queueLimit: Math.max(1, asCount(options.queueLimit, DEFAULT_QUEUE_LIMIT)),
    effects: asRecord(options.effects),
    localEffects: asRecord(options.localEffects),
    retries: asRecord(options.retries),
    retryPolicy: normalizeWorkflowRetryPolicy(options.retryPolicy),
    nextAction: options.nextAction ? asRecord(options.nextAction) : null,
    control: {
      stopRequested: Boolean(options.control?.stopRequested),
      stopRequestedAt: asText(options.control?.stopRequestedAt),
      stopReason: asText(options.control?.stopReason),
      pauseRequested: Boolean(options.control?.pauseRequested),
      pauseRequestedAt: asText(options.control?.pauseRequestedAt),
      pauseReason: asText(options.control?.pauseReason),
      pauseResumeLifecycle: asText(options.control?.pauseResumeLifecycle),
      pauseSuspendedAction: options.control?.pauseSuspendedAction ? asRecord(options.control.pauseSuspendedAction) : null,
    },
    pause: options.pause ? asRecord(options.pause) : null,
    lastOutcome: options.lastOutcome ? asRecord(options.lastOutcome) : null,
    seenEventIds: bounded(Array.isArray(options.seenEventIds) ? options.seenEventIds.map(asText).filter(Boolean) : []),
    seenCommandIds: bounded(Array.isArray(options.seenCommandIds) ? options.seenCommandIds.map(asText).filter(Boolean) : []),
    timestamps: {
      createdAt: asTime(options.createdAt || options.timestamps?.createdAt || now),
      updatedAt: now,
      transitionedAt: asTime(options.timestamps?.transitionedAt || now),
    },
  };
}

export function isWorkflowActive(state) { return ACTIVE_LIFECYCLES.has(state?.lifecycle); }
export function isWorkflowRunning(state) { return state?.lifecycle === WorkflowLifecycle.RUNNING; }
export function workflowPhase(state) { return asText(state?.run?.phase || WorkflowPhase.NONE); }
export function workflowAction(state) { return state?.nextAction || null; }
export function restoreWorkflowState(saved = {}, options = {}) {
  const source = saved.execution && typeof saved.execution === 'object' ? saved.execution : saved;
  if (Number(source.schemaVersion) !== WORKFLOW_STATE_SCHEMA_VERSION) throw new Error(`Workflow state must use schema v${WORKFLOW_STATE_SCHEMA_VERSION}`);
  return createWorkflowState({ ...source, updatedAt: options.updatedAt || source.timestamps?.updatedAt });
}

export function rejected(state, code, message) {
  return { accepted: false, state, diagnostics: [{ code, message }] };
}

export function invariantError(state) {
  const active = ACTIVE_LIFECYCLES.has(state.lifecycle);
  if (active && !asText(state.run?.id)) return 'Active workflow lifecycle requires an active run';
  if (!active && asText(state.run?.id)) return `${state.lifecycle} workflow cannot retain an active run`;
  if (active && !ACTIVE_PHASES.has(state.run?.phase)) return 'Active run requires a valid phase';
  if (!active && state.run?.phase !== WorkflowPhase.NONE) return 'Inactive workflow must use the none phase';
  if (state.lifecycle === WorkflowLifecycle.WAITING_ACTION && !state.nextAction) return 'waiting_action requires nextAction';
  if (state.lifecycle !== WorkflowLifecycle.WAITING_ACTION && state.nextAction) return 'nextAction is only valid while waiting_action';
  if (state.lifecycle === WorkflowLifecycle.PAUSED && !state.pause?.resumeLifecycle) return 'paused workflow requires resumeLifecycle';
  if (state.lifecycle !== WorkflowLifecycle.PAUSED && state.pause) return 'pause metadata is only valid while paused';
  if (state.lifecycle === WorkflowLifecycle.STOPPED && state.control?.stopRequested) return 'Stopped workflow cannot retain a pending stop request';
  if (state.lifecycle === WorkflowLifecycle.STOPPED && state.control?.pauseRequested) return 'Stopped workflow cannot retain a pending pause request';
  if (state.lifecycle === WorkflowLifecycle.PAUSED && state.control?.pauseRequested) return 'Paused workflow cannot retain a pending pause request';
  if (state.control?.pauseRequested && !ACTIVE_LIFECYCLES.has(state.lifecycle)) return 'Pause request requires an active workflow';
  return '';
}

export function committed(state, event, patch) {
  const at = asTime(event.at);
  const next = {
    ...state,
    ...patch,
    revision: state.revision + 1,
    seenEventIds: bounded([...state.seenEventIds, asText(event.eventId)]),
    timestamps: { ...state.timestamps, updatedAt: at, transitionedAt: at },
  };
  const error = invariantError(next);
  return error ? rejected(state, 'workflow_invariant_failed', error) : { accepted: true, state: next, diagnostics: [] };
}

export function currentRunMismatch(state, data) {
  const runId = asText(data.runId);
  if (!runId) return rejected(state, 'run_id_required', 'runId is required');
  return runId === state.run.id ? null : rejected(state, 'run_id_mismatch', `Run ${runId} does not match ${state.run.id || '<none>'}`);
}

export function unsettledEffectRecords(state) {
  const records = [...Object.values(state.effects || {}), ...Object.values(state.localEffects || {})];
  return records.filter((effect) => effect && [
    WorkflowEffectStatus.PLANNED,
    WorkflowEffectStatus.DISPATCHED,
    WorkflowEffectStatus.UNCERTAIN,
  ].includes(effect.status));
}

export function cancelPlannedEffects(records = {}, at, reason = 'workflow control request') {
  const next = {};
  for (const [id, effect] of Object.entries(records || {})) {
    next[id] = effect?.status === WorkflowEffectStatus.PLANNED
      ? { ...effect, status: WorkflowEffectStatus.CANCELLED, updatedAt: at, error: `Cancelled before dispatch by ${reason}` }
      : effect;
  }
  return next;
}

export function terminalOutcome(state, data, status, at) {
  return {
    runId: state.run.id,
    status,
    code: asText(data.code || status),
    message: asText(data.message),
    evidence: asRecord(data.evidence),
    at,
  };
}

export function finishRun(state, event, data, status) {
  if (!RUN_RESULT_LIFECYCLES.has(state.lifecycle)) return rejected(state, 'run_result_not_allowed', `Cannot finish a run while ${state.lifecycle}`);
  const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
  const at = asTime(event.at);
  return committed(state, event, {
    lifecycle: WorkflowLifecycle.READY,
    run: emptyWorkflowRun(),
    nextAction: null,
    pause: null,
    lastOutcome: terminalOutcome(state, data, status, at),
    control: { stopRequested: false, stopRequestedAt: '', stopReason: '', pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null },
  });
}

export function resolveAction(state, event, data, action) {
  const choiceId = asText(data.choice);
  const choice = action.choices.find((item) => item.id === choiceId);
  if (!choice) return rejected(state, 'action_choice_invalid', `Action choice is not allowed: ${choiceId || '<missing>'}`);
  if (choice.transition === WorkflowActionTransition.STOP) {
    const unsettled = unsettledEffectRecords(state);
    if (unsettled.length) {
      return committed(state, event, {
        lifecycle: WorkflowLifecycle.RECOVERING,
        subscription: { enabled: false },
        nextAction: null,
        effects: cancelPlannedEffects(state.effects, asTime(event.at), 'workflow stop action'),
        localEffects: cancelPlannedEffects(state.localEffects, asTime(event.at), 'workflow stop action'),
        control: { stopRequested: true, stopRequestedAt: asTime(event.at), stopReason: asText(choice.outcome.message || 'stopped by action'), pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null },
      });
    }
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, subscription: { enabled: false }, run: emptyWorkflowRun(), nextAction: null, pause: null, control: { stopRequested: false, stopRequestedAt: '', stopReason: '', pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null }, lastOutcome: terminalOutcome(state, choice.outcome, 'cancelled', asTime(event.at)) });
  }
  if (choice.transition === WorkflowActionTransition.FINISH) {
    const status = asText(choice.outcome.status || 'cancelled');
    return committed(state, event, { lifecycle: WorkflowLifecycle.READY, run: emptyWorkflowRun(), nextAction: null, pause: null, lastOutcome: terminalOutcome(state, choice.outcome, status, asTime(event.at)) });
  }
  const lifecycle = choice.transition === WorkflowActionTransition.RECOVER ? WorkflowLifecycle.RECOVERING : WorkflowLifecycle.RUNNING;
  const phase = choice.phase || state.run.phase;
  if (!ACTIVE_PHASES.has(phase)) return rejected(state, 'phase_invalid', `Invalid continuation phase: ${phase}`);
  return committed(state, event, { lifecycle, nextAction: null, run: { ...state.run, phase, updatedAt: asTime(event.at) } });
}

export function publicWorkflowState(state) {
  if (Number(state?.schemaVersion) !== WORKFLOW_STATE_SCHEMA_VERSION) throw new Error(`Workflow state must use schema v${WORKFLOW_STATE_SCHEMA_VERSION}`);
  return structuredClone(state);
}
