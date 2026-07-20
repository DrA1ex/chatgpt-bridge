import { makeEvent } from '../requestState.js';
import { hubActivityToCanonicalEvent } from '../adapters/hubObservationAdapter.js';
import { RequestEventType } from '../state/requestEvents.js';

/**
 * Reconciles a newly connected content executor with the canonical request
 * reducer. It never resubmits an ambiguous write and never owns a lease.
 */
export class RequestReattachmentCoordinator {
  constructor({ pending, lifecycle, eventBus = null, sendCommand = null }) {
    this.pending = pending;
    this.lifecycle = lifecycle;
    this.eventBus = eventBus;
    this.sendCommand = sendCommand;
  }

  canonicalProjectionForState(state) {
    const canonical = this.lifecycle.getState(state.requestId);
    const last = canonical?.lastObservation?.data || {};
    const observation = last.observation || {};
    const submittedUserTurnKey = String(
      canonical?.response?.userTurnKey
      || last.submittedUserTurnKey
      || (last.responseBoundaryEstablished ? observation.turn?.userKey : '')
      || '',
    );
    return {
      responseEpoch: Math.max(0, Number(canonical?.response?.epoch) || 0),
      submittedUserTurnKey,
      submittedUserTurnIndex: Number(observation.turn?.userIndex ?? observation.activeRequest?.submittedUserTurnIndex ?? -1),
      assistantTurnKey: String(last.turnKey || observation.turn?.key || state.progress?.assistantTurnKey || ''),
      assistantTurnIndex: Number(last.turnIndex ?? observation.turn?.index ?? state.progress?.assistantTurnIndex ?? -1),
      sentAt: Number(observation.activeRequest?.sentAt || state.progress?.sentAt || 0),
    };
  }

  rehydrateClientProjection(state, client) {
    if (!this.sendCommand || state.done || !state.promptSubmitted) return;
    const projection = this.canonicalProjectionForState(state);
    if (!projection.submittedUserTurnKey) return;
    const observerId = String(client.tabObservation?.observerId || 'ready');
    const key = `${observerId}:${projection.responseEpoch}:${projection.submittedUserTurnKey}:${projection.assistantTurnKey}`;
    if (state.lastProjectionHydrationKey === key || state.projectionHydrationInFlight === key) return;
    state.projectionHydrationInFlight = key;
    void this.sendCommand('request.resume', {
      requestId: state.requestId,
      projection,
    }, {
      sourceClientId: state.clientId,
      timeoutMs: 5_000,
      request: this.lifecycle.requestIdentity(state),
    }).then(() => {
      state.lastProjectionHydrationKey = key;
      this.eventBus?.emitDebug({
        type: 'request.projection.rehydrated',
        requestId: state.requestId,
        data: { clientId: state.clientId, observerId, responseEpoch: projection.responseEpoch },
      });
    }).catch((error) => {
      this.eventBus?.emitDebug({
        type: 'request.projection.rehydrate_failed',
        requestId: state.requestId,
        data: { clientId: state.clientId, message: error.message || String(error) },
      });
    }).finally(() => {
      if (state.projectionHydrationInFlight === key) state.projectionHydrationInFlight = '';
    });
  }

  handleClientReady(client = {}) {
    if (client.compatible === false || client.compatibility?.compatible === false) return;
    const clientId = String(client.id || '');
    if (!clientId) return;
    for (const state of this.pending.values()) {
      if (state.done || state.clientId !== clientId) continue;
      const activeRequest = client.tabObservation?.activeRequest || client.activeRequest || null;
      if (state.promptSubmitted) {
        if (activeRequest?.requestId !== state.requestId) continue;
        const now = Date.now();
        state.lastHeartbeatAt = now;
        const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, {}, now);
        if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
        state.currentGenerationActive = client.tabObservation?.generation?.state === 'active';
        if (state.currentGenerationActive) state.generationActivityAt = now;
        if (now - (state.lastReattachAt || 0) >= 1_000) {
          state.lastReattachAt = now;
          this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CONNECTION_CHANGED, {
            connected: true,
            connection: 'connected',
            clientId,
          }, 'browser_reconnect'));
          this.lifecycle.emitRequestEvent(state, makeEvent('request.reattached', {
            requestId: state.requestId,
            clientId,
            responseEpoch: Number(this.lifecycle.getState(state.requestId)?.response?.epoch || 0),
          }));
          state.callbacks.onStatus?.('reattached', { requestId: state.requestId, clientId, activeRequest });
          this.rehydrateClientProjection(state, client);
        }
        continue;
      }

      // Reload before a proved prompt submission is an uncertain write boundary.
      // Never resend the prompt from readiness handling: reconciliation must
      // prove whether the original effect happened or fail recoverably.
      if (!state.promptPayload) continue;
      const now = Date.now();
      if (now - (state.lastUnsubmittedReloadRecoveryAt || 0) < 1_000) continue;
      state.lastUnsubmittedReloadRecoveryAt = now;
      const canonical = this.lifecycle.getState(state.requestId);
      const effectId = String(canonical?.effect?.browser?.activeId || `${state.requestId}:prompt.submit:unconfirmed`);
      const effectType = String(canonical?.effect?.browser?.activeType || 'prompt.submit');
      this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_UNCERTAIN, {
        effectId,
        effectType,
        effectDomain: 'browser',
        idempotencyKey: effectId,
        code: 'PROMPT_SUBMISSION_UNCERTAIN_AFTER_RELOAD',
        message: 'Content runtime reloaded before prompt submission could be proved; automatic resend is forbidden.',
        recoveryTimeoutMs: 30_000,
        recoverable: true,
        evidence: { clientId, activeRequestId: activeRequest?.requestId || '' },
      }, 'browser_reconnect'));
      this.lifecycle.emitRequestEvent(state, makeEvent('prompt.reconcile_required_after_navigation', {
        requestId: state.requestId,
        clientId,
        effectId,
      }));
    }
  }
}
