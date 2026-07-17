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
import { maybeReloadExtensionAtStartup, normalizeExtensionReloadPolicy } from './extensionStartup.js';
import {
  initWorkflowConfig,
  validateWorkflowConfig,
  workflowConfigPath,
} from './cli/workflowConfigCommands.js';
import {
  installWorkflowSignalHandler,
  parseWorkflowCli,
  waitForWorkflowRun,
  workflowCliHelp,
} from './cli/workflowRuntime.js';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json');

const args = process.argv.slice(2);
const workflowCli = parseWorkflowCli(args);
const isDebugClient = args.includes('--debug');
const isCodexStdio = args.includes('--codex-stdio');
const isWorkflowService = ['run', 'resume', 'discard', 'serve'].includes(workflowCli?.action || '');
const isServerOnly = isWorkflowService || args.includes('--server') || args.includes('--serve') || args.includes('--daemon');
const isExplicitInteractive = args.includes('--interact') || args.includes('-i') || args.includes('--interactive');
const isInteractive = !workflowCli && !isDebugClient && !isCodexStdio && !isServerOnly && (isExplicitInteractive || !args.includes('--server'));

function printCliHelp() {
  console.log(`ChatGPT Browser Bridge\n\nUsage:\n  bridge                         Start the interactive UI and local server\n  bridge workflow run [path]     Run validation/repair cycles and exit\n  bridge workflow serve [path]   Run the bridge and workflow observer without a TUI\n  bridge workflow init [path]    Create bridge.workflow.json\n  bridge workflow validate [path] Validate workflow configuration\n  bridge --server                Start only the HTTP/WebSocket server\n  bridge --debug                 Run debug client\n  bridge --codex-stdio           Run Codex-like stdio adapter\n\nOptions:\n  --project, -p <path>           Open a project for /task workflows\n  --workflow <path>              Load a workflow JSON config\n  --auto-open-tab                Open an isolated ChatGPT tab when no safe prompt tab is available\n  --no-auto-open-tab             Disable AUTO_OPEN_TAB for this process\n  --help, -h                     Show this help\n  --version, -v                  Show package version`);
}

function packageVersion() {
  return String(packageInfo.version || '0.0.0');
}

if (args.includes('--help') || args.includes('-h') || workflowCli?.action === 'help') {
  if (workflowCli) console.log(workflowCliHelp());
  else printCliHelp();
  process.exit(0);
}

