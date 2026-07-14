#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { config, setupInfo } from './config.js';
import { log, error as logError, setLogEnabled } from './logger.js';
import { createApp } from './server.js';
import { runInteractive } from './interactive.js';
import { runDebugClient } from './debugClient.js';
import { BrowserExtensionHub } from './browserExtensionHub.js';
import { BrowserBridge } from './browserBridge.js';
import { FileStore } from './fileStore.js';
import { EventBus } from './eventBus.js';
import { MetadataStore } from './metadataStore.js';
import { ResultResolver } from './resultResolver.js';
import { TurnManager } from './turnManager.js';
import { CodexRpcServer, runCodexStdio } from './codexRpcServer.js';
import { ProjectService } from './projectService.js';
import { WorkflowManager } from './workflow/workflowManager.js';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json');

const args = process.argv.slice(2);
const isDebugClient = args.includes('--debug');
const isCodexStdio = args.includes('--codex-stdio');
const isServerOnly = args.includes('--server') || args.includes('--serve') || args.includes('--daemon');
const isExplicitInteractive = args.includes('--interact') || args.includes('-i') || args.includes('--interactive');
const isInteractive = !isDebugClient && !isCodexStdio && !isServerOnly && (isExplicitInteractive || !args.includes('--server'));

function printCliHelp() {
  console.log(`ChatGPT Browser Bridge\n\nUsage:\n  bridge                  Start the Ink interactive UI and local server\n  bridge --server         Start only the HTTP/WebSocket server\n  bridge --debug          Run debug client\n  bridge --codex-stdio    Run Codex-like stdio adapter\n\nOptions:\n  --project, -p <path>    Open a project for /task workflows\n  --workflow <path>       Load a passive artifact workflow JSON config\n  --auto-open-tab         Open an isolated ChatGPT tab when no safe prompt tab is available\n  --no-auto-open-tab      Disable AUTO_OPEN_TAB for this process\n  --help, -h              Show this help\n  --version, -v           Show package version`);
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
  const hub = new BrowserExtensionHub(eventBus);
  const fileStore = new FileStore();
  const metadataStore = new MetadataStore();
  const bridge = new BrowserBridge(hub, fileStore, eventBus, { autoOpenTab, publicBaseUrl: config.publicBaseUrl });
  const projectService = new ProjectService({ fileStore, metadataStore, eventBus });
  const resultResolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus });
  const turnManager = new TurnManager({ bridge, metadataStore, resultResolver, eventBus, projectService });
  let restartScheduled = false;
  const workflowManager = new WorkflowManager({
    bridge, fileStore, eventBus, dataDir: config.dataDir,
    restartHandler: async (request) => {
      if (restartScheduled) return { scheduled: true, duplicate: true };
      restartScheduled = true;
      log(`[workflow] daemon restart scheduled in ${request.delayMs}ms via ${request.mode}`);
      const timer = setTimeout(async () => {
        if (request.mode === 'command' && request.command) {
          try {
            const child = spawn(request.command, { cwd: request.projectRoot || process.cwd(), shell: true, detached: true, stdio: 'ignore' });
            child.unref();
          } catch (err) {
            logError('[workflow] failed to launch daemon restart command:', err);
          }
          await shutdown('workflow-restart-command', 0);
          return;
        }
        await shutdown('workflow-restart', Number(request.exitCode) || 75);
      }, Math.max(100, Number(request.delayMs) || 1000));
      timer.unref?.();
      return { scheduled: true, mode: request.mode, delayMs: request.delayMs };
    },
  });
  const codexRpcServer = new CodexRpcServer({ turnManager, bridge, fileStore, metadataStore, eventBus, projectService });
  const app = createApp(bridge, fileStore, eventBus, turnManager, projectService, workflowManager);
  const server = http.createServer(app);
  hub.attach(server);
  codexRpcServer.attach(server);

  if (isInteractive || isCodexStdio) setLogEnabled(false);

  log('Starting ChatGPT bridge');
  log(`Extension WebSocket: ws://127.0.0.1:${config.port}/extension/ws`);
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
        const absoluteWorkflowPath = path.resolve(autoWorkflowPath);
        const restoredWorkflow = workflowManager.list().find((item) => path.resolve(item.configPath || '') === absoluteWorkflowPath);
        if (restoredWorkflow) {
          log(`[workflow] using restored ${restoredWorkflow.id} from ${absoluteWorkflowPath}`);
        } else {
          const workflow = await workflowManager.load(absoluteWorkflowPath, { start: true });
          log(`[workflow] loaded ${workflow.id} from ${absoluteWorkflowPath}`);
        }
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
        await runInteractive({ bridge, fileStore, turnManager, projectService, workflowManager, projectPath });
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
