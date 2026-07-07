import http from 'node:http';
import { config, setupInfo } from './config.js';
import { log, error as logError, setLogEnabled } from './logger.js';
import { createApp } from './server.js';
import { runInteractive } from './interactive.js';
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

const isInteractive = process.argv.includes('--interact') || process.argv.includes('-i');
const isDebugClient = process.argv.includes('--debug');
const isCodexStdio = process.argv.includes('--codex-stdio');
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}
const projectPath = argValue('--project') || argValue('-p');

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
  const bridge = new TampermonkeyBridge(hub, fileStore, eventBus);
  const projectService = new ProjectService({ fileStore, metadataStore, eventBus });
  const resultResolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus });
  const jobManager = new JobManager({ bridge, fileStore, metadataStore, resultResolver, eventBus });
  const turnManager = new TurnManager({ bridge, metadataStore, resultResolver, eventBus, projectService });
  const codexRpcServer = new CodexRpcServer({ turnManager, bridge, fileStore, metadataStore, eventBus, projectService });
  const app = createApp(bridge, fileStore, eventBus, jobManager, turnManager, projectService);
  const server = http.createServer(app);
  hub.attach(server);
  codexRpcServer.attach(server);

  if (isInteractive || isCodexStdio) setLogEnabled(false);

  log('Starting ChatGPT bridge');
  log(`Tampermonkey HTTP polling: ${config.publicBaseUrl}/tm/poll`);
  log(`Tampermonkey WebSocket: ws://127.0.0.1:${config.port}/tm/ws (optional)`);
  log(`Codex-like WebSocket: ws://127.0.0.1:${config.port}/codex/ws`);
  log(`Data directory: ${config.dataDir}`);
  log(`Metadata store: ${metadataStore.dbPath || metadataStore.jsonPath}`);
  if (setupInfo.generated.length) log(`[setup] Generated ${setupInfo.generated.join(', ')} in ${setupInfo.path}`);
  log(`[setup] Open ${config.publicBaseUrl}/setup to configure the Tampermonkey userscript.`);

  server.on('error', (err) => {
    logError('HTTP server failed:', err);
    process.exit(1);
  });

  server.listen(config.port, config.host, async () => {
    log(`HTTP server listening on http://${config.host}:${config.port}`);
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
        await runInteractive({ bridge, fileStore, turnManager, projectService, projectPath });
        await shutdown('interactive-exit', 0);
      } catch (err) {
        logError('Interactive mode failed:', err);
        await shutdown('interactive-error', 1);
      }
    }
  });

  async function shutdown(signal, code = 0) {
    log(`Received ${signal}, stopping ChatGPT bridge`);

    await bridge.close();
    hub.close();
    codexRpcServer.close();

    await new Promise((resolve) => {
      server.close(resolve);
    });

    process.exit(code);
  }

  if (!isInteractive && !isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT'));
  if (isCodexStdio) process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
