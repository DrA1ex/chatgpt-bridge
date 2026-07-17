import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createWorkflowE2eRuntime(deps = {}) {
  const {
    api,
    assert,
    buildPassivePromptBody,
    findWorkflowWaitOutcome,
    nowIso,
    scenarioDiagnosticDir,
    sleep,
    testLog,
    workflowEventKey,
    workflowProgressFromEvents,
  } = deps;

function summarizeWorkflowEvent(event = {}) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const common = {
    pipelineId: data.pipelineId || '',
    approvalId: data.approvalId || '',
    artifact: data.artifact?.name || data.name || '',
    size: data.size ?? '',
    entries: data.entries ?? '',
    identity: data.identityStatus || '',
    changed: data.written ?? data.update ?? '',
    deleted: data.deleted ?? data.delete ?? '',
    reason: data.reason || '',
    message: data.message || '',
  };
  return Object.fromEntries(Object.entries(common).filter(([, value]) => value !== '' && value != null));
}

function workflowEventLog(event = {}, scope = 'workflow') {
  const type = String(event.type || 'workflow.event');
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const fields = summarizeWorkflowEvent(event);
  switch (type) {
    case 'workflow.loaded': return ['ok', scope, 'Workflow configuration loaded', { mode: data.mode, status: data.status, projectId: data.projectId }];
    case 'workflow.started': return ['ok', scope, 'Workflow watcher started', fields];
    case 'workflow.context.sync.started': return ['action', scope, 'Uploading project identity context to the watched conversation', { reason: data.reason, projectId: data.projectId }];
    case 'workflow.context.sync.completed': return ['ok', scope, 'Project identity context synchronized', { projectId: data.projectId, fingerprint: data.fingerprintSha256 }];
    case 'workflow.context.sync.failed': return ['fail', scope, 'Project identity context synchronization failed', { reason: data.reason, message: data.message }];
    case 'workflow.turn.observed': return ['state', scope, 'Passive observer received a new terminal assistant turn', { turnKey: data.turnKey, artifacts: data.artifactCount }];
    case 'workflow.artifacts.discovered': return ['search', scope, 'Scanning the observed turn for workflow artifacts', { found: data.count, source: data.source }];
    case 'workflow.artifact.download.started': return ['action', scope, 'Downloading the selected workflow artifact', fields];
    case 'workflow.artifact.download.completed': return ['ok', scope, 'Workflow artifact downloaded', fields];
    case 'workflow.artifact.verify.started': return ['action', scope, 'Verifying archive safety and project identity', fields];
    case 'workflow.artifact.verify.completed': return ['ok', scope, 'Artifact verification passed', { ...fields, overlap: data.overlapScore, projectId: data.projectId, artifactProjectId: data.artifactProjectId }];
    case 'workflow.artifact.verify.failed': return ['fail', scope, 'Artifact verification failed', { ...fields, reasons: Array.isArray(data.reasons) ? data.reasons.join(' | ') : data.reasons }];
    case 'workflow.apply.plan': return ['state', scope, 'Application plan calculated', { policyOk: data.policyOk, create: data.create, update: data.update, delete: data.delete, reasons: Array.isArray(data.reasons) ? data.reasons.join(' | ') : data.reasons }];
    case 'workflow.approval.required': return ['wait', scope, 'Artifact is verified and waiting for explicit approval', fields];
    case 'workflow.approval.rejected': return ['warn', scope, 'Pending workflow artifact was rejected', fields];
    case 'workflow.apply.started': return ['action', scope, 'Applying the verified archive transactionally', fields];
    case 'workflow.apply.completed': return ['ok', scope, 'Archive applied and post-apply commands passed', { ...fields, commands: Array.isArray(data.commands) ? data.commands.length : 0 }];
    case 'workflow.apply.failed': return ['fail', scope, 'Post-apply validation failed; rollback result recorded', { ...fields, rollbackOk: data.rollback?.ok }];
    case 'workflow.remediation.prompt.started': return ['action', scope, 'Sending validation failure back to the same ChatGPT conversation', { attempt: data.attempt, sessionId: data.sessionId }];
    case 'workflow.remediation.response.completed': return ['ok', scope, 'Received remediation response with replacement artifact candidates', { attempt: data.attempt, artifacts: data.artifactCount, turnKey: data.turnKey }];
    case 'workflow.completed': return ['ok', scope, 'Workflow returned to watching after a successful pipeline', fields];
    case 'workflow.completed_with_warnings': return ['warn', scope, 'Workflow completed with non-fatal warnings', { warnings: Array.isArray(data.warnings) ? data.warnings.join(' | ') : data.warnings }];
    case 'workflow.artifact.duplicate': return ['state', scope, 'Duplicate artifact skipped', fields];
    case 'workflow.artifact.ambiguous': return ['warn', scope, 'Multiple ZIP candidates are ambiguous', fields];
    case 'workflow.artifact.skipped': return ['state', scope, 'Observed turn did not contain a suitable workflow artifact', fields];
    case 'workflow.failed': return ['fail', scope, 'Workflow pipeline failed', fields];
    default: return ['info', scope, `Workflow event: ${type}`, fields];
  }
}

