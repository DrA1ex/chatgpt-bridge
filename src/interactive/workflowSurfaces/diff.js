import { compactLines, literalWorkflowText } from './text.js';

function diffKind(line = {}) {
  const value = String(line.kind || line.type || '').toLowerCase();
  if (['add', 'added', 'insert'].includes(value)) return 'add';
  if (['remove', 'removed', 'delete'].includes(value)) return 'remove';
  return 'context';
}

function lineText(line = {}) {
  return literalWorkflowText(line.text ?? line.content ?? line.value ?? '');
}

function lineNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? String(number) : '';
}

export function renderUnifiedDiff(diff = {}) {
  const lines = [diff.path ? `File: ${literalWorkflowText(diff.path)}` : ''];
  for (const hunk of Array.isArray(diff.hunks) ? diff.hunks : []) {
    const oldCount = Number(hunk.oldCount) || 0;
    const newCount = Number(hunk.newCount) || 0;
    lines.push(`@@ -${Number(hunk.oldStart) || 0},${oldCount} +${Number(hunk.newStart) || 0},${newCount} @@`);
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      const kind = diffKind(line);
      lines.push(`${kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '}${lineText(line)}`);
    }
  }
  if (diff.truncated) lines.push('Diff is truncated.');
  return compactLines(lines);
}

export function renderSideBySideDiff(diff = {}, { columnWidth = 48 } = {}) {
  const width = Math.max(12, Number(columnWidth) || 48);
  const lines = [diff.path ? `File: ${literalWorkflowText(diff.path)}` : ''];
  const fit = (value) => Array.from(String(value || '')).slice(0, width).join('').padEnd(width, ' ');
  for (const hunk of Array.isArray(diff.hunks) ? diff.hunks : []) {
    lines.push(`@@ ${Number(hunk.oldStart) || 0} → ${Number(hunk.newStart) || 0} @@`);
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      const kind = diffKind(line);
      const content = lineText(line);
      const left = kind === 'add' ? '' : `${lineNumber(line.oldLine)} ${content}`;
      const right = kind === 'remove' ? '' : `${lineNumber(line.newLine)} ${content}`;
      lines.push(`${fit(left)} │ ${fit(right)}`);
    }
  }
  if (diff.truncated) lines.push('Diff is truncated.');
  return compactLines(lines);
}

export function renderWorkflowDiff(diff = {}, options = {}) {
  return options.mode === 'side-by-side'
    ? renderSideBySideDiff(diff, options)
    : renderUnifiedDiff(diff);
}
