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

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TERMINAL_TURN_STATUSES = new Set(['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled']);
let consoleLogPath = '';

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
    strictReasoning: true,
    reportDir: path.join(process.cwd(), '.bridge-data', 'e2e', 'last-real-e2e'),
    autoStartServer: true,
    autoOpenBrowser: true,
    bootstrapWaitMs: 0,
    tabReadyTimeoutMs: 60_000,
    tabSettleMs: 1_500,
    models: splitOptionValues(process.env.E2E_MODELS || ''),
    efforts: splitOptionValues(process.env.E2E_EFFORTS || ''),
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
    else if (arg === '--report-dir') options.reportDir = path.resolve(next());
    else if (arg === '--report') options.reportDir = path.dirname(path.resolve(next()));
    else if (arg === '--model' || arg === '--models') appendUnique(options.models, splitOptionValues(next()));
    else if (arg === '--effort' || arg === '--efforts') appendUnique(options.efforts, splitOptionValues(next()));
    else if (arg === '--tab-ready-timeout-ms') options.tabReadyTimeoutMs = Math.max(10_000, Number(next()) || options.tabReadyTimeoutMs);
    else if (arg === '--tab-settle-ms') options.tabSettleMs = Math.max(0, Number(next()) || 0);
    else if (arg === '--keep-session' || arg === '--no-cleanup') options.keepSession = true;
    else if (arg === '--allow-no-reasoning') options.strictReasoning = false;
    else if (arg === '--no-start-server') options.autoStartServer = false;
    else if (arg === '--no-open-browser') options.autoOpenBrowser = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  return options;
}

