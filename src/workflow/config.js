import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const MODES = new Set(['off', 'verify', 'ask', 'auto']);
const COMMIT_MODES = new Set(['none', 'block', 'same-chat', 'new-chat']);
const CONTEXT_MODES = new Set(['identity']);
const RESTART_MODES = new Set(['none', 'exit', 'command']);

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
  };
  if (!config.projectRoot) throw new Error('Workflow projectRoot is required');
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
  };
}
