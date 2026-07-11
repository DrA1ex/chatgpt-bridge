import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../httpError.js';

function bridgeForLocal(req) {
  return req.app.locals.bridge || null;
}

function isTerminalTurnStatus(status = '') {
  return ['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(String(status || ''));
}

function normalizeSelectedResult(value = null) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    turnId: String(value.turnId || ''),
    projectId: String(value.projectId || ''),
    projectRoot: String(value.projectRoot || ''),
    sessionId: String(value.sessionId || ''),
    sourceClientId: String(value.sourceClientId || ''),
    sourceTurnKey: String(value.sourceTurnKey || ''),
    sourceRequestId: String(value.sourceRequestId || ''),
    artifactId: String(value.artifactId || ''),
    fileId: String(value.fileId || ''),
    downloadId: String(value.downloadId || ''),
    name: String(value.name || ''),
    mime: String(value.mime || ''),
    size: Number(value.size) || 0,
    sha256: String(value.sha256 || ''),
    outputType: String(value.outputType || value.type || ''),
    outputStatus: String(value.outputStatus || value.status || ''),
    confidence: String(value.confidence || ''),
    source: String(value.source || ''),
    selectedAt: String(value.selectedAt || ''),
    stale: Boolean(value.stale),
    staleReason: String(value.staleReason || ''),
    replacedByTurnId: String(value.replacedByTurnId || ''),
  };
  return result.turnId || result.fileId || result.artifactId ? result : null;
}

function summarizeTimeline(requestId = '', events = []) {
  const types = new Set(events.map((event) => event.type));
  const last = events[events.length - 1] || null;
  const artifactDownloaded = [...events].reverse().find((event) => ['artifact.downloaded', 'artifact.download.done'].includes(event.type));
  const validationStarted = [...events].reverse().find((event) => event.type === 'result.validation.started');
  const validationPassed = [...events].reverse().find((event) => event.type === 'result.validated');
  const validationFailed = [...events].reverse().find((event) => event.type === 'result.validation_failed');
  const applySkipped = [...events].reverse().find((event) => event.type === 'apply/skipped');
  const applyDone = [...events].reverse().find((event) => event.type === 'apply/done');
  const result = {
    requestId,
    eventCount: events.length,
    lastType: last?.type || '',
    lastTime: last?.time || '',
    phase: '',
    doneReceived: types.has('request.done'),
    resultResolvingStarted: types.has('result/resolving') || types.has('result.validating'),
    resultReady: types.has('result.ready'),
    artifactDownloadStarted: types.has('artifact.download.started') || types.has('artifact.downloading'),
    artifactDownloadDone: types.has('artifact.download.done') || types.has('artifact.downloaded'),
    artifactDownloaded: artifactDownloaded ? { name: artifactDownloaded.data?.name || '', size: artifactDownloaded.data?.size || 0, fileId: artifactDownloaded.data?.fileId || '', artifactId: artifactDownloaded.data?.artifactId || '' } : null,
    validation: validationFailed ? { status: 'failed', message: validationFailed.data?.message || validationFailed.data?.code || '' } : (validationPassed ? { status: 'passed', entries: validationPassed.data?.entries || 0, totalUncompressedSize: validationPassed.data?.totalUncompressedSize || 0, name: validationPassed.data?.name || '' } : (validationStarted ? { status: 'started', name: validationStarted.data?.name || '' } : null)),
    applySeen: Array.from(types).some((type) => String(type).startsWith('apply.') || String(type).startsWith('apply/')),
    apply: applyDone ? { status: 'done', created: applyDone.data?.created || 0, updated: applyDone.data?.updated || 0, deleted: applyDone.data?.deleted || 0, skipped: applyDone.data?.skipped || 0 } : (applySkipped ? { status: 'skipped', reason: applySkipped.data?.reason || '', safe: applySkipped.data?.safe, requiresConfirmation: applySkipped.data?.requiresConfirmation, warnings: applySkipped.data?.warnings || [] } : null),
    warning: '',
    statusText: '',
  };
  const lastProgress = [...events].reverse().find((event) => event.type === 'request.progress');
  result.phase = lastProgress?.data?.phase || '';
  if (result.doneReceived && !result.resultResolvingStarted && !types.has('turn/completed') && !types.has('turn/completed_without_artifact')) {
    result.warning = 'request.done was received, but result resolving did not start in the captured timeline';
  } else if (types.has('result/resolving') && !result.resultReady && !types.has('result/missing_required_artifact')) {
    result.warning = 'result resolving started, but no result.ready or missing-artifact event is visible';
  } else if (result.resultReady && !result.applySeen) {
    result.warning = 'result is ready; apply planning was not observed in this timeline';
  } else if (!events.length) {
    result.warning = 'no compact timeline events captured for this request';
  }
  if (result.apply?.status === 'done') {
    result.statusText = `Applied: +${result.apply.created} ~${result.apply.updated} -${result.apply.deleted}`;
  } else if (result.apply?.status === 'skipped') {
    result.statusText = `Not applied automatically: ${result.apply.reason || 'requires confirmation'}`;
  } else if (result.validation?.status === 'failed') {
    result.statusText = `ZIP validation failed: ${result.validation.message || 'unknown error'}`;
  } else if (result.resultReady) {
    result.statusText = 'Result is ready but apply decision was not observed';
  } else if (result.artifactDownloadDone && result.validation?.status === 'passed') {
    result.statusText = 'Artifact downloaded and ZIP validation passed';
  } else if (result.artifactDownloadDone) {
    result.statusText = 'Artifact downloaded; waiting for ZIP validation/result';
  } else if (result.artifactDownloadStarted) {
    result.statusText = 'Artifact download started';
  } else if (result.resultResolvingStarted) {
    result.statusText = 'Result resolving started';
  }
  return result;
}

