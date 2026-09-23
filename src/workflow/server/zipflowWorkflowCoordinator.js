import { randomUUID } from 'node:crypto';
import {
  normalizeWorkflowServerState,
  patchWorkflowServerState,
} from './workflowServerState.js';

const SURFACE_EVENT_TYPES = new Set(['surface.changed', 'run.attention']);
const NOT_FOUND_CODES = new Set(['RUN_NOT_FOUND', 'OPERATION_NOT_FOUND']);

function text(value) {
  return String(value || '').trim();
}

function sequence(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function coordinatorError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function normalizeEvent(value = {}) {
  const event = value && typeof value === 'object' ? value : {};
  const normalized = {
    ...event,
    type: text(event.type || event.event),
    serverEpoch: text(event.serverEpoch),
    sequence: sequence(event.sequence ?? event.id),
    projectId: text(event.projectId),
    runId: text(event.runId),
    operationId: text(event.operationId),
    revision: sequence(event.revision),
    data: event.data && typeof event.data === 'object' ? event.data : {},
  };
  if (!normalized.type) throw coordinatorError('WORKFLOW_EVENT_TYPE_REQUIRED', 'Workflow event type is required');
  if (!normalized.serverEpoch) throw coordinatorError('WORKFLOW_EVENT_EPOCH_REQUIRED', 'Workflow event server epoch is required');
  if (normalized.sequence < 0) throw coordinatorError('WORKFLOW_EVENT_SEQUENCE_INVALID', 'Workflow event sequence must be a non-negative integer');
  return normalized;
}

function operationIdFrom(run = {}, fallback = '') {
  const source = run && typeof run === 'object' ? run : {};
  return text(source.operationId || source.operation?.id || source.activeOperationId || fallback);
}

export class ZipflowWorkflowCoordinator {
  constructor({
    client,
    store,
    workflowId,
    projectPath = '',
    instanceId = '',
    onEvent = () => {},
    onSurface = () => {},
    onConnectivity = () => {},
  } = {}) {
    if (!client) throw new TypeError('Zipflow workflow coordinator requires a client');
    if (!store) throw new TypeError('Zipflow workflow coordinator requires a store');
    this.client = client;
    this.store = store;
    this.workflowId = text(workflowId);
    if (!this.workflowId) throw new TypeError('Zipflow workflow coordinator requires a workflow ID');
    this.projectPath = text(projectPath);
    this.instanceId = text(instanceId);
    this.idempotencyNamespace = this.instanceId || randomUUID();
    this.onEvent = onEvent;
    this.onSurface = onSurface;
    this.onConnectivity = onConnectivity;
    this.state = normalizeWorkflowServerState();
    this.resources = { hello: null, project: null, run: null, operation: null };
    this.surface = null;
    this.connectivity = {
      status: 'idle',
      error: '',
      retryable: false,
      serverEpoch: '',
    };
    this.abortController = null;
    this.subscription = null;
    this.streamPromise = null;
    this.eventChain = Promise.resolve();
    this.eventFailure = null;
  }

  snapshot() {
    return {
      state: clone(this.state),
      resources: clone(this.resources),
      surface: clone(this.surface),
      connectivity: clone(this.connectivity),
    };
  }

  replaceClient(client) {
    if (!client) throw new TypeError('Replacement Zipflow client is required');
    this.client = client;
  }

  async #setConnectivity(status, error = null, serverEpoch = '') {
    this.connectivity = {
      status,
      error: error ? text(error.message || error) : '',
      retryable: error?.retryable === true,
      serverEpoch: text(serverEpoch || this.state.localWorkflow.serverEpoch),
    };
    await Promise.resolve(this.onConnectivity(clone(this.connectivity))).catch(() => null);
  }

  async #optionalResource(load) {
    try {
      return await load();
    } catch (error) {
      if (NOT_FOUND_CODES.has(text(error?.code))) return null;
      throw error;
    }
  }

  async synchronize({
    reason = 'manual',
    cursor = null,
    expectedEpoch = '',
  } = {}) {
    await this.#setConnectivity('connecting');
    try {
      const previous = await this.store.get(this.workflowId) || normalizeWorkflowServerState();
      const hello = await this.client.hello();
      const serverEpoch = text(hello.serverEpoch);
      if (expectedEpoch && serverEpoch !== text(expectedEpoch)) {
        throw coordinatorError(
          'WORKFLOW_SERVER_EPOCH_MISMATCH',
          `Workflow event epoch ${expectedEpoch} does not match hello epoch ${serverEpoch}`,
        );
      }
      const previousLocal = previous.localWorkflow;
      const epochChanged = Boolean(previousLocal.serverEpoch && previousLocal.serverEpoch !== serverEpoch);
      let projectId = previousLocal.projectId;
      let opened = null;
      if (epochChanged || !projectId) {
        if (!this.projectPath) {
          if (epochChanged) {
            throw coordinatorError(
              'WORKFLOW_PROJECT_PATH_REQUIRED',
              'The canonical project path is required after a workflow server restart',
            );
          }
        } else {
          opened = await this.client.openProject(this.projectPath, {
            idempotencyKey: `bridge:${this.idempotencyNamespace}:${this.workflowId}:open-project`,
            instanceId: this.instanceId,
          });
          projectId = text(opened?.projectId);
        }
      }

      let project = opened;
      if (projectId) project = await this.client.getProject(projectId);
      const activeRunId = text(project?.activeRunId || project?.runId);
      const runId = activeRunId || previousLocal.runId;
      const run = runId
        ? await this.#optionalResource(() => this.client.getRun(runId))
        : null;
      const operationId = operationIdFrom(run, previousLocal.operationId);
      const operation = operationId
        ? await this.#optionalResource(() => this.client.getOperation(operationId))
        : null;
      const surface = runId
        ? await this.#optionalResource(() => this.client.getSurface(runId))
        : (project?.surface || opened?.surface || null);
      const nextCursor = cursor == null
        ? epochChanged ? 0 : previousLocal.eventCursor
        : Math.max(0, sequence(cursor));
      this.state = await this.store.update(this.workflowId, (current) => {
        const currentLocal = current.localWorkflow;
        const currentEpochMatches = currentLocal.serverEpoch === serverEpoch;
        const durableCursor = currentEpochMatches ? currentLocal.eventCursor : 0;
        const durableSurfaceRevision = currentEpochMatches
          ? currentLocal.lastSurfaceRevision
          : 0;
        return patchWorkflowServerState(current, {
          projectId,
          runId: text(run?.runId || run?.id),
          operationId: text(operation?.operationId || operation?.id),
          serverEpoch,
          eventCursor: Math.max(nextCursor, durableCursor),
          lastSurfaceRevision: surface
            ? Math.max(
              0,
              sequence(surface.revision),
              durableSurfaceRevision,
            )
            : Math.max(
              epochChanged ? 0 : previousLocal.lastSurfaceRevision,
              durableSurfaceRevision,
            ),
        });
      });
      this.resources = { hello: clone(hello), project: clone(project), run: clone(run), operation: clone(operation) };
      const liveSurface = this.surface;
      const fetchedSurfaceRevision = surface ? Math.max(0, sequence(surface.revision)) : -1;
      const liveSurfaceRevision = liveSurface ? Math.max(0, sequence(liveSurface.revision)) : -1;
      const preserveLiveSurface = !epochChanged
        && liveSurface
        && liveSurfaceRevision > fetchedSurfaceRevision
        && liveSurfaceRevision === this.state.localWorkflow.lastSurfaceRevision;
      this.surface = clone(preserveLiveSurface ? liveSurface : surface);
      this.eventFailure = null;
      await this.#setConnectivity('connected', null, serverEpoch);
      if (this.surface) {
        await Promise.resolve(this.onSurface(clone(this.surface), {
          reason,
          resynchronized: true,
          epochChanged,
        })).catch(() => null);
      }
      return {
        ...this.snapshot(),
        reason,
        epochChanged,
      };
    } catch (error) {
      await this.#setConnectivity('degraded', error);
      throw error;
    }
  }

  async applyEvent(value) {
    const event = normalizeEvent(value);
    const current = await this.store.get(this.workflowId) || this.state;
    const local = current.localWorkflow;
    if (local.serverEpoch && event.serverEpoch !== local.serverEpoch) {
      const result = await this.synchronize({
        reason: 'epoch_changed',
        cursor: event.sequence,
        expectedEpoch: event.serverEpoch,
      });
      await Promise.resolve(this.onEvent(clone(event), {
        durable: true,
        resynchronized: true,
        reason: 'epoch_changed',
      })).catch(() => null);
      return { applied: true, resynchronized: true, duplicate: false, result };
    }
    if (!local.serverEpoch) {
      await this.synchronize({
        reason: 'event_before_connect',
        cursor: event.sequence,
        expectedEpoch: event.serverEpoch,
      });
      await Promise.resolve(this.onEvent(clone(event), {
        durable: true,
        resynchronized: true,
        reason: 'event_before_connect',
      })).catch(() => null);
      return { applied: true, resynchronized: true, duplicate: false };
    }
    if (event.sequence <= local.eventCursor) {
      return { applied: false, resynchronized: false, duplicate: true };
    }
    if (event.projectId && local.projectId && event.projectId !== local.projectId) {
      throw coordinatorError(
        'WORKFLOW_EVENT_PROJECT_MISMATCH',
        `Workflow event project ${event.projectId} does not match ${local.projectId}`,
      );
    }
    if (event.type === 'stream.gap') {
      const result = await this.synchronize({
        reason: 'stream_gap',
        cursor: event.sequence,
        expectedEpoch: event.serverEpoch,
      });
      await Promise.resolve(this.onEvent(clone(event), {
        durable: true,
        resynchronized: true,
        reason: 'stream_gap',
      })).catch(() => null);
      return { applied: true, resynchronized: true, duplicate: false, result };
    }

    const runId = event.runId || local.runId;
    let surface = event.data?.surface && typeof event.data.surface === 'object'
      ? event.data.surface
      : null;
    if (!surface && SURFACE_EVENT_TYPES.has(event.type) && runId) {
      surface = await this.client.getSurface(runId);
    }
    const next = await this.store.update(this.workflowId, (state) => patchWorkflowServerState(state, {
      projectId: event.projectId || state.localWorkflow.projectId,
      runId,
      operationId: event.operationId || state.localWorkflow.operationId,
      serverEpoch: event.serverEpoch,
      eventCursor: event.sequence,
      lastSurfaceRevision: surface?.revision ?? (
        SURFACE_EVENT_TYPES.has(event.type) && event.revision >= 0
          ? event.revision
          : state.localWorkflow.lastSurfaceRevision
      ),
    }));
    this.state = next;
    if (surface) {
      this.surface = clone(surface);
      await Promise.resolve(this.onSurface(clone(surface), {
        reason: event.type,
        resynchronized: false,
        event: clone(event),
      })).catch(() => null);
    }
    await Promise.resolve(this.onEvent(clone(event), {
      durable: true,
      resynchronized: false,
    })).catch(() => null);
    return { applied: true, resynchronized: false, duplicate: false };
  }

  enqueueEvent(event) {
    if (this.eventFailure) return Promise.reject(this.eventFailure);
    const pending = this.eventChain.then(() => this.applyEvent(event));
    this.eventChain = pending.catch(async (error) => {
      this.eventFailure = error;
      await this.#setConnectivity('degraded', error);
    });
    return pending;
  }

  async #consumeAsyncEvents(stream, signal) {
    try {
      for await (const event of stream) {
        if (signal.aborted) break;
        await this.enqueueEvent(event);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.eventFailure = error;
        await this.#setConnectivity('degraded', error);
      }
    }
  }

  async subscribe() {
    if (this.abortController) return this.subscription;
    const state = await this.store.get(this.workflowId) || this.state;
    const local = state.localWorkflow;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const options = {
      projectId: local.projectId || undefined,
      runId: local.runId || undefined,
      operationId: local.operationId || undefined,
      lastEventId: local.eventCursor,
      signal,
      onEvent: (event) => {
        void this.enqueueEvent(event).catch(() => this.abortController?.abort());
      },
      onError: (error) => {
        if (!signal.aborted) void this.#setConnectivity('degraded', error);
      },
    };
    this.subscription = await this.client.subscribeEvents(options);
    if (this.subscription?.[Symbol.asyncIterator]) {
      this.streamPromise = this.#consumeAsyncEvents(this.subscription, signal);
    }
    return this.subscription;
  }

  async start({ subscribe = true } = {}) {
    const result = await this.synchronize({ reason: 'start' });
    if (subscribe) await this.subscribe();
    return result;
  }

  async reconnect({ subscribe = true } = {}) {
    await this.#closeSubscription();
    this.eventFailure = null;
    this.eventChain = Promise.resolve();
    const result = await this.synchronize({ reason: 'reconnect' });
    if (subscribe) await this.subscribe();
    return result;
  }

  async #closeSubscription() {
    this.abortController?.abort();
    this.abortController = null;
    const subscription = this.subscription;
    this.subscription = null;
    if (typeof subscription === 'function') await subscription();
    else if (typeof subscription?.unsubscribe === 'function') await subscription.unsubscribe();
    else if (typeof subscription?.close === 'function') await subscription.close();
    await this.streamPromise?.catch(() => null);
    this.streamPromise = null;
  }

  async stop() {
    await this.#closeSubscription();
    await this.eventChain.catch(() => null);
    await this.#setConnectivity('stopped');
  }
}
