import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { error as logError, log } from './logger.js';
import { HttpError } from './httpError.js';
import { appendOnlyDelta } from './protocol.js';
import { applyZipToProject, planZipApply } from './projectApply.js';
import { writeZip } from './zipWriter.js';
import {
  extractRequestFromOpenAIPayload,
  makeOpenAIChatCompletionChunk,
  makeOpenAIChatCompletionResponse,
} from './openaiPayload.js';

function wantsStream(req) {
  return req.body?.stream === true || req.query?.stream === '1' || req.query?.stream === 'true';
}

function initSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function writeNamedSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeOpenAISse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function tokenFromRequest(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || String(req.headers['x-bridge-token'] || req.query?.api_token || '');
}

function bridgeTokenFromRequest(req) {
  return String(req.query?.token || req.body?.token || req.headers['x-bridge-token'] || '');
}

async function collectDirectoryEntries(rootDir, prefix = '') {
  const entries = [];
  const items = await fs.readdir(rootDir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const absolute = path.join(rootDir, item.name);
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(...await collectDirectoryEntries(absolute, name));
    else if (item.isFile()) entries.push({ name, path: absolute });
  }
  return entries;
}


function requireApiToken(req, _res, next) {
  if (!config.apiToken) {
    next();
    return;
  }

  if (tokenFromRequest(req) === config.apiToken) {
    next();
    return;
  }

  next(new HttpError(401, 'Unauthorized: missing or invalid API_TOKEN'));
}



function requireLocalTampermonkey(req, res, next) {
  const token = String(req.query?.token || req.body?.token || req.headers['x-bridge-token'] || '');
  if (!bridgeForLocal(req)?.isLocalRequest(req)) {
    next(new HttpError(403, 'Browser companion endpoints only accept localhost requests'));
    return;
  }
  if (!bridgeForLocal(req)?.validateBridgeToken(token)) {
    next(new HttpError(401, 'Unauthorized: missing or invalid BRIDGE_TOKEN'));
    return;
  }
  next();
}

function bridgeForLocal(req) {
  return req.app.locals.bridge || null;
}


function diagnosticsJsonFromRequest(req, eventBus) {
  const bridge = bridgeForLocal(req);
  if (!bridge) throw new HttpError(503, 'Bridge is not configured');
  const health = bridge.health();
  return {
    ok: true,
    apiTokenConfigured: Boolean(config.apiToken),
    health,
    clients: health.clients || [],
    activeClient: health.activeClient || null,
    selectedClientId: health.selectedClientId || '',
    activeRequests: typeof bridge.requestDiagnostics === 'function' ? bridge.requestDiagnostics() : (health.activeRequests || []),
    recentEvents: eventBus ? eventBus.recentEvents(100) : [],
    recentDebugEvents: eventBus ? eventBus.recentDebugEvents(100) : bridge.debugEvents(),
  };
}

function localDiagnosticsEventsFromRequest(req, eventBus, bridge, channel = 'event') {
  const limit = Number.parseInt(String(req.query.limit || '100'), 10);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
  if (channel === 'debug') {
    return { ok: true, events: eventBus ? eventBus.recentDebugEvents(safeLimit) : bridge.debugEvents() };
  }
  return { ok: true, events: eventBus ? eventBus.recentEvents(safeLimit) : [] };
}