async function readInteractiveStateSummary(turnManager = null) {
  const statePath = path.join(config.dataDir, 'interactive-state.json');
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return { available: false, path: statePath };
  }

  const summary = {
    available: true,
    path: statePath,
    updatedAt: raw.updatedAt || '',
    projectRoot: raw.projectRoot || '',
    projectId: raw.projectId || '',
    sessionId: raw.sessionId || '',
    projectThreadId: raw.projectThreadId || '',
    lastTurnId: raw.lastTurnId || '',
    lastAppliedTurnId: raw.lastAppliedTurnId || '',
    lastAppliedFileId: raw.lastAppliedFileId || '',
    lastApplySummary: raw.lastApplySummary || null,
    currentScope: null,
    selectedResult: normalizeSelectedResult(raw.selectedResult),
    recentResponses: Array.isArray(raw.responseHistory) ? raw.responseHistory.slice(0, 5).map((item) => ({
      id: item.id || '',
      turnId: item.turnId || '',
      source: item.source || '',
      chars: item.chars || String(item.text || '').length,
      artifactCount: item.artifactCount || 0,
      createdAt: item.createdAt || '',
    })) : [],
  };

  const projectKey = summary.projectRoot ? `project:${path.resolve(summary.projectRoot)}` : 'global';
  const sessionKey = summary.sessionId ? `session:${summary.sessionId}` : 'session:current-tab';
  const scope = raw.scopes?.[projectKey]?.sessions?.[sessionKey] || null;
  if (scope) {
    summary.currentScope = {
      projectKey,
      sessionKey,
      lastTurnId: scope.lastTurnId || '',
      lastAppliedTurnId: scope.lastAppliedTurnId || '',
      lastAppliedFileId: scope.lastAppliedFileId || '',
      lastApplySummary: scope.lastApplySummary || null,
      selectedResult: normalizeSelectedResult(scope.selectedResult),
      lastProjectSnapshotId: scope.lastProjectScan?.snapshotId || scope.lastProjectPack?.snapshotId || '',
      responseCount: Array.isArray(scope.responseHistory) ? scope.responseHistory.length : 0,
    };
  }
  if (scope?.selectedResult) summary.selectedResult = normalizeSelectedResult(scope.selectedResult);

  if (turnManager && summary.lastTurnId && !summary.selectedResult) {
    const turn = await turnManager.getTurn(summary.lastTurnId).catch(() => null);
    if (turn) {
      summary.selectedResult = {
        turnId: turn.id,
        status: turn.status,
        completedAt: turn.completedAt || '',
        outputType: turn.output?.type || '',
        outputStatus: turn.output?.status || '',
        fileId: turn.output?.fileId || '',
        artifactId: turn.output?.artifactId || '',
        name: turn.output?.name || '',
        sourceClientId: turn.output?.sourceClientId || '',
        sourceTurnKey: turn.output?.sourceTurnKey || '',
        sourceRequestId: turn.output?.sourceRequestId || turn.output?.requestId || turn.id,
        stale: !isTerminalTurnStatus(turn.status) || (turn.output?.type !== 'zip' && !turn.output?.fileId),
      };
    }
  }

  return summary;
}

