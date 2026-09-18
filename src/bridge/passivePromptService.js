import { makeRequestId } from '../protocol.js';
import { PassivePromptLedger } from './passivePromptLedger.js';

/**
 * Owns the passive-prompt HTTP boundary above the browser command layer.
 * Keeping reservation and proof handling out of BrowserBridge preserves the
 * composition root's narrow orchestration role.
 */
export class PassivePromptService {
  #ledger;
  #operations;

  constructor({ operations, metadataStore = null, now, reviewAfterMs } = {}) {
    if (!operations || typeof operations.submitPassivePrompt !== 'function') {
      throw new TypeError('PassivePromptService requires BridgeOperations');
    }
    this.#operations = operations;
    this.#ledger = new PassivePromptLedger({ metadataStore, now, reviewAfterMs });
  }

  async submit(options = {}) {
    const requestId = String(options.requestId || makeRequestId()).trim();
    const reservation = await this.#ledger.reserve(requestId, {
      message: String(options.message || ''),
      sessionId: String(options.sessionId || ''),
      sourceClientId: String(options.sourceClientId || ''),
      effort: String(options.effort || ''),
      model: String(options.model || ''),
    });

    if (!reservation.created) {
      if (reservation.status === PassivePromptLedger.states.SUBMITTED) {
        const proof = PassivePromptLedger.proof(reservation);
        if (proof) return proof;
      }
      if (reservation.status === PassivePromptLedger.states.REJECTED_BEFORE_SUBMIT) {
        throw this.#preSubmitError(requestId, PassivePromptLedger.proof(reservation));
      }
      const error = new Error(`Passive prompt request ${requestId} is already in flight; do not resend`);
      error.submissionStatus = 'UNCERTAIN_AFTER_SUBMIT';
      error.requestId = requestId;
      throw error;
    }

    try {
      const result = await this.#operations.submitPassivePrompt({ ...options, requestId });
      const settled = await this.#ledger.markSubmitted(requestId, result);
      if (settled.status === PassivePromptLedger.states.SUBMITTED) {
        const proof = PassivePromptLedger.proof(settled);
        if (proof) return proof;
      }
      const error = new Error('Passive prompt submission proof could not be durably recorded');
      error.submissionStatus = 'UNCERTAIN_AFTER_SUBMIT';
      error.requestId = requestId;
      throw error;
    } catch (error) {
      if (error?.submissionStatus === 'REJECTED_BEFORE_SUBMIT') {
        const settled = await this.#ledger.markRejectedBeforeSubmit(requestId, {
          error: error.message,
          code: error.code,
        });
        if (settled.status === PassivePromptLedger.states.REJECTED_BEFORE_SUBMIT) {
          throw this.#preSubmitError(requestId, PassivePromptLedger.proof(settled));
        }
      }
      if (!error?.submissionStatus) error.submissionStatus = 'UNCERTAIN_AFTER_SUBMIT';
      error.requestId = requestId;
      throw error;
    }
  }

  async status(requestId = '') {
    return await this.#ledger.get(requestId);
  }

  async reconcileOwnerNotSent(requestId = '', options = {}) {
    return await this.#ledger.reconcileOwnerNotSent(requestId, options);
  }

  #preSubmitError(requestId, proof = null) {
    const error = new Error(proof?.error || 'Prompt rejected before submission');
    error.code = proof?.code || 'PASSIVE_PROMPT_REJECTED_BEFORE_SUBMIT';
    error.submissionStatus = 'REJECTED_BEFORE_SUBMIT';
    error.requestId = requestId;
    return error;
  }
}
