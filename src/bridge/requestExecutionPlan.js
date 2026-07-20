import { createHash } from 'node:crypto';

const STEP_POLICIES = Object.freeze({
  'page.ready.initial': Object.freeze({ retryPolicy: 'always', write: false }),
  'session.apply': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'model.apply': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'attachments.upload': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'prompt.submit': Object.freeze({ retryPolicy: 'never', write: true }),
  'prompt.steer': Object.freeze({ retryPolicy: 'never', write: true }),
  'prompt.cancel': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
});

export function requestTextHash(message = '') {
  return createHash('sha256').update(String(message || '')).digest('hex');
}


function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function preconditionsHash(preconditions = {}) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(preconditions))).digest('hex');
}


export function createRequestEffectDescriptor({
  request,
  kind,
  attempt = 1,
  logicalId = '',
  preconditions = {},
  causationId = '',
} = {}) {
  const effectKind = String(kind || '');
  const policy = STEP_POLICIES[effectKind];
  if (!policy) throw new Error(`Unknown request effect kind: ${effectKind}`);
  if (!request?.requestId || !request?.leaseId || !request?.ownerServerInstanceId) {
    throw new Error(`Request effect ${effectKind} requires a complete request identity`);
  }
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const identity = Object.freeze({
    requestId: String(request.requestId),
    leaseId: String(request.leaseId),
    ownerServerInstanceId: String(request.ownerServerInstanceId),
    responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
  });
  const normalizedPreconditions = Object.freeze({
    ...identity,
    ...(preconditions && typeof preconditions === 'object' ? canonicalValue(preconditions) : {}),
  });
  const idempotencyKey = String(logicalId || `${identity.requestId}:${effectKind}:responseEpoch:${identity.responseEpoch}`);
  return Object.freeze({
    kind: effectKind,
    effectId: `${idempotencyKey}:attempt:${normalizedAttempt}`,
    idempotencyKey,
    attempt: normalizedAttempt,
    retryPolicy: policy.retryPolicy,
    write: policy.write,
    preconditions: normalizedPreconditions,
    preconditionsHash: preconditionsHash(normalizedPreconditions),
    causationId: String(causationId || ''),
    responseEpoch: identity.responseEpoch,
  });
}

function attachmentProjection(attachments = []) {
  return Array.from(attachments || []).map((item) => ({
    id: String(item?.id || ''),
    name: String(item?.name || item?.filename || ''),
    size: Math.max(0, Number(item?.size) || 0),
    mime: String(item?.mime || item?.type || ''),
  }));
}

function preconditionsFor(kind, { request, message, options, attachments }) {
  const common = {
    requestId: request.requestId,
    leaseId: request.leaseId,
    ownerServerInstanceId: request.ownerServerInstanceId,
    responseEpoch: request.responseEpoch,
  };
  if (kind === 'session.apply') return {
    ...common,
    desiredSessionId: String(options?.sessionId || ''),
    newSession: Boolean(options?.newSession),
  };
  if (kind === 'model.apply') return {
    ...common,
    model: String(options?.model || ''),
    effort: String(options?.effort || ''),
  };
  if (kind === 'attachments.upload') return {
    ...common,
    attachments: attachmentProjection(attachments),
  };
  if (kind === 'prompt.submit') return {
    ...common,
    promptHash: requestTextHash(message),
    attachmentCount: Array.from(attachments || []).length,
  };
  return common;
}

export function createPromptExecutionPlan({ request, message = '', options = {}, attachments = [] } = {}) {
  if (!request?.requestId || !request?.leaseId || !request?.ownerServerInstanceId) {
    throw new Error('Prompt execution plan requires a complete request identity');
  }
  const kinds = ['page.ready.initial', 'session.apply', 'model.apply'];
  if (Array.from(attachments || []).length) kinds.push('attachments.upload');
  kinds.push('prompt.submit');
  const steps = kinds.map((kind, index) => {
    const logicalId = `${request.requestId}:${kind}`;
    const attempt = 1;
    const preconditions = Object.freeze(preconditionsFor(kind, { request, message, options, attachments }));
    return Object.freeze({
      stepId: kind,
      ordinal: index + 1,
      kind,
      effectId: `${logicalId}:attempt:${attempt}`,
      idempotencyKey: logicalId,
      attempt,
      retryPolicy: STEP_POLICIES[kind].retryPolicy,
      write: STEP_POLICIES[kind].write,
      preconditions,
      preconditionsHash: preconditionsHash(preconditions),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    requestId: request.requestId,
    startAtStepId: steps[0]?.stepId || '',
    steps: Object.freeze(steps),
  });
}

export function resumePromptExecutionPlan(plan, {
  effectId = '',
  effectType = '',
  mode = 'continue_after',
} = {}) {
  const source = plan && typeof plan === 'object' ? plan : null;
  if (!source || !Array.isArray(source.steps)) throw new Error('Prompt execution plan is unavailable');
  const index = source.steps.findIndex((step) => (effectId && step.effectId === effectId)
    || (effectType && step.kind === effectType));
  if (index < 0) throw new Error(`Prompt execution step was not found for ${effectId || effectType}`);
  const steps = source.steps.map((step, stepIndex) => {
    if (mode !== 'retry_same' || stepIndex !== index) return Object.freeze({ ...step });
    const attempt = Math.max(1, Number(step.attempt) || 1) + 1;
    return Object.freeze({
      ...step,
      attempt,
      effectId: `${step.idempotencyKey}:attempt:${attempt}`,
    });
  });
  const startIndex = mode === 'retry_same' ? index : index + 1;
  return Object.freeze({
    ...source,
    startAtStepId: steps[startIndex]?.stepId || '',
    steps: Object.freeze(steps),
  });
}