function diagnosticsHtml() {
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
<div class="card"><strong>Controls</strong><br><button onclick="refreshAll()">Refresh now</button> <button onclick="copyBundle()">Copy debug bundle</button> <button onclick="clearLog()">Clear live log</button></div>
<div class="grid"><div class="card"><strong>Server / bridge state</strong><pre id="state" class="small">Loading…</pre></div><div class="card"><strong>Active requests</strong><pre id="requests" class="small">Loading…</pre></div></div>
<div class="grid"><div class="card"><strong>Connected clients</strong><pre id="clients" class="small">Loading…</pre></div><div class="card"><strong>Recent request events</strong><pre id="events" class="small">Loading…</pre></div></div>
<div class="card"><strong>Live debug events</strong><pre id="log">Connecting…</pre></div>
<script>
const log = document.getElementById('log');
const stateNode = document.getElementById('state');
const clientsNode = document.getElementById('clients');
const requestsNode = document.getElementById('requests');
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
    sourceUrl:req.sourceUrl
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
    eventsNode.textContent = JSON.stringify((events.events || []).filter(e=>e.requestId || String(e.type||'').includes('request')).slice(-80), null, 2);
  }catch(e){
    const details = { message:String(e.message || e), status:e.status || null, body:e.body || null, hint:'Diagnostics endpoints should be localhost-only and do not require API_TOKEN. If this persists, restart the bridge server with the updated build.' };
    stateNode.textContent=JSON.stringify(details,null,2);
    clientsNode.textContent='[]';
    requestsNode.textContent='[]';
    eventsNode.textContent='[]';
    line('[diagnostics] refresh failed: '+details.message);
  }
}
async function copyBundle(){
  if(!lastState) await refreshAll();
  const text = JSON.stringify({ capturedAt:new Date().toISOString(), ...lastState }, null, 2);
  try { await navigator.clipboard.writeText(text); line('[diagnostics] debug bundle copied'); } catch(e) { line('[diagnostics] copy failed: '+e.message); }
}
refreshAll(); setInterval(refreshAll,3000);
const es = new EventSource('/setup/debug/stream?limit=100');
es.addEventListener('debug', (event) => { try { const data=JSON.parse(event.data); line((data.time || '') + ' ' + (data.type || '') + ' ' + JSON.stringify(data.data || data.payload || data)); } catch { line(event.data); } });
es.onerror = () => line('[diagnostics] debug stream disconnected; browser will retry automatically');
</script></body></html>`;
}

function setupHtml() {
  const setupUrl = `${config.publicBaseUrl}/setup`;
  const extensionZipUrl = `${config.publicBaseUrl}/extensions/chrome-bridge-extension.zip`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT Bridge Setup</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:40px;line-height:1.45;max-width:900px}code,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.card{border:1px solid #ddd;border-radius:12px;padding:18px;margin:18px 0}.row{display:flex;gap:8px;align-items:center;margin:8px 0}input{flex:1;padding:8px;border:1px solid #ccc;border-radius:8px}button{padding:8px 12px;border-radius:8px;border:1px solid #ccc;background:#f7f7f7;cursor:pointer}.ok{color:#097b38}.warn{color:#9a5a00}.muted{color:#666}</style></head>
<body><h1>ChatGPT Bridge setup</h1>
<div class="card"><h2>1. Install browser extension</h2><p>The recommended runtime is now the Chrome/Chromium extension. It keeps the localhost WebSocket in the extension background worker, so ChatGPT page CSP and userscript networking limits do not apply. It also uses Chrome downloads permission to capture artifact files that are created as browser downloads.</p><p><a href="${extensionZipUrl}">Download extension ZIP</a> or load the unpacked folder from <code>tools/chrome-bridge-extension</code>.</p><ol><li>Open <code>chrome://extensions</code>.</li><li>Enable Developer mode.</li><li>Click <b>Load unpacked</b> and select <code>tools/chrome-bridge-extension</code>.</li><li>Reload ChatGPT, open the floating Bridge panel, select <b>Extension WebSocket</b>, then Save & Connect.</li></ol></div>
<div class="card"><h2>2. Configure companion</h2><p>Open <a href="https://chatgpt.com" target="_blank">chatgpt.com</a>, click the floating Bridge button, and paste these values once.</p>
<label>Server URL</label><div class="row"><input readonly value="${config.publicBaseUrl}"><button onclick="copy(this.previousElementSibling.value)">Copy</button></div>
<label>Bridge token</label><div class="row"><input readonly value="${config.bridgeToken}"><button onclick="copy(this.previousElementSibling.value)">Copy</button></div>
<p class="warn">Keep the API token private. The browser companion only needs the Bridge token.</p></div>
<div class="card"><h2>Status</h2><pre id="status">Loading…</pre><button onclick="refresh()">Refresh</button> <a href="/diagnostics">Open diagnostics</a></div>
<script>
async function copy(text){ await navigator.clipboard.writeText(text); }
async function refresh(){ const r=await fetch('/setup/status'); document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2); }
refresh(); setInterval(refresh,3000);
</script></body></html>`;
}

function streamEventBus(req, res, eventBus, channel) {
  if (!eventBus) {
    res.status(503).json({ detail: 'Event bus is not configured' });
    return;
  }

  initSse(res);
  const limit = Number.parseInt(String(req.query.limit || '50'), 10);
  const includeRecent = req.query.recent !== '0';
  const eventName = channel === 'debug' ? 'debug' : 'event';
  let closed = false;

  const write = (event) => {
    if (closed) return;
    writeNamedSse(res, eventName, event);
  };

  if (includeRecent) {
    const recent = channel === 'debug' ? eventBus.recentDebugEvents(Number.isFinite(limit) ? limit : 50) : eventBus.recentEvents(Number.isFinite(limit) ? limit : 50);
    for (const event of recent) write(event);
  }

  const handler = (event) => write(event);
  eventBus.on(eventName, handler);

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    eventBus.off(eventName, handler);
  });
}

function createAbortControllerForResponse(res) {
  const controller = new AbortController();
  let completed = false;

  res.on('close', () => {
    if (!completed && !controller.signal.aborted) controller.abort('HTTP client disconnected');
  });

  return {
    controller,
    markCompleted() {
      completed = true;
    },
  };
}


function idempotencyKeyFromRequest(req) {
  return String(req.headers['idempotency-key'] || req.body?.idempotencyKey || req.body?.idempotency_key || '').trim();
}

function ensureJobManager(jobManager) {
  if (!jobManager) throw new HttpError(503, 'Job manager is not configured');
}

function ensureTurnManager(turnManager) {
  if (!turnManager) throw new HttpError(503, 'Turn manager is not configured');
}

