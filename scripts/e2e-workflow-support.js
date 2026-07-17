export function buildPassivePromptBody({ message, sessionId, sourceClientId, effort, timeoutMs = 0 } = {}) {
  if (effort === undefined) throw new Error('Passive workflow prompt effort must be passed explicitly');
  const prompt = String(message || '');
  const session = String(sessionId || '');
  const client = String(sourceClientId || '');
  if (!prompt) throw new Error('Passive workflow prompt message is required');
  if (!session) throw new Error('Passive workflow prompt sessionId is required');
  if (!client) throw new Error('Passive workflow prompt sourceClientId is required');
  return {
    message: prompt,
    sessionId: session,
    sourceClientId: client,
    effort: String(effort || ''),
    ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
  };
}

export function workflowEventKey(event = {}) {
  return event.id || `${event.time || ''}:${event.type || ''}:${event.data?.pipelineId || ''}:${event.data?.approvalId || ''}`;
}


const GLOBAL_FATAL_WORKFLOW_EVENTS = new Set([
  'workflow.context.sync.failed',
  'workflow.unloaded',
]);

function workflowStateFatalEvent(workflow = null, successPipelineStatuses = [], unseenEvents = []) {
  if (!workflow) return null;
  const pipeline = workflow.pipeline || {};
  const status = String(pipeline.status || '');
  const terminalFailure = status === 'failed' || status === 'rejected';
  const unexpectedTerminal = Boolean(pipeline.terminal)
    && status !== 'idle'
    && !successPipelineStatuses.includes(status);
  if (!terminalFailure && !unexpectedTerminal) return null;

  const revision = Number(workflow.workflowStateRevision || 0);
  const stateObserved = unseenEvents.some((event) => {
    const data = event?.data && typeof event.data === 'object' ? event.data : {};
    return Number(data.workflowStateRevision || 0) === revision
      || (pipeline.id && data.pipelineId === pipeline.id);
  });
  if (!stateObserved) return null;
  return {
    type: `workflow.pipeline.${status || 'terminal'}`,
    data: {
      pipelineId: pipeline.id || '',
      pipelineStatus: status,
      workflowStateRevision: revision,
      code: pipeline.terminal?.code || workflow.lastOutcome?.code || '',
      message: pipeline.terminal?.message || workflow.lastOutcome?.message || workflow.lastError || '',
    },
  };
}

export function findWorkflowWaitOutcome(events = [], {
  predicate = () => false,
  fatalPredicate = null,
  fatalCandidates = events,
  workflow = null,
  successPipelineStatuses = [],
} = {}) {
  const values = Array.isArray(events) ? events : [];
  const matched = [...values].reverse().find(predicate) || null;
  if (matched) return { matched, fatal: null };
  const candidates = Array.isArray(fatalCandidates) ? fatalCandidates : [];
  const fatalEvent = [...candidates].reverse().find((event) => (
    GLOBAL_FATAL_WORKFLOW_EVENTS.has(event?.type)
    || (typeof fatalPredicate === 'function' && fatalPredicate(event, values))
  )) || null;
  const fatal = fatalEvent || workflowStateFatalEvent(workflow, successPipelineStatuses, candidates);
  return { matched: null, fatal };
}

export function workflowProgressFromEvents(events = [], { submittedUserTurnKey = '', approvals = [] } = {}) {
  const types = new Set((Array.isArray(events) ? events : []).map((event) => event?.type).filter(Boolean));
  const pendingApprovals = (Array.isArray(approvals) ? approvals : []).filter((item) => item?.status === 'pending').length;
  return {
    contextSyncStarted: types.has('workflow.context.sync.started'),
    contextSyncCompleted: types.has('workflow.context.sync.completed'),
    contextSyncFailed: types.has('workflow.context.sync.failed'),
    passivePromptSubmitted: Boolean(submittedUserTurnKey),
    artifactObserved: types.has('workflow.turn.observed'),
    artifactDiscovered: types.has('workflow.artifacts.discovered'),
    artifactDownloaded: types.has('workflow.artifact.download.completed'),
    artifactVerified: types.has('workflow.artifact.verify.completed'),
    approvalCreated: types.has('workflow.approval.required'),
    pendingApprovals,
    applyStarted: types.has('workflow.apply.started'),
    applyCompleted: types.has('workflow.apply.completed'),
    applyFailed: types.has('workflow.apply.failed'),
    remediationStarted: types.has('workflow.remediation.prompt.started'),
    remediationCompleted: types.has('workflow.remediation.response.completed'),
    workflowCompleted: types.has('workflow.completed') || types.has('workflow.completed_with_warnings'),
    workflowFailed: types.has('workflow.failed'),
  };
}

export function markReportInterrupted(report, timeline, signal, at = new Date().toISOString()) {
  report.status = 'interrupted';
  report.finishedAt = at;
  report.interruption = { signal, at };
  for (const scenario of report.scenarios || []) {
    if (scenario.status !== 'running') continue;
    scenario.status = 'interrupted';
    scenario.finishedAt = at;
    scenario.note = `Interrupted by ${signal}`;
  }
  timeline.push({ at, type: 'run.interrupted', signal });
  return report;
}
