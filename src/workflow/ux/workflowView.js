import { workflowActionLabels } from './workflowActions.js';

function text(value) { return String(value || '').trim(); }
function shortId(value, keep = 18) { const id = text(value); return !id || id.length <= keep ? id : `${id.slice(0, keep - 1)}…`; }

const PHASE_LABELS = Object.freeze({
  none: ['Idle', 'gray'], observing: ['Checking the ChatGPT response', 'cyan'], context_sync: ['Synchronizing project context', 'cyan'],
  checking: ['Running project checks', 'cyan'], prompting: ['Sending request to ChatGPT', 'cyan'], waiting_response: ['Waiting for ChatGPT', 'yellow'],
  downloading: ['Downloading returned files', 'cyan'], verifying: ['Checking returned files', 'cyan'], planning: ['Preparing changes', 'cyan'],
  applying: ['Applying changes', 'cyan'], committing: ['Creating commit', 'cyan'], remediating: ['Requesting a corrected result', 'yellow'], rolling_back: ['Restoring the previous project state', 'yellow'],
});

export function workflowRunActive(workflow = {}) { return ['running', 'recovering', 'waiting_action', 'paused'].includes(text(workflow.lifecycle)); }
export function workflowWatcherActive(workflow = {}) { return text(workflow.lifecycle) !== 'stopped' && Boolean(workflow.execution?.subscription?.enabled); }
export function workflowActive(workflow = {}) { return text(workflow.lifecycle) !== 'stopped'; }
export function workflowRunTerminal(workflow = {}) { return Boolean(workflow.lastOutcome) && !workflow.run?.id; }
export function workflowHasBlockingAction(workflow = {}) { return text(workflow.lifecycle) === 'waiting_action'; }
export function workflowBoundSession(workflow = {}) { return text(workflow.binding?.sessionId || workflow.run?.source?.sessionId || workflow.pinnedSessionId); }

export function workflowStage(workflow = {}) {
  const lifecycle = text(workflow.lifecycle);
  if (lifecycle === 'waiting_action') return { key: 'waiting_action', label: 'Waiting for your decision', tone: 'yellow' };
  if (lifecycle === 'recovering') return { key: 'recovering', label: 'Recovering workflow state', tone: 'yellow' };
  if (lifecycle === 'paused') return { key: 'paused', label: 'Paused', tone: 'yellow' };
  if (lifecycle === 'stopped') return { key: 'stopped', label: 'Stopped', tone: 'gray' };
  const phase = text(workflow.phase || workflow.run?.phase);
  if (lifecycle === 'running' && PHASE_LABELS[phase]) return { key: phase, label: PHASE_LABELS[phase][0], tone: PHASE_LABELS[phase][1] };
  if (workflowWatcherActive(workflow)) return workflow.preset === 'guided-task'
    ? { key: 'guided_ready', label: 'Ready for your next prompt', tone: 'green' }
    : { key: 'watching', label: 'Watching the ChatGPT tab', tone: 'green' };
  if (workflow.lastOutcome?.status === 'completed') return { key: 'completed', label: 'Last run completed', tone: 'green' };
  return { key: 'ready', label: 'Ready', tone: 'gray' };
}

export function workflowNextActions(workflow = {}) {
  const decisions = workflowActionLabels(workflow).map((item) => item.label);
  if (decisions.length) return decisions;
  const stage = workflowStage(workflow).key;
  if (stage === 'watching') return ['Continue chatting in the selected ChatGPT browser tab; Bridge is watching for completed responses.'];
  if (stage === 'guided_ready') return ['Type your next prompt in Bridge while this guided workflow is focused.'];
  if (stage === 'paused') return ['Open /workflow to resume or stop this workflow.'];
  return ['Open /workflow to inspect or start this workflow.'];
}

export function selectWorkflow(workflows = [], token = '') {
  const items = Array.isArray(workflows) ? workflows : []; const value = text(token);
  if (value) { const exact = items.find((item) => item.id === value); if (!exact) throw new Error(`Unknown workflow: ${value}`); return exact; }
  if (items.length <= 1) return items[0] || null;
  throw new Error('Multiple workflows are loaded. Specify a workflow id.');
}

export function workflowDashboard(workflow = {}, options = {}) {
  const stage = workflowStage(workflow); const run = workflow.run || {}; const boundSessionId = workflowBoundSession(workflow);
  return {
    id: text(workflow.id), goal: text(workflow.label || workflow.ux?.label || workflow.preset || workflow.id), projectRoot: text(workflow.projectRoot), configPath: text(workflow.configPath),
    stage, runId: text(run.id), cycle: Number(run.cycle) || 0, maxCycles: Number(run.maxCycles) || 0, boundSessionId,
    nextSession: workflow.sessionPolicy === 'pinned' ? text(workflow.pinnedSessionId) : text(options.currentSessionId) || '(current browser tab)',
    error: text(workflow.lastOutcome?.message), reportDir: text(run.references?.reportDir), action: workflow.nextAction || null,
    actions: workflowNextActions(workflow), blocking: workflowHasBlockingAction(workflow), active: workflowActive(workflow),
  };
}

export function formatWorkflowDashboard(workflow = {}, options = {}) {
  const view = workflowDashboard(workflow, options);
  const lines = [`WORKFLOW · ${view.goal}`, '', `Current step:  ${view.stage.label}`, `Action needed: ${view.action ? 'Yes' : 'No'}`];
  if (view.runId) lines.push(`Run:      ${view.runId}`);
  if (view.cycle || view.maxCycles) lines.push(`Cycle:    ${view.cycle}/${view.maxCycles || '?'}`);
  if (view.boundSessionId) lines.push(`Session:  ${view.boundSessionId}`);
  if (view.error) lines.push(`Reason:   ${view.error}`);
  lines.push('', 'Actions:', ...view.actions.map((item) => `  ${item}`));
  return lines.join('\n');
}

export function workflowListLines(workflows = []) {
  const items = Array.isArray(workflows) ? workflows : [];
  return items.length ? items.map((workflow, index) => `${index + 1}. ${workflow.id} · ${workflowStage(workflow).label}`) : ['No workflows are loaded.'];
}

export function workflowHistoryFromEvents(events = [], limit = 10) {
  return (Array.isArray(events) ? events : []).filter((event) => ['run.started', 'run.completed', 'run.failed'].includes(text(event.type))).slice(-Math.max(1, Number(limit) || 10)).reverse().map((event) => ({ id: text(event.data?.runId), status: text(event.type).replace('run.', ''), startedAt: text(event.time), error: text(event.data?.message) }));
}

export function formatWorkflowHistory(history = []) {
  if (!history.length) return 'No workflow runs have been recorded.';
  return ['Recent workflow runs', ...history.map((item, index) => `${index + 1}. ${shortId(item.id)} · ${item.status.toUpperCase()}${item.error ? `\n   ${item.error}` : ''}`)].join('\n');
}
