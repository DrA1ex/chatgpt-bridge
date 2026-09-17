import path from 'node:path';
import { normalizeSelectedResult } from './state.js';
import {
  renderWorkflowDiff,
  renderWorkflowHistoryPage,
  renderWorkflowPlanPage,
} from './workflowSurfaces/index.js';
import { validateServerWorkflowResultMetadata } from '../workflow/result/resultProtocol.js';
import { ServerRepairSeriesCoordinator } from '../workflow/server/serverRepairSeries.js';

function requireRuntime(context) {
  if (!context.zipflowWorkflowRuntime) {
    throw Object.assign(new Error('Workflow service is not available'), {
      code: 'WORKFLOW_SERVICE_UNAVAILABLE',
    });
  }
  return context.zipflowWorkflowRuntime;
}

function requireProject(state) {
  const projectRoot = String(state.projectRoot || '').trim();
  if (!projectRoot) throw new Error('No project opened. Use --project <path> or /project open <path>.');
  return projectRoot;
}

function printLines(lines) {
  for (const line of lines) console.log(line);
}

async function resolveRepairAction(context, surface) {
  const firstChoice = surface.sections?.flatMap((section) => section.choices || [])[0];
  const firstConflict = surface.sections?.flatMap((section) => section.conflicts || [])[0];
  if (surface.kind === 'archive_root_choice') {
    return { actionId: 'select-archive-root', input: { rootId: firstChoice?.id } };
  }
  if (surface.kind === 'archive_safety') {
    return await context.confirm?.('Acknowledge the advertised archive safety warnings? [y/N]')
      ? { actionId: 'acknowledge-archive-safety' }
      : null;
  }
  if (surface.kind === 'conflict_summary' || surface.kind === 'conflict_file') {
    return await context.confirm?.(`Use the repair archive for ${firstConflict?.path || 'the advertised conflict'}? [y/N]`)
      ? {
        actionId: 'resolve-conflict',
        input: { path: firstConflict?.path, decision: 'archive' },
      }
      : null;
  }
  if (surface.kind === 'plan_review' || surface.kind === 'plan_files') {
    return await context.confirm?.('Approve the advertised Zipflow plan? [y/N]')
      ? { actionId: 'approve-plan' }
      : null;
  }
  if (surface.kind === 'commit_choice') {
    return await context.confirm?.('Checks passed. Create the advertised final commit? [y/N]')
      ? { actionId: 'prepare-commit' }
      : { actionId: 'continue-without-commit' };
  }
  if (surface.kind === 'commit_message') {
    return { actionId: 'commit', input: { message: 'Repair project checks' } };
  }
  if (surface.kind === 'deploy_choice') {
    return await context.confirm?.('Run the configured deployment? [y/N]')
      ? { actionId: 'deploy' }
      : { actionId: 'skip-deploy' };
  }
  return null;
}

