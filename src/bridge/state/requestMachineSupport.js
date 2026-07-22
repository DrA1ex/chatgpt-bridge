export function effectDomain(data = {}) {
  return String(data.effectDomain || data.domain || 'browser') === 'coordinator'
    ? 'coordinator'
    : 'browser';
}

export function effectSlot(state, domain) {
  return state?.effect?.[domain]
    || { activeId: null, activeType: null, startedAt: 0, lastResult: null };
}

export function withEffectSlot(state, domain, patch) {
  const current = effectSlot(state, domain);
  const nextSlot = { ...current, ...patch };
  return {
    ...state,
    effect: {
      browser: { ...(state.effect?.browser || {}) },
      coordinator: { ...(state.effect?.coordinator || {}) },
      [domain]: nextSlot,
    },
  };
}
