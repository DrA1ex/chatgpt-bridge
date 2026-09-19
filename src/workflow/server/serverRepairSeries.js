import { randomUUID } from 'node:crypto';

const TRANSIENT_SURFACES = new Set(['operation_progress', 'archive_inspecting']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function checksFromReport(value) {
  const report = value?.body || value || {};
  const checks = report.checks || report.summary?.checks || {};
  return {
    ok: checks.ok === true || (
      Number(checks.failed) === 0
      && Array.isArray(checks.results)
      && checks.results.length > 0
      && checks.results.every((item) => item.ok === true)
    ),
    report,
  };
}

function failureText(value) {
  const resource = value?.body || value || {};
  const lines = Array.isArray(resource.lines)
    ? resource.lines
    : Array.isArray(resource.items)
      ? resource.items.flatMap((item) => item.lines || item.text || [])
      : [];
  const rendered = lines.length ? lines.join('\n') : JSON.stringify(resource);
  return rendered.slice(-20_000);
}

function advertisedAction(surface, actionId) {
  return surface?.actions?.find((action) => action.id === actionId && action.enabled !== false) || null;
}

function actionRequest(surface, decision) {
  const action = advertisedAction(surface, decision?.actionId);
  if (!action) {
    throw Object.assign(new Error(`Workflow action is not advertised: ${decision?.actionId || '(none)'}`), {
      code: 'WORKFLOW_ACTION_NOT_ADVERTISED',
    });
  }
  return {
    actionId: action.id,
    actionKind: action.kind,
    input: clone(decision.input || {}),
    surfaceId: surface.id,
    surfaceRevision: surface.revision,
    links: clone(surface.links || {}),
  };
}

function repairPrompt({ attempt, maxAttempts, seriesId, output }) {
  return [
    'The configured project checks failed after a Zipflow-controlled iteration.',
    `Repair attempt ${attempt} of ${maxAttempts}. Series: ${seriesId}.`,
    '',
    'Fix the failures and return one complete project ZIP. Preserve unrelated files.',
    'The project archive will be validated and uploaded to Zipflow; do not return a patch.',
    '',
    'CHECK_OUTPUT_BEGIN',
    output,
    'CHECK_OUTPUT_END',
  ].join('\n');
}

export class ServerRepairSeriesCoordinator {
  constructor({
    runtime,
    createId = () => `bridge-series-${randomUUID()}`,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs = 100,
    maxSurfacePolls = 600,
  } = {}) {
    if (!runtime) throw new TypeError('Zipflow runtime is required');
    this.runtime = runtime;
    this.createId = createId;
    this.sleep = sleep;
    this.pollMs = Math.max(0, Number(pollMs) || 0);
    this.maxSurfacePolls = Math.max(1, Number(maxSurfacePolls) || 1);
  }

  async run({
    workflowId = '',
    requestRepair,
    resolveAction,
    maxAttempts = undefined,
    noProgressLimit = undefined,
  } = {}) {
    if (typeof requestRepair !== 'function') throw new TypeError('requestRepair callback is required');
    const snapshot = this.runtime.snapshot(workflowId);
    const orchestration = snapshot.orchestration || {};
    if (orchestration.preset !== 'fix-until-pass' || orchestration.remediation?.enabled !== true) {
      throw Object.assign(new Error('The active server workflow is not configured for fix-until-pass'), {
        code: 'WORKFLOW_PRESET_MISMATCH',
      });
    }
    const attemptsLimit = Math.max(
      1,
      Number(maxAttempts ?? orchestration.attempts?.checkCycles) || 1,
    );
    const progressLimit = Math.max(
      1,
      Number(noProgressLimit ?? orchestration.noProgressLimit) || 1,
    );
    const restored = orchestration.series?.status === 'active'
      ? clone(orchestration.series)
      : null;
    const series = {
      id: restored?.id || this.createId(),
      status: 'active',
      stage: restored?.stage || 'new',
      attempt: Math.max(0, Number(restored?.attempt) || 0),
      noProgress: Math.max(0, Number(restored?.noProgress) || 0),
      lastSha256: String(restored?.lastSha256 || ''),
      artifact: clone(restored?.artifact || null),
    };
    await this.#persist(workflowId, series);

    let boundary;
    const local = snapshot.state?.localWorkflow || {};
    const run = snapshot.resources?.run || {};
    const resumableArchive = run.kind === 'archive' && run.seriesId === series.id;
    if (restored?.stage === 'requesting_repair' && !series.artifact) {
      return {
        status: 'waiting_action',
        reason: 'repair_response_uncertain',
        series: clone(series),
        snapshot,
      };
    }
    if (resumableArchive) {
      boundary = await this.#advance(workflowId, resolveAction, series);
    } else if (series.artifact
      && ['artifact_ready', 'starting_archive'].includes(series.stage)) {
      if (snapshot.surface && advertisedAction(snapshot.surface, 'finish')) {
        await this.runtime.performAction(
          actionRequest(snapshot.surface, { actionId: 'finish', input: {} }),
          workflowId,
        );
        await this.#waitForProjectIdle(workflowId);
      }
      await this.#startArchive(workflowId, series);
      boundary = await this.#advance(workflowId, resolveAction, series);
    } else if (local.seriesId === series.id && local.runId) {
      boundary = await this.#advance(workflowId, resolveAction, series);
    } else {
      series.stage = 'starting_checks';
      await this.#persist(workflowId, series);
      await this.runtime.startCheckRun({ seriesId: series.id }, workflowId);
      series.stage = 'checking';
      await this.#persist(workflowId, series);
      boundary = await this.#advance(workflowId, resolveAction, series);
    }

    while (true) {
      if (boundary.kind === 'waiting_action') {
        return { status: 'waiting_action', series: clone(series), snapshot: boundary.snapshot };
      }
      if (boundary.kind === 'passed') {
        series.status = 'completed';
        series.stage = 'completed';
        await this.#persist(workflowId, series);
        return { status: 'completed', series: clone(series), report: boundary.report };
      }
      if (series.attempt >= attemptsLimit) {
        return await this.#stop(workflowId, series, 'attempt_limit', boundary.report);
      }

      const outputResource = await this.runtime.output({ source: 'checks' }, workflowId);
      const output = failureText(outputResource);
      series.attempt += 1;
      series.stage = 'requesting_repair';
      await this.#persist(workflowId, series);
      const artifact = await requestRepair({
        workflowId,
        seriesId: series.id,
        attempt: series.attempt,
        maxAttempts: attemptsLimit,
        output,
        report: clone(boundary.report),
        prompt: repairPrompt({
          attempt: series.attempt,
          maxAttempts: attemptsLimit,
          seriesId: series.id,
          output,
        }),
      });
      const sha256 = String(artifact?.expected?.sha256 || artifact?.sha256 || '').trim();
      if (!artifact?.fileId || !sha256) {
        throw Object.assign(new Error('Repair callback did not return a verified ZIP artifact'), {
          code: 'WORKFLOW_REPAIR_ARTIFACT_INVALID',
        });
      }
      series.noProgress = sha256 === series.lastSha256 ? series.noProgress + 1 : 0;
      series.lastSha256 = sha256;
      series.artifact = clone({
        fileId: artifact.fileId,
        filename: artifact.filename || 'result.zip',
        expected: { ...(artifact.expected || {}), sha256 },
        correlation: artifact.correlation || {},
        uploadIdempotencyKey: `bridge:${series.id}:upload:${series.attempt}`,
        runIdempotencyKey: `bridge:${series.id}:archive:${series.attempt}`,
      });
      series.stage = 'artifact_ready';
      await this.#persist(workflowId, series);
      if (series.noProgress >= progressLimit) {
        return await this.#stop(workflowId, series, 'no_progress', boundary.report);
      }

      if (boundary.surface && advertisedAction(boundary.surface, 'finish')) {
        await this.runtime.performAction(
          actionRequest(boundary.surface, { actionId: 'finish', input: {} }),
          workflowId,
        );
        await this.#waitForProjectIdle(workflowId);
      }
      await this.#startArchive(workflowId, series);
      boundary = await this.#advance(workflowId, resolveAction, series);
    }
  }

  async #advance(workflowId, resolveAction, series) {
    for (let poll = 0; poll < this.maxSurfacePolls; poll += 1) {
      const snapshot = await this.runtime.refresh(workflowId);
      const surface = snapshot.surface;
      if (!surface || TRANSIENT_SURFACES.has(surface.kind)) {
        await this.sleep(this.pollMs);
        continue;
      }
      if (surface.kind === 'checks_failed') {
        const { report } = checksFromReport(await this.runtime.report(workflowId));
        return { kind: 'failed', report, surface, snapshot };
      }
      if (surface.kind === 'completed') {
        const { ok, report } = checksFromReport(await this.runtime.report(workflowId));
        return { kind: ok ? 'passed' : 'failed', report, surface, snapshot };
      }
      const decision = typeof resolveAction === 'function'
        ? await resolveAction({ surface: clone(surface), series: clone(series), workflowId })
        : null;
      if (!decision) return { kind: 'waiting_action', surface, snapshot };
      await this.runtime.performAction(actionRequest(surface, decision), workflowId);
    }
    throw Object.assign(new Error('Workflow surface did not settle within the polling limit'), {
      code: 'WORKFLOW_SURFACE_TIMEOUT',
    });
  }

  async #persist(workflowId, series) {
    await this.runtime.updateOrchestration({ series: clone(series) }, workflowId);
  }

  async #startArchive(workflowId, series) {
    series.stage = 'starting_archive';
    await this.#persist(workflowId, series);
    await this.runtime.uploadAndStartArchiveRun({
      ...series.artifact,
      seriesId: series.id,
      correlation: {
        ...series.artifact.correlation,
        workflowId,
        requestId: `${series.id}:repair:${series.attempt}`,
      },
    }, workflowId);
    series.stage = 'applying_repair';
    await this.#persist(workflowId, series);
  }

  async #waitForProjectIdle(workflowId) {
    for (let poll = 0; poll < this.maxSurfacePolls; poll += 1) {
      const snapshot = await this.runtime.refresh(workflowId);
      if (!snapshot.resources?.project?.activeRunId) return snapshot;
      await this.sleep(this.pollMs);
    }
    throw Object.assign(new Error('Workflow project remained busy after finishing the failed run'), {
      code: 'WORKFLOW_PROJECT_BUSY_TIMEOUT',
    });
  }

  async #stop(workflowId, series, reason, report) {
    series.status = 'stopped';
    series.stage = reason;
    await this.#persist(workflowId, series);
    return { status: 'stopped', reason, series: clone(series), report: clone(report) };
  }
}

export function createServerRepairSeriesCoordinator(options = {}) {
  return new ServerRepairSeriesCoordinator(options);
}
