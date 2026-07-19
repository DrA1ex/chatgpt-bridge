export function workflowBinding(runtime = {}) {
  const binding = runtime.workflowState?.binding;
  if (binding && typeof binding === 'object') {
    return {
      clientId: String(binding.clientId || ''),
      sessionId: String(binding.sessionId || ''),
      epoch: Math.max(0, Number(binding.epoch) || 0),
    };
  }
  return {
    clientId: String(runtime.config?.watch?.clientId || ''),
    sessionId: String(runtime.config?.watch?.sessionId || ''),
    epoch: 0,
  };
}

export function workflowSourceClientId(runtime, explicit = '', { allowLast = true } = {}) {
  return String(explicit || workflowBinding(runtime).clientId || (allowLast ? runtime?.lastSourceClientId : '') || '');
}

export function workflowSessionId(runtime, explicit = '', { allowLast = true } = {}) {
  return String(explicit || workflowBinding(runtime).sessionId || (allowLast ? runtime?.lastSessionId : '') || '');
}