async function selectedArchive(context, explicitPath = '', { workflowId = '' } = {}) {
  if (explicitPath) {
    const absolutePath = path.resolve(explicitPath);
    const validation = await validateServerWorkflowResultMetadata({
      zipPath: absolutePath,
      producer: {
        name: 'chatgpt-bridge',
        workflowId,
        projectId: context.state.projectId,
      },
    });
    if (!validation.ok) {
      throw Object.assign(new Error(
        `Explicit ZIP result metadata is invalid: ${validation.reasons.join('; ')}`,
      ), {
        code: 'RESULT_PROTOCOL_INVALID',
        details: { reasons: validation.reasons },
      });
    }
    const imported = await context.fileStore.importLocalPath({
      filePath: absolutePath,
      name: path.basename(absolutePath),
    });
    const manifestProducer = validation.manifest?.producer || {};
    return {
      fileId: imported.id,
      filename: imported.name,
      expected: {
        size: imported.size,
        sha256: imported.sha256 || imported.metadata?.sha256 || '',
      },
      correlation: {
        workflowId: manifestProducer.workflowId,
        requestId: manifestProducer.requestId,
        projectId: manifestProducer.projectId,
      },
    };
  }
  const selected = normalizeSelectedResult(context.state.selectedResult);
  if (!selected?.fileId) {
    throw new Error('No selected ZIP result. Run a project task, use /recover, or pass a ZIP path.');
  }
  if (selected.stale) {
    throw Object.assign(new Error(`Selected ZIP result is stale: ${selected.staleReason || 'replaced'}`), {
      code: 'RESULT_STALE',
    });
  }
  if (selected.projectRoot
    && path.resolve(selected.projectRoot) !== path.resolve(context.state.projectRoot)) {
    throw Object.assign(new Error('Selected ZIP result belongs to another project'), {
      code: 'RESULT_PROJECT_MISMATCH',
    });
  }
  const readable = await context.fileStore.getReadable(selected.fileId);
  if (!readable?.absolutePath) throw new Error('Selected ZIP result is no longer readable');
  const producer = {
    name: 'chatgpt-bridge',
    workflowId,
    requestId: selected.sourceRequestId,
    projectId: selected.projectId,
  };
  const validation = await validateServerWorkflowResultMetadata({
    zipPath: readable.absolutePath,
    producer,
  });
  if (!validation.ok) {
    throw Object.assign(new Error(
      `Selected ZIP result metadata is invalid: ${validation.reasons.join('; ')}`,
    ), {
      code: 'RESULT_PROTOCOL_INVALID',
      details: { reasons: validation.reasons },
    });
  }
  return {
    fileId: selected.fileId,
    filename: selected.name || 'result.zip',
    expected: { size: selected.size, sha256: selected.sha256 },
    correlation: {
      workflowId: producer.workflowId,
      requestId: selected.sourceRequestId,
      projectId: selected.projectId,
      sessionId: selected.sessionId,
      turnId: selected.turnId,
      sourceClientId: selected.sourceClientId,
    },
  };
}

async function ensureArchiveWorkflow(runtime, opened) {
  if (!Object.prototype.hasOwnProperty.call(opened || {}, 'workflow') || opened.workflow) return;
  if (!opened.suggestedWorkflow) {
    throw Object.assign(new Error(
      'Zipflow did not provide a workflow or a suggested workflow for this project.',
    ), { code: 'WORKFLOW_CONFIGURATION_UNAVAILABLE' });
  }
  if (typeof runtime.configurePreset !== 'function') {
    throw Object.assign(new Error(
      'Workflow service cannot initialize the default apply workflow.',
    ), { code: 'WORKFLOW_CONFIGURATION_UNAVAILABLE' });
  }
  await runtime.configurePreset('apply-changes', {}, opened.workflowId);
  console.log('Workflow: initialized Apply changes from ChatGPT for this project.');
}

export async function startServerArchiveWorkflow(context, {
  explicitPath = '',
} = {}) {
  const runtime = requireRuntime(context);
  const projectRoot = requireProject(context.state);
  const opened = await runtime.openProject(projectRoot);
  const archive = await selectedArchive(context, explicitPath, {
    workflowId: opened.workflowId,
  });
  await ensureArchiveWorkflow(runtime, opened);
  const result = await runtime.uploadAndStartArchiveRun(archive);
  const run = result.run || {};
  console.log(`Workflow archive accepted: ${archive.filename}`);
  console.log(`Run: ${run.runId || run.id || '(starting)'}`);
  console.log('Project changes remain owned by the local workflow service. Review its advertised actions before applying.');
  await context.openWorkflowSurface?.();
  return result;
}

