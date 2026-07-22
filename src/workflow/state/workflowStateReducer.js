import {
  ACTIVE_LIFECYCLES,
  ACTIVE_PHASES,
  TERMINAL_EFFECTS,
  WORKFLOW_STATE_SCHEMA_VERSION,
  WorkflowActionTransition,
  WorkflowEffectKind,
  WorkflowEffectStatus,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  asCount,
  asRecord,
  asText,
  asTime,
  bounded,
  cancelPlannedEffects,
  committed,
  createWorkflowState,
  currentRunMismatch,
  emptyWorkflowRun,
  finishRun,
  invariantError,
  isWorkflowActive,
  nextBinding,
  normalizeGitState,
  normalizeAction,
  normalizeInput,
  normalizeRun,
  rejected,
  resolveAction,
  terminalOutcome,
  unsettledEffectRecords,
  workflowEffectRetryMode,
  workflowLocalEffectRetryMode,
} from './workflowStateModel.js';

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
    if (!effect.safe && effect.policy === 'always') return rejected(state, 'effect_retry_policy_invalid', `Unsafe effect ${kind} cannot use always retry`);
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
    const policyAllows = effect.safe
      ? effect.attempt < state.retryPolicy.safeLimit
      : effect.policy !== 'never' && asText(data.reconciliation) === 'proved_not_started';
    if (!policyAllows) return rejected(state, 'effect_retry_policy_denied', `Retry policy denies ${effect.kind}`);
    if (asText(data.idempotencyKey) !== effect.idempotencyKey || asText(data.preconditionsHash) !== effect.preconditionsHash) return rejected(state, 'effect_retry_guard_mismatch', 'Retry must keep the original idempotency key and preconditions');
    return committed(state, event, { effects: { ...state.effects, [id]: { ...effect, status: WorkflowEffectStatus.PLANNED, updatedAt: at, error: '', reconciliation: effect.safe ? 'safe_read_retry' : 'proved_not_started' } } });
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
    if (!effect.safe && effect.policy === 'always') return rejected(state, 'local_effect_retry_policy_invalid', `Unsafe local effect ${kind} cannot use always retry`);
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
    const policyAllows = effect.safe
      ? effect.attempt < state.retryPolicy.safeLimit
      : effect.policy !== 'never' && asText(data.reconciliation) === 'proved_not_started';
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
      const policyAllows = effect.safe
        ? effect.attempt < state.retryPolicy.safeLimit && outcome === 'safe_retry'
        : effect.policy !== 'never' && outcome === 'not_started';
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
