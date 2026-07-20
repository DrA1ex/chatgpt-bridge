import { GenerationState, RequestEventType } from '../state/requestEvents.js';
import { createRequestEffectDescriptor } from '../requestExecutionPlan.js';
import { isCancellationRequested, isRequestRuntimeFinished, markCancellationRequested } from './requestRuntimeProjection.js';

/**
 * Plans request cancellation as one source-bound physical BrowserEffect.
 * Command delivery is correlation only; the persisted physical result owns the
 * canonical cancelled/failed outcome.
 */
export class RequestCancellationCoordinator {
  constructor(owner) {
    if (!owner) throw new TypeError('RequestCancellationCoordinator requires an owner');
    this.owner = owner;
  }

  cancel(state, reason = 'Cancelled') {
    const owner = this.owner;
    if (!state || isRequestRuntimeFinished(state) || isCancellationRequested(state)) return;
    markCancellationRequested(state);
    state.cancelReason = String(reason || 'Cancelled');

    if (!state.clientId) {
      owner.ingestRequestTransition(state, owner.canonicalEvent(state, RequestEventType.CANCELLED, {
        message: reason,
      }, 'bridge_cancellation_without_source'));
      return;
    }

    const request = owner.requestIdentity(state);
    const effect = createRequestEffectDescriptor({
      request,
      kind: 'prompt.cancel',
      logicalId: `${state.requestId}:prompt.cancel:responseEpoch:${request.responseEpoch}`,
      causationId: `${state.requestId}:cancel`,
      preconditions: {
        reason: String(reason || 'Cancelled'),
        generation: String(owner.requestState.store.get(state.requestId)?.generation || GenerationState.IDLE),
      },
    });

    void owner.sendCommand('prompt.cancel', {
      requestId: state.requestId,
      reason,
      effect,
    }, {
      sourceClientId: state.clientId,
      timeoutMs: 10_000,
      request,
    }).catch((error) => {
      owner.eventBus?.emitDebug({
        type: 'request.cancel.command_failed',
        requestId: state.requestId,
        data: { message: error?.message || String(error), effectId: effect.effectId },
      });
      const canonical = owner.requestState.store.get(state.requestId);
      const browserEffect = canonical?.effect?.browser || {};
      const effectKnown = browserEffect.activeId === effect.effectId
        || String(browserEffect.lastResult?.data?.effectId || '') === effect.effectId;
      if (!isRequestRuntimeFinished(state) && !effectKnown) {
        owner.ingestRequestTransition(state, owner.canonicalEvent(state, RequestEventType.FAILED, {
          code: 'CANCEL_COMMAND_DELIVERY_FAILED',
          message: error?.message || String(error),
          recoverable: true,
        }, 'bridge_cancellation_delivery'));
      }
    });
  }
}
