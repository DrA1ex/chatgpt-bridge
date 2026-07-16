import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MODES = new Set(['off', 'verify', 'ask', 'auto']);
const COMMIT_MODES = new Set(['none', 'block', 'same-chat', 'new-chat']);
const CONTEXT_MODES = new Set(['identity']);
const RESTART_MODES = new Set(['none', 'exit', 'command']);
const AUTOMATION_RESTART_POLICIES = new Set(['ask', 'auto', 'discard']);
const AUTOMATION_SESSION_POLICIES = new Set(['current', 'new', 'pinned']);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function string(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function bool(value, fallback = false) { return value == null ? fallback : Boolean(value); }
function number(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function resolveFrom(baseDir, value, fallback = '') {
  const raw = string(value, fallback).trim();
  if (!raw) return '';
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

export function defaultWorkflowConfigPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), 'bridge.workflow.json');
}

function normalizeAutomationStep(value, { projectRoot, defaultTimeoutMs, defaultContinueOnFailure, index } = {}) {
  const source = typeof value === 'string' ? { command: value } : object(value);
  const command = string(source.command || source.run).trim();
  if (!command) return null;
  const env = Object.fromEntries(Object.entries(object(source.env)).map(([key, item]) => [String(key), String(item)]));
  const name = string(source.name || source.id).trim() || `step-${Number(index || 0) + 1}`;
  return {
    id: name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `step-${Number(index || 0) + 1}`,
    name,
    command,
    cwd: resolveFrom(projectRoot, source.cwd, '.'),
    timeoutMs: Math.max(1_000, number(source.timeoutMs, defaultTimeoutMs)),
    env,
    continueOnFailure: bool(source.continueOnFailure, defaultContinueOnFailure),
  };
}

function normalizeAutomationConfig(automation, { projectRoot } = {}) {
  const trigger = string(automation.trigger, 'manual').toLowerCase();
  if (!new Set(['manual', 'on-start']).has(trigger)) throw new Error(`Invalid workflow automation trigger: ${trigger}`);
  const defaultTimeoutMs = Math.max(1_000, number(automation.stepTimeoutMs, 2 * 60 * 60_000));
  const continueAfterFailure = bool(automation.continueAfterFailure, true);
  const turn = object(automation.turn);
  const session = object(automation.session);
  const diagnostics = object(automation.diagnostics);
  const project = object(automation.project);
  const onFailure = object(automation.onFailure);
  const output = object(onFailure.output);
  const action = string(onFailure.action, 'chatgpt-repair').toLowerCase();
  if (action !== 'chatgpt-repair') throw new Error(`Invalid workflow automation onFailure.action: ${action}`);
  const legacySessionId = string(turn.sessionId).trim();
  const sessionPolicy = string(session.policy, legacySessionId ? 'pinned' : 'current').toLowerCase();
  const sessionId = string(session.id || legacySessionId).trim();
  const legacyResume = automation.resumeOnRestart;
  const restartPolicy = string(
    automation.restartPolicy,
    legacyResume == null ? 'ask' : (Boolean(legacyResume) ? 'auto' : 'ask'),
  ).toLowerCase();
  if (!AUTOMATION_SESSION_POLICIES.has(sessionPolicy)) {
    throw new Error(`Invalid workflow automation session.policy: ${sessionPolicy}`);
  }
  if (sessionPolicy === 'pinned' && !sessionId) {
    throw new Error('Workflow automation session.policy=pinned requires session.id');
  }
  if (!AUTOMATION_RESTART_POLICIES.has(restartPolicy)) {
    throw new Error(`Invalid workflow automation restartPolicy: ${restartPolicy}`);
  }
  return {
    enabled: bool(automation.enabled, false),
    trigger,
    steps: array(automation.steps || automation.commands)
      .map((value, index) => normalizeAutomationStep(value, {
        projectRoot,
        defaultTimeoutMs,
        defaultContinueOnFailure: continueAfterFailure,
        index,
      }))
      .filter(Boolean),
    continueAfterFailure,
    stepTimeoutMs: defaultTimeoutMs,
    maxCycles: Math.max(1, number(automation.maxCycles, 5)),
    suspendWatcher: bool(automation.suspendWatcher, true),
    restartPolicy,
    session: {
      policy: sessionPolicy,
      id: sessionPolicy === 'pinned' ? sessionId : '',
    },
    turn: {
      timeoutMs: Math.max(60_000, number(turn.timeoutMs, 2 * 60 * 60_000)),
      pollIntervalMs: Math.max(250, number(turn.pollIntervalMs, 1_000)),
      approvalTimeoutMs: Math.max(60_000, number(turn.approvalTimeoutMs, 24 * 60 * 60_000)),
      model: string(turn.model),
      effort: string(turn.effort, 'high'),
      sourceClientId: string(turn.sourceClientId),
    },
    diagnostics: {
      reportDir: resolveFrom(projectRoot, diagnostics.reportDir, '.bridge-data/workflow-runs'),
      keepReports: Math.max(1, number(diagnostics.keepReports, 5)),
      include: array(diagnostics.include).map(String).map((value) => value.trim()).filter(Boolean),
      maxIncludedBytes: Math.max(1, number(diagnostics.maxIncludedBytes, 512 * 1024 * 1024)),
    },
    project: {
      mode: string(project.mode, 'package') || 'package',
      useGitignore: bool(project.useGitignore, true),
      snapshotPolicy: string(project.snapshotPolicy, 'always') || 'always',
      force: bool(project.force, true),
    },
    onFailure: {
      action,
      prompt: string(onFailure.prompt),
      attachProject: bool(onFailure.attachProject, true),
      attachDiagnostics: bool(onFailure.attachDiagnostics, true),
      applyResult: bool(onFailure.applyResult, true),
      output: {
        expected: string(output.expected, 'zip').toLowerCase(),
        required: bool(output.required, true),
      },
    },
  };
}

