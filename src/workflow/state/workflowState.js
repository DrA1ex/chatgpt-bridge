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

const ACTIVE_LIFECYCLES = new Set([
  WorkflowLifecycle.RUNNING,
  WorkflowLifecycle.WAITING_ACTION,
  WorkflowLifecycle.RECOVERING,
  WorkflowLifecycle.PAUSED,
]);
const RUN_RESULT_LIFECYCLES = new Set([WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING]);
const ACTIVE_PHASES = new Set(Object.values(WorkflowPhase).filter((phase) => phase !== WorkflowPhase.NONE));
const TERMINAL_EFFECTS = new Set([
  WorkflowEffectStatus.SUCCEEDED,
  WorkflowEffectStatus.FAILED,
  WorkflowEffectStatus.UNCERTAIN,
  WorkflowEffectStatus.CANCELLED,
]);
const RETRY_POLICIES = new Set(['never', 'if_unconfirmed', 'always']);
const MAX_SEEN_IDS = 512;
const DEFAULT_QUEUE_LIMIT = 100;

function asText(value = '') { return String(value || '').trim(); }
function asRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {}; }
function asTime(value = '') { return asText(value) || new Date().toISOString(); }
function asCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}
function bounded(items, limit = MAX_SEEN_IDS) { return items.slice(-limit); }

function normalizeRetryPolicy(value = {}) {
  const policy = (item, fallback = 'never') => RETRY_POLICIES.has(item) ? item : fallback;
  return {
    safeLimit: asCount(value.safeLimit, 3),
    prompt: policy(value.prompt),
    steering: policy(value.steering),
    attachment: policy(value.attachment, 'if_unconfirmed'),
    artifact: policy(value.artifact, 'if_unconfirmed'),
    checks: policy(value.checks, 'always'),
    apply: policy(value.apply),
    rollback: policy(value.rollback, 'if_unconfirmed'),
    commit: policy(value.commit, 'if_unconfirmed'),
    squash: policy(value.squash),
    sessionHandoff: policy(value.sessionHandoff),
  };
}

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

