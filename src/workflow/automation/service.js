import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import { WorkflowEventType, WorkflowLifecycle, WorkflowRunKind } from '../state/workflowState.js';

function automationActive(runtime) {
  return runtime?.workflowState?.run?.kind === WorkflowRunKind.AUTOMATION
    && ![WorkflowLifecycle.READY, WorkflowLifecycle.STOPPED].includes(runtime.workflowState.lifecycle);
}

export class WorkflowAutomationService {
  constructor({ bridge, store, controller, publish } = {}) {
    this.bridge = bridge;
    this.store = store;
    this.controller = controller;
    this.publish = publish;
  }

  async restore(runtime) {
    if (!automationActive(runtime)) return null;
    return await this.controller.restore(runtime);
  }

  async run(runtime, options = {}) {
    if (automationActive(runtime)) throw new Error(`Workflow ${runtime.id} already has an active run`);
    const session = await this.#resolveSession(runtime, options);
    return await this.controller.start(runtime, {
      ...options,
      sessionId: session.id,
      sessionPolicy: session.policy,
    });
  }

  async pause(runtime, reason = 'paused by user') {
    if (!automationActive(runtime)) {
      throw new Error(`Workflow ${runtime.id} has no active run to pause`);
    }
    return await this.controller.pause(runtime, reason);
  }

  async stop(runtime, reason = 'stopped by user') {
    return await this.controller.stop(runtime, reason);
  }

  async resume(runtime) {
    if (runtime.workflowState.lifecycle !== WorkflowLifecycle.PAUSED) throw new Error(`Workflow ${runtime.id} has no paused run to resume`);
    await this.controller.resume(runtime);
    return await this.controller.restore(runtime);
  }

  async discard(runtime, reason = 'discarded by user') {
    if (!automationActive(runtime)) {
      throw new Error(`Workflow ${runtime.id} has no active or interrupted run to discard`);
    }
    const result = await this.controller.stop(runtime, reason);
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    return result;
  }

  async restart(runtime, options = {}) {
    if (automationActive(runtime)) {
      await this.stop(runtime, 'restarting workflow run');
      const stopped = await this.controller.waitForIdle(runtime.id, 30_000);
      if (!stopped) throw new Error(`Timed out stopping workflow ${runtime.id} before restart`);
    }
    return await this.run(runtime, options);
  }

  async #resolveSession(runtime, options = {}) {
    const configured = runtime.config.automation.session || { policy: 'current', id: '' };
    const requested = String(options.sessionPolicy || configured.policy || 'current').toLowerCase();
    const explicitId = String(options.sessionId || '').trim();
    if (requested === 'pinned') {
      const id = explicitId || String(configured.id || '').trim();
      if (!id) throw new Error(`Workflow ${runtime.id} requires a pinned session id`);
      return { policy: 'pinned', id };
    }
    if (requested === 'new') {
      const created = await this.bridge.newSession({ sourceClientId: options.sourceClientId || undefined });
      const session = created?.session || created?.current || created;
      const id = String(session?.id || session?.sessionId || '').trim();
      if (!id) throw new Error('ChatGPT did not return a session id for the new workflow session');
      return { policy: 'new', id };
    }
    if (requested !== 'current') throw new Error(`Invalid workflow session policy: ${requested}`);
    const activeClient = this.bridge.health?.().activeClient || null;
    const currentId = explicitId || String(activeClient?.session?.id || activeClient?.sessionId || '').trim();
    return { policy: 'current', id: currentId };
  }
}
