import { createHash } from 'node:crypto';

const CONTRACT = 'passive-prompt-v1';
const UNKNOWN = 'UNKNOWN';
const INFLIGHT = 'INFLIGHT';
const SUBMITTED = 'SUBMITTED';
const REJECTED_BEFORE_SUBMIT = 'REJECTED_BEFORE_SUBMIT';
const NEEDS_OWNER_REVIEW = 'NEEDS_OWNER_REVIEW';
const OWNER_RECONCILED_NOT_SENT = 'OWNER_RECONCILED_NOT_SENT';
const INFLIGHT_OPERATOR = 'INFLIGHT';
const DEFAULT_REVIEW_AFTER_MS = 120_000;
const OWNER_RECONCILIATION_EVENT = 'passive_prompt.owner_reconciled_not_sent';

const TERMINAL_STATES = new Set([SUBMITTED, REJECTED_BEFORE_SUBMIT]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeRequestId(requestId) {
  const value = String(requestId || '').trim();
  if (!value) throw new Error('A passive prompt requestId is required');
  return value;
}

function asTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function promptDigest(message) {
  return createHash('sha256').update(String(message || ''), 'utf8').digest('hex');
}

function normalizeReviewAfterMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1_000 ? numeric : DEFAULT_REVIEW_AFTER_MS;
}

function normalizeTurn(record) {
  if (!record) return { status: UNKNOWN, turn: null };
  const status = String(record.status || '').trim().toUpperCase();
  return {
    status: [INFLIGHT, SUBMITTED, REJECTED_BEFORE_SUBMIT].includes(status) ? status : INFLIGHT,
    turn: record,
  };
}

/**
 * Durable request ledger for the passive-prompt-v1 boundary.
 *
 * The first reservation is the only caller allowed to issue a physical
 * browser command. INFLIGHT is deliberately not terminal: timeouts and
 * transport failures stay there so a later duplicate cannot blindly resend.
 */
export class PassivePromptLedger {
  #metadataStore;
  #now;
  #reviewAfterMs;
  #memory = new Map();
  #memoryMutation = Promise.resolve();

  constructor({ metadataStore = null, now = () => Date.now(), reviewAfterMs = DEFAULT_REVIEW_AFTER_MS } = {}) {
    this.#metadataStore = metadataStore;
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#reviewAfterMs = normalizeReviewAfterMs(reviewAfterMs);
  }

