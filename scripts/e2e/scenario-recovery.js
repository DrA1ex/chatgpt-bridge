export function turnFailureDetail(snapshot = {}, label = 'Turn') {
  const status = String(snapshot?.turn?.status || 'unknown');
  const error = snapshot?.turn?.error || {};
  const code = String(error.code || '').trim();
  const message = String(error.message || '').trim();
  const suffix = [code, message].filter(Boolean).join(': ');
  return `${label}: ${status}${suffix ? ` (${suffix})` : ''}`;
}

export async function recoverBrowserAfterScenarioFailure({
  options,
  sourceClientId,
  scenarioId,
  api,
  waitUntil,
  testLog,
} = {}) {
  if (!sourceClientId) return { recovered: false, reason: 'no-client' };
  const snapshot = await api(options, '/browser/clients');
  const client = snapshot.clients?.find((item) => item.id === sourceClientId);
  if (!client) return { recovered: false, reason: 'client-missing' };
  const generation = String(client.tabObservation?.generation || '').toLowerCase();
  const busy = Boolean(client.activeRequest) || ['active', 'starting', 'streaming'].includes(generation);
  if (!busy) return { recovered: false, reason: 'already-idle' };

  testLog('warn', scenarioId, 'Scenario left the ChatGPT tab busy; reloading it before the next scenario', {
    activeRequest: client.activeRequest?.requestId || '',
    generation: generation || '(unknown)',
  });
  await api(options, '/browser/tabs/reload', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      sourceClientId,
      reason: `recover after failed E2E scenario ${scenarioId}`,
      timeoutMs: 10_000,
    },
  });
  const ready = await waitUntil(async () => {
    const current = await api(options, '/browser/clients');
    const candidate = current.clients?.find((item) => item.id === sourceClientId);
    if (!candidate?.pageReady || !candidate?.composerReady) return null;
    const currentGeneration = String(candidate.tabObservation?.generation || '').toLowerCase();
    if (candidate.activeRequest || ['active', 'starting', 'streaming'].includes(currentGeneration)) return null;
    return candidate;
  }, {
    timeoutMs: Math.max(15_000, Number(options.tabReadyTimeoutMs) || 60_000),
    intervalMs: 300,
    message: `browser recovery after ${scenarioId}`,
  });
  testLog('ok', scenarioId, 'ChatGPT tab recovered before the next scenario', { url: ready.url || '' });
  return { recovered: true, reason: 'tab-reloaded', url: ready.url || '' };
}
