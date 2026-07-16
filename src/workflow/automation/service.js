import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import { isWorkflowAutomationActive } from '../state/workflowState.js';

export class WorkflowAutomationService {
  constructor({ bridge, store, controller, publish } = {}) {
    this.bridge = bridge;
    this.store = store;
    this.controller = controller;
    this.publish = publish;
  }

  async restore(runtime) {
    if (!isWorkflowAutomationActive(runtime.workflowState)) return null;
    const restartPolicy = runtime.config.automation.restartPolicy || 'ask';
    if (restartPolicy === 'auto') return await this.controller.restore(runtime);
    if (restartPolicy === 'discard') return await this.controller.stop(runtime, 'discarded after daemon restart');
    runtime.automationInterrupted = true;
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    await this.publish(runtime.id, 'workflow.automation.interrupted', {
      automationId: runtime.workflowState.automation.id,
      cycle: runtime.workflowState.automation.cycle,
      status: runtime.workflowState.automation.status,
    });
    return publicWorkflowSnapshot(runtime);
  }

  async run(runtime, options = {}) {
    if (runtime.automationInterrupted) {
      throw new Error(`Workflow ${runtime.id} has an interrupted run. Use /workflow resume or /workflow discard first.`);
    }
    const session = await this.#resolveSession(runtime, options);
    runtime.automationInterrupted = false;
    return await this.controller.start(runtime, {
      ...options,
      sessionId: session.id,
      sessionPolicy: session.policy,
    });
  }

  async stop(runtime, reason = 'stopped by user') {
    runtime.automationInterrupted = false;
    return await this.controller.stop(runtime, reason);
  }

  async resume(runtime) {
    if (!runtime.automationInterrupted) throw new Error(`Workflow ${runtime.id} has no interrupted run to resume`);
    runtime.automationInterrupted = false;
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    return await this.controller.restore(runtime);
  }

  async discard(runtime, reason = 'discarded by user') {
    if (!runtime.automationInterrupted && !isWorkflowAutomationActive(runtime.workflowState)) {
      throw new Error(`Workflow ${runtime.id} has no active or interrupted run to discard`);
    }
    runtime.automationInterrupted = false;
    const result = await this.controller.stop(runtime, reason);
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    return result;
  }

  async restart(runtime, options = {}) {
    if (runtime.automationInterrupted || isWorkflowAutomationActive(runtime.workflowState)) {
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