function logUnseenWorkflowEvents(events, seen, scope) {
  const unseen = [];
  for (const event of events) {
    const key = workflowEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    unseen.push(event);
    const [level, eventScope, message, fields] = workflowEventLog(event, scope);
    testLog(level, eventScope, message, fields);
  }
  return unseen;
}

function workflowWaitError(workflowId, target, fatalEvent, events) {
  const data = fatalEvent?.data && typeof fatalEvent.data === 'object' ? fatalEvent.data : {};
  const error = new Error([
    `Workflow ${workflowId} cannot reach ${target}: ${fatalEvent?.type || 'fatal event'}`,
    data.message || data.reason || '',
  ].filter(Boolean).join(' — '));
  error.name = 'WorkflowWaitTerminalError';
  error.workflowId = workflowId;
  error.target = target;
  error.fatalEvent = fatalEvent;
  error.recentEvents = events.slice(-20);
  return error;
}

async function waitForWorkflowEvent(options, workflowId, predicate, {
  timeoutMs = 240_000,
  intervalMs = 750,
  scope = 'passive-workflow',
  seenEvents = null,
  target = 'requested workflow state',
  waitMessage = '',
  successPipelineStatuses = [],
  fatalPredicate = null,
  statusProbe = null,
} = {}) {
  const started = Date.now();
  let lastEvents = [];
  const seen = seenEvents instanceof Set ? seenEvents : new Set();
  let lastWaitLogAt = 0;
  let lastProgressAt = started;
  let lastProgressSignature = '';
  while (Date.now() - started < timeoutMs) {
    const [eventResponse, workflowResponse] = await Promise.all([
      api(options, `/workflows/${encodeURIComponent(workflowId)}/events?limit=500`),
      api(options, `/workflows/${encodeURIComponent(workflowId)}`),
    ]);
    lastEvents = eventResponse.events || [];
    const workflow = workflowResponse.workflow || null;
    const progressSignature = JSON.stringify([
      lastEvents.length,
      lastEvents.at(-1)?.id || '',
      workflow?.workflowStateRevision || 0,
      workflow?.pipeline?.status || 'idle',
    ]);
    if (progressSignature !== lastProgressSignature) {
      lastProgressSignature = progressSignature;
      lastProgressAt = Date.now();
    }
    const unseen = logUnseenWorkflowEvents(lastEvents, seen, scope);
    const outcome = findWorkflowWaitOutcome(lastEvents, {
      predicate,
      fatalPredicate,
      fatalCandidates: unseen,
      workflow,
      successPipelineStatuses,
    });
    const matched = outcome.matched;
    if (matched) {
      testLog('ok', scope, `Workflow reached ${target}`, {
        workflowId,
        event: matched.type,
        elapsedMs: Date.now() - started,
        eventCount: lastEvents.length,
      });
      return { event: matched, events: lastEvents };
    }
    const fatal = outcome.fatal;
    if (fatal) {
      const data = fatal?.data && typeof fatal.data === 'object' ? fatal.data : {};
      testLog('fail', scope, `Workflow cannot reach ${target}`, {
        workflowId,
        fatalEvent: fatal.type,
        message: data.message || data.reason || '',
        elapsedMs: Date.now() - started,
      });
      throw workflowWaitError(workflowId, target, fatal, lastEvents);
    }
    const pipelineStatus = String(workflow?.pipeline?.status || 'idle');
    const pipelineStarted = pipelineStatus !== 'idle' || lastEvents.some((event) => event.type === 'workflow.pipeline.observed');
    if (pipelineStarted && Date.now() - lastProgressAt >= Number(options.pipelineIdleTimeoutMs || 60_000)) {
      const idleMs = Date.now() - lastProgressAt;
      testLog('fail', scope, `Workflow pipeline made no progress while waiting for ${target}`, {
        workflowId,
        target,
        pipelineStatus,
        idleMs,
        currentStage: lastEvents.at(-1)?.type || '(no events)',
      });
      const error = new Error(`Workflow ${workflowId} made no pipeline progress for ${idleMs}ms while waiting for ${target}; pipelineStatus=${pipelineStatus}; current stage=${lastEvents.at(-1)?.type || '(none)'}`);
      error.name = 'WorkflowWaitIdleTimeoutError';
      error.workflowId = workflowId;
      error.target = target;
      error.pipelineStatus = pipelineStatus;
      error.recentEvents = lastEvents.slice(-20);
      throw error;
    }
    if (Date.now() - lastWaitLogAt >= 5_000) {
      lastWaitLogAt = Date.now();
      const current = lastEvents.at(-1) || null;
      let extra = {};
      if (typeof statusProbe === 'function') {
        try { extra = await statusProbe(lastEvents) || {}; } catch (error) { extra = { statusProbeError: error.message }; }
      }
      testLog('wait', scope, waitMessage || `Waiting for ${target}`, {
        workflowId,
        target,
        currentStage: current?.type || '(no events)',
        pipelineStatus: workflow?.pipeline?.status || 'idle',
        workflowStateRevision: workflow?.workflowStateRevision || 0,
        elapsedMs: Date.now() - started,
        eventCount: lastEvents.length,
        ...extra,
      });
    }
    await sleep(intervalMs);
  }
  const current = lastEvents.at(-1);
  testLog('fail', scope, 'Workflow wait reached its absolute timeout', {
    workflowId,
    target,
    timeoutMs,
    currentStage: current?.type || '(none)',
    eventCount: lastEvents.length,
  });
  const error = new Error(`Timed out after ${timeoutMs}ms waiting for ${target} in workflow ${workflowId}; current stage: ${current?.type || '(none)'}; recent events: ${lastEvents.slice(-10).map((event) => event.type).join(', ')}`);
  error.name = 'WorkflowWaitTimeoutError';
  error.workflowId = workflowId;
  error.target = target;
  error.timeoutMs = timeoutMs;
  error.recentEvents = lastEvents.slice(-20);
  throw error;
}

