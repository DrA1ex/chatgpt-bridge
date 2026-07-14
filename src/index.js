#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, setupInfo } from './config.js';
import { log, error as logError, setLogEnabled } from './logger.js';
import { createApp } from './server.js';
import { runInteractive, runLegacyInteractive } from './interactive.js';
import { runDebugClient } from './debugClient.js';
import { TampermonkeyHub } from './tampermonkeyHub.js';
import { TampermonkeyBridge } from './tampermonkeyBridge.js';
import { FileStore } from './fileStore.js';
import { EventBus } from './eventBus.js';
import { MetadataStore } from './metadataStore.js';
import { ResultResolver } from './resultResolver.js';
import { JobManager } from './jobManager.js';
import { TurnManager } from './turnManager.js';
import { CodexRpcServer, runCodexStdio } from './codexRpcServer.js';
import { ProjectService } from './projectService.js';
import { WorkflowManager } from './workflow/workflowManager.js';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json');

const args = process.argv.slice(2);
const isDebugClient = args.includes('--debug');
const isCodexStdio = args.includes('--codex-stdio');
const isLegacyInteractive = args.includes('--legacy');
const isServerOnly = args.includes('--server') || args.includes('--serve') || args.includes('--daemon');
const isExplicitInteractive = args.includes('--interact') || args.includes('-i') || args.includes('--interactive');
const isInteractive = !isDebugClient && !isCodexStdio && !isServerOnly && (isExplicitInteractive || isLegacyInteractive || !args.includes('--server'));

function printCliHelp() {
  console.log(`ChatGPT Browser Bridge\n\nUsage:\n  bridge                  Start the Ink interactive UI and local server\n  bridge --legacy         Start the legacy readline interactive shell\n  bridge --server         Start only the HTTP/WebSocket server\n  bridge --debug          Run debug client\n  bridge --codex-stdio    Run Codex-like stdio adapter\n\nOptions:\n  --project, -p <path>    Open a project for /task workflows\n  --workflow <path>       Load a passive artifact workflow JSON config\n  --auto-open-tab         Open an isolated ChatGPT tab when no safe prompt tab is available\n  --no-auto-open-tab      Disable AUTO_OPEN_TAB for this process\n  --help, -h              Show this help\n  --version, -v           Show package version`);
}

function packageVersion() {
  return String(packageInfo.version || '0.0.0');
}

if (args.includes('--help') || args.includes('-h')) {
  printCliHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(packageVersion());
  process.exit(0);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}
const projectPath = argValue('--project') || argValue('-p');
const workflowPathArg = argValue('--workflow') || process.env.WORKFLOW_CONFIG || '';
const autoOpenTab = args.includes('--auto-open-tab')
  ? true
  : args.includes('--no-auto-open-tab')
    ? false
    : config.autoOpenTab;

if (isDebugClient) {
  setLogEnabled(false);
  runDebugClient().catch((err) => {
    console.error(`DEBUG ERROR: ${err.message}`);
    process.exit(1);
  });
} else {
  const eventBus = new EventBus({ limit: config.debugEventsLimit });
  const hub = new TampermonkeyHub(eventBus);
  const fileStore = new FileStore();
  const metadataStore = new MetadataStore();
  const bridge = new TampermonkeyBridge(hub, fileStore, eventBus, { autoOpenTab, publicBaseUrl: config.publicBaseUrl });
  const projectService = new ProjectService({ fileStore, metadataStore, eventBus });
  const resultResolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus });
  const jobManager = new JobManager({ bridge, fileStore, metadataStore, resultResolver, eventBus });
  const turnManager = new TurnManager({ bridge, metadataStore, resultResolver, eventBus, projectService });
  const workflowManager = new WorkflowManager({ bridge, fileStore, eventBus, dataDir: config.dataDir });
  const codexRpcServer = new CodexRpcServer({ turnManager, bridge, fileStore, metadataStore, eventBus, projectService });
  const app = createApp(bridge, fileStore, eventBus, jobManager, turnManager, projectService, workflowManager);
  const server = http.createServer(app);
  hub.attach(server);
  codexRpcServer.attach(server);

  if (isInteractive || isCodexStdio) setLogEnabled(false);

  log('Starting ChatGPT bridge');
  log(`Extension WebSocket: ws://127.0.0.1:${config.port}/tm/ws`);
  log(`Codex-like WebSocket: ws://127.0.0.1:${config.port}/codex/ws`);
  log(`Data directory: ${config.dataDir}`);
  log(`Metadata store: ${metadataStore.dbPath || metadataStore.jsonPath}`);
  if (setupInfo.generated.length) log(`[setup] Generated ${setupInfo.generated.join(', ')} in ${setupInfo.path}`);
  log(`[setup] Open ${config.publicBaseUrl}/setup to configure the browser extension.`);

  server.on('error', (err) => {
    logError('HTTP server failed:', err);
    process.exit(1);
  });

  server.listen(config.port, config.host, async () => {
    log(`HTTP server listening on http://${config.host}:${config.port}`);
    try {
      const restored = await workflowManager.restore();
      if (restored.length) log(`[workflow] restored ${restored.length} persisted workflow(s)`);
    } catch (err) {
      logError('[workflow] failed to restore persisted workflows:', err);
    }
    const autoWorkflowPath = workflowPathArg || (projectPath && fs.existsSync(path.join(path.resolve(projectPath), 'bridge.workflow.json')) ? path.join(path.resolve(projectPath), 'bridge.workflow.json') : '');
    if (autoWorkflowPath) {
      try {
        const workflow = await workflowManager.load(autoWorkflowPath, { start: true });
        log(`[workflow] loaded ${workflow.id} from ${autoWorkflowPath}`);
      } catch (err) {
        logError(`[workflow] failed to load ${autoWorkflowPath}:`, err);
      }
    }
    if (!config.apiToken) {
      log('API_TOKEN is not set. HTTP API is unprotected; keep HOST bound to 127.0.0.1.');
    }

    if (isCodexStdio) {
      try {
        await runCodexStdio(codexRpcServer);
        await shutdown('codex-stdio-exit', 0);
      } catch (err) {
        logError('Codex stdio mode failed:', err);
        await shutdown('codex-stdio-error', 1);
      }
    }

    if (isInteractive) {
      try {
        const runner = isLegacyInteractive ? runLegacyInteractive : runInteractive;
        await runner({ bridge, fileStore, turnManager, projectService, workflowManager, projectPath });
        await shutdown('interactive-exit', 0);
      } catch (err) {
        logError('Interactive mode failed:', err);
        await shutdown('interactive-error', 1);
      }
    }
  });

  async function shutdown(signal, code = 0) {
    log(`Received ${signal}, stopping ChatGPT bridge`);

    await workflowManager.close();
    await bridge.close();
    hub.close();
    codexRpcServer.close();

    await new Promise((resolve) => {
      server.close(resolve);
    });

    process.exit(code);
  }

  if (isServerOnly && !isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT'));
  if (isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
