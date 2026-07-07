export function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function makeRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendOnlyDelta(previous, next) {
  const normalizedNext = String(next || '');
  const normalizedPrevious = String(previous || '');

  if (!normalizedNext || normalizedNext === normalizedPrevious) return '';
  if (!normalizedPrevious) return normalizedNext;
  if (normalizedNext.startsWith(normalizedPrevious)) return normalizedNext.slice(normalizedPrevious.length);
  return '';
}

export function deltaFromPrevious(previous, next) {
  return appendOnlyDelta(previous, next);
}