async function writeWorkflowDiagnostics(options, scenarioId, { workflowConfig, events = [], approvals = [], projectDir = '', extra = {} } = {}) {
  const dir = scenarioDiagnosticDir(options, scenarioId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'workflow-config.json'), `${JSON.stringify(workflowConfig, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'workflow-events.json'), `${JSON.stringify(events, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'workflow-approvals.json'), `${JSON.stringify(approvals, null, 2)}\n`);
  const progress = workflowProgressFromEvents(events, { submittedUserTurnKey: extra.submittedUserTurnKey || '', approvals });
  await fs.writeFile(path.join(dir, 'workflow-progress.json'), `${JSON.stringify(progress, null, 2)}\n`);
  const projectFiles = {};
  if (projectDir) {
    for (const relative of ['package.json', 'README.md', 'src/index.js', '.bridge/PROJECT_ID.json', '.bridge/PROJECT_FINGERPRINT.json']) {
      const absolute = path.join(projectDir, relative);
      const content = await fs.readFile(absolute, 'utf8').catch(() => null);
      if (content != null) projectFiles[relative] = content;
    }
  }
  await fs.writeFile(path.join(dir, 'project-terminal-state.json'), `${JSON.stringify({ files: projectFiles, progress, ...extra }, null, 2)}\n`);
}

