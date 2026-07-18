import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { error as logError, log } from './logger.js';
import { HttpError } from './httpError.js';
import { appendOnlyDelta } from './protocol.js';
import { planZipApply } from './project/apply/planner.js';
import { applyZipToProject } from './project/apply/runner.js';
import { writeZip } from './zipWriter.js';
import {
  extractRequestFromOpenAIPayload,
  makeOpenAIChatCompletionChunk,
  makeOpenAIChatCompletionResponse,
} from './openaiPayload.js';
import { diagnosticsHtml, diagnosticsJsonFromRequest, localDiagnosticsEventsFromRequest, sendDiagnosticsBundle } from './http/diagnostics.js';
import { initSse, streamEventBus, writeNamedSse } from './http/eventStreams.js';
import { streamTurnEvents } from './http/publicTurnStream.js';
import { streamObservedTurns } from './http/observedTurnStream.js';
import { registerWorkflowRoutes } from './http/workflowRoutes.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY } from './extensionCompatibility.js';


function wantsStream(req) {
  return req.body?.stream === true || req.query?.stream === '1' || req.query?.stream === 'true';
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



function requireLocalExtension(req, res, next) {
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


function setupHtml() {
  const extensionZipUrl = `${config.publicBaseUrl}/extensions/chrome-bridge-extension.zip`;
  const extensionVersion = EXTENSION_COMPATIBILITY.recommendedExtensionVersion;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT Bridge Setup</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--primary:#2563eb;--primary2:#1d4ed8;--ok:#15803d;--okbg:#f0fdf4;--warn:#a16207;--warnbg:#fffbeb;--bad:#be123c;--badbg:#fff1f2}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,rgba(37,99,235,.08),transparent 28rem),var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:980px;margin:0 auto;padding:48px 24px 72px}.hero{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:start;margin-bottom:28px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:800;color:var(--primary)}h1{margin:5px 0 8px;font-size:38px;line-height:1.08;letter-spacing:-.035em}.lead{max-width:700px;margin:0;color:var(--muted);font-size:17px}.version{padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:var(--card);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 14px 40px rgba(0,0,0,.05)}.card h2{display:flex;align-items:center;gap:10px;margin:0 0 9px;font-size:18px}.step{display:grid;place-items:center;width:27px;height:27px;border-radius:9px;background:#dbeafe;color:#1d4ed8;font-size:13px}.muted{color:var(--muted)}ol{padding-left:21px;margin:13px 0}li{margin:7px 0}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 14px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--text);font-weight:700;text-decoration:none;cursor:pointer}.button:hover{background:#f4f4f5}.button.primary{background:var(--primary);border-color:var(--primary);color:#fff}.button.primary:hover{background:var(--primary2)}.field{margin-top:13px}.field label{display:flex;justify-content:space-between;margin-bottom:6px;color:var(--muted);font-size:12px;font-weight:700}.copyrow{display:flex;gap:7px}.copyrow input{min-width:0;flex:1;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.copyrow button{padding:8px 11px}.notice{margin-top:13px;padding:11px 12px;border-radius:12px;background:var(--warnbg);color:var(--warn);font-size:12px}.status{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--line);border-radius:14px;background:#fafafa}.statusdot{width:11px;height:11px;border-radius:50%;margin-top:5px;background:#a1a1aa;box-shadow:0 0 0 4px rgba(161,161,170,.13)}.status[data-tone=ok]{background:var(--okbg);border-color:#bbf7d0}.status[data-tone=ok] .statusdot{background:#22c55e}.status[data-tone=warn]{background:var(--warnbg);border-color:#fde68a}.status[data-tone=warn] .statusdot{background:#f59e0b}.status[data-tone=bad]{background:var(--badbg);border-color:#fecdd3}.status[data-tone=bad] .statusdot{background:#f43f5e}.status h3{margin:0;font-size:15px}.status p{margin:3px 0 0;color:var(--muted);font-size:13px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}details{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;color:var(--muted);font-weight:700;font-size:13px}pre{max-height:300px;overflow:auto;padding:12px;border-radius:12px;background:#18181b;color:#e4e4e7;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.wide{grid-column:1/-1}@media(max-width:760px){.shell{padding:30px 15px 50px}.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.wide{grid-column:auto}h1{font-size:31px}}@media(prefers-color-scheme:dark){:root{--bg:#0f0f10;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--okbg:#10251a;--warnbg:#2b2411;--badbg:#30151b}.button:hover{background:#27272a}.status{background:#202024}.copyrow input{background:#202024}}
</style></head><body><main class="shell"><header class="hero"><div><div class="eyebrow">Local browser companion</div><h1>Connect ChatGPT Bridge</h1><p class="lead">Install the extension once, paste the local Bridge token, and verify that this browser tab is ready. Diagnostics stay out of the way unless you need them.</p></div><div class="version">bridge ${BRIDGE_VERSION} · extension ${extensionVersion}</div></header>
<div class="grid">
<section class="card"><h2><span class="step">1</span>Install or update the extension</h2><p class="muted">Use the extension packaged by this running bridge so the protocol and artifact-download code match.</p><div class="actions"><a class="button primary" href="${extensionZipUrl}">Download extension ${extensionVersion}</a></div><ol><li>Open <code>chrome://extensions</code>.</li><li>Enable <b>Developer mode</b>.</li><li>For the first install, choose <b>Load unpacked</b>. For an existing unpacked copy, click <b>Reload</b>; do not remove and add it again.</li><li>Select <code>tools/chrome-bridge-extension</code> and reload the ChatGPT chat tab.</li></ol></section>
<section class="card"><h2><span class="step">2</span>Copy connection details</h2><div class="field"><label><span>Local bridge URL</span><span>safe to share locally</span></label><div class="copyrow"><input readonly value="${config.publicBaseUrl}"><button class="button" onclick="copyValue(this)">Copy</button></div></div><div class="field"><label><span>Bridge token</span><span>keep private</span></label><div class="copyrow"><input readonly type="password" value="${config.bridgeToken}"><button class="button" onclick="copyValue(this)">Copy</button></div></div><div class="notice">Use the <b>Bridge token</b>, not the API token. Paste it into the floating Bridge button inside an actual ChatGPT chat.</div></section>
<section class="card wide"><h2><span class="step">3</span>Verify the connection</h2><div id="friendly-status" class="status" data-tone="warn"><span class="statusdot"></span><div><h3>Waiting for a ChatGPT tab</h3><p>Open a chat, configure the floating Bridge panel, then return here.</p></div></div><div class="actions"><a class="button primary" href="https://chatgpt.com" target="_blank" rel="noreferrer">Open ChatGPT chat</a><button class="button" onclick="refreshStatus()">Refresh status</button><a class="button" href="/diagnostics">Open diagnostics</a></div><details><summary>Advanced & diagnostics</summary><pre id="status-json">Loading…</pre></details></section>
</div></main><script>
async function copyValue(button){const input=button.previousElementSibling;await navigator.clipboard.writeText(input.value);const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,900)}
function clientLabel(client){return client.title||client.session?.title||client.session?.id||client.id||'ChatGPT tab'}
function renderFriendly(data){const node=document.getElementById('friendly-status');const title=node.querySelector('h3');const text=node.querySelector('p');const clients=Array.isArray(data.clients)?data.clients:[];const compatible=clients.filter(c=>c.compatible!==false&&c.compatibility?.compatible!==false);const incompatible=clients.filter(c=>c.compatible===false||c.compatibility?.compatible===false);if(data.activeClient){node.dataset.tone='ok';title.textContent='Connected and ready';text.textContent=clientLabel(data.activeClient)+' · extension '+(data.activeClient.extensionVersion||data.activeClient.clientVersion||'unknown');return}if(incompatible.length){node.dataset.tone='bad';title.textContent='Extension update required';text.textContent=incompatible[0].compatibility?.message||'Reload the extension included with this bridge package.';return}if(compatible.length>1){node.dataset.tone='warn';title.textContent='Multiple tabs connected';text.textContent='Choose a tab in interactive mode with /tabs and /tab.';return}node.dataset.tone='warn';title.textContent='Waiting for a configured ChatGPT chat';text.textContent=data.error||'Open a chat and connect the extension using the Bridge token above.'}
async function refreshStatus(){try{const response=await fetch('/setup/status',{cache:'no-store'});const data=await response.json();document.getElementById('status-json').textContent=JSON.stringify(data,null,2);renderFriendly(data)}catch(error){const node=document.getElementById('friendly-status');node.dataset.tone='bad';node.querySelector('h3').textContent='Bridge status unavailable';node.querySelector('p').textContent=String(error.message||error)}}
refreshStatus();setInterval(refreshStatus,3000);
</script></body></html>`;
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

function ensureTurnManager(turnManager) {
  if (!turnManager) throw new HttpError(503, 'Turn manager is not configured');
}

function requestFromChatBody(body = {}) {
  const message = typeof body.message === 'string' ? body.message : typeof body.prompt === 'string' ? body.prompt : '';
  return {
    message,
    attachments: Array.isArray(body.attachments) ? body.attachments : Array.isArray(body.fileIds) ? body.fileIds : [],
    model: typeof body.model === 'string' ? body.model : '',
    effort: typeof body.effort === 'string' ? body.effort : typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '',
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : typeof body.conversationId === 'string' ? body.conversationId : '',
    sourceClientId: typeof body.sourceClientId === 'string' ? body.sourceClientId : typeof body.clientId === 'string' ? body.clientId : '',
    newSession: Boolean(body.newSession),
    autoOpenTab: typeof body.autoOpenTab === 'boolean'
      ? body.autoOpenTab
      : typeof body.auto_open_tab === 'boolean'
        ? body.auto_open_tab
        : undefined,
    output: body.output && typeof body.output === 'object' ? body.output : undefined,
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

  res.on('close', () => {
    closed = true;
  });

  try {
    const response = await bridge.sendRequest(request, {
      onEvent(event) {
        if (!closed) writeNamedSse(res, 'event', event);
      },
    }, { signal: abortable.controller.signal, fullResponse: true });

    if (!closed) {
      writeNamedSse(res, 'event', {
        type: 'request.result',
        requestId: response.requestId || response.id || request.requestId || '',
        result: response,
      });
      abortable.markCompleted();
      res.end();
    }
  } catch (err) {
    if (!closed) {
      writeNamedSse(res, 'event', {
        type: 'request.error',
        requestId: request.requestId || '',
        error: { code: err.code || 'REQUEST_FAILED', message: err.message || 'Internal Server Error' },
      });
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

export function createRouter(bridge, fileStore, eventBus = null, turnManager = null, projectService = null, workflowManager = null) {
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
        bridgeVersion: BRIDGE_VERSION,
        extensionCompatibility: EXTENSION_COMPATIBILITY,
        clients: health.clients,
        activeClient: health.activeClient,
        error: health.ok
          ? ''
          : health.clients.some((client) => client.compatible === false || client.compatibility?.compatible === false)
            ? (health.clients.find((client) => client.compatible === false || client.compatibility?.compatible === false)?.compatibility?.message
              || `Extension update required. Install version ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion}.`)
            : health.needsSelection
              ? 'Multiple compatible clients connected; select one.'
              : 'No compatible browser companion connected yet.',
      });
    } catch (err) { next(err); }
  });

  router.get('/extension/auth/check', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Browser companion endpoints only accept localhost requests');
      const token = bridgeTokenFromRequest(req);
      if (!bridge.validateBridgeToken(token)) {
        throw new HttpError(403, 'Invalid BRIDGE_TOKEN. Paste the Bridge token from /setup into the ChatGPT Bridge companion.');
      }
      res.json({ ok: true, bridgeTokenAccepted: true, recommendedTransport: 'extension' });
    } catch (err) { next(err); }
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

  router.get('/diagnostics/state', async (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics API is only available from localhost');
      res.json(await diagnosticsJsonFromRequest(req, eventBus, turnManager));
    } catch (err) { next(err); }
  });


  router.get('/diagnostics/request-state', (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Request state diagnostics are only available from localhost');
      const requestId = String(req.query?.requestId || '').trim();
      res.json({ ok: true, authoritative: true, requests: bridge.requestStateDiagnostics(requestId) });
    } catch (err) { next(err); }
  });



  router.get('/diagnostics/bundle', async (req, res, next) => {
    try {
      if (!bridge.isLocalRequest(req)) throw new HttpError(403, 'Diagnostics bundle is only available from localhost');
      const mode = String(req.query?.mode || 'compact').toLowerCase();
      const diagnostics = await diagnosticsJsonFromRequest(req, eventBus, turnManager);
      sendDiagnosticsBundle(res, diagnostics, { compact: mode !== 'full' });
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


  router.get('/extension/files/:id/download', async (req, res, next) => {
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
        files: true,
        artifacts: true,
        projectPackaging: Boolean(projectService),
        workflows: Boolean(workflowManager),
        passiveTurnObservation: Boolean(workflowManager),
        fileEdits: 'zip-artifact',
        shellCommands: Boolean(workflowManager),
        workflowCommands: Boolean(workflowManager),
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

  router.get('/browser/observed-turns', async (req, res, next) => {
    try {
      const afterSequence = Math.max(0, Number(req.query.after || 0) || 0);
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 100) || 100));
      res.json({ ok: true, observedTurns: bridge.listObservedTurns({ afterSequence, limit }) });
    } catch (error) { next(error); }
  });

  router.get('/browser/observed-turns/stream', (req, res, next) => {
    try { return streamObservedTurns(req, res, bridge); }
    catch (error) { next(error); }
  });

  router.post('/browser/recover-latest', async (req, res, next) => {
    try {
      res.json({ ok: true, result: await bridge.recoverLatestResponse({
        sourceClientId: String(req.body?.sourceClientId || ''),
        index: Math.max(1, Number(req.body?.index) || 1),
        timeoutMs: Number(req.body?.timeoutMs) || 30_000,
      }) });
    } catch (error) { next(error); }
  });

  router.post('/browser/passive-prompt', async (req, res, next) => {
    try {
      res.json({ ok: true, result: await bridge.submitPassivePrompt({
        message: req.body?.message,
        sessionId: req.body?.sessionId,
        effort: req.body?.effort,
        model: req.body?.model,
        sourceClientId: req.body?.sourceClientId,
        timeoutMs: req.body?.timeoutMs,
      }) });
    } catch (error) { next(error); }
  });

  registerWorkflowRoutes(router, workflowManager);

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
      activeRequests: health.activeRequests,
      activeClient: health.activeClient,
      artifacts: health.artifacts,
      error: health.ok ? undefined : health.needsSelection
        ? 'Multiple browser extension clients connected. Select one before sending prompts.'
        : 'No selected browser extension client connected',
    });
  });

  router.get('/browser/clients', async (_req, res) => {
    const health = bridge.health();
    res.json({ ok: true, clients: health.clients, selectedClientId: health.selectedClientId, activeClient: health.activeClient, needsSelection: health.needsSelection });
  });

  router.delete('/browser/clients/:clientId', async (req, res, next) => {
    try {
      const clientId = String(req.params.clientId || '').trim();
      if (!clientId) throw new HttpError(400, 'No clientId provided');
      const dropped = bridge.dropClient(clientId);
      res.json({ ok: true, droppedClient: dropped });
    } catch (err) { next(err); }
  });

  router.post('/browser/select', async (req, res, next) => {
    try {
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
      if (!clientId) throw new HttpError(400, 'No clientId provided');
      const selected = bridge.selectClient(clientId);
      res.json({ ok: true, selectedClient: selected });
    } catch (err) { next(err); }
  });

  router.delete('/browser/select', async (_req, res) => {
    bridge.clearSelectedClient();
    res.json({ ok: true, selectedClientId: '' });
  });

  router.post('/browser/stop', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'Cancelled through /browser/stop';
    const cancelled = bridge.cancelActive(reason);
    res.json({ ok: true, cancelled });
  });


  router.post('/requests/:requestId/steer', async (req, res, next) => {
    try {
      const message = String(req.body?.message || req.body?.prompt || '').trim();
      if (!message) throw new HttpError(400, 'No steer message provided');
      const result = await bridge.steerRequest(req.params.requestId, message, {
        sourceClientId: String(req.body?.sourceClientId || ''),
        timeoutMs: Number(req.body?.timeoutMs) || 30_000,
      });
      res.json({ ok: true, requestId: req.params.requestId, steered: true, result });
    } catch (err) { next(err); }
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

  router.post('/sessions/delete', async (req, res, next) => {
    try {
      const sessionId = String(req.body?.sessionId || req.body?.id || '').trim();
      const expectedUrl = String(req.body?.expectedUrl || '').trim();
      const sourceClientId = String(req.body?.sourceClientId || req.body?.clientId || '').trim();
      if (!sessionId) throw new HttpError(400, 'No sessionId provided');
      if (!expectedUrl) throw new HttpError(400, 'No expectedUrl provided');
      const result = await bridge.deleteSession(sessionId, expectedUrl, { sourceClientId, timeoutMs: Number(req.body?.timeoutMs) || 30_000 });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  router.post('/browser/extension/reload', async (req, res, next) => {
    try {
      const result = await bridge.reloadExtension({
        sourceClientId: String(req.body?.sourceClientId || req.body?.clientId || ''),
        expectedVersion: String(req.body?.expectedVersion || ''),
        reloadTabs: req.body?.reloadTabs !== false,
        timeoutMs: Number(req.body?.timeoutMs) || 30_000,
      });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  router.post('/browser/tabs/open', async (req, res, next) => {
    try {
      const result = await bridge.openBrowserTab({
        url: String(req.body?.url || 'https://chatgpt.com/'),
        active: req.body?.active !== false,
        launchToken: String(req.body?.launchToken || ''),
        bridgeServerUrl: String(req.body?.bridgeServerUrl || ''),
        sourceClientId: String(req.body?.sourceClientId || req.body?.clientId || ''),
        timeoutMs: Number(req.body?.timeoutMs) || 30_000,
        ...(req.body?.bootstrapWaitMs != null ? { bootstrapWaitMs: Number(req.body.bootstrapWaitMs) } : {}),
        ...(typeof req.body?.allowSystemFallback === 'boolean' ? { allowSystemFallback: req.body.allowSystemFallback } : {}),
        ...(typeof req.body?.allowIncompatibleClient === 'boolean' ? { allowIncompatibleClient: req.body.allowIncompatibleClient } : {}),
      });
      const selectedClient = req.body?.select === false ? null : bridge.selectClient(result.client.id);
      res.status(201).json({ ok: true, ...result, selectedClient });
    } catch (err) { next(err); }
  });

  router.post('/browser/tabs/reload', async (req, res, next) => {
    try {
      const sourceClientId = String(req.body?.sourceClientId || req.body?.clientId || '').trim();
      if (!sourceClientId) throw new HttpError(400, 'No sourceClientId provided');
      const result = await bridge.reloadBrowserTab({
        sourceClientId,
        reason: String(req.body?.reason || 'manual browser recovery'),
        timeoutMs: Number(req.body?.timeoutMs) || 10_000,
      });
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  router.post('/browser/tabs/close', async (req, res, next) => {
    try {
      const sourceClientId = String(req.body?.sourceClientId || req.body?.clientId || '').trim();
      if (!sourceClientId) throw new HttpError(400, 'No sourceClientId provided');
      const result = await bridge.closeBrowserTab({
        sourceClientId,
        expectedLaunchToken: String(req.body?.expectedLaunchToken || ''),
        expectedUrl: String(req.body?.expectedUrl || ''),
        timeoutMs: Number(req.body?.timeoutMs) || 10_000,
      });
      res.json({ ok: true, ...result });
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
      if (wantsStream(req) && (req.query.wait === '1' || req.query.wait === 'true')) {
        return streamTurnEvents(req, res, turnManager, req.params.id, { allowMissing: true });
      }
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
