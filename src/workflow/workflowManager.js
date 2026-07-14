import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log, error as logError } from '../logger.js';
import { artifactMatchesResponseScope, looksLikeZipArtifact, selectRequiredZipCompletionCandidate, summarizeArtifact } from '../results/artifacts.js';
import { loadWorkflowConfig } from './config.js';
import { WorkflowStore } from './store.js';
import { ArtifactVerifier } from './artifactVerifier.js';
import { TransactionalApplier } from './transaction.js';
import { ExtensionDeployer } from './extensionDeployer.js';
import { buildCommitContext, createGitCommit, extractMarkedBlock, inspectGitRepository } from './gitCommit.js';
import { ensureProjectIdentity, writeProjectFingerprint, PROJECT_IDENTITY_RELATIVE_PATH, PROJECT_FINGERPRINT_RELATIVE_PATH } from '../projectIdentity.js';
import { writeZip } from '../zipWriter.js';
import { matchesProjectContextAcknowledgement } from './contextAcknowledgement.js';

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`; }
function tailLines(text, count = 250) { return String(text || '').split(/\r?\n/).slice(-count).join('\n'); }
function boundedText(value, maxChars = 200_000) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated by workflow state store]` : text;
}
function compactValue(value, depth = 0) {
  if (typeof value === 'string') return boundedText(value, 16_000);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 5) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}
function commandSummary(commands = {}) {
  return {
    ok: Boolean(commands?.ok),
    results: Array.isArray(commands?.results) ? commands.results.map((item) => ({
      command: item.command,
      cwd: item.cwd,
      ok: item.ok,
      code: item.code,
      signal: item.signal,
      timedOut: item.timedOut,
      durationMs: item.durationMs,
      stdout: boundedText(item.stdout, 20_000),
      stderr: boundedText(item.stderr, 20_000),
      error: boundedText(item.error, 4_000),
    })) : [],
  };
}
function verificationSummary(verification = {}) {
  return {
    ok: Boolean(verification.ok),
    reasons: Array.isArray(verification.reasons) ? verification.reasons.slice(0, 100) : [],
    zip: verification.zip ? {
      ok: verification.zip.ok,
      name: verification.zip.name,
      size: verification.zip.size,
      entries: verification.zip.entries,
      totalUncompressedSize: verification.zip.totalUncompressedSize,
      sha256: verification.zip.sha256,
    } : null,
    zipPath: verification.zipPath || '',
    stagingRoot: verification.stagingRoot || '',
    stripPrefix: verification.stripPrefix || '',
    outputFileCount: Array.isArray(verification.outputFiles) ? verification.outputFiles.length : 0,
    currentFileCount: Array.isArray(verification.currentFiles) ? verification.currentFiles.length : 0,
    outputFilesPreview: Array.isArray(verification.outputFiles) ? verification.outputFiles.slice(0, 100) : [],
    overlapScore: verification.overlapScore,
    expectedPackageName: verification.expectedPackageName || '',
    outputPackageName: verification.outputPackageName || '',
    projectIdentity: verification.projectIdentity || null,
    projectFingerprintSha256: verification.projectFingerprintSha256 || '',
    artifactProjectId: verification.artifactProjectId || '',
    identityStatus: verification.identityStatus || '',
    identityFallback: Array.isArray(verification.identityFallback) ? verification.identityFallback.slice(0, 50) : [],
    commands: commandSummary(verification.commands),
    verifiedAt: verification.verifiedAt || '',
  };
}
function applicationSummary(applied = {}) {
  const fileResult = applied.applied || {};
  const written = Array.isArray(fileResult.written) ? fileResult.written : [];
  const deleted = Array.isArray(fileResult.deleted) ? fileResult.deleted : [];
  return {
    ok: Boolean(applied.ok),
    appliedAt: applied.appliedAt || '',
    backupRoot: applied.backupRoot || '',
    rollbackEntryCount: Array.isArray(applied.manifest) ? applied.manifest.length : 0,
    files: {
      writtenCount: written.length,
      deletedCount: deleted.length,
      writtenPreview: written.slice(0, 100).map((item) => item.path || item),
      deletedPreview: deleted.slice(0, 100).map((item) => item.path || item),
    },
    commands: commandSummary(applied.commands),
  };
}

function applyPlanSummary(plan = {}) {
  const body = plan.plan || {};
  return {
    policyOk: Boolean(plan.policyOk),
    policyReasons: Array.isArray(plan.policyReasons) ? plan.policyReasons.slice(0, 100) : [],
    requiresConfirmation: Boolean(plan.requiresConfirmation),
    changedFiles: plan.changedFiles || 0,
    counts: {
      create: body.filesToCreate || 0,
      update: (body.filesToUpdate || 0) + (body.filesLocallyChanged || 0),
      delete: (body.filesToDelete || 0) + (body.filesLocallyChangedDelete || 0),
      unchanged: body.filesUnchanged || 0,
    },
    writePathsPreview: Array.isArray(body.written) ? body.written.slice(0, 100).map((item) => item.path) : [],
    deletePathsPreview: [
      ...(Array.isArray(body.delete) ? body.delete : []),
      ...(Array.isArray(body.localChangedDelete) ? body.localChangedDelete : []),
    ].slice(0, 100).map((item) => item.path),
  };
}
function responseScope(response = {}) { return { turnKey: response.turnKey || response.sourceTurnKey || '', requestId: response.requestId || '', candidateIndex: response.candidateIndex || 0 }; }

