function automationRunActive(state, isWorkflowActive) {
  return state?.run?.kind === 'automation' && isWorkflowActive(state);
}

export function observedTurnMatches(runtime, turn, { ignoreLifecycle = false, isWorkflowActive } = {}) {
  const cfg = runtime.config;
  if (!ignoreLifecycle) {
    if (runtime.workflowState?.lifecycle === 'stopped' || !runtime.workflowState?.subscription?.enabled || cfg.watch.mode === 'off') return false;
    if (cfg.automation?.suspendWatcher && automationRunActive(runtime.workflowState, isWorkflowActive)) return false;
  } else if (cfg.watch.mode === 'off') return false;
  const effectiveClientId = cfg.watch.clientId || runtime.boundSourceClientId || '';
  const effectiveSessionId = cfg.watch.sessionId || runtime.boundSessionId || '';
  const turnClientId = String(turn.sourceClientId || '');
  const turnSessionId = String(turn.sessionId || turn.session?.id || '');
  return (!effectiveClientId || effectiveClientId === turnClientId)
    && (!effectiveSessionId || effectiveSessionId === turnSessionId);
}

export async function routeObservedTurn({
  workflows,
  turn,
  enqueue,
  processObserved,
  failRuntime,
  isWorkflowActive,
}) {
  const tasks = [];
  for (const runtime of workflows.values()) {
    if (runtime.hydrationStatus === 'hydrating'
      && observedTurnMatches(runtime, turn, { ignoreLifecycle: true, isWorkflowActive })) {
      tasks.push(new Promise((resolve, reject) => runtime.startupInbox.push({ turn: { ...turn }, resolve, reject })));
      continue;
    }
    if (!observedTurnMatches(runtime, turn, { isWorkflowActive })) continue;
    tasks.push(enqueue(runtime.id, () => processObserved(runtime, turn)).catch(async (error) => {
      await failRuntime(runtime.id, error);
      throw error;
    }));
  }
  await Promise.all(tasks);
}

export async function completeWorkflowHydration({
  runtime,
  snapshot,
  restore,
  enqueue,
  processObserved,
  syncRefresh,
  publish,
}) {
  try {
    const restored = await restore(runtime, snapshot);
    runtime.hydrationStatus = 'ready';
    const inbox = runtime.startupInbox.splice(0);
    for (const item of inbox) {
      try {
        await enqueue(runtime.id, () => processObserved(runtime, item.turn));
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
    syncRefresh(runtime);
    await publish(runtime.id, 'workflow.restored', {
      configPath: runtime.config.configPath,
      lifecycle: runtime.workflowState.lifecycle,
      phase: runtime.workflowState.run.phase,
    });
    return restored;
  } catch (error) {
    runtime.hydrationStatus = 'failed';
    for (const item of runtime.startupInbox.splice(0)) item.reject(error);
    throw error;
  }
}
