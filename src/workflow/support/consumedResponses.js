function text(value) {
  return String(value ?? '').trim();
}

export function workflowResponseIdentity(response = {}) {
  const turnKey = text(response.turnKey || response.sourceTurnKey);
  if (turnKey) return `turn:${turnKey}`;
  const requestId = text(response.requestId || response.sourceRequestId);
  return requestId ? `request:${requestId}` : '';
}

export function rememberWorkflowResponse(runtime, response = {}, { limit = 200 } = {}) {
  const identity = workflowResponseIdentity(response);
  if (!identity) return '';
  if (!(runtime.consumedResponseIdentities instanceof Set)) runtime.consumedResponseIdentities = new Set();
  runtime.consumedResponseIdentities.add(identity);
  while (runtime.consumedResponseIdentities.size > limit) {
    runtime.consumedResponseIdentities.delete(runtime.consumedResponseIdentities.values().next().value);
  }
  return identity;
}

export function workflowResponseWasConsumed(runtime, response = {}) {
  const identity = workflowResponseIdentity(response);
  return Boolean(identity
    && runtime.consumedResponseIdentities instanceof Set
    && runtime.consumedResponseIdentities.has(identity));
}

export function forgetWorkflowResponse(runtime, responseOrIdentity = {}) {
  const identity = typeof responseOrIdentity === 'string'
    ? responseOrIdentity
    : workflowResponseIdentity(responseOrIdentity);
  if (identity && runtime.consumedResponseIdentities instanceof Set) {
    runtime.consumedResponseIdentities.delete(identity);
  }
  return identity;
}