export class WorkflowManager {
  constructor({ bridge, fileStore, eventBus = null, dataDir, workflowStore = null, restartHandler = null } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.eventBus = eventBus;
    this.dataDir = dataDir;
    this.store = workflowStore || new WorkflowStore(dataDir);
    this.restartHandler = typeof restartHandler === 'function' ? restartHandler : null;
    this.workflows = new Map();
    this.queues = new Map();
    this.projectQueues = new Map();
    this.refreshTimers = new Map();
    this.unsubscribe = bridge.onObservedTurn((turn) => this.#handleObservedTurn(turn));
    this.verifier = new ArtifactVerifier({ dataDir, event: (type, data) => this.#event('', type, data) });
    this.applier = new TransactionalApplier({ dataDir, event: (type, data) => this.#event('', type, data) });
    this.extensionDeployer = new ExtensionDeployer({ bridge, dataDir, event: (type, data) => this.#event('', type, data) });
  }

  async close({ timeoutMs = 30_000 } = {}) {
    this.unsubscribe?.();
    for (const timer of this.refreshTimers.values()) clearInterval(timer);
    this.refreshTimers.clear();
    const pending = Array.from(new Set(this.projectQueues.values()));
    if (!pending.length) return { drained: true, pending: 0 };
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ drained: false, pending: pending.length }), Math.max(0, Number(timeoutMs) || 0));
      timer.unref?.();
    });
    const drained = Promise.allSettled(pending).then(() => ({ drained: true, pending: 0 }));
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  async restore() {
    const saved = await this.store.listWorkflows();
    const restored = [];
    for (const item of saved) {
      if (!item?.configPath) continue;
      try {
        const restoredWorkflow = await this.load(item.configPath, {
          start: item.status !== 'stopped',
          includeLatest: false,
        });
        const runtime = this.workflows.get(restoredWorkflow.id);
        if (runtime) {
          const interrupted = item.status === 'processing' || item.status === 'recovering';
          runtime.status = item.status === 'stopped'
            ? 'stopped'
            : item.status === 'awaiting-approval'
              ? 'awaiting-approval'
              : interrupted
                ? 'recovering'
                : 'watching';
          runtime.lastObservedTurnKey = String(item.lastObservedTurnKey || '');
          runtime.lastSourceClientId = String(item.lastSourceClientId || '');
          runtime.lastSessionId = String(item.lastSessionId || '');
          runtime.boundSourceClientId = String(item.boundSourceClientId || '');
          runtime.boundSessionId = String(item.boundSessionId || '');
          runtime.lastPipelineId = String(item.lastPipelineId || '');
          runtime.lastError = String(item.lastError || '');
          runtime.projectId = String(item.projectId || runtime.projectId || '');
          runtime.projectFingerprintSha256 = String(item.projectFingerprintSha256 || runtime.projectFingerprintSha256 || '');
          runtime.contextSyncedSessionId = String(item.contextSyncedSessionId || '');
          runtime.contextSyncFingerprint = String(item.contextSyncFingerprint || '');
          runtime.updatedAt = nowIso();
          await this.store.setWorkflow(runtime.id, this.#public(runtime));
          if (interrupted) await this.#recoverInterruptedPipeline(runtime);
          this.#syncRefreshTimer(runtime);
          restored.push(this.#public(runtime));
        }
      } catch (error) {
        await this.#event(item.id || '', 'workflow.restore.failed', { configPath: item.configPath, message: error.message || String(error) });
      }
    }
    await this.#acknowledgeRestartIntent().catch((error) => this.#event('', 'workflow.daemon.restart.ack.failed', { message: error.message || String(error) }));
    return restored;
  }

  async load(configPath, { start = true, includeLatest = true } = {}) {
    const config = await loadWorkflowConfig(configPath);
    const projectIdentity = await ensureProjectIdentity(config.projectRoot, { packageName: config.verification.packageName });
    const projectFingerprint = await writeProjectFingerprint(config.projectRoot, { identity: projectIdentity, files: config.projectContext.fallbackFiles });
    const conflicting = Array.from(this.workflows.values()).find((item) => item.id !== config.id && path.resolve(item.config.projectRoot) === path.resolve(config.projectRoot));
    if (conflicting) throw new Error(`Project root is already managed by workflow ${conflicting.id}: ${config.projectRoot}`);
    const runtime = {
      id: config.id,
      config,
      configPath: config.configPath,
      status: start && config.enabled ? 'watching' : 'stopped',
      loadedAt: nowIso(),
      updatedAt: nowIso(),
      lastObservedTurnKey: '',
      lastSourceClientId: '',
      lastSessionId: '',
      boundSourceClientId: '',
      boundSessionId: '',
      lastPipelineId: '',
      lastError: '',
      projectId: projectIdentity.projectId,
      projectFingerprintSha256: projectFingerprint.fingerprintSha256,
      contextSyncedSessionId: '',
      contextSyncFingerprint: '',
    };
    this.workflows.set(config.id, runtime);
    await this.store.setWorkflow(config.id, this.#public(runtime));
    this.#syncRefreshTimer(runtime);
    await this.#event(config.id, 'workflow.loaded', { configPath: config.configPath, projectRoot: config.projectRoot, projectId: runtime.projectId, mode: config.watch.mode, status: runtime.status });
    if (start && config.enabled && config.projectContext.enabled && config.projectContext.syncOnStart && config.watch.sessionId) {
      this.#enqueue(config.id, () => this.#syncProjectContext(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(config.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    if (includeLatest && start && config.enabled && config.watch.includeLatest) {
      this.#enqueue(config.id, async () => {
        try {
          const response = await this.bridge.recoverLatestResponse({ sourceClientId: config.watch.clientId || undefined, index: 1 });
          if (!config.watch.sessionId || response.session?.id === config.watch.sessionId) await this.#processResponse(config.id, response, { source: 'include-latest', remediationAttempt: 0 });
        } catch (error) {
          await this.#failRuntime(config.id, error);
        }
      });
    }
    return this.#public(runtime);
  }

  async unload(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) return false;
    runtime.status = 'stopped';
    runtime.updatedAt = nowIso();
    this.workflows.delete(workflowId);
    this.#clearRefreshTimer(workflowId);
    await this.store.removeWorkflow(workflowId);
    await this.#event(workflowId, 'workflow.unloaded', {});
    return true;
  }

  async start(workflowId) {
    const runtime = this.#require(workflowId);
    runtime.status = 'watching';
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(workflowId, this.#public(runtime));
    this.#syncRefreshTimer(runtime);
    await this.#event(workflowId, 'workflow.started', {});
    if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncOnStart) {
      this.#enqueue(runtime.id, () => this.#syncProjectContext(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(runtime.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    return this.#public(runtime);
  }

  async stop(workflowId) {
    const runtime = this.#require(workflowId);
    runtime.status = 'stopped';
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(workflowId, this.#public(runtime));
    this.#clearRefreshTimer(workflowId);
    await this.#event(workflowId, 'workflow.stopped', {});
    return this.#public(runtime);
  }

  list() { return Array.from(this.workflows.values()).map((runtime) => this.#public(runtime)); }
  get(workflowId) { const runtime = this.workflows.get(workflowId); return runtime ? this.#public(runtime) : null; }
  async approvals() { return await this.store.listApprovals({ status: 'pending' }); }
  async events(workflowId, limit = 200) { return await this.store.listEvents({ workflowId, limit }); }

  async approve(approvalId) {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Unknown workflow approval: ${approvalId}`);
    if (approval.status !== 'pending') throw new Error(`Workflow approval is not pending: ${approval.status}`);
    const runtime = this.#require(approval.workflowId);
    approval.status = 'approved'; approval.decidedAt = nowIso();
    await this.store.setApproval(approvalId, approval);
    return await this.#enqueue(runtime.id, () => this.#resumeApproved(runtime, approval));
  }

  async reject(approvalId, reason = 'rejected by user') {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Unknown workflow approval: ${approvalId}`);
    approval.status = 'rejected'; approval.reason = reason; approval.decidedAt = nowIso();
    await this.store.setApproval(approvalId, approval);
    const runtime = this.workflows.get(approval.workflowId);
    if (runtime) {
      runtime.status = 'watching';
      runtime.lastError = '';
      runtime.updatedAt = nowIso();
      this.#syncRefreshTimer(runtime);
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
    }
    await this.#event(approval.workflowId, 'workflow.approval.rejected', { approvalId, reason });
    return approval;
  }

  async verifyArtifact(workflowId, { artifactId = '', fileId = '' } = {}) {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(workflowId, async () => {
      const pipelineId = id('verify');
      let resolvedFileId = String(fileId || '');
      if (!resolvedFileId) {
        if (!artifactId) throw new Error('artifactId or fileId is required');
        const fetched = await this.bridge.fetchArtifact(artifactId, { sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '' });
        resolvedFileId = fetched.id || artifactId;
      }
      const readable = await this.fileStore.getReadable(resolvedFileId);
      if (!readable?.absolutePath) throw new Error(`Artifact file cannot be opened from FileStore: ${resolvedFileId}`);
      await this.#event(workflowId, 'workflow.manual.verify.started', { pipelineId, artifactId, fileId: resolvedFileId });
      const verification = await this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId });
      await this.#event(workflowId, verification.ok ? 'workflow.manual.verify.completed' : 'workflow.manual.verify.failed', {
        pipelineId,
        artifactId,
        fileId: resolvedFileId,
        ok: verification.ok,
        reasons: verification.reasons,
        sha256: verification.zip?.sha256 || '',
        entries: verification.zip?.entries || 0,
        overlapScore: verification.overlapScore,
      });
      return verification;
    });
  }

  async deployExtension(workflowId) {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(workflowId, async () => {
      await this.#event(workflowId, 'workflow.extension.update.started', {});
      const pipelineId = id('extension');
      const backup = await this.extensionDeployer.prepareBackup(runtime.config, { pipelineId });
      const result = await this.extensionDeployer.deploy(runtime.config, { sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '', pipelineId, backup });
      await this.#event(workflowId, 'workflow.extension.update.completed', result);
      return result;
    });
  }

  async #handleObservedTurn(turn) {
    const matched = Array.from(this.workflows.values()).filter((runtime) => {
      const cfg = runtime.config;
      if (runtime.status === 'stopped' || cfg.watch.mode === 'off') return false;
      const effectiveClientId = cfg.watch.clientId || runtime.boundSourceClientId || '';
      const effectiveSessionId = cfg.watch.sessionId || runtime.boundSessionId || '';
      const turnClientId = String(turn.sourceClientId || '');
      const turnSessionId = String(turn.sessionId || turn.session?.id || '');
      if (effectiveClientId && effectiveClientId !== turnClientId) return false;
      if (effectiveSessionId && effectiveSessionId !== turnSessionId) return false;
      return true;
    });
    for (const runtime of matched) {
      this.#enqueue(runtime.id, () => this.#processObserved(runtime, turn)).catch((error) => this.#failRuntime(runtime.id, error));
    }
  }

  async #processObserved(runtime, turn) {
    runtime.lastObservedTurnKey = String(turn.turnKey || '');
    runtime.lastSourceClientId = String(turn.sourceClientId || runtime.lastSourceClientId || '');
    runtime.lastSessionId = String(turn.sessionId || turn.session?.id || runtime.lastSessionId || '');
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, 'workflow.turn.observed', { turnKey: turn.turnKey || '', sessionId: turn.sessionId || '', sourceClientId: turn.sourceClientId || '', artifactCount: turn.artifacts?.length || 0 });
    return await this.#processResponse(runtime.id, turn, { source: 'passive-observer', remediationAttempt: 0 });
  }

