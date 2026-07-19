export async function stopInterruptedBridgeWork({ options, api, sleep, signalName = 'signal' } = {}) {
  if (typeof api !== 'function') throw new TypeError('Interrupted E2E cleanup requires api');
  if (typeof sleep !== 'function') throw new TypeError('Interrupted E2E cleanup requires sleep');
  const result = { browserCancelled: 0, interruptedTurns: [], errors: [] };
  const reason = `Real E2E interrupted by ${signalName}`;
  try {
    const stopped = await api(options, '/browser/stop', {
      method: 'POST', timeoutMs: 10_000, ignoreRunAbort: true, body: { reason },
    });
    result.browserCancelled = Number(stopped?.cancelled) || 0;
  } catch (error) {
    result.errors.push({ stage: 'browser.stop', message: error.message });
  }

  try {
    const running = await api(options, '/turns?status=running&limit=100', { timeoutMs: 10_000, ignoreRunAbort: true });
    for (const turn of running?.turns || []) {
      const turnId = String(turn?.id || '');
      if (!turnId) continue;
      try {
        const response = await api(options, `/turns/${encodeURIComponent(turnId)}/interrupt`, {
          method: 'POST', timeoutMs: 10_000, ignoreRunAbort: true, body: { reason },
        });
        result.interruptedTurns.push({ turnId, status: response?.turn?.status || 'interrupted' });
      } catch (error) {
        result.errors.push({ stage: 'turn.interrupt', turnId, message: error.message });
      }
    }
  } catch (error) {
    result.errors.push({ stage: 'turn.list', message: error.message });
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await api(options, '/health', { timeoutMs: 2_000, ignoreRunAbort: true });
      if (!(health.activeRequests || []).length) return { ...result, settled: true };
    } catch (error) {
      result.errors.push({ stage: 'health', message: error.message });
      break;
    }
    await sleep(100, { ignoreAbort: true });
  }
  return { ...result, settled: false };
}
