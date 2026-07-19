import path from 'node:path';
import process from 'node:process';
import { config } from '../../src/config.js';
import { expandScenarioSelectors, formatScenarioList } from '../e2e-scenarios.js';

function splitOptionValues(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function appendUnique(target, values) {
  for (const value of values) if (value && !target.includes(value)) target.push(value);
}

export function parseArgs(argv) {
  const options = {
    baseUrl: '',
    port: 0,
    apiToken: config.apiToken,
    timeoutMs: 30_000,
    promptTimeoutMs: 0,
    resultIdleTimeoutMs: 300_000,
    pipelineIdleTimeoutMs: 60_000,
    workflowWaitTimeoutMs: 120_000,
    turnMaxTimeoutMs: 0,
    artifactTimeoutMs: 45_000,
    keepSession: false,
    strictReasoning: false,
    verbose: false,
    reportDir: path.join(process.cwd(), '.bridge-data', 'e2e', 'last-real-e2e'),
    autoStartServer: true,
    autoOpenBrowser: true,
    bootstrapWaitMs: 0,
    tabReadyTimeoutMs: 60_000,
    tabSettleMs: 1_500,
    models: splitOptionValues(process.env.E2E_MODELS || ''),
    efforts: splitOptionValues(process.env.E2E_EFFORTS || ''),
    scenarios: splitOptionValues(process.env.E2E_SCENARIOS || ''),
    reportDirExplicit: false,
    colorMode: 'auto',
    captureDomFixtures: false,
    fixtureOutputDir: '',
    capturePageLayout: false,
    extensionReloadPolicy: process.env.E2E_EXTENSION_RELOAD || 'ask',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || '';
    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--port') options.port = Math.max(0, Number(next()) || 0);
    else if (arg === '--api-token') options.apiToken = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(5_000, Number(next()) || options.timeoutMs);
    else if (arg === '--prompt-timeout-ms') options.promptTimeoutMs = Math.max(0, Number(next()) || 0);
    else if (arg === '--result-idle-timeout-ms') options.resultIdleTimeoutMs = Math.max(30_000, Number(next()) || options.resultIdleTimeoutMs);
    else if (arg === '--pipeline-idle-timeout-ms') options.pipelineIdleTimeoutMs = Math.max(10_000, Number(next()) || options.pipelineIdleTimeoutMs);
    else if (arg === '--workflow-wait-timeout-ms') options.workflowWaitTimeoutMs = Math.max(30_000, Number(next()) || options.workflowWaitTimeoutMs);
    else if (arg === '--turn-max-timeout-ms') options.turnMaxTimeoutMs = Math.max(0, Number(next()) || 0);
    else if (arg === '--artifact-timeout-ms') options.artifactTimeoutMs = Math.min(60_000, Math.max(10_000, Number(next()) || options.artifactTimeoutMs));
    else if (arg === '--report-dir') { options.reportDir = path.resolve(next()); options.reportDirExplicit = true; }
    else if (arg === '--report') { options.reportDir = path.dirname(path.resolve(next())); options.reportDirExplicit = true; }
    else if (arg === '--model' || arg === '--models') appendUnique(options.models, splitOptionValues(next()));
    else if (arg === '--effort' || arg === '--efforts') appendUnique(options.efforts, splitOptionValues(next()));
    else if (arg === '--scenario' || arg === '--scenarios') appendUnique(options.scenarios, splitOptionValues(next()));
    else if (arg === '--tab-ready-timeout-ms') options.tabReadyTimeoutMs = Math.max(10_000, Number(next()) || options.tabReadyTimeoutMs);
    else if (arg === '--tab-settle-ms') options.tabSettleMs = Math.max(0, Number(next()) || 0);
    else if (arg === '--keep-session' || arg === '--no-cleanup') options.keepSession = true;
    else if (arg === '--strict-reasoning') options.strictReasoning = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--capture-dom-fixtures') options.captureDomFixtures = true;
    else if (arg === '--capture-page-layout' || arg === '--capture-layout') options.capturePageLayout = true;
    else if (arg === '--fixture-output-dir') { options.fixtureOutputDir = path.resolve(next()); options.captureDomFixtures = true; }
    else if (arg === '--no-start-server') options.autoStartServer = false;
    else if (arg === '--no-open-browser') options.autoOpenBrowser = false;
    else if (arg === '--reload-extension') options.extensionReloadPolicy = 'always';
    else if (arg === '--no-reload-extension') options.extensionReloadPolicy = 'never';
    else if (arg === '--list-scenarios') options.listScenarios = true;
    else if (arg === '--color') options.colorMode = 'always';
    else if (arg === '--no-color') options.colorMode = 'never';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  options.scenarioIds = expandScenarioSelectors(options.scenarios);
  if (!options.reportDirExplicit) {
    const requestedReportKey = options.scenarios.length === 1
      ? String(options.scenarios[0] || '').trim().toLowerCase().replaceAll('_', '-')
      : '';
    const reportKey = requestedReportKey && requestedReportKey !== 'all'
      ? requestedReportKey
      : options.scenarioIds.length === 1 ? options.scenarioIds[0] : '';
    if (reportKey) options.reportDir = path.join(process.cwd(), '.bridge-data', 'e2e', reportKey);
  }
  if (options.captureDomFixtures && !options.fixtureOutputDir) options.fixtureOutputDir = path.join(options.reportDir, 'dom-fixtures');
  return options;
}

export function printHelp() {
  console.log(`Real ChatGPT browser E2E matrix

Usage:
  npm run test:e2e:real
  npm run test:e2e:real -- --scenario response-markdown
  npm run test:e2e:real -- --scenario reasoning-lifecycle
  npm run test:e2e:real -- --scenario model-effort --model "GPT-5.6 Thinking" --effort high
  npm run test:e2e:real -- --keep-session

Options:
  --scenario <id>        Run only selected scenario(s); repeat or pass comma-separated values
  --list-scenarios       Print stable scenario ids and aliases, then exit
  --keep-session          Leave the verified ChatGPT conversation and tab open
  --strict-reasoning      Fail when ChatGPT exposes no visible reasoning in either attempt
  --verbose               Print every raw browser diagnostic; full raw events are always archived
  --capture-dom-fixtures  Save sanitized assistant DOM snapshots and canonical traces for offline tests
  --capture-page-layout   Save sanitized structural page layouts at startup and scenario boundaries
  --fixture-output-dir    Override the DOM fixture output directory; also enables capture
  --report-dir <path>     Directory for JSON, Markdown, NDJSON and ZIP diagnostics
  --model <label>         Model label/id to test; repeat or pass comma-separated values
  --effort <value>        Effort to test; repeat or pass comma-separated values
  --tab-settle-ms <ms>    Extra delay after the composer becomes ready (default: 1500)
  --tab-ready-timeout-ms  Timeout waiting for a ready ChatGPT composer (default: 60000)
  --base-url <url>        Existing or auto-started bridge HTTP URL
  --port <port>           Port for an auto-started bridge; default is a free random port
  --api-token <token>     API_TOKEN for the bridge
  --timeout-ms <ms>       Timeout for short bridge HTTP control calls (default: 30000)
  --prompt-timeout-ms <ms> Optional total timeout for synchronous ChatGPT prompts; 0 disables it
  --result-idle-timeout-ms Fail before completion only after no result progress (default: 300000)
  --pipeline-idle-timeout-ms Fail post-generation processing after no progress (default: 60000)
  --workflow-wait-timeout-ms Absolute limit for each workflow wait stage (default: 120000)
  --turn-max-timeout-ms    Optional absolute turn limit; 0 disables it
  --artifact-timeout-ms   Artifact materialization timeout, 10-60s (default: 45000)
  --no-start-server       Require an already running bridge
  --no-open-browser       Disable OS browser fallback
  --reload-extension      Reload the unpacked extension at startup without prompting
  --no-reload-extension   Skip the startup extension reload prompt
  --color                 Force ANSI colors in E2E console output
  --no-color              Disable ANSI colors in E2E console output

${formatScenarioList()}`);
}

