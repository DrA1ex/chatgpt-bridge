#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.bridge-data', '.env');

function expandHome(value = '') {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

export function readApiToken(filePath = DEFAULT_ENV_FILE) {
  const absolutePath = path.resolve(expandHome(filePath));
  let source;
  try { source = fs.readFileSync(absolutePath, 'utf8'); } catch (error) {
    throw new Error(`Cannot read bridge env file ${absolutePath}: ${error.message}`);
  }
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== 'API_TOKEN') continue;
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closing = value.indexOf(quote, 1);
      if (closing < 0) throw new Error(`Invalid API_TOKEN quoting in ${absolutePath}`);
      value = value.slice(1, closing);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (value) return value;
  }
  throw new Error(`API_TOKEN was not found in ${absolutePath}`);
}

function cookieValue(req, name) {
  const entries = String(req.headers.cookie || '').split(';').map((value) => value.trim());
  return entries.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function send(res, status, contentType, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': data.length, ...headers });
  res.end(data);
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function proxyHttp({ bridgePort, apiToken, req, res, upstreamPath, inline = false, timeoutMs = 70_000 }) {
  const upstream = http.request({
    host: '127.0.0.1', port: bridgePort, path: upstreamPath, method: 'GET',
    headers: { authorization: `Bearer ${apiToken}` }, timeout: timeoutMs,
  }, (response) => {
    const headers = {
      'content-type': response.headers['content-type'] || 'application/octet-stream',
      'cache-control': inline ? 'private, max-age=60' : 'no-store',
    };
    if (response.headers['content-length']) headers['content-length'] = response.headers['content-length'];
    if (inline) headers['content-disposition'] = 'inline';
    else if (response.headers['content-disposition']) headers['content-disposition'] = response.headers['content-disposition'];
    res.writeHead(response.statusCode || 502, headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Bridge request timed out')));
  upstream.on('error', (error) => {
    if (!res.headersSent) send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: error.message }));
    else res.destroy(error);
  });
  req.on('aborted', () => upstream.destroy());
  upstream.end();
}

function injectToken(data, isBinary, apiToken) {
  if (isBinary) return data;
  try {
    const message = JSON.parse(String(data));
    if (!message || typeof message !== 'object' || message.method === 'initialize') return data;
    message.params = message.params && typeof message.params === 'object' ? message.params : {};
    message.params.token = apiToken;
    return JSON.stringify(message);
  } catch { return data; }
}

function relayClose(target, code, reason) {
  if (target.readyState !== WebSocket.OPEN && target.readyState !== WebSocket.CONNECTING) return;
  const validCode = Number(code) >= 1000 && Number(code) <= 4999 && ![1004, 1005, 1006, 1015].includes(Number(code));
  try { validCode ? target.close(code, reason) : target.close(); } catch { target.terminate(); }
}

function bridgeWebSocket({ req, socket, head, bridgePort, apiToken, wss, session, peers }) {
  if (cookieValue(req, 'bridge_ui_session') !== session) return rejectUpgrade(socket, '403 Forbidden', 'Invalid UI session');
  const upstream = new WebSocket(`ws://127.0.0.1:${bridgePort}/codex/ws`, {
    headers: { authorization: `Bearer ${apiToken}`, origin: 'http://127.0.0.1' },
    handshakeTimeout: 5_000,
  });
  peers.add(upstream);
  let upgraded = false;
  const fail = (message) => {
    if (!upgraded && !socket.destroyed) rejectUpgrade(socket, '502 Bad Gateway', message);
    try { upstream.terminate(); } catch {}
  };
  upstream.once('error', (error) => fail(`Cannot connect to bridge WebSocket: ${error.message}`));
  upstream.once('open', () => {
    if (socket.destroyed) return upstream.close();
    wss.handleUpgrade(req, socket, head, (browser) => {
      upgraded = true;
      peers.add(browser);
      browser.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(injectToken(data, isBinary, apiToken), { binary: isBinary });
      });
      upstream.on('message', (data, isBinary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
      });
      browser.on('close', (code, reason) => { peers.delete(browser); relayClose(upstream, code, reason); });
      upstream.on('close', (code, reason) => { peers.delete(upstream); relayClose(browser, code, reason); });
      browser.on('error', () => upstream.terminate());
    });
  });
}

export async function startCodexChatUi(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 8090);
  const bridgePort = Number(options.bridgePort ?? 8080);
  const apiToken = String(options.apiToken || '');
  if (!apiToken) throw new Error('API_TOKEN is required');
  const session = crypto.randomBytes(32).toString('base64url');
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/ui.html') {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      return send(res, 200, 'text/html; charset=utf-8', html, {
        'set-cookie': `bridge_ui_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        'content-security-policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      });
    }
    if (url.pathname === '/ui-core.js') return send(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'ui-core.js')));
    if (url.pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', Buffer.alloc(0));
    if (cookieValue(req, 'bridge_ui_session') !== session) return send(res, 403, 'application/json; charset=utf-8', '{"ok":false,"error":"invalid UI session"}');
    if (url.pathname === '/bootstrap') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, wsUrl: `ws://${host}:${server.address().port}/codex/ws`, bridgePort, tokenLoaded: true }));
    if (url.pathname === '/setup/status') return proxyHttp({ bridgePort, apiToken, req, res, upstreamPath: '/setup/status', timeoutMs: 3_000 });
    if (url.pathname.startsWith('/artifact/')) {
      const artifactId = decodeURIComponent(url.pathname.slice('/artifact/'.length));
      if (!artifactId || artifactId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(artifactId)) return send(res, 400, 'text/plain; charset=utf-8', 'Invalid artifact id\n');
      return proxyHttp({ bridgePort, apiToken, req, res, upstreamPath: `/artifacts/${encodeURIComponent(artifactId)}/download`, inline: url.searchParams.has('inline') });
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
  });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', `http://${host}`).pathname; } catch {}
    if (pathname !== '/codex/ws') return rejectUpgrade(socket, '404 Not Found', 'Not found');
    bridgeWebSocket({ req, socket, head, bridgePort, apiToken, wss, session, peers });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  return {
    server, url, bridgePort,
    close: async () => {
      for (const peer of peers) {
        try { peer.terminate(); } catch {}
      }
      peers.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function parseArgs(argv) {
  const options = { port: 8090, bridgePort: 8080, envFile: DEFAULT_ENV_FILE, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') options.port = Number(argv[++index]);
    else if (value === '--bridge-port') options.bridgePort = Number(argv[++index]);
    else if (value === '--env-file') options.envFile = argv[++index];
    else if (value === '--no-open') options.open = false;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run ui:codex -- [--port 8090] [--bridge-port 8080] [--env-file PATH] [--no-open]');
    return;
  }
  const apiToken = process.env.API_TOKEN || readApiToken(options.envFile);
  const runtime = await startCodexChatUi({ ...options, apiToken });
  console.log(`Codex Chat UI: ${runtime.url}`);
  console.log(`Bridge:        http://127.0.0.1:${runtime.bridgePort}`);
  console.log(`API_TOKEN:     loaded server-side from ${path.resolve(expandHome(options.envFile))}`);
  console.log('The browser never receives API_TOKEN. Press Ctrl+C to stop.');
  if (options.open) openBrowser(runtime.url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
