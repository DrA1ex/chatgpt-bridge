import {
  compactLines,
  formatDuration,
  literalWorkflowText,
  publicWorkflowText,
  statusMarker,
} from './text.js';

export function renderProgress(section = {}) {
  const completed = Number(section.completed);
  const total = Number(section.total);
  const percent = Number.isFinite(Number(section.percent))
    ? Math.max(0, Math.min(100, Math.round(Number(section.percent))))
    : Number.isFinite(completed) && Number.isFinite(total) && total > 0
      ? Math.round((completed / total) * 100)
      : null;
  return compactLines([
    `${statusMarker(section.status)} ${publicWorkflowText(section.label || section.phase || 'Working')}${percent == null ? '' : ` · ${percent}%`}`,
    Number.isFinite(completed) && Number.isFinite(total) ? `${completed} of ${total} complete` : '',
    section.message || section.detail || '',
  ]);
}

export function renderCheckResults(section = {}) {
  const checks = Array.isArray(section.checks)
    ? section.checks
    : Array.isArray(section.results) ? section.results : [];
  const lines = [];
  const summary = section.summary || (
    checks.length
      ? `${checks.filter((check) => ['passed', 'success', 'succeeded'].includes(String(check?.status || '').toLowerCase())).length} of ${checks.length} checks passed`
      : ''
  );
  if (summary) lines.push(publicWorkflowText(summary));
  for (const check of checks) {
    const duration = formatDuration(check?.durationMs);
    const detail = literalWorkflowText(check?.summary || check?.message || check?.status);
    const name = literalWorkflowText(check?.label || check?.name || check?.id || 'Project check');
    lines.push(`${statusMarker(check?.status)} ${name}${detail ? ` · ${detail}` : ''}${duration ? ` · ${duration}` : ''}`);
  }
  if (section.truncated) lines.push('Output is truncated. Open the linked check output for more.');
  return compactLines(lines);
}
