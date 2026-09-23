import {
  compactLines,
  fieldLines,
  literalWorkflowText,
  namedItem,
  scalarText,
  statusMarker,
} from './text.js';

export function renderSummaryFields(section = {}) {
  return fieldLines(section.fields || section.values || section.items || []);
}

export function renderChoiceList(section = {}) {
  const choices = Array.isArray(section.choices)
    ? section.choices
    : Array.isArray(section.items) ? section.items : [];
  return compactLines(choices.map((choice) => {
    const selected = choice?.selected || choice?.active;
    const detail = scalarText(choice?.description || choice?.detail || '');
    return `${selected ? '●' : '○'} ${namedItem(choice, 'Choice')}${detail ? ` · ${detail}` : ''}`;
  }));
}

export function renderCommit(section = {}) {
  return compactLines([
    section.message ? `Commit message: ${literalWorkflowText(section.message)}` : '',
    section.policy ? `Policy: ${scalarText(section.policy)}` : '',
    section.status ? `${statusMarker(section.status)} ${scalarText(section.status)}` : '',
    section.summary || section.description || '',
  ]);
}

export function renderDeployment(section = {}) {
  return compactLines([
    section.name || section.target ? `Deployment: ${literalWorkflowText(section.name || section.target)}` : 'Deployment',
    section.status ? `${statusMarker(section.status)} ${scalarText(section.status)}` : '',
    section.summary || section.description || '',
  ]);
}
