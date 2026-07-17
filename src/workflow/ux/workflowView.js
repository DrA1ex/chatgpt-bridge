const ACTIVE_AUTOMATION = new Set(['validating', 'waiting_turn', 'applying', 'awaiting_approval']);
const TERMINAL_AUTOMATION = new Set(['completed', 'failed', 'stopped']);
const BLOCKING_AUTOMATION = new Set(['validating', 'applying']);
const ACTIVE_PIPELINE = new Set([
  'observed',
  'downloading',
  'verifying',
  'planning',
  'awaiting_approval',
  'applying',
  'remediating',
  'recovering',
  'rolling_back',
]);
const BLOCKING_PIPELINE = new Set([
  'downloading',
  'verifying',
  'planning',
  'applying',
  'remediating',
  'recovering',
  'rolling_back',
]);

function text(value) {
  return String(value || '').trim();
}

function shortId(value, keep = 18) {
  const id = text(value);
  if (!id || id.length <= keep) return id;
  return `${id.slice(0, keep - 1)}…`;
}

export function workflowRunActive(workflow = {}) {
  return Boolean(workflow.automationInterrupted || ACTIVE_AUTOMATION.has(text(workflow.automation?.status)));
}

export function workflowRunTerminal(workflow = {}) {
  return TERMINAL_AUTOMATION.has(text(workflow.automation?.status));
}

export function workflowHasBlockingAction(workflow = {}) {
  if (workflow.automationInterrupted) return false;
  const automationStatus = text(workflow.automation?.status);
  const pipelineStatus = text(workflow.pipeline?.status);
  return BLOCKING_AUTOMATION.has(automationStatus) || BLOCKING_PIPELINE.has(pipelineStatus);
}

export function workflowBoundSession(workflow = {}) {
  return text(workflow.automation?.evidence?.sessionId);
}

export function workflowStage(workflow = {}) {
  const automation = workflow.automation || {};
  const pipeline = workflow.pipeline || {};
  if (workflow.attention?.required) return { key: 'waiting_for_decision', label: 'Waiting for your decision', tone: 'yellow' };
  if (workflow.automationInterrupted) return { key: 'interrupted', label: 'Paused', tone: 'yellow' };
  if (automation.status === 'validating') return { key: 'validating', label: 'Running project checks', tone: 'cyan' };
  if (automation.status === 'waiting_turn') return { key: 'waiting_chatgpt', label: 'Waiting for ChatGPT', tone: 'yellow' };
  if (automation.status === 'awaiting_approval' || pipeline.status === 'awaiting_approval') {
    return { key: 'awaiting_approval', label: 'Waiting for your decision', tone: 'yellow' };
  }
  if (automation.status === 'applying') return { key: 'applying', label: 'Applying changes', tone: 'cyan' };
  if (automation.status === 'completed') return { key: 'succeeded', label: 'Completed', tone: 'green' };
  if (automation.status === 'failed') return { key: 'failed', label: 'Stopped with an error', tone: 'red' };
  if (automation.status === 'stopped') return { key: 'stopped', label: 'Stopped', tone: 'gray' };

  const passiveLabels = {
    observed: 'Checking the ChatGPT response',
    downloading: 'Downloading returned files',
    verifying: 'Checking returned files',
    planning: 'Preparing changes',
    applying: 'Applying changes',
    remediating: 'Requesting a corrected result',
    recovering: 'Starting a new ChatGPT chat',
    rolling_back: 'Restoring the previous project state',
    completed: 'Last update completed',
    failed: 'Last update stopped with an error',
    rejected: 'Last update was rejected',
  };
  if (passiveLabels[pipeline.status]) {
    const tone = pipeline.status === 'completed' ? 'green' : ['failed', 'rejected'].includes(pipeline.status) ? 'red' : 'cyan';
    return { key: pipeline.status, label: passiveLabels[pipeline.status], tone };
  }
  return { key: 'idle', label: 'Idle', tone: 'gray' };
}

