#!/usr/bin/env node
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { FileStore } from '../src/fileStore.js';
import { EventBus } from '../src/eventBus.js';
import { WorkflowManager } from '../src/workflow/workflowManager.js';
import { RemoteBrowserBridge } from '../src/workflow/remoteBrowserBridge.js';
import { registerWorkflowRoutes } from '../src/http/workflowRoutes.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}


if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Workflow worker

Usage:
  npm run workflow:worker -- --port <port> --workflow <path> --upstream-url <url> [options]

Options:
  --host <host>              Listen host (default: 127.0.0.1)
  --port <port>              Worker HTTP port
  --data-dir <path>          Worker state and artifact directory
  --workflow <path>          Workflow JSON configuration
  --upstream-url <url>       Primary browser bridge URL
  --upstream-token <token>   Primary bridge API token
  --api-token <token>        Worker API token
`);
  process.exit(0);
}

const host = argValue('--host', process.env.HOST || '127.0.0.1');
const port = Math.max(1, Number(argValue('--port', process.env.PORT || '0')) || 0);
const dataDir = path.resolve(argValue('--data-dir', process.env.DATA_DIR || '.bridge-data/workflow-worker'));
const workflowPath = path.resolve(argValue('--workflow', process.env.WORKFLOW_CONFIG || ''));
const upstreamUrl = argValue('--upstream-url', process.env.UPSTREAM_BRIDGE_URL || '');
const upstreamToken = argValue('--upstream-token', process.env.UPSTREAM_BRIDGE_TOKEN || '');
const apiToken = argValue('--api-token', process.env.API_TOKEN || '');

if (!port) throw new Error('workflow-worker requires --port');
if (!workflowPath) throw new Error('workflow-worker requires --workflow');
if (!upstreamUrl) throw new Error('workflow-worker requires --upstream-url');

const fileStore = new FileStore(dataDir);
const eventBus = new EventBus();
const bridge = new RemoteBrowserBridge({ baseUrl: upstreamUrl, token: upstreamToken, fileStore, eventBus });
const workflowManager = new WorkflowManager({ bridge, fileStore, eventBus, dataDir });
const app = express();
app.use(express.json({ limit: '4mb' }));
app.get('/health', (_req, res) => {
  const workflows = workflowManager.list();
  res.json({
    ok: bridge.health().ok && workflows.length > 0,
    bridge: bridge.health(),
    workflows,
    dataDir,
  });
});
app.use((req, res, next) => {
  if (!apiToken) return next();
  const auth = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (auth !== apiToken) return res.status(401).json({ detail: 'Unauthorized' });
  return next();
});
registerWorkflowRoutes(app, workflowManager);
app.use((error, _req, res, _next) => {
  console.error('[workflow-worker] request failed:', error);
  res.status(Number(error.statusCode) || 500).json({ detail: error.message || 'Internal Server Error' });
});

const server = http.createServer(app);
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[workflow-worker] stopping: ${signal}`);
  await workflowManager.close().catch(() => null);
  await bridge.close().catch(() => null);
  await new Promise((resolve) => server.close(resolve));
}
process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));

server.listen(port, host, async () => {
  try {
    await bridge.waitUntilConnected(20_000);
    const workflow = await workflowManager.load(workflowPath, { start: true, includeLatest: false });
    console.log(`[workflow-worker] READY http://${host}:${port} workflow=${workflow.id} upstream=${upstreamUrl}`);
  } catch (error) {
    console.error('[workflow-worker] startup failed:', error);
    await shutdown('startup-error');
    process.exit(1);
  }
});
