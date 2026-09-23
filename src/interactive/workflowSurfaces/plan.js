import {
  compactLines,
  labelText,
  literalWorkflowText,
  publicWorkflowText,
  scalarText,
  statusMarker,
} from './text.js';

const PLAN_COUNTS = Object.freeze([
  ['added', 'Added'],
  ['created', 'Added'],
  ['changed', 'Changed'],
  ['updated', 'Changed'],
  ['removed', 'Removed'],
  ['deleted', 'Removed'],
  ['unchanged', 'Unchanged'],
  ['conflicts', 'Conflicts'],
]);

function countSummary(source = {}) {
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : source;
  const seen = new Set();
  const parts = [];
  for (const [key, label] of PLAN_COUNTS) {
    if (seen.has(label) || !Number.isFinite(Number(counts[key]))) continue;
    seen.add(label);
    parts.push(`${label} ${Number(counts[key])}`);
  }
  return parts.join(' · ');
}

export function renderPlanSummary(section = {}) {
  const summary = publicWorkflowText(section.summary || countSummary(section));
  const lines = [summary];
  if (section.mode) lines.push(`Mode: ${labelText(section.mode)}`);
  if (section.root) lines.push(`Archive root: ${literalWorkflowText(section.root)}`);
  return compactLines(lines);
}

export function renderFileGroups(section = {}) {
  const groups = Array.isArray(section.groups)
    ? section.groups
    : Object.entries(section.files || {}).map(([kind, files]) => ({ kind, files }));
  const lines = [];
  for (const group of groups) {
    const files = Array.isArray(group?.files) ? group.files : Array.isArray(group?.items) ? group.items : [];
    lines.push(`${publicWorkflowText(group?.title || labelText(group?.kind || 'Files'))} (${files.length})`);
    for (const file of files) {
      const detail = typeof file === 'object'
        ? scalarText(file.summary || file.status || file.change || '')
        : '';
      const fileName = typeof file === 'string'
        ? literalWorkflowText(file)
        : literalWorkflowText(file?.path || file?.name || file?.id || 'file');
      lines.push(`  ${statusMarker(file?.status || group?.kind)} ${fileName}${detail ? ` · ${detail}` : ''}`);
    }
  }
  return compactLines(lines);
}

export function renderFileDetails(section = {}) {
  const file = section.file && typeof section.file === 'object' ? section.file : section;
  return compactLines([
    `${statusMarker(file.status || file.change)} ${literalWorkflowText(file.path || file.name || 'File')}`,
    file.status || file.change ? `Change: ${labelText(file.status || file.change)}` : '',
    Number.isFinite(Number(file.size)) ? `Size: ${Number(file.size)} bytes` : '',
    file.summary || file.description || '',
  ]);
}

export function renderWorkflowPlanPage(page = {}) {
  const lines = [
    publicWorkflowText(page.title || 'Files in this plan'),
    ...renderPlanSummary(page),
  ];
  if (Array.isArray(page.groups) || page.files) lines.push(...renderFileGroups(page));
  if (Array.isArray(page.items)) {
    lines.push(...renderFileGroups({ groups: [{ title: page.group || 'Files', files: page.items }] }));
  }
  if (page.nextCursor) lines.push('More files are available.');
  return compactLines(lines);
}