async function createPassiveWorkflowFixture(workDir, {
  runId,
  marker,
  scenarioId,
  mode = 'auto',
  initialSource = '',
  applyCommands = [],
  remediation = { enabled: false, maxAttempts: 0 },
  sharedContext = null,
  syncContextOnStart = false,
} = {}) {
  const workflowId = `${scenarioId}-${runId}`;
  const packageName = sharedContext?.packageName || `${scenarioId}-${runId}`;
  const projectDir = path.join(workDir, `${scenarioId}-project`);
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  if (sharedContext?.identity) {
    await fs.mkdir(path.join(projectDir, '.bridge'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.bridge/PROJECT_ID.json'), `${JSON.stringify(sharedContext.identity, null, 2)}\n`);
  }
  await fs.writeFile(path.join(projectDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '1.0.0', type: 'module' }, null, 2)}\n`);
  await fs.writeFile(path.join(projectDir, 'src/index.js'), initialSource || `export const value = "BEFORE_${marker}";\n`);
  await fs.writeFile(path.join(projectDir, 'README.md'), `# Workflow E2E fixture\n\nScenario: ${scenarioId}\nMarker: ${marker}\n`);
  const workflowPath = path.join(workDir, `${scenarioId}.workflow.json`);
  const workflowConfig = {
    version: 1,
    id: workflowId,
    enabled: true,
    projectRoot: projectDir,
    watch: { mode, clientId: '', sessionId: '', includeLatest: false, bindOnFirstVerifiedArtifact: false, refreshIntervalMs: 0 },
    artifact: { expected: 'zip', requireSingleCandidate: true },
    projectContext: { enabled: true, mode: 'identity', syncOnStart: Boolean(syncContextOnStart), syncAfterBind: false, fallbackFiles: ['package.json', 'README.md'] },
    verification: {
      requiredFiles: ['package.json', 'src/index.js', '.bridge/PROJECT_ID.json'],
      packageName,
      minProjectFileOverlap: 0.4,
      requireProjectIdentity: true,
      identityFallbackFiles: ['package.json', 'README.md'],
      commands: [],
    },
    apply: {
      sync: true,
      requireCleanGit: false,
      rollbackOnFailure: true,
      protectedPaths: ['.git/**', '.env*'],
      allowedWarningCodes: ['NO_REFERENCE_MANIFEST_FOR_SYNC'],
      maxChangedFiles: 50,
      maxDeletedFiles: 10,
      commands: applyCommands,
    },
    remediation: {
      enabled: Boolean(remediation.enabled),
      maxAttempts: Number(remediation.maxAttempts || 0),
      sameChat: remediation.sameChat !== false,
      outputTailLines: Number(remediation.outputTailLines || 100),
      ...(remediation.prompt ? { prompt: remediation.prompt } : {}),
    },
    commit: { mode: 'none', required: false },
    extensionUpdate: { enabled: false },
    daemonRestart: { enabled: false, mode: 'none' },
  };
  await fs.writeFile(workflowPath, `${JSON.stringify(workflowConfig, null, 2)}\n`);
  return { workflowId, packageName, projectDir, workflowPath, workflowConfig };
}

function passiveWorkflowArtifactPrompt({ marker, projectId, packageName, sourceLine, extra = [] } = {}) {
  return [
    'Create one real downloadable ZIP artifact containing the complete project at the archive root.',
    `This is workflow E2E marker ${marker}.`,
    'Use the shared project identity context synchronized earlier in this conversation.',
    `Preserve .bridge/PROJECT_ID.json unchanged with projectId ${projectId}.`,
    `Keep package.json name exactly ${packageName}.`,
    `Set src/index.js to exactly: ${sourceLine}`,
    `Keep README.md and preserve marker ${marker}.`,
    'Do not wrap the project in an additional top-level directory.',
    'Return the ZIP as a downloadable artifact and a short final note.',
    ...extra,
  ].join('\n');
}


async function createWorkflowGroupContext(workDir, { runId, marker } = {}) {
  const projectDir = path.join(workDir, 'workflow-shared-context-project');
  const packageName = `workflow-e2e-${runId}`;
  const identity = {
    version: 1,
    projectId: `bridge-project-${randomUUID()}`,
    projectName: 'workflow-e2e-fixture',
    packageName,
    createdAt: nowIso(),
  };
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.bridge'), { recursive: true });
  await fs.writeFile(path.join(projectDir, '.bridge/PROJECT_ID.json'), `${JSON.stringify(identity, null, 2)}\n`);
  await fs.writeFile(path.join(projectDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '1.0.0', type: 'module' }, null, 2)}\n`);
  await fs.writeFile(path.join(projectDir, 'README.md'), `# Shared workflow E2E project context\n\nMarker: ${marker}\n`);
  await fs.writeFile(path.join(projectDir, 'src/index.js'), `export const contextMarker = "${marker}";\n`);
  return { projectDir, packageName, identity };
}

