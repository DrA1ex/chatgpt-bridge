import fs from 'node:fs/promises';
import path from 'node:path';
import { planZipApply } from '../project/apply/planner.js';
import { applyZipToProject } from '../project/apply/runner.js';
import { matchSimpleGlob } from '../project/service/ignoreRules.js';
import { runWorkflowCommands } from './commandRunner.js';

function protectedReason(rel, patterns = []) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  for (const pattern of patterns) if (matchSimpleGlob(pattern, normalized, false)) return pattern;
  return '';
}

async function pathState(absolute) {
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return { exists: false, type: 'missing' };
  if (stat.isSymbolicLink()) return { exists: true, type: 'symlink' };
  if (stat.isFile()) return { exists: true, type: 'file', mode: stat.mode };
  if (stat.isDirectory()) return { exists: true, type: 'directory', mode: stat.mode };
  return { exists: true, type: 'other' };
}

export class TransactionalApplier {
  constructor({ dataDir, event = null } = {}) {
    this.dataDir = dataDir;
    this.event = event;
  }

  async plan({ workflow, verification }) {
    const plan = await planZipApply({
      zipPath: verification.zipPath,
      projectRoot: workflow.projectRoot,
      options: {
        sync: workflow.apply.sync,
        zipValidation: {
          maxEntries: workflow.artifact.maxEntries,
          maxUncompressedSize: workflow.artifact.maxExtractedBytes,
        },
        excludedWritePaths: [workflow.resultProtocol?.manifest || 'bridge-result.json', 'bridge-workflow-instructions.md'],
        excludedWritePrefixes: ['.bridge/'],
      },
    });
    const changed = plan.plan.filesToCreate + plan.plan.filesToUpdate + plan.plan.filesLocallyChanged + plan.plan.filesToDelete + plan.plan.filesLocallyChangedDelete;
    const protectedFiles = [
      ...plan.plan.written.map((item) => item.path),
      ...plan.plan.delete.map((item) => item.path),
      ...plan.plan.localChangedDelete.map((item) => item.path),
    ].map((rel) => ({ path: rel, pattern: protectedReason(rel, workflow.apply.protectedPaths) })).filter((item) => item.pattern);
    const allowedWarnings = new Set(workflow.apply.allowedWarningCodes || []);
    const plannerWarnings = Array.isArray(plan.safety?.warnings) ? plan.safety.warnings : [];
    const warningAllowed = (warning) => {
      const code = String(warning?.code || '');
      if (allowedWarnings.has(code)) return true;
      if (code === 'NO_GIT_OR_GIT_STATUS_FAILED' && !workflow.apply.requireCleanGit) return true;
      return false;
    };
    const blockingWarnings = plannerWarnings.filter((warning) => !warningAllowed(warning));
    const reasons = [];
    if (blockingWarnings.length) reasons.push(`planner warnings require approval: ${blockingWarnings.map((warning) => warning.code || warning.message).join(', ')}`);
    if (changed > workflow.apply.maxChangedFiles) reasons.push(`too many changed files: ${changed} > ${workflow.apply.maxChangedFiles}`);
    if (plan.plan.filesToDelete + plan.plan.filesLocallyChangedDelete > workflow.apply.maxDeletedFiles) reasons.push(`too many deleted files: ${plan.plan.filesToDelete + plan.plan.filesLocallyChangedDelete} > ${workflow.apply.maxDeletedFiles}`);
    if (protectedFiles.length) reasons.push(`protected paths would be modified: ${protectedFiles.slice(0, 10).map((item) => item.path).join(', ')}`);
    if (workflow.apply.requireCleanGit && plan.safety.git?.dirty) reasons.push('git worktree is dirty');
    return {
      ...plan,
      requiresConfirmation: blockingWarnings.length > 0,
      policyOk: reasons.length === 0,
      policyReasons: reasons,
      plannerWarnings,
      blockingWarnings,
      allowedWarnings: plannerWarnings.filter((warning) => warningAllowed(warning)),
      protectedFiles,
      changedFiles: changed,
    };
  }

  async apply({ workflow, verification, plan, pipelineId }) {
    const backupRoot = path.join(this.dataDir, 'workflows', workflow.id, 'pipelines', pipelineId, 'rollback');
    await fs.rm(backupRoot, { recursive: true, force: true });
    await fs.mkdir(backupRoot, { recursive: true });
    const targets = new Set([
      ...plan.plan.written.map((item) => item.path),
      ...plan.plan.delete.map((item) => item.path),
      ...plan.plan.localChangedDelete.map((item) => item.path),
    ]);
    const manifest = [];
    for (const rel of targets) {
      const absolute = path.join(workflow.projectRoot, rel);
      const state = await pathState(absolute);
      const entry = { path: rel, ...state };
      if (state.exists && state.type === 'file') {
        const backupPath = path.join(backupRoot, rel);
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(absolute, backupPath);
        entry.backupPath = backupPath;
      } else if (state.exists) {
        throw new Error(`Unsupported rollback target type for ${rel}: ${state.type}`);
      }
      manifest.push(entry);
    }
    await fs.writeFile(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    let applied = null;
    let commands = null;
    try {
      applied = await applyZipToProject({
        zipPath: verification.zipPath,
        projectRoot: workflow.projectRoot,
        options: {
          sync: workflow.apply.sync,
          conflictPolicy: 'overwrite',
          selectedWritePaths: plan.plan.written.map((item) => item.path),
          selectedDeletePaths: [...plan.plan.delete, ...plan.plan.localChangedDelete].map((item) => item.path),
          zipValidation: {
            maxEntries: workflow.artifact.maxEntries,
            maxUncompressedSize: workflow.artifact.maxExtractedBytes,
          },
          excludedWritePaths: [workflow.resultProtocol?.manifest || 'bridge-result.json', 'bridge-workflow-instructions.md'],
          excludedWritePrefixes: ['.bridge/'],
        },
      });
      commands = await runWorkflowCommands(workflow.apply.commands, {
        cwd: workflow.projectRoot,
        timeoutMs: workflow.apply.timeoutMs,
        onOutput: (stream, text) => this.event?.('workflow.apply.command.output', { pipelineId, stream, text }),
      });
      if (!commands.ok) throw Object.assign(new Error('Post-apply command failed'), { code: 'WORKFLOW_VALIDATION_FAILED', commandResults: commands.results });
      return { ok: true, applied, commands, backupRoot, manifest, appliedAt: new Date().toISOString() };
    } catch (error) {
      const rollback = workflow.apply.rollbackOnFailure ? await this.rollback({ workflow, manifest }) : { ok: false, skipped: true };
      error.workflowApply = { applied, commands, backupRoot, rollback, manifest };
      throw error;
    }
  }

  async rollback({ workflow, manifest }) {
    const errors = [];
    for (const entry of [...manifest].reverse()) {
      const absolute = path.join(workflow.projectRoot, entry.path);
      try {
        if (!entry.exists) {
          await fs.rm(absolute, { recursive: true, force: true });
        } else if (entry.type === 'file') {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.copyFile(entry.backupPath, absolute);
          if (entry.mode) await fs.chmod(absolute, entry.mode).catch(() => {});
        }
      } catch (error) {
        errors.push({ path: entry.path, message: error.message });
      }
    }
    return { ok: errors.length === 0, errors, rolledBackAt: new Date().toISOString() };
  }
}