function streamJobEvents(req, res, jobManager, jobId) {
  ensureJobManager(jobManager);
  initSse(res);
  const includeRecent = req.query.recent !== '0';
  const limit = Number.parseInt(String(req.query.limit || '500'), 10);
  let closed = false;

  const write = (event) => {
    if (!closed) writeNamedSse(res, 'event', event);
  };

  Promise.resolve()
    .then(async () => {
      if (includeRecent) {
        const events = await jobManager.getJobEvents(jobId, { limit: Number.isFinite(limit) ? limit : 500 });
        for (const event of events) write(event);
      }
      const job = await jobManager.getJob(jobId);
      if (job && ['done', 'failed', 'cancelled'].includes(job.status)) {
        writeNamedSse(res, 'done', { job });
        res.end();
      }
    })
    .catch((err) => {
      if (!closed) writeNamedSse(res, 'error', { error: err.message || 'Failed to stream job events' });
    });

  const handler = (event) => {
    write(event);
    if (['job.done', 'job.failed', 'job.cancelled'].includes(event.type)) {
      writeNamedSse(res, 'done', { event });
      res.end();
    }
  };
  jobManager.on(`job:${jobId}`, handler);

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    jobManager.off(`job:${jobId}`, handler);
  });
}


function streamTurnEvents(req, res, turnManager, turnId) {
  ensureTurnManager(turnManager);
  initSse(res);
  const includeRecent = req.query.recent !== '0';
  const limit = Number.parseInt(String(req.query.limit || '1000'), 10);
  let closed = false;
  const write = (event) => { if (!closed) writeNamedSse(res, 'event', event); };
  Promise.resolve().then(async () => {
    if (includeRecent) {
      const events = await turnManager.getTurnEvents(turnId, { limit: Number.isFinite(limit) ? limit : 1000 });
      for (const event of events) write(event);
    }
    const turn = await turnManager.getTurn(turnId);
    if (turn && ['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) {
      writeNamedSse(res, 'done', { turn });
      res.end();
    }
  }).catch((err) => {
    if (!closed) writeNamedSse(res, 'error', { error: err.message || 'Failed to stream turn events' });
  });
  const handler = (event) => {
    write(event);
    if (['turn/completed', 'turn/completed_without_artifact', 'turn/failed', 'turn/interrupted', 'turn/cancelled'].includes(event.type)) {
      writeNamedSse(res, 'done', { event });
      res.end();
    }
  };
  turnManager.on(`turn:${turnId}`, handler);
  const keepalive = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 15_000);
  keepalive.unref?.();
  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    turnManager.off(`turn:${turnId}`, handler);
  });
}

function requestFromChatBody(body = {}) {
  const message = typeof body.message === 'string' ? body.message : typeof body.prompt === 'string' ? body.prompt : '';
  return {
    message,
    attachments: Array.isArray(body.attachments) ? body.attachments : Array.isArray(body.fileIds) ? body.fileIds : [],
    model: typeof body.model === 'string' ? body.model : '',
    effort: typeof body.effort === 'string' ? body.effort : typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : typeof body.conversationId === 'string' ? body.conversationId : '',
    newSession: Boolean(body.newSession),
  };
}

function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[\\/\0\r\n"]/g, '_')
    .slice(0, 180) || 'download';
}

function sendStoredFile(res, file) {
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(file.name)}"`);
  file.stream.pipe(res);
}

async function streamChatResponse(req, res, bridge, request) {
  initSse(res);

  const abortable = createAbortControllerForResponse(res);
  let closed = false;
  let lastAnswer = '';
  let lastThinking = '';
  let lastArtifacts = [];

  res.on('close', () => {
    closed = true;
  });

  try {
    const response = await bridge.sendRequest(request, {
      onEvent(event) {
        if (!closed) writeNamedSse(res, 'event', event);
      },
      onThinkingUpdate(text) {
        if (closed) return;
        const delta = appendOnlyDelta(lastThinking, text);
        lastThinking = text;
        if (delta) writeNamedSse(res, 'thinking', { delta, thinking: text });
      },
      onAnswerUpdate(text) {
        if (closed) return;
        const delta = appendOnlyDelta(lastAnswer, text);
        lastAnswer = text;
        if (delta) writeNamedSse(res, 'message', { delta, response: text });
      },
      onArtifactUpdate(artifacts) {
        if (closed) return;
        lastArtifacts = artifacts;
        writeNamedSse(res, 'artifacts', { artifacts });
      },
    }, { signal: abortable.controller.signal });

    if (!closed) {
      writeNamedSse(res, 'done', { response: response.answer, result: response, artifacts: lastArtifacts });
      abortable.markCompleted();
      res.end();
    }
  } catch (err) {
    if (!closed) {
      writeNamedSse(res, 'error', { error: err.message || 'Internal Server Error' });
      abortable.markCompleted();
      res.end();
    }
  }
}

