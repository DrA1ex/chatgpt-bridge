const text = (value) => String(value ?? '').trim();

function selectedValue(option = {}) {
  return text(option.value || option.label || option.id);
}

export function modelsListResult(intelligence = {}) {
  return {
    models: Array.isArray(intelligence.models) ? intelligence.models : [],
    current: intelligence.selectedModel || null,
    intelligence,
  };
}

export function effortsListResult(intelligence = {}) {
  return {
    efforts: Array.isArray(intelligence.efforts) ? intelligence.efforts : [],
    current: intelligence.selectedEffort || null,
    intelligence,
  };
}

export function intelligenceApplyResult(intelligence = {}, options = {}) {
  const requestedModel = text(options.model);
  const requestedEffort = text(options.effort);
  return {
    model: requestedModel || selectedValue(intelligence.selectedModel),
    effort: requestedEffort || selectedValue(intelligence.selectedEffort),
    modelApplied: Boolean(requestedModel),
    effortApplied: Boolean(requestedEffort),
    warnings: [],
    intelligence,
  };
}

export function preparationEffectResult(kind, { intelligence = null, options = {}, attachments = [], session = null } = {}) {
  if (kind === 'model.apply') return intelligenceApplyResult(intelligence || {}, options);
  if (kind === 'attachments.upload') {
    return {
      completed: true,
      uploaded: Array.isArray(attachments) ? attachments.length : 0,
      attachments: Array.isArray(attachments) ? attachments : [],
    };
  }
  if (kind === 'session.apply') return { completed: true, session };
  return { completed: true };
}

export function effectEnvelopeOptions(envelope = {}, step = {}, request = null) {
  return {
    commandId: text(envelope.commandId) || null,
    effectId: text(step.effectId) || null,
    request,
    causationId: text(envelope.messageId) || null,
  };
}

export function steerEffectResult({ request = {}, body = {}, step = {}, submittedUserTurnKey = '' } = {}) {
  const previousResponseEpoch = Math.max(0, Number(request.responseEpoch) || 0);
  const targetResponseEpoch = Math.max(
    previousResponseEpoch + 1,
    Number(body.responseEpoch ?? step.preconditions?.targetResponseEpoch) || 0,
  );
  return {
    submitted: true,
    submittedUserTurnKey: text(submittedUserTurnKey),
    previousResponseEpoch,
    targetResponseEpoch,
  };
}
