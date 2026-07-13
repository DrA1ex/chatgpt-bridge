#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { compareVersions } from '../src/extensionCompatibility.js';
import { writeZip } from '../src/zipWriter.js';
import { extractZipFile, validateZipFile } from '../src/zipUtils.js';
import { expandScenarioSelectors, formatScenarioList, scenarioDefinition } from './e2e-scenarios.js';
import { createE2eConsole } from './e2e-console.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TERMINAL_TURN_STATUSES = new Set(['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled']);
let consoleLogPath = '';
let e2eConsole = null;

function splitOptionValues(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function appendUnique(target, values) {
  for (const value of values) if (value && !target.includes(value)) target.push(value);
}

function parseArgs(argv) {
  const options = {
    baseUrl: '',
    port: 0,
    apiToken: config.apiToken,
    timeoutMs: 30_000,
    promptTimeoutMs: 0,
    resultIdleTimeoutMs: 300_000,
    pipelineIdleTimeoutMs: 60_000,
    turnMaxTimeoutMs: 0,
    artifactTimeoutMs: 45_000,
    keepSession: false,
    strictReasoning: false,
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || '';
    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--port') options.port = Math.max(0, Number(next()) || 0);
    else if (arg === '--api-token') options.apiToken = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(5_000, Number(next()) || options.timeoutMs);
    else if (arg === '--prompt-timeout-ms') options.promptTimeoutMs = Math.max(0, Number(next()) || 0);
    else if (arg === '--result-idle-timeout-ms' || arg === '--turn-idle-timeout-ms') options.resultIdleTimeoutMs = Math.max(30_000, Number(next()) || options.resultIdleTimeoutMs);
    else if (arg === '--pipeline-idle-timeout-ms') options.pipelineIdleTimeoutMs = Math.max(10_000, Number(next()) || options.pipelineIdleTimeoutMs);
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
    else if (arg === '--allow-no-reasoning') options.strictReasoning = false;
    else if (arg === '--no-start-server') options.autoStartServer = false;
    else if (arg === '--no-open-browser') options.autoOpenBrowser = false;
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
  return options;
}

function printHelp() {
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
  --allow-no-reasoning    Backward-compatible alias for the default inconclusive behavior
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
  --turn-idle-timeout-ms   Backward-compatible alias for --result-idle-timeout-ms
  --pipeline-idle-timeout-ms Fail post-generation processing after no progress (default: 60000)
  --turn-max-timeout-ms    Optional absolute turn limit; 0 disables it
  --artifact-timeout-ms   Artifact materialization timeout, 10-60s (default: 45000)
  --no-start-server       Require an already running bridge
  --no-open-browser       Disable OS browser fallback
  --color                 Force ANSI colors in E2E console output
  --no-color              Disable ANSI colors in E2E console output

${formatScenarioList()}`);
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function writeConsoleLine(line) {
  if (!consoleLogPath) return;
  try { fsSync.appendFileSync(consoleLogPath, `${line.endsWith('\n') ? line : `${line}\n`}`); } catch {}
}
function testLog(level, scope, message, fields = {}) {
  if (e2eConsole) {
    const method = String(level || 'info').toLowerCase();
    const writer = typeof e2eConsole[method] === 'function' ? e2eConsole[method] : e2eConsole.info;
    writer(scope, message, fields);
    return;
  }
  const line = `[e2e]${scope ? ` [${scope}]` : ''} ${message}`;
  console.log(line);
  writeConsoleLine(`${nowIso()} ${line}`);
}
function step(message) { testLog('step', '', message); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function normalizeAnswer(value = '') {
  return String(value || '').trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/i, '').replace(/^`|`$/g, '').trim();
}
function canonicalConversation(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const id = parsed.pathname.match(/^\/c\/([^/?#]+)\/?$/)?.[1] || '';
    if (!id || !['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname.toLowerCase())) return null;
    return { id, url: `${parsed.protocol}//${parsed.hostname.toLowerCase()}/c/${id}` };
  } catch { return null; }
}

async function api(options, pathname, request = {}) {
  const controller = new AbortController();
  const explicitTimeout = Object.prototype.hasOwnProperty.call(request, 'timeoutMs') ? Number(request.timeoutMs) : Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(explicitTimeout) ? Math.max(0, explicitTimeout) : Math.max(1_000, Number(options.timeoutMs) || 30_000);
  const timeoutError = new Error(`${request.method || 'GET'} ${pathname} timed out after ${timeoutMs}ms`);
  timeoutError.code = 'E2E_HTTP_TIMEOUT';
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(timeoutError), timeoutMs) : null;
  const headers = { ...(request.headers || {}) };
  if (options.apiToken) headers.Authorization = `Bearer ${options.apiToken}`;
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(`${options.baseUrl}${pathname}`, {
      method: request.method || 'GET', headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal, cache: 'no-store',
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try { detail = JSON.parse(text)?.detail || text; } catch {}
      const error = new Error(`${request.method || 'GET'} ${pathname} failed (${response.status}): ${detail}`);
      error.status = response.status;
      throw error;
    }
    if (request.binary) return Buffer.from(await response.arrayBuffer());
    if (/json/i.test(contentType)) return await response.json();
    return await response.text();
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : timeoutError;
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally { if (timer) clearTimeout(timer); }
}


function parseSseBlocks(buffer, onEvent) {
  let rest = buffer;
  let index = -1;
  while ((index = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) continue;
    try { onEvent(JSON.parse(data)); } catch {}
  }
  return rest;
}

function modelPickerDebugMessage(event = {}) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const name = String(data.name || event.type || '');
  const fields = { request: event.requestId || data.requestId || '' };
  const scope = 'model-picker';
  switch (name) {
    case 'intelligence.state.read.started':
      return ['search', scope, 'Reading current model and effort from ChatGPT UI', { ...fields, includeModels: data.includeModels }];
    case 'intelligence.picker.candidates':
      return ['search', scope, 'Located possible Intelligence menu triggers', { count: data.count }];
    case 'intelligence.picker.candidate.selected':
      return ['state', scope, 'Selected the highest-confidence Intelligence trigger', { candidate: data.index, score: data.score, signal: data.signal }];
    case 'intelligence.picker.activation':
      return ['action', scope, 'Activating Intelligence menu trigger once', { attempt: data.attempt, method: data.method, waitMs: data.waitMs }];
    case 'intelligence.picker.waiting':
      return ['wait', scope, 'Waiting for Intelligence menu to become visible and stable', { timeoutMs: data.timeoutMs, stableMs: data.stableMs }];
    case 'intelligence.picker.activation_timeout':
      return ['retry', scope, 'Intelligence menu did not open after the activation window', { attempt: data.attempt, method: data.method, elapsedMs: data.elapsedMs }];
    case 'intelligence.picker.opened':
      return ['ok', scope, 'Intelligence menu is open and stable', { method: data.method, elapsedMs: data.elapsedMs }];
    case 'intelligence.picker.not_found':
      return ['fail', scope, 'Could not open the Intelligence menu', { candidates: data.candidateCount }];
    case 'model.submenu.search.started':
      return ['search', scope, 'Looking for the transient model submenu', { trigger: data.trigger }];
    case 'model.submenu.hover.started':
      return ['action', scope, 'Hovering the current-model row to reveal the submenu', { trigger: data.trigger }];
    case 'model.submenu.waiting':
      return ['wait', scope, 'Waiting for the model submenu and option list to stabilize', { timeoutMs: data.timeoutMs, stableMs: data.stableMs }];
    case 'model.submenu.keyboard_retry':
      return ['retry', scope, 'Hover did not reveal the submenu; trying ArrowRight once', { elapsedMs: data.elapsedMs }];
    case 'model.submenu.opened':
      return ['ok', scope, 'Model submenu is visible and stable', { method: data.method, models: data.count }];
    case 'model.submenu.hover_timeout':
      return ['warn', scope, 'Model submenu did not appear during the hover window', { trigger: data.trigger }];
    case 'intelligence.options.wait.started':
      return ['wait', scope, `Waiting for ${data.kind || 'picker'} options to stabilize`, { timeoutMs: data.timeoutMs }];
    case 'intelligence.options.stable':
      return ['ok', scope, `${data.kind || 'Picker'} options are stable`, { count: data.count, elapsedMs: data.elapsedMs }];
    case 'intelligence.options.timeout':
      return ['warn', scope, `${data.kind || 'Picker'} options did not fully stabilize before timeout`, { count: data.count, elapsedMs: data.elapsedMs }];
    case 'model.selection.started':
    case 'effort.selection.started':
      return ['search', scope, `Finding requested ${data.kind || name.split('.')[0]} option`, { requested: data.label }];
    case 'model.selection.click':
    case 'effort.selection.click':
      return ['action', scope, `Clicking ${data.kind || name.split('.')[0]} option once`, { requested: data.label, matched: data.matchedLabel }];
    case 'model.selection.already_selected':
    case 'effort.selection.already_selected':
      return ['ok', scope, `Requested ${data.kind || name.split('.')[0]} was already selected`, { requested: data.label }];
    case 'model.selection.clicked':
    case 'effort.selection.clicked':
      return ['ok', scope, `${data.kind || name.split('.')[0]} option click completed`, { requested: data.label }];
    case 'model.apply.started':
      return ['step', scope, 'Applying requested model/effort settings', { model: data.model, effort: data.effort, request: data.requestId }];
    case 'model.apply.verification.started':
      return ['wait', scope, 'Reopening the picker once to verify the final combined state', { model: data.model, effort: data.effort }];
    case 'model.apply.verification.retry':
      return ['retry', scope, 'State verification failed; waiting before one read-only retry', { attempt: data.attempt, message: data.message }];
    case 'model.apply.done':
      return [(data.warnings || []).length ? 'warn' : 'ok', scope, 'Model/effort application finished', { modelApplied: data.modelApplied, effortApplied: data.effortApplied, warnings: (data.warnings || []).join(' | ') }];
    case 'intelligence.state.read':
      return ['state', scope, 'Current picker state read', { model: data.selectedModel, effort: data.selectedEffort, models: data.models?.length, efforts: data.efforts?.length }];
    default:
      return null;
  }
}

