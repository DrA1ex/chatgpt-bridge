#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const CONTRACT_TESTS = Object.freeze([
  'test/architectureHardCut.test.js',
  'test/compositionRootLimits.test.js',
  'test/noLegacyRuntime.test.js',
  'test/p0CommandContract.test.js',
  'test/backgroundFaultInjectionMatrix.test.js',
  'test/extensionBackgroundAuth.test.js',
  'test/extensionDownloadCapture.test.js',
  'test/artifactBackgroundDownload.test.js',
  'test/extensionContentBootstrap.test.js',
  'test/extensionContentStatus.test.js',
  'test/extensionContentRuntimeErrors.test.js',
  'test/requestCommandTransportRegression.test.js',
  'test/requestLifecycleCore.test.js',
  'test/requestLifecycleDeadlines.test.js',
  'test/requestStateCanonicalBridge.test.js',
  'test/requestReloadProjectionRecovery.test.js',
  'test/protocol.test.js',
  'test/protocolV5Trace.test.js',
  'test/responseParserDomFixture.test.js',
  'test/responseParserBrowserFixture.test.js',
  'test/responseParserBrowserFixtureContract.test.js',
  'test/capturedDomFixtures.test.js',
  'test/mockChatGptLayout.test.js',
  'test/mockChatGptContract.test.js',
  'test/mockChatGptCommandResults.test.js',
  'test/mockChatGptScenarioContracts.test.js',
  'test/e2eReasoningObservationFallback.test.js',
  'test/remoteBrowserBridgeInitialCursor.test.js',
  'test/reasoningSupport.test.js',
  'test/e2eCoreScenarioContext.test.js',
  'test/realE2eScenarios.test.js',
  'test/e2eScenarioTimeouts.test.js',
  'test/e2eWorkflowSupport.test.js',
  'test/e2eArtifactSelection.test.js',
  'test/e2eScenarioInfrastructure.test.js',
  'test/e2eLauncherWiring.test.js',
  'test/e2eRequestStateWait.test.js',
  'test/e2eWorkflowWaitTimeout.test.js',
  'test/e2eScenarioRunner.test.js',
  'test/e2eScenarioRecovery.test.js',
  'test/e2eErrorSummary.test.js',
  'test/e2eConsole.test.js',
  'test/e2eInterruption.test.js',
  'test/e2eDomFixtureCapture.test.js',
  'test/pageLayoutCapture.test.js',
  'test/tabObservationCore.test.js',
  'test/requestMachine.test.js',
  'test/browserEffectReconciliationMatrix.test.js',
  'test/workflowState.test.js',
  'test/workflowLocalEffectRecovery.test.js',
  'test/workflowLocalEffectFaultMatrix.test.js',
  'test/workflowControlFaultMatrix.test.js',
]);

function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

async function run(label, command, args, { timeoutMs = 5 * 60_000 } = {}) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, BRIDGE_DISABLE_NOTIFICATIONS: '1' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, 'SIGTERM');
    setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 2_000).unref?.();
  }, timeoutMs);
  timer.unref?.();
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code: Number.isInteger(code) ? code : 1, signal, error: null }));
  });
  clearTimeout(timer);
  if (result.code !== 0) {
    const detail = timedOut ? `timed out after ${timeoutMs}ms` : result.error?.message || `exit=${result.code} signal=${result.signal || ''}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  console.log(`PASS ${label} (${Date.now() - started}ms)`);
}

async function dependencyAvailable(name) {
  try {
    await import(name);
    return true;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return false;
    throw error;
  }
}

const requireFull = process.argv.includes('--require-full');
const contractsOnly = process.argv.includes('--contracts-only');

await run('source and architecture checks', process.execPath, ['scripts/check-js.js'], { timeoutMs: 2 * 60_000 });
await run('dependency-free local E2E contracts', process.execPath, ['--test', ...CONTRACT_TESTS], { timeoutMs: 5 * 60_000 });

let fullRan = false;
if (!contractsOnly) {
  const [expressAvailable, wsAvailable] = await Promise.all([
    dependencyAvailable('express'),
    dependencyAvailable('ws'),
  ]);
  if (expressAvailable && wsAvailable) {
    await run('full Bridge/WebSocket local E2E matrix', process.execPath, [
      'scripts/e2e-real.js',
      '--mock-chatgpt',
      '--no-reload-extension',
    ], { timeoutMs: 15 * 60_000 });
    fullRan = true;
  } else if (requireFull) {
    throw new Error('Full local E2E requires installed express and ws dependencies; run npm ci first');
  } else {
    console.log('\nSKIP full Bridge/WebSocket local E2E matrix: express/ws are not installed in this sandbox.');
    console.log('The dependency-free contract matrix passed. Run npm ci and repeat with --require-full for the transport-level matrix.');
  }
}

console.log(`\nSandbox E2E verification passed (${CONTRACT_TESTS.length} test files; full transport matrix ${fullRan ? 'passed' : 'not available'}).`);
