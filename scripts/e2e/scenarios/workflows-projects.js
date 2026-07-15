import { startWorkflowWorker } from '../multi-bridge-workflow.js';
import { normalizedArtifactText } from '../artifact-content.js';
import { turnFailureDetail } from '../scenario-recovery.js';

export async function runWorkflowProjectScenarios(context = {}) {
  const {
    scenario,
    options,
    workDir,
    runId,
    marker,
    sessionId,
    testClient,
    effortFor,
    FAST_EFFORT,
    ensureWorkflowSharedContext,
    createPassiveWorkflowFixture,
    loadPassiveWorkflow,
    passiveWorkflowArtifactPrompt,
    submitPassiveWorkflowPrompt,
    waitForWorkflowEvent,
    writeWorkflowDiagnostics,
    api,
    assert,
    eventTypes,
    logEvent,
    testLog,
    createThread,
    startTurn,
    waitTurn,
    turnEvents,
    artifactsFromTurn,
    selectArtifactCandidate,
    isZipArtifactCandidate,
    downloadArtifact,
    inspectZipBuffer,
    sha256,
    fs,
    path
  } = context;

  await scenario('passive-workflow', async () => {
    const scope = 'passive-workflow';
    const scenarioId = 'passive-workflow';
    const expectedValue = `PASSIVE_APPLIED_${marker}`;
    const sharedContext = await ensureWorkflowSharedContext();
    const fixture = await createPassiveWorkflowFixture(workDir, {
      runId,
      marker,
      scenarioId,
      mode: 'auto',
      sharedContext,
      applyCommands: [`node -e "const fs=require('fs');process.exit(fs.readFileSync('src/index.js','utf8').includes('${expectedValue}')?0:1)"`],
    });
    let events = [];
    let submittedUserTurnKey = '';
    try {
      const { identity, seenEvents } = await loadPassiveWorkflow(options, fixture, { sessionId, sourceClientId: testClient.id, scope });
      const prompt = passiveWorkflowArtifactPrompt({
        marker,
        projectId: identity.projectId,
        packageName: fixture.packageName,
        sourceLine: `export const value = "${expectedValue}";`,
      });
      const promptEffort = effortFor(scope, FAST_EFFORT, 'workflow artifact generation does not require visible reasoning');
      const submitted = await submitPassiveWorkflowPrompt(options, { prompt, sessionId, sourceClientId: testClient.id, scope, effort: promptEffort });
      submittedUserTurnKey = submitted.submittedUserTurnKey;
      const completed = await waitForWorkflowEvent(options, fixture.workflowId, (event) => ['workflow.completed', 'workflow.completed_with_warnings'].includes(event.type), {
        timeoutMs: Math.max(options.turnMaxTimeoutMs || 0, options.workflowWaitTimeoutMs),
        scope,
        seenEvents,
        target: 'workflow.completed',
        successPipelineStatuses: ['completed'],
        waitMessage: 'Waiting for passive artifact download, verification, apply, and validation',
      });
      events = completed.events;
      const finalSource = await fs.readFile(path.join(fixture.projectDir, 'src/index.js'), 'utf8');
      assert.equal(normalizedArtifactText(finalSource), `export const value = "${expectedValue}";`);
      const types = events.map((event) => event.type);
      for (const required of ['workflow.turn.observed', 'workflow.artifact.download.completed', 'workflow.artifact.verify.completed', 'workflow.apply.completed']) {
        assert(types.includes(required), `Passive workflow did not emit ${required}`);
      }
      const verified = events.find((event) => event.type === 'workflow.artifact.verify.completed');
      assert.equal(verified?.data?.identityStatus, 'matched', `Passive artifact identity was not matched: ${JSON.stringify(verified?.data || {})}`);
      await writeWorkflowDiagnostics(options, scenarioId, {
        workflowConfig: fixture.workflowConfig,
        events,
        projectDir: fixture.projectDir,
        extra: { expectedValue, submittedUserTurnKey, terminalEvent: completed.event.type },
      });
      return {
        workflowId: fixture.workflowId,
        projectId: identity.projectId,
        submittedUserTurnKey,
        terminalEvent: completed.event.type,
        eventTypes: types,
      };
    } finally {
      if (!events.length) {
        events = await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}/events?limit=500`).then((value) => value.events || []).catch(() => []);
        await writeWorkflowDiagnostics(options, scenarioId, { workflowConfig: fixture.workflowConfig, events, projectDir: fixture.projectDir, extra: { submittedUserTurnKey } }).catch(() => {});
      }
      await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  await scenario('workflow-multi-bridge', async () => {
    const scope = 'workflow-multi-bridge';
    const scenarioId = 'workflow-multi-bridge';
    const expectedValue = `REMOTE_WORKER_APPLIED_${marker}`;
    const sharedContext = await ensureWorkflowSharedContext();
    const fixture = await createPassiveWorkflowFixture(workDir, {
      runId,
      marker,
      scenarioId,
      mode: 'auto',
      sharedContext,
      applyCommands: [`node -e "const fs=require('fs');process.exit(fs.readFileSync('src/index.js','utf8').includes('${expectedValue}')?0:1)"`],
    });
    fixture.workflowConfig.watch.sessionId = sessionId;
    fixture.workflowConfig.watch.clientId = testClient.id;
    await fs.writeFile(fixture.workflowPath, `${JSON.stringify(fixture.workflowConfig, null, 2)}\n`);
    const diagnosticDir = path.join(options.reportDir, 'scenarios', scenarioId);
    const worker = await startWorkflowWorker(options, {
      workflowPath: fixture.workflowPath,
      dataDir: path.join(workDir, 'workflow-multi-bridge-worker-data'),
      diagnosticDir,
      scope,
      testLog,
    });
    let events = [];
    let submittedUserTurnKey = '';
    try {
      const prompt = passiveWorkflowArtifactPrompt({
        marker,
        projectId: sharedContext.identity.projectId,
        packageName: fixture.packageName,
        sourceLine: `export const value = "${expectedValue}";`,
        extra: ['This artifact is consumed by a separate workflow-worker process connected through the observed-turn stream.'],
      });
      const promptEffort = effortFor(scope, FAST_EFFORT, 'remote workflow artifact generation does not require visible reasoning');
      const submitted = await submitPassiveWorkflowPrompt(options, {
        prompt,
        sessionId,
        sourceClientId: testClient.id,
        scope,
        effort: promptEffort,
      });
      submittedUserTurnKey = submitted.submittedUserTurnKey;
      const seenEvents = new Set();
      const completed = await waitForWorkflowEvent(worker.options, fixture.workflowId, (event) => ['workflow.completed', 'workflow.completed_with_warnings'].includes(event.type), {
        timeoutMs: Math.max(options.turnMaxTimeoutMs || 0, options.workflowWaitTimeoutMs),
        scope,
        seenEvents,
        target: 'remote workflow.completed',
        successPipelineStatuses: ['completed'],
        waitMessage: 'Waiting for the independent workflow worker to observe, download, verify, and apply the ZIP',
      });
      events = completed.events;
      const finalSource = await fs.readFile(path.join(fixture.projectDir, 'src/index.js'), 'utf8');
      assert.equal(normalizedArtifactText(finalSource), `export const value = "${expectedValue}";`);
      const types = events.map((event) => event.type);
      for (const required of ['workflow.turn.observed', 'workflow.artifact.download.completed', 'workflow.artifact.verify.completed', 'workflow.apply.completed', 'workflow.completed']) {
        assert(types.includes(required), `Remote workflow worker did not emit ${required}`);
      }
      const workerHealth = await api(worker.options, '/health');
      assert.equal(workerHealth.bridge?.transport, 'remote-observed-turn-sse');
      assert(Number(workerHealth.bridge?.lastSequence || 0) > 0, 'Remote workflow worker did not advance the observed-turn sequence');
      await writeWorkflowDiagnostics(worker.options, scenarioId, {
        workflowConfig: fixture.workflowConfig,
        events,
        projectDir: fixture.projectDir,
        extra: {
          expectedValue,
          submittedUserTurnKey,
          primaryBridge: options.baseUrl,
          workerBridge: worker.baseUrl,
          observedTurnSequence: workerHealth.bridge.lastSequence,
        },
      });
      return {
        workflowId: fixture.workflowId,
        submittedUserTurnKey,
        workerBridge: worker.baseUrl,
        primaryBridge: options.baseUrl,
        observedTurnSequence: workerHealth.bridge.lastSequence,
        eventTypes: types,
      };
    } finally {
      if (!events.length) {
        events = await api(worker.options, `/workflows/${encodeURIComponent(fixture.workflowId)}/events?limit=500`).then((value) => value.events || []).catch(() => []);
        await writeWorkflowDiagnostics(worker.options, scenarioId, {
          workflowConfig: fixture.workflowConfig,
          events,
          projectDir: fixture.projectDir,
          extra: { submittedUserTurnKey, primaryBridge: options.baseUrl, workerBridge: worker.baseUrl },
        }).catch(() => {});
      }
      await worker.stop();
    }
  });

  await scenario('workflow-approval', async () => {
    const scope = 'workflow-approval';
    const scenarioId = 'workflow-approval';
    const beforeValue = `APPROVAL_BEFORE_${marker}`;
    const expectedValue = `APPROVAL_APPLIED_${marker}`;
    const sharedContext = await ensureWorkflowSharedContext();
    const fixture = await createPassiveWorkflowFixture(workDir, {
      runId,
      marker,
      scenarioId,
      mode: 'ask',
      sharedContext,
      initialSource: `export const value = "${beforeValue}";\n`,
      applyCommands: [`node -e "const fs=require('fs');process.exit(fs.readFileSync('src/index.js','utf8').includes('${expectedValue}')?0:1)"`],
    });
    let events = [];
    let approvals = [];
    let submittedUserTurnKey = '';
    let diagnosticsWritten = false;
    try {
      const { identity, seenEvents } = await loadPassiveWorkflow(options, fixture, { sessionId, sourceClientId: testClient.id, scope });
      const prompt = passiveWorkflowArtifactPrompt({
        marker,
        projectId: identity.projectId,
        packageName: fixture.packageName,
        sourceLine: `export const value = "${expectedValue}";`,
        extra: ['The workflow is intentionally running in ask mode; do not omit the ZIP.'],
      });
      const promptEffort = effortFor(scope, FAST_EFFORT, 'workflow artifact generation does not require visible reasoning');
      const submitted = await submitPassiveWorkflowPrompt(options, { prompt, sessionId, sourceClientId: testClient.id, scope, effort: promptEffort });
      submittedUserTurnKey = submitted.submittedUserTurnKey;
      const pending = await waitForWorkflowEvent(options, fixture.workflowId, (event) => event.type === 'workflow.approval.required', {
        timeoutMs: Math.max(options.turnMaxTimeoutMs || 0, options.workflowWaitTimeoutMs),
        scope,
        seenEvents,
        target: 'workflow.approval.required',
        successPipelineStatuses: ['awaiting_approval'],
        waitMessage: 'Waiting for a verified artifact to enter the approval queue',
        statusProbe: async () => {
          const values = (await api(options, '/workflow-approvals')).approvals || [];
          return { pendingApprovals: values.filter((item) => item.workflowId === fixture.workflowId && item.status === 'pending').length };
        },
      });
      events = pending.events;
      const unchanged = await fs.readFile(path.join(fixture.projectDir, 'src/index.js'), 'utf8');
      assert.equal(unchanged, `export const value = "${beforeValue}";\n`, 'Ask workflow modified the project before approval');
      testLog('ok', scope, 'Project remains unchanged while the verified artifact is pending approval', { value: beforeValue });

      const approvalResponse = await api(options, '/workflow-approvals');
      approvals = (approvalResponse.approvals || []).filter((approval) => approval.workflowId === fixture.workflowId && approval.status === 'pending');
      assert.equal(approvals.length, 1, `Expected one pending approval for ${fixture.workflowId}, got ${approvals.length}`);
      const approval = approvals[0];
      assert.equal(approval.id, pending.event.data?.approvalId, 'Approval queue id does not match workflow event');
      testLog('action', scope, 'Approving the verified workflow artifact explicitly', { approvalId: approval.id });
      await api(options, `/workflow-approvals/${encodeURIComponent(approval.id)}/approve`, {
        method: 'POST',
        timeoutMs: Math.max(options.timeoutMs, 180_000),
        body: {},
      });
      const completed = await waitForWorkflowEvent(options, fixture.workflowId, (event) => ['workflow.completed', 'workflow.completed_with_warnings'].includes(event.type), {
        timeoutMs: options.workflowWaitTimeoutMs,
        scope,
        seenEvents,
        target: 'workflow.completed after approval',
        successPipelineStatuses: ['completed'],
        waitMessage: 'Waiting for the approved artifact to apply and pass validation',
      });
      events = completed.events;
      const finalSource = await fs.readFile(path.join(fixture.projectDir, 'src/index.js'), 'utf8');
      assert.equal(normalizedArtifactText(finalSource), `export const value = "${expectedValue}";`);
      const types = events.map((event) => event.type);
      for (const required of ['workflow.approval.required', 'workflow.apply.started', 'workflow.apply.completed', 'workflow.completed']) {
        assert(types.includes(required), `Approval workflow did not emit ${required}`);
      }
      const afterApprovals = (await api(options, '/workflow-approvals')).approvals || [];
      assert.equal(afterApprovals.some((item) => item.id === approval.id && item.status === 'pending'), false, 'Approved item remained in pending approval queue');
      await writeWorkflowDiagnostics(options, scenarioId, {
        workflowConfig: fixture.workflowConfig,
        events,
        approvals: [...approvals, ...afterApprovals.filter((item) => item.id === approval.id)],
        projectDir: fixture.projectDir,
        extra: { beforeValue, expectedValue, submittedUserTurnKey, approvalId: approval.id },
      });
      diagnosticsWritten = true;
      return { workflowId: fixture.workflowId, approvalId: approval.id, eventTypes: types, submittedUserTurnKey };
    } finally {
      if (!events.length) events = await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}/events?limit=500`).then((value) => value.events || []).catch(() => []);
      if (!approvals.length) approvals = await api(options, '/workflow-approvals').then((value) => (value.approvals || []).filter((item) => item.workflowId === fixture.workflowId)).catch(() => []);
      if (!diagnosticsWritten) await writeWorkflowDiagnostics(options, scenarioId, { workflowConfig: fixture.workflowConfig, events, approvals, projectDir: fixture.projectDir, extra: { submittedUserTurnKey } }).catch(() => {});
      await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  await scenario('workflow-remediation', async () => {
    const scope = 'workflow-remediation';
    const scenarioId = 'workflow-remediation';
    const originalValue = `REMEDIATION_ORIGINAL_${marker}`;
    const brokenValue = `REMEDIATION_BROKEN_${marker}`;
    const expectedValue = `REMEDIATION_FIXED_${marker}`;
    const sharedContext = await ensureWorkflowSharedContext();
    const validationCommand = `node -e "const fs=require('fs');const expected='${expectedValue}';const text=fs.readFileSync('src/index.js','utf8');if(!text.includes(expected)){console.error('WORKFLOW_E2E_VALIDATION_FAILED expected '+expected+' in src/index.js, got: '+text.trim());process.exit(23)}"`;
    const fixture = await createPassiveWorkflowFixture(workDir, {
      runId,
      marker,
      scenarioId,
      mode: 'auto',
      sharedContext,
      initialSource: `export const value = "${originalValue}";\n`,
      applyCommands: [validationCommand],
      remediation: { enabled: true, maxAttempts: 1, sameChat: true, outputTailLines: 120 },
    });
    let events = [];
    let submittedUserTurnKey = '';
    let diagnosticsWritten = false;
    try {
      const { identity, seenEvents } = await loadPassiveWorkflow(options, fixture, { sessionId, sourceClientId: testClient.id, scope });
      const prompt = passiveWorkflowArtifactPrompt({
        marker,
        projectId: identity.projectId,
        packageName: fixture.packageName,
        sourceLine: `export const value = "${brokenValue}";`,
        extra: [
          `For the first artifact, use exactly the broken value ${brokenValue}; the configured validation is expected to fail and the workflow will send you the error for remediation.`,
          `When the workflow sends validation output back, return a new complete ZIP and change src/index.js to contain ${expectedValue}.`,
        ],
      });
      const promptEffort = effortFor(scope, FAST_EFFORT, 'workflow artifact generation does not require visible reasoning');
      const submitted = await submitPassiveWorkflowPrompt(options, { prompt, sessionId, sourceClientId: testClient.id, scope, effort: promptEffort });
      submittedUserTurnKey = submitted.submittedUserTurnKey;
      const completed = await waitForWorkflowEvent(options, fixture.workflowId, (event) => ['workflow.completed', 'workflow.completed_with_warnings'].includes(event.type), {
        timeoutMs: Math.max(options.turnMaxTimeoutMs || 0, options.workflowWaitTimeoutMs * 2),
        scope,
        seenEvents,
        target: 'workflow.completed after remediation',
        successPipelineStatuses: ['completed'],
        waitMessage: 'Waiting for rollback, remediation response, replacement artifact, and successful validation',
      });
      events = completed.events;
      const finalSource = await fs.readFile(path.join(fixture.projectDir, 'src/index.js'), 'utf8');
      assert.equal(normalizedArtifactText(finalSource), `export const value = "${expectedValue}";`);
      const types = events.map((event) => event.type);
      for (const required of ['workflow.apply.failed', 'workflow.remediation.prompt.started', 'workflow.remediation.response.completed', 'workflow.apply.completed', 'workflow.completed']) {
        assert(types.includes(required), `Remediation workflow did not emit ${required}`);
      }
      const failedApply = events.find((event) => event.type === 'workflow.apply.failed');
      assert.equal(failedApply?.data?.rollback?.ok, true, `Failed artifact was not rolled back safely: ${JSON.stringify(failedApply?.data || {})}`);
      const remediationResponse = events.find((event) => event.type === 'workflow.remediation.response.completed');
      assert(Number(remediationResponse?.data?.artifactCount || 0) >= 1, 'Remediation response did not contain an artifact');
      await writeWorkflowDiagnostics(options, scenarioId, {
        workflowConfig: fixture.workflowConfig,
        events,
        projectDir: fixture.projectDir,
        extra: {
          originalValue,
          brokenValue,
          expectedValue,
          submittedUserTurnKey,
          failedPipelineId: failedApply?.data?.pipelineId || '',
          remediationTurnKey: remediationResponse?.data?.turnKey || '',
        },
      });
      diagnosticsWritten = true;
      return {
        workflowId: fixture.workflowId,
        submittedUserTurnKey,
        remediationTurnKey: remediationResponse?.data?.turnKey || '',
        eventTypes: types,
      };
    } finally {
      if (!events.length) events = await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}/events?limit=500`).then((value) => value.events || []).catch(() => []);
      if (!diagnosticsWritten) await writeWorkflowDiagnostics(options, scenarioId, { workflowConfig: fixture.workflowConfig, events, projectDir: fixture.projectDir, extra: { submittedUserTurnKey } }).catch(() => {});
      await api(options, `/workflows/${encodeURIComponent(fixture.workflowId)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  await scenario('project-context', async () => {
    const projectDir = path.join(workDir, 'project-with-context');
    await fs.mkdir(path.join(projectDir, '.bridge', 'skills'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'seed.txt'), `${marker}_SEED\n`);
    await fs.writeFile(path.join(projectDir, 'AGENT.md'), `For E2E output tasks, always include the literal token AGENT_${marker}. Do not omit it.\n`);
    await fs.writeFile(path.join(projectDir, '.bridge', 'skills', 'deterministic.md'), `When enabled, include the literal token SKILL_${marker} in result.txt.\n`);
    const thread = await createThread(options, projectDir, `E2E project ${runId}`, { scope: 'project-context' });
    const first = await startTurn(options, {
      threadId: thread.id,
      cwd: projectDir,
      sourceClientId: testClient.id,
      sessionId,
      effort: effortFor('project-context', FAST_EFFORT, 'project packaging does not require visible reasoning'),
      project: { mode: 'package', skills: ['deterministic'], snapshotPolicy: 'reuse-if-unchanged' },
      output: { expected: 'zip', required: true },
      message: `Return a complete ZIP of the project. Create result.txt at the archive root with exactly four lines: seed=${marker}_SEED, agent=AGENT_${marker}, skill=SKILL_${marker}, revision=1. Preserve all other input files.`,
    }, { scope: 'project-context', label: 'project revision 1' });
    const firstDone = await waitTurn(options, first.id, { scope: 'project-context' });
    const firstEvents = await turnEvents(options, first.id);
    assert(firstDone.turn.status === 'completed', turnFailureDetail(firstDone, 'First project turn'));
    const firstArtifacts = artifactsFromTurn(firstDone);
    const firstArtifact = selectArtifactCandidate(firstArtifacts, { scope: 'project-context', purpose: 'revision 1 project ZIP', predicate: isZipArtifactCandidate });
    assert(firstArtifact, 'Revision 1 project ZIP was not found');
    const firstZip = await inspectZipBuffer(await downloadArtifact(options, firstArtifact), workDir, 'project-rev1');
    testLog('state', 'project-context', 'Revision 1 ZIP inspected', { entries: Object.keys(firstZip.files).join(' | ') });
    const expected1 = `seed=${marker}_SEED\nagent=AGENT_${marker}\nskill=SKILL_${marker}\nrevision=1`;
    assert(firstZip.files['result.txt']?.trim() === expected1, `AGENT/skill result mismatch: ${firstZip.files['result.txt']}`);
    const package1 = firstEvents.find((event) => event.type === 'project/packageCreated')?.data || firstEvents.find((event) => event.type === 'project/packageCreated') || {};

    const second = await startTurn(options, {
      threadId: thread.id,
      cwd: projectDir,
      sourceClientId: testClient.id,
      sessionId,
      project: { mode: 'package', skills: ['deterministic'], snapshotPolicy: 'reuse-if-unchanged' },
      output: { expected: 'zip', required: true },
      message: `Use the result of the previous turn in this conversation and return an updated complete ZIP of the project. Change only result.txt: preserve the first three lines exactly, replace revision=1 with revision=2, and add a fifth line previous=${sha256(Buffer.from(expected1)).slice(0, 16)}.`,
    }, { scope: 'project-context', label: 'project revision 2' });
    const secondDone = await waitTurn(options, second.id, { scope: 'project-context' });
    const secondEvents = await turnEvents(options, second.id);
    assert(secondDone.turn.status === 'completed', turnFailureDetail(secondDone, 'Second project turn'));
    const secondArtifacts = artifactsFromTurn(secondDone);
    const secondArtifact = selectArtifactCandidate(secondArtifacts, { scope: 'project-context', purpose: 'revision 2 project ZIP', predicate: isZipArtifactCandidate });
    assert(secondArtifact, 'Revision 2 project ZIP was not found');
    const secondZip = await inspectZipBuffer(await downloadArtifact(options, secondArtifact), workDir, 'project-rev2');
    testLog('state', 'project-context', 'Revision 2 ZIP inspected', { entries: Object.keys(secondZip.files).join(' | ') });
    const expected2 = `${expected1.replace('revision=1', 'revision=2')}\nprevious=${sha256(Buffer.from(expected1)).slice(0, 16)}`;
    assert(secondZip.files['result.txt']?.trim() === expected2, `Second-turn modification mismatch: ${secondZip.files['result.txt']}`);
    const packageEvents = secondEvents.filter((event) => event.type === 'project/packageCreated');
    assert(packageEvents.length === 1, `Expected one packageCreated event, got ${packageEvents.length}`);
    const package2 = packageEvents[0].data || packageEvents[0];
    assert(package2.attached === false, `Unchanged snapshot was attached again: ${JSON.stringify(package2)}`);
    assert(package2.reused === true, `Unchanged snapshot was not reported reused: ${JSON.stringify(package2)}`);
    logEvent('project.turns', { first: { turn: firstDone.turn, events: firstEvents }, second: { turn: secondDone.turn, events: secondEvents } });
    return { firstTurnId: first.id, secondTurnId: second.id, firstPackage: package1, secondPackage: package2, result1: expected1, result2: expected2 };
  });

  await scenario('project-no-context', async () => {
    const projectDir = path.join(workDir, 'project-without-context'); await fs.mkdir(projectDir, { recursive: true }); await fs.writeFile(path.join(projectDir, 'plain.txt'), 'plain\n');
    const thread = await createThread(options, projectDir, `E2E no context ${runId}`, { scope: 'project-no-context' });
    const turn = await startTurn(options, {
      threadId: thread.id,
      cwd: projectDir,
      sourceClientId: testClient.id,
      sessionId,
      effort: effortFor('project-no-context', FAST_EFFORT, 'project packaging does not require visible reasoning'),
      project: { mode: 'package', skills: ['missing-skill'], snapshotPolicy: 'reuse-if-unchanged' },
      output: { expected: 'zip', required: true },
      message: `Return a complete ZIP of the project and add fallback.txt containing the single line NO_CONTEXT_${marker}. The absence of AGENT.md and the requested skill must not be treated as an error.`,
    }, { scope: 'project-no-context', label: 'project without context files' });
    const done = await waitTurn(options, turn.id, { scope: 'project-no-context' });
    assert(done.turn.status === 'completed', turnFailureDetail(done, 'No-context turn'));
    const artifact = selectArtifactCandidate(artifactsFromTurn(done), { scope: 'project-no-context', purpose: 'no-context project ZIP', predicate: isZipArtifactCandidate });
    assert(artifact, 'No-context project ZIP was not found');
    const inspected = await inspectZipBuffer(await downloadArtifact(options, artifact), workDir, 'no-context');
    assert(inspected.files['fallback.txt']?.trim() === `NO_CONTEXT_${marker}`, 'fallback.txt mismatch');
    return { turnId: turn.id, files: Object.keys(inspected.files) };
  });
}
