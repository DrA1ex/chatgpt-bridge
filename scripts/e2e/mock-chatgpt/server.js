import http from 'node:http';
import { once } from 'node:events';
import { renderMockChatPage, renderMockCss } from './render.js';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, statusCode, value) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

export async function startMockChatGptServer({ host = '127.0.0.1', port = 0, tabs } = {}) {
  if (!tabs || typeof tabs.get !== 'function') throw new TypeError('Mock ChatGPT server requires a tab registry');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      if (url.pathname === '/mock-chatgpt.css') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/css; charset=utf-8');
        res.end(renderMockCss());
        return;
      }
      if (url.pathname === '/health') {
        json(res, 200, { ok: true, tabs: tabs.size });
        return;
      }
      const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)$/);
      if (artifactMatch) {
        const artifactId = decodeURIComponent(artifactMatch[1]);
        const artifact = Array.from(tabs.values()).map((tab) => tab.state.artifactById(artifactId)).find(Boolean);
        if (!artifact) { json(res, 404, { detail: `Artifact not found: ${artifactId}` }); return; }
        res.statusCode = 200;
        res.setHeader('content-type', artifact.mime || 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${String(artifact.name || artifactId).replaceAll('"', '')}"`);
        res.end(artifact.buffer);
        return;
      }
      const stateMatch = url.pathname.match(/^\/api\/tabs\/(\d+)$/);
      if (stateMatch) {
        const tab = tabs.get(Number(stateMatch[1]));
        if (!tab) { json(res, 404, { detail: 'Mock tab not found' }); return; }
        if (req.method === 'POST') {
          const input = await readJson(req);
          const action = String(input.action || '');
          if (action === 'prompt') {
            const request = input.request && typeof input.request === 'object' ? input.request : null;
            tab.state.appendUser(String(input.message || ''), request);
            void tab.state.generate(String(input.message || ''), { request, onChange: async () => tab.publishObservation?.('mock-api') });
          } else if (action === 'steer') await tab.state.steer(String(input.message || ''), { onChange: async () => tab.publishObservation?.('mock-api-steer') });
          else if (action === 'cancel') tab.state.cancel();
          else if (action === 'new-session') tab.state.newSession();
          else if (action === 'select-session') tab.state.selectSession(String(input.sessionId || ''));
          else if (action === 'delete-session') tab.state.deleteSession(String(input.sessionId || ''));
          else if (action === 'intelligence') tab.state.setIntelligence(input.options || {});
          else if (action === 'set-attachments') tab.state.setAttachments(input.attachments || []);
          else if (action === 'remove-attachment') tab.state.removeAttachment(String(input.attachmentId || input.name || ''));
          else if (action === 'clear-attachments') tab.state.clearAttachments();
          else { json(res, 400, { detail: `Unknown mock action: ${action || '(missing)'}` }); return; }
          await tab.publishObservation?.(`mock-api:${action}`);
        }
        json(res, 200, { ok: true, state: tab.state.publicState(), layoutUrl: tab.publicLayoutUrl?.() || '' });
        return;
      }
      const requestedSession = url.pathname.match(/^\/c\/([^/]+)$/)?.[1] || '';
      const requestedTabId = Number(url.searchParams.get('tab')) || tabs.keys().next().value;
      const tab = tabs.get(Number(requestedTabId)) || tabs.values().next().value;
      if (!tab) { json(res, 503, { detail: 'No mock tabs are connected yet' }); return; }
      if (requestedSession && requestedSession !== tab.state.sessionId) tab.state.selectSession(requestedSession);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(renderMockChatPage(tab.state.publicState()));
    } catch (error) {
      json(res, 500, { detail: error.message || String(error) });
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    origin: `http://bridge-e2e.localhost:${actualPort}`,
    loopbackOrigin: `http://${host}:${actualPort}`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}
