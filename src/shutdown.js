function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeHttpServer(server, { timeoutMs = 1_500, log = () => {} } = {}) {
  if (!server?.close) return { closed: true, forced: false };
  let settled = false;
  const closing = new Promise((resolve) => {
    try {
      server.close(() => {
        settled = true;
        resolve({ closed: true, forced: false });
      });
      server.closeIdleConnections?.();
    } catch (error) {
      settled = true;
      resolve({ closed: false, forced: false, error });
    }
  });
  const deadline = sleep(timeoutMs).then(() => {
    if (settled) return null;
    log(`HTTP shutdown exceeded ${timeoutMs}ms; closing remaining connections.`);
    server.closeAllConnections?.();
    return { closed: true, forced: true };
  });
  return await Promise.race([closing, deadline]);
}

export async function shutdownBridgeResources({
  workflowManager,
  bridge,
  hub,
  codexRpcServer,
  server,
  preserveActiveWork = false,
  log = () => {},
  workflowTimeoutMs = 3_000,
  serverTimeoutMs = 1_500,
} = {}) {
  const workflowTimeout = preserveActiveWork ? 0 : Math.max(0, Number(workflowTimeoutMs) || 0);
  log(preserveActiveWork
    ? 'Detaching from active workflow work and closing local services.'
    : 'Stopping active work and closing local services.');
  const workflowResult = await workflowManager?.close?.({
    timeoutMs: workflowTimeout,
    cancelActiveTurns: !preserveActiveWork,
  }).catch((error) => ({ drained: false, error }));
  if (workflowResult && workflowResult.drained === false) {
    log(`Workflow shutdown did not drain ${workflowResult.pending || 0} queued operation(s); continuing process shutdown.`);
  }
  await bridge?.close?.({ cancelPending: !preserveActiveWork }).catch((error) => log(`Bridge close failed: ${error.message || error}`));
  hub?.close?.();
  codexRpcServer?.close?.();
  const serverResult = await closeHttpServer(server, { timeoutMs: serverTimeoutMs, log });
  return { workflow: workflowResult || null, server: serverResult || null };
}