async function synchronizeWorkflowGroupContext(options, sharedContext, { runId, sessionId, sourceClientId, scope = 'workflow-context' } = {}) {
  const fixture = await createPassiveWorkflowFixture(path.dirname(sharedContext.projectDir), {
    runId,
    marker: runId,
    scenarioId: 'workflow-context-preflight',
    mode: 'verify',
    initialSource: `export const contextReady = true;\n`,
    sharedContext,
    syncContextOnStart: true,
  });
  fixture.projectDir = sharedContext.projectDir;
  fixture.workflowConfig.projectRoot = sharedContext.projectDir;
  fixture.workflowConfig.verification.packageName = sharedContext.packageName;
  fixture.workflowConfig.projectContext.syncOnStart = true;
  await fs.writeFile(fixture.workflowPath, `${JSON.stringify(fixture.workflowConfig, null, 2)}\n`);
  fixture.workflowConfig.watch.sessionId = sessionId;
  fixture.workflowConfig.watch.clientId = sourceClientId;
  await fs.writeFile(fixture.workflowPath, `${JSON.stringify(fixture.workflowConfig, null, 2)}\n`);
  const seenEvents = new Set();
  let events = [];
  testLog('step', scope, 'Synchronizing one shared project context for all workflow scenarios', {
    workflowId: fixture.workflowId,
    projectId: sharedContext.identity.projectId,
    packageName: sharedContext.packageName,
  });
  try {
    await api(options, '/workflows/load', { method: 'POST', body: { configPath: fixture.workflowPath, start: true } });
    const synced = await waitForWorkflowEvent(options, fixture.workflowId, (event) => event.type === 'workflow.context.sync.completed', {
      timeoutMs: options.promptTimeoutMs || 180_000,
      scope,
      seenEvents,
      target: 'workflow.context.sync.completed',
      waitMessage: 'Waiting for the shared project context acknowledgement',
    });
    events = synced.events;
    testLog('ok', scope, 'Shared project context is ready for the workflow scenario group', {
      projectId: sharedContext.identity.projectId,
      eventCount: synced.events.length,
    });
    return { ...sharedContext, events: synced.events };
  } finally {
    if (!events.length) events = await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}/events?limit=500`).then((value) => value.events || []).catch(() => []);
    await writeWorkflowDiagnostics(options, 'workflow-context', {
      workflowConfig: fixture.workflowConfig,
      events,
      projectDir: sharedContext.projectDir,
      extra: { projectId: sharedContext.identity.projectId, contextOnly: true },
    }).catch(() => {});
    await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function loadPassiveWorkflow(options, fixture, { sessionId, sourceClientId, scope, expectContextSync = false } = {}) {
  fixture.workflowConfig.watch.sessionId = sessionId;
  fixture.workflowConfig.watch.clientId = sourceClientId;
  fixture.workflowConfig.projectContext.syncOnStart = Boolean(expectContextSync);
  await fs.writeFile(fixture.workflowPath, `${JSON.stringify(fixture.workflowConfig, null, 2)}\n`);
  testLog('action', scope, 'Loading workflow configuration bound to the owned browser conversation', {
    workflowId: fixture.workflowId,
    mode: fixture.workflowConfig.watch.mode,
    projectDir: fixture.projectDir,
    contextSync: expectContextSync ? 'required' : 'already synchronized for this scenario group',
  });
  await api(options, '/workflows/load', { method: 'POST', body: { configPath: fixture.workflowPath, start: true } });
  const seenEvents = new Set();
  const targetType = expectContextSync ? 'workflow.context.sync.completed' : 'workflow.loaded';
  const ready = await waitForWorkflowEvent(options, fixture.workflowId, (event) => event.type === targetType, {
    timeoutMs: expectContextSync ? (options.promptTimeoutMs || 180_000) : 30_000,
    scope,
    seenEvents,
    target: targetType,
    waitMessage: expectContextSync ? 'Waiting for project context synchronization' : 'Waiting for the workflow watcher to load',
  });
  const identity = JSON.parse(await fs.readFile(path.join(fixture.projectDir, '.bridge/PROJECT_ID.json'), 'utf8'));
  return { identity, initialEvents: ready.events, seenEvents };
}

async function submitPassiveWorkflowPrompt(options, { prompt, sessionId, sourceClientId, scope, effort } = {}) {
  // The content command has its own bounded page-readiness deadline. Keep
  // the command/HTTP envelopes longer than that inner deadline so failures
  // surface as CHAT_PAGE_NOT_READY instead of an unrelated correlation timeout.
  const commandTimeoutMs = Math.max(60_000, Number(options.tabReadyTimeoutMs || 0) + 15_000);
  const body = buildPassivePromptBody({ message: prompt, sessionId, sourceClientId, effort, timeoutMs: commandTimeoutMs });
  testLog('action', scope, 'Submitting prompt directly through the browser command without a bridge request', { sessionId, effort: body.effort || '(unchanged)' });
  const submitted = await api(options, '/browser/passive-prompt', {
    method: 'POST',
    timeoutMs: commandTimeoutMs + 10_000,
    body,
  });
  assert(submitted.result?.submittedUserTurnKey, 'Passive workflow prompt did not confirm a submitted user turn');
  testLog('ok', scope, 'Browser confirmed the externally submitted user turn', { userTurnKey: submitted.result.submittedUserTurnKey });
  return submitted.result;
}


  return Object.freeze({
    createPassiveWorkflowFixture,
    createWorkflowGroupContext,
    loadPassiveWorkflow,
    passiveWorkflowArtifactPrompt,
    submitPassiveWorkflowPrompt,
    synchronizeWorkflowGroupContext,
    waitForWorkflowEvent,
    writeWorkflowDiagnostics,
  });
}