export function workflowNextActions(workflow = {}) {
  const stage = workflowStage(workflow).key;
  if (workflow.attention?.required) return ['Open /workflow to choose what happens next'];
  if (stage === 'interrupted') return ['Open /workflow to resume or discard the interrupted run'];
  if (stage === 'awaiting_approval' || stage === 'waiting_for_decision') return ['Open /workflow to review the pending decision'];
  if (workflowRunActive(workflow)) return ['Open /workflow to inspect, pause, or stop this workflow'];
  return ['Open /workflow to continue or start another workflow'];
}

export function selectWorkflow(workflows = [], token = '') {
  const items = Array.isArray(workflows) ? workflows : [];
  const value = text(token);
  if (value) {
    const exact = items.find((item) => item.id === value);
    if (!exact) throw new Error(`Unknown workflow: ${value}`);
    return exact;
  }
  if (items.length === 1) return items[0];
  if (!items.length) return null;
  throw new Error('Multiple workflows are loaded. Specify a workflow id.');
}

export function resolveWorkflowApproval(approvals = [], workflowId = '', approvalId = '') {
  const pending = (Array.isArray(approvals) ? approvals : []).filter((item) => item?.status === 'pending');
  const explicit = text(approvalId);
  if (explicit) {
    const item = pending.find((approval) => approval.id === explicit);
    if (!item) throw new Error(`Unknown pending workflow approval: ${explicit}`);
    return item;
  }
  const scoped = pending.filter((approval) => !workflowId || approval.workflowId === workflowId);
  if (scoped.length === 1) return scoped[0];
  if (!scoped.length) throw new Error('No pending approval for this workflow.');
  throw new Error('Multiple approvals are pending. Use /workflow show and specify an approval id.');
}

export function workflowDashboard(workflow = {}, options = {}) {
  const stage = workflowStage(workflow);
  const currentSessionId = text(options.currentSessionId);
  const boundSessionId = workflowBoundSession(workflow);
  const nextSession = workflow.sessionPolicy === 'pinned'
    ? text(workflow.pinnedSessionId)
    : workflow.sessionPolicy === 'new'
      ? '(new session)'
      : currentSessionId || '(current browser tab)';
  const approval = (Array.isArray(options.approvals) ? options.approvals : [])
    .find((item) => item.status === 'pending' && item.workflowId === workflow.id) || null;
  return {
    id: text(workflow.id),
    goal: text(workflow.label || workflow.ux?.label || workflow.preset || workflow.id),
    projectRoot: text(workflow.projectRoot),
    configPath: text(workflow.configPath),
    stage,
    runId: text(workflow.automation?.id),
    cycle: Number(workflow.automation?.cycle) || 0,
    maxCycles: Number(workflow.automation?.maxCycles) || 0,
    boundSessionId,
    currentSessionId,
    nextSession,
    sessionPolicy: text(workflow.sessionPolicy || 'current'),
    restartPolicy: text(workflow.restartPolicy || 'ask'),
    error: text(workflow.automation?.error || workflow.lastError || workflow.pipeline?.terminal?.message),
    reportDir: text(workflow.automation?.reportDir),
    approval,
    attention: workflow.attention || null,
    checkpointCount: Array.isArray(workflow.workflowCommitShas) ? workflow.workflowCommitShas.length : 0,
    projectSync: workflow.contextSyncFingerprint ? 'Up to date' : 'Not uploaded yet',
    actions: workflowNextActions(workflow),
    blocking: workflowHasBlockingAction(workflow),
    active: workflowRunActive(workflow),
  };
}

