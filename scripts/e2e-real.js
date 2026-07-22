#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { writeZip } from '../src/zipWriter.js';
import { extractZipFile, validateZipFile } from '../src/zipUtils.js';
import { expandScenarioSelectors, formatScenarioList, scenarioDefinition } from './e2e-scenarios.js';
import { createE2eConsole } from './e2e-console.js';
import { buildPassivePromptBody, findWorkflowWaitOutcome, markReportInterrupted, workflowEventKey, workflowProgressFromEvents } from './e2e-workflow-support.js';
import { canonicalTerminalFailure, canonicalTransitionPath, turnProgressSignature, turnWaitState } from './e2e/request-state-wait.js';
import { writeFailedRequestStateTrace } from './e2e/request-state-trace.js';
import { startLiveDebugTrace } from './e2e/live-debug.js';
import { parseArgs, printHelp } from './e2e/cli.js';
import { REASONING_PROGRESS_PERCENTAGES, reasoningTestPrompt, extractReasoningProgressPercentages, validateReasoningFinalAnswer, validatePublicReasoningStream } from './e2e/reasoning-support.js';
import { openPublicTurnEventStream } from './e2e/public-turn-stream.js';
import { createParserObservationWriter, firstDifference, logicalProgressId, mergeObservedProgress, progressRevisionTimeline, reasoningSnapshotsFromEvents } from './e2e/parser-observation.js';
import { createDomFixtureCapture, withDomCaptureMetadata } from './e2e/dom-fixture-capture.js';
import { createPageLayoutCapture } from './e2e/page-layout-capture.js';
import { createWorkflowE2eRuntime } from './e2e/workflow-runtime.js';
import { runCoreScenarios } from './e2e/scenarios/core.js';
import { createCoreScenarioContextFactory } from './e2e/core-scenario-context.js';
import { runWorkflowProjectScenarios } from './e2e/scenarios/workflows-projects.js';
import { writeFinalDiagnostics } from './e2e/diagnostics.js';
import { collectE2eIssues, writeE2eIssueSummary } from './e2e/error-summary.js';
import { prepareIsolatedE2eTab } from './e2e/startup-extension.js';
import { browserOwnershipIdentity, findOwnedBrowserClient, quiesceBrowserWork } from './e2e/scenario-recovery.js';
import { createScenarioRunner } from './e2e/scenario-runner.js';
import { artifactsFromTurnSnapshot, isZipArtifactCandidate } from './e2e/artifact-selection.js';
import { abortableDelay, createE2eInterruptionController, createE2eSignalCoordinator, isE2eInterruption, ownedBridgeSpawnOptions } from './e2e/interruption.js';
import { stopInterruptedBridgeWork } from './e2e/interrupted-cleanup.js';
import { initializeDiagnostics, resolveBridgeRuntime, writeDiagnosticCheckpoint } from './e2e/runtime.js';
import { startMockChatGptRuntime, stopMockChatGptRuntime } from './e2e/mock-chatgpt/runtime.js';
import { alternativeSelectionOption, explicitSelectionCases, intelligenceSnapshotFromApplied, normalizeSelectionValue, optionLabel, selectedOption, selectionOptionMatches } from './e2e/intelligence-selection.js';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
process.env.BRIDGE_DISABLE_NOTIFICATIONS = '1';
const TERMINAL_TURN_STATUSES = new Set(['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled']);
let consoleLogPath = '';
let e2eConsole = null;
const turnLogContexts = new Map();
const FAST_EFFORT = 'instant';
const DEFAULT_REASONING_EFFORT = 'high';
const interruption = createE2eInterruptionController();
let activeInterruptedRun = null;
let forcedInterruption = false;
let cleanupMode = false;
const requestInterruption = createE2eSignalCoordinator({
  interruption,
  onGraceful(signal) {
    const state = activeInterruptedRun;
    const at = new Date().toISOString();
    if (state) markReportInterrupted(state.report, state.timeline, signal, at);
    testLog('warn', 'runner', 'Interrupt received; cancelling active waits and entering graceful cleanup', {
      signal,
      reportDir: state?.options?.reportDir || '',
    });
  },
  onDuplicate: (signal) => writeConsoleLine(`${new Date().toISOString()} [e2e] Ignored duplicate ${signal} while graceful cleanup is starting.`),
  onForce(signal) {
    forcedInterruption = true;
    writeConsoleLine(`${new Date().toISOString()} [e2e] Second interrupt received; forcing exit.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  },
});
const nowIso = () => new Date().toISOString();
const sleep = (ms, options = {}) => abortableDelay(ms, options.ignoreAbort || cleanupMode ? null : interruption.signal);
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
  const abortFromRun = () => controller.abort(interruption.signal.reason);
  if (!cleanupMode && !request.ignoreRunAbort) {
    if (interruption.signal.aborted) abortFromRun();
    else interruption.signal.addEventListener('abort', abortFromRun, { once: true });
  }
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
  } finally { if (timer) clearTimeout(timer); interruption.signal.removeEventListener('abort', abortFromRun); }
}
async function waitUntil(check, { timeoutMs = 30_000, intervalMs = 300, message = 'condition' } = {}) {
  const started = Date.now(); let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (!cleanupMode) interruption.throwIfRequested();
    try { const value = await check(); if (value) return value; } catch (err) {
      if (isE2eInterruption(err)) throw err;
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? `: ${lastError.message}` : ''}`);
}
async function bridgeReachable(options) { try { return (await fetch(`${options.baseUrl}/setup/status`, { cache: 'no-store' })).ok; } catch { return false; } }
async function startBridgeIfNeeded(options, { deferConsoleOutput = false } = {}) {
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
    API_TOKEN: String(options.apiToken || ''), BRIDGE_TOKEN: String(options.bridgeToken || ''),
    BRIDGE_DISABLE_NOTIFICATIONS: '1',
    BRIDGE_E2E_TEST_HOOKS: '1',
    ARTIFACT_CHUNK_TIMEOUT_MS: String(Math.min(60_000, Math.max(30_000, options.artifactTimeoutMs))),
  };
  const child = spawn(process.execPath, ['src/index.js', '--server'], ownedBridgeSpawnOptions({ cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }));
  const bufferedOutput = [];
  let consoleOutputReleased = !deferConsoleOutput;
  const forwardChildOutput = (stream, prefix, chunk) => {
    const text = String(chunk);
    writeConsoleLine(`${nowIso()} [bridge:${prefix}] ${text.replace(/\n$/, '')}`);
    if (consoleOutputReleased) stream.write(chunk);
    else bufferedOutput.push({ stream, chunk: Buffer.from(chunk) });
  };
  child.releaseConsoleOutput = () => {
    if (consoleOutputReleased) return;
    consoleOutputReleased = true;
    for (const entry of bufferedOutput.splice(0)) entry.stream.write(entry.chunk);
  };
  child.stdout.on('data', (chunk) => {
    forwardChildOutput(process.stdout, 'stdout', chunk);
  });
  child.stderr.on('data', (chunk) => {
    forwardChildOutput(process.stderr, 'stderr', chunk);
  });
  try {
    await waitUntil(() => bridgeReachable(options), { timeoutMs: 20_000, message: 'bridge startup' });
    return child;
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
}
async function clientSnapshot(options) { return await api(options, '/browser/clients'); }
function usableClient(client) { return client?.ready && client.compatible !== false && client.compatibility?.compatible !== false; }
async function createThread(options, cwd, title, { scope = 'thread' } = {}) {
  testLog('action', scope, 'Creating bridge thread', { title, cwd: cwd || '(none)' });
  const thread = (await api(options, '/threads', { method: 'POST', body: { cwd, title } })).thread;
  testLog('ok', scope, 'Bridge thread created', { threadId: thread?.id || '' });
  return thread;
}
function outputExpectation(output = {}) {
  const expected = String(output?.expected || 'text');
  return output?.required ? `${expected}:required` : expected;
}
async function startTurn(options, body, { scope = 'turn', label = 'prompt' } = {}) {
  const turnId = String(body?.id || '');
  const startedAt = Date.now();
  const prompt = String(body?.message || '');
  const context = {
    scope,
    label,
    startedAt,
    promptChars: prompt.length,
    expectedOutput: outputExpectation(body?.output),
    effort: body?.effort || '(unchanged)',
    model: body?.model || '(unchanged)',
  };
  if (turnId) turnLogContexts.set(turnId, context);
  testLog('action', scope, 'Submitting prompt to the bridge', {
    turnId,
    label,
    chars: prompt.length,
    model: context.model,
    effort: context.effort,
    output: context.expectedOutput,
  });
  testLog('wait', scope, 'Waiting for the bridge to accept and dispatch the prompt', { turnId });
  const requestBody = withDomCaptureMetadata(body, options.captureDomFixtures);
  const turn = (await api(options, '/turns', { method: 'POST', body: requestBody })).turn;
  const effectiveTurnId = String(turn?.id || turnId || '');
  if (effectiveTurnId) turnLogContexts.set(effectiveTurnId, context);
  testLog('ok', scope, 'Prompt accepted by the bridge', { turnId: effectiveTurnId, status: turn?.status || 'queued', elapsedMs: Date.now() - startedAt });
  return turn;
}

async function sendSynchronousMessage(options, pathname, body, {
  scope = 'prompt',
  label = 'prompt',
} = {}) {
  const startedAt = Date.now();
  const prompt = String(body?.message || body?.prompt || '');
  testLog('action', scope, 'Submitting synchronous prompt', {
    label,
    chars: prompt.length,
    effort: body?.effort || '(unchanged)',
    model: body?.model || '(unchanged)',
    output: outputExpectation(body?.output),
  });
  testLog('wait', scope, 'Waiting for prompt submission, generation, and terminal bridge response', { label });
  const requestBody = withDomCaptureMetadata(body, options.captureDomFixtures);
  const response = await api(options, pathname, { method: 'POST', timeoutMs: options.promptTimeoutMs, body: requestBody });
  if (options.domFixtureCapture?.enabled && response?.requestId) {
    const canonicalPromise = api(options, `/diagnostics/request-state?requestId=${encodeURIComponent(response.requestId)}`).then((value) => value.requests).catch(() => null);
    let events = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      events = await api(options, `/turns/${encodeURIComponent(response.requestId)}/events?limit=5000`).then((value) => value.events || []).catch(() => []);
      if (events.some((event) => event?.type === 'assistant.dom.snapshot')) break;
      if (attempt < 4) await sleep(100);
    }
    const canonical = await canonicalPromise;
    await options.domFixtureCapture.capture({ scope, requestId: response.requestId, response, events, canonical }).catch((error) => {
      testLog('warn', scope, 'Could not persist synchronous DOM fixture capture', { requestId: response.requestId, message: error.message });
    });
  }
  const artifacts = artifactsFromResponse(response);
  const answer = String(response?.answer || response?.response || '');
  testLog('ok', scope, 'Synchronous prompt completed', {
    label,
    requestId: response?.requestId || '',
    elapsedMs: Date.now() - startedAt,
    answerChars: answer.length,
    artifacts: artifacts.length,
  });
  return response;
}
async function waitTurn(options, turnId, hooks = {}) {
  const startedAt = Date.now();
  const context = turnLogContexts.get(turnId) || {};
  const scope = hooks.scope || context.scope || 'turn';
  let lastProgressAt = startedAt;
  let lastSignature = '';
  let lastStage = '';
  let lastPhase = '';
  let lastStatus = '';
  let lastEventType = '';
  let lastAnswerLength = -1;
  let lastThinkingLength = -1;
  let lastArtifactCount = -1;
  let lastLogAt = startedAt;

  testLog('wait', scope, 'Waiting for prompt completion', {
    turnId,
    label: context.label || '',
    output: context.expectedOutput || '',
    idleTimeoutMs: options.resultIdleTimeoutMs,
  });

  while (true) {
    const [snapshot, eventsResult, health, requestStateResult] = await Promise.all([
      api(options, `/turns/${encodeURIComponent(turnId)}`),
      api(options, `/turns/${encodeURIComponent(turnId)}/events?limit=5000`),
      api(options, '/health'),
      api(options, `/diagnostics/request-state?requestId=${encodeURIComponent(turnId)}`).catch(() => null),
    ]);
    const events = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    const active = (health.activeRequests || []).find((item) => item.requestId === turnId) || null;
    const canonical = requestStateResult?.requests || null;
    const waitState = turnWaitState({ canonical, events, active });
    const status = String(snapshot.turn?.status || 'unknown');
    const phase = String(waitState.phase || active?.phase || 'unknown');
    const latestEvent = events.at?.(-1) || events[events.length - 1] || {};
    const latestEventType = String(latestEvent.type || '');
    const answerLength = Number(active?.answerLength || 0);
    const thinkingLength = Number(active?.thinkingLength || 0);
    const artifactCount = Number(active?.artifactCount || artifactsFromTurn(snapshot).length || 0);

    if (typeof hooks.onPoll === 'function') await hooks.onPoll({ snapshot, events, active, canonical, waitState, terminal: TERMINAL_TURN_STATUSES.has(status) });

    if (status !== lastStatus || waitState.stage !== lastStage || phase !== lastPhase) {
      testLog('state', scope, 'Turn state changed', {
        turnId,
        status,
        stage: waitState.stage,
        phase,
        generationActive: waitState.generationActive,
        stateSource: waitState.source,
        stateRevision: waitState.revision,
        latestEvent: latestEventType,
        answerChars: answerLength,
        reasoningChars: thinkingLength,
        artifacts: artifactCount,
      });
      lastStatus = status;
      lastStage = waitState.stage;
      lastPhase = phase;
    } else if (latestEventType && latestEventType !== lastEventType) {
      testLog('state', scope, 'Observed new turn event', { turnId, event: latestEventType, phase });
    }
    lastEventType = latestEventType;

    if (answerLength !== lastAnswerLength || thinkingLength !== lastThinkingLength || artifactCount !== lastArtifactCount) {
      const changed = lastAnswerLength >= 0 || lastThinkingLength >= 0 || lastArtifactCount >= 0;
      if (changed && (Date.now() - lastLogAt >= 2_000 || artifactCount !== lastArtifactCount)) {
        testLog('state', scope, 'Visible response progress changed', {
          turnId,
          answerChars: answerLength,
          reasoningChars: thinkingLength,
          artifacts: artifactCount,
          phase,
        });
        lastLogAt = Date.now();
      }
      lastAnswerLength = answerLength;
      lastThinkingLength = thinkingLength;
      lastArtifactCount = artifactCount;
    }

    const canonicalFailure = canonicalTerminalFailure(waitState);
    if (canonicalFailure && !TERMINAL_TURN_STATUSES.has(status)) {
      await writeFailedRequestStateTrace(options.reportDir, turnId, canonical, `canonical terminal ${canonicalFailure.code}`).catch(() => {});
      await options.domFixtureCapture?.capture({ scope, requestId: turnId, turnSnapshot: snapshot, events, canonical }).catch(() => {});
      throw new Error(
        `Turn ${turnId} became canonically terminal at revision ${canonicalFailure.revision}: ${canonicalFailure.code}: ${canonicalFailure.message}`
        + `${canonicalFailure.path ? `; transitions=${canonicalFailure.path}` : ''}`,
      );
    }

    if (TERMINAL_TURN_STATUSES.has(status)) {
      testLog(status === 'completed' || status === 'completed_without_artifact' ? 'ok' : 'fail', scope, 'Turn reached a terminal state', {
        turnId,
        status,
        elapsedMs: Date.now() - startedAt,
        answerChars: String((snapshot.items || []).find((item) => item.type === 'agent_message')?.content?.text || '').length,
        artifacts: artifactsFromTurn(snapshot).length,
      });
      await options.domFixtureCapture?.capture({ scope, requestId: turnId, turnSnapshot: snapshot, events, canonical }).catch((error) => {
        testLog('warn', scope, 'Could not persist terminal DOM fixture capture', { turnId, message: error.message });
      });
      turnLogContexts.delete(turnId);
      return snapshot;
    }

    const signature = turnProgressSignature(snapshot, events, active, waitState);
    if (signature !== lastSignature || waitState.stage !== lastStage) {
      lastSignature = signature;
      lastProgressAt = Date.now();
    }
    const now = Date.now();
    if (options.turnMaxTimeoutMs > 0 && now - startedAt >= options.turnMaxTimeoutMs) {
      await writeFailedRequestStateTrace(options.reportDir, turnId, canonical, 'absolute turn timeout').catch(() => {});
      const path = canonicalTransitionPath(waitState);
      throw new Error(
        `Turn ${turnId} exceeded the configured absolute limit of ${options.turnMaxTimeoutMs}ms while status=${status}`
        + `${path ? ` transitions=${path}` : ''}`,
      );
    }
    const idleLimitMs = waitState.stage === 'pipeline'
      ? options.pipelineIdleTimeoutMs
      : options.resultIdleTimeoutMs;
    if (idleLimitMs > 0 && now - lastProgressAt >= idleLimitMs) {
      await writeFailedRequestStateTrace(options.reportDir, turnId, canonical, `${waitState.stage} idle timeout`).catch(() => {});
      const path = canonicalTransitionPath(waitState);
      throw new Error(
        `Turn ${turnId} made no semantic ${waitState.stage === 'pipeline' ? 'post-generation pipeline' : 'result'} progress for ${idleLimitMs}ms while status=${status} phase=${phase} generationActive=${waitState.generationActive}`
        + `${path ? ` transitions=${path}` : ''}`,
      );
    }
    if (now - lastLogAt >= 10_000) {
      testLog('wait', scope, waitState.generationActive ? 'Generation is still active; continuing to wait' : 'No terminal result yet; continuing to monitor the pipeline', {
        turnId,
        status,
        stage: waitState.stage,
        phase,
        elapsedMs: now - startedAt,
        idleMs: now - lastProgressAt,
        idleLimitMs,
        absoluteRemainingMs: options.turnMaxTimeoutMs > 0 ? Math.max(0, options.turnMaxTimeoutMs - (now - startedAt)) : null,
        latestEvent: latestEventType,
      });
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

function scenarioDiagnosticDir(options, scenarioId) {
  const basename = path.basename(path.resolve(options.reportDir));
  return options.scenarioIds.length === 1 && basename === scenarioId
    ? options.reportDir
    : path.join(options.reportDir, scenarioId);
}

const {
  createPassiveWorkflowFixture,
  createWorkflowGroupContext,
  loadPassiveWorkflow,
  passiveWorkflowArtifactPrompt,
  submitPassiveWorkflowPrompt,
  synchronizeWorkflowGroupContext,
  waitForWorkflowEvent,
  writeWorkflowDiagnostics,
} = createWorkflowE2eRuntime({
  api,
  assert,
  buildPassivePromptBody,
  findWorkflowWaitOutcome,
  nowIso,
  scenarioDiagnosticDir,
  sleep,
  testLog,
  workflowEventKey,
  workflowProgressFromEvents,
});

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
  testLog('search', 'artifact', 'Looking for the concrete browser-download cleanup audit', { artifactId });
  testLog('wait', 'artifact', 'Waiting for download completion and safe source cleanup metadata', { artifactId, timeoutMs: 3_000 });
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

  testLog('state', 'artifact', 'Artifact cleanup audit received', {
    artifactId,
    source: audit.source,
    cleanupRequired: audit.cleanupRequired,
    status: audit.status,
    path: audit.path,
    downloadId: audit.downloadId,
  });
  if (audit.status === 'removed' && audit.path) {
    testLog('search', 'artifact', 'Verifying the exact captured download path is absent', { artifactId, path: audit.path });
    let stillExists = false;
    try { await fs.lstat(audit.path); stillExists = true; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    audit.pathAbsent = !stillExists;
    assert(!stillExists, `Browser download cleanup reported success, but the captured file still exists: ${audit.path}`);
    testLog('ok', 'artifact', 'Captured source file is absent after cleanup', { artifactId, path: audit.path });
  }
  if (Array.isArray(options.downloadCleanupAudits)) options.downloadCleanupAudits.push(audit);
  assert(audit.status !== 'skipped', `Browser download cleanup was safely skipped for ${artifactId}: ${audit.reason || 'unknown safety check failure'} (${audit.path || 'path unavailable'}). The file was left untouched.`);
  return audit;
}

async function downloadArtifact(options, artifact) {
  assert(artifact?.id, 'Artifact has no id');
  const name = artifact.name || artifact.fileName || artifact.id;
  const started = Date.now();
  testLog('action', 'artifact', 'Downloading the selected artifact', { artifactId: artifact.id, name, timeoutMs: options.artifactTimeoutMs });
  testLog('wait', 'artifact', 'Waiting for artifact materialization and byte transfer', { artifactId: artifact.id, name });
  const bytes = await api(options, `/artifacts/${encodeURIComponent(artifact.id)}/download`, { binary: true, timeoutMs: options.artifactTimeoutMs });
  testLog('state', 'artifact', 'Artifact bytes received; validating source cleanup', { artifactId: artifact.id, name, bytes: bytes.length, elapsedMs: Date.now() - started });
  const cleanupAudit = await auditArtifactSourceCleanup(options, artifact.id);
  testLog('ok', 'artifact', 'Artifact download completed', { artifactId: artifact.id, name, bytes: bytes.length, elapsedMs: Date.now() - started, sourceCleanup: cleanupAudit.status });
  return bytes;
}
function artifactsFromResponse(response) { return Array.isArray(response?.artifacts) ? response.artifacts : []; }
function artifactsFromTurn(snapshot) { return artifactsFromTurnSnapshot(snapshot); }
function selectArtifactCandidate(artifacts = [], {
  scope = 'artifact',
  purpose = 'artifact',
  predicate = null,
} = {}) {
  const candidates = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
  testLog('search', scope, `Looking for ${purpose} in the scoped assistant result`, {
    found: candidates.length,
    names: candidates.map((item) => item.name || item.fileName || item.id).join(' | ') || '(none)',
  });
  const selected = typeof predicate === 'function'
    ? candidates.find(predicate) || null
    : candidates[0] || null;
  if (selected) {
    testLog('ok', scope, `${purpose} selected`, { artifactId: selected.id, name: selected.name || selected.fileName || selected.id, candidates: candidates.length });
  } else {
    testLog('fail', scope, `${purpose} was not found`, { candidates: candidates.length });
  }
  return selected;
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
      testLog('step', 'cleanup', 'Deleting the owned ChatGPT conversation', { sessionId, attempt, maxAttempts });
      testLog('wait', 'cleanup', 'Waiting for the exact owned conversation page to be ready', { sessionUrl, sourceClientId });
      await waitUntil(async () => {
        const snapshot = await clientSnapshot(options);
        const client = snapshot.clients?.find((item) => item.id === sourceClientId);
        const current = canonicalConversation(client?.url || client?.session?.url || '');
        if (current?.id !== sessionId || current.url !== sessionUrl) {
          throw new Error(`Cleanup refused: expected ${sessionUrl}, current ${client?.url || '(missing)'}`);
        }
        return client.pageReady && client.chatMainReady ? client : null;
      }, { timeoutMs: 15_000, intervalMs: 250, message: `cleanup page readiness for ${sessionUrl}` });
      testLog('action', 'cleanup', 'Requesting exact URL-bound conversation deletion', { sessionId, expectedUrl: sessionUrl });
      const deleted = await api(options, '/sessions/delete', {
        method: 'POST',
        timeoutMs: 45_000,
        body: { sessionId, expectedUrl: sessionUrl, sourceClientId, timeoutMs: 30_000 },
      });
      attempts.push({ attempt, ok: true, deletedSessionId: deleted.deletedSessionId || '' });
      testLog('ok', 'cleanup', 'Owned ChatGPT conversation deleted', { sessionId: deleted.deletedSessionId || sessionId, attempt });
      return { deleted, attempts };
    } catch (err) {
      attempts.push({ attempt, ok: false, error: err.message });
      const leaseConflict = /Browser lease belongs to another request or server instance/i.test(err.message || '');
      const retryable = leaseConflict || /could not find the delete action|confirmation dialog did not appear|cleanup page readiness/i.test(err.message || '');
      if (!retryable || attempt >= maxAttempts) {
        err.cleanupAttempts = attempts;
        throw err;
      }
      if (leaseConflict) {
        testLog('warn', 'cleanup', 'Conversation deletion encountered an active lease; settling canonical browser work before retry', {
          sessionId,
          attempt,
        });
        await quiesceBrowserWork({
          options,
          api,
          waitUntil,
          reason: `settle E2E browser work before deleting ${sessionId}`,
          sourceClientId,
          testLog,
        });
      }
      const delayMs = Math.min(4_000, 500 * (2 ** (attempt - 1)));
      testLog('retry', 'cleanup', 'Cleanup UI was not ready; retrying the exact URL-bound deletion', { attempt, maxAttempts, delayMs, message: err.message });
      await sleep(delayMs);
    }
  }
  throw new Error('Session deletion retry loop exited unexpectedly');
}
async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.listScenarios) { console.log(formatScenarioList()); return; }
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  await resolveBridgeRuntime(options, runId, { publicBaseUrl: config.publicBaseUrl, dataDir: config.dataDir });
  consoleLogPath = await initializeDiagnostics(options, runId, nowIso());
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
    verbose: options.verbose,
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
    workflowWaitTimeoutMs: options.workflowWaitTimeoutMs,
    turnMaxTimeoutMs: options.turnMaxTimeoutMs,
    artifactTimeoutMs: options.artifactTimeoutMs,
    captureDomFixtures: options.captureDomFixtures,
    fixtureOutputDir: options.fixtureOutputDir || '',
    capturePageLayout: options.capturePageLayout,
    mockChatGpt: options.mockChatGpt,
    status: 'running',
    scenarios: [],
    downloadCleanupAudits: [],
    cleanup: null,
  };
  options.downloadCleanupAudits = report.downloadCleanupAudits;
  options.domFixtureCapture = createDomFixtureCapture({
    enabled: options.captureDomFixtures,
    outputDir: options.fixtureOutputDir,
    runId,
    marker,
    log: testLog,
  });
  const timeline = []; const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `bridge-real-e2e-${runId}-`));
  let ownedServer = null; let mockChatGptRuntime = null; let testClient = null; let launchToken = ''; let sessionId = ''; let sessionUrl = ''; let previousSelectedClientId = ''; let primaryError = null; let liveDebugTrace = null; let pageLayoutCapture = null;
  activeInterruptedRun = { options, report, timeline, interruption, get ownedServer() { return ownedServer; } };
  const effortState = { expectedUiEffort: '' };
  const scenarioFailures = []; const effortFor = (scope, desired, reason) => {
    const normalized = String(desired || '').trim().toLowerCase();
    if (!normalized) return '';
    if (effortState.expectedUiEffort === normalized) {
      testLog('state', scope, 'Requested effort is already expected to be active; no picker interaction is needed', { effort: normalized, reason });
      return '';
    }
    testLog('state', scope, 'This prompt will switch the ChatGPT effort before submission', { from: effortState.expectedUiEffort || '(unknown)', to: normalized, reason });
    effortState.expectedUiEffort = normalized;
    return normalized;
  };
  let workflowSharedContextPromise = null;
  const ensureWorkflowSharedContext = () => {
    if (!workflowSharedContextPromise) {
      workflowSharedContextPromise = (async () => {
        buildPassivePromptBody({ message: 'workflow-preflight', sessionId, sourceClientId: testClient.id, effort: '' });
        testLog('ok', 'workflow-context', 'Passive browser prompt request builder passed preflight validation', { explicitEffort: true });
        const shared = await createWorkflowGroupContext(workDir, { runId, marker });
        const synced = await synchronizeWorkflowGroupContext(options, shared, {
          runId,
          sessionId,
          sourceClientId: testClient.id,
          scope: 'workflow-context',
        });
        report.workflowPreflight = {
          projectId: synced.identity.projectId,
          packageName: synced.packageName,
          contextSyncCompleted: true,
          eventTypes: synced.events.map((event) => event.type),
          passivePromptHelperValidated: true,
        };
        await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
        return synced;
      })();
    }
    return workflowSharedContextPromise;
  };
  const logEvent = (type, data = {}) => timeline.push({ at: nowIso(), type, ...data });
  await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
  pageLayoutCapture = createPageLayoutCapture({
    enabled: options.capturePageLayout,
    reportDir: options.reportDir,
    options,
    api,
    getClient: () => testClient,
    report,
    testLog,
  });
  const scenarioRuntime = createScenarioRunner({
    options,
    report,
    scenarioFailures,
    definitionFor: scenarioDefinition,
    getClient: () => testClient,
    getLaunchToken: () => launchToken,
    clientSnapshot,
    api,
    waitUntil,
    testLog,
    logEvent,
    checkpoint: () => writeDiagnosticCheckpoint(options.reportDir, report, timeline),
    checkpointWarning: (id, error) => step(`Warning: could not write diagnostic checkpoint after ${id}: ${error.message}`),
    capturePageLayout: (...args) => pageLayoutCapture.capture(...args),
  });
  const scenario = scenarioRuntime.run;
  try {
    const buildCoreScenarioContext = createCoreScenarioContextFactory({
      scenario, options, marker, workDir, runId, effortState, effortFor,
      FAST_EFFORT, DEFAULT_REASONING_EFFORT, REASONING_PROGRESS_PERCENTAGES,
      assert, testLog, step, logEvent, api, waitUntil, nowIso, sha256, normalizeAnswer,
      sendSynchronousMessage, createThread, startTurn, waitTurn, turnEvents, eventTypes, eventData,
      scenarioDiagnosticDir, createParserObservationWriter, firstDifference, logicalProgressId, mergeObservedProgress, progressRevisionTimeline, reasoningSnapshotsFromEvents,
      reasoningTestPrompt, extractReasoningProgressPercentages, validateReasoningFinalAnswer, validatePublicReasoningStream,
      openPublicTurnEventStream,
      readIntelligenceSnapshot, intelligenceSnapshotFromApplied, explicitSelectionCases, alternativeSelectionOption,
      optionLabel, selectionOptionMatches, waitForSteerWindow,
      artifactsFromResponse, artifactsFromTurn, selectArtifactCandidate, downloadArtifact, inspectZipBuffer,
      isZipArtifactCandidate,
      fs, path,
    });
    ownedServer = await startBridgeIfNeeded(options, { deferConsoleOutput: true });
    mockChatGptRuntime = await startMockChatGptRuntime({ enabled: options.mockChatGpt, bridgeUrl: options.baseUrl, bridgeToken: options.bridgeToken || config.bridgeToken || '', report, testLog });
    const before = await clientSnapshot(options); previousSelectedClientId = String(before.selectedClientId || '');
    const opened = await prepareIsolatedE2eTab(options, { api, waitUntil, testLog, step, runId });
    ownedServer?.releaseConsoleOutput?.();
    liveDebugTrace = await startLiveDebugTrace(options, testLog);
    report.extensionStartupReload = opened.extensionStartupReload;
    launchToken = opened.launchToken; testClient = { ...opened.client, launchToken: opened.client?.launchToken || launchToken };
    assert(testClient?.id, 'Isolated tab has no bridge client id');
    assert(testClient.capabilities?.sessionDeletion === true && testClient.capabilities?.browserTabs === true, 'Reload the extension packaged with this bridge');
    assert(testClient.capabilities?.promptSteering === true, 'Extension does not advertise promptSteering; reload extension 0.3.8+');
    await pageLayoutCapture.capture('startup-ready', { phase: 'startup' });
    logEvent('tab.opened', { clientId: testClient.id, openedBy: opened.openedBy, launchToken, bootstrapClientId: opened.bootstrapClientId || '', targetUrl: opened.targetUrl || '' });
    step('Bootstrapping an owned ChatGPT conversation for the selected scenarios');
    const bootstrapExpected = `BOOTSTRAP_${marker}`;
    const bootstrapPrompt = `This is setup for an isolated real integration test. Keep marker ${marker} only in this conversation. Do not add it to ChatGPT account-wide memory and do not modify saved memories. In this response, output exactly ${bootstrapExpected}.`;
    const bootstrap = await sendSynchronousMessage(options, '/chat', {
      message: bootstrapPrompt,
      sourceClientId: testClient.id,
      effort: effortFor('bootstrap', FAST_EFFORT, 'bootstrap does not require visible reasoning'),
    }, { scope: 'bootstrap', label: 'owned-session bootstrap' });
    assert(normalizeAnswer(bootstrap.answer || bootstrap.response) === bootstrapExpected, `Unexpected bootstrap answer: ${bootstrap.answer || bootstrap.response}`);
    const conversation = canonicalConversation(bootstrap.session?.url || bootstrap.url || '');
    assert(conversation?.id && bootstrap.session?.id === conversation.id, 'Concrete bootstrap conversation URL/session mismatch');
    sessionId = conversation.id;
    sessionUrl = conversation.url;
    report.bootstrap = { requestId: bootstrap.requestId || '', expected: bootstrapExpected, sessionId, sessionUrl };
    logEvent('session.bootstrapped', report.bootstrap);
    await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
    await runCoreScenarios(buildCoreScenarioContext({ sessionId, sessionUrl, testClient }));
    await runWorkflowProjectScenarios({
      scenario, options, workDir, runId, marker, sessionId, testClient, effortFor, FAST_EFFORT,
      ensureWorkflowSharedContext, createPassiveWorkflowFixture, loadPassiveWorkflow, passiveWorkflowArtifactPrompt,
      submitPassiveWorkflowPrompt, waitForWorkflowEvent, writeWorkflowDiagnostics,
      api, assert, eventTypes, logEvent, testLog, createThread, startTurn, waitTurn, turnEvents,
      artifactsFromTurn, selectArtifactCandidate, downloadArtifact, inspectZipBuffer, sha256,
      isZipArtifactCandidate,
      fs, path,
    });
    report.status = report.scenarios.some((item) => ['failed', 'blocked'].includes(item.status)) ? 'failed' : report.scenarios.some((item) => item.status === 'inconclusive') ? 'passed_with_inconclusive' : 'passed';
    if (scenarioFailures.length) {
      const summary = scenarioFailures.map((failure) => `${failure.id}: ${failure.error.message}`).join('; ');
      const aggregate = new Error(`${scenarioFailures.length} E2E scenario(s) failed: ${summary}`);
      aggregate.name = 'E2EScenarioAggregateError';
      aggregate.failures = scenarioFailures.map((failure) => ({ id: failure.id, name: failure.name, message: failure.error.message, stack: failure.error.stack }));
      throw aggregate;
    }
  } catch (err) {
    ownedServer?.releaseConsoleOutput?.();
    if (isE2eInterruption(err) || interruption.requested) {
      markReportInterrupted(report, timeline, interruption.signalName || err.signal || 'SIGINT', interruption.requestedAt || nowIso());
      step(`Interrupted: ${interruption.signalName || err.signal || 'signal'}`);
    } else {
      primaryError = err;
      report.status = 'failed';
      report.error = { message: err.message, stack: err.stack };
      step(`FAILED: ${err.message}`);
      writeConsoleLine(`${nowIso()} [e2e] ${err.stack || err.message}`);
    }
  } finally {
    cleanupMode = true;
    if (interruption.requested) {
      report.interruptedWorkCleanup = await stopInterruptedBridgeWork({
        options, api, sleep, signalName: interruption.signalName || 'signal',
      });
      testLog(report.interruptedWorkCleanup.settled ? 'ok' : 'warn', 'runner', 'Interrupted bridge work cleanup completed', report.interruptedWorkCleanup);
    }
    try {
      report.bridgeEvents = (await api(options, '/events?limit=5000')).events || [];
      report.debugEvents = (await api(options, '/debug/events?limit=5000')).events || [];
    } catch (err) { report.diagnosticsCollectionError = err.message; }
    if (testClient?.id) await pageLayoutCapture?.capture('run-final', { phase: 'final', status: report.status, requestId: testClient.activeRequest?.requestId || '' });
    if (testClient?.id && !options.keepSession) {
      try {
        if (sessionId && sessionUrl) {
          const identity = browserOwnershipIdentity(testClient, launchToken);
          const currentSnapshot = await clientSnapshot(options);
          const currentClient = findOwnedBrowserClient(currentSnapshot.clients, identity);
          const infrastructureFailure = scenarioRuntime.infrastructureGate.current();
          if (!currentClient && infrastructureFailure) {
            report.cleanup = {
              skipped: true,
              reason: 'owned browser client unavailable after infrastructure failure',
              blockedBy: infrastructureFailure.scenarioId,
              sessionId,
              sessionUrl,
              clientId: testClient.id,
            };
          } else {
            assert(currentClient, `Cleanup could not find the owned browser client for ${sessionUrl}`);
            Object.assign(testClient, currentClient);
            const currentConversation = canonicalConversation(currentClient.url || currentClient.session?.url || '');
            assert(currentConversation?.id === sessionId && currentConversation.url === sessionUrl, `Cleanup refused: expected ${sessionUrl}, current ${currentClient.url || '(missing)'}`);
            const deletion = await deleteOwnedSessionWithRetry(options, { sessionId, sessionUrl, sourceClientId: currentClient.id });
            const deleted = deletion.deleted;
            assert(deleted.deleted === true && deleted.deletedSessionId === sessionId, 'Deletion did not confirm expected session');
            await api(options, '/browser/tabs/close', { method: 'POST', timeoutMs: 15_000, body: { sourceClientId: currentClient.id, expectedLaunchToken: launchToken, expectedUrl: deleted.afterUrl, timeoutMs: 10_000 } });
            report.cleanup = { deleted: true, sessionId, beforeUrl: deleted.beforeUrl, afterUrl: deleted.afterUrl, tabClosed: true, attempts: deletion.attempts };
          }
        }
      } catch (cleanupError) {
        report.cleanup = { failed: true, error: cleanupError.message, attempts: cleanupError.cleanupAttempts || [], sessionId, sessionUrl, clientId: testClient.id };
        if (!interruption.requested) {
          report.status = 'failed';
          if (!report.error) report.error = { message: cleanupError.message, stack: cleanupError.stack };
          if (!primaryError) primaryError = cleanupError;
        }
      }
    } else if (testClient?.id) report.cleanup = { skipped: true, reason: '--keep-session', sessionId, sessionUrl, clientId: testClient.id };
    try {
      const snapshot = await clientSnapshot(options);
      if (previousSelectedClientId && snapshot.clients?.some((client) => client.id === previousSelectedClientId && usableClient(client))) await api(options, '/browser/select', { method: 'POST', body: { clientId: previousSelectedClientId } });
      else await api(options, '/browser/select', { method: 'DELETE' });
    } catch {}
    try {
      report.finalDownloadCleanupVerification = await verifyRemovedDownloadSourcesRemainAbsent(report.downloadCleanupAudits);
    } catch (cleanupVerificationError) {
      report.downloadCleanupVerificationError = cleanupVerificationError.message;
      if (!interruption.requested) {
        report.status = 'failed';
        if (!report.error) report.error = { message: cleanupVerificationError.message, stack: cleanupVerificationError.stack };
        if (!primaryError) primaryError = cleanupVerificationError;
      }
    }
    report.sessionId = sessionId;
    report.sessionUrl = sessionUrl;
    report.finishedAt = nowIso();
    report.failureSummary = collectE2eIssues({ report, scenarioFailures, primaryError });
    try {
      const outputs = await writeFinalDiagnostics({ reportDir: options.reportDir, report, timeline, consoleLogPath, writeZip });
      step(`Report: ${outputs.jsonPath}`);
      const ratio = outputs.bundle?.uncompressedSize ? Math.round((outputs.verified[outputs.bundlePath] / outputs.bundle.uncompressedSize) * 100) : 100;
      step(`Diagnostic bundle: ${outputs.bundlePath} (${outputs.verified[outputs.bundlePath]} bytes, ${ratio}% of raw payload)`);
    } catch (diagnosticsError) {
      report.diagnosticsWriteError = diagnosticsError.message;
      report.failureSummary = collectE2eIssues({ report, scenarioFailures, primaryError: primaryError || diagnosticsError });
      step(`FAILED to finalize diagnostics: ${diagnosticsError.message}`);
      try {
        await fs.mkdir(options.reportDir, { recursive: true });
        await fs.writeFile(path.join(options.reportDir, 'DIAGNOSTICS_WRITE_ERROR.txt'), `${diagnosticsError.stack || diagnosticsError.message}\n`);
        await writeDiagnosticCheckpoint(options.reportDir, report, timeline);
      } catch {}
      if (!interruption.requested) {
        report.status = 'failed';
        if (!report.error) report.error = { message: diagnosticsError.message, stack: diagnosticsError.stack };
        if (!primaryError) primaryError = diagnosticsError;
      }
    } finally {
      if (liveDebugTrace) await liveDebugTrace.stop().catch(() => {});
      await stopMockChatGptRuntime(mockChatGptRuntime);
      if (ownedServer) {
        ownedServer.kill('SIGTERM');
        await Promise.race([new Promise((resolve) => ownedServer.once('exit', resolve)), sleep(5_000, { ignoreAbort: true })]);
      }
      if (ownedServer) await fs.rm(options.serverDataDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      report.failureSummary = collectE2eIssues({ report, scenarioFailures, primaryError });
      writeE2eIssueSummary(report.failureSummary, { writeLine: (output) => writeConsoleLine(`${nowIso()} ${output}`) });
    }
  }
  activeInterruptedRun = null;
  cleanupMode = false;
  if (interruption.requested || forcedInterruption) { process.exitCode = interruption.signalName === 'SIGTERM' ? 143 : 130; return; }
  if (primaryError) { primaryError.e2eSummaryPrinted = true; throw primaryError; }
}
process.on('SIGTERM', () => requestInterruption('SIGTERM'));
process.on('SIGINT', () => requestInterruption('SIGINT'));
run().catch((err) => {
  if (!err?.e2eSummaryPrinted) { const text = `FAILED [e2e] ${err.stack || err.message || String(err)}`; console.error(text); writeConsoleLine(`${nowIso()} ${text}`); }
  process.exitCode = 1;
});
