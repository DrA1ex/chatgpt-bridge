export function normalizeAssistantText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/[\u2026.。]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isInterimAssistantText(text) {
  const normalized = normalizeAssistantText(text).toLowerCase();

  return [
    'thinking',
    'think',
    'думаю',
    'размышляю',
  ].includes(normalized);
}

export function isUsableFinalAssistantText(text) {
  return Boolean(normalizeAssistantText(text)) && !isInterimAssistantText(text);
}