export async function runServerWorkflowCommand(context, args = []) {
  const runtime = requireRuntime(context);
  const projectRoot = requireProject(context.state);
  const sub = String(args[0] || 'open').toLowerCase();
  await runtime.openProject(projectRoot);

  if (['open', 'service', 'server'].includes(sub)) {
    await context.openWorkflowSurface?.();
    return true;
  }
  if (sub === 'history') {
    const response = await runtime.history({ limit: Math.max(1, Number(args[1]) || 20) });
    printLines(renderWorkflowHistoryPage(response?.body || response));
    return true;
  }
  if (sub === 'plan') {
    const response = await runtime.plan({ limit: Math.max(1, Number(args[1]) || 100) });
    printLines(renderWorkflowPlanPage(response?.body || response));
    return true;
  }
  if (sub === 'diff') {
    const filePath = args.slice(1).join(' ').trim();
    if (!filePath) throw new Error('Usage: /workflow service diff <path>');
    const response = await runtime.diff({ path: filePath, mode: 'unified' });
    printLines(renderWorkflowDiff(response?.body || response, { mode: 'unified' }));
    return true;
  }
  if (sub === 'report') {
    console.log(JSON.stringify(await runtime.report(), null, 2));
    return true;
  }
  if (sub === 'checks') {
    await runtime.startCheckRun();
    await context.openWorkflowSurface?.();
    return true;
  }
  if (sub === 'fix' || sub === 'run') {
    if (typeof context.requestProjectArtifact !== 'function') {
      throw new Error('ChatGPT project turns are not available for fix-until-pass');
    }
    const coordinator = new ServerRepairSeriesCoordinator({ runtime });
    const result = await coordinator.run({
      workflowId: runtime.snapshot().workflowId,
      requestRepair: async ({ prompt }) => {
        await context.requestProjectArtifact(prompt);
        return await selectedArchive(context, '', {
          workflowId: runtime.snapshot().workflowId,
        });
      },
      resolveAction: ({ surface }) => resolveRepairAction(context, surface),
    });
    if (result.status === 'waiting_action') {
      console.log('Fix-until-pass is waiting for an advertised workflow action.');
      await context.openWorkflowSurface?.();
    } else if (result.status === 'completed') {
      console.log(`Fix-until-pass completed after ${result.series.attempt} repair attempt(s).`);
    } else {
      console.log(`Fix-until-pass stopped: ${result.reason}.`);
    }
    return true;
  }
  if (sub === 'preset') {
    const preset = String(args[1] || '').trim();
    if (!preset) {
      throw new Error('Usage: /workflow service preset <apply-changes|fix-until-pass|guided-task>');
    }
    const preview = runtime.previewPreset(preset);
    console.log(JSON.stringify(preview, null, 2));
    const accepted = await context.confirm?.(`Save the ${preset} workflow configuration? [y/N]`);
    if (!accepted) {
      console.log('Workflow preset was not saved.');
      return true;
    }
    await runtime.configurePreset(preset);
    console.log(`Workflow preset saved: ${preset}`);
    await context.openWorkflowSurface?.();
    return true;
  }
  throw new Error('Usage: /workflow service [open|preset <id>|history|plan|diff <path>|report|checks|fix]');
}

export async function migrateLegacyWorkflowCommand(context, workflowId) {
  const migration = context.zipflowMigrationRuntime;
  if (!migration) throw new Error('Workflow migration is not available');
  const review = await migration.prepare(workflowId);
  console.log(JSON.stringify({
    migrationId: review.migrationId,
    workflowId: review.workflowId,
    eligible: review.eligible,
    blockers: review.blockers,
    warnings: review.warnings,
    target: review.target,
    bridgeRetained: review.bridgeRetained,
  }, null, 2));
  if (!review.eligible || review.blockers.length) {
    console.log('Legacy workflow remains on its current backend until every migration blocker is settled.');
    return { migrated: false, review };
  }
  const accepted = await context.confirm?.(
    `Migrate ${review.workflowId} to the reviewed server workflow? [y/N]`,
  );
  if (!accepted) {
    console.log('Workflow migration was not started.');
    return { migrated: false, review };
  }
  const result = await migration.migrate(review, {
    explicit: true,
    id: review.confirmation.id,
  });
  const legacy = context.workflowManager.get(review.workflowId);
  await context.zipflowWorkflowRuntime.openProject(
    legacy?.projectRoot || context.state.projectRoot,
    { workflowId: review.workflowId },
  );
  console.log(`Workflow migrated: ${review.workflowId}`);
  console.log(`Migration receipt: ${result.receipt.receiptId}`);
  await context.openWorkflowSurface?.({ workflowId: review.workflowId });
  return result;
}
