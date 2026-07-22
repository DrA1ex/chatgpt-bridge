export async function runQuarantineIsolationScenario(context = {}) {
  const {
    scenario,
    options,
    marker,
    sessionId,
    sessionUrl,
    testClient,
    runId,
    effortFor,
    FAST_EFFORT,
    assert,
    api,
    waitUntil,
    normalizeAnswer,
    sendSynchronousMessage,
  } = context;

  await scenario('quarantine-isolation', async () => {
    const scope = 'quarantine-isolation';
    const launchToken = `bridge-real-e2e-safe-${runId}`;
    const expected = `QUARANTINE_SAFE_TAB_${marker}`;
    let safeClient = null;
    let quarantineApplied = false;
    try {
      const opened = await api(options, '/browser/tabs/open', {
        method: 'POST',
        timeoutMs: 55_000,
        body: {
          url: sessionUrl,
          active: false,
          launchToken,
          bridgeServerUrl: options.baseUrl,
          select: false,
          timeoutMs: 45_000,
          bootstrapWaitMs: options.bootstrapWaitMs,
          allowSystemFallback: options.autoOpenBrowser,
        },
      });
      assert(opened.client?.id, 'Quarantine isolation could not open a second owned ChatGPT tab');
      safeClient = await waitUntil(async () => {
        const snapshot = await api(options, '/browser/clients');
        const candidate = snapshot.clients?.find((client) => client.launchToken === launchToken || client.id === opened.client.id);
        if (!candidate?.ready || !candidate.pageReady || !candidate.composerReady || !candidate.chatMainReady) return null;
        if (String(candidate.session?.id || '') !== sessionId) return null;
        return candidate;
      }, {
        timeoutMs: options.tabReadyTimeoutMs,
        intervalMs: 250,
        message: 'second safe ChatGPT tab on the owned conversation',
      });

      await api(options, '/diagnostics/e2e/client-quarantine', {
        method: 'POST',
        body: {
          clientId: testClient.id,
          quarantined: true,
          reason: 'real_e2e_release_uncertainty_projection',
        },
      });
      quarantineApplied = true;
      const projected = await api(options, '/browser/clients');
      const quarantinedClient = projected.clients?.find((client) => client.id === testClient.id);
      assert(quarantinedClient?.quarantined === true, 'Primary E2E tab was not projected as quarantined');
      assert(projected.clients?.find((client) => client.id === safeClient.id)?.quarantined !== true,
        'Safe E2E tab was unexpectedly quarantined');

      const response = await sendSynchronousMessage(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
        message: `This verifies quarantine isolation. Output exactly ${expected}.`,
        effort: effortFor('quarantine-isolation', FAST_EFFORT, 'safe-tab scheduling requires only an exact answer'),
      }, { scope, label: 'safe-tab request after quarantine' });
      assert(normalizeAnswer(response.answer || response.response) === expected,
        `Unexpected quarantine isolation answer: ${response.answer || response.response}`);
      assert(response.sourceClientId === safeClient.id,
        `Quarantine isolation used ${response.sourceClientId || '(unknown)'} instead of safe client ${safeClient.id}`);
      return {
        quarantinedClientId: testClient.id,
        safeClientId: safeClient.id,
        requestId: response.requestId || '',
        expected,
      };
    } finally {
      if (quarantineApplied) {
        await api(options, '/diagnostics/e2e/client-quarantine', {
          method: 'POST',
          ignoreRunAbort: true,
          body: { clientId: testClient.id, quarantined: false },
        }).catch(() => {});
      }
      if (safeClient?.id) {
        await api(options, '/browser/tabs/close', {
          method: 'POST',
          ignoreRunAbort: true,
          timeoutMs: 20_000,
          body: { sourceClientId: safeClient.id, timeoutMs: 10_000 },
        }).catch(() => {});
        await waitUntil(async () => {
          const snapshot = await api(options, '/browser/clients', { ignoreRunAbort: true, timeoutMs: 5_000 });
          return !snapshot.clients?.some((client) => client.id === safeClient.id);
        }, {
          timeoutMs: 10_000,
          intervalMs: 100,
          message: 'closed quarantine-isolation safe tab to leave the next scenario isolated',
        }).catch(() => {});
      }
      await waitUntil(async () => {
        const snapshot = await api(options, '/browser/clients', { ignoreRunAbort: true, timeoutMs: 5_000 });
        return snapshot.clients?.find((client) => client.id === testClient.id
          && client.ready
          && client.pageReady
          && client.composerReady
          && client.chatMainReady !== false) || null;
      }, {
        timeoutMs: 10_000,
        intervalMs: 100,
        message: 'primary E2E tab after quarantine isolation cleanup',
      }).catch(() => null);
      await api(options, '/browser/select', {
        method: 'POST',
        ignoreRunAbort: true,
        timeoutMs: 5_000,
        body: { clientId: testClient.id },
      }).catch(() => {});
    }
  });
}
