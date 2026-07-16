import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWorkflowConfigPath, loadWorkflowConfig } from '../workflow/config.js';

export function workflowConfigPath(value = '', cwd = process.cwd()) {
  return path.resolve(value || defaultWorkflowConfigPath(cwd));
}

async function exists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

async function detectProject(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (await exists(packagePath)) {
    const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    const scripts = pkg.scripts || {};
    const steps = [];
    if (scripts.test) steps.push({ name: 'Tests', command: 'npm test', timeoutMs: 7_200_000 });
    if (scripts.check) steps.push({ name: 'Source checks', command: 'npm run check', timeoutMs: 1_200_000 });
    return { requiredFiles: ['package.json'], packageName: String(pkg.name || ''), steps };
  }
  if (await exists(path.join(projectRoot, 'pyproject.toml'))) {
    return { requiredFiles: ['pyproject.toml'], packageName: '', steps: [{ name: 'Tests', command: 'python -m pytest', timeoutMs: 7_200_000 }] };
  }
  if (await exists(path.join(projectRoot, 'Cargo.toml'))) {
    return { requiredFiles: ['Cargo.toml'], packageName: '', steps: [{ name: 'Tests', command: 'cargo test', timeoutMs: 7_200_000 }] };
  }
  if (await exists(path.join(projectRoot, 'go.mod'))) {
    return { requiredFiles: ['go.mod'], packageName: '', steps: [{ name: 'Tests', command: 'go test ./...', timeoutMs: 7_200_000 }] };
  }
  return { requiredFiles: [], packageName: '', steps: [] };
}

export async function starterWorkflowConfig(projectRoot, id = '') {
  const root = path.resolve(projectRoot || process.cwd());
  const detected = await detectProject(root);
  return {
    version: 1,
    id: id || `${path.basename(root) || 'project'}-workflow`,
    enabled: true,
    projectRoot: '.',
    watch: {
      mode: 'ask',
      sessionId: '',
      clientId: '',
      includeLatest: false,
      bindOnFirstVerifiedArtifact: true,
      refreshIntervalMs: 0,
    },
    artifact: { expected: 'zip', requireSingleCandidate: true },
    projectContext: {
      enabled: true,
      mode: 'identity',
      syncOnStart: true,
      syncAfterBind: true,
      fallbackFiles: detected.requiredFiles.length ? detected.requiredFiles : ['README.md'],
    },
    verification: {
      requiredFiles: detected.requiredFiles,
      packageName: detected.packageName,
      minProjectFileOverlap: 0.15,
      commands: [],
      requireProjectIdentity: false,
      identityFallbackFiles: detected.requiredFiles.length ? detected.requiredFiles : ['README.md'],
    },
    apply: {
      sync: true,
      requireCleanGit: false,
      rollbackOnFailure: true,
      protectedPaths: ['.git/**', '.env*', '.bridge-data/**', 'node_modules/**'],
      allowedWarningCodes: ['NO_REFERENCE_MANIFEST_FOR_SYNC'],
      commands: [],
    },
    remediation: { enabled: true, maxAttempts: 2, sameChat: true, outputTailLines: 250 },
    commit: { mode: 'none', required: false },
    extensionUpdate: { enabled: false },
    daemonRestart: { enabled: false },
    automation: {
      enabled: detected.steps.length > 0,
      trigger: 'manual',
      restartPolicy: 'ask',
      session: { policy: 'current' },
      maxCycles: 5,
      continueAfterFailure: true,
      stepTimeoutMs: 7_200_000,
      steps: detected.steps,
      turn: { timeoutMs: 7_200_000, pollIntervalMs: 1_000, approvalTimeoutMs: 86_400_000, effort: 'high' },
      diagnostics: { reportDir: '.bridge-data/workflow-runs', keepReports: 5, include: [], maxIncludedBytes: 536_870_912 },
      project: { mode: 'package', useGitignore: true, snapshotPolicy: 'always', force: true },
      onFailure: {
        action: 'chatgpt-repair',
        attachProject: true,
        attachDiagnostics: true,
        applyResult: true,
        output: { expected: 'zip', required: true },
      },
    },
  };
}

export async function initWorkflowConfig(filePath = '', options = {}) {
  const target = workflowConfigPath(filePath, options.cwd);
  const existing = await fs.stat(target).catch(() => null);
  if (existing && !options.force) {
    throw new Error(`Workflow config already exists: ${target}. Use --force to overwrite it.`);
  }
  const value = await starterWorkflowConfig(path.dirname(target));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { path: target, config: value };
}

export async function validateWorkflowConfig(filePath = '', options = {}) {
  const target = workflowConfigPath(filePath, options.cwd);
  const config = await loadWorkflowConfig(target);
  return {
    path: target,
    id: config.id,
    projectRoot: config.projectRoot,
    sessionPolicy: config.automation.session.policy,
    restartPolicy: config.automation.restartPolicy,
    stepCount: config.automation.steps.length,
    maxCycles: config.automation.maxCycles,
    automationEnabled: config.automation.enabled,
  };
}
