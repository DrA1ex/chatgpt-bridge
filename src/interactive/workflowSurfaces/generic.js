import { renderHistoryRows } from './history.js';
import { renderFileDetails, renderFileGroups, renderPlanSummary } from './plan.js';
import { renderCheckResults, renderProgress } from './progress.js';
import {
  renderChoiceList,
  renderCommit,
  renderDeployment,
  renderSummaryFields,
} from './setup.js';
import {
  compactLines,
  fieldLines,
  literalWorkflowText,
  publicWorkflowText,
  scalarText,
  statusMarker,
} from './text.js';

function renderText(section = {}) {
  const body = section.text ?? section.body ?? section.message ?? section.content ?? '';
  return Array.isArray(body) ? body.map((line) => publicWorkflowText(line)) : publicWorkflowText(body).split(/\r?\n/);
}

function renderWarnings(section = {}) {
  const warnings = Array.isArray(section.warnings)
    ? section.warnings
    : Array.isArray(section.items) ? section.items : [];
  return warnings.map((warning) => {
    if (typeof warning === 'string') return `! ${publicWorkflowText(warning)}`;
    const code = warning?.code ? `[${publicWorkflowText(warning.code)}] ` : '';
    return `! ${code}${publicWorkflowText(warning?.message || warning?.summary || 'Warning')}`;
  });
}

function renderError(section = {}) {
  return compactLines([
    `× ${publicWorkflowText(section.title || section.code || 'Workflow error')}`,
    section.message || section.summary || section.detail || '',
    section.recoveryAction ? `Next: ${publicWorkflowText(section.recoveryAction)}` : '',
  ]);
}

function renderConflict(section = {}) {
  return compactLines([
    `! ${literalWorkflowText(section.path || section.title || 'Conflict')}`,
    section.summary || section.message || '',
    ...fieldLines(section.fields || []),
  ]);
}

export function renderWorkflowSection(section = {}) {
  const kind = String(section?.kind || section?.type || 'text');
  let lines;
  if (kind === 'text') lines = renderText(section);
  else if (kind === 'summary_fields') lines = renderSummaryFields(section);
  else if (kind === 'progress') lines = renderProgress(section);
  else if (kind === 'choice_list') lines = renderChoiceList(section);
  else if (kind === 'plan_summary') lines = renderPlanSummary(section);
  else if (kind === 'file_groups') lines = renderFileGroups(section);
  else if (kind === 'file_details') lines = renderFileDetails(section);
  else if (kind === 'conflict') lines = renderConflict(section);
  else if (kind === 'check_results') lines = renderCheckResults(section);
  else if (kind === 'commit') lines = renderCommit(section);
  else if (kind === 'deployment') lines = renderDeployment(section);
  else if (kind === 'history_rows') lines = renderHistoryRows(section);
  else if (kind === 'warning_list') lines = renderWarnings(section);
  else if (kind === 'error') lines = renderError(section);
  else lines = compactLines([
    section.title ? publicWorkflowText(section.title) : labelTextFallback(kind),
    section.summary || section.message || scalarText(section.value || ''),
  ]);
  const title = publicWorkflowText(section.title || section.label || '');
  return {
    id: String(section.id || ''),
    kind,
    title,
    lines: compactLines(title ? [title, ...lines] : lines),
  };
}

function labelTextFallback(kind) {
  return publicWorkflowText(String(kind || 'section').replace(/[_-]+/g, ' '));
}

export function renderWorkflowAction(action = {}) {
  return {
    id: String(action.id || ''),
    kind: String(action.kind || ''),
    label: publicWorkflowText(action.label || action.kind || 'Continue'),
    description: publicWorkflowText(action.description || ''),
    enabled: action.enabled !== false,
    disabledReason: publicWorkflowText(action.disabledReason || ''),
    risk: String(action.risk || 'read'),
    confirmation: String(action.confirmation || 'none'),
    role: String(action.presentation?.role || 'secondary'),
  };
}

export function renderGenericWorkflowSurface(surface = {}) {
  const sections = (Array.isArray(surface.sections) ? surface.sections : []).map(renderWorkflowSection);
  const summary = publicWorkflowText(surface.summary || '');
  return {
    id: String(surface.id || ''),
    kind: String(surface.kind || 'error'),
    revision: Math.max(0, Number(surface.revision) || 0),
    title: publicWorkflowText(surface.title || 'Workflow'),
    summary,
    stage: surface.stage && typeof surface.stage === 'object' ? {
      id: String(surface.stage.id || ''),
      index: Math.max(0, Number(surface.stage.index) || 0),
      count: Math.max(0, Number(surface.stage.count) || 0),
    } : null,
    sections,
    lines: compactLines([
      summary,
      ...sections.flatMap((section) => ['', ...section.lines]),
    ]),
    actions: (Array.isArray(surface.actions) ? surface.actions : []).map(renderWorkflowAction).filter((action) => action.id),
  };
}