export async function diagnosticsJsonFromRequest(req, eventBus, turnManager = null) {
  const bridge = bridgeForLocal(req);
  if (!bridge) throw new HttpError(503, 'Bridge is not configured');
  const health = bridge.health();
  const activeRequests = typeof bridge.requestDiagnostics === 'function' ? bridge.requestDiagnostics() : (health.activeRequests || []);
  const compactTimelines = eventBus?.recentRequestTimelines ? eventBus.recentRequestTimelines({ limitPerRequest: 120, maxRequests: 30 }) : [];
  const timelineSummaries = compactTimelines.map((item) => summarizeTimeline(item.requestId, item.events));
  const interactiveState = await readInteractiveStateSummary(turnManager);
  const recentTurns = turnManager ? await turnManager.listTurns({ limit: 12 }).catch(() => []) : [];
  return {
    ok: true,
    apiTokenConfigured: Boolean(config.apiToken),
    health,
    clients: health.clients || [],
    activeClient: health.activeClient || null,
    selectedClientId: health.selectedClientId || '',
    activeRequests,
    compactTimelines,
    timelineSummaries,
    interactiveState,
    recentTurns: recentTurns.map((turn) => ({
      id: turn.id,
      threadId: turn.threadId,
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      completedAt: turn.completedAt || '',
      outputType: turn.output?.type || '',
      outputStatus: turn.output?.status || '',
      fileId: turn.output?.fileId || '',
      artifactId: turn.output?.artifactId || '',
      sourceClientId: turn.output?.sourceClientId || '',
      sourceTurnKey: turn.output?.sourceTurnKey || '',
    })),
    recentEvents: eventBus ? eventBus.recentEvents(200) : [],
    recentDebugEvents: eventBus ? eventBus.recentDebugEvents(200) : bridge.debugEvents(),
  };
}

export function localDiagnosticsEventsFromRequest(req, eventBus, bridge, channel = 'event') {
  const limit = Number.parseInt(String(req.query.limit || '100'), 10);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
  if (channel === 'debug') {
    return { ok: true, events: eventBus ? eventBus.recentDebugEvents(safeLimit) : bridge.debugEvents() };
  }
  return { ok: true, events: eventBus ? eventBus.recentEvents(safeLimit) : [] };
}


function diagnosticsTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
}

function compactEvent(event = {}) {
  const data = event.data || {};
  return {
    time: event.time || '',
    type: event.type || '',
    requestId: event.requestId || data.requestId || data.turnId || data.jobId || '',
    clientId: event.clientId || data.sourceClientId || data.clientId || '',
    data: {
      phase: data.phase,
      reason: data.reason,
      status: data.status,
      answerLength: data.answerLength,
      thinkingLength: data.thinkingLength,
      progressLength: data.progressLength,
      artifactCount: data.artifactCount,
      artifactId: data.artifactId,
      fileId: data.fileId,
      name: data.name,
      safe: data.safe,
      requiresConfirmation: data.requiresConfirmation,
      created: data.created,
      updated: data.updated,
      deleted: data.deleted,
      skipped: data.skipped,
      createdFiles: data.createdFiles,
      updatedFiles: data.updatedFiles,
      deletedFiles: data.deletedFiles,
      skippedFiles: data.skippedFiles,
      entries: data.entries,
      totalUncompressedSize: data.totalUncompressedSize,
      filesToCreate: data.filesToCreate,
      filesToUpdate: data.filesToUpdate,
      filesToDelete: data.filesToDelete,
      filesUnchanged: data.filesUnchanged,
      filesSkipped: data.filesSkipped,
      filesLocallyChanged: data.filesLocallyChanged,
      filesLocallyChangedDelete: data.filesLocallyChangedDelete,
      warnings: data.warnings,
      selectionReason: data.selectionReason,
      selected: data.selected,
      candidates: Array.isArray(data.candidates) ? data.candidates.slice(0, 8) : undefined,
      artifacts: Array.isArray(data.artifacts) ? data.artifacts.slice(0, 8) : undefined,
      captureSource: data.captureSource,
      message: data.message,
      code: data.code,
    },
  };
}

