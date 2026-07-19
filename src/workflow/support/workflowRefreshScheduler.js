import { WorkflowLifecycle } from '../state/workflowState.js';
import { workflowSourceClientId } from './workflowBinding.js';

export class WorkflowRefreshScheduler {
  constructor({ bridge, publish, isBusy } = {}) {
    this.bridge = bridge;
    this.publish = publish;
    this.isBusy = isBusy;
    this.timers = new Map();
  }

  close() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  clear(workflowId) {
    const timer = this.timers.get(workflowId);
    if (timer) clearInterval(timer);
    this.timers.delete(workflowId);
  }

  sync(runtime) {
    this.clear(runtime.id);
    const intervalMs = Number(runtime.config.watch.refreshIntervalMs) || 0;
    if (runtime.workflowState?.lifecycle === WorkflowLifecycle.STOPPED || !runtime.workflowState?.subscription?.enabled || intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (runtime.workflowState?.lifecycle === WorkflowLifecycle.STOPPED || !runtime.workflowState?.subscription?.enabled || this.isBusy?.(runtime.id)) return;
      this.publish(runtime.id, 'workflow.watch.refresh.started', { intervalMs }).catch(() => {});
      this.bridge.reloadBrowserTab({
        sourceClientId: workflowSourceClientId(runtime),
        reason: `workflow ${runtime.id} periodic refresh`,
        timeoutMs: Math.min(10_000, Math.max(3_000, Math.floor(intervalMs / 2))),
      }).then((result) => this.publish(runtime.id, 'workflow.watch.refresh.requested', { intervalMs, result }))
        .catch((error) => this.publish(runtime.id, 'workflow.watch.refresh.failed', { intervalMs, message: error.message || String(error) }));
    }, intervalMs);
    timer.unref?.();
    this.timers.set(runtime.id, timer);
  }
}
