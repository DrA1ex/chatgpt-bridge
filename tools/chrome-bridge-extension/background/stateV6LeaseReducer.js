import {
  CommandStatus,
  LEASE_TRANSITIONS,
  LeaseStatus,
  activeRequestChildren,
  boundedCommands,
  committed,
  enqueueEnvelopePatch,
  matchingLease,
  matchingPersistedRequestIdentity,
  now,
  rejected
} from './stateV6Core.js';

export function reduceLeaseEvent(state, event) {
  switch (event.type) {
    case 'content.attached': {
      const contentEpoch = String(event.contentEpoch || '');
      if (!contentEpoch) return rejected(state, event, 'content_epoch_missing');
      const lease = state.lease && state.lease.status !== LeaseStatus.IDLE
        ? { ...state.lease, status: state.lease.status === LeaseStatus.RELEASING ? LeaseStatus.RELEASING : LeaseStatus.RECONCILING, contentEpoch, updatedAt: now(event) }
        : state.lease;
      return committed(state, event, { contentEpoch, lease });
    }
    case 'lease.claim': {
      const requestId = String(event.requestId || '');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      if (!requestId || !leaseId || !ownerServerInstanceId) return rejected(state, event, 'lease_identity_missing');
      if (state.lease && state.lease.status !== LeaseStatus.IDLE) {
        if (matchingLease(state, event)) return rejected(state, event, 'duplicate_lease');
        return rejected(state, event, 'lease_conflict');
      }
      return committed(state, event, {
        lease: {
          requestId,
          leaseId,
          ownerServerInstanceId,
          responseEpoch: Math.max(0, Number(event.responseEpoch) || 0),
          conversationId: String(event.conversationId || ''),
          contentEpoch: state.contentEpoch,
          status: LeaseStatus.CLAIMED,
          claimedAt: now(event),
          updatedAt: now(event),
        },
      });
    }
    case 'lease.handoff': {
      if (!state.lease || state.lease.requestId !== String(event.requestId || '')) return rejected(state, event, 'lease_mismatch');
      if (!String(event.previousLeaseId || '') || state.lease.leaseId !== String(event.previousLeaseId || '')) return rejected(state, event, 'previous_lease_mismatch');
      if (event.previousResponseEpoch == null || Math.max(0, Number(event.previousResponseEpoch) || 0) !== Math.max(0, Number(state.lease.responseEpoch) || 0)) return rejected(state, event, 'previous_response_epoch_mismatch');
      if (state.lease.ownerServerInstanceId !== String(event.previousOwnerServerInstanceId || '')) return rejected(state, event, 'previous_owner_mismatch');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      if (!leaseId || !ownerServerInstanceId) return rejected(state, event, 'lease_identity_missing');
      return committed(state, event, { lease: {
        ...state.lease,
        leaseId,
        ownerServerInstanceId,
        responseEpoch: Math.max(0, Number(event.responseEpoch ?? state.lease.responseEpoch) || 0),
        status: LeaseStatus.RECONCILING,
        contentEpoch: state.contentEpoch,
        updatedAt: now(event),
      } });
    }
    case 'lease.executing':
    case 'lease.reconciling':
    case 'lease.releasing': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      const status = event.type.split('.')[1];
      if (!LEASE_TRANSITIONS[state.lease.status]?.has(status)) return rejected(state, event, 'lease_transition_invalid');
      return committed(state, event, { lease: { ...state.lease, status, updatedAt: now(event) } });
    }
    case 'lease.epoch_adopted': {
      if (!state.lease) return rejected(state, event, 'lease_missing');
      const previous = Math.max(0, Number(event.previousResponseEpoch) || 0);
      const target = Math.max(0, Number(event.responseEpoch) || 0);
      if (String(event.requestId || '') !== state.lease.requestId
        || String(event.leaseId || '') !== state.lease.leaseId
        || String(event.ownerServerInstanceId || '') !== state.lease.ownerServerInstanceId) return rejected(state, event, 'lease_mismatch');
      if (previous !== Math.max(0, Number(state.lease.responseEpoch) || 0)) return rejected(state, event, 'previous_response_epoch_mismatch');
      if (target !== previous + 1) return rejected(state, event, 'response_epoch_not_monotonic');
      return committed(state, event, { lease: { ...state.lease, responseEpoch: target, updatedAt: now(event) } });
    }
    case 'lease.quarantine': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      return committed(state, event, { lease: { ...state.lease, status: LeaseStatus.QUARANTINED, quarantineReason: String(event.reason || 'release_unproven'), quarantinedAt: now(event), updatedAt: now(event) } });
    }
    case 'lease.release_recover': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      const active = activeRequestChildren(state, state.lease);
      if (active.commands.length || active.effects.length || active.downloads.length) {
        return rejected(state, event, 'lease_children_active');
      }
      const commandId = String(event.commandId || '');
      if (!commandId || event.commandType !== 'request.release' || event.scope !== 'request' || event.mode !== 'release') {
        return rejected(state, event, 'release_command_identity_missing');
      }

      const sameLeaseReleaseCommands = Object.values(state.commands || {}).filter((command) => command
        && command.scope === 'request'
        && command.commandType === 'request.release'
        && String(command.requestId || '') === state.lease.requestId
        && String(command.leaseId || '') === state.lease.leaseId
        && String(command.ownerServerInstanceId || '') === state.lease.ownerServerInstanceId);
      if (sameLeaseReleaseCommands.length > 1) return rejected(state, event, 'release_command_ambiguous');
      const existingReleaseCommand = sameLeaseReleaseCommands[0] || null;
      if (state.commands?.[commandId] && state.commands[commandId] !== existingReleaseCommand) {
        return rejected(state, event, 'duplicate_command');
      }
      if (existingReleaseCommand) {
        if (existingReleaseCommand.commandId !== commandId) return rejected(state, event, 'release_command_identity_mismatch');
        if (existingReleaseCommand.mode !== 'release' || existingReleaseCommand.status !== CommandStatus.REGISTERED) {
          return rejected(state, event, 'release_already_dispatched');
        }
        if (!matchingPersistedRequestIdentity(existingReleaseCommand, event, { requireResponseEpoch: true })) {
          return rejected(state, event, 'release_command_identity_mismatch');
        }
        if (state.lease.status !== LeaseStatus.RELEASING) return rejected(state, event, 'lease_release_recovery_status_invalid');
      } else {
        if (state.lease.releaseRecoveryUsed === true) return rejected(state, event, 'lease_release_recovery_used');
        if (![LeaseStatus.CLAIMED, LeaseStatus.RECONCILING, LeaseStatus.EXECUTING, LeaseStatus.QUARANTINED].includes(state.lease.status)) {
          return rejected(state, event, 'lease_release_recovery_status_invalid');
        }
      }
      if (state.lease.releaseRecoveryCommandId
        && String(state.lease.releaseRecoveryCommandId) !== commandId) return rejected(state, event, 'release_command_identity_mismatch');
      if (!event.acceptedEnvelope || event.acceptedEnvelope.messageType !== 'command.accepted'
        || String(event.acceptedEnvelope.body?.commandId || '') !== commandId
        || String(event.acceptedEnvelope.body?.commandType || '') !== 'request.release'
        || String(event.acceptedEnvelope.body?.requestId || '') !== state.lease.requestId
        || String(event.acceptedEnvelope.body?.commandScope || '') !== 'request'
        || String(event.acceptedEnvelope.body?.commandMode || '') !== 'release'
        || !matchingPersistedRequestIdentity(state.lease, event.acceptedEnvelope.request, { requireResponseEpoch: true })) {
        return rejected(state, event, 'release_acceptance_envelope_invalid');
      }

      const terminalEnvelope = existingReleaseCommand?.terminalEnvelope || event.terminalEnvelope;
      if (!terminalEnvelope || terminalEnvelope.messageType !== 'lease.released'
        || String(terminalEnvelope.body?.commandId || '') !== commandId
        || String(terminalEnvelope.body?.requestId || '') !== state.lease.requestId
        || terminalEnvelope.body?.released !== true
        || terminalEnvelope.body?.activeRequest !== null
        || !matchingPersistedRequestIdentity(state.lease, terminalEnvelope.request, { requireResponseEpoch: true })) {
        return rejected(state, event, 'release_terminal_envelope_invalid');
      }
      const queued = enqueueEnvelopePatch(state, event.acceptedEnvelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });

      const at = now(event);
      const request = state.lease;
      const command = existingReleaseCommand
        ? {
            ...existingReleaseCommand,
            status: CommandStatus.DISPATCHED,
            dispatchedContentEpoch: String(event.contentEpoch || existingReleaseCommand.registeredContentEpoch || ''),
            dispatchedAt: at,
            updatedAt: at,
          }
        : {
            commandId,
            commandType: 'request.release',
            causationId: String(event.causationId || ''),
            scope: 'request',
            requestId: request.requestId,
            leaseId: request.leaseId,
            ownerServerInstanceId: request.ownerServerInstanceId,
            responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
            idempotencyKey: String(event.idempotencyKey || commandId),
            preconditions: event.preconditions && typeof event.preconditions === 'object' ? event.preconditions : {},
            retryPolicy: ['never', 'if_unconfirmed', 'always'].includes(event.retryPolicy) ? event.retryPolicy : 'always',
            reconcilePolicy: String(event.reconcilePolicy || 'lease_cleanup'),
            operation: String(event.operation || 'control'),
            registeredContentEpoch: String(event.contentEpoch || ''),
            dispatchedContentEpoch: String(event.contentEpoch || ''),
            mode: 'release',
            terminalEnvelope,
            status: CommandStatus.DISPATCHED,
            createdAt: at,
            dispatchedAt: at,
            updatedAt: at,
          };
      const commands = boundedCommands({ ...(state.commands || {}), [commandId]: command }, [...(state.commandOrder || []).filter((id) => id !== commandId), commandId]);
      return committed(state, event, {
        ...queued.patch,
        ...commands,
        lease: {
          ...request,
          status: LeaseStatus.RELEASING,
          releaseRecoveryUsed: true,
          releaseRecoveryCommandId: commandId,
          updatedAt: at,
        },
      });
    }
    case 'lease.release': {
      if (!matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
      if (state.lease.status !== LeaseStatus.RELEASING) return rejected(state, event, 'lease_not_releasing');
      const active = activeRequestChildren(state, state.lease);
      if (active.commands.length || active.effects.length || active.downloads.length) {
        return rejected(state, event, 'lease_children_active', {
          metrics: {
            ...state.metrics,
            releaseBlocked: (Number(state.metrics?.releaseBlocked) || 0) + 1,
          },
        });
      }
      return committed(state, event, { lease: null });
    }
    default:
      return null;
  }
}