export function formatWorkflowDashboard(workflow = {}, options = {}) {
  const view = workflowDashboard(workflow, options);
  const lines = [
    `WORKFLOW · ${view.goal}`,
    '',
    `Current step:  ${view.stage.label}`,
    `Project sync:  ${view.projectSync}`,
    `Commits:       ${view.checkpointCount ? `${view.checkpointCount} checkpoint${view.checkpointCount === 1 ? '' : 's'}` : 'No checkpoints'}`,
    `Action needed: ${view.attention?.required ? 'Yes' : 'No'}`,
  ];
  if (view.runId) lines.push(`Run:      ${view.runId}`);
  if (view.cycle || view.maxCycles) lines.push(`Cycle:    ${view.cycle || 0}/${view.maxCycles || '?'}`);
  if (view.boundSessionId) lines.push(`Session:  ${view.boundSessionId}`);
  else if (!view.active) lines.push(`Next run: ${view.nextSession}`);
  if (view.error) lines.push(`Reason:   ${view.error}`);
  if (view.approval?.plan) {
    const plan = view.approval.plan;
    const counts = plan.counts || {};
    lines.push('', 'Changes ready:');
    lines.push(`  create ${counts.create || 0} · update ${counts.update || 0} · delete ${counts.delete || 0}`);
    if (Array.isArray(plan.policyReasons) && plan.policyReasons.length) {
      lines.push(`  warning: ${plan.policyReasons.join('; ')}`);
    }
  }
  lines.push('', 'Actions:');
  for (const action of view.actions) lines.push(`  ${action}`);
  return lines.join('\n');
}

export function workflowListLines(workflows = []) {
  const items = Array.isArray(workflows) ? workflows : [];
  if (!items.length) return ['No workflows are loaded.'];
  return items.map((workflow, index) => {
    const stage = workflowStage(workflow);
    const cycle = Number(workflow.automation?.cycle) || 0;
    const maxCycles = Number(workflow.automation?.maxCycles) || 0;
    const suffix = cycle || maxCycles ? ` · cycle ${cycle}/${maxCycles || '?'}` : '';
    return `${index + 1}. ${workflow.id} · ${stage.label}${suffix}`;
  });
}

export function workflowHistoryFromEvents(events = [], limit = 10) {
  const runs = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const type = text(event.type);
    if (!type.startsWith('workflow.automation.')) continue;
    const automationId = text(event.data?.automationId);
    if (!automationId) continue;
    const current = runs.get(automationId) || {
      id: automationId,
      status: 'running',
      startedAt: '',
      endedAt: '',
      cycle: 0,
      maxCycles: 0,
      error: '',
    };
    current.cycle = Math.max(current.cycle, Number(event.data?.cycle) || 0);
    current.maxCycles = Math.max(current.maxCycles, Number(event.data?.maxCycles) || 0);
    if (type === 'workflow.automation.started') current.startedAt = text(event.time);
    if (type === 'workflow.automation.completed') {
      current.status = 'succeeded';
      current.endedAt = text(event.time);
    } else if (type === 'workflow.automation.failed') {
      current.status = 'failed';
      current.endedAt = text(event.time);
      current.error = text(event.data?.message || event.data?.error);
    } else if (type === 'workflow.automation.stopped') {
      current.status = 'stopped';
      current.endedAt = text(event.time);
      current.error = text(event.data?.reason);
    } else if (type === 'workflow.automation.interrupted') {
      current.status = 'interrupted';
      current.endedAt = text(event.time);
    }
    runs.set(automationId, current);
  }
  return Array.from(runs.values())
    .sort((a, b) => text(b.startedAt || b.endedAt).localeCompare(text(a.startedAt || a.endedAt)))
    .slice(0, Math.max(1, Number(limit) || 10));
}

export function formatWorkflowHistory(history = []) {
  if (!history.length) return 'No workflow runs have been recorded.';
  const lines = ['Recent workflow runs'];
  for (const [index, item] of history.entries()) {
    const cycle = item.cycle ? ` · cycle ${item.cycle}${item.maxCycles ? `/${item.maxCycles}` : ''}` : '';
    lines.push(`${index + 1}. ${shortId(item.id)} · ${item.status.toUpperCase()}${cycle}`);
    if (item.error) lines.push(`   ${item.error}`);
  }
  return lines.join('\n');
}
