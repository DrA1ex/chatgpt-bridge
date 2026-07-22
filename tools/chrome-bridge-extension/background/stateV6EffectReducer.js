import {
  CommandStatus,
  EFFECT_TRANSITIONS,
  EffectStatus,
  boundedEffects,
  committed,
  enqueueEnvelopePatch,
  matchingLease,
  matchingPersistedRequestIdentity,
  now,
  rejected,
  stableHash
} from './stateV6Core.js';

export function reduceEffectEvent(state, event) {
  switch (event.type) {
    case 'effect.planned': {
      if (!matchingLease(state, event)) return rejected(state, event, 'lease_mismatch');
      const effectId = String(event.effectId || '');
      const idempotencyKey = String(event.idempotencyKey || '');
      if (!effectId || !idempotencyKey) return rejected(state, event, 'effect_identity_missing');
      if (state.effects[effectId]) return rejected(state, event, 'duplicate_effect');
      const preconditions = event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {};
      const computedPreconditionsHash = stableHash(preconditions);
      // The canonical server owns semantic effect identity and may provide a
      // stronger hash algorithm than the background reducer. Background stores
      // that immutable guard verbatim and enforces it on every later transition;
      // it computes its local deterministic fallback only for non-server tests
      // and legacy internal callers that omit a hash.
      const preconditionsHash = String(event.preconditionsHash || computedPreconditionsHash);
      if (!preconditionsHash) return rejected(state, event, 'preconditions_hash_missing');
      const plannedAt = now(event);
      const effects = { ...state.effects, [effectId]: {
        effectId,
        kind: String(event.kind || ''),
        idempotencyKey,
        commandId: String(event.commandId || ''),
        causationId: String(event.causationId || event.commandId || ''),
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        preconditions,
        preconditionsHash,
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : null,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'if_unconfirmed',
        attempt: Math.max(1, Number(event.attempt) || 1),
        status: EffectStatus.PLANNED,
        plannedAt,
        dispatchedAt: 0,
        settledAt: 0,
        reconciliationEvidence: null,
        result: null,
        error: null,
        createdAt: plannedAt,
        updatedAt: plannedAt,
      } };
      return committed(state, event, boundedEffects(effects, [...state.effectOrder, effectId]));
    }
    case 'effect.dispatched':
    case 'effect.succeeded':
    case 'effect.failed':
    case 'effect.uncertain':
    case 'effect.cancelled': {
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (!matchingPersistedRequestIdentity(effect, event, { requireResponseEpoch: true })) return rejected(state, event, 'effect_identity_mismatch');
      if (!matchingLease(state, effect, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (event.idempotencyKey && event.idempotencyKey !== effect.idempotencyKey) return rejected(state, event, 'idempotency_key_mismatch');
      if ([EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED].includes(effect.status)) return rejected(state, event, 'effect_terminal');
      const status = event.type.split('.')[1];
      if (!EFFECT_TRANSITIONS[effect.status]?.has(status)) return rejected(state, event, 'effect_transition_invalid');
      if (status === EffectStatus.CANCELLED && effect.status === EffectStatus.DISPATCHED && event.provenNotExecuted !== true) {
        return rejected(state, event, 'effect_cancellation_unproven');
      }
      if (event.preconditionsHash && event.preconditionsHash !== effect.preconditionsHash) return rejected(state, event, 'preconditions_hash_mismatch');
      const transitionAt = now(event);
      const terminal = [EffectStatus.SUCCEEDED, EffectStatus.FAILED, EffectStatus.UNCERTAIN, EffectStatus.CANCELLED].includes(status);
      const queued = terminal ? enqueueEnvelopePatch(state, event.terminalEnvelope) : { accepted: true, patch: {} };
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const linkedCommand = effect.commandId ? state.commands?.[effect.commandId] || null : null;
      const linkedCommandStatus = status === EffectStatus.SUCCEEDED
        ? CommandStatus.SUCCEEDED
        : status === EffectStatus.UNCERTAIN
          ? CommandStatus.UNCERTAIN
          : CommandStatus.REJECTED;
      const commandPatch = terminal && linkedCommand?.mode === 'effect'
        ? { ...state.commands, [linkedCommand.commandId]: {
          ...linkedCommand,
          status: linkedCommandStatus,
          physicalEffectId: effect.effectId,
          physicalEffectStatus: status,
          updatedAt: transitionAt,
        } }
        : state.commands;
      return committed(state, event, { ...queued.patch, commands: commandPatch, effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        status,
        attempt: Math.max(effect.attempt || 1, Number(event.attempt) || effect.attempt || 1),
        dispatchedAt: status === EffectStatus.DISPATCHED ? transitionAt : effect.dispatchedAt,
        settledAt: terminal ? transitionAt : effect.settledAt,
        result: event.result || null,
        error: event.error || null,
        reconciliationEvidence: event.reconciliationEvidence && typeof event.reconciliationEvidence === 'object'
          ? event.reconciliationEvidence
          : effect.reconciliationEvidence,
        cancellationEvidence: status === EffectStatus.CANCELLED
          ? (event.cancellationEvidence && typeof event.cancellationEvidence === 'object' ? event.cancellationEvidence : null)
          : effect.cancellationEvidence || null,
        updatedAt: transitionAt,
      } } });
    }
    case 'effect.reconciliation_recorded': {
      const effect = state.effects[String(event.effectId || '')];
      if (!effect) return rejected(state, event, 'effect_missing');
      if (!matchingPersistedRequestIdentity(effect, event, { requireResponseEpoch: true })) return rejected(state, event, 'effect_identity_mismatch');
      if (event.idempotencyKey !== effect.idempotencyKey) return rejected(state, event, 'idempotency_key_mismatch');
      if (event.preconditionsHash !== effect.preconditionsHash) return rejected(state, event, 'preconditions_hash_mismatch');
      const evidence = event.reconciliationEvidence && typeof event.reconciliationEvidence === 'object'
        ? event.reconciliationEvidence
        : null;
      if (!evidence) return rejected(state, event, 'reconciliation_evidence_missing');
      return committed(state, event, { effects: { ...state.effects, [effect.effectId]: {
        ...effect,
        reconciliationEvidence: evidence,
        reconciledAt: now(event),
        updatedAt: now(event),
      } } });
    }
    default:
      return null;
  }
}
