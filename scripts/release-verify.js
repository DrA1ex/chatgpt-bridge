#!/usr/bin/env node
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { signalProcessTree } from '../src/runtime/childProcess.js';

const RELEASE_SCENARIOS = Object.freeze([
  'conversation',
  'response-markdown',
  'reasoning-lifecycle',
  'model-effort',
  'reasoning-steer',
  'reload-mid-request',
  'quarantine-isolation',
  'zip-artifact',
  'passive-workflow',
  'workflow-multi-bridge',
  'workflow-approval',
  'workflow-remediation',
]);

const FAULT_TESTS = Object.freeze([
  'test/workflowEffectFaultInjection.test.js',
  'test/backgroundFaultInjectionMatrix.test.js',
  'test/browserEffectReconciliationMatrix.test.js',
  'test/workflowControlFaultMatrix.test.js',
  'test/requestFaultInjectionMatrix.test.js',
  'test/requestDeadlinePolicy.test.js',
  'test/workflowLocalEffectFaultMatrix.test.js',
  'test/remoteWorkflowBridge.test.js',
  'test/extensionDownloadCapture.test.js',
  'test/extensionContentRuntimeErrors.test.js',
  'test/commandReleaseAndReloadRegression.test.js',
  'test/intelligenceSurfaceSelection.test.js',
  'test/requestStateCanonicalBridge.test.js',
  'test/pageLayoutCapture.test.js',
  'test/workflowHydrationBarrier.test.js',
  'test/tabObservationCore.test.js',
  'test/extensionObservationPerformance.test.js',
  'test/tabObservationAdapter.test.js',
  'test/extensionDeployment.test.js',
  'test/extensionStartup.test.js',
  'test/e2eInterruption.test.js',
  'test/requestReloadProjectionRecovery.test.js',
  'test/requestMonitorBoundary.test.js',
  'test/e2eScenarioTimeouts.test.js',
  'test/architectureHardCut.test.js',
  'test/maintenanceOperationState.test.js',
  'test/protocolV5Trace.test.js',
  'test/workflowInputOverflow.test.js',
  'test/workflowManualLocalEffect.test.js',
  'test/requestTelemetryPersistence.test.js',
  'test/workflowNotificationSuppression.test.js',
  'test/backgroundStateCompaction.test.js',
  'test/outboxDurabilityRegression.test.js',
  'test/p0CommandContract.test.js',
  'test/e2eDownloadSourceCleanup.test.js',
  'test/mockArtifactMaterializationParity.test.js',
  'test/e2eScenarioRecovery.test.js',
  'test/extensionInteractionRegression.test.js',
  'test/chatGptTransientRetry.test.js',
  'test/mockSuccessfulRunParity.test.js',
  'test/tabClientIdentity.test.js',
  'test/mockTabIdentityParity.test.js',
  'test/workflowChatBootstrap.test.js',
  'test/extensionBackgroundAuth.test.js',
  'test/workflowWizardNewChat.test.js',
]);

const WORKFLOW_COVERAGE_ARGS = Object.freeze([
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/workflow/state/**/*.js',
  '--test-coverage-include=src/workflow/store.js',
  '--test-coverage-include=src/workflow/services/command*.js',
  '--test-coverage-include=src/workflow/recovery/workflowRecoveryCoordinator.js',
  '--test-coverage-include=src/workflow/ux/workflow{Actions,View,PendingAction}.js',
  '--test-coverage-lines=80',
  '--test-coverage-branches=60',
  '--test-coverage-functions=65',
  'test/workflow.test.js',
  'test/workflowState.test.js',
  'test/workflowStoreV3.test.js',
  'test/workflowSurface.test.js',
  'test/workflowV3Coverage.test.js',
  'test/workflowEffectFaultInjection.test.js',
  'test/workflowControlFaultMatrix.test.js',
  'test/workflowLocalEffectFaultMatrix.test.js',
  'test/workflowHydrationBarrier.test.js',
]);

