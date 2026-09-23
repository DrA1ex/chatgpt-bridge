import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../../config.js';
import { ZipflowArtifactTransfer } from './artifactTransfer.js';
import { WorkflowServerStore } from './workflowServerStore.js';
import { WorkflowOrchestrationStore } from './workflowOrchestrationStore.js';
import { ZipflowDaemonManager } from './zipflowDaemonManager.js';
import { ZipflowWorkflowClient } from './zipflowWorkflowClient.js';
import { ZipflowWorkflowCoordinator } from './zipflowWorkflowCoordinator.js';
import { buildServerWorkflowPreset } from './serverWorkflowPresets.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function text(value) {
  return String(value || '').trim();
}

function workflowIdForPath(projectPath) {
  const canonical = path.resolve(projectPath);
  const fingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return `project-${fingerprint}`;
}

function responseBody(value) {
  return value?.body && typeof value.body === 'object' ? value.body : value;
}

function responseRun(value) {
  const body = responseBody(value);
  return body?.run || body;
}

function mutationKey(kind, workflowId) {
  return `bridge:${kind}:${workflowId}:${randomUUID()}`;
}

function connectivityError(workflowId) {
  return Object.assign(new Error(
    `Workflow service connection is degraded for ${workflowId}; refresh before issuing another mutation.`,
  ), {
    code: 'WORKFLOW_CONNECTIVITY_DEGRADED',
    retryable: true,
    recoveryAction: 'refresh',
  });
}

