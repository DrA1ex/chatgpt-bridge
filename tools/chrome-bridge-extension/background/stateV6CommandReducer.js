import {
  COMMAND_TRANSITIONS,
  CommandStatus,
  EffectStatus,
  LeaseStatus,
  boundedCommands,
  boundedEffects,
  committed,
  enqueueEnvelopePatch,
  matchingLease,
  matchingPersistedRequestIdentity,
  now,
  rejected,
  stableHash,
  storedCommandResult
} from './stateV6Core.js';

export function reduceCommandEvent(state, event) {
  switch (event.type) {
    case 'effect_command.dispatched': {
      const commandId = String(event.commandId || '');
      const effectId = String(event.effectId || '');
      const idempotencyKey = String(event.idempotencyKey || '');
      const kind = String(event.kind || '');
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (!commandId || !effectId || !idempotencyKey || !kind) return rejected(state, event, 'effect_command_identity_missing');
      if (state.commands?.[commandId]) return rejected(state, event, 'duplicate_command');
      if (state.effects?.[effectId]) return rejected(state, event, 'duplicate_effect');
      const queued = enqueueEnvelopePatch(state, event.acceptedEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const at = now(event);
      const preconditions = event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {};
      const preconditionsHash = String(event.preconditionsHash || stableHash(preconditions));
      const command = {
        commandId,
        commandType: String(event.commandType || ''),
        causationId: String(event.causationId || ''),
        scope: 'request',
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(state.lease.responseEpoch) || 0),
        idempotencyKey,
        preconditions,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'never',
        mode: 'effect',
        status: CommandStatus.ACCEPTED,
        physicalEffectId: effectId,
        createdAt: at,
        dispatchedAt: at,
        updatedAt: at,
      };
      const effect = {
        effectId,
        kind,
        idempotencyKey,
        commandId,
        causationId: String(event.causationId || commandId),
        requestId: state.lease.requestId,
        leaseId: state.lease.leaseId,
        ownerServerInstanceId: state.lease.ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        preconditions,
        preconditionsHash,
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : null,
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'if_unconfirmed',
        attempt: Math.max(1, Number(event.attempt) || 1),
        status: EffectStatus.DISPATCHED,
        plannedAt: at,
        dispatchedAt: at,
        settledAt: 0,
        reconciliationEvidence: null,
        result: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      return committed(state, event, {
        ...queued.patch,
        ...boundedCommands({ ...(state.commands || {}), [commandId]: command }, [...(state.commandOrder || []), commandId]),
        ...boundedEffects({ ...(state.effects || {}), [effectId]: effect }, [...(state.effectOrder || []), effectId]),
      });
    }
    case 'command.registered': {
      const scope = event.scope === 'standalone' ? 'standalone' : 'request';
      if (scope === 'request' && !matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      const commandId = String(event.commandId || '');
      if (!commandId) return rejected(state, event, 'command_identity_missing');
      if (state.commands?.[commandId]) return rejected(state, event, 'duplicate_command');
      const commands = { ...(state.commands || {}), [commandId]: {
        commandId,
        commandType: String(event.commandType || ''),
        causationId: String(event.causationId || ''),
        scope,
        requestId: scope === 'request' ? state.lease.requestId : '',
        leaseId: scope === 'request' ? state.lease.leaseId : '',
        ownerServerInstanceId: scope === 'request' ? state.lease.ownerServerInstanceId : '',
        responseEpoch: scope === 'request' ? Math.max(0, Number(state.lease.responseEpoch) || 0) : 0,
        idempotencyKey: String(event.idempotencyKey || commandId),
        preconditions: event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {},
        retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'never',
        reconcilePolicy: String(event.reconcilePolicy || ''),
        operation: String(event.operation || ''),
        registeredContentEpoch: String(event.contentEpoch || ''),
        dispatchedContentEpoch: '',
        mode: ['effect', 'result', 'release'].includes(event.mode) ? event.mode : 'result',
        terminalEnvelope: event.terminalEnvelope || null,
        status: CommandStatus.REGISTERED,
        createdAt: now(event),
        updatedAt: now(event),
      } };
      return committed(state, event, boundedCommands(commands, [...(state.commandOrder || []), commandId]));
    }
    case 'command.dispatched': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.scope !== 'standalone') {
        if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
        if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      }
      if (command.status !== CommandStatus.REGISTERED) return rejected(state, event, 'command_transition_invalid');
      const queued = enqueueEnvelopePatch(state, event.acceptedEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const status = command.mode === 'effect' ? CommandStatus.ACCEPTED : CommandStatus.DISPATCHED;
      return committed(state, event, {
        ...queued.patch,
        commands: { ...state.commands, [command.commandId]: { ...command, status, dispatchedContentEpoch: String(event.contentEpoch || command.registeredContentEpoch || ''), dispatchedAt: now(event), updatedAt: now(event) } },
      });
    }
    case 'command.succeeded':
    case 'command.rejected':
    case 'command.uncertain': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.mode === 'effect') return rejected(state, event, 'effect_backed_command_has_no_terminal_result');
      if (command.scope !== 'standalone') {
        if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
        if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      }
      if (command.commandType === 'request.release' && event.type === 'command.succeeded') return rejected(state, event, 'release_requires_barrier');
      if ([CommandStatus.SUCCEEDED, CommandStatus.REJECTED, CommandStatus.UNCERTAIN].includes(command.status)) return rejected(state, event, 'command_terminal');
      const status = event.type.split('.')[1];
      if (!COMMAND_TRANSITIONS[command.status]?.has(status)) return rejected(state, event, 'command_transition_invalid');
      const resultPayload = storedCommandResult(event.resultPayload ?? event.result ?? null);
      const resultTooLarge = resultPayload?.code === 'COMMAND_RESULT_PERSISTENCE_LIMIT';
      const settledStatus = resultTooLarge ? CommandStatus.UNCERTAIN : status;
      const queued = enqueueEnvelopePatch(state, event.terminalEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      const releaseFailed = command.mode === 'release' && event.type !== 'command.succeeded';
      return committed(state, event, {
        ...queued.patch,
        lease: releaseFailed && state.lease ? {
          ...state.lease,
          status: LeaseStatus.QUARANTINED,
          quarantineReason: String(event.error?.message || event.resultPayload?.message || 'release_cleanup_failed'),
          quarantinedAt: now(event),
          updatedAt: now(event),
        } : state.lease,
        commands: { ...state.commands, [command.commandId]: {
          ...command,
          status: settledStatus,
          resultType: resultTooLarge ? 'command.result.persistence_limit' : String(event.resultType || ''),
          resultPayload,
          error: resultTooLarge ? { code: resultPayload.code, message: resultPayload.message } : (event.error || null),
          updatedAt: now(event),
        } },
      });
    }
    case 'command.release_ready': {
      const command = state.commands?.[String(event.commandId || '')];
      if (!command) return rejected(state, event, 'command_missing');
      if (command.scope !== 'request' || command.commandType !== 'request.release') return rejected(state, event, 'command_not_release');
      if (!matchingPersistedRequestIdentity(command, event, { requireResponseEpoch: true })) return rejected(state, event, 'command_identity_mismatch');
      if (!matchingLease(state, command, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (command.status !== CommandStatus.DISPATCHED) return rejected(state, event, 'release_command_not_dispatched');
      if (state.lease.status !== LeaseStatus.RELEASING) return rejected(state, event, 'lease_not_releasing');
      if (command.releaseReadyAt) return rejected(state, event, 'release_already_ready');
      return committed(state, event, { commands: { ...state.commands, [command.commandId]: {
        ...command,
        releaseReadyAt: now(event),
        resultType: 'lease.released',
        updatedAt: now(event),
      } } });
    }
    default:
      return null;
  }
}
