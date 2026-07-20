import { makeEvent } from '../requestState.js';
import { RequestEventType } from '../state/requestEvents.js';
import { createRequestEffectDescriptor, requestTextHash } from '../requestExecutionPlan.js';
import { waitForSteerReadiness } from './steerReadiness.js';

/**
 * Coordinates explicit controls for one already-canonical request.
 * It does not own lifecycle state; it validates the tracked request, supplies
 * immutable effect identity, and delegates every mutation to the canonical
 * request reducer or the source-bound command transport.
 */
export class RequestControlCoordinator {
  constructor({ pending, lifecycle, operations, sendCommand } = {}) {
    if (!pending || !lifecycle || !operations || typeof sendCommand !== 'function') {
      throw new TypeError('RequestControlCoordinator requires pending, lifecycle, operations, and sendCommand');
    }
    this.pending = pending;
    this.lifecycle = lifecycle;
    this.operations = operations;
    this.sendCommand = sendCommand;
  }

  async steerRequest(requestId, message, options = {}) {
    const id = String(requestId || '').trim();
    const text = String(message || '').trim();
    if (!id) throw new Error('No requestId provided for steer');
    if (!text) throw new Error('No steer message provided');
    const state = this.pending.get(id);
    if (!state || state.done) throw new Error(`No active tracked request for steer: ${id}`);
    const sourceClientId = String(options.sourceClientId || state.clientId || '');
    if (!sourceClientId) throw new Error(`Active request ${id} has no source browser client`);

    await waitForSteerReadiness({
      requestId: id,
      state,
      lifecycle: this.lifecycle,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      steerReadyTimeoutMs: options.steerReadyTimeoutMs,
    });

    const currentResponseEpoch = Number(this.lifecycle.getState(id)?.response?.epoch || 0);
    const targetResponseEpoch = currentResponseEpoch + 1;
    const request = this.lifecycle.requestIdentity(state, currentResponseEpoch);
    const effect = createRequestEffectDescriptor({
      request,
      kind: 'prompt.steer',
      logicalId: `${id}:prompt.steer:responseEpoch:${targetResponseEpoch}`,
      causationId: `${id}:steer:${targetResponseEpoch}`,
      preconditions: {
        currentResponseEpoch,
        targetResponseEpoch,
        messageHash: requestTextHash(text),
      },
    });
    this.lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.requested', {
      requestId: id, message: text, sourceClientId,
    }), { canonical: false });
    const response = await this.lifecycle.runRequestEffect(state, {
      id: `${id}:prompt-steer:${targetResponseEpoch}`,
      type: 'prompt.steer',
      data: { sourceClientId, messageLength: text.length, effectId: effect.effectId },
      execute: async () => await this.sendCommand('prompt.steer', {
        requestId: id,
        message: text,
        responseEpoch: targetResponseEpoch,
        effect,
      }, {
        ...options,
        sourceClientId,
        timeoutMs: Number(options.timeoutMs) || 30_000,
        request,
      }),
    });
    const previousResponseEpoch = Math.max(0, Number(response?.previousResponseEpoch ?? currentResponseEpoch) || 0);
    const committedResponseEpoch = Math.max(0, Number(response?.targetResponseEpoch ?? targetResponseEpoch) || 0);
    if (previousResponseEpoch !== currentResponseEpoch || committedResponseEpoch !== targetResponseEpoch) {
      const error = new Error(`Steer response epoch mismatch: expected ${currentResponseEpoch}->${targetResponseEpoch}, received ${previousResponseEpoch}->${committedResponseEpoch}`);
      error.code = 'STEER_RESPONSE_EPOCH_MISMATCH';
      throw error;
    }
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.STEER_ACCEPTED, {
      messageLength: text.length,
      sourceClientId,
      userTurnKey: response?.submittedUserTurnKey || response?.userTurnKey || '',
      previousResponseEpoch,
      targetResponseEpoch: committedResponseEpoch,
    }, 'browser_prompt_steer'));
    this.lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.accepted', {
      requestId: id,
      message: text,
      sourceClientId,
      responseEpoch: this.lifecycle.getState(id)?.response?.epoch || 0,
    }), { canonical: false });
    this.lifecycle.touchState(state, 'prompt.steer.accepted');
    return response;
  }

  async reloadBrowserTab(options = {}) {
    const requestId = String(options.requestId || '').trim();
    if (!requestId) {
      const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
      return await this.operations.reloadBrowserTab({ ...options, sourceClientId, requestId: '' });
    }
    const state = this.pending.get(requestId);
    if (!state || state.done) {
      const error = new Error(`No active tracked request for content reload: ${requestId}`);
      error.code = 'REQUEST_RELOAD_NOT_ACTIVE';
      throw error;
    }
    const sourceClientId = String(options.sourceClientId || options.clientId || state.clientId || '').trim();
    if (!sourceClientId || (state.clientId && sourceClientId !== state.clientId)) {
      const error = new Error(`Request ${requestId} is not owned by browser client ${sourceClientId || '(missing)'}`);
      error.code = 'REQUEST_RELOAD_SOURCE_MISMATCH';
      throw error;
    }
    return await this.operations.reloadBrowserTab({
      ...options,
      sourceClientId,
      requestId,
      request: this.lifecycle.requestIdentity(state),
    });
  }
}