async function startLiveDebugTrace(options) {
  testLog('search', 'diagnostics', 'Connecting to the live browser-debug stream');
  const controller = new AbortController();
  const headers = options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {};
  const seen = new Map();
  const done = (async () => {
    try {
      const response = await fetch(`${options.baseUrl}/debug/stream`, { headers, signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      testLog('ok', 'diagnostics', 'Live browser-debug stream connected');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseBlocks(buffer, (event) => {
          const mapped = modelPickerDebugMessage(event);
          if (!mapped) return;
          const [level, scope, message, fields] = mapped;
          const fingerprint = JSON.stringify([event?.data?.name || event.type, event.requestId || '', fields]);
          const now = Date.now();
          if (seen.has(fingerprint) && now - seen.get(fingerprint) < 250) return;
          seen.set(fingerprint, now);
          testLog(level, scope, message, fields);
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) testLog('warn', 'diagnostics', 'Live debug stream stopped', { message: err.message });
    }
  })();
  return {
    stop: async () => {
      controller.abort();
      await done.catch(() => {});
    },
  };
}

async function waitUntil(check, { timeoutMs = 30_000, intervalMs = 300, message = 'condition' } = {}) {
  const started = Date.now(); let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try { const value = await check(); if (value) return value; } catch (err) { lastError = err; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function findFreeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function resolveBridgeRuntime(options, runId) {
  if (!options.baseUrl) {
    if (options.autoStartServer) {
      const port = options.port || await findFreeLoopbackPort();
      options.port = port;
      options.baseUrl = `http://127.0.0.1:${port}`;
    } else {
      options.baseUrl = config.publicBaseUrl;
    }
  }
  const parsed = new URL(options.baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Real E2E bridge must use loopback, got ${options.baseUrl}`);
  }
  options.port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  options.serverDataDir = path.join(config.dataDir, 'e2e', 'runtime', runId);
  return options;
}

async function initializeDiagnostics(options, runId) {
  await fs.rm(options.reportDir, { recursive: true, force: true });
  await fs.mkdir(options.reportDir, { recursive: true });
  consoleLogPath = path.join(options.reportDir, 'console.log');
  await fs.writeFile(consoleLogPath, `${nowIso()} [e2e] diagnostics initialized run=${runId} cwd=${process.cwd()} reportDir=${options.reportDir}\n`);
  await fs.writeFile(path.join(options.reportDir, 'RUNNING.json'), `${JSON.stringify({ runId, startedAt: nowIso(), cwd: process.cwd(), reportDir: options.reportDir, baseUrl: options.baseUrl, port: options.port }, null, 2)}\n`);
}

async function writeDiagnosticCheckpoint(reportDir, report, timeline) {
  await fs.mkdir(reportDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(reportDir, 'report.partial.json'), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(reportDir, 'timeline.partial.ndjson'), timeline.map((item) => JSON.stringify(item)).join('\n') + (timeline.length ? '\n' : '')),
  ]);
}

async function bridgeReachable(options) { try { return (await fetch(`${options.baseUrl}/setup/status`, { cache: 'no-store' })).ok; } catch { return false; } }
async function startBridgeIfNeeded(options) {
  if (await bridgeReachable(options)) return null;
  if (!options.autoStartServer) throw new Error(`Bridge is not reachable at ${options.baseUrl}`);
  step(`Starting isolated bridge at ${options.baseUrl}`);
  const parsed = new URL(options.baseUrl);
  const childEnv = {
    ...process.env,
    HOST: parsed.hostname,
    PORT: String(options.port),
    PUBLIC_BASE_URL: options.baseUrl,
    DATA_DIR: options.serverDataDir,
    ANSWER_TIMEOUT_MS: String(options.resultIdleTimeoutMs),
    REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS: String(options.resultIdleTimeoutMs),
    REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS: String(options.pipelineIdleTimeoutMs),
    REQUIRED_ARTIFACT_SETTLE_MS: String(Math.min(30_000, options.artifactTimeoutMs)),
    ARTIFACT_CHUNK_TIMEOUT_MS: String(Math.min(60_000, Math.max(30_000, options.artifactTimeoutMs))),
  };
  const child = spawn(process.execPath, ['src/index.js', '--server'], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    writeConsoleLine(`${nowIso()} [bridge:stdout] ${String(chunk).replace(/\n$/, '')}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    writeConsoleLine(`${nowIso()} [bridge:stderr] ${String(chunk).replace(/\n$/, '')}`);
  });
  try {
    await waitUntil(() => bridgeReachable(options), { timeoutMs: 20_000, message: 'bridge startup' });
    return child;
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
}
async function clientSnapshot(options) { return await api(options, '/tm/clients'); }
function usableClient(client) { return client?.ready && client.compatible !== false && client.compatibility?.compatible !== false; }
async function createIsolatedTab(options, runId) {
  const launchToken = `bridge-real-e2e-${runId}`;
  const opened = await api(options, '/browser/tabs/open', {
    method: 'POST',
    timeoutMs: 55_000,
    body: {
      url: 'https://chatgpt.com/',
      active: true,
      launchToken,
      bridgeServerUrl: options.baseUrl,
      select: true,
      timeoutMs: 45_000,
      bootstrapWaitMs: options.bootstrapWaitMs,
      allowSystemFallback: options.autoOpenBrowser,
    },
  });
  assert(opened.client?.id, 'Bridge opened a tab but did not return its source client');
  assert(opened.client.launchToken === launchToken, `Opened tab launch token mismatch: expected ${launchToken}, got ${opened.client.launchToken || '(empty)'}`);
  const readinessVersion = compareVersions(opened.client.clientVersion || '', '2.12.18');
  assert(readinessVersion !== null && readinessVersion >= 0, `Real E2E page-readiness handshake requires content runtime 2.12.18+ (extension 0.4.19+); got ${opened.client.clientVersion || 'unknown'}. Reload the unpacked extension and reload ChatGPT tabs.`);
  step(`Waiting for ChatGPT composer in ${opened.client.id}`);
  const readyClient = await waitUntil(async () => {
    const snapshot = await clientSnapshot(options);
    const client = snapshot.clients?.find((item) => item.id === opened.client.id);
    if (!client) return null;
    if (client.pageReady && client.composerReady && client.chatMainReady) return client;
    return null;
  }, { timeoutMs: options.tabReadyTimeoutMs, intervalMs: 250, message: `ChatGPT page readiness for ${opened.client.id}` });
  if (options.tabSettleMs) {
    step(`ChatGPT composer is ready; settling for ${options.tabSettleMs}ms`);
    await sleep(options.tabSettleMs);
  }
  return {
    client: readyClient,
    launchToken,
    openedBy: opened.openedBy || 'extension',
    bootstrapClientId: opened.sourceClientId || '',
    targetUrl: opened.targetUrl || opened.requestedUrl || '',
  };
}

async function createThread(options, cwd, title) {
  return (await api(options, '/threads', { method: 'POST', body: { cwd, title } })).thread;
}
async function startTurn(options, body) {
  return (await api(options, '/turns', { method: 'POST', body })).turn;
}
function turnProgressSignature(snapshot = {}, events = [], active = null) {
  const turn = snapshot.turn || {};
  const latest = events.at?.(-1) || events[events.length - 1] || {};
  return JSON.stringify({
    status: turn.status || '',
    updatedAt: turn.updatedAt || '',
    completedAt: turn.completedAt || '',
    latestEventType: latest.type || '',
    latestEventTime: latest.time || latest.createdAt || latest.at || '',
    latestEventId: latest.id || latest.sequence || '',
    activePhase: active?.phase || '',
    activeAnswerLength: Number(active?.answerLength || 0),
    activeThinkingLength: Number(active?.thinkingLength || 0),
    activeArtifactCount: Number(active?.artifactCount || 0),
    activeLastMeaningfulProgressAt: Number(active?.lastMeaningfulProgressAt || 0),
    activeGeneration: Boolean(active?.currentGenerationActive),
  });
}

function turnWaitStage(snapshot = {}, events = [], active = null) {
  const phase = String(active?.phase || '').toLowerCase();
  const types = new Set(eventTypes(events));
  const hasExplicitGenerationState = Boolean(active) && Object.prototype.hasOwnProperty.call(active, 'currentGenerationActive');
  const generationActive = hasExplicitGenerationState
    ? Boolean(active.currentGenerationActive)
    : /(?:generat|stream|reason|thinking|tool_running|assistant_progress)/.test(phase);
  if (generationActive) return { stage: 'result_active', phase, generationActive: true };

  const postGeneration = /(?:post_stop|artifact_settle|final_snapshot|result_|download_|apply_|completed|failed|cancel)/.test(phase)
    || types.has('normal.done.received')
    || types.has('request.done')
    || types.has('result/resolving')
    || types.has('artifact.download.started')
    || types.has('apply/planning');
  if (postGeneration) return { stage: 'pipeline', phase, generationActive: false };
  return { stage: 'result_waiting', phase, generationActive: false };
}

async function waitTurn(options, turnId, hooks = {}) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastSignature = '';
  let lastStage = '';
  let lastLogAt = startedAt;
  while (true) {
    const [snapshot, eventsResult, health] = await Promise.all([
      api(options, `/turns/${encodeURIComponent(turnId)}`),
      api(options, `/turns/${encodeURIComponent(turnId)}/events?limit=5000`),
      api(options, '/health'),
    ]);
    const events = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    const active = (health.activeRequests || []).find((item) => item.requestId === turnId) || null;
    const waitState = turnWaitStage(snapshot, events, active);
    if (typeof hooks.onPoll === 'function') await hooks.onPoll({ snapshot, events, active, waitState, terminal: TERMINAL_TURN_STATUSES.has(snapshot.turn.status) });
    if (TERMINAL_TURN_STATUSES.has(snapshot.turn.status)) return snapshot;
    const signature = turnProgressSignature(snapshot, events, active);
    if (signature !== lastSignature || waitState.stage !== lastStage) {
      lastSignature = signature;
      lastStage = waitState.stage;
      lastProgressAt = Date.now();
    }
    const now = Date.now();
    if (options.turnMaxTimeoutMs > 0 && now - startedAt >= options.turnMaxTimeoutMs) {
      throw new Error(`Turn ${turnId} exceeded the configured absolute limit of ${options.turnMaxTimeoutMs}ms while status=${snapshot.turn.status}`);
    }

    // A visible active generation is positive liveness evidence. It may legitimately
    // continue for tens of minutes, so only an explicit absolute limit may stop it.
    if (!waitState.generationActive) {
      const idleLimitMs = waitState.stage === 'pipeline'
        ? options.pipelineIdleTimeoutMs
        : options.resultIdleTimeoutMs;
      if (now - lastProgressAt >= idleLimitMs) {
        throw new Error(`Turn ${turnId} made no observable ${waitState.stage === 'pipeline' ? 'post-generation pipeline' : 'result'} progress for ${idleLimitMs}ms while status=${snapshot.turn.status} phase=${waitState.phase || 'unknown'}`);
      }
    }
    if (now - lastLogAt >= 30_000) {
      step(`Waiting for turn ${turnId}: status=${snapshot.turn.status} stage=${waitState.stage} phase=${waitState.phase || 'unknown'} elapsed=${now - startedAt}ms idle=${now - lastProgressAt}ms`);
      lastLogAt = now;
    }
    await sleep(750);
  }
}
async function turnEvents(options, turnId) {
  return (await api(options, `/turns/${encodeURIComponent(turnId)}/events?limit=5000`)).events || [];
}
function eventData(event = {}) { return event?.data && typeof event.data === 'object' ? event.data : event; }
function eventTypes(events = []) { return events.map((event) => String(event?.type || '')); }
function terminalTurnStatus(status = '') { return TERMINAL_TURN_STATUSES.has(String(status || '')); }

function parserObservationBlockText(block = {}, index = 0) {
  const lines = [`[${index}] ${block.type || 'unknown'}`];
  if (block.language) lines.push(`Language: ${block.language}`);
  if (block.diagnostic?.source) lines.push(`Language source: ${block.diagnostic.source}`);
  if (block.diagnostic?.confidence) lines.push(`Language confidence: ${block.diagnostic.confidence}`);
  if (block.code !== undefined) {
    lines.push('Code:');
    lines.push(String(block.code || ''));
  } else {
    lines.push('Markdown:');
    lines.push(String(block.markdown || block.text || ''));
  }
  if (Array.isArray(block.diagnostic?.unknownChildren) && block.diagnostic.unknownChildren.length) {
    lines.push('Unknown children:');
    for (const item of block.diagnostic.unknownChildren) lines.push(`- ${item.domPath || '(no path)'} :: ${item.text || ''}`);
  }
  return lines.join('\n');
}

function parserObservationSnapshotText(snapshot = {}, index = 0, metadata = {}) {
  const audit = snapshot.parserAudit || {};
  const coverage = audit.coverage || {};
  const progressItems = Array.isArray(snapshot.progressItems) ? snapshot.progressItems : [];
  const blocks = Array.isArray(snapshot.responseBlocks) ? snapshot.responseBlocks : [];
  const interfaceItems = Array.isArray(audit.interfaceItems) ? audit.interfaceItems : [];
  const artifactItems = Array.isArray(audit.artifactItems) ? audit.artifactItems : [];
  const interfaceControls = Array.isArray(audit.interfaceControls) ? audit.interfaceControls : [];
  const unknownItems = Array.isArray(audit.unknownItems) ? audit.unknownItems : [];
  const duplicateItems = Array.isArray(audit.duplicateItems) ? audit.duplicateItems : [];
  const lines = [
    '='.repeat(72),
    `${metadata.terminal ? 'FINAL TERMINAL SNAPSHOT' : `SNAPSHOT ${index}`}`,
    `Timestamp: ${metadata.at || nowIso()}`,
    `DOM phase: ${snapshot.phase || snapshot.domPhase || 'unknown'}`,
    `Turn key: ${snapshot.turnKey || ''}`,
    '='.repeat(72),
    '',
    'RAW VISIBLE ASSISTANT TURN',
    '--------------------------',
    String(snapshot.rawText || snapshot.raw || ''),
    '',
    'PARSED RESPONSE BLOCKS',
    '----------------------',
    blocks.length ? blocks.map(parserObservationBlockText).join('\n\n') : 'None',
    '',
    'REASONING / PROGRESS BLOCKS',
    '---------------------------',
    progressItems.length ? progressItems.map((item, itemIndex) => [
      `[${itemIndex}] kind=${item.kind || 'progress'} state=${item.state || ''} revision=${item.revision || 0} active=${Boolean(item.active)} visible=${Boolean(item.visible)}`,
      String(item.text || ''),
    ].join('\n')).join('\n\n') : 'None',
    '',
    'ARTIFACT CONTENT',
    '----------------',
    artifactItems.length ? artifactItems.map((item, itemIndex) => `[${itemIndex}] ${item.domPath || ''} :: ${item.text || item.ariaLabel || ''}`).join('\n') : 'None',
    '',
    'EXCLUDED INTERFACE',
    '------------------',
    (interfaceItems.length || interfaceControls.length) ? [
      ...interfaceItems.map((item, itemIndex) => `[leaf ${itemIndex}] ${item.reason || item.category || 'interface'} ${item.domPath || ''} :: ${item.text || item.ariaLabel || ''}`),
      ...interfaceControls.map((item, itemIndex) => `[control ${itemIndex}] ${item.kind || item.role || 'control'} ${item.domPath || ''} :: ${item.ariaLabel || item.title || item.text || ''}`),
    ].join('\n') : 'None',
    '',
    'UNKNOWN VISIBLE CONTENT',
    '-----------------------',
    unknownItems.length ? unknownItems.map((item, itemIndex) => `[${itemIndex}] ${item.reason || item.category || 'unknown'} ${item.domPath || ''} :: ${item.text || item.alt || item.ariaLabel || ''}`).join('\n') : 'None',
    '',
    'DUPLICATE OWNERSHIP',
    '-------------------',
    duplicateItems.length ? duplicateItems.map((item, itemIndex) => `[${itemIndex}] ${item.domPath || ''} owners=${JSON.stringify(item.ownerIndexes || [])} :: ${item.text || ''}`).join('\n') : 'None',
    '',
    'COVERAGE',
    '--------',
    `Visible text leaves: ${coverage.visibleTextLeaves ?? 0}`,
    `Content leaves: ${coverage.contentLeaves ?? 0}`,
    `Interface leaves: ${coverage.interfaceLeaves ?? 0}`,
    `Artifact leaves: ${coverage.artifactLeaves ?? 0}`,
    `Reasoning phases: ${coverage.reasoningLeaves ?? 0}`,
    `Unknown leaves: ${coverage.unknownLeaves ?? 0}`,
    `Unknown visual elements: ${coverage.unknownVisualElements ?? 0}`,
    `Duplicate leaves: ${coverage.duplicateLeaves ?? 0}`,
    `Coverage: ${coverage.coveragePercent ?? 0}%`,
    `Warnings: ${(audit.warnings || []).join(', ') || 'None'}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function createParserObservationWriter(filePath) {
  const seen = new Set();
  let snapshotIndex = 0;
  return {
    async initialize() {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `ChatGPT response parser live observation\nCreated: ${nowIso()}\n\n`);
    },
    async consume(events = []) {
      for (const event of Array.isArray(events) ? events : []) {
        if (event?.type !== 'assistant.dom.snapshot') continue;
        const data = eventData(event);
        const key = String(event.id || event.sequence || `${event.time || event.createdAt || ''}:${data.signature || ''}`);
        if (seen.has(key)) continue;
        seen.add(key);
        snapshotIndex += 1;
        await fs.appendFile(filePath, parserObservationSnapshotText(data, snapshotIndex, { at: event.time || event.createdAt || event.at || '' }));
      }
    },
    async appendTerminal(snapshot = {}, metadata = {}) {
      await fs.appendFile(filePath, parserObservationSnapshotText(snapshot, snapshotIndex + 1, { ...metadata, terminal: true }));
    },
    get snapshotCount() { return snapshotIndex; },
    filePath,
  };
}
function firstDifference(left = '', right = '') {
  const a = String(left); const b = String(right); const limit = Math.min(a.length, b.length);
  let offset = 0; while (offset < limit && a[offset] === b[offset]) offset += 1;
  if (offset === a.length && offset === b.length) return null;
  return { offset, expected: a.slice(offset, offset + 80), actual: b.slice(offset, offset + 80), expectedLength: a.length, actualLength: b.length };
}
function logicalProgressId(item = {}, index = 0) { return String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`); }
function mergeObservedProgress(items = []) {
  const order = []; const map = new Map();
  for (const item of items) {
    const id = logicalProgressId(item, order.length); const previous = map.get(id);
    if (!previous) order.push(id);
    if (!previous || Number(item?.revision || 0) >= Number(previous?.revision || 0) || (!previous?.text && item?.text)) map.set(id, { ...previous, ...item, id });
  }
  return order.map((id) => map.get(id));
}
function progressRevisionTimeline(domSnapshots = []) {
  const timeline = [];
  const lastSignatureById = new Map();
  for (const [snapshotIndex, snapshot] of (Array.isArray(domSnapshots) ? domSnapshots : []).entries()) {
    for (const [itemIndex, item] of (Array.isArray(snapshot?.progressItems) ? snapshot.progressItems : []).entries()) {
      const id = logicalProgressId(item, itemIndex);
      const entry = {
        snapshotIndex,
        id,
        kind: String(item?.kind || ''),
        revision: Number(item?.revision || 0),
        state: String(item?.state || ''),
        active: Boolean(item?.active),
        visible: Boolean(item?.visible),
        text: String(item?.text || ''),
      };
      const signature = JSON.stringify([entry.revision, entry.state, entry.active, entry.visible, entry.text]);
      if (lastSignatureById.get(id) === signature) continue;
      lastSignatureById.set(id, signature);
      timeline.push(entry);
    }
  }
  return timeline;
}

async function waitForSteerWindow(options, turnId, timeoutMs = 90_000) {
  let last = { events: [], turn: null, active: null };
  return await waitUntil(async () => {
    const [snapshot, events, health] = await Promise.all([
      api(options, `/turns/${encodeURIComponent(turnId)}`),
      turnEvents(options, turnId),
      api(options, '/health'),
    ]);
    const active = (health.activeRequests || []).find((item) => item.requestId === turnId) || null;
    last = { events, turn: snapshot.turn, active };
    if (terminalTurnStatus(snapshot.turn?.status)) return { terminal: true, ...last };
    const types = new Set(eventTypes(events));
    const promptSubmitted = types.has('prompt.sent') || types.has('user_turn.captured') || types.has('generation.started');
    const accepted = types.has('prompt.accepted') || Boolean(active?.accepted);
    const generationObserved = types.has('generation.started')
      || Boolean(active?.currentGenerationActive)
      || Boolean(active?.sawGenerating)
      || Number(active?.thinkingLength || 0) > 0
      || Number(active?.answerLength || 0) > 0;
    if (accepted && promptSubmitted && generationObserved && active && !active.done) return { terminal: false, ...last };
    return null;
  }, { timeoutMs, intervalMs: 180, message: `active steer window for ${turnId}` }).catch((err) => {
    err.steerWindow = last;
    throw err;
  });
}

function normalizeSelectionValue(value = '') {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function selectionOptionMatches(option = {}, desired = '') {
  const wanted = normalizeSelectionValue(desired);
  const candidate = normalizeSelectionValue(`${option?.value || ''} ${option?.label || ''} ${option?.rawText || ''} ${option?.id || ''}`);
  return Boolean(wanted && candidate && (candidate.includes(wanted) || wanted.includes(normalizeSelectionValue(option?.label || ''))));
}

function optionLabel(option = {}) {
  return String(option?.value || option?.label || option?.rawText || option?.id || '').trim();
}

function selectedOption(payload = {}, listKey = '') {
  return payload?.current || (Array.isArray(payload?.[listKey]) ? payload[listKey].find((option) => option?.selected) : null) || null;
}

async function readIntelligenceSnapshot(options, { scope = 'model-effort', reason = 'read current picker state' } = {}) {
  testLog('search', scope, 'Reading model and effort in one picker session', { reason });
  const response = await api(options, '/models');
  const intelligence = response?.intelligence && typeof response.intelligence === 'object' ? response.intelligence : {};
  const models = Array.isArray(response?.models) ? response.models : (Array.isArray(intelligence.models) ? intelligence.models : []);
  const efforts = Array.isArray(intelligence.efforts) ? intelligence.efforts : [];
  const currentModel = response?.current || intelligence.selectedModel || models.find((option) => option?.selected) || null;
  const currentEffort = intelligence.selectedEffort || efforts.find((option) => option?.selected) || null;
  const snapshot = {
    models,
    efforts,
    currentModel,
    currentEffort,
    intelligence,
  };
  testLog('state', scope, 'Picker state captured', {
    model: optionLabel(currentModel),
    effort: optionLabel(currentEffort),
    models: models.length,
    efforts: efforts.length,
  });
  return snapshot;
}

function intelligenceSnapshotFromApplied(applied = {}, fallback = {}) {
  const intelligence = applied?.intelligence && typeof applied.intelligence === 'object' ? applied.intelligence : {};
  const models = Array.isArray(intelligence.models) && intelligence.models.length ? intelligence.models : (fallback.models || []);
  const efforts = Array.isArray(intelligence.efforts) && intelligence.efforts.length ? intelligence.efforts : (fallback.efforts || []);
  const currentModel = intelligence.selectedModel || models.find((option) => option?.selected) || fallback.currentModel || null;
  const currentEffort = intelligence.selectedEffort || efforts.find((option) => option?.selected) || fallback.currentEffort || null;
  return { models, efforts, currentModel, currentEffort, intelligence };
}

function explicitSelectionCases(options) {
  const models = options.models.length ? options.models : [''];
  const efforts = options.efforts.length ? options.efforts : [''];
  const result = [];
  for (const model of models) for (const effort of efforts) result.push({ model, effort, mode: 'explicit' });
  if (result.length > 12) throw new Error(`Refusing to run ${result.length} model/effort combinations; limit is 12`);
  return result;
}

function alternativeSelectionOption(options = [], current = null) {
  return (Array.isArray(options) ? options : []).find((option) => {
    if (!option || option.disabled) return false;
    const label = optionLabel(option);
    return label && !selectionOptionMatches(current || {}, label);
  }) || null;
}

function scenarioDiagnosticDir(options, scenarioId) {
  const basename = path.basename(path.resolve(options.reportDir));
  return options.scenarioIds.length === 1 && basename === scenarioId
    ? options.reportDir
    : path.join(options.reportDir, scenarioId);
}

function artifactEventData(event = {}) {
  return event?.data && typeof event.data === 'object' ? event.data : {};
}

async function verifyRemovedDownloadSourcesRemainAbsent(audits = []) {
  const verified = [];
  for (const audit of Array.isArray(audits) ? audits : []) {
    if (audit?.status !== 'removed' || !audit.path) continue;
    let stillExists = false;
    try { await fs.lstat(audit.path); stillExists = true; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    audit.finalPathAbsent = !stillExists;
    verified.push({ artifactId: audit.artifactId || '', path: audit.path, absent: !stillExists, downloadId: audit.downloadId ?? null });
    assert(!stillExists, `Browser download source reappeared or was not removed by final cleanup verification: ${audit.path}`);
  }
  return verified;
}

async function auditArtifactSourceCleanup(options, artifactId) {
  const audit = await waitUntil(async () => {
    const events = (await api(options, '/events?limit=5000', { timeoutMs: Math.min(2_000, options.timeoutMs) })).events || [];
    const matching = events.filter((event) => String(artifactEventData(event).artifactId || '') === String(artifactId || ''));
    const done = [...matching].reverse().find((event) => event.type === 'artifact.download.done');
    if (!done) return null;
    const source = String(artifactEventData(done).source || '');
    if (source !== 'chrome-downloads') {
      return { artifactId, source: source || 'in-memory', cleanupRequired: false, status: 'not_applicable' };
    }
    const cleanup = [...matching].reverse().find((event) => {
      return event.type === 'artifact.download.source_removed' || event.type === 'artifact.download.source_cleanup_skipped';
    });
    if (!cleanup) return null;
    const data = artifactEventData(cleanup);
    return {
      artifactId,
      source,
      cleanupRequired: true,
      status: cleanup.type === 'artifact.download.source_removed' ? 'removed' : 'skipped',
      path: data.path || '',
      reason: data.reason || '',
      downloadId: data.downloadId ?? null,
    };
  }, { timeoutMs: 3_000, intervalMs: 100, message: `source cleanup audit for artifact ${artifactId}` });

  if (audit.status === 'removed' && audit.path) {
    let stillExists = false;
    try { await fs.lstat(audit.path); stillExists = true; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    audit.pathAbsent = !stillExists;
    assert(!stillExists, `Browser download cleanup reported success, but the captured file still exists: ${audit.path}`);
  }
  if (Array.isArray(options.downloadCleanupAudits)) options.downloadCleanupAudits.push(audit);
  assert(audit.status !== 'skipped', `Browser download cleanup was safely skipped for ${artifactId}: ${audit.reason || 'unknown safety check failure'} (${audit.path || 'path unavailable'}). The file was left untouched.`);
  return audit;
}

async function downloadArtifact(options, artifact) {
  assert(artifact?.id, 'Artifact has no id');
  const name = artifact.name || artifact.fileName || artifact.id;
  const started = Date.now();
  console.log(`[e2e] Downloading artifact ${name} (${artifact.id})`);
  const bytes = await api(options, `/artifacts/${encodeURIComponent(artifact.id)}/download`, { binary: true, timeoutMs: options.artifactTimeoutMs });
  const cleanupAudit = await auditArtifactSourceCleanup(options, artifact.id);
  console.log(`[e2e] Downloaded artifact ${name}: ${bytes.length} bytes in ${Date.now() - started}ms; source cleanup=${cleanupAudit.status}`);
  return bytes;
}
function artifactsFromResponse(response) { return Array.isArray(response?.artifacts) ? response.artifacts : []; }
function artifactsFromTurn(snapshot) {
  return (snapshot.items || []).filter((item) => item.type === 'artifact').map((item) => item.content?.artifact).filter(Boolean);
}
async function inspectZipBuffer(buffer, workDir, label) {
  const zipPath = path.join(workDir, `${label}.zip`);
  const outDir = path.join(workDir, `${label}-out`);
  await fs.writeFile(zipPath, buffer);
  const validation = await validateZipFile(zipPath);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const extracted = await extractZipFile(zipPath, outDir, { stripCommonRoot: false });
  const files = {};
  for (const item of extracted.written) files[item.path] = await fs.readFile(path.join(outDir, item.path), 'utf8');
  return { validation, extracted, files, zipPath, outDir };
}

async function deleteOwnedSessionWithRetry(options, { sessionId, sessionUrl, sourceClientId }) {
  const attempts = [];
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await waitUntil(async () => {
        const snapshot = await clientSnapshot(options);
        const client = snapshot.clients?.find((item) => item.id === sourceClientId);
        const current = canonicalConversation(client?.url || client?.session?.url || '');
        if (current?.id !== sessionId || current.url !== sessionUrl) {
          throw new Error(`Cleanup refused: expected ${sessionUrl}, current ${client?.url || '(missing)'}`);
        }
        return client.pageReady && client.chatMainReady ? client : null;
      }, { timeoutMs: 15_000, intervalMs: 250, message: `cleanup page readiness for ${sessionUrl}` });
      const deleted = await api(options, '/sessions/delete', {
        method: 'POST',
        timeoutMs: 45_000,
        body: { sessionId, expectedUrl: sessionUrl, sourceClientId, timeoutMs: 30_000 },
      });
      attempts.push({ attempt, ok: true, deletedSessionId: deleted.deletedSessionId || '' });
      return { deleted, attempts };
    } catch (err) {
      attempts.push({ attempt, ok: false, error: err.message });
      const retryable = /could not find the delete action|confirmation dialog did not appear|cleanup page readiness/i.test(err.message || '');
      if (!retryable || attempt >= maxAttempts) {
        err.cleanupAttempts = attempts;
        throw err;
      }
      const delayMs = Math.min(4_000, 500 * (2 ** (attempt - 1)));
      step(`Cleanup UI was not ready; retrying exact URL-bound deletion (${attempt}/${maxAttempts}) after ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw new Error('Session deletion retry loop exited unexpectedly');
}

async function writeDiagnostics(reportDir, report, timeline) {
  await fs.mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'report.json');
  const timelinePath = path.join(reportDir, 'timeline.ndjson');
  const summaryPath = path.join(reportDir, 'SUMMARY.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(timelinePath, timeline.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const rows = report.scenarios.map((item) => `| ${item.id || ''} | ${item.name} | ${item.status} | ${item.durationMs ?? ''} | ${String(item.error?.message || item.note || '').replaceAll('|', '\\|')} |`).join('\n');
  await fs.writeFile(summaryPath, `# Real E2E report\n\n- Run: \`${report.runId}\`\n- Status: **${report.status}**\n- Started: ${report.startedAt}\n- Finished: ${report.finishedAt || ''}\n- Session: ${report.sessionUrl || '(not created)'}\n- Selected scenarios: ${(report.selectedScenarios || []).map((id) => `\`${id}\``).join(', ')}\n\n| ID | Scenario | Status | ms | Detail |\n|---|---|---:|---:|---|\n${rows}\n\n## Cleanup\n\n\`\`\`json\n${JSON.stringify(report.cleanup, null, 2)}\n\`\`\`\n`);
  const runningPath = path.join(reportDir, 'RUNNING.json');
  await fs.rm(runningPath, { force: true }).catch(() => {});
  const bundlePath = `${reportDir}.zip`;
  const entries = [];
  const collectEntries = async (dir, prefix = '') => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectEntries(absolute, name);
      else if (entry.isFile() && !['RUNNING.json', 'report.partial.json', 'timeline.partial.ndjson'].includes(name)) entries.push({ name, path: absolute });
    }
  };
  await collectEntries(reportDir);
  await writeZip(bundlePath, entries);
  const verified = {};
  for (const filePath of [jsonPath, timelinePath, summaryPath, bundlePath]) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Diagnostics output is empty or missing: ${filePath}`);
    verified[filePath] = stat.size;
  }
  return { jsonPath, timelinePath, summaryPath, bundlePath, consoleLogPath, verified };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.listScenarios) { console.log(formatScenarioList()); return; }
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  await resolveBridgeRuntime(options, runId);
  await initializeDiagnostics(options, runId);
  const consoleStartedAt = Date.now();
  e2eConsole = createE2eConsole({
    startedAt: consoleStartedAt,
    colorMode: options.colorMode,
    appendPlainLine: (line) => writeConsoleLine(`${nowIso()} ${line}`),
  });
  testLog('info', 'runner', 'Diagnostics initialized', { run: runId, reportDir: options.reportDir });
  const marker = `BRIDGE_E2E_${runId.toUpperCase()}`;
  const report = {
    runId,
    marker,
    startedAt: nowIso(),
    cwd: process.cwd(),
    reportDir: options.reportDir,
    baseUrl: options.baseUrl,
    port: options.port,
    serverDataDir: options.serverDataDir,
    strictReasoning: options.strictReasoning,
    keepSession: options.keepSession,
    requestedModels: options.models,
    requestedEfforts: options.efforts,
    requestedScenarios: options.scenarios,
    selectedScenarios: options.scenarioIds,
    tabReadyTimeoutMs: options.tabReadyTimeoutMs,
    tabSettleMs: options.tabSettleMs,
    httpTimeoutMs: options.timeoutMs,
    promptTimeoutMs: options.promptTimeoutMs,
    resultIdleTimeoutMs: options.resultIdleTimeoutMs,
    pipelineIdleTimeoutMs: options.pipelineIdleTimeoutMs,
    turnMaxTimeoutMs: options.turnMaxTimeoutMs,
    artifactTimeoutMs: options.artifactTimeoutMs,
    status: 'running',
    scenarios: [],
    downloadCleanupAudits: [],
    cleanup: null,
  };
  options.downloadCleanupAudits = report.downloadCleanupAudits;
  const timeline = [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `bridge-real-e2e-${runId}-`));
  let ownedServer = null; let testClient = null; let launchToken = ''; let sessionId = ''; let sessionUrl = ''; let previousSelectedClientId = ''; let primaryError = null; let liveDebugTrace = null;
  const scenarioFailures = [];
  const logEvent = (type, data = {}) => timeline.push({ at: nowIso(), type, ...data });
  await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
  async function scenario(id, fn) {
    if (!options.scenarioIds.includes(id)) return null;
    const definition = scenarioDefinition(id);
    assert(definition, `Unknown registered scenario: ${id}`);
    const name = definition.name;
    const entry = { id, name, status: 'running', startedAt: nowIso() };
    report.scenarios.push(entry);
    testLog('step', id, name);
    logEvent('scenario.started', { id, name });
    const started = Date.now();
    try { const data = await fn(entry); entry.status = entry.status === 'inconclusive' ? entry.status : 'passed'; if (data !== undefined) entry.data = data; }
    catch (err) {
      entry.status = 'failed';
      entry.error = { message: err.message, stack: err.stack };
      scenarioFailures.push({ id, name, error: err });
      testLog('fail', id, 'Scenario failed', { message: err.message });
      logEvent('scenario.failed', { id, name, message: err.message });
    }
    finally {
      entry.finishedAt = nowIso();
      entry.durationMs = Date.now() - started;
      logEvent('scenario.finished', { id, name, status: entry.status, durationMs: entry.durationMs });
      if (entry.status === 'passed') testLog('ok', id, 'Scenario completed', { durationMs: entry.durationMs });
      else if (entry.status === 'inconclusive') testLog('warn', id, 'Scenario completed as inconclusive', { durationMs: entry.durationMs, note: entry.note || '' });
      await writeDiagnosticCheckpoint(options.reportDir, report, timeline).catch((err) => {
        step(`Warning: could not write diagnostic checkpoint after ${id}: ${err.message}`);
      });
    }
    return entry;
  }

  try {
    ownedServer = await startBridgeIfNeeded(options);
    liveDebugTrace = await startLiveDebugTrace(options);
    const before = await clientSnapshot(options); previousSelectedClientId = String(before.selectedClientId || '');
    const opened = await createIsolatedTab(options, runId); testClient = opened.client; launchToken = opened.launchToken;
    assert(testClient?.id, 'Isolated tab has no bridge client id');
    assert(testClient.capabilities?.sessionDeletion === true && testClient.capabilities?.browserTabs === true, 'Reload the extension packaged with this bridge');
    assert(testClient.capabilities?.promptSteering === true, 'Extension does not advertise promptSteering; reload extension 0.3.8+');
    logEvent('tab.opened', { clientId: testClient.id, openedBy: opened.openedBy, launchToken, bootstrapClientId: opened.bootstrapClientId || '', targetUrl: opened.targetUrl || '' });

    step('Bootstrapping an owned ChatGPT conversation for the selected scenarios');
    const bootstrapExpected = `BOOTSTRAP_${marker}`;
    const bootstrapPrompt = `This is setup for an isolated real integration test. Keep marker ${marker} only in this conversation. Do not add it to ChatGPT account-wide memory and do not modify saved memories. In this response, output exactly ${bootstrapExpected}.`;
    const bootstrap = await api(options, '/chat', { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { message: bootstrapPrompt, sourceClientId: testClient.id } });
    assert(normalizeAnswer(bootstrap.answer || bootstrap.response) === bootstrapExpected, `Unexpected bootstrap answer: ${bootstrap.answer || bootstrap.response}`);
    const conversation = canonicalConversation(bootstrap.session?.url || bootstrap.url || '');
    assert(conversation?.id && bootstrap.session?.id === conversation.id, 'Concrete bootstrap conversation URL/session mismatch');
    sessionId = conversation.id;
    sessionUrl = conversation.url;
    report.bootstrap = { requestId: bootstrap.requestId || '', expected: bootstrapExpected, sessionId, sessionUrl };
    logEvent('session.bootstrapped', report.bootstrap);
    await writeDiagnosticCheckpoint(options.reportDir, report, timeline);

    await scenario('conversation', async () => {
      const control = `CONVERSATION_CONTROL_${marker}`;
      const first = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { message: `This tests exact completion and conversation continuity. Output exactly ${control}.`, sourceClientId: testClient.id } });
      assert(normalizeAnswer(first.answer || first.response) === control, `Unexpected conversation answer: ${first.answer || first.response}`);
      const follow = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { message: 'Using only the immediately previous message in this conversation, output exactly its control identifier and nothing else.', sourceClientId: testClient.id } });
      assert(normalizeAnswer(follow.answer || follow.response) === control, 'Conversation continuity failed');
      return { sessionId, sessionUrl, requestIds: [first.requestId, follow.requestId], control, memoryScopeExplicit: true };
    });

    await scenario('response-markdown', async () => {
      const diagnosticDir = scenarioDiagnosticDir(options, 'response-markdown');
      const observation = createParserObservationWriter(path.join(diagnosticDir, 'parser-observation.txt'));
      const thread = await createThread(options, '', `E2E response Markdown ${runId}`);
      const jsCode = [
        `const marker = "${marker}";`,
        'const inlineLike = "`not a fence`";',
        'const fenceLike = "```still code```";',
        'const symbols = "<>&";',
        'function render(value) {',
        '  return marker + ":" + value;',
        '}',
        '',
        'console.log(render(symbols));',
      ].join('\n');
      const pythonCode = [
        `marker = "${marker}"`,
        'values = [1, 2, 3]',
        '',
        'def total(items):',
        '    return sum(items)',
        '',
        'print(f"{marker}:{total(values)}")',
      ].join('\n');
      const expectedAnswer = [
        `First paragraph ${marker} keeps inline \`const inlineValue = 42\`, embedded-backtick \`\` \`inlineLike\` \`\`, **bold text**, *italic text*, ~~removed text~~, Unicode café λ 漢字 and symbols < > &.`,
        '',
        'Second paragraph remains a separate block.',
        '',
        '````javascript',
        jsCode,
        '````',
        '',
        `Text between code blocks: ${marker}.`,
        '',
        '```python',
        pythonCode,
        '```',
        '',
        `PARSE_END_${marker}`,
      ].join('\n');
      const parserTurnId = `turn_e2e_${runId}_response_markdown`;
      const parserPrompt = [
        'Return exactly the Markdown payload below. Do not add an introduction, explanation, outer code fence, or trailing text.',
        'Preserve every paragraph break, inline-code span, code-block language, empty line, indentation, punctuation, and Unicode character.',
        'PAYLOAD START',
        expectedAnswer,
        'PAYLOAD END',
      ].join('\n\n');
      let parserSnapshot = null;
      let parserEvents = [];
      let parserAgent = null;
      let actualAnswer = '';
      let parsingDiff = null;
      let responseBlocks = [];
      let codeBlocks = [];
      let parserAudit = null;
      let parserDom = [];
      let answerSnapshots = [];
      let resultData = null;
      const validationFailures = [];
      const check = (condition, message) => { if (!condition) validationFailures.push(message); };

      try {
        await observation.initialize();
        step(`Live parser transcript: ${observation.filePath}`);
        await startTurn(options, {
          id: parserTurnId,
          threadId: thread.id,
          sessionId,
          sourceClientId: testClient.id,
          message: parserPrompt,
          metadata: { captureDomTimeline: true },
          output: { expected: 'text', required: false },
        });
        parserSnapshot = await waitTurn(options, parserTurnId, { onPoll: ({ events }) => observation.consume(events) });
        parserEvents = await turnEvents(options, parserTurnId);
        parserAgent = (parserSnapshot.items || []).find((item) => item.type === 'agent_message');
        actualAnswer = String(parserAgent?.content?.text || '').trim();
        parsingDiff = firstDifference(expectedAnswer, actualAnswer);
        responseBlocks = Array.isArray(parserAgent?.content?.blocks) ? parserAgent.content.blocks : [];
        codeBlocks = Array.isArray(parserAgent?.content?.codeBlocks) ? parserAgent.content.codeBlocks : [];
        parserAudit = parserAgent?.content?.parserAudit || null;
        parserDom = parserEvents.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
        answerSnapshots = parserDom.map((snapshot) => String(snapshot.answer || '')).filter(Boolean);

        check(parserSnapshot.turn.status === 'completed', `Response Markdown turn ended as ${parserSnapshot.turn.status}`);
        const expectedTypes = ['paragraph', 'paragraph', 'code_block', 'paragraph', 'code_block', 'paragraph'];
        check(responseBlocks.length === expectedTypes.length, `Expected ${expectedTypes.length} semantic response blocks, got ${responseBlocks.length}: ${JSON.stringify(responseBlocks.map((block) => block.type))}`);
        check(JSON.stringify(responseBlocks.map((block) => block.type)) === JSON.stringify(expectedTypes), `Response block order mismatch: ${JSON.stringify(responseBlocks.map((block) => block.type))}`);
        check(JSON.stringify(responseBlocks[0]?.inlineCode || []) === JSON.stringify(['const inlineValue = 42', '`inlineLike`']), `Inline code spans were not preserved exactly: ${JSON.stringify(responseBlocks[0])}`);
        check(codeBlocks.length === 2, `Expected 2 code blocks, got ${codeBlocks.length}`);
        check(codeBlocks[0]?.language === 'javascript', `JavaScript code block language mismatch: expected "javascript", actual ${JSON.stringify(codeBlocks[0]?.language || '')}`);
        check(codeBlocks[0]?.code === jsCode, `JavaScript code block content mismatch: ${JSON.stringify(firstDifference(jsCode, codeBlocks[0]?.code || ''))}`);
        check(codeBlocks[1]?.language === 'python', `Python code block language mismatch: expected "python", actual ${JSON.stringify(codeBlocks[1]?.language || '')}`);
        check(codeBlocks[1]?.code === pythonCode, `Python code block content mismatch: ${JSON.stringify(firstDifference(pythonCode, codeBlocks[1]?.code || ''))}`);
        check(!parsingDiff, `Final Markdown mismatch at offset ${parsingDiff?.offset}: expected ${JSON.stringify(parsingDiff?.expected)}, actual ${JSON.stringify(parsingDiff?.actual)}`);
        check(parserDom.length > 0, 'No raw DOM snapshots were recorded for the Markdown parser turn');
        check(answerSnapshots.at(-1)?.trim() === expectedAnswer, 'Last DOM answer snapshot does not equal the completed Markdown answer');
        check(Boolean(parserAudit), 'Completed agent message has no parser audit');
        const coverage = parserAudit?.coverage || {};
        check(Number(coverage.unknownLeaves || 0) === 0, `Parser audit found ${coverage.unknownLeaves || 0} unclassified visible text leaves`);
        check(Number(coverage.unknownVisualElements || 0) === 0, `Parser audit found ${coverage.unknownVisualElements || 0} unclassified visual elements`);
        check(Number(coverage.duplicateLeaves || 0) === 0, `Parser audit found ${coverage.duplicateLeaves || 0} text leaves with duplicate ownership`);
        check(Number(coverage.coveragePercent || 0) === 100, `Parser audit coverage is ${coverage.coveragePercent || 0}% instead of 100%`);
        check(!responseBlocks.some((block) => block.type === 'unknown'), `Parser returned unknown response blocks: ${JSON.stringify(responseBlocks.filter((block) => block.type === 'unknown'))}`);
        for (const [snapshotIndex, dom] of parserDom.entries()) {
          const audit = dom.parserAudit;
          if (!audit?.coverage) continue;
          check(Number(audit.coverage.duplicateLeaves || 0) === 0, `Streaming DOM snapshot ${snapshotIndex + 1} has duplicate leaf ownership`);
        }
        resultData = {
          turnId: parserTurnId,
          responseBlockTypes: responseBlocks.map((block) => block.type),
          codeBlocks: codeBlocks.map((block) => ({ language: block.language, chars: block.code?.length || 0 })),
          answerSnapshotCount: answerSnapshots.length,
          parserCoverage: parserAudit?.coverage || null,
          unknownItems: parserAudit?.unknownItems || [],
          observationFile: observation.filePath,
          validationFailures,
        };
        if (validationFailures.length) {
          const error = new Error(`Response Markdown validation found ${validationFailures.length} issue(s): ${validationFailures.join(' | ')}`);
          error.name = 'ResponseMarkdownValidationError';
          error.validationFailures = validationFailures;
          throw error;
        }
      } finally {
        if (!parserSnapshot) parserSnapshot = await api(options, `/turns/${encodeURIComponent(parserTurnId)}`).catch(() => null);
        if (!parserEvents.length) parserEvents = await turnEvents(options, parserTurnId).catch(() => []);
        if (!parserAgent) parserAgent = (parserSnapshot?.items || []).find((item) => item.type === 'agent_message') || null;
        if (!actualAnswer) actualAnswer = String(parserAgent?.content?.text || '').trim();
        if (!responseBlocks.length) responseBlocks = Array.isArray(parserAgent?.content?.blocks) ? parserAgent.content.blocks : [];
        if (!codeBlocks.length) codeBlocks = Array.isArray(parserAgent?.content?.codeBlocks) ? parserAgent.content.codeBlocks : [];
        if (!parserAudit) parserAudit = parserAgent?.content?.parserAudit || null;
        if (!parserDom.length) parserDom = parserEvents.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
        if (!answerSnapshots.length) answerSnapshots = parserDom.map((snapshot) => String(snapshot.answer || '')).filter(Boolean);
        parsingDiff = firstDifference(expectedAnswer, actualAnswer);
        const diagnosticSnapshot = [...parserDom].reverse().find((snapshot) => Array.isArray(snapshot?.codeBlockDiagnostics) && snapshot.codeBlockDiagnostics.length) || parserDom.at(-1) || null;
        const storedCodeBlockDiagnostics = Array.isArray(parserAgent?.content?.codeBlockDiagnostics) ? parserAgent.content.codeBlockDiagnostics : [];
        const codeBlockDomDiagnostics = storedCodeBlockDiagnostics.length ? storedCodeBlockDiagnostics : (diagnosticSnapshot?.codeBlockDiagnostics || []);
        const terminalAudit = parserAudit || diagnosticSnapshot?.parserAudit || null;
        const terminalObservation = {
          ...(diagnosticSnapshot || {}),
          answer: actualAnswer,
          responseBlocks,
          codeBlocks,
          parserAudit: terminalAudit,
          progressItems: diagnosticSnapshot?.progressItems || [],
          rawText: diagnosticSnapshot?.rawText || diagnosticSnapshot?.raw || '',
        };
        await observation.appendTerminal(terminalObservation, { at: nowIso() }).catch((err) => step(`Warning: could not append terminal parser observation: ${err.message}`));
        await fs.mkdir(diagnosticDir, { recursive: true }).catch(() => {});
        await Promise.all([
          fs.writeFile(path.join(diagnosticDir, 'expected-answer.md'), `${expectedAnswer}\n`),
          fs.writeFile(path.join(diagnosticDir, 'final-answer.md'), `${actualAnswer}\n`),
          fs.writeFile(path.join(diagnosticDir, 'parser-audit.json'), `${JSON.stringify(terminalAudit, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'response-blocks.json'), `${JSON.stringify(responseBlocks, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'reasoning-blocks.json'), `${JSON.stringify(diagnosticSnapshot?.progressItems || [], null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'unknown-nodes.json'), `${JSON.stringify(terminalAudit?.unknownItems || [], null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'terminal-dom.html'), String(terminalAudit?.sourceHtml || codeBlockDomDiagnostics.map((item) => item.domContext || '').join('\n') || '')),
          fs.writeFile(path.join(diagnosticDir, 'response-parsing-diff.json'), `${JSON.stringify({
            diff: parsingDiff,
            expectedBlockTypes: ['paragraph', 'paragraph', 'code_block', 'paragraph', 'code_block', 'paragraph'],
            actualBlockTypes: responseBlocks.map((block) => block.type),
            expectedCodeBlocks: [{ language: 'javascript', code: jsCode }, { language: 'python', code: pythonCode }],
            actualCodeBlocks: codeBlocks,
            codeBlockDomDiagnostics,
            parserAudit: terminalAudit,
            validationFailures,
          }, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'code-block-dom-context.json'), `${JSON.stringify(codeBlockDomDiagnostics, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'raw-dom-timeline.json'), `${JSON.stringify(parserDom.map((snapshot) => ({ turnId: parserTurnId, ...snapshot })), null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'parsed-timeline.json'), `${JSON.stringify({ turnId: parserTurnId, responseBlocks, codeBlocks, codeBlockDomDiagnostics, parserAudit: terminalAudit, answerSnapshots, validationFailures }, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'stored-items.json'), `${JSON.stringify([{ turnId: parserTurnId, items: parserSnapshot?.items || [] }], null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'turn-events.json'), `${JSON.stringify([{ turnId: parserTurnId, events: parserEvents }], null, 2)}\n`),
        ]).catch((err) => step(`Warning: could not write response-markdown diagnostics: ${err.message}`));
        logEvent('response-markdown.diagnostics', { parserTurnId, responseBlocks, codeBlocks, parsingDiff, validationFailures, answerSnapshotCount: answerSnapshots.length });
      }
      return resultData;
    });

    await scenario('reasoning-lifecycle', async (entry) => {
      const diagnosticDir = scenarioDiagnosticDir(options, 'reasoning-lifecycle');
      const thread = await createThread(options, '', `E2E reasoning lifecycle ${runId}`);
      const attempts = [];
      let resultData = null;

      const genericReasoningLabel = (value = '') => /^(?:thinking|reasoning|analyzing|working|processing|\u0434\u0443\u043c(?:\u0430\u044e|\u0430\u0435\u0442|\u0430)|\u0440\u0430\u0437\u043c\u044b\u0448\u043b\u044f\u044e|\u0430\u043d\u0430\u043b\u0438\u0437\u0438\u0440\u0443\u044e|\u043e\u0431\u0440\u0430\u0431\u0430\u0442\u044b\u0432\u0430\u044e)\s*(?:\.|…)?$/iu.test(String(value || '').trim());
      const coverageFor = (record) => {
        const thinking = record.observed.filter((item) => item.kind === 'thinking');
        const substantive = thinking.filter((item) => String(item.text || '').trim().length >= 8 && !genericReasoningLabel(item.text));
        const maxRevision = Math.max(0, ...thinking.map((item) => Number(item.revision || 0)));
        const maxChars = Math.max(0, ...substantive.map((item) => String(item.text || '').length));
        const score = substantive.length * 10_000 + thinking.length * 1_000 + maxRevision * 100 + maxChars;
        const sufficient = substantive.length >= 2 || (substantive.length >= 1 && (maxRevision >= 2 || maxChars >= 40));
        return { thinking, substantive, maxRevision, maxChars, score, sufficient };
      };
      const verifyObservedItems = (attempt) => {
        const stored = (attempt.snapshot?.items || []).filter((item) => item.type === 'reasoning' || item.type === 'progress');
        const storedByLogicalId = new Map(stored.map((item) => [String(item.content?.logicalId || ''), item]));
        for (const phase of attempt.observed) {
          const id = logicalProgressId(phase);
          const storedItem = storedByLogicalId.get(id);
          assert(storedItem, `Visible ${phase.kind || 'progress'} phase ${id} was not stored for ${attempt.turnId}`);
          const expectedType = phase.kind === 'thinking' ? 'reasoning' : 'progress';
          assert(storedItem.type === expectedType, `Visible phase ${id} changed type from ${phase.kind} to ${storedItem.type}`);
          assert(storedItem.status === 'completed', `Visible phase ${id} remained ${storedItem.status}`);
          assert(String(storedItem.content?.text || '') === String(phase.text || ''), `Visible phase ${id} was truncated or changed: ${JSON.stringify(firstDifference(phase.text || '', storedItem.content?.text || ''))}`);
          assert(String(storedItem.content?.text || '').length > 0, `Visible phase ${id} was overwritten with an empty snapshot`);
          assert(Number(storedItem.content?.revision || 0) >= Number(phase.revision || 0), `Visible phase ${id} lost revisions: observed=${phase.revision || 0} stored=${storedItem.content?.revision || 0}`);
          assert(!attempt.finalText.includes(String(storedItem.content?.text || '')), `Visible phase ${id} leaked into the final answer`);
        }
        const observedOrder = attempt.observed.map((item) => logicalProgressId(item));
        const storedOrder = stored.map((item) => String(item.content?.logicalId || '')).filter((id) => observedOrder.includes(id));
        assert(JSON.stringify(storedOrder) === JSON.stringify(observedOrder), `Visible phase order changed for ${attempt.turnId}: observed=${JSON.stringify(observedOrder)} stored=${JSON.stringify(storedOrder)}`);
        const timelineById = new Map();
        for (const entry of attempt.revisionTimeline || []) {
          const entries = timelineById.get(entry.id) || [];
          const previous = entries.at(-1) || null;
          if (previous) {
            assert(entry.revision >= previous.revision, `Visible phase ${entry.id} revision decreased from ${previous.revision} to ${entry.revision}`);
            assert(!(entry.revision === previous.revision && entry.text !== previous.text), `Visible phase ${entry.id} changed text without incrementing revision ${entry.revision}`);
          }
          entries.push(entry);
          timelineById.set(entry.id, entries);
        }
        for (const phase of attempt.observed) {
          const id = logicalProgressId(phase);
          const last = (timelineById.get(id) || []).at(-1);
          assert(last, `Visible phase ${id} has no revision timeline`);
          assert(String(last.text || '') === String(phase.text || ''), `Visible phase ${id} final revision differs from the observed final phase`);
        }
        if (attempt.observed.some((item) => item.kind === 'thinking')) {
          const firstReasoningIndex = attempt.domSnapshots.findIndex((dom) => (dom.progressItems || []).some((item) => item?.kind === 'thinking' && item?.text));
          const finalIndex = attempt.domSnapshots.findIndex((dom, index) => index > firstReasoningIndex && String(dom.answer || '').trim() === attempt.finalToken);
          assert(firstReasoningIndex >= 0 && finalIndex > firstReasoningIndex, `Reasoning-to-final transition was not observed in order for ${attempt.turnId}: reasoning=${firstReasoningIndex} final=${finalIndex}`);
        }
        return stored;
      };

      try {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const turnId = `turn_e2e_${runId}_reasoning_lifecycle_${attempt}`;
          const finalToken = `REASONING_PARSE_OK_${attempt}_${marker}`;
          let snapshot = null;
          let events = [];
          let error = null;
          try {
            await startTurn(options, {
              id: turnId,
              threadId: thread.id,
              sessionId,
              sourceClientId: testClient.id,
              model: options.models[0] || '',
              effort: options.efforts[0] || 'high',
              metadata: { captureDomTimeline: true },
              message: `Work through this multi-stage verification carefully: independently derive the sum of squares from 1 through ${attempt === 1 ? 360 : 720}, verify it using a second method, compare intermediate checkpoints, and check for arithmetic mistakes. Use visibly distinct analysis phases when the interface supports them. After the work is complete, the final response must contain exactly ${finalToken} and nothing else.`,
              output: { expected: 'text', required: false },
            });
            snapshot = await waitTurn(options, turnId);
            events = await turnEvents(options, turnId);
          } catch (err) {
            error = { message: err.message, stack: err.stack };
            snapshot = snapshot || await api(options, `/turns/${encodeURIComponent(turnId)}`).catch(() => null);
            events = events.length ? events : await turnEvents(options, turnId).catch(() => []);
          }
          const agent = (snapshot?.items || []).find((item) => item.type === 'agent_message');
          const finalText = normalizeAnswer(agent?.content?.text || '');
          const domSnapshots = events.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
          const observed = mergeObservedProgress(domSnapshots.flatMap((dom) => Array.isArray(dom.progressItems) ? dom.progressItems : []));
          const revisionTimeline = progressRevisionTimeline(domSnapshots);
          const record = {
            turnId,
            finalToken,
            finalText,
            snapshot,
            events,
            domSnapshots,
            observed,
            revisionTimeline,
            items: snapshot?.items || [],
            error,
          };
          record.coverage = coverageFor(record);
          attempts.push(record);
          if (record.coverage.sufficient) break;
        }

        for (const attempt of attempts) {
          if (attempt.error) throw Object.assign(new Error(`Reasoning lifecycle request ${attempt.turnId} failed: ${attempt.error.message}`), { stack: attempt.error.stack });
          assert(attempt.snapshot?.turn?.status === 'completed', `Reasoning lifecycle turn ${attempt.turnId} ended as ${attempt.snapshot?.turn?.status || 'missing'}`);
          assert(attempt.finalText === attempt.finalToken, `Reasoning lifecycle final answer mismatch for ${attempt.turnId}: ${attempt.finalText}`);
          attempt.stored = verifyObservedItems(attempt);
        }

        const candidates = attempts.filter((attempt) => attempt.coverage.sufficient).sort((a, b) => b.coverage.score - a.coverage.score);
        const reasoningResult = candidates[0] || null;
        if (!reasoningResult) {
          entry.status = options.strictReasoning ? 'failed' : 'inconclusive';
          entry.note = 'ChatGPT exposed no substantive visible reasoning phases in either lifecycle attempt. Generic labels were still checked for loss and lifecycle correctness.';
          if (options.strictReasoning) throw new Error(entry.note);
          resultData = {
            reasoningTurnId: '',
            reasoningPhases: [],
            attempts: attempts.map((attempt) => ({
              turnId: attempt.turnId,
              observedCount: attempt.observed.length,
              thinkingCount: attempt.coverage.thinking.length,
              substantiveCount: attempt.coverage.substantive.length,
              storedCount: attempt.stored?.length || 0,
            })),
          };
          return resultData;
        }

        resultData = {
          reasoningTurnId: reasoningResult.turnId,
          reasoningPhases: reasoningResult.coverage.thinking.map((item) => ({ id: logicalProgressId(item), revision: item.revision, chars: String(item.text || '').length, generic: genericReasoningLabel(item.text) })),
          visibleAuxiliaryPhases: reasoningResult.observed.filter((item) => item.kind !== 'thinking').map((item) => ({ id: logicalProgressId(item), kind: item.kind, revision: item.revision, chars: String(item.text || '').length })),
          attempts: attempts.map((attempt) => ({
            turnId: attempt.turnId,
            observedCount: attempt.observed.length,
            thinkingCount: attempt.coverage.thinking.length,
            substantiveCount: attempt.coverage.substantive.length,
            storedCount: attempt.stored?.length || 0,
            coverageScore: attempt.coverage.score,
          })),
        };
      } finally {
        const allDomSnapshots = attempts.flatMap((attempt) => attempt.domSnapshots.map((snapshot) => ({ turnId: attempt.turnId, ...snapshot })));
        const allEvents = attempts.map((attempt) => ({ turnId: attempt.turnId, events: attempt.events }));
        const allItems = attempts.map((attempt) => ({ turnId: attempt.turnId, items: attempt.items }));
        await fs.mkdir(diagnosticDir, { recursive: true }).catch(() => {});
        await Promise.all([
          fs.writeFile(path.join(diagnosticDir, 'raw-dom-timeline.json'), `${JSON.stringify(allDomSnapshots, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'parsed-timeline.json'), `${JSON.stringify({ attempts: attempts.map((attempt) => ({ turnId: attempt.turnId, finalToken: attempt.finalToken, finalText: attempt.finalText, observed: attempt.observed, revisionTimeline: attempt.revisionTimeline || [], stored: attempt.stored || [], coverage: attempt.coverage, error: attempt.error })) }, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'stored-items.json'), `${JSON.stringify(allItems, null, 2)}\n`),
          fs.writeFile(path.join(diagnosticDir, 'turn-events.json'), `${JSON.stringify(allEvents, null, 2)}\n`),
        ]).catch((err) => step(`Warning: could not write reasoning-lifecycle diagnostics: ${err.message}`));
        logEvent('reasoning-lifecycle.diagnostics', { attempts: attempts.map((attempt) => ({ turnId: attempt.turnId, observedCount: attempt.observed.length, thinkingCount: attempt.coverage?.thinking?.length || 0, substantiveCount: attempt.coverage?.substantive?.length || 0, error: attempt.error?.message || '' })) });
      }
      return resultData;
    });

    await scenario('model-effort', async () => {
      const scope = 'model-effort';
      const initialState = await readIntelligenceSnapshot(options, { scope, reason: 'capture the original settings and available options' });
      assert(initialState.models.length > 0, 'Model picker returned no internal model list');
      assert(initialState.efforts.length > 0, 'Effort picker returned no internal effort list');
      assert(initialState.models.every((item) => item?.id && item?.value && item?.label), `Model picker returned an unnormalized option: ${JSON.stringify(initialState.models)}`);
      assert(initialState.efforts.every((item) => item?.id && item?.value && item?.label), `Effort picker returned an unnormalized option: ${JSON.stringify(initialState.efforts)}`);

      const originalModel = initialState.currentModel;
      const originalEffort = initialState.currentEffort;
      assert(optionLabel(originalModel), `Model picker did not expose a current model: ${JSON.stringify(initialState)}`);
      assert(optionLabel(originalEffort), `Effort picker did not expose a current effort: ${JSON.stringify(initialState)}`);
      testLog('ok', scope, 'Original settings captured', { model: optionLabel(originalModel), effort: optionLabel(originalEffort) });

      const thread = await createThread(options, '', `E2E model effort ${runId}`);
      const verified = [];
      let primaryError = null;
      let selectionMayHaveChanged = false;
      let restoreResult = null;
      let lastKnownState = initialState;

      const executeSelectionCase = async (selected, index, {
        beforeState = lastKnownState,
        mustChangeModel = false,
        mustChangeEffort = false,
        purpose = 'selection',
      } = {}) => {
        const beforeCurrent = { model: beforeState.currentModel, effort: beforeState.currentEffort };
        const turnId = `turn_e2e_${runId}_model_effort_${index + 1}`;
        const expected = `MODEL_EFFORT_OK_${index + 1}_${marker}`;
        testLog('step', scope, `Starting ${purpose}`, {
          turn: index + 1,
          requestedModel: selected.model || '(unchanged)',
          requestedEffort: selected.effort || '(unchanged)',
          beforeModel: optionLabel(beforeCurrent.model),
          beforeEffort: optionLabel(beforeCurrent.effort),
        });
        testLog('action', scope, 'Submitting one deterministic ChatGPT turn with the requested settings', { turnId });
        await startTurn(options, {
          id: turnId,
          threadId: thread.id,
          sessionId,
          sourceClientId: testClient.id,
          ...(selected.model ? { model: selected.model } : {}),
          ...(selected.effort ? { effort: selected.effort } : {}),
          message: `This is a short browser E2E check for model and reasoning-effort selection. Do not save anything from this request to account-wide memory. Output exactly ${expected} and nothing else.`,
          output: { expected: 'text', required: false },
        });
        testLog('wait', scope, 'Waiting for model/effort application and the deterministic answer', { turnId });
        const snapshot = await waitTurn(options, turnId);
        const events = await turnEvents(options, turnId);
        const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
        assert(snapshot.turn.status === 'completed', `Model/effort ${purpose} case ${index + 1} ended as ${snapshot.turn.status}`);
        assert(normalizeAnswer(agent?.content?.text || '') === expected, `Model/effort ${purpose} case ${index + 1} answer mismatch: ${agent?.content?.text || ''}`);
        testLog('ok', scope, 'Deterministic answer received', { turnId, answer: expected });

        const startedEvent = events.find((event) => event.type === 'model.apply.started');
        const applyEvent = events.find((event) => event.type === 'model.apply.done');
        const applied = eventData(applyEvent || {});
        assert(startedEvent, `Model/effort application did not start for ${purpose} case ${index + 1}`);
        assert(applyEvent, `Model/effort application did not finish for ${purpose} case ${index + 1}`);
        if (selected.model) assert(applied.modelApplied === true, `Model was not confirmed for ${purpose} case ${index + 1}: ${selected.model}; warnings=${JSON.stringify(applied.warnings || [])}`);
        if (selected.effort) assert(applied.effortApplied === true, `Effort was not confirmed for ${purpose} case ${index + 1}: ${selected.effort}; warnings=${JSON.stringify(applied.warnings || [])}`);

        const afterState = intelligenceSnapshotFromApplied(applied, beforeState);
        assert(applied.intelligence, `Model/effort ${purpose} did not return the internally verified picker state`);
        testLog('state', scope, 'Using the picker state already verified by the extension', {
          model: optionLabel(afterState.currentModel),
          effort: optionLabel(afterState.currentEffort),
        });
        const afterCurrent = { model: afterState.currentModel, effort: afterState.currentEffort };
        if (selected.model) assert(selectionOptionMatches(afterCurrent.model, selected.model), `Model picker no longer reports ${selected.model} as selected after ${purpose} case ${index + 1}: ${JSON.stringify(afterCurrent.model)}`);
        if (selected.effort) assert(selectionOptionMatches(afterCurrent.effort, selected.effort), `Effort picker no longer reports ${selected.effort} as selected after ${purpose} case ${index + 1}: ${JSON.stringify(afterCurrent.effort)}`);
        if (mustChangeModel) assert(!selectionOptionMatches(beforeCurrent.model, optionLabel(afterCurrent.model)), `Model did not actually change during ${purpose}: before=${JSON.stringify(beforeCurrent.model)} after=${JSON.stringify(afterCurrent.model)}`);
        if (mustChangeEffort) assert(!selectionOptionMatches(beforeCurrent.effort, optionLabel(afterCurrent.effort)), `Effort did not actually change during ${purpose}: before=${JSON.stringify(beforeCurrent.effort)} after=${JSON.stringify(afterCurrent.effort)}`);
        testLog('ok', scope, `${purpose} verified`, { model: optionLabel(afterCurrent.model), effort: optionLabel(afterCurrent.effort) });

        const modelSlug = events.map(eventData).map((data) => data.modelSlug).find(Boolean) || '';
        const result = { turnId, purpose, requested: selected, applied, before: beforeCurrent, after: afterCurrent, modelSlug, answer: expected };
        verified.push(result);
        lastKnownState = afterState;
        if (mustChangeModel || mustChangeEffort || (selected.model && !selectionOptionMatches(originalModel, selected.model)) || (selected.effort && !selectionOptionMatches(originalEffort, selected.effort))) selectionMayHaveChanged = true;
        return { result, state: afterState };
      };

      try {
        if (options.models.length || options.efforts.length) {
          const requestedSelectionCases = explicitSelectionCases(options);
          for (let index = 0; index < requestedSelectionCases.length; index += 1) {
            await executeSelectionCase(requestedSelectionCases[index], index, { beforeState: lastKnownState, purpose: 'explicit selection' });
          }
        } else {
          const alternateModel = alternativeSelectionOption(initialState.models, originalModel);
          assert(alternateModel, `Default model-effort E2E requires a second selectable model; current=${JSON.stringify(originalModel)} available=${JSON.stringify(initialState.models)}`);
          testLog('state', scope, 'Automatic model target chosen', { from: optionLabel(originalModel), to: optionLabel(alternateModel) });
          const modelSwitch = await executeSelectionCase(
            { model: optionLabel(alternateModel), effort: '', mode: 'automatic-switch' },
            0,
            { beforeState: initialState, mustChangeModel: true, purpose: 'model switch' },
          );

          const alternateEffort = alternativeSelectionOption(modelSwitch.state.efforts, modelSwitch.state.currentEffort);
          assert(alternateEffort, `Default model-effort E2E requires a second selectable effort after switching model; current=${JSON.stringify(modelSwitch.state.currentEffort)} available=${JSON.stringify(modelSwitch.state.efforts)}`);
          testLog('state', scope, 'Automatic effort target chosen', { from: optionLabel(modelSwitch.state.currentEffort), to: optionLabel(alternateEffort) });
          await executeSelectionCase(
            { model: '', effort: optionLabel(alternateEffort), mode: 'automatic-switch' },
            1,
            { beforeState: modelSwitch.state, mustChangeEffort: true, purpose: 'effort switch' },
          );
        }
      } catch (err) {
        primaryError = err;
        throw err;
      } finally {
        let currentState = lastKnownState;
        if (primaryError) {
          currentState = await readIntelligenceSnapshot(options, { scope, reason: 'recover the current state after a failed selection step' }).catch(() => lastKnownState);
        }
        const needsRestore = selectionMayHaveChanged
          || !selectionOptionMatches(currentState.currentModel || {}, optionLabel(originalModel))
          || !selectionOptionMatches(currentState.currentEffort || {}, optionLabel(originalEffort));
        if (needsRestore) {
          try {
            const restoreIndex = verified.length + 1;
            const turnId = `turn_e2e_${runId}_model_effort_restore`;
            const expected = `MODEL_EFFORT_RESTORED_${marker}`;
            testLog('step', scope, 'Restoring the original model and effort', { model: optionLabel(originalModel), effort: optionLabel(originalEffort) });
            await startTurn(options, {
              id: turnId,
              threadId: thread.id,
              sessionId,
              sourceClientId: testClient.id,
              model: optionLabel(originalModel),
              effort: optionLabel(originalEffort),
              message: `Restore the original model and effort after an isolated browser E2E check. Do not save anything from this request to account-wide memory. Output exactly ${expected} and nothing else.`,
              output: { expected: 'text', required: false },
            });
            testLog('wait', scope, 'Waiting for the original settings to be restored', { turnId });
            const snapshot = await waitTurn(options, turnId);
            const events = await turnEvents(options, turnId);
            const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
            const applied = eventData(events.find((event) => event.type === 'model.apply.done') || {});
            const restoredState = intelligenceSnapshotFromApplied(applied, currentState);
            assert(applied.intelligence, 'Model/effort restore did not return the internally verified picker state');
            testLog('state', scope, 'Using the internally verified restored state', {
              model: optionLabel(restoredState.currentModel),
              effort: optionLabel(restoredState.currentEffort),
            });
            assert(snapshot.turn.status === 'completed', `Model/effort restore turn ended as ${snapshot.turn.status}`);
            assert(normalizeAnswer(agent?.content?.text || '') === expected, `Model/effort restore answer mismatch: ${agent?.content?.text || ''}`);
            assert(applied.modelApplied === true && applied.effortApplied === true, `Original selection was not fully restored: ${JSON.stringify(applied)}`);
            assert(selectionOptionMatches(restoredState.currentModel, optionLabel(originalModel)), `Original model was not restored: ${JSON.stringify(restoredState.currentModel)}`);
            assert(selectionOptionMatches(restoredState.currentEffort, optionLabel(originalEffort)), `Original effort was not restored: ${JSON.stringify(restoredState.currentEffort)}`);
            testLog('ok', scope, 'Original settings restored', { model: optionLabel(restoredState.currentModel), effort: optionLabel(restoredState.currentEffort) });
            lastKnownState = restoredState;
            restoreResult = { turnId, index: restoreIndex, requested: { model: optionLabel(originalModel), effort: optionLabel(originalEffort) }, applied, currentAfter: { model: restoredState.currentModel, effort: restoredState.currentEffort }, answer: expected };
          } catch (restoreError) {
            if (primaryError) {
              primaryError.message = `${primaryError.message}\nAdditionally failed to restore the original model/effort: ${restoreError.message}`;
              testLog('warn', scope, 'Failed to restore original settings after the primary failure', { message: restoreError.message });
            } else {
              throw restoreError;
            }
          }
        } else {
          testLog('ok', scope, 'Settings already match the original state; restore is not needed');
        }
      }
      return {
        availableModels: initialState.models,
        availableEfforts: initialState.efforts,
        original: { model: originalModel, effort: originalEffort },
        automaticSwitch: !options.models.length && !options.efforts.length,
        verified,
        restored: restoreResult,
      };
    });

    await scenario('reasoning-steer', async (entry) => {
      const thread = await createThread(options, '', `E2E reasoning ${runId}`);
      const requestedModel = options.models[0] || '';
      const requestedEffort = options.efforts[0] || 'high';
      let completed = null;
      const attempts = [];
      for (let attempt = 1; attempt <= 2 && !completed; attempt += 1) {
        const turnId = `turn_e2e_${runId}_steer_${attempt}`;
        const upper = attempt === 1 ? 240 : 480;
        await startTurn(options, {
          id: turnId,
          threadId: thread.id,
          sessionId,
          sourceClientId: testClient.id,
          model: requestedModel,
          effort: requestedEffort,
          message: `This tests steering an active request. Simulate a long multi-step task: compute the sum of squares from 1 through ${upper}, then independently verify the result with the closed-form formula and checkpoint partial sums. Do not jump directly to the final response. Initial rule for this request: unless a new instruction arrives while you are working, output exactly STEER_RESULT RED in the final response.`,
          output: { expected: 'text', required: false },
        });
        const steerWindow = await waitForSteerWindow(options, turnId, 90_000);
        if (steerWindow.terminal) {
          attempts.push({ turnId, status: 'completed_before_steer', eventTypes: eventTypes(steerWindow.events) });
          continue;
        }
        const steerMessage = 'This new instruction overrides the original response rule. Stop the remaining calculations immediately. Do not output RED and do not add an explanation. In the final response, output exactly STEER_RESULT BLUE.';
        const steerResponse = await api(options, `/requests/${encodeURIComponent(turnId)}/steer`, { method: 'POST', body: { sourceClientId: testClient.id, message: steerMessage } });
        const snapshot = await waitTurn(options, turnId);
        const events = await turnEvents(options, turnId);
        const reasoningItems = (snapshot.items || []).filter((item) => item.type === 'reasoning');
        const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
        const final = normalizeAnswer(agent?.content?.text || '');
        attempts.push({ turnId, status: snapshot.turn.status, steerResponse, final, eventTypes: eventTypes(events) });
        assert(snapshot.turn.status === 'completed', `Turn ended as ${snapshot.turn.status}`);
        assert(final === 'STEER_RESULT BLUE', `Steer did not override the original RED rule exactly: ${agent?.content?.text || ''}`);
        assert(events.some((event) => event.type === 'prompt.steer.accepted'), 'No prompt.steer.accepted event was recorded');
        assert(events.some((event) => event.type === 'normal.done.received'), 'No normal.done.received completion event');
        assert(events.some((event) => event.type === 'turn/completed'), 'No turn/completed event');
        if (!reasoningItems.length) {
          entry.status = options.strictReasoning ? 'failed' : 'inconclusive';
          entry.note = 'ChatGPT exposed no visible reasoning summary in DOM for this run.';
          if (options.strictReasoning) throw new Error(entry.note);
        }
        logEvent('turn.diagnostics', { turnId, items: snapshot.items, events, steerMessage });
        completed = { turnId, reasoningItems, events, final };
      }
      assert(completed, `ChatGPT completed both long-running attempts before a steer could be submitted: ${JSON.stringify(attempts)}`);
      return {
        turnId: completed.turnId,
        attempts,
        reasoningItems: completed.reasoningItems.map((item) => ({ id: item.id, status: item.status, text: item.content?.text })),
        eventTypes: eventTypes(completed.events),
        final: completed.final,
        originalRule: 'STEER_RESULT RED',
        overriddenRule: 'STEER_RESULT BLUE',
      };
    });

    await scenario('multiple-files', async () => {
      const names = [`${runId}-one.txt`, `${runId}-two.json`, `${runId}-three.csv`];
      const expected = new Map([[names[0], `${marker}_ONE\n`], [names[1], `{"marker":"${marker}_TWO"}\n`], [names[2], `key,value\nmarker,${marker}_THREE\n`]]);
      const response = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { sourceClientId: testClient.id, output: { expected: 'file', required: true }, message: `Create and attach three separate downloadable files, not code blocks: ${names[0]} containing the single line ${marker}_ONE; ${names[1]} containing valid JSON {"marker":"${marker}_TWO"}; and ${names[2]} containing the CSV rows key,value and marker,${marker}_THREE. Attach all three files in one response.` } });
      const artifacts = artifactsFromResponse(response);
      assert(artifacts.length >= 3, `Expected at least 3 artifacts, got ${artifacts.length}`);
      const verified = [];
      for (const name of names) {
        const artifact = artifacts.find((item) => String(item.name || '').toLowerCase() === name.toLowerCase());
        assert(artifact, `Missing artifact ${name}`); const bytes = await downloadArtifact(options, artifact);
        assert(bytes.toString('utf8') === expected.get(name), `Unexpected content in ${name}: ${JSON.stringify(bytes.toString('utf8'))}`);
        verified.push({ id: artifact.id, name, size: bytes.length, sha256: sha256(bytes) });
      }
      return { verified };
    });

    await scenario('zip-artifact', async () => {
      const zipName = `${runId}-bundle.zip`;
      const response = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { sourceClientId: testClient.id, output: { expected: 'zip', required: true }, message: `Create one real ZIP file named ${zipName}. The archive must contain exactly two files: alpha.txt with content ${marker}_ALPHA and nested/beta.txt with content ${marker}_BETA. Do not add any other files and do not replace the archive with a link or code block.` } });
      const artifact = artifactsFromResponse(response).find((item) => /\.zip$/i.test(item.name || '')) || artifactsFromResponse(response)[0];
      const bytes = await downloadArtifact(options, artifact); const inspected = await inspectZipBuffer(bytes, workDir, 'single-bundle');
      assert(inspected.files['alpha.txt']?.trim() === `${marker}_ALPHA`, 'alpha.txt mismatch');
      assert(inspected.files['nested/beta.txt']?.trim() === `${marker}_BETA`, 'nested/beta.txt mismatch');
      assert(Object.keys(inspected.files).length === 2, `ZIP contains unexpected entries: ${Object.keys(inspected.files).join(', ')}`);
      return { artifact: { id: artifact.id, name: artifact.name, size: bytes.length, sha256: sha256(bytes) }, entries: Object.keys(inspected.files) };
    });

    await scenario('project-context', async () => {
      const projectDir = path.join(workDir, 'project-with-context');
      await fs.mkdir(path.join(projectDir, '.bridge', 'skills'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'seed.txt'), `${marker}_SEED\n`);
      await fs.writeFile(path.join(projectDir, 'AGENT.md'), `For E2E output tasks, always include the literal token AGENT_${marker}. Do not omit it.\n`);
      await fs.writeFile(path.join(projectDir, '.bridge', 'skills', 'deterministic.md'), `When enabled, include the literal token SKILL_${marker} in result.txt.\n`);
      const thread = await createThread(options, projectDir, `E2E project ${runId}`);
      const first = await startTurn(options, { threadId: thread.id, cwd: projectDir, sourceClientId: testClient.id, sessionId, project: { mode: 'package', skills: ['deterministic'], snapshotPolicy: 'reuse-if-unchanged' }, output: { expected: 'zip', required: true }, message: `Return a complete ZIP of the project. Create result.txt at the archive root with exactly four lines: seed=${marker}_SEED, agent=AGENT_${marker}, skill=SKILL_${marker}, revision=1. Preserve all other input files.` });
      const firstDone = await waitTurn(options, first.id); const firstEvents = await turnEvents(options, first.id);
      assert(firstDone.turn.status === 'completed', `First project turn: ${firstDone.turn.status}`);
      const firstArtifact = artifactsFromTurn(firstDone).find((item) => /\.zip$/i.test(item.name || '')) || artifactsFromTurn(firstDone)[0];
      const firstZip = await inspectZipBuffer(await downloadArtifact(options, firstArtifact), workDir, 'project-rev1');
      const expected1 = `seed=${marker}_SEED\nagent=AGENT_${marker}\nskill=SKILL_${marker}\nrevision=1`;
      assert(firstZip.files['result.txt']?.trim() === expected1, `AGENT/skill result mismatch: ${firstZip.files['result.txt']}`);
      const package1 = firstEvents.find((event) => event.type === 'project/packageCreated')?.data || firstEvents.find((event) => event.type === 'project/packageCreated') || {};

      const second = await startTurn(options, { threadId: thread.id, cwd: projectDir, sourceClientId: testClient.id, sessionId, project: { mode: 'package', skills: ['deterministic'], snapshotPolicy: 'reuse-if-unchanged' }, output: { expected: 'zip', required: true }, message: `Use the result of the previous turn in this conversation and return an updated complete ZIP of the project. Change only result.txt: preserve the first three lines exactly, replace revision=1 with revision=2, and add a fifth line previous=${sha256(Buffer.from(expected1)).slice(0, 16)}.` });
      const secondDone = await waitTurn(options, second.id); const secondEvents = await turnEvents(options, second.id);
      assert(secondDone.turn.status === 'completed', `Second project turn: ${secondDone.turn.status}`);
      const secondArtifact = artifactsFromTurn(secondDone).find((item) => /\.zip$/i.test(item.name || '')) || artifactsFromTurn(secondDone)[0];
      const secondZip = await inspectZipBuffer(await downloadArtifact(options, secondArtifact), workDir, 'project-rev2');
      const expected2 = `${expected1.replace('revision=1', 'revision=2')}\nprevious=${sha256(Buffer.from(expected1)).slice(0, 16)}`;
      assert(secondZip.files['result.txt']?.trim() === expected2, `Second-turn modification mismatch: ${secondZip.files['result.txt']}`);
      const packageEvents = secondEvents.filter((event) => event.type === 'project/packageCreated');
      assert(packageEvents.length === 1, `Expected one packageCreated event, got ${packageEvents.length}`);
      const package2 = packageEvents[0].data || packageEvents[0];
      assert(package2.attached === false, `Unchanged snapshot was attached again: ${JSON.stringify(package2)}`);
      assert(package2.reused === true, `Unchanged snapshot was not reported reused: ${JSON.stringify(package2)}`);
      logEvent('project.turns', { first: { turn: firstDone.turn, events: firstEvents }, second: { turn: secondDone.turn, events: secondEvents } });
      return { firstTurnId: first.id, secondTurnId: second.id, firstPackage: package1, secondPackage: package2, result1: expected1, result2: expected2 };
    });

    await scenario('project-no-context', async () => {
      const projectDir = path.join(workDir, 'project-without-context'); await fs.mkdir(projectDir, { recursive: true }); await fs.writeFile(path.join(projectDir, 'plain.txt'), 'plain\n');
      const thread = await createThread(options, projectDir, `E2E no context ${runId}`);
      const turn = await startTurn(options, { threadId: thread.id, cwd: projectDir, sourceClientId: testClient.id, sessionId, project: { mode: 'package', skills: ['missing-skill'], snapshotPolicy: 'reuse-if-unchanged' }, output: { expected: 'zip', required: true }, message: `Return a complete ZIP of the project and add fallback.txt containing the single line NO_CONTEXT_${marker}. The absence of AGENT.md and the requested skill must not be treated as an error.` });
      const done = await waitTurn(options, turn.id); assert(done.turn.status === 'completed', `No-context turn: ${done.turn.status}`);
      const artifact = artifactsFromTurn(done).find((item) => /\.zip$/i.test(item.name || '')) || artifactsFromTurn(done)[0];
      const inspected = await inspectZipBuffer(await downloadArtifact(options, artifact), workDir, 'no-context');
      assert(inspected.files['fallback.txt']?.trim() === `NO_CONTEXT_${marker}`, 'fallback.txt mismatch');
      return { turnId: turn.id, files: Object.keys(inspected.files) };
    });

    report.status = report.scenarios.some((item) => item.status === 'failed') ? 'failed' : report.scenarios.some((item) => item.status === 'inconclusive') ? 'passed_with_inconclusive' : 'passed';
    if (scenarioFailures.length) {
      const summary = scenarioFailures.map((failure) => `${failure.id}: ${failure.error.message}`).join('; ');
      const aggregate = new Error(`${scenarioFailures.length} E2E scenario(s) failed: ${summary}`);
      aggregate.name = 'E2EScenarioAggregateError';
      aggregate.failures = scenarioFailures.map((failure) => ({ id: failure.id, name: failure.name, message: failure.error.message, stack: failure.error.stack }));
      throw aggregate;
    }
  } catch (err) {
    primaryError = err;
    report.status = 'failed';
    report.error = { message: err.message, stack: err.stack };
    step(`FAILED: ${err.message}`);
    writeConsoleLine(`${nowIso()} [e2e] ${err.stack || err.message}`);
  } finally {
    try {
      report.bridgeEvents = (await api(options, '/events?limit=5000')).events || [];
      report.debugEvents = (await api(options, '/debug/events?limit=5000')).events || [];
    } catch (err) { report.diagnosticsCollectionError = err.message; }
    if (testClient?.id && !options.keepSession) {
      try {
        if (sessionId && sessionUrl) {
          const currentSnapshot = await clientSnapshot(options); const currentClient = currentSnapshot.clients?.find((client) => client.id === testClient.id);
          const currentConversation = canonicalConversation(currentClient?.url || currentClient?.session?.url || '');
          assert(currentConversation?.id === sessionId && currentConversation.url === sessionUrl, `Cleanup refused: expected ${sessionUrl}, current ${currentClient?.url || '(missing)'}`);
          const deletion = await deleteOwnedSessionWithRetry(options, { sessionId, sessionUrl, sourceClientId: testClient.id });
          const deleted = deletion.deleted;
          assert(deleted.deleted === true && deleted.deletedSessionId === sessionId, 'Deletion did not confirm expected session');
          await api(options, '/browser/tabs/close', { method: 'POST', timeoutMs: 15_000, body: { sourceClientId: testClient.id, expectedLaunchToken: launchToken, expectedUrl: deleted.afterUrl, timeoutMs: 10_000 } });
          report.cleanup = { deleted: true, sessionId, beforeUrl: deleted.beforeUrl, afterUrl: deleted.afterUrl, tabClosed: true, attempts: deletion.attempts };
        }
      } catch (cleanupError) {
        report.cleanup = { failed: true, error: cleanupError.message, attempts: cleanupError.cleanupAttempts || [], sessionId, sessionUrl, clientId: testClient.id };
        report.status = 'failed';
        if (!report.error) report.error = { message: cleanupError.message, stack: cleanupError.stack };
        if (!primaryError) primaryError = cleanupError;
      }
    } else if (testClient?.id) report.cleanup = { skipped: true, reason: '--keep-session', sessionId, sessionUrl, clientId: testClient.id };
    try {
      const snapshot = await clientSnapshot(options);
      if (previousSelectedClientId && snapshot.clients?.some((client) => client.id === previousSelectedClientId && usableClient(client))) await api(options, '/tm/select', { method: 'POST', body: { clientId: previousSelectedClientId } });
      else await api(options, '/tm/select', { method: 'DELETE' });
    } catch {}
    try {
      report.finalDownloadCleanupVerification = await verifyRemovedDownloadSourcesRemainAbsent(report.downloadCleanupAudits);
    } catch (cleanupVerificationError) {
      report.status = 'failed';
      if (!report.error) report.error = { message: cleanupVerificationError.message, stack: cleanupVerificationError.stack };
      if (!primaryError) primaryError = cleanupVerificationError;
    }
    report.sessionId = sessionId;
    report.sessionUrl = sessionUrl;
    report.finishedAt = nowIso();
    try {
      const outputs = await writeDiagnostics(options.reportDir, report, timeline);
      step(`Report: ${outputs.jsonPath}`);
      step(`Diagnostic bundle: ${outputs.bundlePath}`);
    } catch (diagnosticsError) {
      step(`FAILED to finalize diagnostics: ${diagnosticsError.message}`);
      try {
        await fs.mkdir(options.reportDir, { recursive: true });
        await fs.writeFile(path.join(options.reportDir, 'DIAGNOSTICS_WRITE_ERROR.txt'), `${diagnosticsError.stack || diagnosticsError.message}\n`);
        await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
      } catch {}
      report.status = 'failed';
      if (!report.error) report.error = { message: diagnosticsError.message, stack: diagnosticsError.stack };
      if (!primaryError) primaryError = diagnosticsError;
    } finally {
      if (liveDebugTrace) await liveDebugTrace.stop().catch(() => {});
      if (ownedServer) {
        ownedServer.kill('SIGTERM');
        await Promise.race([new Promise((resolve) => ownedServer.once('exit', resolve)), sleep(5_000)]);
      }
      if (ownedServer) await fs.rm(options.serverDataDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (primaryError) throw primaryError;
}

run().catch((err) => { const text = `[e2e] ${err.stack || err.message || String(err)}`; console.error(text); writeConsoleLine(`${nowIso()} ${text}`); process.exitCode = 1; });
