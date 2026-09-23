const IMPLEMENTATION_BRAND = /\bzipflow(?:\s+server)?\b/gi;

export function literalWorkflowText(value, fallback = '') {
  const source = value == null ? fallback : value;
  return String(source)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '');
}

export function publicWorkflowText(value, fallback = '') {
  return literalWorkflowText(value, fallback).replace(IMPLEMENTATION_BRAND, 'Workflow');
}

export function scalarText(value, fallback = '') {
  if (value == null || value === '') return publicWorkflowText(fallback);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((item) => scalarText(item)).join(', ');
  if (typeof value === 'object') return publicWorkflowText(value.label || value.name || value.id || fallback);
  return publicWorkflowText(value);
}

export function labelText(value) {
  return publicWorkflowText(String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()));
}

export function formatDuration(durationMs) {
  const milliseconds = Number(durationMs);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function fieldLines(fields = []) {
  const entries = Array.isArray(fields)
    ? fields
    : fields && typeof fields === 'object'
      ? Object.entries(fields).map(([label, value]) => ({ label, value }))
      : [];
  return entries.map((field) => {
    const source = field && typeof field === 'object' ? field : { value: field };
    const label = publicWorkflowText(source.label || source.name || source.id || 'Value');
    return `${label}: ${scalarText(source.value ?? source.text ?? source.status, '—')}`;
  });
}

export function namedItem(item = {}, fallback = 'Item') {
  if (typeof item === 'string') return publicWorkflowText(item);
  return publicWorkflowText(item.label || item.name || item.path || item.id || fallback);
}

export function statusMarker(status = '') {
  const value = String(status || '').toLowerCase();
  if (['passed', 'success', 'succeeded', 'completed', 'done', 'unchanged'].includes(value)) return '✓';
  if (['failed', 'error', 'uncertain'].includes(value)) return '×';
  if (['running', 'active', 'checking', 'applying', 'inspecting'].includes(value)) return '●';
  if (['warning', 'blocked', 'waiting_action'].includes(value)) return '!';
  return '•';
}

export function compactLines(lines = []) {
  const output = [];
  for (const line of lines.flat(Infinity)) {
    const value = literalWorkflowText(line);
    if (value || (output.length && output.at(-1) !== '')) output.push(value);
  }
  while (output.at(-1) === '') output.pop();
  return output;
}
