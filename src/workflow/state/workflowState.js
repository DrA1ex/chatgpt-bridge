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
  ACTION_REQUIRED: 'action.required',
  ACTION_RESOLVED: 'action.resolved',
  ACTION_EXPIRED: 'action.expired',
  RECOVERY_STARTED: 'recovery.started',
  RECOVERY_RESUMED: 'recovery.resumed',
  PAUSED: 'workflow.paused',
  RESUMED: 'workflow.resumed',
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
    apply: policy(value.apply),
    commit: policy(value.commit),
    rollback: policy(value.rollback),
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
    observedAt: asTime(data.observedAt || at),
    references: asRecord(data.references),
    payload: asRecord(data.payload),
  };
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
    observing: Boolean(options.observing),
    project: {
      id: asText(options.project?.id || options.projectId),
      root: asText(options.project?.root || options.projectRoot),
      fingerprintSha256: asText(options.project?.fingerprintSha256 || options.projectFingerprintSha256),
    },
    binding: { clientId: asText(options.binding?.clientId), sessionId: asText(options.binding?.sessionId) },
    run,
    inputs: Array.isArray(options.inputs) ? structuredClone(options.inputs).slice(0, asCount(options.queueLimit, DEFAULT_QUEUE_LIMIT)) : [],
    inputHistory: bounded(Array.isArray(options.inputHistory) ? options.inputHistory.map(asText).filter(Boolean) : []),
    queueLimit: Math.max(1, asCount(options.queueLimit, DEFAULT_QUEUE_LIMIT)),
    effects: asRecord(options.effects),
    retries: asRecord(options.retries),
    retryPolicy: normalizeRetryPolicy(options.retryPolicy),
    nextAction: options.nextAction ? asRecord(options.nextAction) : null,
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
  const key = asText(effectKind).replace(/^.*\./, '');
  return state?.retryPolicy?.[key] || 'never';
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
  });
}

