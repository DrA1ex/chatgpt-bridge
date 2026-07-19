import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

async function findFreeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function resolveBridgeRuntime(options, runId, { publicBaseUrl, dataDir } = {}) {
  if (!options.baseUrl) {
    if (options.autoStartServer) {
      const port = options.port || await findFreeLoopbackPort();
      options.port = port;
      options.baseUrl = `http://127.0.0.1:${port}`;
    } else {
      options.baseUrl = publicBaseUrl;
    }
  }
  const parsed = new URL(options.baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Real E2E bridge must use loopback, got ${options.baseUrl}`);
  }
  options.port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  options.serverDataDir = path.join(dataDir, 'e2e', 'runtime', runId);
  return options;
}

export async function initializeDiagnostics(options, runId, startedAt = new Date().toISOString()) {
  await fs.rm(options.reportDir, { recursive: true, force: true });
  await fs.mkdir(options.reportDir, { recursive: true });
  const consoleLogPath = path.join(options.reportDir, 'console.log');
  await fs.writeFile(consoleLogPath, `${startedAt} [e2e] diagnostics initialized run=${runId} cwd=${process.cwd()} reportDir=${options.reportDir}\n`);
  await fs.writeFile(path.join(options.reportDir, 'RUNNING.json'), `${JSON.stringify({ runId, startedAt, cwd: process.cwd(), reportDir: options.reportDir, baseUrl: options.baseUrl, port: options.port }, null, 2)}\n`);
  return consoleLogPath;
}

export async function writeDiagnosticCheckpoint(reportDir, report, timeline) {
  await fs.mkdir(reportDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(reportDir, 'report.partial.json'), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(reportDir, 'timeline.partial.ndjson'), timeline.map((item) => JSON.stringify(item)).join('\n') + (timeline.length ? '\n' : '')),
  ]);
}