  async reserve(requestId, input = {}) {
    const key = normalizeRequestId(requestId);
    if (this.#metadataStore?.reserveTurn) {
      const result = await this.#metadataStore.reserveTurn({
        id: `passive_${key}`,
        threadId: 'passive-prompt',
        idempotencyKey: key,
        status: INFLIGHT,
        input: clone(input) || {},
      });
      const normalized = normalizeTurn(result.turn);
      return { requestId: key, created: Boolean(result.created), ...normalized };
    }

    return await this.#withMemoryMutation(async () => {
      const existing = this.#memory.get(key);
      if (existing) return { requestId: key, created: false, ...normalizeTurn(existing) };
      const turn = {
        id: `passive_${key}`,
        threadId: 'passive-prompt',
        idempotencyKey: key,
        status: INFLIGHT,
        input: clone(input) || {},
        output: null,
        error: null,
      };
      this.#memory.set(key, turn);
      return { requestId: key, created: true, status: INFLIGHT, turn: clone(turn) };
    });
  }

  async get(requestId) {
    const key = normalizeRequestId(requestId);
    const turn = await this.#getRecord(key);
    const normalized = normalizeTurn(turn);
    return {
      requestId: key,
      ...normalized,
      ...await this.#operatorView(normalized),
    };
  }

  /**
   * Record an owner-supplied negative conversation proof without changing the
   * INFLIGHT storage state.  This is deliberately not a retry/rejection path:
   * the original write may still have crossed the browser boundary.
   */
  async reconcileOwnerNotSent(requestId, { actor = 'owner', evidence = {} } = {}) {
    const key = normalizeRequestId(requestId);
    const turn = await this.#getRecord(key);
    const normalized = normalizeTurn(turn);
    if (!turn || normalized.status === UNKNOWN) {
      const error = new Error('Passive prompt request was not found');
      error.code = 'PASSIVE_PROMPT_UNKNOWN_REQUEST';
      error.statusCode = 404;
      throw error;
    }
    if (normalized.status !== INFLIGHT) {
      const error = new Error(`Passive prompt is ${normalized.status}; owner reconciliation is not applicable`);
      error.code = 'PASSIVE_PROMPT_NOT_INFLIGHT';
      error.statusCode = 409;
      throw error;
    }
    const current = await this.get(key);
    if (current.operator_status !== NEEDS_OWNER_REVIEW) {
      const error = new Error('Passive prompt is still within the reconciliation window; wait for owner review state');
      error.code = 'PASSIVE_PROMPT_REVIEW_NOT_READY';
      error.statusCode = 409;
      throw error;
    }

    const normalizedEvidence = this.#validateNegativeEvidence(turn, evidence);
    const record = {
      requestId: key,
      storage_status: INFLIGHT,
      operator_status: OWNER_RECONCILED_NOT_SENT,
      actor: String(actor || 'owner').trim().slice(0, 160) || 'owner',
      reconciledAt: new Date(this.#now()).toISOString(),
      evidence: normalizedEvidence,
    };
    if (this.#metadataStore?.addTurnEvent) {
      await this.#metadataStore.addTurnEvent(turn.id, {
        type: OWNER_RECONCILIATION_EVENT,
        level: 'warn',
        time: record.reconciledAt,
        data: record,
      });
    } else {
      await this.#withMemoryMutation(async () => {
        const currentTurn = this.#memory.get(key);
        if (currentTurn) currentTurn.ownerReconciliation = clone(record);
      });
    }
    return await this.get(key);
  }

  async markSubmitted(requestId, proof) {
    const key = normalizeRequestId(requestId);
    const normalizedProof = clone(proof) || {};
    if (this.#metadataStore?.updateTurnByIdempotencyKey) {
      const turn = await this.#metadataStore.updateTurnByIdempotencyKey(key, {
        fromStatuses: [INFLIGHT],
        patch: { status: SUBMITTED, output: normalizedProof, error: null },
      });
      return { requestId: key, ...normalizeTurn(turn) };
    }
    return await this.#withMemoryMutation(async () => {
      const current = this.#memory.get(key);
      if (!current) return { requestId: key, status: UNKNOWN, turn: null };
      if (current.status === INFLIGHT) {
        current.status = SUBMITTED;
        current.output = normalizedProof;
        current.error = null;
      }
      return { requestId: key, ...normalizeTurn(current) };
    });
  }

  async markRejectedBeforeSubmit(requestId, proof = {}) {
    const key = normalizeRequestId(requestId);
    const normalizedProof = {
      contract: CONTRACT,
      submissionStatus: REJECTED_BEFORE_SUBMIT,
      error: String(proof.error || 'Prompt rejected before submission'),
      ...(proof.code ? { code: String(proof.code) } : {}),
    };
    if (this.#metadataStore?.updateTurnByIdempotencyKey) {
      const turn = await this.#metadataStore.updateTurnByIdempotencyKey(key, {
        fromStatuses: [INFLIGHT],
        patch: { status: REJECTED_BEFORE_SUBMIT, output: null, error: normalizedProof },
      });
      return { requestId: key, ...normalizeTurn(turn) };
    }
    return await this.#withMemoryMutation(async () => {
      const current = this.#memory.get(key);
      if (!current) return { requestId: key, status: UNKNOWN, turn: null };
      if (current.status === INFLIGHT) {
        current.status = REJECTED_BEFORE_SUBMIT;
        current.output = null;
        current.error = normalizedProof;
      }
      return { requestId: key, ...normalizeTurn(current) };
    });
  }

  static proof(record) {
    if (!record?.turn) return null;
    if (record.status === SUBMITTED) return clone(record.turn.output || null);
    if (record.status === REJECTED_BEFORE_SUBMIT) return clone(record.turn.error || null);
    return null;
  }

  static get states() {
    return Object.freeze({ UNKNOWN, INFLIGHT, SUBMITTED, REJECTED_BEFORE_SUBMIT });
  }

  static get operatorStates() {
    return Object.freeze({
      UNKNOWN,
      INFLIGHT: INFLIGHT_OPERATOR,
      SUBMITTING: INFLIGHT_OPERATOR,
      SUBMITTED,
      REJECTED_BEFORE_SUBMIT,
      NEEDS_OWNER_REVIEW,
      OWNER_RECONCILED_NOT_SENT,
    });
  }

  static isTerminal(status) {
    return TERMINAL_STATES.has(String(status || '').toUpperCase());
  }

  async #withMemoryMutation(operation) {
    const previous = this.#memoryMutation;
    let release;
    this.#memoryMutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #getRecord(key) {
    return this.#metadataStore?.getTurnByIdempotencyKey
      ? await this.#metadataStore.getTurnByIdempotencyKey(key)
      : this.#memory.get(key) || null;
  }

  async #ownerReconciliation(turn) {
    if (turn?.ownerReconciliation) return clone(turn.ownerReconciliation);
    if (!turn || !this.#metadataStore?.listTurnEvents) return null;
    const events = await this.#metadataStore.listTurnEvents(turn.id, { limit: 100 });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === OWNER_RECONCILIATION_EVENT) {
        return clone(events[index].data || null);
      }
    }
    return null;
  }

  async #operatorView(normalized) {
    const turn = normalized.turn;
    const storageStatus = normalized.status;
    if (!turn || storageStatus === UNKNOWN) {
      return {
        storage_status: UNKNOWN,
        operator_status: UNKNOWN,
        can_retry: false,
        reconciliation_required: false,
      };
    }
    const createdAtMs = asTimestamp(turn.createdAt);
    const updatedAtMs = asTimestamp(turn.updatedAt) || createdAtMs;
    const ageMs = Math.max(0, Number(this.#now()) - (updatedAtMs || Number(this.#now())));
    if (storageStatus === SUBMITTED) {
      return {
        storage_status: SUBMITTED,
        operator_status: SUBMITTED,
        can_retry: false,
        reconciliation_required: false,
        ageMs,
      };
    }
    if (storageStatus === REJECTED_BEFORE_SUBMIT) {
      return {
        storage_status: REJECTED_BEFORE_SUBMIT,
        operator_status: REJECTED_BEFORE_SUBMIT,
        can_retry: true,
        reconciliation_required: false,
        ageMs,
      };
    }
    if (storageStatus === INFLIGHT) {
      const ownerReconciliation = await this.#ownerReconciliation(turn);
      if (ownerReconciliation) {
        return {
          storage_status: INFLIGHT,
          operator_status: OWNER_RECONCILED_NOT_SENT,
          can_retry: false,
          reconciliation_required: false,
          ageMs,
          reconciliation: ownerReconciliation,
        };
      }
      return {
        storage_status: INFLIGHT,
        operator_status: ageMs >= this.#reviewAfterMs ? NEEDS_OWNER_REVIEW : INFLIGHT_OPERATOR,
        can_retry: false,
        reconciliation_required: true,
        ageMs,
        reviewAfterMs: this.#reviewAfterMs,
      };
    }
    return {
      storage_status: storageStatus || UNKNOWN,
      operator_status: UNKNOWN,
      can_retry: false,
      reconciliation_required: false,
    };
  }

  #validateNegativeEvidence(turn, evidence) {
    const candidate = evidence && typeof evidence === 'object' ? evidence : {};
    const input = turn.input && typeof turn.input === 'object' ? turn.input : {};
    const expectedSession = String(input.sessionId || '').trim();
    const expectedClient = String(input.sourceClientId || '').trim();
    const sessionId = String(candidate.sessionId || candidate.conversationId || '').trim();
    const sourceClientId = String(candidate.sourceClientId || '').trim();
    const matchingUserTurnKeys = Array.isArray(candidate.matchingUserTurnKeys)
      ? candidate.matchingUserTurnKeys.map((value) => String(value || '').trim()).filter(Boolean)
      : null;
    const digest = String(candidate.promptSha256 || '').trim().toLowerCase();
    const valid = candidate.proofType === 'NO_MATCHING_USER_TURN'
      && candidate.notFound === true
      && expectedSession
      && sessionId === expectedSession
      && expectedClient
      && sourceClientId === expectedClient
      && Array.isArray(matchingUserTurnKeys)
      && matchingUserTurnKeys.length === 0
      && digest === promptDigest(input.message);
    if (!valid) {
      const error = new Error('Owner reconciliation requires exact no-matching-user-turn evidence for the bound session and request');
      error.code = 'PASSIVE_PROMPT_NEGATIVE_EVIDENCE_INVALID';
      error.statusCode = 422;
      throw error;
    }
    return {
      proofType: 'NO_MATCHING_USER_TURN',
      notFound: true,
      sessionId,
      sourceClientId,
      matchingUserTurnKeys,
      promptSha256: digest,
      observedAt: String(candidate.observedAt || new Date(this.#now()).toISOString()).slice(0, 80),
      notes: String(candidate.notes || '').slice(0, 500),
    };
  }
}

export const PassivePromptContract = Object.freeze({
  contract: CONTRACT,
  states: PassivePromptLedger.states,
  operatorStates: PassivePromptLedger.operatorStates,
});