async function streamOpenAIResponse(req, res, bridge, request) {
  initSse(res);

  const abortable = createAbortControllerForResponse(res);
  let closed = false;
  let lastAnswer = '';
  let lastThinking = '';

  res.on('close', () => {
    closed = true;
  });

  try {
    await bridge.sendRequest(request, {
      onThinkingUpdate(text) {
        if (closed) return;
        const delta = appendOnlyDelta(lastThinking, text);
        lastThinking = text;
        if (delta) writeOpenAISse(res, makeOpenAIChatCompletionChunk({ reasoningContent: delta }));
      },
      onAnswerUpdate(text) {
        if (closed) return;
        const delta = appendOnlyDelta(lastAnswer, text);
        lastAnswer = text;
        if (delta) writeOpenAISse(res, makeOpenAIChatCompletionChunk({ content: delta }));
      },
      onEvent(event) {
        if (!closed && event.type === 'artifact.snapshot') {
          writeOpenAISse(res, makeOpenAIChatCompletionChunk({ event }));
        }
      },
    }, { signal: abortable.controller.signal });

    if (!closed) {
      writeOpenAISse(res, makeOpenAIChatCompletionChunk({ finishReason: 'stop' }));
      res.write('data: [DONE]\n\n');
      abortable.markCompleted();
      res.end();
    }
  } catch (err) {
    if (!closed) {
      writeOpenAISse(res, { error: { message: err.message || 'Internal Server Error' } });
      abortable.markCompleted();
      res.end();
    }
  }
}