export async function loadWorkflowConfig(filePath) {
  const absolutePath = path.resolve(filePath || defaultWorkflowConfigPath());
  const baseDir = path.dirname(absolutePath);
  const raw = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  const source = object(raw);
  const watch = object(source.watch);
  const artifact = object(source.artifact);
  const verification = object(source.verification);
  const projectContext = object(source.projectContext);
  const apply = object(source.apply);
  const remediation = object(source.remediation);
  const commit = object(source.commit);
  const extensionUpdate = object(source.extensionUpdate);
  const daemonRestart = object(source.daemonRestart);
  const automation = object(source.automation);
  const mode = string(watch.mode || source.mode, 'ask').toLowerCase();
  const commitMode = string(commit.mode, 'block').toLowerCase();
  const requestedRefreshIntervalMs = Math.max(0, number(watch.refreshIntervalMs, 0));
  const contextMode = string(projectContext.mode, 'identity').toLowerCase();
  const restartMode = string(daemonRestart.mode, daemonRestart.enabled ? 'exit' : 'none').toLowerCase();
  if (!MODES.has(mode)) throw new Error(`Invalid workflow watch mode: ${mode}`);
  if (!COMMIT_MODES.has(commitMode)) throw new Error(`Invalid workflow commit mode: ${commitMode}`);
  if (!CONTEXT_MODES.has(contextMode)) throw new Error(`Invalid workflow projectContext mode: ${contextMode}`);
  if (!RESTART_MODES.has(restartMode)) throw new Error(`Invalid workflow daemonRestart mode: ${restartMode}`);

  const projectRoot = resolveFrom(baseDir, source.projectRoot, '.');
  const id = string(source.id, path.basename(projectRoot) || 'workflow').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const config = {
    version: number(source.version, 1),
    id,
    enabled: bool(source.enabled, true),
    configPath: absolutePath,
    projectRoot,
    watch: {
      mode,
      clientId: string(watch.clientId),
      sessionId: string(watch.sessionId),
      includeLatest: bool(watch.includeLatest, false),
      bindOnFirstVerifiedArtifact: bool(watch.bindOnFirstVerifiedArtifact, true),
      refreshIntervalMs: requestedRefreshIntervalMs > 0 ? Math.max(30_000, requestedRefreshIntervalMs) : 0,
    },
    artifact: {
      expected: string(artifact.expected, 'zip').toLowerCase(),
      requireSingleCandidate: bool(artifact.requireSingleCandidate, true),
      maxBytes: Math.max(1, number(artifact.maxBytes, 500 * 1024 * 1024)),
      maxEntries: Math.max(1, number(artifact.maxEntries, 50_000)),
      maxExtractedBytes: Math.max(1, number(artifact.maxExtractedBytes, 2 * 1024 * 1024 * 1024)),
    },
    projectContext: {
      enabled: bool(projectContext.enabled, true),
      mode: contextMode,
      syncOnStart: bool(projectContext.syncOnStart, true),
      syncAfterBind: bool(projectContext.syncAfterBind, true),
      fallbackFiles: array(projectContext.fallbackFiles || ['package.json', 'AGENT.MD', 'AGENTS.md', 'README.md']).map(String).filter(Boolean),
      maxBytes: Math.max(32_768, number(projectContext.maxBytes, 2 * 1024 * 1024)),
    },
    verification: {
      requiredFiles: array(verification.requiredFiles).map(String).filter(Boolean),
      packageName: string(verification.packageName),
      minProjectFileOverlap: Math.max(0, Math.min(1, number(verification.minProjectFileOverlap, 0.15))),
      commands: array(verification.commands).map(String).filter(Boolean),
      timeoutMs: Math.max(1_000, number(verification.timeoutMs, 10 * 60_000)),
      requireProjectIdentity: bool(verification.requireProjectIdentity, false),
      identityFallbackFiles: array(verification.identityFallbackFiles || projectContext.fallbackFiles || ['package.json', 'AGENT.MD', 'AGENTS.md', 'README.md']).map(String).filter(Boolean),
    },
    apply: {
      sync: bool(apply.sync, true),
      requireCleanGit: bool(apply.requireCleanGit, false),
      rollbackOnFailure: bool(apply.rollbackOnFailure, true),
      protectedPaths: array(apply.protectedPaths).map(String).filter(Boolean),
      allowedWarningCodes: array(apply.allowedWarningCodes || ['NO_REFERENCE_MANIFEST_FOR_SYNC']).map(String).filter(Boolean),
      maxChangedFiles: Math.max(1, number(apply.maxChangedFiles, 2_000)),
      maxDeletedFiles: Math.max(0, number(apply.maxDeletedFiles, 200)),
      commands: array(apply.commands || apply.postApplyCommands).map(String).filter(Boolean),
      timeoutMs: Math.max(1_000, number(apply.timeoutMs, 20 * 60_000)),
    },
    remediation: {
      enabled: bool(remediation.enabled, true),
      maxAttempts: Math.max(0, number(remediation.maxAttempts, 2)),
      sameChat: bool(remediation.sameChat, true),
      outputTailLines: Math.max(20, number(remediation.outputTailLines, 250)),
      prompt: string(remediation.prompt),
    },
    commit: {
      mode: commitMode,
      required: bool(commit.required, false),
      beginMarker: string(commit.beginMarker, 'COMMIT_MESSAGE_BEGIN'),
      endMarker: string(commit.endMarker, 'COMMIT_MESSAGE_END'),
      style: string(commit.style, 'detailed').toLowerCase(),
      prompt: string(commit.prompt),
      authorName: string(commit.authorName),
      authorEmail: string(commit.authorEmail),
      maxContextBytes: Math.max(32_768, number(commit.maxContextBytes, 2 * 1024 * 1024)),
    },
    extensionUpdate: {
      enabled: bool(extensionUpdate.enabled, false),
      sourceDir: resolveFrom(projectRoot, extensionUpdate.sourceDir, 'tools/chrome-bridge-extension'),
      targetDir: resolveFrom(projectRoot, extensionUpdate.targetDir),
      reloadTabs: bool(extensionUpdate.reloadTabs, true),
      reconnectTimeoutMs: Math.max(1_000, number(extensionUpdate.reconnectTimeoutMs, 20_000)),
      backupRetention: Math.max(1, number(extensionUpdate.backupRetention, 5)),
      rollbackOnReloadFailure: bool(extensionUpdate.rollbackOnReloadFailure, true),
    },
    daemonRestart: {
      enabled: bool(daemonRestart.enabled, false) && restartMode !== 'none',
      mode: restartMode,
      command: string(daemonRestart.command),
      delayMs: Math.max(100, number(daemonRestart.delayMs, 1_000)),
      exitCode: Math.max(1, Math.min(255, number(daemonRestart.exitCode, 75))),
      required: bool(daemonRestart.required, false),
    },
    automation: normalizeAutomationConfig(automation, { projectRoot }),
  };
  if (!config.projectRoot) throw new Error('Workflow projectRoot is required');
  if (config.automation.enabled && config.automation.onFailure.applyResult) {
    if (config.automation.onFailure.output.expected !== 'zip') {
      throw new Error('Workflow automation applyResult requires onFailure.output.expected to be zip');
    }
    if (config.watch.mode === 'verify') {
      throw new Error('Workflow automation applyResult cannot be used with watch.mode=verify');
    }
  }
  return config;
}