const workflowActions = new Set(['init', 'validate', 'run', 'resume', 'discard', 'serve']);
if (workflowCli && !workflowActions.has(workflowCli.action)) {
  console.error(`Unknown workflow command: ${workflowCli.action}
`);
  console.error(workflowCliHelp());
  process.exit(2);
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
const workflowPathArg = workflowCli?.configPath
  ? workflowConfigPath(workflowCli.configPath)
  : argValue('--workflow') || process.env.WORKFLOW_CONFIG || (isWorkflowService ? workflowConfigPath('') : '');
const autoOpenTab = args.includes('--auto-open-tab')
  ? true
  : args.includes('--no-auto-open-tab')
    ? false
    : config.autoOpenTab;
const startupExtensionReloadPolicy = args.includes('--reload-extension')
  ? 'always'
  : args.includes('--no-reload-extension')
    ? 'never'
    : normalizeExtensionReloadPolicy(process.env.BRIDGE_STARTUP_EXTENSION_RELOAD || 'ask');

if (workflowCli?.action === 'init' || workflowCli?.action === 'validate') {
  try {
    if (workflowCli.action === 'init') {
      const result = await initWorkflowConfig(workflowCli.configPath, { force: workflowCli.force });
      console.log(`Created workflow config: ${result.path}`);
      console.log('Next: bridge workflow validate');
    } else {
      const result = await validateWorkflowConfig(workflowCli.configPath);
      console.log('Workflow configuration is valid');
      console.log(`Name:           ${result.id}`);
      console.log(`Project root:   ${result.projectRoot}`);
      console.log(`Session policy: ${result.sessionPolicy}`);
      console.log(`Restart policy: ${result.restartPolicy}`);
      console.log(`Steps:          ${result.stepCount}`);
      console.log(`Maximum cycles: ${result.maxCycles}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Workflow configuration error: ${err.message}`);
    process.exit(1);
  }
}

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
  let shuttingDown = false;
  let removeWorkflowSignalHandler = null;
  const workflowManager = new WorkflowManager({
    bridge, fileStore, eventBus, dataDir: config.dataDir, turnManager, projectService,
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
    let activeWorkflow = null;
    if (autoWorkflowPath) {
      try {
        const absoluteWorkflowPath = path.resolve(autoWorkflowPath);
        const restoredWorkflow = workflowManager.list().find((item) => path.resolve(item.configPath || '') === absoluteWorkflowPath);
        if (restoredWorkflow) {
          activeWorkflow = restoredWorkflow;
          log(`[workflow] using restored ${restoredWorkflow.id} from ${absoluteWorkflowPath}`);
        } else {
          const workflow = await workflowManager.load(absoluteWorkflowPath, {
            start: true,
            triggerAutomation: !['run', 'resume', 'discard'].includes(workflowCli?.action || ''),
          });
          activeWorkflow = workflow;
          log(`[workflow] loaded ${workflow.id} from ${absoluteWorkflowPath}`);
        }
      } catch (err) {
        logError(`[workflow] failed to load ${autoWorkflowPath}:`, err);
        if (isWorkflowService) await shutdown('workflow-load-error', 1);
      }
    }
    if (!config.apiToken) {
      log('API_TOKEN is not set. HTTP API is unprotected; keep HOST bound to 127.0.0.1.');
    }

    if (isInteractive) {
      try {
        await maybeReloadExtensionAtStartup({
          policy: startupExtensionReloadPolicy,
          mode: 'interactive',
          waitTimeoutMs: 5_000,
          getHealth: async () => bridge.health(),
          reload: async (options) => await bridge.reloadExtension(options),
          log: (level, message) => {
            const line = `[extension] ${message}`;
            if (level === 'warn') console.warn(line);
            else if (level === 'action') console.log(line);
            else console.log(line);
          },
        });
      } catch (err) {
        console.error(`[extension] Startup reload failed: ${err.message}`);
      }
    }

    if (workflowCli?.action === 'serve') {
      if (!activeWorkflow) {
        logError(`No workflow config was loaded from ${autoWorkflowPath || '(none)'}`);
        await shutdown('workflow-serve-config-missing', 1);
        return;
      }
      console.log(`Workflow service ready\nWorkflow: ${activeWorkflow.id}\nProject:  ${activeWorkflow.projectRoot}\nConfig:   ${activeWorkflow.configPath}\n\nPress Ctrl+C to stop.`);
      return;
    }

    if (workflowCli?.action === 'discard') {
      if (!activeWorkflow) {
        logError(`No workflow config was loaded from ${autoWorkflowPath || '(none)'}`);
        await shutdown('workflow-discard-config-missing', 1);
        return;
      }
      try {
        await workflowManager.discardAutomation(activeWorkflow.id, 'discarded from CLI');
        console.log(`Interrupted workflow run discarded: ${activeWorkflow.id}`);
        await shutdown('workflow-discard-completed', 0);
      } catch (err) {
        logError('Workflow discard failed:', err);
        await shutdown('workflow-discard-error', 1);
      }
      return;
    }

    if (workflowCli?.action === 'run' || workflowCli?.action === 'resume') {
      if (!activeWorkflow) {
        logError(`No workflow config was loaded from ${autoWorkflowPath || '(none)'}`);
        await shutdown('workflow-run-config-missing', 1);
        return;
      }
      try {
        if (workflowCli.action === 'run' && activeWorkflow.automationInterrupted) {
          throw new Error(`Interrupted run found for ${activeWorkflow.id}. Use \`bridge workflow resume\` or \`bridge workflow discard\`.`);
        }
        const automation = workflowCli.action === 'resume'
          ? await workflowManager.resumeAutomation(activeWorkflow.id)
          : await workflowManager.runAutomation(activeWorkflow.id, {
            verbose: workflowCli.verbose,
            maxCycles: workflowCli.maxCycles,
            sessionPolicy: workflowCli.sessionPolicy,
            sessionId: workflowCli.sessionId,
            trigger: 'cli',
          });
        console.log(`Workflow run started\nRun:      ${automation.id}\nWorkflow: ${activeWorkflow.id}\nCycle:    ${automation.cycle}/${automation.maxCycles}`);
        const result = await waitForWorkflowRun({
          manager: workflowManager,
          workflowId: activeWorkflow.id,
          approve: workflowCli.approve,
        });
        const final = result.workflow;
        if (result.ok) {
          console.log(`Workflow completed successfully\nRun:    ${final.automation.id}\nCycles: ${final.automation.cycle}/${final.automation.maxCycles}`);
          await shutdown('workflow-run-completed', 0);
        } else {
          console.error(`Workflow failed\nRun:    ${final.automation.id || '(unknown)'}\nStatus: ${final.automation.status}\nReason: ${final.automation.error || final.lastError || 'workflow did not complete'}`);
          await shutdown('workflow-run-failed', 1);
        }
      } catch (err) {
        logError('Workflow run failed:', err);
        await shutdown('workflow-run-error', err.code === 'WORKFLOW_RUN_INTERRUPTED' ? 130 : 1);
      }
      return;
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
        const interactiveResult = await runInteractive({ bridge, fileStore, turnManager, projectService, workflowManager, projectPath });
        await shutdown('interactive-exit', 0, { preserveActiveWork: Boolean(interactiveResult?.preserveActiveWork) });
      } catch (err) {
        logError('Interactive mode failed:', err);
        await shutdown('interactive-error', 1);
      }
    }
  });

  async function shutdown(signal, code = 0, options = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    removeWorkflowSignalHandler?.();
    log(`Received ${signal}, stopping ChatGPT bridge`);

    const preserveActiveWork = Boolean(options.preserveActiveWork || options.preserveWorkflowRuns);
    await workflowManager.close({ cancelActiveTurns: !preserveActiveWork });
    await bridge.close({ cancelPending: !preserveActiveWork });
    hub.close();
    codexRpcServer.close();

    await new Promise((resolve) => {
      server.close(resolve);
    });

    process.exit(code);
  }

  if (isWorkflowService) {
    removeWorkflowSignalHandler = installWorkflowSignalHandler({
      manager: workflowManager,
      shutdown,
    });
  } else if (isServerOnly && !isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT'));
  if (isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