export function createRouter(bridge, fileStore, eventBus = null, jobManager = null, turnManager = null, projectService = null) {
  const router = express.Router();
  router.use((req, _res, next) => { req.app.locals.bridge = bridge; next(); });


  router.get('/diagnostics', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics page is only available from localhost');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(diagnosticsHtml());
    } catch (err) { next(err); }
  });

  router.get('/setup', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Setup page is only available from localhost');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(setupHtml());
    } catch (err) { next(err); }
  });

  router.get('/setup/status', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Setup status is only available from localhost');
      const health = bridge.health();
      res.json({
        ok: true,
        setupUrl: `${config.publicBaseUrl}/setup`,
        serverUrl: config.publicBaseUrl,
        host: config.host,
        port: config.port,
        apiTokenConfigured: Boolean(config.apiToken),
        bridgeTokenConfigured: Boolean(config.bridgeToken),
        generatedEnv: config.generatedEnv || [],
        recommendedTransport: 'extension',
        extensionTransport: 'extension-websocket',
        clients: health.clients,
        activeClient: health.activeClient,
        error: health.ok ? '' : health.needsSelection ? 'Multiple clients connected; select one.' : 'No browser companion connected yet.',
      });
    } catch (err) { next(err); }
  });

  router.get('/tm/auth/check', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Browser companion endpoints only accept localhost requests');
      const token = bridgeTokenFromRequest(req);
      if (!bridge.validateBridgeToken(token)) {
        throw new HttpError(403, 'Invalid BRIDGE_TOKEN. Paste the Bridge token from /setup into the ChatGPT Bridge companion.');
      }
      res.json({ ok: true, bridgeTokenAccepted: true, recommendedTransport: 'extension' });
    } catch (err) { next(err); }
  });

  router.get('/userscripts/chatgpt-bridge.user.js', (_req, res) => {
    res.status(410).type('text/plain').send('The userscript runtime is no longer supported. Install tools/chrome-bridge-extension instead.');
  });

  router.get('/extensions/chrome-bridge-extension.zip', async (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Extension package is only available from localhost');
      const root = path.resolve('tools/chrome-bridge-extension');
      const entries = await collectDirectoryEntries(root);
      const output = path.join(config.dataDir, 'setup', 'chrome-bridge-extension.zip');
      await writeZip(output, entries);
      res.download(output, 'chrome-bridge-extension.zip');
    } catch (err) { next(err); }
  });

  router.get('/diagnostics/state', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics API is only available from localhost');
      res.json(diagnosticsJsonFromRequest(req, eventBus));
    } catch (err) { next(err); }
  });

  router.get('/diagnostics/events', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics events are only available from localhost');
      res.json(localDiagnosticsEventsFromRequest(req, eventBus, bridge, 'event'));
    } catch (err) { next(err); }
  });

  router.get('/diagnostics/debug-events', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics debug events are only available from localhost');
      res.json(localDiagnosticsEventsFromRequest(req, eventBus, bridge, 'debug'));
    } catch (err) { next(err); }
  });

  router.get('/setup/debug/stream', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Setup debug stream is only available from localhost');
      streamEventBus(req, res, eventBus, 'debug');
    } catch (err) { next(err); }
  });

  router.all(['/tm/hello', '/tm/events', '/tm/exchange', '/tm/poll'], (_req, res) => {
    res.status(410).json({ ok: false, error: 'Userscript polling is no longer supported. Use the Chrome extension runtime.' });
  });

  router.get('/tm/files/:id/download', async (req, res, next) => {
    try {
      if (String(req.query.token || '') !== config.bridgeToken) throw new HttpError(401, 'Unauthorized browser companion file download');
      const file = await fileStore.getReadable(req.params.id);
      if (!file) throw new HttpError(404, 'File not found');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Content-Type', file.mime || 'application/octet-stream');
      res.setHeader('Content-Length', String(file.size || 0));
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name || file.id)}"`);
      file.stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });


  router.use(requireApiToken);


  router.get('/capabilities', async (_req, res) => {
    const health = bridge.health();
    res.json({
      ok: true,
      capabilities: {
        transports: { http: true, sse: true, extensionWebSocket: true, codexWs: true, codexStdio: true },
        threads: Boolean(turnManager),
        turns: Boolean(turnManager),
        items: Boolean(turnManager),
        jobs: Boolean(jobManager),
        files: true,
        artifacts: true,
        projectPackaging: Boolean(projectService),
        fileEdits: 'zip-artifact',
        shellCommands: false,
        approvals: false,
        worktrees: false,
        sandbox: false,
      },
      browser: {
        connected: health.ok,
        clients: health.clients.length,
        selectedClientId: health.selectedClientId,
        modelSelection: 'best_effort',
        fileUpload: true,
        artifactDownload: true,
      },
    });
  });

  router.get('/health', async (_req, res) => {
    const health = bridge.health();
    res.json({
      ok: health.ok,
      transport: health.transport,
      clients: health.clients.length,
      selectedClientId: health.selectedClientId,
      needsSelection: health.needsSelection,
      pendingRequests: health.pendingRequests,
      pendingCommands: health.pendingCommands,
      activeClient: health.activeClient,
      artifacts: health.artifacts,
      error: health.ok ? undefined : health.needsSelection
        ? 'Multiple browser extension clients connected. Select one before sending prompts.'
        : 'No selected browser extension client connected',
    });
  });

  router.get('/tm/clients', async (_req, res) => {
    const health = bridge.health();
    res.json({ ok: true, clients: health.clients, selectedClientId: health.selectedClientId, activeClient: health.activeClient, needsSelection: health.needsSelection });
  });

  router.delete('/tm/clients/:clientId', async (req, res, next) => {
    try {
      const clientId = String(req.params.clientId || '').trim();
      if (!clientId) throw new HttpError(400, 'No clientId provided');
      const dropped = bridge.dropClient(clientId);
      res.json({ ok: true, droppedClient: dropped });
    } catch (err) { next(err); }
  });

  router.post('/tm/select', async (req, res, next) => {
    try {
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
      if (!clientId) throw new HttpError(400, 'No clientId provided');
      const selected = bridge.selectClient(clientId);
      res.json({ ok: true, selectedClient: selected });
    } catch (err) { next(err); }
  });

  router.delete('/tm/select', async (_req, res) => {
    bridge.clearSelectedClient();
    res.json({ ok: true, selectedClientId: '' });
  });

  router.post('/tm/stop', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'Cancelled through /tm/stop';
    const cancelled = bridge.cancelActive(reason);
    res.json({ ok: true, cancelled });
  });

  router.get('/models', async (_req, res, next) => {
    try { res.json({ ok: true, ...(await bridge.listModels({ timeoutMs: 10_000 })) }); } catch (err) { next(err); }
  });

  router.get('/efforts', async (_req, res, next) => {
    try { res.json({ ok: true, ...(await bridge.listEfforts({ timeoutMs: 10_000 })) }); } catch (err) { next(err); }
  });

  router.post('/composer/attachments/clear', async (_req, res, next) => {
    try { res.json({ ok: true, ...(await bridge.clearComposerAttachments({ timeoutMs: 10_000 })) }); } catch (err) { next(err); }
  });

  router.get('/debug/events', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    res.json({ ok: true, events: eventBus ? eventBus.recentDebugEvents(Number.isFinite(limit) ? limit : 100) : bridge.debugEvents() });
  });

  router.get('/events', async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit || '100'), 10);
    res.json({ ok: true, events: eventBus ? eventBus.recentEvents(Number.isFinite(limit) ? limit : 100) : [] });
  });

  router.get('/events/stream', async (req, res) => {
    streamEventBus(req, res, eventBus, 'event');
  });

  router.get('/debug/stream', async (req, res) => {
    streamEventBus(req, res, eventBus, 'debug');
  });

  router.get('/files', async (_req, res, next) => {
    try { res.json({ ok: true, files: await fileStore.listFiles() }); } catch (err) { next(err); }
  });

  router.post('/files', async (req, res, next) => {
    try {
      const record = await fileStore.putUpload({
        name: req.body?.name,
        mime: req.body?.mime || req.body?.type,
        contentBase64: req.body?.contentBase64 || req.body?.content_base64,
        content: req.body?.content,
      });
      res.status(201).json({ ok: true, file: record });
    } catch (err) { next(err); }
  });

  router.post('/files/from-path', async (req, res, next) => {
    try {
      const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!filePath) throw new HttpError(400, 'No path provided');
      const record = await fileStore.importLocalPath({ filePath, name: req.body?.name, mime: req.body?.mime || req.body?.type });
      res.status(201).json({ ok: true, file: record });
    } catch (err) { next(err); }
  });

  router.get('/files/:id/download', async (req, res, next) => {
    try {
      const file = await fileStore.getReadable(req.params.id);
      if (!file) throw new HttpError(404, `File not found: ${req.params.id}`);
      sendStoredFile(res, file);
    } catch (err) { next(err); }
  });

  router.delete('/files/:id', async (req, res, next) => {
    try {
      const removed = await fileStore.remove(req.params.id);
      if (eventBus) eventBus.emitUser({ type: 'file.local.removed', data: { fileId: req.params.id, removed } });
      res.json({ ok: true, removed });
    } catch (err) { next(err); }
  });

  router.get('/artifacts', async (_req, res, next) => {
    try {
      res.json({ ok: true, artifacts: bridge.listKnownArtifacts(), stored: await fileStore.listArtifacts() });
    } catch (err) { next(err); }
  });

  router.get('/artifacts/:id/download', async (req, res, next) => {
    try {
      const stored = await bridge.fetchArtifact(req.params.id);
      const file = await fileStore.getReadable(stored.id || req.params.id);
      if (!file) throw new HttpError(404, `Artifact not found: ${req.params.id}`);
      sendStoredFile(res, file);
    } catch (err) { next(err); }
  });

  router.get('/sessions', async (req, res, next) => {
    try { res.json({ ok: true, sessions: await bridge.listSessions({ timeoutMs: Number(req.query.timeoutMs) || 10_000 }) }); } catch (err) { next(err); }
  });

  router.post('/sessions/new', async (_req, res, next) => {
    try { res.json({ ok: true, session: await bridge.newSession() }); } catch (err) { next(err); }
  });

  router.post('/sessions/select', async (req, res, next) => {
    try {
      const sessionId = String(req.body?.sessionId || req.body?.id || '');
      if (!sessionId) throw new HttpError(400, 'No sessionId provided');
      res.json({ ok: true, session: await bridge.selectSession(sessionId) });
    } catch (err) { next(err); }
  });




  router.post('/projects/open', async (req, res, next) => {
    try {
      if (!projectService) throw new HttpError(501, 'Project service is not available');
      const cwd = String(req.body?.cwd || req.body?.path || '');
      if (!cwd) throw new HttpError(400, 'No cwd/path provided');
      let thread = null;
      if (req.body?.createThread !== false && turnManager) {
        thread = await turnManager.createThread({ title: req.body?.title, cwd, metadata: { project: true } });
      }
      const project = await projectService.open(cwd, { threadId: thread?.id || req.body?.threadId || '', title: req.body?.title || '' });
      res.status(201).json({ ok: true, project, ...(thread ? { thread } : {}) });
    } catch (err) { next(err); }
  });

  router.post('/projects/scan', async (req, res, next) => {
    try {
      if (!projectService) throw new HttpError(501, 'Project service is not available');
      const cwd = String(req.body?.cwd || req.body?.path || '');
      if (!cwd) throw new HttpError(400, 'No cwd/path provided');
      res.json({ ok: true, scan: await projectService.scan(cwd, req.body || {}) });
    } catch (err) { next(err); }
  });

  router.post('/projects/pack', async (req, res, next) => {
    try {
      if (!projectService) throw new HttpError(501, 'Project service is not available');
      const cwd = String(req.body?.cwd || req.body?.path || '');
      if (!cwd) throw new HttpError(400, 'No cwd/path provided');
      res.json({ ok: true, pack: await projectService.pack(cwd, req.body || {}) });
    } catch (err) { next(err); }
  });


  router.post('/projects/apply-zip', async (req, res, next) => {
    try {
      const cwd = String(req.body?.cwd || req.body?.projectRoot || req.body?.path || '');
      if (!cwd) throw new HttpError(400, 'No cwd/projectRoot provided');
      let zipPath = String(req.body?.zipPath || '');
      if (!zipPath) {
        const fileId = String(req.body?.fileId || req.body?.resultFileId || '');
        if (!fileId) throw new HttpError(400, 'No zipPath or fileId provided');
        const readable = await fileStore.getReadable(fileId);
        if (!readable?.absolutePath) throw new HttpError(404, `File not found or not readable: ${fileId}`);
        zipPath = readable.absolutePath;
      }
      const referenceManifest = req.body?.referenceManifest
        || (Array.isArray(req.body?.referenceFiles) ? { files: req.body.referenceFiles.map((item) => (typeof item === 'string' ? { path: item } : item)) } : null)
        || (req.body?.referenceSnapshotId && projectService ? await projectService.getSnapshotManifest(cwd, String(req.body.referenceSnapshotId)).catch(() => null) : null)
        || (projectService ? await projectService.getLatestSnapshotManifest(cwd).catch(() => null) : null);
      const applyMode = String(req.body?.applyMode || '').toLowerCase();
      const options = {
        stripCommonRoot: req.body?.stripCommonRoot !== false,
        sync: Boolean(req.body?.sync || req.body?.deleteMissing),
        referenceManifest,
        conflictPolicy: req.body?.conflictPolicy || 'overwrite',
        selectedWritePaths: req.body?.selectedWritePaths || req.body?.selectedUpdatePaths || req.body?.selectedConflictPaths || req.body?.selectedPaths,
        selectedDeletePaths: req.body?.selectedDeletePaths || req.body?.selectedRemovePaths,
      };
      const plan = await planZipApply({ zipPath, projectRoot: cwd, options });
      const force = Boolean(req.body?.force || req.body?.confirmed || applyMode === 'force');
      const dryRun = Boolean(req.body?.dryRun || req.body?.planOnly || applyMode === 'plan');
      if (dryRun) {
        res.json({ ok: true, applied: false, requiresConfirmation: plan.requiresConfirmation, ...plan });
        return;
      }
      if (plan.requiresConfirmation && !force) {
        res.status(409).json({ ok: false, applied: false, requiresConfirmation: true, ...plan });
        return;
      }
      const result = await applyZipToProject({ zipPath, projectRoot: cwd, options });
      if (eventBus) eventBus.emitUser({ type: 'project/resultApplied', data: { cwd, files: result.written.length, deleted: result.deleted.length } });
      res.json({ ok: true, applied: true, result });
    } catch (err) { next(err); }
  });

  router.get('/threads', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const limit = Number.parseInt(String(req.query.limit || '100'), 10);
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
      const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
      res.json({ ok: true, threads: await turnManager.listThreads({ limit, cwd, includeArchived }) });
    } catch (err) { next(err); }
  });

  router.post('/threads', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const thread = await turnManager.createThread(req.body || {});
      res.status(201).json({ ok: true, thread });
    } catch (err) { next(err); }
  });

  router.get('/threads/:id', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const thread = await turnManager.getThread(req.params.id);
      if (!thread) throw new HttpError(404, `Thread not found: ${req.params.id}`);
      const turns = await turnManager.listTurns({ threadId: req.params.id });
      const items = req.query.items === '1' || req.query.items === 'true' ? await turnManager.getItems({ threadId: req.params.id }) : undefined;
      res.json({ ok: true, thread, turns, ...(items ? { items } : {}) });
    } catch (err) { next(err); }
  });

  router.get('/turns', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const limit = Number.parseInt(String(req.query.limit || '100'), 10);
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : '';
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      res.json({ ok: true, turns: await turnManager.listTurns({ limit, threadId, status }) });
    } catch (err) { next(err); }
  });

  router.post('/turns', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const { turn, reused } = await turnManager.startTurn(req.body || {}, { idempotencyKey: idempotencyKeyFromRequest(req) });
      res.status(reused ? 200 : 202).json({ ok: true, reused, turn, eventsUrl: `/turns/${turn.id}/events` });
    } catch (err) { next(err); }
  });

  router.get('/turns/:id', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const turn = await turnManager.getTurn(req.params.id);
      if (!turn) throw new HttpError(404, `Turn not found: ${req.params.id}`);
      const items = await turnManager.getItems({ turnId: req.params.id });
      res.json({ ok: true, turn, items });
    } catch (err) { next(err); }
  });

  router.get('/turns/:id/events', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const turn = await turnManager.getTurn(req.params.id);
      if (!turn) throw new HttpError(404, `Turn not found: ${req.params.id}`);
      if (wantsStream(req)) return streamTurnEvents(req, res, turnManager, req.params.id);
      const limit = Number.parseInt(String(req.query.limit || '1000'), 10);
      res.json({ ok: true, events: await turnManager.getTurnEvents(req.params.id, { limit }) });
    } catch (err) { next(err); }
  });



  router.get('/turns/:id/result/download', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const turn = await turnManager.getTurn(req.params.id);
      if (!turn) throw new HttpError(404, `Turn not found: ${req.params.id}`);
      const fileId = turn.output?.fileId || turn.output?.result?.fileId;
      if (!fileId) throw new HttpError(404, `No downloadable result for turn: ${req.params.id}`);
      const file = await fileStore.getReadable(fileId);
      if (!file) throw new HttpError(404, `Result file not found: ${fileId}`);
      sendStoredFile(res, file);
    } catch (err) { next(err); }
  });

  router.get('/turns/:id/items', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const turn = await turnManager.getTurn(req.params.id);
      if (!turn) throw new HttpError(404, `Turn not found: ${req.params.id}`);
      res.json({ ok: true, items: await turnManager.getItems({ turnId: req.params.id }) });
    } catch (err) { next(err); }
  });

  router.post('/turns/:id/interrupt', async (req, res, next) => {
    try {
      ensureTurnManager(turnManager);
      const turn = await turnManager.cancelTurn(req.params.id, typeof req.body?.reason === 'string' ? req.body.reason : 'Interrupted by API client');
      if (!turn) throw new HttpError(404, `Turn not found: ${req.params.id}`);
      res.json({ ok: true, turn });
    } catch (err) { next(err); }
  });


  router.get('/jobs', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const limit = Number.parseInt(String(req.query.limit || '50'), 10);
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      res.json({ ok: true, jobs: await jobManager.listJobs({ limit, status }) });
    } catch (err) { next(err); }
  });

  router.post('/jobs', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const { job, reused } = await jobManager.createJob(req.body || {}, { idempotencyKey: idempotencyKeyFromRequest(req) });
      res.status(reused ? 200 : 202).json({ ok: true, reused, job, eventsUrl: `/jobs/${job.id}/events`, resultUrl: `/jobs/${job.id}/result` });
    } catch (err) { next(err); }
  });

  router.post('/project-jobs', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const { job, reused } = await jobManager.createProjectJob(req.body || {}, { idempotencyKey: idempotencyKeyFromRequest(req) });
      res.status(reused ? 200 : 202).json({ ok: true, reused, job, eventsUrl: `/jobs/${job.id}/events`, resultUrl: `/jobs/${job.id}/result` });
    } catch (err) { next(err); }
  });

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const job = await jobManager.getJob(req.params.id);
      if (!job) throw new HttpError(404, `Job not found: ${req.params.id}`);
      res.json({ ok: true, job });
    } catch (err) { next(err); }
  });

  router.get('/jobs/:id/events', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const job = await jobManager.getJob(req.params.id);
      if (!job) throw new HttpError(404, `Job not found: ${req.params.id}`);
      if (wantsStream(req)) return streamJobEvents(req, res, jobManager, req.params.id);
      const limit = Number.parseInt(String(req.query.limit || '500'), 10);
      res.json({ ok: true, events: await jobManager.getJobEvents(req.params.id, { limit }) });
    } catch (err) { next(err); }
  });

  router.post('/jobs/:id/cancel', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Cancelled by API client';
      const job = await jobManager.cancelJob(req.params.id, reason);
      if (!job) throw new HttpError(404, `Job not found: ${req.params.id}`);
      res.json({ ok: true, job });
    } catch (err) { next(err); }
  });

  router.get('/jobs/:id/result', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const job = await jobManager.getJob(req.params.id);
      if (!job) throw new HttpError(404, `Job not found: ${req.params.id}`);
      res.json({ ok: true, status: job.status, result: job.result, response: job.response, error: job.error });
    } catch (err) { next(err); }
  });

  router.get('/jobs/:id/artifacts', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const job = await jobManager.getJob(req.params.id);
      if (!job) throw new HttpError(404, `Job not found: ${req.params.id}`);
      res.json({ ok: true, artifacts: job.response?.artifacts || [], result: job.result || null });
    } catch (err) { next(err); }
  });

  router.get('/jobs/:id/result/download', async (req, res, next) => {
    try {
      ensureJobManager(jobManager);
      const download = await jobManager.getResultDownload(req.params.id);
      if (!download?.fileId) throw new HttpError(404, `No downloadable result for job: ${req.params.id}`);
      const file = await fileStore.getReadable(download.fileId);
      if (!file) throw new HttpError(404, `Result file not found: ${download.fileId}`);
      sendStoredFile(res, file);
    } catch (err) { next(err); }
  });

  router.post('/sessions/:sessionId/messages', async (req, res, next) => {
    try {
      const request = { ...requestFromChatBody(req.body), sessionId: req.params.sessionId };
      if (!request.message.trim()) throw new HttpError(400, 'No message provided');
      if (wantsStream(req)) return await streamChatResponse(req, res, bridge, request);
      const response = await bridge.sendRequest(request, {}, { fullResponse: true });
      res.json({ ok: true, ...response });
    } catch (err) { next(err); }
  });

  router.post('/chat', async (req, res, next) => {
    try {
      const request = requestFromChatBody(req.body);
      if (!request.message.trim()) throw new HttpError(400, 'No message provided');
      if (wantsStream(req)) return await streamChatResponse(req, res, bridge, request);
      const response = await bridge.sendRequest(request, {}, { fullResponse: true });
      res.json({ ok: true, response: response.answer, ...response });
    } catch (err) { next(err); }
  });

  router.post('/v1/chat/completions', async (req, res, next) => {
    try {
      if (config.payloadDebug) await fs.writeFile(config.payloadDebugFile, JSON.stringify(req.body, null, 2), 'utf8');
      const request = extractRequestFromOpenAIPayload(req.body);
      if (!request.message) {
        const preview = JSON.stringify(req.body).slice(0, 500).replaceAll('\n', '\\n');
        log(`Could not extract user message from payload: ${preview}`);
        throw new HttpError(400, 'No user message provided');
      }
      if (wantsStream(req)) return await streamOpenAIResponse(req, res, bridge, request);
      const response = await bridge.sendRequest(request, {}, { fullResponse: true });
      res.json(makeOpenAIChatCompletionResponse(response));
    } catch (err) { next(err); }
  });

  router.use((err, _req, res, _next) => {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (statusCode >= 500) logError('Request failed:', err);
    res.status(statusCode).json({ detail: err.message || 'Internal Server Error' });
  });

  return router;
}