export class ZipflowBridgeRuntime {
  constructor({
    dataDir = config.dataDir,
    fileStore = null,
    instanceId = randomUUID(),
    serverStore = null,
    orchestrationStore = null,
    daemonManager = null,
    daemonOptions = {},
    clientFactory = null,
    reconnectDelaysMs = [0, 100, 250, 500, 1_000],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.fileStore = fileStore;
    this.instanceId = text(instanceId);
    this.store = serverStore || new WorkflowServerStore(this.dataDir);
    this.orchestrationStore = orchestrationStore || new WorkflowOrchestrationStore(this.dataDir);
    this.listeners = new Set();
    this.contexts = new Map();
    this.activeWorkflowId = '';
    this.client = null;
    this.closed = false;
    this.reconnectDelaysMs = reconnectDelaysMs.map((value) => Math.max(0, Number(value) || 0));
    this.sleep = sleep;
    this.recoveries = new Map();
    const createClient = clientFactory || ((options) => new ZipflowWorkflowClient({
      ...options,
      instanceId: this.instanceId,
    }));
    this.daemon = daemonManager || new ZipflowDaemonManager({
      ...daemonOptions,
      clientFactory: createClient,
    });
  }

  health() {
    return this.daemon.health();
  }

  snapshot(workflowId = this.activeWorkflowId) {
    const context = this.contexts.get(text(workflowId));
    return {
      activeWorkflowId: this.activeWorkflowId,
      daemon: this.health(),
      workflowId: context?.workflowId || '',
      projectPath: context?.projectPath || '',
      workflow: clone(context?.workflow || null),
      suggestedWorkflow: clone(context?.suggestedWorkflow || null),
      orchestration: clone(context?.orchestration || null),
      ...context?.coordinator.snapshot(),
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Workflow listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(reason, workflowId = this.activeWorkflowId, details = {}) {
    const snapshot = this.snapshot(workflowId);
    for (const listener of this.listeners) {
      try {
        listener(snapshot, { reason, ...clone(details) });
      } catch {
        // A view listener cannot own durable workflow state.
      }
    }
  }

  async #ensureClient() {
    if (this.closed) throw Object.assign(new Error('Workflow service runtime is closed'), { code: 'WORKFLOW_RUNTIME_CLOSED' });
    if (!this.client) {
      const connected = await this.daemon.ensure();
      this.client = connected.client;
    }
    return this.client;
  }

  async openProject(projectPath, {
    workflowId = '',
    subscribe = true,
  } = {}) {
    const canonicalPath = path.resolve(text(projectPath) || process.cwd());
    const id = text(workflowId) || workflowIdForPath(canonicalPath);
    const client = await this.#ensureClient();
    let context = this.contexts.get(id);
    if (!context) {
      context = {
        workflowId: id,
        projectPath: canonicalPath,
        coordinator: null,
        workflow: null,
        suggestedWorkflow: null,
        orchestration: null,
      };
      context.coordinator = new ZipflowWorkflowCoordinator({
        client,
        store: this.store,
        workflowId: id,
        projectPath: canonicalPath,
        instanceId: this.instanceId,
        onSurface: (_surface, details) => this.#emit('surface', id, details),
        onEvent: (event, details) => this.#emit('event', id, { event, ...details }),
        onConnectivity: (connectivity) => {
          this.#emit('connectivity', id, { connectivity });
          if (connectivity.status === 'degraded' && connectivity.retryable) {
            this.#scheduleRecovery(id);
          }
        },
      });
      this.contexts.set(id, context);
    }
    this.activeWorkflowId = id;
    await context.coordinator.start({ subscribe });
    await Promise.all([
      this.#loadWorkflowResource(context),
      this.orchestrationStore.get(id).then((value) => { context.orchestration = value; }),
    ]);
    this.#emit('opened', id);
    return this.snapshot(id);
  }

  async #loadWorkflowResource(context) {
    const projectId = context.coordinator.state.localWorkflow.projectId;
    if (!projectId) return null;
    const resource = responseBody(await this.client.getWorkflow(projectId));
    context.workflow = clone(resource?.workflow || null);
    context.suggestedWorkflow = clone(resource?.suggestedWorkflow || null);
    return resource;
  }

  async refresh(workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    if (context.coordinator.connectivity.status === 'degraded') {
      await this.#recover(context);
    } else {
      try {
        await context.coordinator.synchronize({ reason: 'manual_refresh' });
      } catch (error) {
        if (!error?.retryable) throw error;
        await this.#recover(context);
      }
    }
    await this.#loadWorkflowResource(context);
    this.#emit('refreshed', context.workflowId);
    return this.snapshot(context.workflowId);
  }

  async saveWorkflow(draft, {
    workflowId = this.activeWorkflowId,
    expectedRevision = undefined,
  } = {}) {
    const context = this.#context(workflowId);
    this.#assertMutationReady(context);
    const projectId = context.coordinator.state.localWorkflow.projectId;
    const revision = expectedRevision ?? context.coordinator.resources.project?.workflowRevision ?? 0;
    const response = responseBody(await this.client.putWorkflow(projectId, draft, {
      ifMatch: revision,
      idempotencyKey: mutationKey('save-workflow', context.workflowId),
    }));
    context.workflow = clone(response?.workflow || draft);
    context.suggestedWorkflow = null;
    await context.coordinator.synchronize({ reason: 'workflow_saved' });
    this.#emit('workflow_saved', context.workflowId);
    return { ...response, surface: clone(context.coordinator.surface) };
  }

  async configurePreset(preset, options = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    const configured = this.previewPreset(preset, options, workflowId);
    const response = await this.saveWorkflow(configured.workflow, {
      workflowId: context.workflowId,
    });
    context.orchestration = await this.orchestrationStore.set(
      context.workflowId,
      configured.orchestration,
    );
    this.#emit('preset_configured', context.workflowId, { preset });
    return {
      ...response,
      orchestration: clone(context.orchestration),
    };
  }

  previewPreset(preset, options = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    const base = context.workflow || context.suggestedWorkflow;
    return buildServerWorkflowPreset(preset, base, options);
  }

  async updateOrchestration(patch = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    context.orchestration = await this.orchestrationStore.set(context.workflowId, {
      ...(context.orchestration || {}),
      ...clone(patch),
    });
    this.#emit('orchestration_updated', context.workflowId);
    return clone(context.orchestration);
  }

  async history(query = {}, workflowId = this.activeWorkflowId) {
    const context = await this.#readContext(workflowId);
    return await this.client.getHistory(context.coordinator.state.localWorkflow.projectId, query);
  }

  async plan(query = {}, workflowId = this.activeWorkflowId) {
    await this.#readContext(workflowId);
    return await this.client.getPlan(this.#runId(workflowId), query);
  }

  async diff(query = {}, workflowId = this.activeWorkflowId) {
    await this.#readContext(workflowId);
    return await this.client.getDiff(this.#runId(workflowId), query);
  }

  async output(query = {}, workflowId = this.activeWorkflowId) {
    await this.#readContext(workflowId);
    return await this.client.getOutput(this.#runId(workflowId), query);
  }

  async report(workflowId = this.activeWorkflowId) {
    await this.#readContext(workflowId);
    return await this.client.getReport(this.#runId(workflowId));
  }

  async startCheckRun(draft = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    this.#assertMutationReady(context);
    const result = responseRun(await this.client.startCheckRun(
      context.coordinator.state.localWorkflow.projectId,
      draft,
      { idempotencyKey: mutationKey('check-run', context.workflowId) },
    ));
    await this.#bindRun(context, result, 'check_run_started');
    return { run: clone(result), surface: clone(context.coordinator.surface) };
  }

  async uploadAndStartArchiveRun({
    fileId,
    expected = {},
    filename = '',
    seriesId = null,
    correlation = {},
    uploadIdempotencyKey = '',
    runIdempotencyKey = '',
  } = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    this.#assertMutationReady(context);
    const transfer = new ZipflowArtifactTransfer({
      fileStore: this.fileStore,
      client: this.client,
      persistCorrelation: async (value) => {
        await this.store.update(context.workflowId, {
          projectId: value.projectId,
          seriesId: value.seriesId || '',
          blobId: value.blobId,
          archiveSha256: value.sha256,
        });
      },
    });
    const result = await transfer.uploadAndStartArchiveRun({
      fileId,
      expected,
      filename,
      projectId: context.coordinator.state.localWorkflow.projectId,
      seriesId,
      correlation,
      uploadIdempotencyKey: text(uploadIdempotencyKey)
        || mutationKey('blob-upload', context.workflowId),
      runIdempotencyKey: text(runIdempotencyKey)
        || mutationKey('archive-run', context.workflowId),
    });
    await this.#bindRun(context, result.run, 'archive_run_started');
    return { ...result, surface: clone(context.coordinator.surface) };
  }

  async performAction(request = {}, workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    this.#assertMutationReady(context);
    if (request.actionId === 'save-workflow') {
      return await this.saveWorkflow(request.input?.workflow, {
        workflowId: context.workflowId,
        expectedRevision: request.surfaceRevision,
      });
    }
    const runId = this.#runId(context.workflowId);
    const response = responseBody(await this.client.performAction(
      runId,
      request.actionId,
      request.input || {},
      {
        ifMatch: request.surfaceRevision,
        idempotencyKey: mutationKey(`action-${request.actionId}`, context.workflowId),
      },
    ));
    await context.coordinator.synchronize({ reason: `action:${request.actionId}` });
    this.#emit('action', context.workflowId, { actionId: request.actionId });
    return { ...response, surface: clone(context.coordinator.surface) };
  }

  async cancel(workflowId = this.activeWorkflowId) {
    const context = this.#context(workflowId);
    this.#assertMutationReady(context);
    const operationId = context.coordinator.state.localWorkflow.operationId;
    if (!operationId) throw Object.assign(new Error('No active workflow operation'), { code: 'OPERATION_NOT_FOUND' });
    const result = await this.client.cancelOperation(operationId, {
      idempotencyKey: mutationKey('cancel-operation', context.workflowId),
    });
    await context.coordinator.synchronize({ reason: 'operation_cancelled' });
    return result;
  }

  async #bindRun(context, run, reason) {
    await this.store.update(context.workflowId, {
      runId: text(run?.runId || run?.id),
      operationId: text(run?.operationId || run?.operation?.id),
      seriesId: text(run?.seriesId),
    });
    await context.coordinator.reconnect({ subscribe: true });
    this.#emit(reason, context.workflowId);
  }

  #context(workflowId) {
    const id = text(workflowId);
    const context = this.contexts.get(id);
    if (!context) throw Object.assign(new Error(`Workflow is not connected: ${id || '(none)'}`), { code: 'WORKFLOW_NOT_CONNECTED' });
    return context;
  }

  #assertMutationReady(context) {
    if (context.coordinator.connectivity.status !== 'connected'
      || this.recoveries.has(context.workflowId)) {
      throw connectivityError(context.workflowId);
    }
  }

  async #readContext(workflowId) {
    const context = this.#context(workflowId);
    if (context.coordinator.connectivity.status === 'degraded'
      || this.recoveries.has(context.workflowId)) {
      await this.#recover(context);
    }
    return context;
  }

  #scheduleRecovery(workflowId) {
    if (this.closed || this.recoveries.has(workflowId)) return;
    const context = this.contexts.get(workflowId);
    if (!context) return;
    void this.#recover(context).catch(() => {});
  }

