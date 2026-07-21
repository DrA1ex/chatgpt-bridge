#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const RELEASE_SCENARIOS = Object.freeze([
  'conversation',
  'response-markdown',
  'reasoning-lifecycle',
  'model-effort',
  'reasoning-steer',
  'reload-mid-request',
  'zip-artifact',
  'passive-workflow',
  'workflow-multi-bridge',
  'workflow-approval',
  'workflow-remediation',
]);

const LOCAL_GATES = Object.freeze([
  ['check', 'npm', ['run', 'check']],
  ['full-tests', 'npm', ['test']],
  ['fault-matrix', 'npm', ['run', 'test:faults']],
  ['workflow-coverage', 'npm', ['run', 'test:workflow:coverage']],
  ['captured-fixtures', 'npm', ['run', 'test:e2e:local']],
  ['workflow-multi-bridge', 'npm', ['run', 'test:workflow:multi-bridge']],
  ['parser-fixtures', 'npm', ['run', 'test:parser-fixture']],
  ['extension-deployment', process.execPath, ['scripts/verify-extension-deployment.js']],
  ['dependency-audit', 'npm', ['audit', '--omit=dev', '--audit-level=low']],
]);

function usage() {
  return `ChatGPT Bridge release verification\n\nUsage:\n  npm run verify:release:local\n  npm run verify:release:live -- [real E2E options]\n  npm run verify:release -- [real E2E options]\n\nOptions:\n  --local                Run deterministic local release gates\n  --live                 Run the authenticated browser release matrix\n  --clean-install        Run npm ci before other local gates\n  --report-dir <path>    Write release-verification.json/.md here\n  --continue-on-failure  Continue independent gates after a failure\n  --help                 Show this help\n\nUnknown options are forwarded to scripts/e2e-real.js when --live is enabled.\nLive verification requires a logged-in browser profile and extension 2.3.0.`;
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

function commandName(command) {
  if (command === process.execPath) return 'node';
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
}

function runGate(id, command, args, options) {
  const startedAt = new Date();
  console.log(`\n=== ${id} ===`);
  const result = spawnSync(commandName(command), args, {
    cwd: process.cwd(),
    env: { ...process.env, BRIDGE_DISABLE_NOTIFICATIONS: '1' },
    stdio: 'inherit',
  });
  const endedAt = new Date();
  const status = Number.isInteger(result.status) ? result.status : 1;
  const record = {
    id,
    command: [command === process.execPath ? 'node' : command, ...safeArgs(args)].join(' '),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    status,
    outcome: status === 0 ? 'passed' : 'failed',
    signal: result.signal || null,
    error: result.error?.message || null,
  };
  console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${id} (${record.durationMs}ms)`);
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
    '| Gate | Outcome | Duration | Command |',
    '| --- | --- | ---: | --- |',
  ];
  for (const gate of report.gates) {
    lines.push(`| ${gate.id} | ${gate.outcome} | ${gate.durationMs} ms | \`${gate.command.replaceAll('|', '\\|')}\` |`);
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

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const reportDir = options.reportDir || path.join(os.tmpdir(), `chatgpt-bridge-release-${stamp}`);
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
    report.gates.push(runGate('clean-install', 'npm', ['ci'], options));
  }
  if (options.local) {
    for (const [id, command, args] of LOCAL_GATES) report.gates.push(runGate(id, command, args, options));
  }
  if (options.live) {
    const scenarioArgs = RELEASE_SCENARIOS.flatMap((scenario) => ['--scenario', scenario]);
    report.gates.push(runGate('authenticated-browser-matrix', process.execPath, [
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