function normalizeRun(data, at, input = null) {
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

function normalizeInput(data, at) {
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


function normalizeGitState(value = {}) {
  const source = asRecord(value);
  return {
    baseSha: asText(source.baseSha),
    checkpointShas: Array.isArray(source.checkpointShas) ? source.checkpointShas.map(asText).filter(Boolean) : [],
    ownedPaths: Array.isArray(source.ownedPaths) ? Array.from(new Set(source.ownedPaths.map(asText).filter(Boolean))).sort() : [],
    pathStates: asRecord(source.pathStates),
    lastCommitMessage: asText(source.lastCommitMessage),
  };
}

function nextBinding(current, update = {}) {
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

function normalizeAction(data, at, runId) {
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
    retryPolicy: normalizeRetryPolicy(options.retryPolicy),
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
export function workflowEffectRetryMode(state, effectKind) {
  const kind = asText(effectKind);
  const aliases = {
    prompt: 'prompt',
    steering: 'steering',
    attachment: 'attachment',
    download: 'artifact',
    verify: 'artifact',
    checks: 'checks',
    apply: 'apply',
    rollback: 'rollback',
    commit: 'commit',
    squash: 'squash',
    context_sync: 'sessionHandoff',
    session_handoff: 'sessionHandoff',
  };
  const short = kind.replace(/^.*\./, '');
  const key = aliases[kind] || aliases[short] || short;
  return state?.retryPolicy?.[key] || 'never';
}

export function workflowLocalEffectRetryMode(state, effectKind) {
  const key = asText(effectKind);
  if ([WorkflowLocalEffectKind.PROJECT_SNAPSHOT, WorkflowLocalEffectKind.VERIFY, WorkflowLocalEffectKind.PLAN].includes(key)) return 'always';
  if (key === WorkflowLocalEffectKind.CHECKS) return state?.retryPolicy?.checks || 'always';
  if (key === WorkflowLocalEffectKind.APPLY) return state?.retryPolicy?.apply || 'never';
  if (key === WorkflowLocalEffectKind.SQUASH) return state?.retryPolicy?.squash || 'never';
  if (key === WorkflowLocalEffectKind.COMMIT) return state?.retryPolicy?.commit || 'if_unconfirmed';
  if (key === WorkflowLocalEffectKind.ROLLBACK) return state?.retryPolicy?.rollback || 'if_unconfirmed';
  return 'never';
}

export function restoreWorkflowState(saved = {}, options = {}) {
  const source = saved.execution && typeof saved.execution === 'object' ? saved.execution : saved;
  if (Number(source.schemaVersion) !== WORKFLOW_STATE_SCHEMA_VERSION) throw new Error(`Workflow state must use schema v${WORKFLOW_STATE_SCHEMA_VERSION}`);
  return createWorkflowState({ ...source, updatedAt: options.updatedAt || source.timestamps?.updatedAt });
}

function rejected(state, code, message) {
  return { accepted: false, state, diagnostics: [{ code, message }] };
}

function invariantError(state) {
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

function committed(state, event, patch) {
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

function currentRunMismatch(state, data) {
  const runId = asText(data.runId);
  if (!runId) return rejected(state, 'run_id_required', 'runId is required');
  return runId === state.run.id ? null : rejected(state, 'run_id_mismatch', `Run ${runId} does not match ${state.run.id || '<none>'}`);
}


function unsettledEffectRecords(state) {
  const records = [...Object.values(state.effects || {}), ...Object.values(state.localEffects || {})];
  return records.filter((effect) => effect && [
    WorkflowEffectStatus.PLANNED,
    WorkflowEffectStatus.DISPATCHED,
    WorkflowEffectStatus.UNCERTAIN,
  ].includes(effect.status));
}

function cancelPlannedEffects(records = {}, at, reason = 'workflow control request') {
  const next = {};
  for (const [id, effect] of Object.entries(records || {})) {
    next[id] = effect?.status === WorkflowEffectStatus.PLANNED
      ? { ...effect, status: WorkflowEffectStatus.CANCELLED, updatedAt: at, error: `Cancelled before dispatch by ${reason}` }
      : effect;
  }
  return next;
}

function terminalOutcome(state, data, status, at) {
  return {
    runId: state.run.id,
    status,
    code: asText(data.code || status),
    message: asText(data.message),
    evidence: asRecord(data.evidence),
    at,
  };
}

function finishRun(state, event, data, status) {
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

function resolveAction(state, event, data, action) {
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

export function reduceWorkflowState(current, event = {}) {
  const state = current || createWorkflowState({ updatedAt: event.at });
  if (state.schemaVersion !== WORKFLOW_STATE_SCHEMA_VERSION) return rejected(state, 'workflow_schema_unsupported', `Workflow schema ${state.schemaVersion} is not v${WORKFLOW_STATE_SCHEMA_VERSION}`);
  const initialError = invariantError(state);
  if (initialError) return rejected(state, 'workflow_state_invalid', initialError);
  const eventId = asText(event.eventId);
  if (!eventId) return rejected(state, 'event_id_required', 'Every workflow event requires eventId');
  if (state.seenEventIds.includes(eventId)) return rejected(state, 'event_duplicate', `Event ${eventId} was already handled`);
  if (event.expectedRevision != null && Number(event.expectedRevision) !== state.revision) return rejected(state, 'revision_mismatch', `Expected revision ${event.expectedRevision}, current revision is ${state.revision}`);
  const type = asText(event.type);
  const data = asRecord(event.data);
  const at = asTime(event.at);

  if (type === WorkflowEventType.COMMAND_ACCEPTED) {
    const commandId = asText(data.commandId);
    if (!commandId) return rejected(state, 'command_id_required', 'commandId is required');
    if (state.seenCommandIds.includes(commandId)) return rejected(state, 'command_duplicate', `Command ${commandId} was already accepted`);
    return committed(state, event, { seenCommandIds: bounded([...state.seenCommandIds, commandId]) });
  }

  if (type === WorkflowEventType.ACTIVATED) {
    if (state.lifecycle !== WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_not_activatable', `Cannot activate workflow while ${state.lifecycle}`);
    return committed(state, event, { lifecycle: WorkflowLifecycle.READY, subscription: { enabled: data.subscriptionEnabled !== false }, binding: nextBinding(state.binding, data), control: { stopRequested: false, stopRequestedAt: '', stopReason: '', pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null } });
  }
  if (type === WorkflowEventType.DEACTIVATED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_already_stopped', 'Workflow is already stopped');
    if (isWorkflowActive(state)) return rejected(state, 'workflow_active', 'Deactivate cannot discard an active run; use stop');
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, subscription: { enabled: false }, inputs: [], inputHistory: bounded([...state.inputHistory, ...state.inputs.map((item) => item.deduplicationKey)]) });
  }
  if (type === WorkflowEventType.GIT_STATE_UPDATED) {
    if (!isWorkflowActive(state)) return rejected(state, 'git_state_not_allowed', `Cannot update workflow Git state while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const mode = asText(data.mode || 'merge');
    if (!['merge', 'replace', 'clear'].includes(mode)) return rejected(state, 'git_state_mode_invalid', `Unknown Git state update mode: ${mode || '<missing>'}`);
    if (mode === 'clear') {
      return committed(state, event, { git: normalizeGitState({ baseSha: data.baseSha ?? state.git?.baseSha }) });
    }
    const incoming = normalizeGitState(data.git || data);
    if (mode === 'replace') return committed(state, event, { git: incoming });
    const currentGit = normalizeGitState(state.git);
    return committed(state, event, { git: {
      baseSha: currentGit.baseSha || incoming.baseSha,
      checkpointShas: [...currentGit.checkpointShas, ...incoming.checkpointShas.filter((sha) => !currentGit.checkpointShas.includes(sha))],
      ownedPaths: Array.from(new Set([...currentGit.ownedPaths, ...incoming.ownedPaths])).sort(),
      pathStates: { ...currentGit.pathStates, ...incoming.pathStates },
      lastCommitMessage: incoming.lastCommitMessage || currentGit.lastCommitMessage,
    } });
  }
  if (type === WorkflowEventType.BINDING_CHANGED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'binding_change_not_allowed', 'Stopped workflow cannot change binding');
    const binding = nextBinding(state.binding, data);
    if (binding.clientId === state.binding.clientId && binding.sessionId === state.binding.sessionId) return rejected(state, 'binding_unchanged', 'Workflow binding did not change');
    const preserveInputs = data.preserveInputs === true;
    const retainedInputs = preserveInputs
      ? state.inputs.filter((item) => item.bindingEpoch === binding.epoch)
      : [];
    const discardedInputs = state.inputs.filter((item) => !retainedInputs.includes(item));
    const run = isWorkflowActive(state)
      ? {
          ...state.run,
          source: { clientId: binding.clientId, sessionId: binding.sessionId },
          references: { ...state.run.references, bindingEpoch: binding.epoch },
          updatedAt: at,
        }
      : state.run;
    return committed(state, event, {
      binding,
      run,
      inputs: retainedInputs,
      inputHistory: bounded([...state.inputHistory, ...discardedInputs.map((item) => item.deduplicationKey)]),
    });
  }
  if (type === WorkflowEventType.STOP_REQUESTED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_already_stopped', 'Workflow is already stopped');
    if (state.control?.stopRequested) return rejected(state, 'workflow_stop_already_requested', 'Workflow stop is already pending');
    return committed(state, event, {
      subscription: { enabled: false },
      nextAction: null,
      effects: cancelPlannedEffects(state.effects, at, 'workflow stop request'),
      localEffects: cancelPlannedEffects(state.localEffects, at, 'workflow stop request'),
      control: { stopRequested: true, stopRequestedAt: at, stopReason: asText(data.reason || 'stopped by user'), pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null },
    });
  }
  if (type === WorkflowEventType.STOPPED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_already_stopped', 'Workflow is already stopped');
    if (isWorkflowActive(state) && !state.control?.stopRequested) return rejected(state, 'workflow_stop_not_requested', 'Active workflow must commit stopRequested before stopping');
    const unsettled = unsettledEffectRecords(state);
    if (unsettled.length) return rejected(state, 'workflow_stop_barrier_pending', `Cannot stop while effects remain unsettled: ${unsettled.map((effect) => `${effect.kind}:${effect.id}:${effect.status}`).join(', ')}`);
    const lastOutcome = isWorkflowActive(state)
      ? terminalOutcome(state, { code: 'stopped', message: data.reason || state.control?.stopReason, evidence: { stopped: true, stopRequestedAt: state.control?.stopRequestedAt || '' } }, 'cancelled', at)
      : state.lastOutcome;
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, subscription: { enabled: false }, run: emptyWorkflowRun(), nextAction: null, pause: null, control: { stopRequested: false, stopRequestedAt: '', stopReason: '', pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null }, inputs: [], inputHistory: bounded([...state.inputHistory, ...state.inputs.map((item) => item.deduplicationKey)]), lastOutcome });
  }
  if (type === WorkflowEventType.INPUT_ENQUEUED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'input_not_allowed', 'Stopped workflow does not accept observed inputs');
    const input = normalizeInput(data, at);
    if (!input.id || !input.deduplicationKey) return rejected(state, 'input_invalid', 'Input id and deduplication key are required');
    if (input.bindingEpoch && input.bindingEpoch !== state.binding.epoch) return rejected(state, 'input_binding_stale', `Input binding epoch ${input.bindingEpoch} does not match ${state.binding.epoch}`);
    if (input.projectFingerprintSha256 && state.project.fingerprintSha256 && input.projectFingerprintSha256 !== state.project.fingerprintSha256) return rejected(state, 'input_project_stale', 'Input project fingerprint does not match the active project');
    if (state.inputs.length >= state.queueLimit) return rejected(state, 'input_queue_full', `Input queue limit ${state.queueLimit} reached`);
    if (state.inputs.some((item) => item.id === input.id || item.deduplicationKey === input.deduplicationKey) || state.inputHistory.includes(input.deduplicationKey)) return rejected(state, 'input_duplicate', `Input ${input.deduplicationKey} was already queued or consumed`);
    return committed(state, event, { inputs: [...state.inputs, input] });
  }
  if (type === WorkflowEventType.INPUT_DISCARDED) {
    const inputId = asText(data.inputId);
    const index = state.inputs.findIndex((item) => item.id === inputId);
    if (index < 0) return rejected(state, 'input_missing', `Unknown queued input ${inputId || '<missing>'}`);
    const input = state.inputs[index];
    return committed(state, event, { inputs: state.inputs.filter((_, itemIndex) => itemIndex !== index), inputHistory: bounded([...state.inputHistory, input.deduplicationKey]) });
  }
  if (type === WorkflowEventType.RUN_STARTED) {
    if (state.lifecycle !== WorkflowLifecycle.READY) return rejected(state, 'workflow_not_ready', `Cannot start a run while ${state.lifecycle}`);
    if (!asText(data.runId)) return rejected(state, 'run_id_required', 'runId is required');
    let inputs = state.inputs;
    let input = null;
    let inputHistory = state.inputHistory;
    if (data.inputId) {
      input = state.inputs[0];
      if (!input || input.id !== asText(data.inputId)) return rejected(state, 'input_order_mismatch', 'Runs must consume the oldest queued input');
      if (input.bindingEpoch && input.bindingEpoch !== state.binding.epoch) return rejected(state, 'input_binding_stale', `Input binding epoch ${input.bindingEpoch} does not match ${state.binding.epoch}`);
      inputs = state.inputs.slice(1);
      inputHistory = bounded([...state.inputHistory, input.deduplicationKey]);
    }
    const run = normalizeRun(data, at, input);
    return committed(state, event, { lifecycle: WorkflowLifecycle.RUNNING, binding: nextBinding(state.binding, run.source), run, inputs, inputHistory, lastOutcome: null, control: { stopRequested: false, stopRequestedAt: '', stopReason: '', pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null } });
  }
  if (type === WorkflowEventType.PHASE_CHANGED) {
    if (state.lifecycle !== WorkflowLifecycle.RUNNING) return rejected(state, 'workflow_not_running', `Cannot change phase while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const phase = asText(data.phase);
    if (!ACTIVE_PHASES.has(phase)) return rejected(state, 'phase_invalid', `Invalid workflow phase: ${phase || '<missing>'}`);
    return committed(state, event, { run: { ...state.run, phase, updatedAt: at, source: { ...state.run.source, ...asRecord(data.source) }, request: { ...state.run.request, ...asRecord(data.request) }, artifact: { ...state.run.artifact, ...asRecord(data.artifact) }, references: { ...state.run.references, ...asRecord(data.references) } } });
  }
  if (type === WorkflowEventType.EFFECT_PLANNED) {
    if (state.control?.pauseRequested || state.control?.stopRequested) return rejected(state, 'effect_blocked_by_control', 'Cannot plan an effect while pause or stop is pending');
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'effect_not_allowed', `Cannot plan an effect while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const id = asText(data.effectId); const kind = asText(data.kind);
    if (!id || !Object.values(WorkflowEffectKind).includes(kind)) return rejected(state, 'effect_invalid', 'Effect id and known kind are required');
    if (state.effects[id]) return rejected(state, 'effect_duplicate', `Effect ${id} already exists`);
    const effect = { id, runId: state.run.id, kind, status: WorkflowEffectStatus.PLANNED, safe: data.safe === true, idempotencyKey: asText(data.idempotencyKey), preconditionsHash: asText(data.preconditionsHash), attempt: 0, policy: asText(data.policy || workflowEffectRetryMode(state, kind)), createdAt: at, updatedAt: at, references: asRecord(data.references), result: {}, error: '' };
    if (!effect.idempotencyKey || !effect.preconditionsHash) return rejected(state, 'effect_contract_invalid', 'Effect idempotencyKey and preconditionsHash are required');
    return committed(state, event, { effects: { ...state.effects, [id]: effect } });
  }
  if (type === WorkflowEventType.EFFECT_DISPATCHED) {
    const id = asText(data.effectId); const effect = state.effects[id];
    if (!effect) return rejected(state, 'effect_missing', `Unknown effect ${id || '<missing>'}`);
    if (effect.runId !== state.run.id || ![WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'effect_stale', `Effect ${id} does not belong to the active run`);
    if (effect.status !== WorkflowEffectStatus.PLANNED) return rejected(state, 'effect_not_planned', `Effect ${id} is ${effect.status}`);
    const attempt = effect.attempt + 1;
    return committed(state, event, { effects: { ...state.effects, [id]: { ...effect, status: WorkflowEffectStatus.DISPATCHED, attempt, dispatchedAt: at, updatedAt: at } } });
  }
  if (type === WorkflowEventType.EFFECT_RETRY_PLANNED) {
    const id = asText(data.effectId); const effect = state.effects[id];
    if (!effect) return rejected(state, 'effect_missing', `Unknown effect ${id || '<missing>'}`);
    if (state.lifecycle !== WorkflowLifecycle.RECOVERING || effect.runId !== state.run.id) return rejected(state, 'effect_retry_not_allowed', `Effect ${id} cannot be retried now`);
    if (![WorkflowEffectStatus.FAILED, WorkflowEffectStatus.UNCERTAIN, WorkflowEffectStatus.DISPATCHED].includes(effect.status)) return rejected(state, 'effect_retry_not_allowed', `Effect ${id} is ${effect.status}`);
    const policyAllows = effect.safe ? effect.attempt < state.retryPolicy.safeLimit : effect.policy === 'always' || (effect.policy === 'if_unconfirmed' && effect.status !== WorkflowEffectStatus.UNCERTAIN && effect.status !== WorkflowEffectStatus.DISPATCHED);
    if (!policyAllows) return rejected(state, 'effect_retry_policy_denied', `Retry policy denies ${effect.kind}`);
    if (asText(data.idempotencyKey) !== effect.idempotencyKey || asText(data.preconditionsHash) !== effect.preconditionsHash) return rejected(state, 'effect_retry_guard_mismatch', 'Retry must keep the original idempotency key and preconditions');
    return committed(state, event, { effects: { ...state.effects, [id]: { ...effect, status: WorkflowEffectStatus.PLANNED, updatedAt: at, error: '' } } });
  }
  if ([WorkflowEventType.EFFECT_SUCCEEDED, WorkflowEventType.EFFECT_FAILED, WorkflowEventType.EFFECT_UNCERTAIN, WorkflowEventType.EFFECT_CANCELLED].includes(type)) {
    const id = asText(data.effectId); const effect = state.effects[id];
    if (!effect) return rejected(state, 'effect_missing', `Unknown effect ${id || '<missing>'}`);
    if (effect.runId !== state.run.id || !ACTIVE_LIFECYCLES.has(state.lifecycle)) return rejected(state, 'effect_stale', `Effect ${id} does not belong to the active run`);
    const cancellation = type === WorkflowEventType.EFFECT_CANCELLED;
    if (effect.status !== WorkflowEffectStatus.DISPATCHED && !cancellation) return rejected(state, 'effect_not_dispatched', `Effect ${id} is ${effect.status}`);
    const reconciledCancellation = cancellation && [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status) && asText(data.reconciliation) === 'proved_not_started';
    if (cancellation && [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status) && !reconciledCancellation) return rejected(state, 'effect_cancel_evidence_required', `Effect ${id} was dispatched; cancellation requires proved_not_started evidence`);
    if (TERMINAL_EFFECTS.has(effect.status) && !reconciledCancellation) return rejected(state, 'effect_terminal', `Effect ${id} is already ${effect.status}`);
    if (data.attempt != null && Number(data.attempt) !== effect.attempt) return rejected(state, 'effect_attempt_mismatch', `Effect result attempt ${data.attempt} does not match ${effect.attempt}`);
    const status = type === WorkflowEventType.EFFECT_SUCCEEDED ? WorkflowEffectStatus.SUCCEEDED : type === WorkflowEventType.EFFECT_FAILED ? WorkflowEffectStatus.FAILED : type === WorkflowEventType.EFFECT_UNCERTAIN ? WorkflowEffectStatus.UNCERTAIN : WorkflowEffectStatus.CANCELLED;
    return committed(state, event, { effects: { ...state.effects, [id]: { ...effect, status, updatedAt: at, result: asRecord(data.result), error: asText(data.error || data.message) } } });
  }
  if (type === WorkflowEventType.LOCAL_EFFECT_PLANNED) {
    if (state.control?.pauseRequested || state.control?.stopRequested) return rejected(state, 'local_effect_blocked_by_control', 'Cannot plan a local effect while pause or stop is pending');
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'local_effect_not_allowed', `Cannot plan a local effect while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const id = asText(data.localEffectId || data.effectId); const kind = asText(data.kind);
    if (!id || !Object.values(WorkflowLocalEffectKind).includes(kind)) return rejected(state, 'local_effect_invalid', 'Local effect id and known kind are required');
    if (state.localEffects[id]) return rejected(state, 'local_effect_duplicate', `Local effect ${id} already exists`);
    const effect = { id, runId: state.run.id, kind, status: WorkflowEffectStatus.PLANNED, safe: data.safe === true, idempotencyKey: asText(data.idempotencyKey), preconditionsHash: asText(data.preconditionsHash), attempt: 0, policy: asText(data.policy || workflowLocalEffectRetryMode(state, kind)), createdAt: at, updatedAt: at, references: asRecord(data.references), processIdentity: asText(data.processIdentity), transactionIdentity: asText(data.transactionIdentity), result: {}, error: '' };
    if (!effect.idempotencyKey || !effect.preconditionsHash) return rejected(state, 'local_effect_contract_invalid', 'Local effect idempotencyKey and preconditionsHash are required');
    return committed(state, event, { localEffects: { ...state.localEffects, [id]: effect } });
  }
  if (type === WorkflowEventType.LOCAL_EFFECT_DISPATCHED) {
    const id = asText(data.localEffectId || data.effectId); const effect = state.localEffects[id];
    if (!effect) return rejected(state, 'local_effect_missing', `Unknown local effect ${id || '<missing>'}`);
    if (effect.runId !== state.run.id || ![WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'local_effect_stale', `Local effect ${id} does not belong to the active run`);
    if (effect.status !== WorkflowEffectStatus.PLANNED) return rejected(state, 'local_effect_not_planned', `Local effect ${id} is ${effect.status}`);
    return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status: WorkflowEffectStatus.DISPATCHED, attempt: effect.attempt + 1, processIdentity: asText(data.processIdentity || effect.processIdentity), transactionIdentity: asText(data.transactionIdentity || effect.transactionIdentity), dispatchedAt: at, updatedAt: at } } });
  }
  if (type === WorkflowEventType.LOCAL_EFFECT_RETRY_PLANNED) {
    const id = asText(data.localEffectId || data.effectId); const effect = state.localEffects[id];
    if (!effect) return rejected(state, 'local_effect_missing', `Unknown local effect ${id || '<missing>'}`);
    if (state.lifecycle !== WorkflowLifecycle.RECOVERING || effect.runId !== state.run.id) return rejected(state, 'local_effect_retry_not_allowed', `Local effect ${id} cannot be retried now`);
    if (![WorkflowEffectStatus.FAILED, WorkflowEffectStatus.UNCERTAIN, WorkflowEffectStatus.DISPATCHED].includes(effect.status)) return rejected(state, 'local_effect_retry_not_allowed', `Local effect ${id} is ${effect.status}`);
    const policyAllows = effect.safe ? effect.attempt < state.retryPolicy.safeLimit : effect.policy === 'always' || (effect.policy === 'if_unconfirmed' && data.reconciliation === 'proved_not_started');
    if (!policyAllows) return rejected(state, 'local_effect_retry_policy_denied', `Retry policy denies ${effect.kind}`);
    if (asText(data.idempotencyKey) !== effect.idempotencyKey || asText(data.preconditionsHash) !== effect.preconditionsHash) return rejected(state, 'local_effect_retry_guard_mismatch', 'Local effect retry must keep the original identity and preconditions');
    return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status: WorkflowEffectStatus.PLANNED, updatedAt: at, error: '', reconciliation: asText(data.reconciliation) } } });
  }
  if (type === WorkflowEventType.LOCAL_EFFECT_RECONCILED) {
    const id = asText(data.localEffectId || data.effectId); const effect = state.localEffects[id];
    if (!effect) return rejected(state, 'local_effect_missing', `Unknown local effect ${id || '<missing>'}`);
    if (effect.runId !== state.run.id || state.lifecycle !== WorkflowLifecycle.RECOVERING) return rejected(state, 'local_effect_reconcile_not_allowed', `Local effect ${id} cannot be reconciled now`);
    if (![WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status)) return rejected(state, 'local_effect_reconcile_not_allowed', `Local effect ${id} is ${effect.status}`);
    const outcome = asText(data.outcome);
    if (outcome === 'succeeded') {
      return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status: WorkflowEffectStatus.SUCCEEDED, updatedAt: at, result: asRecord(data.result), error: '', reconciliation: asText(data.reason || 'proved_succeeded') } } });
    }
    if (outcome === 'not_started' || outcome === 'safe_retry') {
      const policyAllows = effect.safe ? effect.attempt < state.retryPolicy.safeLimit : effect.policy === 'always' || (effect.policy === 'if_unconfirmed' && outcome === 'not_started');
      if (!policyAllows) return rejected(state, 'local_effect_retry_policy_denied', `Retry policy denies ${effect.kind}`);
      return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status: WorkflowEffectStatus.PLANNED, updatedAt: at, error: '', reconciliation: outcome === 'not_started' ? 'proved_not_started' : 'safe_read_retry' } } });
    }
    if (outcome === 'uncertain') {
      return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status: WorkflowEffectStatus.UNCERTAIN, updatedAt: at, reconciliation: asText(data.reason || 'uncertain'), error: asText(data.error || effect.error) } } });
    }
    return rejected(state, 'local_effect_reconcile_outcome_invalid', `Unknown local effect reconciliation outcome: ${outcome || '<missing>'}`);
  }
  if ([WorkflowEventType.LOCAL_EFFECT_SUCCEEDED, WorkflowEventType.LOCAL_EFFECT_FAILED, WorkflowEventType.LOCAL_EFFECT_UNCERTAIN, WorkflowEventType.LOCAL_EFFECT_CANCELLED].includes(type)) {
    const id = asText(data.localEffectId || data.effectId); const effect = state.localEffects[id];
    if (!effect) return rejected(state, 'local_effect_missing', `Unknown local effect ${id || '<missing>'}`);
    if (effect.runId !== state.run.id || !ACTIVE_LIFECYCLES.has(state.lifecycle)) return rejected(state, 'local_effect_stale', `Local effect ${id} does not belong to the active run`);
    const cancellation = type === WorkflowEventType.LOCAL_EFFECT_CANCELLED;
    if (effect.status !== WorkflowEffectStatus.DISPATCHED && !cancellation) return rejected(state, 'local_effect_not_dispatched', `Local effect ${id} is ${effect.status}`);
    const reconciledCancellation = cancellation && [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status) && asText(data.reconciliation) === 'proved_not_started';
    if (cancellation && [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status) && !reconciledCancellation) return rejected(state, 'local_effect_cancel_evidence_required', `Local effect ${id} was dispatched; cancellation requires proved_not_started evidence`);
    if (TERMINAL_EFFECTS.has(effect.status) && !reconciledCancellation) return rejected(state, 'local_effect_terminal', `Local effect ${id} is already ${effect.status}`);
    if (data.attempt != null && Number(data.attempt) !== effect.attempt) return rejected(state, 'local_effect_attempt_mismatch', `Local effect result attempt ${data.attempt} does not match ${effect.attempt}`);
    const status = type === WorkflowEventType.LOCAL_EFFECT_SUCCEEDED ? WorkflowEffectStatus.SUCCEEDED : type === WorkflowEventType.LOCAL_EFFECT_FAILED ? WorkflowEffectStatus.FAILED : type === WorkflowEventType.LOCAL_EFFECT_UNCERTAIN ? WorkflowEffectStatus.UNCERTAIN : WorkflowEffectStatus.CANCELLED;
    return committed(state, event, { localEffects: { ...state.localEffects, [id]: { ...effect, status, updatedAt: at, result: asRecord(data.result), error: asText(data.error || data.message), reconciliation: asText(data.reconciliation) } } });
  }
  if (type === WorkflowEventType.ACTION_REQUIRED) {
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'action_not_allowed', `Cannot require an action while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const action = normalizeAction(data, at, state.run.id);
    if (!action.id || !action.kind || !action.choices.length) return rejected(state, 'action_invalid', 'Action id, kind, and choices are required');
    if (action.defaultOnExpiry && !action.choices.some((choice) => choice.id === action.defaultOnExpiry)) return rejected(state, 'action_expiry_choice_invalid', 'defaultOnExpiry must be a permitted choice');
    return committed(state, event, { lifecycle: WorkflowLifecycle.WAITING_ACTION, nextAction: action });
  }
  if (type === WorkflowEventType.ACTION_RESOLVED || type === WorkflowEventType.ACTION_EXPIRED) {
    if (state.lifecycle !== WorkflowLifecycle.WAITING_ACTION || !state.nextAction) return rejected(state, 'action_not_pending', 'Workflow is not waiting for an action');
    if (asText(data.actionId) !== state.nextAction.id) return rejected(state, 'action_id_mismatch', 'Action id is stale or does not belong to this workflow');
    if (state.nextAction.expiresAt && Date.parse(at) >= Date.parse(state.nextAction.expiresAt) && type !== WorkflowEventType.ACTION_EXPIRED) return rejected(state, 'action_expired', `Action ${state.nextAction.id} has expired`);
    const choice = type === WorkflowEventType.ACTION_EXPIRED ? state.nextAction.defaultOnExpiry : asText(data.choice);
    if (!choice) return rejected(state, 'action_expiry_unsafe', 'Expired action has no safe default');
    return resolveAction(state, event, { ...data, choice }, state.nextAction);
  }
  if (type === WorkflowEventType.RECOVERY_STARTED) {
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.WAITING_ACTION, WorkflowLifecycle.RECOVERING, WorkflowLifecycle.PAUSED].includes(state.lifecycle)) return rejected(state, 'recovery_not_allowed', `Cannot recover workflow while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    return committed(state, event, { lifecycle: WorkflowLifecycle.RECOVERING, nextAction: null, pause: null });
  }
  if (type === WorkflowEventType.RECOVERY_RESUMED) {
    if (state.lifecycle !== WorkflowLifecycle.RECOVERING) return rejected(state, 'workflow_not_recovering', `Cannot resume recovery while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    return committed(state, event, { lifecycle: WorkflowLifecycle.RUNNING });
  }
  if (type === WorkflowEventType.PAUSE_REQUESTED) {
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.WAITING_ACTION, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'pause_not_allowed', `Cannot request pause while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    if (state.control?.stopRequested) return rejected(state, 'workflow_stop_pending', 'Cannot pause while workflow stop is pending');
    if (state.control?.pauseRequested) return rejected(state, 'workflow_pause_already_requested', 'Workflow pause is already pending');
    return committed(state, event, {
      lifecycle: WorkflowLifecycle.RECOVERING,
      nextAction: null,
      effects: cancelPlannedEffects(state.effects, at, 'workflow pause request'),
      localEffects: cancelPlannedEffects(state.localEffects, at, 'workflow pause request'),
      control: {
        ...state.control,
        pauseRequested: true,
        pauseRequestedAt: at,
        pauseReason: asText(data.reason || 'paused by user'),
        pauseResumeLifecycle: state.lifecycle,
        pauseSuspendedAction: state.nextAction ? structuredClone(state.nextAction) : null,
      },
    });
  }
  if (type === WorkflowEventType.PAUSED) {
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.WAITING_ACTION, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'pause_not_allowed', `Cannot pause workflow while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    if (!state.control?.pauseRequested) return rejected(state, 'workflow_pause_not_requested', 'Active workflow must commit pauseRequested before pausing');
    const unsettled = unsettledEffectRecords(state);
    if (unsettled.length) return rejected(state, 'workflow_pause_barrier_pending', `Cannot pause while effects remain unsettled: ${unsettled.map((effect) => `${effect.kind}:${effect.id}:${effect.status}`).join(', ')}`);
    const pause = {
      resumeLifecycle: state.control.pauseResumeLifecycle || WorkflowLifecycle.RUNNING,
      suspendedAction: state.control.pauseSuspendedAction ? structuredClone(state.control.pauseSuspendedAction) : null,
      pausedAt: at,
      reason: asText(data.reason || state.control.pauseReason),
    };
    return committed(state, event, {
      lifecycle: WorkflowLifecycle.PAUSED,
      nextAction: null,
      pause,
      control: { ...state.control, pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null },
    });
  }
  if (type === WorkflowEventType.RESUMED) {
    if (state.lifecycle !== WorkflowLifecycle.PAUSED) return rejected(state, 'resume_not_allowed', `Cannot resume workflow while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    return committed(state, event, { lifecycle: state.pause.resumeLifecycle, nextAction: state.pause.suspendedAction || null, pause: null, control: { ...state.control, pauseRequested: false, pauseRequestedAt: '', pauseReason: '', pauseResumeLifecycle: '', pauseSuspendedAction: null } });
  }
  if (type === WorkflowEventType.RUN_COMPLETED) return finishRun(state, event, data, 'completed');
  if (type === WorkflowEventType.RUN_FAILED) return finishRun(state, event, data, 'failed');
  if (type === WorkflowEventType.RUN_CANCELLED) return finishRun(state, event, data, 'cancelled');
  return rejected(state, 'unknown_workflow_event', `Unknown workflow event: ${type || '<missing>'}`);
}

/** Returns an immutable, transport-safe v3 snapshot. */
export function publicWorkflowState(state) {
  if (Number(state?.schemaVersion) !== WORKFLOW_STATE_SCHEMA_VERSION) throw new Error(`Workflow state must use schema v${WORKFLOW_STATE_SCHEMA_VERSION}`);
  return structuredClone(state);
}
