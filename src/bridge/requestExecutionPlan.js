import { createHash } from 'node:crypto';

const STEP_POLICIES = Object.freeze({
  'page.ready.initial': Object.freeze({ retryPolicy: 'always', write: false }),
  'session.apply': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'model.apply': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'attachments.upload': Object.freeze({ retryPolicy: 'if_unconfirmed', write: true }),
  'prompt.submit': Object.freeze({ retryPolicy: 'never', write: true }),
});

function promptHash(message = '') {
  return createHash('sha256').update(String(message || '')).digest('hex');
}


function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function preconditionsHash(preconditions = {}) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(preconditions))).digest('hex');
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
    promptHash: promptHash(message),
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