  async #recover(context) {
    const existing = this.recoveries.get(context.workflowId);
    if (existing) return await existing;
    const pending = this.#recoverWithBackoff(context).finally(() => {
      if (this.recoveries.get(context.workflowId) === pending) {
        this.recoveries.delete(context.workflowId);
      }
    });
    this.recoveries.set(context.workflowId, pending);
    return await pending;
  }

  async #recoverWithBackoff(context) {
    let lastError = null;
    for (const delayMs of this.reconnectDelaysMs) {
      if (this.closed) throw connectivityError(context.workflowId);
      if (delayMs) await this.sleep(delayMs);
      try {
        const connected = await this.daemon.ensure();
        this.client = connected.client;
        context.coordinator.replaceClient(connected.client);
        await context.coordinator.reconnect({ subscribe: true });
        await this.#loadWorkflowResource(context);
        this.#emit('reconnected', context.workflowId);
        return this.snapshot(context.workflowId);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || connectivityError(context.workflowId);
  }

  #runId(workflowId) {
    const context = this.#context(workflowId);
    const runId = context.coordinator.state.localWorkflow.runId;
    if (!runId) throw Object.assign(new Error('This workflow has no current run'), { code: 'RUN_NOT_FOUND' });
    return runId;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.recoveries.values());
    await Promise.all([...this.contexts.values()].map((context) => context.coordinator.stop()));
    await this.daemon.close();
    await this.store.close();
    await this.orchestrationStore.close();
    this.listeners.clear();
  }
}

export function createZipflowBridgeRuntime(options = {}) {
  return new ZipflowBridgeRuntime(options);
}
