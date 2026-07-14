import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso } from '../support/workflowValues.js';

export async function acknowledgeRestartIntent({ dataDir, getRuntime, publish }) {
  const intentPath = path.join(dataDir, 'workflows', 'restart-request.json');
  const intent = await fs.readFile(intentPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!intent?.workflowId) return null;
  const runtime = getRuntime(intent.workflowId);
  const projectRoot = intent.projectRoot || runtime?.config?.projectRoot || process.cwd();
  const actualPackageVersion = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text).version || '')
    .catch(() => '');
  await publish(intent.workflowId, 'workflow.daemon.restart.completed', {
    ...intent,
    actualPackageVersion,
    versionMatched: !intent.expectedPackageVersion || intent.expectedPackageVersion === actualPackageVersion,
    completedAt: nowIso(),
  });
  await fs.rm(intentPath, { force: true });
  return intent;
}