const CAPTURED_FIXTURE_TESTS = Object.freeze([
  'test/capturedDomFixtures.test.js',
  'test/responseParserBrowserFixtureContract.test.js',
  'test/mockChatGptLayout.test.js',
  'test/mockChatGptContract.test.js',
  'test/mockChatGptCommandResults.test.js',
  'test/mockChatGptScenarioContracts.test.js',
  'test/intelligenceSelection.test.js',
  'test/mockExactOutput.test.js',
  'test/e2eRuntimeIsolation.test.js',
  'test/backgroundStateCompaction.test.js',
  'test/outboxDurabilityRegression.test.js',
  'test/extensionMaintenanceReloadPage.test.js',
  'test/extensionReloadTrampoline.test.js',
  'test/extensionStartup.test.js',
  'test/browserClientSelection.test.js',
  'test/maintenanceOperationState.test.js',
  'test/externalBrowserSafety.test.js',
  'test/commandReleaseAndReloadRegression.test.js',
  'test/browserExtensionHubOwnership.test.js',
  'test/bridgeClientLiveSnapshot.test.js',
  'test/steerReadiness.test.js',
  'test/extensionInteractionRegression.test.js',
  'test/p0CommandContract.test.js',
  'test/artifactDomParserCore.test.js',
  'test/artifactBackgroundDownload.test.js',
  'test/e2eWorkflowSupport.test.js',
  'test/mockRealObservationParity.test.js',
  'test/e2eDownloadSourceCleanup.test.js',
  'test/browserDownloadCleanupSafety.test.js',
  'test/mockArtifactMaterializationParity.test.js',
  'test/e2eScenarioRecovery.test.js',
  'test/chatGptTransientUserTurnError.test.js',
  'test/mockTransientRequestErrorParity.test.js',
  'test/mockSuccessfulRunParity.test.js',
  'test/tabClientIdentity.test.js',
  'test/mockTabIdentityParity.test.js',
  'test/workflowChatBootstrap.test.js',
  'test/extensionBackgroundAuth.test.js',
  'test/workflowWizardNewChat.test.js',
]);

const PARSER_FIXTURE_TESTS = Object.freeze([
  'test/responseParserDomFixture.test.js',
  'test/responseParserBrowserFixtureContract.test.js',
  'test/responseParserBrowserFixture.test.js',
]);

const LOCAL_GATES = Object.freeze([
  ['check', 'npm', ['run', 'check']],
  ['full-tests', 'npm', ['test']],
  ['fault-matrix', process.execPath, ['--test', ...FAULT_TESTS]],
  ['workflow-coverage', process.execPath, [...WORKFLOW_COVERAGE_ARGS]],
  ['captured-fixtures', process.execPath, ['--test', ...CAPTURED_FIXTURE_TESTS]],
  ['local-chatgpt-e2e', process.execPath, ['scripts/e2e-real.js', '--mock-chatgpt', '--no-reload-extension']],
  ['workflow-multi-bridge', process.execPath, ['--test', 'test/workflowMultiBridge.integration.test.js']],
  ['parser-fixtures', process.execPath, ['--test', ...PARSER_FIXTURE_TESTS]],
  ['extension-deployment', process.execPath, ['scripts/verify-extension-deployment.js']],
  ['dependency-audit', 'npm', ['audit', '--omit=dev', '--audit-level=low']],
]);

function usage() {
  return `ChatGPT Bridge release verification\n\nUsage:\n  npm run verify\n  npm run verify -- --live [real E2E options]\n  npm run verify -- --local --live --clean-install [real E2E options]\n\nOptions:\n  --local                Run deterministic local release gates (default)\n  --live                 Run the authenticated browser release matrix\n  --clean-install        Run npm ci before other local gates\n  --report-dir <path>    Write release-verification.json/.md here\n  --continue-on-failure  Continue independent gates after a failure\n  --help                 Show this help\n\nUnknown options are forwarded to scripts/e2e-real.js when --live is enabled.\nLive verification requires a logged-in browser profile and a compatible extension.`;
}

function parseArgs(argv) {
  const options = {
    local: false,
    live: false,
    cleanInstall: false,
    continueOnFailure: false,
    reportDir: '',
    e2eArgs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { ...options, help: true };
    if (arg === '--local') options.local = true;
    else if (arg === '--live') options.live = true;
    else if (arg === '--clean-install') options.cleanInstall = true;
    else if (arg === '--continue-on-failure') options.continueOnFailure = true;
    else if (arg === '--report-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('Missing value for --report-dir');
      options.reportDir = path.resolve(value);
      index += 1;
    } else options.e2eArgs.push(arg);
  }
  if (!options.local && !options.live) options.local = true;
  return options;
}

function safeArgs(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--api-token') {
      output.push(arg, '<redacted>');
      index += 1;
    } else if (arg.startsWith('--api-token=')) output.push('--api-token=<redacted>');
    else output.push(arg);
  }
  return output;
}

export function gateInvocation(command, args, platform = process.platform) {
  if (platform === 'win32' && command === 'npm') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] };
  }
  return { command, args };
}

