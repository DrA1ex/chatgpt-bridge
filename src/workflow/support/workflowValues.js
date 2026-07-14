import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function workflowId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

export function tailLines(text, count = 250) {
  return String(text || '').split(/\r?\n/).slice(-count).join('\n');
}

export function boundedText(value, maxChars = 200_000) {
  const text = String(value || '');
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[truncated by workflow state store]`
    : text;
}

export function compactValue(value, depth = 0) {
  if (typeof value === 'string') return boundedText(value, 16_000);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 5) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]),
  );
}

export function responseScope(response = {}) {
  return {
    turnKey: response.turnKey || response.sourceTurnKey || '',
    requestId: response.requestId || '',
    candidateIndex: response.candidateIndex || 0,
  };
}
