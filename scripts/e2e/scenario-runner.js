import {
  browserOwnershipIdentity,
  findOwnedBrowserClient,
  recoverBrowserAfterScenarioFailure,
  waitForOwnedBrowserClient,
} from './scenario-recovery.js';
import { createScenarioInfrastructureGate } from './scenario-infrastructure.js';

export function createScenarioRunner({
  options,
  report,
  scenarioFailures,
  definitionFor,
  getClient,
  getLaunchToken,
  clientSnapshot,
  api,
  waitUntil,
  testLog,
  logEvent,
  checkpoint,
  checkpointWarning,
  capturePageLayout = null,
} = {}) {
  const infrastructureGate = createScenarioInfrastructureGate();

  async function run(id, fn) {
    if (!options.scenarioIds.includes(id)) return null;
    const definition = definitionFor(id);
    if (!definition) throw new Error(`Unknown registered scenario: ${id}`);
    const entry = { id, name: definition.name, status: 'running', startedAt: new Date().toISOString() };
    report.scenarios.push(entry);
    testLog('step', id, definition.name);
    logEvent('scenario.started', { id, name: definition.name });
    const started = Date.now();
    try {
      const blocked = infrastructureGate.blockedScenario(id);
      if (blocked) {
        entry.status = 'blocked';
        entry.note = `Blocked by browser infrastructure failure in ${blocked.blockedBy}: ${blocked.reason}`;
        (report.blockedScenarios ||= []).push(blocked);
        testLog('warn', id, 'Scenario blocked because the owned browser client did not recover', blocked);
      } else {
        const client = getClient();
        if (client?.id) {
          const identity = browserOwnershipIdentity(client, getLaunchToken());
          const clients = await clientSnapshot(options);
          let current = findOwnedBrowserClient(clients.clients, identity);
          if (!current?.ready || !current.pageReady || !current.composerReady || current.chatMainReady === false) {
            current = await waitForOwnedBrowserClient({
              options,
              identity,
              api,
              waitUntil,
              message: `owned browser preflight before ${id}`,
            });
          }
          Object.assign(client, current);
        }
        await capturePageLayout?.(`${id}-before`, { scenarioId: id, phase: 'before', requestId: getClient()?.activeRequest?.requestId || '' });
        const data = await fn(entry);
        entry.status = entry.status === 'inconclusive' ? entry.status : 'passed';
        if (data !== undefined) entry.data = data;
      }
    } catch (error) {
      if (error?.code === 'E2E_INTERRUPTED') {
        entry.status = 'interrupted';
        entry.note = error.message;
        testLog('warn', id, 'Scenario interrupted; handing control to graceful runner cleanup', { signal: error.signal || '' });
        throw error;
      }
      entry.status = 'failed';
      entry.error = { message: error.message, stack: error.stack };
      scenarioFailures.push({ id, name: definition.name, error });
      testLog('fail', id, 'Scenario failed', { message: error.message });
      logEvent('scenario.failed', { id, name: definition.name, message: error.message });
      await capturePageLayout?.(`${id}-failed`, { scenarioId: id, phase: 'failed', status: 'failed', requestId: getClient()?.activeRequest?.requestId || '' });
      const client = getClient();
      if (client?.id) {
        const recovery = await recoverBrowserAfterScenarioFailure({
          options,
          sourceClientId: client.id,
          clientIdentity: browserOwnershipIdentity(client, getLaunchToken()),
          scenarioId: id,
          api,
          waitUntil,
          testLog,
        }).catch((recoveryError) => ({ recovered: false, reason: 'recovery-failed', error: recoveryError.message }));
        if (recovery.client) Object.assign(client, recovery.client);
        (report.scenarioRecoveries ||= []).push({
          scenarioId: id,
          ...recovery,
          client: recovery.client ? { id: recovery.client.id, browserTabId: recovery.client.browserTabId, url: recovery.client.url } : undefined,
        });
        const infrastructureFailure = infrastructureGate.recordRecovery(id, recovery);
        if (infrastructureFailure) report.browserInfrastructureFailure = infrastructureFailure;
      }
    } finally {
      entry.finishedAt = new Date().toISOString();
      entry.durationMs = Date.now() - started;
      logEvent('scenario.finished', { id, name: definition.name, status: entry.status, durationMs: entry.durationMs });
      if (entry.status === 'passed') {
        await capturePageLayout?.(`${id}-after`, { scenarioId: id, phase: 'after', status: entry.status, requestId: getClient()?.activeRequest?.requestId || '' });
        testLog('ok', id, 'Scenario completed', { durationMs: entry.durationMs });
      }
      else if (entry.status === 'inconclusive') testLog('warn', id, 'Scenario completed as inconclusive', { durationMs: entry.durationMs, note: entry.note || '' });
      else if (entry.status === 'blocked') testLog('warn', id, 'Scenario was not run', { durationMs: entry.durationMs, note: entry.note || '' });
      await checkpoint().catch((error) => checkpointWarning(id, error));
    }
    return entry;
  }

  return Object.freeze({ infrastructureGate, run });
}