export async function runGate(id, command, args, options) {
  const startedAt = new Date();
  const logPath = path.join(options.reportDir, `${id}.log`);
  const timeoutMs = options.timeoutMs ?? Math.max(30_000, Number(process.env.BRIDGE_RELEASE_GATE_TIMEOUT_MS) || 15 * 60_000);
  console.log(`\n=== ${id} ===`);
  const logFd = fsSync.openSync(logPath, 'w');
  let status = 1;
  let signal = null;
  let errorMessage = null;
  let timedOut = false;
  try {
    const result = await new Promise((resolve) => {
      const invocation = gateInvocation(command, args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: process.cwd(),
        env: { ...process.env, BRIDGE_DISABLE_NOTIFICATIONS: '1' },
        stdio: ['ignore', logFd, logFd],
        detached: process.platform !== 'win32',
      });
      let settled = false;
      let forceTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        signalProcessTree(child, 'SIGTERM');
        forceTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), options.killGraceMs ?? 5_000);
        forceTimer.unref?.();
      }, timeoutMs);
      timeout.unref?.();
      child.once('error', (error) => finish({ status: 1, signal: null, error }));
      child.once('close', (code, exitSignal) => {
        // Log descriptors do not keep close pending for surviving descendants.
        if (timedOut) signalProcessTree(child, 'SIGKILL');
        finish({
          status: timedOut ? 1 : (Number.isInteger(code) ? code : 1),
          signal: exitSignal || null,
          error: timedOut ? new Error(`Gate exceeded ${timeoutMs}ms`) : null,
        });
      });
    });
    status = result.status;
    signal = result.signal;
    errorMessage = result.error?.message || null;
  } finally {
    fsSync.closeSync(logFd);
  }
  const endedAt = new Date();
  const record = {
    id,
    command: [command === process.execPath ? 'node' : command, ...safeArgs(args)].join(' '),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    status,
    outcome: status === 0 ? 'passed' : 'failed',
    signal,
    error: errorMessage,
    timedOut,
    log: path.basename(logPath),
  };
  console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${id} (${record.durationMs}ms; log: ${record.log})`);
  if (status !== 0) {
    const lines = fsSync.readFileSync(logPath, 'utf8').trimEnd().split('\n');
    console.error(lines.slice(-80).join('\n'));
  }
  if (status !== 0 && !options.continueOnFailure) throw Object.assign(new Error(`Release gate failed: ${id}`), { record });
  return record;
}

function markdownReport(report) {
  const lines = [
    '# ChatGPT Bridge Release Verification',
    '',
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Outcome: **${report.outcome}**`,
    `- Node: ${report.environment.node}`,
    `- Platform: ${report.environment.platform}`,
    '',
    '| Gate | Outcome | Duration | Log | Command |',
    '| --- | --- | ---: | --- | --- |',
  ];
  for (const gate of report.gates) {
    lines.push(`| ${gate.id} | ${gate.outcome} | ${gate.durationMs} ms | \`${gate.log || ''}\` | \`${gate.command.replaceAll('|', '\\|')}\` |`);
  }
  if (report.error) lines.push('', `Failure: ${report.error}`);
  lines.push('');
  return lines.join('\n');
}

async function writeReport(report, reportDir) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'release-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(reportDir, 'release-verification.md'), markdownReport(report));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const reportDir = options.reportDir || path.join(os.tmpdir(), `chatgpt-bridge-release-${stamp}`);
  await fs.mkdir(reportDir, { recursive: true });
  options.reportDir = reportDir;
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: 'running',
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      chromiumBin: process.env.CHROMIUM_BIN || null,
    },
    modes: { local: options.local, live: options.live, cleanInstall: options.cleanInstall },
    liveScenarios: options.live ? [...RELEASE_SCENARIOS] : [],
    gates: [],
    error: null,
  };

  try {
    if (options.local && options.cleanInstall) {
      report.gates.push(await runGate('clean-install', 'npm', ['ci'], options));
    }
    if (options.local) {
      for (const [id, command, args] of LOCAL_GATES) report.gates.push(await runGate(id, command, args, options));
    }
    if (options.live) {
      const scenarioArgs = RELEASE_SCENARIOS.flatMap((scenario) => ['--scenario', scenario]);
      report.gates.push(await runGate('authenticated-browser-matrix', process.execPath, [
        'scripts/e2e-real.js',
        ...scenarioArgs,
        '--report-dir', path.join(reportDir, 'authenticated-e2e'),
        ...options.e2eArgs,
      ], options));
    }
    report.outcome = report.gates.every((gate) => gate.outcome === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    if (error.record) report.gates.push(error.record);
    report.outcome = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeReport(report, reportDir);
    console.log(`\nRelease report: ${reportDir}`);
  }

  process.exitCode = report.outcome === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