function printHelp() {
  console.log(`Real ChatGPT browser E2E matrix

Usage:
  npm run test:e2e:real
  npm run test:e2e:real -- --keep-session

Options:
  --keep-session          Leave the verified ChatGPT conversation and tab open
  --allow-no-reasoning    Mark absent visible reasoning as inconclusive instead of failing
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
  --no-open-browser       Disable OS browser fallback`);
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
function writeConsoleLine(line) {
  if (!consoleLogPath) return;
  try { fsSync.appendFileSync(consoleLogPath, `${line.endsWith('\n') ? line : `${line}\n`}`); } catch {}
}
function step(message) {
  const line = `[e2e] ${message}`;
  console.log(line);
  writeConsoleLine(`${nowIso()} ${line}`);
}
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
  const readinessVersion = compareVersions(opened.client.clientVersion || '', '2.12.10');
  assert(readinessVersion !== null && readinessVersion >= 0, `Real E2E page-readiness handshake requires content runtime 2.12.10+ (extension 0.4.11+); got ${opened.client.clientVersion || 'unknown'}. Reload the unpacked extension and reload ChatGPT tabs.`);
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

async function waitTurn(options, turnId) {
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
    if (TERMINAL_TURN_STATUSES.has(snapshot.turn.status)) return snapshot;
    const events = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    const active = (health.activeRequests || []).find((item) => item.requestId === turnId) || null;
    const waitState = turnWaitStage(snapshot, events, active);
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

function selectionCases(options) {
  if (!options.models.length && !options.efforts.length) return [];
  const models = options.models.length ? options.models : [''];
  const efforts = options.efforts.length ? options.efforts : [''];
  const result = [];
  for (const model of models) for (const effort of efforts) result.push({ model, effort });
  if (result.length > 12) throw new Error(`Refusing to run ${result.length} model/effort combinations; limit is 12`);
  return result;
}
async function downloadArtifact(options, artifact) {
  assert(artifact?.id, 'Artifact has no id');
  const name = artifact.name || artifact.fileName || artifact.id;
  const started = Date.now();
  console.log(`[e2e] Downloading artifact ${name} (${artifact.id})`);
  const bytes = await api(options, `/artifacts/${encodeURIComponent(artifact.id)}/download`, { binary: true, timeoutMs: options.artifactTimeoutMs });
  console.log(`[e2e] Downloaded artifact ${name}: ${bytes.length} bytes in ${Date.now() - started}ms`);
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
  const rows = report.scenarios.map((item) => `| ${item.name} | ${item.status} | ${item.durationMs ?? ''} | ${String(item.error?.message || item.note || '').replaceAll('|', '\\|')} |`).join('\n');
  await fs.writeFile(summaryPath, `# Real E2E report\n\n- Run: \`${report.runId}\`\n- Status: **${report.status}**\n- Started: ${report.startedAt}\n- Finished: ${report.finishedAt || ''}\n- Session: ${report.sessionUrl || '(not created)'}\n\n| Scenario | Status | ms | Detail |\n|---|---:|---:|---|\n${rows}\n\n## Cleanup\n\n\`\`\`json\n${JSON.stringify(report.cleanup, null, 2)}\n\`\`\`\n`);
  const runningPath = path.join(reportDir, 'RUNNING.json');
  await fs.rm(runningPath, { force: true }).catch(() => {});
  const bundlePath = `${reportDir}.zip`;
  const entries = [
    { name: 'report.json', path: jsonPath },
    { name: 'timeline.ndjson', path: timelinePath },
    { name: 'SUMMARY.md', path: summaryPath },
  ];
  if (consoleLogPath && fsSync.existsSync(consoleLogPath)) entries.push({ name: 'console.log', path: consoleLogPath });
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
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  await resolveBridgeRuntime(options, runId);
  await initializeDiagnostics(options, runId);
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
    cleanup: null,
  };
  const timeline = [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `bridge-real-e2e-${runId}-`));
  let ownedServer = null; let testClient = null; let launchToken = ''; let sessionId = ''; let sessionUrl = ''; let previousSelectedClientId = ''; let primaryError = null;
  const logEvent = (type, data = {}) => timeline.push({ at: nowIso(), type, ...data });
  await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
  async function scenario(name, fn) {
    const entry = { name, status: 'running', startedAt: nowIso() }; report.scenarios.push(entry); step(name); logEvent('scenario.started', { name }); const started = Date.now();
    try { const data = await fn(entry); entry.status = entry.status === 'inconclusive' ? entry.status : 'passed'; if (data !== undefined) entry.data = data; }
    catch (err) { entry.status = 'failed'; entry.error = { message: err.message, stack: err.stack }; throw err; }
    finally {
      entry.finishedAt = nowIso();
      entry.durationMs = Date.now() - started;
      logEvent('scenario.finished', { name, status: entry.status, durationMs: entry.durationMs });
      await writeDiagnosticCheckpoint(options.reportDir, report, timeline).catch((err) => {
        step(`Warning: could not write diagnostic checkpoint after ${name}: ${err.message}`);
      });
    }
  }

  try {
    ownedServer = await startBridgeIfNeeded(options);
    const before = await clientSnapshot(options); previousSelectedClientId = String(before.selectedClientId || '');
    const opened = await createIsolatedTab(options, runId); testClient = opened.client; launchToken = opened.launchToken;
    assert(testClient?.id, 'Isolated tab has no bridge client id');
    assert(testClient.capabilities?.sessionDeletion === true && testClient.capabilities?.browserTabs === true, 'Reload the extension packaged with this bridge');
    assert(testClient.capabilities?.promptSteering === true, 'Extension does not advertise promptSteering; reload extension 0.3.8+');
    logEvent('tab.opened', { clientId: testClient.id, openedBy: opened.openedBy, launchToken, bootstrapClientId: opened.bootstrapClientId || '', targetUrl: opened.targetUrl || '' });

    await scenario('deterministic conversation and completion', async () => {
      const firstPrompt = `This is a real integration test. Keep marker ${marker} only in the context of this conversation. Do not add it to ChatGPT account-wide memory and do not modify saved memories. This marker instruction applies only to this chat. In this response, output exactly: ACK ${marker}`;
      const first = await api(options, '/chat', { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { message: firstPrompt, sourceClientId: testClient.id } });
      assert(normalizeAnswer(first.answer || first.response) === `ACK ${marker}`, `Unexpected answer: ${first.answer || first.response}`);
      const conversation = canonicalConversation(first.session?.url || first.url || '');
      assert(conversation?.id && first.session?.id === conversation.id, 'Concrete conversation URL/session mismatch');
      sessionId = conversation.id; sessionUrl = conversation.url;
      const follow = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { message: 'Using only the context of this conversation, output exactly the control identifier from the previous message. This instruction applies only to the current response.', sourceClientId: testClient.id } });
      assert(normalizeAnswer(follow.answer || follow.response) === marker, 'Conversation continuity failed');
      return { sessionId, sessionUrl, requestIds: [first.requestId, follow.requestId], memoryScopeExplicit: true };
    });

    const requestedSelectionCases = selectionCases(options);
    if (requestedSelectionCases.length) {
      await scenario('requested model and effort matrix', async () => {
        const models = await api(options, '/models');
        const efforts = await api(options, '/efforts');
        const thread = await createThread(options, '', `E2E model matrix ${runId}`);
        const verified = [];
        for (let index = 0; index < requestedSelectionCases.length; index += 1) {
          const selected = requestedSelectionCases[index];
          const turnId = `turn_e2e_${runId}_model_${index + 1}`;
          const expected = `MODEL_CASE_${index + 1}_${marker}`;
          await startTurn(options, {
            id: turnId,
            threadId: thread.id,
            sessionId,
            sourceClientId: testClient.id,
            model: selected.model,
            effort: selected.effort,
            message: `This tests model and reasoning-effort selection. Do not save anything from this request to account-wide memory. In the current response, output exactly ${expected}.`,
            output: { expected: 'text', required: false },
          });
          const snapshot = await waitTurn(options, turnId);
          const events = await turnEvents(options, turnId);
          const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
          assert(snapshot.turn.status === 'completed', `Model case ${index + 1} ended as ${snapshot.turn.status}`);
          assert(normalizeAnswer(agent?.content?.text || '') === expected, `Model case ${index + 1} answer mismatch: ${agent?.content?.text || ''}`);
          const applyEvent = events.find((event) => event.type === 'model.apply.done');
          const applied = eventData(applyEvent || {});
          if (selected.model) assert(applyEvent && applied.modelApplied === true, `Model was not confirmed for case ${index + 1}: ${selected.model}`);
          if (selected.effort) assert(applyEvent && applied.effortApplied === true, `Effort was not confirmed for case ${index + 1}: ${selected.effort}`);
          const modelSlug = events.map(eventData).map((data) => data.modelSlug).find(Boolean) || '';
          verified.push({ turnId, requested: selected, applied, modelSlug, answer: expected });
        }
        return { availableModels: models.models || [], availableEfforts: efforts.efforts || [], verified };
      });
    }

    await scenario('visible reasoning items, finalization and steer', async (entry) => {
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

    await scenario('multiple downloadable files', async () => {
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

    await scenario('single deterministic ZIP artifact', async () => {
      const zipName = `${runId}-bundle.zip`;
      const response = await api(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: { sourceClientId: testClient.id, output: { expected: 'zip', required: true }, message: `Create one real ZIP file named ${zipName}. The archive must contain exactly two files: alpha.txt with content ${marker}_ALPHA and nested/beta.txt with content ${marker}_BETA. Do not add any other files and do not replace the archive with a link or code block.` } });
      const artifact = artifactsFromResponse(response).find((item) => /\.zip$/i.test(item.name || '')) || artifactsFromResponse(response)[0];
      const bytes = await downloadArtifact(options, artifact); const inspected = await inspectZipBuffer(bytes, workDir, 'single-bundle');
      assert(inspected.files['alpha.txt']?.trim() === `${marker}_ALPHA`, 'alpha.txt mismatch');
      assert(inspected.files['nested/beta.txt']?.trim() === `${marker}_BETA`, 'nested/beta.txt mismatch');
      assert(Object.keys(inspected.files).length === 2, `ZIP contains unexpected entries: ${Object.keys(inspected.files).join(', ')}`);
      return { artifact: { id: artifact.id, name: artifact.name, size: bytes.length, sha256: sha256(bytes) }, entries: Object.keys(inspected.files) };
    });

    await scenario('project AGENT.md, skill, multi-turn edit and snapshot reuse', async () => {
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

    await scenario('project without AGENT.md or skills remains functional', async () => {
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