  async #processResponse(workflowId, response, context = {}) {
    const runtime = this.#require(workflowId);
    const artifacts = this.bridge.registerObservedArtifacts(response.artifacts || [], {
      sourceClientId: response.sourceClientId || runtime.config.watch.clientId,
      turnKey: response.turnKey || '',
      sessionId: response.session?.id || response.sessionId || '',
    });
    await this.#event(workflowId, 'workflow.artifacts.discovered', { count: artifacts.length, artifacts: artifacts.map(summarizeArtifact), source: context.source || '' });
    const scope = responseScope(response);
    if (runtime.config.artifact.requireSingleCandidate) {
      const explicitZipCandidates = artifacts.filter((artifact) => looksLikeZipArtifact(artifact) && artifactMatchesResponseScope(artifact, scope));
      if (explicitZipCandidates.length > 1) {
        await this.#event(workflowId, 'workflow.artifact.ambiguous', { reason: 'multiple_explicit_zip_candidates', candidates: explicitZipCandidates.map(summarizeArtifact) });
        return { status: 'ambiguous-artifacts', candidates: explicitZipCandidates.map(summarizeArtifact) };
      }
    }
    const selected = selectRequiredZipCompletionCandidate(artifacts, scope);
    if (!selected.artifact) {
      await this.#event(workflowId, 'workflow.artifact.skipped', { reason: selected.reason || 'no suitable ZIP', candidates: selected.candidates || [] });
      return { status: 'no-artifact', reason: selected.reason || 'no suitable ZIP' };
    }
    return await this.#processArtifact(runtime, response, selected.artifact, context);
  }

  async #processArtifact(runtime, response, artifact, context = {}) {
    const workflow = runtime.config;
    const pipelineId = id('pipeline');
    runtime.status = 'processing';
    runtime.lastPipelineId = pipelineId;
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, 'workflow.artifact.download.started', { pipelineId, artifact: summarizeArtifact(artifact) });
    const fetched = await this.bridge.fetchArtifact(artifact.id, { sourceClientId: artifact.sourceClientId || response.sourceClientId || workflow.watch.clientId });
    const readable = await this.fileStore.getReadable(fetched.id || artifact.id);
    if (!readable?.absolutePath) throw new Error(`Downloaded artifact cannot be opened from FileStore: ${fetched.id || artifact.id}`);
    await this.#event(runtime.id, 'workflow.artifact.download.completed', { pipelineId, fileId: fetched.id, name: fetched.name, size: fetched.size });

    await this.#event(runtime.id, 'workflow.artifact.verify.started', { pipelineId, fileId: fetched.id });
    const verification = await this.verifier.verify({ workflow, artifactFile: readable, pipelineId });
    const digest = String(verification.zip?.sha256 || fetched.sha256 || artifact.sha256 || '').trim();
    const artifactKey = digest
      ? `${runtime.id}:sha256:${digest}`
      : `${runtime.id}:turn:${response.turnKey || artifact.sourceTurnKey || ''}:artifact:${artifact.id}`;
    if (verification.ok) await this.#bindVerifiedSource(runtime, response, artifact);
    const previous = await this.store.getArtifact(artifactKey);
    if (previous && ['applied', 'verified', 'pending-approval'].includes(previous.status)) {
      await this.#event(runtime.id, 'workflow.artifact.duplicate', { pipelineId, artifactKey, sha256: digest, previousStatus: previous.status });
      runtime.status = 'watching'; runtime.lastError = ''; runtime.updatedAt = nowIso();
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
      return { status: 'duplicate', artifactKey, sha256: digest };
    }
    await this.store.setArtifact(artifactKey, {
      workflowId: runtime.id,
      pipelineId,
      artifactKey,
      sha256: digest,
      artifactId: artifact.id,
      fileId: fetched.id,
      turnKey: response.turnKey || '',
      sessionId: response.session?.id || response.sessionId || '',
      sourceClientId: response.sourceClientId || artifact.sourceClientId || '',
      status: verification.ok ? 'verified' : 'invalid',
      verification: verificationSummary(verification),
      answer: boundedText(response.answer || ''),
      createdAt: nowIso(),
      remediationAttempt: context.remediationAttempt || 0,
    });
    await this.#event(runtime.id, verification.ok ? 'workflow.artifact.verify.completed' : 'workflow.artifact.verify.failed', { pipelineId, ok: verification.ok, reasons: verification.reasons, overlapScore: verification.overlapScore, entries: verification.zip.entries, identityStatus: verification.identityStatus, projectId: verification.projectIdentity?.projectId || '', artifactProjectId: verification.artifactProjectId || '', identityFallback: verification.identityFallback || [] });
    if (!verification.ok) {
      runtime.status = 'watching'; runtime.lastError = verification.reasons.join('; '); await this.store.setWorkflow(runtime.id, this.#public(runtime));
      return { status: 'invalid', verification };
    }
    if (workflow.watch.mode === 'verify') {
      runtime.status = 'watching'; runtime.lastError = ''; await this.store.setWorkflow(runtime.id, this.#public(runtime));
      return { status: 'verified', verification };
    }

    const plan = await this.applier.plan({ workflow, verification });
    await this.#event(runtime.id, 'workflow.apply.plan', { pipelineId, policyOk: plan.policyOk, reasons: plan.policyReasons, create: plan.plan.filesToCreate, update: plan.plan.filesToUpdate + plan.plan.filesLocallyChanged, delete: plan.plan.filesToDelete + plan.plan.filesLocallyChangedDelete, unchanged: plan.plan.filesUnchanged });
    const shouldAsk = workflow.watch.mode === 'ask' || !plan.policyOk || plan.requiresConfirmation;
    if (shouldAsk) {
      const approvalId = id('approval');
      const approval = {
        id: approvalId,
        workflowId: runtime.id,
        pipelineId,
        artifactKey,
        artifactId: artifact.id,
        fileId: fetched.id,
        status: 'pending',
        createdAt: nowIso(),
        response: {
          answer: boundedText(response.answer || ''),
          turnKey: response.turnKey || '',
          session: response.session || null,
          sessionId: response.sessionId || '',
          sourceClientId: response.sourceClientId || '',
        },
        plan: applyPlanSummary(plan),
      };
      await this.store.setApproval(approvalId, approval);
      await this.store.setArtifact(artifactKey, { ...(await this.store.getArtifact(artifactKey)), status: 'pending-approval', approvalId });
      await this.#event(runtime.id, 'workflow.approval.required', { approvalId, pipelineId, reason: workflow.watch.mode === 'ask' ? 'ask-mode' : 'policy-warning' });
      runtime.status = 'awaiting-approval'; await this.store.setWorkflow(runtime.id, this.#public(runtime));
      return { status: 'pending-approval', approvalId };
    }

    return await this.#applyVerified(runtime, { pipelineId, artifactKey, response, artifact, fetched, verification, plan, remediationAttempt: context.remediationAttempt || 0 });
  }

  async #resumeApproved(runtime, approval) {
    const artifactState = await this.store.getArtifact(approval.artifactKey);
    if (!artifactState) throw new Error(`Approval artifact state is missing: ${approval.artifactKey}`);
    const readable = await this.fileStore.getReadable(approval.fileId);
    if (!readable?.absolutePath) throw new Error(`Approval artifact file is missing: ${approval.fileId}`);
    const verification = await this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId: approval.pipelineId });
    if (!verification.ok) throw new Error(`Artifact no longer verifies: ${verification.reasons.join('; ')}`);
    const plan = await this.applier.plan({ workflow: runtime.config, verification });
    return await this.#applyVerified(runtime, { pipelineId: approval.pipelineId, artifactKey: approval.artifactKey, response: approval.response || {}, artifact: { id: approval.artifactId }, fetched: { id: approval.fileId }, verification, plan, remediationAttempt: artifactState.remediationAttempt || 0 });
  }

  async #applyVerified(runtime, state) {
    const workflow = runtime.config;
    await this.#event(runtime.id, 'workflow.apply.started', { pipelineId: state.pipelineId });
    const preApplyGit = workflow.commit.mode === 'none'
      ? null
      : await inspectGitRepository(workflow.projectRoot);
    let extensionBackup = { available: false, reason: 'disabled' };
    if (workflow.extensionUpdate.enabled) {
      extensionBackup = await this.extensionDeployer.prepareBackup(workflow, { pipelineId: state.pipelineId });
    }
    let applied;
    try {
      applied = await this.applier.apply({ workflow, verification: state.verification, plan: state.plan, pipelineId: state.pipelineId });
      await this.#event(runtime.id, 'workflow.apply.completed', {
        pipelineId: state.pipelineId,
        written: applied.applied.written.length,
        deleted: applied.applied.deleted.length,
        commands: applied.commands.results.map((item) => ({ command: item.command, ok: item.ok, code: item.code, durationMs: item.durationMs })),
      });
    } catch (error) {
      const commandResults = error.commandResults || error.workflowApply?.commands?.results || [];
      await this.#event(runtime.id, 'workflow.apply.failed', {
        pipelineId: state.pipelineId,
        message: error.message,
        rollback: error.workflowApply?.rollback || null,
        commands: commandResults.map((item) => ({ command: item.command, ok: item.ok, code: item.code })),
      });
      const attempt = Number(state.remediationAttempt || 0);
      if (workflow.remediation.enabled && attempt < workflow.remediation.maxAttempts) {
        return await this.#remediate(runtime, state, error, attempt + 1);
      }
      runtime.status = 'watching';
      runtime.lastError = error.message;
      runtime.updatedAt = nowIso();
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
      throw error;
    }

    let commit = { committed: false, reason: 'disabled' };
    let commitError = null;
    try {
      commit = await this.#maybeCommit(runtime, state.response, state.pipelineId, { preApplyGit });
    } catch (error) {
      commitError = error;
      commit = { committed: false, reason: 'commit-failed', error: error.message || String(error) };
      await this.#event(runtime.id, 'workflow.commit.failed', {
        pipelineId: state.pipelineId,
        message: commit.error,
        code: error.code || '',
      });
    }

    const extensionUpdate = await this.extensionDeployer.deploy(workflow, {
      sourceClientId: state.response.sourceClientId || workflow.watch.clientId,
      pipelineId: state.pipelineId,
      backup: extensionBackup,
    }).catch((error) => ({ updated: false, error: error.message, rollback: error.extensionRollback || null, backup: extensionBackup }));
    if (extensionUpdate.updated || extensionUpdate.error) {
      await this.#event(runtime.id, extensionUpdate.error ? 'workflow.extension.update.failed' : 'workflow.extension.update.completed', {
        pipelineId: state.pipelineId,
        ...extensionUpdate,
      });
    }

    const warnings = [commitError?.message, extensionUpdate.error].filter(Boolean);
    await this.store.setArtifact(state.artifactKey, {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'applied',
      appliedAt: nowIso(),
      applied: applicationSummary(applied),
      commit,
      extensionUpdate,
      warnings,
    });
    runtime.status = 'watching';
    runtime.lastError = warnings.join('; ');
    runtime.updatedAt = nowIso();
    this.#syncRefreshTimer(runtime);
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, warnings.length ? 'workflow.completed_with_warnings' : 'workflow.completed', {
      pipelineId: state.pipelineId,
      commit: commit.committed ? commit.sha : '',
      extensionUpdated: Boolean(extensionUpdate.updated),
      warnings,
    });
    const daemonRestart = await this.#requestDaemonRestart(runtime, state, { extensionUpdate, warnings });
    if (daemonRestart.requested) {
      await this.store.setArtifact(state.artifactKey, {
        ...(await this.store.getArtifact(state.artifactKey)),
        daemonRestart: {
          requested: true,
          mode: daemonRestart.mode,
          delayMs: daemonRestart.delayMs,
          exitCode: daemonRestart.exitCode,
          requestedAt: nowIso(),
        },
      });
    }
    return {
      status: warnings.length ? 'applied-with-warnings' : 'applied',
      applied: applicationSummary(applied),
      commit,
      extensionUpdate,
      daemonRestart,
      warnings,
    };
  }

  async #requestDaemonRestart(runtime, state, { extensionUpdate = null, warnings = [] } = {}) {
    const cfg = runtime.config.daemonRestart;
    if (!cfg?.enabled) return { requested: false, reason: 'disabled' };
    if (!this.restartHandler) {
      const message = 'Daemon restart is enabled, but no restart handler is configured';
      await this.#event(runtime.id, 'workflow.daemon.restart.failed', { pipelineId: state.pipelineId, message });
      if (cfg.required) throw new Error(message);
      return { requested: false, reason: 'handler-unavailable', message };
    }
    const request = {
      workflowId: runtime.id,
      pipelineId: state.pipelineId,
      mode: cfg.mode,
      command: cfg.command,
      delayMs: cfg.delayMs,
      exitCode: cfg.exitCode,
      projectRoot: runtime.config.projectRoot,
      expectedPackageVersion: await fs.readFile(path.join(runtime.config.projectRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version || '').catch(() => ''),
      extensionUpdated: Boolean(extensionUpdate?.updated),
      warnings,
      requestedAt: nowIso(),
    };
    const intentPath = path.join(this.dataDir, 'workflows', 'restart-request.json');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(intentPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await this.#event(runtime.id, 'workflow.daemon.restart.requested', request);
    await this.restartHandler(request);
    return { requested: true, mode: cfg.mode, delayMs: cfg.delayMs, exitCode: cfg.exitCode, intentPath };
  }

  async #remediate(runtime, state, error, attempt) {
    const workflow = runtime.config;
    const commandResults = error.commandResults || error.workflowApply?.commands?.results || [];
    const output = commandResults.map((item) => [`$ ${item.command}`, item.stdout, item.stderr].filter(Boolean).join('\n')).join('\n\n');
    const prompt = workflow.remediation.prompt || [
      'The project artifact was downloaded and applied transactionally, but the configured validation commands failed. The project was rolled back.',
      `This is remediation attempt ${attempt} of ${workflow.remediation.maxAttempts}.`,
      '',
      'Fix the project based on the validation output below and return a new downloadable ZIP containing the full updated project at the archive root.',
      'Do not return only a patch. Preserve unrelated project files.',
      '',
      'VALIDATION_OUTPUT_BEGIN',
      tailLines(output || error.message, workflow.remediation.outputTailLines),
      'VALIDATION_OUTPUT_END',
    ].join('\n');
    await this.#event(runtime.id, 'workflow.remediation.prompt.started', { pipelineId: state.pipelineId, attempt, sessionId: state.response.session?.id || state.response.sessionId || '' });
    const sameChat = workflow.remediation.sameChat !== false;
    const response = await this.bridge.sendRequest({
      message: prompt,
      sessionId: sameChat ? (state.response.session?.id || state.response.sessionId || workflow.watch.sessionId || '') : '',
      sourceClientId: state.response.sourceClientId || workflow.watch.clientId || '',
      newSession: !sameChat,
      effort: 'instant',
      output: { expected: 'zip', required: true },
      fullResponse: true,
    });
    await this.#event(runtime.id, 'workflow.remediation.response.completed', { attempt, artifactCount: response.artifacts?.length || 0, turnKey: response.turnKey || '' });
    return await this.#processResponse(runtime.id, response, { source: 'remediation', remediationAttempt: attempt });
  }

  async #maybeCommit(runtime, sourceResponse, pipelineId, { preApplyGit = null } = {}) {
    const cfg = runtime.config.commit;
    if (cfg.mode === 'none') return { committed: false, reason: 'disabled' };
    if (preApplyGit?.available && preApplyGit.dirty) {
      const reason = 'pre-existing Git changes were present before artifact application';
      if (cfg.required) throw new Error(`Git commit is required but unsafe: ${reason}`);
      await this.#event(runtime.id, 'workflow.commit.skipped', { pipelineId, committed: false, reason: 'preexisting-changes' });
      return { committed: false, reason: 'preexisting-changes' };
    }
    const gitInfo = await inspectGitRepository(runtime.config.projectRoot);
    if (!gitInfo.available) {
      const reason = gitInfo.reason || 'git-unavailable';
      if (cfg.required) throw new Error(`Git commit is required but the repository is unavailable: ${reason}`);
      return { committed: false, reason };
    }
    if (!gitInfo.dirty) {
      await this.#event(runtime.id, 'workflow.commit.skipped', { pipelineId, committed: false, reason: 'no-changes' });
      return { committed: false, reason: 'no-changes' };
    }
    let answer = String(sourceResponse.answer || '');
    if (cfg.mode === 'same-chat' || cfg.mode === 'new-chat') {
      const prompt = cfg.prompt || [
        'Write a Git commit message for the completed project changes.',
        `Return only the message between exact markers ${cfg.beginMarker} and ${cfg.endMarker}.`,
        cfg.style === 'short' ? 'Use one concise subject line.' : 'Use a concise subject line and an optional explanatory body.',
      ].join('\n');
      if (cfg.mode === 'same-chat') {
        const response = await this.bridge.sendRequest({ message: prompt, sessionId: sourceResponse.session?.id || sourceResponse.sessionId || runtime.config.watch.sessionId || '', sourceClientId: sourceResponse.sourceClientId || runtime.config.watch.clientId || '', effort: 'instant', fullResponse: true });
        answer = response.answer || '';
      } else {
        const contextPath = path.join(this.dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'commit-context.txt');
        await buildCommitContext(runtime.config.projectRoot, contextPath, { maxBytes: cfg.maxContextBytes });
        const attachment = await this.fileStore.importLocalPath({ filePath: contextPath, name: 'commit-context.txt', mime: 'text/plain' });
        const response = await this.bridge.sendRequest({ message: prompt, attachments: [attachment.id], newSession: true, effort: 'instant', fullResponse: true });
        answer = response.answer || '';
        if (response.session?.id && response.session.id !== 'new') await this.bridge.deleteSession(response.session.id, { sourceClientId: response.sourceClientId || runtime.config.watch.clientId, expectedUrl: response.session.url || response.url || '' }).catch(() => {});
      }
    }
    const message = extractMarkedBlock(answer, cfg.beginMarker, cfg.endMarker);
    if (!message) {
      if (cfg.required) throw new Error(`Commit message block is required but missing (${cfg.beginMarker} ... ${cfg.endMarker})`);
      return { committed: false, reason: 'marker-block-missing' };
    }
    const result = await createGitCommit({ root: runtime.config.projectRoot, message, authorName: cfg.authorName, authorEmail: cfg.authorEmail });
    if (!result.committed && cfg.required) throw new Error(`Git commit is required but was not created: ${result.reason || 'unknown reason'}`);
    await this.#event(runtime.id, result.committed ? 'workflow.commit.completed' : 'workflow.commit.skipped', { pipelineId, ...result });
    return result;
  }

  async #bindVerifiedSource(runtime, response, artifact = {}) {
    if (!runtime.config.watch.bindOnFirstVerifiedArtifact) return false;
    let changed = false;
    const sourceClientId = String(response.sourceClientId || artifact.sourceClientId || '');
    const sessionId = String(response.session?.id || response.sessionId || '');
    if (!runtime.config.watch.clientId && !runtime.boundSourceClientId && sourceClientId) {
      runtime.boundSourceClientId = sourceClientId;
      changed = true;
    }
    if (!runtime.config.watch.sessionId && !runtime.boundSessionId && sessionId) {
      runtime.boundSessionId = sessionId;
      changed = true;
    }
    if (!changed) return false;
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, 'workflow.watch.bound', {
      sourceClientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
      reason: 'first-verified-artifact',
    });
    this.#syncRefreshTimer(runtime);
    if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncAfterBind) {
      try {
        await this.#syncProjectContext(runtime, { reason: 'first-verified-artifact' });
      } catch (error) {
        await this.#event(runtime.id, 'workflow.context.sync.failed', {
          reason: 'first-verified-artifact',
          message: error.message || String(error),
        });
      }
    }
    return true;
  }

  async #syncProjectContext(runtime, { reason = 'manual' } = {}) {
    const cfg = runtime.config.projectContext;
    if (!cfg?.enabled) return { synced: false, reason: 'disabled' };
    const sessionId = runtime.config.watch.sessionId || runtime.boundSessionId || runtime.lastSessionId || '';
    const sourceClientId = runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '';
    if (!sessionId || !sourceClientId) return { synced: false, reason: 'unbound' };
    const identity = await ensureProjectIdentity(runtime.config.projectRoot, { packageName: runtime.config.verification.packageName });
    const fingerprint = await writeProjectFingerprint(runtime.config.projectRoot, { identity, files: cfg.fallbackFiles });
    if (runtime.contextSyncedSessionId === sessionId && runtime.contextSyncFingerprint === fingerprint.fingerprintSha256) {
      return { synced: false, reason: 'already-synced', sessionId, projectId: identity.projectId };
    }
    const contextDir = path.join(this.dataDir, 'workflows', runtime.id, 'context');
    await fs.mkdir(contextDir, { recursive: true });
    const zipPath = path.join(contextDir, `project-context-${fingerprint.fingerprintSha256.slice(0, 16)}.zip`);
    const entries = [
      { name: PROJECT_IDENTITY_RELATIVE_PATH, data: JSON.stringify(identity, null, 2) },
      { name: PROJECT_FINGERPRINT_RELATIVE_PATH, data: JSON.stringify(fingerprint, null, 2) },
    ];
    let includedBytes = Buffer.byteLength(entries[0].data) + Buffer.byteLength(entries[1].data);
    for (const rel of cfg.fallbackFiles) {
      const absolute = path.resolve(runtime.config.projectRoot, rel);
      const root = path.resolve(runtime.config.projectRoot);
      if (!absolute.startsWith(`${root}${path.sep}`)) continue;
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.size > cfg.maxBytes || includedBytes + stat.size > cfg.maxBytes) continue;
      entries.push({ name: `project/${String(rel).replace(/\\/g, '/')}`, path: absolute });
      includedBytes += stat.size;
    }
    await writeZip(zipPath, entries);
    const attachment = await this.fileStore.importLocalPath({ filePath: zipPath, name: path.basename(zipPath), mime: 'application/zip' });
    const marker = `PROJECT_CONTEXT_SYNCED_${identity.projectId}`;
    await this.#event(runtime.id, 'workflow.context.sync.started', { reason, sessionId, projectId: identity.projectId, fingerprintSha256: fingerprint.fingerprintSha256, attachment: attachment.name });
    const response = await this.bridge.sendRequest({
      message: [
        'This attachment identifies the local project managed by ChatGPT Browser Bridge.',
        `The stable project id is ${identity.projectId}.`,
        `Preserve ${PROJECT_IDENTITY_RELATIVE_PATH} unchanged in every full-project ZIP artifact for this project.`,
        'Use the attached fallback project files only to identify the project; do not treat this message as a request to modify it.',
        `Reply exactly ${marker}.`,
      ].join('\n'),
      attachments: [attachment.id],
      sessionId,
      sourceClientId,
      effort: 'instant',
      fullResponse: true,
    });
    if (!matchesProjectContextAcknowledgement(response.answer, marker)) throw new Error(`Project context acknowledgement mismatch: ${response.answer || ''}`);
    runtime.contextSyncedSessionId = sessionId;
    runtime.contextSyncFingerprint = fingerprint.fingerprintSha256;
    runtime.projectId = identity.projectId;
    runtime.projectFingerprintSha256 = fingerprint.fingerprintSha256;
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, 'workflow.context.sync.completed', { reason, sessionId, projectId: identity.projectId, fingerprintSha256: fingerprint.fingerprintSha256 });
    return { synced: true, sessionId, projectId: identity.projectId, fingerprintSha256: fingerprint.fingerprintSha256 };
  }

  async #acknowledgeRestartIntent() {
    const intentPath = path.join(this.dataDir, 'workflows', 'restart-request.json');
    const intent = await fs.readFile(intentPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!intent?.workflowId) return null;
    const runtime = this.workflows.get(intent.workflowId);
    const actualPackageVersion = await fs.readFile(path.join(intent.projectRoot || runtime?.config?.projectRoot || process.cwd(), 'package.json'), 'utf8')
      .then((text) => JSON.parse(text).version || '')
      .catch(() => '');
    await this.#event(intent.workflowId, 'workflow.daemon.restart.completed', {
      ...intent,
      actualPackageVersion,
      versionMatched: !intent.expectedPackageVersion || intent.expectedPackageVersion === actualPackageVersion,
      completedAt: nowIso(),
    });
    await fs.rm(intentPath, { force: true });
    return intent;
  }

  async #recoverInterruptedPipeline(runtime) {
    const pipelineId = String(runtime.lastPipelineId || '');
    if (!pipelineId || !/^[a-zA-Z0-9._-]+$/.test(pipelineId)) {
      runtime.status = 'watching';
      runtime.lastError = pipelineId ? 'Interrupted pipeline id is invalid; no automatic rollback was attempted' : '';
      runtime.updatedAt = nowIso();
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
      await this.#event(runtime.id, 'workflow.interrupted.detected', { pipelineId, rollbackAvailable: false });
      return;
    }
    const rollbackRoot = path.resolve(this.dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'rollback');
    const manifestPath = path.join(rollbackRoot, 'manifest.json');
    const manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!Array.isArray(manifest)) {
      runtime.status = 'watching';
      runtime.lastError = '';
      runtime.updatedAt = nowIso();
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
      await this.#event(runtime.id, 'workflow.interrupted.detected', { pipelineId, rollbackAvailable: false });
      return;
    }
    const projectRoot = path.resolve(runtime.config.projectRoot);
    const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
    const safeManifest = manifest.every((entry) => {
      const rel = String(entry?.path || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return false;
      if (!within(projectRoot, path.resolve(projectRoot, rel))) return false;
      if (entry.exists && entry.type === 'file') {
        const backupPath = path.resolve(String(entry.backupPath || ''));
        if (!within(rollbackRoot, backupPath)) return false;
      }
      return true;
    });
    if (!safeManifest) {
      runtime.status = 'stopped';
      runtime.lastError = `Interrupted pipeline ${pipelineId} has an unsafe rollback manifest`;
      runtime.updatedAt = nowIso();
      await this.store.setWorkflow(runtime.id, this.#public(runtime));
      await this.#event(runtime.id, 'workflow.interrupted.rollback.failed', { pipelineId, message: runtime.lastError });
      return;
    }
    const rollback = await this.applier.rollback({ workflow: runtime.config, manifest });
    runtime.status = rollback.ok ? 'watching' : 'stopped';
    runtime.lastError = rollback.ok ? '' : `Interrupted pipeline rollback failed for ${rollback.errors.length} path(s)`;
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, this.#public(runtime));
    await this.#event(runtime.id, rollback.ok ? 'workflow.interrupted.rollback.completed' : 'workflow.interrupted.rollback.failed', {
      pipelineId,
      rollback,
    });
  }

  #enqueue(workflowId, task) {
    const runtime = this.workflows.get(workflowId);
    const projectKey = runtime?.config?.projectRoot
      ? path.resolve(runtime.config.projectRoot)
      : `workflow:${workflowId}`;
    const previous = this.projectQueues.get(projectKey) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
      if (this.projectQueues.get(projectKey) === tracked) this.projectQueues.delete(projectKey);
      if (this.queues.get(workflowId) === tracked) this.queues.delete(workflowId);
    });
    this.projectQueues.set(projectKey, tracked);
    this.queues.set(workflowId, tracked);
    return tracked;
  }

  #clearRefreshTimer(workflowId) {
    const timer = this.refreshTimers.get(workflowId);
    if (timer) clearInterval(timer);
    this.refreshTimers.delete(workflowId);
  }

  #syncRefreshTimer(runtime) {
    this.#clearRefreshTimer(runtime.id);
    const intervalMs = Number(runtime.config.watch.refreshIntervalMs) || 0;
    if (runtime.status !== 'watching' || intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (runtime.status !== 'watching' || this.queues.has(runtime.id)) return;
      this.#event(runtime.id, 'workflow.watch.refresh.started', { intervalMs }).catch(() => {});
      this.bridge.reloadBrowserTab({
        sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
        reason: `workflow ${runtime.id} periodic refresh`,
        timeoutMs: Math.min(10_000, Math.max(3_000, Math.floor(intervalMs / 2))),
      }).then((result) => this.#event(runtime.id, 'workflow.watch.refresh.requested', { intervalMs, result }))
        .catch((error) => this.#event(runtime.id, 'workflow.watch.refresh.failed', { intervalMs, message: error.message || String(error) }));
    }, intervalMs);
    timer.unref?.();
    this.refreshTimers.set(runtime.id, timer);
  }

  #require(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) throw new Error(`Unknown workflow: ${workflowId}`);
    return runtime;
  }

  #public(runtime) {
    return {
      id: runtime.id,
      configPath: runtime.configPath,
      projectRoot: runtime.config.projectRoot,
      mode: runtime.config.watch.mode,
      clientId: runtime.config.watch.clientId,
      sessionId: runtime.config.watch.sessionId,
      status: runtime.status,
      loadedAt: runtime.loadedAt,
      updatedAt: runtime.updatedAt,
      lastObservedTurnKey: runtime.lastObservedTurnKey,
      lastSourceClientId: runtime.lastSourceClientId,
      lastSessionId: runtime.lastSessionId,
      boundSourceClientId: runtime.boundSourceClientId,
      boundSessionId: runtime.boundSessionId,
      lastPipelineId: runtime.lastPipelineId,
      lastError: runtime.lastError,
      projectId: runtime.projectId || '',
      projectFingerprintSha256: runtime.projectFingerprintSha256 || '',
      contextSyncedSessionId: runtime.contextSyncedSessionId || '',
      contextSyncFingerprint: runtime.contextSyncFingerprint || '',
    };
  }

  async #failRuntime(workflowId, error) {
    const runtime = this.workflows.get(workflowId);
    if (runtime) {
      runtime.status = 'watching';
      runtime.lastError = error.message || String(error);
      runtime.updatedAt = nowIso();
      await this.store.setWorkflow(workflowId, this.#public(runtime)).catch(() => {});
    }
    await this.#event(workflowId, 'workflow.failed', { message: error.message || String(error), code: error.code || '' });
    logError(`[workflow:${workflowId}] ${error.stack || error.message || error}`);
  }

  async #event(workflowId, type, data = {}) {
    const event = { id: id('workflow-event'), workflowId, type, time: nowIso(), data: compactValue(data) };
    await this.store.appendEvent(event).catch(() => {});
    this.eventBus?.emitUser({ type, data: { workflowId, ...data } });
    const summary = JSON.stringify(data, (key, value) => typeof value === 'string' && value.length > 400 ? `${value.slice(0, 400)}…` : value);
    log(`[workflow:${workflowId || 'global'}] ${type}${summary && summary !== '{}' ? ` ${summary}` : ''}`);
    return event;
  }
}