function makeDiagnosticsBundle(diagnostics = {}, { compact = true } = {}) {
  if (!compact) return diagnostics;
  const meaningfulTypes = /request\.done|normal\.|result|artifact|apply|turn\/completed|missing_required_artifact|assistant\.progress|generation|prompt|user_turn|assistant_turn/i;
  const recentEvents = (diagnostics.recentEvents || []).filter((event) => meaningfulTypes.test(String(event.type || ''))).slice(-160).map(compactEvent);
  const recentDebugEvents = (diagnostics.recentDebugEvents || []).filter((event) => meaningfulTypes.test(String(event.type || ''))).slice(-120).map(compactEvent);
  return {
    ok: diagnostics.ok,
    apiTokenConfigured: diagnostics.apiTokenConfigured,
    health: {
      transport: diagnostics.health?.transport,
      selectedClientId: diagnostics.health?.selectedClientId,
      needsSelection: diagnostics.health?.needsSelection,
      pendingRequests: diagnostics.health?.pendingRequests,
      pendingCommands: diagnostics.health?.pendingCommands,
      artifacts: diagnostics.health?.artifacts,
    },
    clients: (diagnostics.clients || []).map((client) => ({
      id: client.id,
      selected: client.selected,
      ready: client.ready,
      url: client.url,
      title: client.title,
      clientVersion: client.clientVersion || '',
      visibilityState: client.visibilityState,
      focused: client.focused,
      activeRequest: client.activeRequest,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
    })),
    activeRequests: diagnostics.activeRequests || [],
    timelineSummaries: diagnostics.timelineSummaries || [],
    compactTimelines: diagnostics.compactTimelines || [],
    interactiveState: diagnostics.interactiveState || {},
    recentTurns: diagnostics.recentTurns || [],
    recentEvents,
    recentDebugEvents,
  };
}

