import path from 'node:path';
import { log, error as logError } from '../../logger.js';
import { compactValue, nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import {
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  isWorkflowActive,
  reduceWorkflowState,
} from '../state/workflowState.js';

function runActive(state) {
  return isWorkflowActive(state) && Boolean(state?.run?.id);
}

export class WorkflowRuntimeCoordinator {
  constructor({
    workflows,
    queues,
    projectQueues,
    transitionQueues,
    store,
    notificationService,
    eventBus,
    refreshScheduler,
    deferredTurnQueue,
  } = {}) {
    Object.assign(this, {
      workflows,
      queues,
      projectQueues,
      transitionQueues,
      store,
      notificationService,
      eventBus,
      refreshScheduler,
      deferredTurnQueue,
    });
  }

  enqueue(workflowId, task) {
    const runtime = this.workflows.get(workflowId);
    const projectKey = runtime?.config?.projectRoot
      ? path.resolve(runtime.config.projectRoot)
      : `workflow:${workflowId}`;
    const previous = this.projectQueues.get(projectKey) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
      if (this.projectQueues.get(projectKey) === tracked) this.projectQueues.delete(projectKey);
      if (this.queues.get(workflowId) === tracked) this.queues.delete(workflowId);
    });
    this.projectQueues.set(projectKey, tracked);
    this.queues.set(workflowId, tracked);
    return tracked;
  }

  require(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) throw new Error(`Unknown workflow: ${workflowId}`);
    return runtime;
  }

  async transition(runtime, type, data = {}, publishedType = '', publishedData = {}, persistence = {}) {
    const previous = this.transitionQueues.get(runtime.id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#performTransition(runtime, type, data, publishedType, publishedData, persistence));
    const tracked = operation.finally(() => {
      if (this.transitionQueues.get(runtime.id) === tracked) this.transitionQueues.delete(runtime.id);
    });
    this.transitionQueues.set(runtime.id, tracked);
    return await tracked;
  }

  async #performTransition(runtime, type, data = {}, publishedType = '', publishedData = {}, persistence = {}) {
    const at = nowIso();
    const eventId = String(persistence.eventId || createWorkflowId('workflow-transition'));
    const wasRunActive = runActive(runtime.workflowState);
    const event = { eventId, type, data, at };
    if (persistence.expectedRevision != null) event.expectedRevision = persistence.expectedRevision;
    const outcome = reduceWorkflowState(runtime.workflowState, event);
    if (!outcome.accepted) {
      const diagnostic = outcome.diagnostics?.[0];
      await this.store.commitTransition(runtime.id, publicWorkflowSnapshot(runtime), {
        workflowId: runtime.id,
        eventId,
        accepted: false,
        revision: runtime.workflowState.revision,
        at,
        type,
        data: compactValue(data),
        diagnostics: compactValue(outcome.diagnostics || []),
        lifecycle: runtime.workflowState.lifecycle,
        phase: runtime.workflowState.run?.phase || WorkflowPhase.NONE,
      });
      const error = new Error(diagnostic?.message || `Workflow state transition rejected: ${type}`);
      error.code = diagnostic?.code || 'WORKFLOW_STATE_TRANSITION_REJECTED';
      throw error;
    }
    runtime.workflowState = outcome.state;
    if (outcome.state.run?.id) runtime.lastPipelineId = outcome.state.run.id;
    if (Object.prototype.hasOwnProperty.call(data, 'lastError')) runtime.lastError = String(data.lastError || '');
    runtime.updatedAt = at;
    await this.store.commitTransition(runtime.id, publicWorkflowSnapshot(runtime), {
      workflowId: runtime.id,
      eventId,
      accepted: true,
      revision: outcome.state.revision,
      at,
      type,
      data: compactValue(data),
      lifecycle: outcome.state.lifecycle,
      phase: outcome.state.run?.phase || WorkflowPhase.NONE,
      nextActionId: outcome.state.nextAction?.id || '',
    }, {
      decisions: persistence.decisions || {},
      artifacts: persistence.artifacts || {},
    });
    if (outcome.state.nextAction) {
      await this.notificationService.notify({
        key: `${runtime.id}:${outcome.state.nextAction.id}`,
        title: 'Workflow needs attention',
        body: outcome.state.nextAction.reason || outcome.state.nextAction.kind,
        config: runtime.config.ux?.notifications,
      }).catch(() => {});
    }
    if (publishedType) {
      await this.publish(runtime.id, publishedType, {
        ...publishedData,
        workflowStateRevision: outcome.state.revision,
        lifecycle: outcome.state.lifecycle,
        phase: outcome.state.run?.phase || WorkflowPhase.NONE,
      });
    }
    if (wasRunActive && !runActive(outcome.state)) this.deferredTurnQueue.schedule(runtime);
    return outcome.state;
  }

  async persist(runtime) {
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    return runtime;
  }

  async fail(workflowId, error) {
    const runtime = this.workflows.get(workflowId);
    const message = error.message || String(error);
    const code = error.code || '';
    if (runtime) {
      runtime.lastError = message;
      const pipelineId = runtime.workflowState?.run?.id || runtime.lastPipelineId || '';
      if (pipelineId && [WorkflowLifecycle.RUNNING, WorkflowLifecycle.RECOVERING].includes(runtime.workflowState.lifecycle)) {
        await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
          runId: pipelineId,
          code: code || 'workflow_pipeline_failed',
          message,
        }, 'workflow.failed', { message, code, pipelineId }).catch(async () => {
          await this.persist(runtime).catch(() => {});
          await this.publish(workflowId, 'workflow.failed', { message, code, pipelineId });
        });
      } else {
        await this.persist(runtime).catch(() => {});
        await this.publish(workflowId, 'workflow.failed', { message, code, pipelineId });
      }
      this.refreshScheduler.sync(runtime);
    } else {
      await this.publish(workflowId, 'workflow.failed', { message, code });
    }
    logError(`[workflow:${workflowId}] ${error.stack || error.message || error}`);
  }

  async publish(workflowId, type, data = {}) {
    const event = {
      id: createWorkflowId('workflow-event'),
      workflowId,
      type,
      time: nowIso(),
      data: compactValue(data),
    };
    await this.store.appendEvent(event).catch(() => {});
    this.eventBus?.emitUser({ type, data: { workflowId, ...data } });
    const summary = JSON.stringify(data, (key, value) => typeof value === 'string' && value.length > 400 ? `${value.slice(0, 400)}…` : value);
    log(`[workflow:${workflowId || 'global'}] ${type}${summary && summary !== '{}' ? ` ${summary}` : ''}`);
    return event;
  }
}
