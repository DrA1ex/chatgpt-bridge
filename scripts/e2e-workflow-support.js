export function buildPassivePromptBody({ message, sessionId, sourceClientId, effort } = {}) {
  if (effort === undefined) throw new Error('Passive workflow prompt effort must be passed explicitly');
  const prompt = String(message || '');
  const session = String(sessionId || '');
  const client = String(sourceClientId || '');
  if (!prompt) throw new Error('Passive workflow prompt message is required');
  if (!session) throw new Error('Passive workflow prompt sessionId is required');
  if (!client) throw new Error('Passive workflow prompt sourceClientId is required');
  return { message: prompt, sessionId: session, sourceClientId: client, effort: String(effort || '') };
}

export function workflowEventKey(event = {}) {
  return event.id || `${event.time || ''}:${event.type || ''}:${event.data?.pipelineId || ''}:${event.data?.approvalId || ''}`;
}


export function findWorkflowWaitOutcome(events = [], {
  predicate = () => false,
  fatalTypes = [],
  fatalPredicate = null,
  fatalCandidates = events,
} = {}) {
  const values = Array.isArray(events) ? events : [];
  const matched = [...values].reverse().find(predicate) || null;
  if (matched) return { matched, fatal: null };
  const candidates = Array.isArray(fatalCandidates) ? fatalCandidates : [];
  const fatal = [...candidates].reverse().find((event) => fatalTypes.includes(event?.type) || (typeof fatalPredicate === 'function' && fatalPredicate(event, values))) || null;
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