function resolveAction(state, event, data, action) {
  const choiceId = asText(data.choice);
  const choice = action.choices.find((item) => item.id === choiceId);
  if (!choice) return rejected(state, 'action_choice_invalid', `Action choice is not allowed: ${choiceId || '<missing>'}`);
  if (choice.transition === WorkflowActionTransition.STOP) {
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, observing: false, run: emptyWorkflowRun(), nextAction: null, pause: null, lastOutcome: terminalOutcome(state, choice.outcome, 'cancelled', asTime(event.at)) });
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
    return committed(state, event, { lifecycle: WorkflowLifecycle.READY, observing: data.observing !== false, binding: { clientId: asText(data.clientId || state.binding.clientId), sessionId: asText(data.sessionId || state.binding.sessionId) } });
  }
  if (type === WorkflowEventType.DEACTIVATED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_already_stopped', 'Workflow is already stopped');
    if (isWorkflowActive(state)) return rejected(state, 'workflow_active', 'Deactivate cannot discard an active run; use stop');
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, observing: false, inputs: [], inputHistory: bounded([...state.inputHistory, ...state.inputs.map((item) => item.deduplicationKey)]) });
  }
  if (type === WorkflowEventType.STOPPED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'workflow_already_stopped', 'Workflow is already stopped');
    const lastOutcome = isWorkflowActive(state)
      ? terminalOutcome(state, { code: 'stopped', message: data.reason, evidence: { stopped: true } }, 'cancelled', at)
      : state.lastOutcome;
    return committed(state, event, { lifecycle: WorkflowLifecycle.STOPPED, observing: false, run: emptyWorkflowRun(), nextAction: null, pause: null, inputs: [], inputHistory: bounded([...state.inputHistory, ...state.inputs.map((item) => item.deduplicationKey)]), lastOutcome });
  }
  if (type === WorkflowEventType.INPUT_ENQUEUED) {
    if (state.lifecycle === WorkflowLifecycle.STOPPED) return rejected(state, 'input_not_allowed', 'Stopped workflow does not accept observed inputs');
    const input = normalizeInput(data, at);
    if (!input.id || !input.deduplicationKey) return rejected(state, 'input_invalid', 'Input id and deduplication key are required');
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
      inputs = state.inputs.slice(1);
      inputHistory = bounded([...state.inputHistory, input.deduplicationKey]);
    }
    const run = normalizeRun(data, at, input);
    return committed(state, event, { lifecycle: WorkflowLifecycle.RUNNING, binding: { clientId: run.source.clientId || state.binding.clientId, sessionId: run.source.sessionId || state.binding.sessionId }, run, inputs, inputHistory, lastOutcome: null });
  }
  if (type === WorkflowEventType.PHASE_CHANGED) {
    if (state.lifecycle !== WorkflowLifecycle.RUNNING) return rejected(state, 'workflow_not_running', `Cannot change phase while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const phase = asText(data.phase);
    if (!ACTIVE_PHASES.has(phase)) return rejected(state, 'phase_invalid', `Invalid workflow phase: ${phase || '<missing>'}`);
    return committed(state, event, { run: { ...state.run, phase, updatedAt: at, source: { ...state.run.source, ...asRecord(data.source) }, request: { ...state.run.request, ...asRecord(data.request) }, artifact: { ...state.run.artifact, ...asRecord(data.artifact) }, references: { ...state.run.references, ...asRecord(data.references) } } });
  }
  if (type === WorkflowEventType.EFFECT_PLANNED) {
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
    if (effect.runId !== state.run.id || state.lifecycle !== WorkflowLifecycle.RUNNING) return rejected(state, 'effect_stale', `Effect ${id} does not belong to the running run`);
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
    if (effect.status !== WorkflowEffectStatus.DISPATCHED && type !== WorkflowEventType.EFFECT_CANCELLED) return rejected(state, 'effect_not_dispatched', `Effect ${id} is ${effect.status}`);
    if (TERMINAL_EFFECTS.has(effect.status)) return rejected(state, 'effect_terminal', `Effect ${id} is already ${effect.status}`);
    if (data.attempt != null && Number(data.attempt) !== effect.attempt) return rejected(state, 'effect_attempt_mismatch', `Effect result attempt ${data.attempt} does not match ${effect.attempt}`);
    const status = type === WorkflowEventType.EFFECT_SUCCEEDED ? WorkflowEffectStatus.SUCCEEDED : type === WorkflowEventType.EFFECT_FAILED ? WorkflowEffectStatus.FAILED : type === WorkflowEventType.EFFECT_UNCERTAIN ? WorkflowEffectStatus.UNCERTAIN : WorkflowEffectStatus.CANCELLED;
    return committed(state, event, { effects: { ...state.effects, [id]: { ...effect, status, updatedAt: at, result: asRecord(data.result), error: asText(data.error || data.message) } } });
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
  if (type === WorkflowEventType.PAUSED) {
    if (![WorkflowLifecycle.RUNNING, WorkflowLifecycle.WAITING_ACTION, WorkflowLifecycle.RECOVERING].includes(state.lifecycle)) return rejected(state, 'pause_not_allowed', `Cannot pause workflow while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    const pause = { resumeLifecycle: state.lifecycle, suspendedAction: state.nextAction ? structuredClone(state.nextAction) : null, pausedAt: at, reason: asText(data.reason) };
    return committed(state, event, { lifecycle: WorkflowLifecycle.PAUSED, nextAction: null, pause });
  }
  if (type === WorkflowEventType.RESUMED) {
    if (state.lifecycle !== WorkflowLifecycle.PAUSED) return rejected(state, 'resume_not_allowed', `Cannot resume workflow while ${state.lifecycle}`);
    const mismatch = currentRunMismatch(state, data); if (mismatch) return mismatch;
    return committed(state, event, { lifecycle: state.pause.resumeLifecycle, nextAction: state.pause.suspendedAction || null, pause: null });
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
