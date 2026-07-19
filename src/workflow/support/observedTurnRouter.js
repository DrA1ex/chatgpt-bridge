import { createHash } from 'node:crypto';
import { workflowBinding } from './workflowBinding.js';

function automationRunActive(state, isWorkflowActive) {
  return state?.run?.kind === 'automation' && isWorkflowActive(state);
}

export const canonicalWorkflowBinding = workflowBinding;

export function observedTurnMatches(runtime, turn, { ignoreLifecycle = false, isWorkflowActive } = {}) {
  const cfg = runtime.config;
  if (!ignoreLifecycle) {
    if (runtime.workflowState?.lifecycle === 'stopped' || !runtime.workflowState?.subscription?.enabled || cfg.watch.mode === 'off') return false;
    if (cfg.automation?.suspendWatcher && automationRunActive(runtime.workflowState, isWorkflowActive)) return false;
  } else if (cfg.watch.mode === 'off') return false;
  const binding = workflowBinding(runtime);
  const turnClientId = String(turn.sourceClientId || '');
  const turnSessionId = String(turn.sessionId || turn.session?.id || '');
  return (!binding.clientId || binding.clientId === turnClientId)
    && (!binding.sessionId || binding.sessionId === turnSessionId);
}

function startupInputId(runtime, turn = {}) {
  const direct = String(turn.inputId || turn.eventId || '');
  if (direct) return direct;
  const streamEpoch = String(turn.streamEpoch || turn.observation?.streamEpoch || '');
  const sequence = Math.max(0, Number(turn.sequence ?? turn.observation?.sequence) || 0);
  if (streamEpoch && sequence) return `${streamEpoch}:${sequence}`;
  const semantic = JSON.stringify({
    workflowId: runtime.id,
    bindingEpoch: workflowBinding(runtime).epoch,
    sourceClientId: String(turn.sourceClientId || ''),
    sessionId: String(turn.sessionId || turn.session?.id || ''),
    turnKey: String(turn.turnKey || ''),
    requestId: String(turn.requestId || turn.sourceRequestId || ''),
    answer: String(turn.answer || ''),
    artifacts: (turn.artifacts || []).map((item) => String(item?.id || item?.name || '')),
  });
  return `startup-${createHash('sha256').update(semantic).digest('hex')}`;
}

export async function routeObservedTurn({
  workflows,
  turn,
  enqueue,
  processObserved,
  failRuntime,
  isWorkflowActive,
  store,
}) {
  const tasks = [];
  for (const runtime of workflows.values()) {
    if (runtime.hydrationStatus !== 'ready'
      && observedTurnMatches(runtime, turn, { ignoreLifecycle: true, isWorkflowActive })) {
      if (typeof store?.enqueueStartupInput !== 'function') {
        throw new Error(`Workflow ${runtime.id} cannot accept observed input before hydration without durable startup storage`);
      }
      const binding = workflowBinding(runtime);
      tasks.push(store.enqueueStartupInput(runtime.id, {
        id: startupInputId(runtime, turn),
        bindingEpoch: binding.epoch,
        acceptedAt: new Date().toISOString(),
        turn: structuredClone(turn),
      }, { limit: runtime.workflowState?.queueLimit || runtime.config.execution?.maxDeferredTurns || 100 }));
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
  store,
}) {
  try {
    const restored = await restore(runtime, snapshot);
    if (typeof store?.listStartupInputs !== 'function' || typeof store?.removeStartupInput !== 'function') {
      throw new Error(`Workflow ${runtime.id} hydration requires durable startup inbox storage`);
    }
    for (;;) {
      const inbox = await store.listStartupInputs(runtime.id);
      if (!inbox.length) break;
      for (const item of inbox) {
        const currentEpoch = workflowBinding(runtime).epoch;
        if (Number(item.bindingEpoch) !== currentEpoch) {
          await store.removeStartupInput(runtime.id, item.id);
          await publish(runtime.id, 'workflow.startup_input.discarded', {
            inputId: item.id,
            reason: 'stale_binding_epoch',
            inputBindingEpoch: Number(item.bindingEpoch) || 0,
            bindingEpoch: currentEpoch,
          });
          continue;
        }
        await enqueue(runtime.id, () => processObserved(runtime, item.turn));
        await store.removeStartupInput(runtime.id, item.id);
      }
    }
    // No await is allowed between the final empty read and this assignment.
    // An observed turn can therefore either be durably enqueued while hydrating
    // or routed through the normal ready path, but cannot fall between them.
    runtime.hydrationStatus = 'ready';
    syncRefresh(runtime);
    await publish(runtime.id, 'workflow.restored', {
      configPath: runtime.config.configPath,
      lifecycle: runtime.workflowState.lifecycle,
      phase: runtime.workflowState.run.phase,
    });
    return restored;
  } catch (error) {
    runtime.hydrationStatus = 'failed';
    throw error;
  }
}
