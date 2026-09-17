const CONTRACT = 'passive-prompt-v1';
const UNKNOWN = 'UNKNOWN';
const INFLIGHT = 'INFLIGHT';
const SUBMITTED = 'SUBMITTED';
const REJECTED_BEFORE_SUBMIT = 'REJECTED_BEFORE_SUBMIT';

const TERMINAL_STATES = new Set([SUBMITTED, REJECTED_BEFORE_SUBMIT]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeRequestId(requestId) {
  const value = String(requestId || '').trim();
  if (!value) throw new Error('A passive prompt requestId is required');
  return value;
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
  #memory = new Map();
  #memoryMutation = Promise.resolve();

  constructor({ metadataStore = null } = {}) {
    this.#metadataStore = metadataStore;
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
    const turn = this.#metadataStore?.getTurnByIdempotencyKey
      ? await this.#metadataStore.getTurnByIdempotencyKey(key)
      : this.#memory.get(key) || null;
    return { requestId: key, ...normalizeTurn(turn) };
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
}

export const PassivePromptContract = Object.freeze({
  contract: CONTRACT,
  states: PassivePromptLedger.states,
});