export function exampleWorkflowConfig() {
  return {
    version: 1,
    id: 'chatgpt-bridge-self-hosted',
    enabled: true,
    projectRoot: '.',
    watch: { mode: 'auto', sessionId: '', clientId: '', includeLatest: false, bindOnFirstVerifiedArtifact: true, refreshIntervalMs: 0 },
    artifact: { expected: 'zip', requireSingleCandidate: true },
    projectContext: { enabled: true, mode: 'identity', syncOnStart: true, syncAfterBind: true, fallbackFiles: ['package.json', 'AGENT.MD', 'README.md'] },
    verification: {
      requiredFiles: ['package.json', 'src/index.js', 'tools/chrome-bridge-extension/manifest.json'],
      packageName: 'chatgpt-browser-bridge-node',
      minProjectFileOverlap: 0.15,
      commands: [],
      requireProjectIdentity: false,
      identityFallbackFiles: ['package.json', 'AGENT.MD', 'README.md'],
    },
    apply: {
      sync: true,
      requireCleanGit: false,
      rollbackOnFailure: true,
      protectedPaths: ['.git/**', '.env*', '.bridge-data/**', 'node_modules/**'],
      allowedWarningCodes: ['NO_REFERENCE_MANIFEST_FOR_SYNC'],
      commands: ['npm test', 'npm run check'],
    },
    remediation: { enabled: true, maxAttempts: 2, sameChat: true, outputTailLines: 250 },
    commit: {
      mode: 'block',
      required: false,
      beginMarker: 'COMMIT_MESSAGE_BEGIN',
      endMarker: 'COMMIT_MESSAGE_END',
      style: 'detailed',
    },
    extensionUpdate: {
      enabled: true,
      sourceDir: 'tools/chrome-bridge-extension',
      targetDir: '',
      reloadTabs: true,
      backupRetention: 5,
      rollbackOnReloadFailure: true,
    },
    daemonRestart: { enabled: true, mode: 'exit', delayMs: 1_000, exitCode: 75, required: false },
    automation: {
      enabled: false,
      trigger: 'manual',
      maxCycles: 5,
      continueAfterFailure: true,
      restartPolicy: 'ask',
      session: { policy: 'current' },
      stepTimeoutMs: 7_200_000,
      steps: [],
      turn: {
        timeoutMs: 7_200_000,
        pollIntervalMs: 1_000,
        approvalTimeoutMs: 86_400_000,
        effort: 'high',
      },
      diagnostics: {
        reportDir: '.bridge-data/workflow-runs',
        keepReports: 5,
        include: [],
        maxIncludedBytes: 536_870_912,
      },
      project: {
        mode: 'package',
        useGitignore: true,
        snapshotPolicy: 'always',
        force: true,
      },
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