export function sendDiagnosticsBundle(res, diagnostics, { compact = true } = {}) {
  const capturedAt = new Date().toISOString();
  const payload = { capturedAt, diagnostics: makeDiagnosticsBundle(diagnostics, { compact }) };
  const filename = `bridge-debug-${compact ? 'compact-' : 'full-'}${diagnosticsTimestampForFile(new Date(capturedAt))}.json`;
  const body = JSON.stringify(payload, null, 2);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

export function diagnosticsHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT Bridge Diagnostics</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:24px;line-height:1.45;background:#fafafa;color:#111}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card{background:#fff;border:1px solid #ddd;border-radius:12px;padding:14px;margin:12px 0}
pre{white-space:pre-wrap;background:#101010;color:#d7f7d7;border-radius:10px;padding:12px;max-height:46vh;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.small{max-height:28vh}
button{padding:8px 12px;border:1px solid #ccc;border-radius:8px;background:#f7f7f7;cursor:pointer}.ok{color:#087c3f}.bad{color:#b42318}.warn{color:#9a5a00}.muted{color:#666}.pill{display:inline-block;border:1px solid #ddd;border-radius:999px;padding:2px 8px;margin:2px;background:#f7f7f7;font-size:12px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style></head><body>
<header><div><h1>ChatGPT Bridge diagnostics</h1><div class="muted">Live extension/server events, connected clients, and active request phases. Keep this open while testing project-task workflow.</div></div><div><a href="/setup">Setup</a></div></header>
<div class="card"><strong>Controls</strong><br><button onclick="refreshAll()">Refresh now</button> <button onclick="downloadCompactBundle()">Download compact debug bundle</button> <button onclick="downloadFullBundle()">Download full debug bundle</button> <button onclick="clearLog()">Clear live log</button></div>
<div class="grid"><div class="card"><strong>Server / bridge state</strong><pre id="state" class="small">Loading…</pre></div><div class="card"><strong>Active requests</strong><pre id="requests" class="small">Loading…</pre></div></div>
<div class="grid"><div class="card"><strong>Connected clients</strong><pre id="clients" class="small">Loading…</pre></div><div class="card"><strong>Interactive selected/apply state</strong><pre id="interactive" class="small">Loading…</pre></div></div>
<div class="grid"><div class="card"><strong>Timeline summaries</strong><pre id="summaries" class="small">Loading…</pre></div><div class="card"><strong>Compact request timelines</strong><pre id="timelines" class="small">Loading…</pre></div></div>
<div class="grid"><div class="card"><strong>Recent turns</strong><pre id="turns" class="small">Loading…</pre></div><div class="card"><strong>Recent request events</strong><pre id="events" class="small">Loading…</pre></div></div>
<div class="card"><strong>Live debug events</strong><pre id="log">Connecting…</pre></div>
<script>
const log = document.getElementById('log');
const stateNode = document.getElementById('state');
const clientsNode = document.getElementById('clients');
const requestsNode = document.getElementById('requests');
const interactiveNode = document.getElementById('interactive');
const summariesNode = document.getElementById('summaries');
const timelinesNode = document.getElementById('timelines');
const turnsNode = document.getElementById('turns');
const eventsNode = document.getElementById('events');
let lastState = null;
function line(text){ log.textContent += (log.textContent ? '\\n' : '') + text; log.scrollTop = log.scrollHeight; }
function clearLog(){ log.textContent=''; }
function formatRequest(req){
  if(!req) return null;
  return {
    requestId:req.requestId, clientId:req.clientId, phase:req.phase,
    delivered:req.delivered, accepted:req.accepted,
    lastHeartbeatAgoMs:req.lastHeartbeatAt?Date.now()-req.lastHeartbeatAt:null,
    lastMeaningfulProgressAgoMs:req.lastMeaningfulProgressAt?Date.now()-req.lastMeaningfulProgressAt:null,
    lastActivityReason:req.lastActivityReason,
    answerLength:req.answerLength, thinkingLength:req.thinkingLength, artifactCount:req.artifactCount,
    submittedUserTurnKey:req.submittedUserTurnKey, assistantTurnKey:req.assistantTurnKey,
    anchorConfidence:req.anchorConfidence, anchorReason:req.anchorReason,
    visibilityState:req.visibilityState, focused:req.focused, stopButtonVisible:req.stopButtonVisible,
    progressLength:req.progressTextLength || req.progressLength || 0,
    sourceUrl:req.sourceUrl
  };
}
function compactInteractiveState(diag){
  const state = diag.interactiveState || {};
  return {
    available: state.available,
    projectRoot: state.projectRoot,
    projectId: state.projectId,
    sessionId: state.sessionId,
    lastTurnId: state.lastTurnId,
    lastAppliedTurnId: state.lastAppliedTurnId,
    lastAppliedFileId: state.lastAppliedFileId,
    lastApplySummary: state.lastApplySummary,
    currentScope: state.currentScope,
    selectedResult: state.selectedResult,
    recentResponses: state.recentResponses,
  };
}
async function fetchJson(url){
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const detail = body?.detail || body?.error || response.statusText || 'Request failed';
    const error = new Error(url + ' -> HTTP ' + response.status + ': ' + detail);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
async function refreshAll(){
  try{
    const [diag, debug, events] = await Promise.all([
      fetchJson('/diagnostics/state'),
      fetchJson('/diagnostics/debug-events?limit=120'),
      fetchJson('/diagnostics/events?limit=120').catch(()=>({events:[]})),
    ]);
    lastState = { diagnostics: diag, debug, events };
    stateNode.textContent = JSON.stringify({ ok:diag.ok, transport:diag.health?.transport, selectedClientId:diag.health?.selectedClientId, needsSelection:diag.health?.needsSelection, pendingRequests:diag.health?.pendingRequests, pendingCommands:diag.health?.pendingCommands, artifacts:diag.health?.artifacts }, null, 2);
    clientsNode.textContent = JSON.stringify(diag.clients || [], null, 2);
    requestsNode.textContent = JSON.stringify((diag.activeRequests || []).map(formatRequest), null, 2);
    interactiveNode.textContent = JSON.stringify(compactInteractiveState(diag), null, 2);
    summariesNode.textContent = JSON.stringify(diag.timelineSummaries || [], null, 2);
    timelinesNode.textContent = JSON.stringify((diag.compactTimelines || []).slice(0, 8), null, 2);
    turnsNode.textContent = JSON.stringify(diag.recentTurns || [], null, 2);
    eventsNode.textContent = JSON.stringify((events.events || []).filter(e=>e.requestId || String(e.type||'').includes('request') || String(e.type||'').includes('result') || String(e.type||'').includes('artifact')).slice(-100), null, 2);
  }catch(e){
    const details = { message:String(e.message || e), status:e.status || null, body:e.body || null, hint:'Diagnostics endpoints should be localhost-only and do not require API_TOKEN. If this persists, restart the bridge server with the updated build.' };
    stateNode.textContent=JSON.stringify(details,null,2);
    clientsNode.textContent='[]';
    requestsNode.textContent='[]';
    interactiveNode.textContent='{}';
    summariesNode.textContent='[]';
    timelinesNode.textContent='[]';
    turnsNode.textContent='[]';
    eventsNode.textContent='[]';
    line('[diagnostics] refresh failed: '+details.message);
  }
}
function downloadBundle(mode){
  const kind = mode === 'full' ? 'full' : 'compact';
  window.location.href = '/diagnostics/bundle?mode=' + encodeURIComponent(kind);
  line('[diagnostics] downloading ' + kind + ' debug bundle');
}
function downloadCompactBundle(){ downloadBundle('compact'); }
function downloadFullBundle(){ downloadBundle('full'); }
refreshAll(); setInterval(refreshAll,3000);
const es = new EventSource('/setup/debug/stream?limit=100');
es.addEventListener('debug', (event) => { try { const data=JSON.parse(event.data); line((data.time || '') + ' ' + (data.type || '') + ' ' + JSON.stringify(data.data || data.payload || data)); } catch { line(event.data); } });
es.onerror = () => line('[diagnostics] debug stream disconnected; browser will retry automatically');
</script></body></html>`;
}

