export function normalizeSelectionValue(value = '') {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function selectionOptionMatches(option = {}, desired = '') {
  const wanted = normalizeSelectionValue(desired);
  const candidate = normalizeSelectionValue(`${option?.value || ''} ${option?.label || ''} ${option?.rawText || ''} ${option?.id || ''}`);
  return Boolean(wanted && candidate && (candidate.includes(wanted) || wanted.includes(normalizeSelectionValue(option?.label || ''))));
}

export function optionLabel(option = {}) {
  return String(option?.value || option?.label || option?.rawText || option?.id || '').trim();
}

export function selectedOption(payload = {}, listKey = '') {
  return payload?.current || (Array.isArray(payload?.[listKey]) ? payload[listKey].find((option) => option?.selected) : null) || null;
}

export function intelligenceSnapshotFromApplied(applied = {}, fallback = {}) {
  const intelligence = applied?.intelligence && typeof applied.intelligence === 'object' ? applied.intelligence : {};
  const models = Array.isArray(intelligence.models) && intelligence.models.length ? intelligence.models : (fallback.models || []);
  const efforts = Array.isArray(intelligence.efforts) && intelligence.efforts.length ? intelligence.efforts : (fallback.efforts || []);
  const currentModel = intelligence.selectedModel || models.find((option) => option?.selected) || fallback.currentModel || null;
  const currentEffort = intelligence.selectedEffort || efforts.find((option) => option?.selected) || fallback.currentEffort || null;
  return { models, efforts, currentModel, currentEffort, intelligence };
}

export function explicitSelectionCases(options) {
  const models = options.models.length ? options.models : [''];
  const efforts = options.efforts.length ? options.efforts : [''];
  const result = [];
  for (const model of models) for (const effort of efforts) result.push({ model, effort, mode: 'explicit' });
  if (result.length > 12) throw new Error(`Refusing to run ${result.length} model/effort combinations; limit is 12`);
  return result;
}

export function alternativeSelectionOption(options = [], current = null) {
  return (Array.isArray(options) ? options : []).find((option) => {
    if (!option || option.disabled) return false;
    const label = optionLabel(option);
    return label && !selectionOptionMatches(current || {}, label);
  }) || null;
}
