export function normalizeSelectionValue(value = '') {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function selectionOptionMatches(option = {}, desired = '') {
  const wanted = normalizeSelectionValue(desired);
  if (!wanted) return false;

  const value = normalizeSelectionValue(option?.value || '');
  const label = normalizeSelectionValue(option?.label || '');
  const rawText = normalizeSelectionValue(option?.rawText || '');
  const id = normalizeSelectionValue(option?.id || '');

  if ([value, label, rawText, id].some((candidate) => candidate && candidate === wanted)) return true;

  // IDs commonly include a structural prefix such as `model-` or `effort-`.
  // Match the complete desired value at the end, but never treat one visible
  // option label as equal to a longer label merely because it is a prefix.
  return Boolean(id && id.endsWith(` ${wanted}`));
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
