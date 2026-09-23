import {
  compactLines,
  formatDuration,
  namedItem,
  publicWorkflowText,
  scalarText,
  statusMarker,
} from './text.js';

export function renderHistoryRows(section = {}) {
  const rows = Array.isArray(section.rows)
    ? section.rows
    : Array.isArray(section.items) ? section.items : [];
  return compactLines(rows.map((row) => {
    const time = publicWorkflowText(row?.finishedAt || row?.createdAt || row?.startedAt || '');
    const detail = scalarText(row?.summary || row?.kind || row?.status);
    return `${statusMarker(row?.status)} ${namedItem(row, 'Run')}${detail ? ` · ${detail}` : ''}${time ? ` · ${time}` : ''}`;
  }));
}

export function renderRunDetails(run = {}) {
  return compactLines([
    publicWorkflowText(run.title || run.label || `Run ${run.runId || run.id || ''}`),
    run.status ? `Status: ${scalarText(run.status)}` : '',
    run.kind ? `Kind: ${scalarText(run.kind)}` : '',
    run.summary || '',
    Number.isFinite(Number(run.durationMs)) ? `Duration: ${formatDuration(run.durationMs)}` : '',
    run.operationId ? `Operation: ${publicWorkflowText(run.operationId)}` : '',
  ]);
}

export function renderWorkflowHistoryPage(page = {}) {
  const lines = [
    publicWorkflowText(page.title || 'History'),
    ...renderHistoryRows(page),
  ];
  if (page.nextCursor) lines.push('More history is available.');
  return compactLines(lines);
}
