export async function closeWorkflowManager({ unsubscribe, refreshScheduler, automationController, projectQueues, transitionQueues, timeoutMs = 30_000, cancelActiveTurns = true } = {}) {
  unsubscribe?.();
  refreshScheduler.close();
  await automationController.close({ timeoutMs, cancelActiveTurns }).catch(() => null);
  const pending = Array.from(new Set([...projectQueues.values(), ...transitionQueues.values()]));
  if (!pending.length) return { drained: true, pending: 0 };
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ drained: false, pending: pending.length }), Math.max(0, Number(timeoutMs) || 0));
    timer.unref?.();
  });
  const drained = Promise.allSettled(pending).then(() => ({ drained: true, pending: 0 }));
  const result = await Promise.race([drained, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
