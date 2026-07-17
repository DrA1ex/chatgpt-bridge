import { boundedText } from './workflowValues.js';

function commandSummary(commands = {}) {
  return {
    ok: Boolean(commands?.ok),
    results: Array.isArray(commands?.results)
      ? commands.results.map((item) => ({
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
      }))
      : [],
  };
}

export function verificationSummary(verification = {}) {
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

export function applicationSummary(applied = {}) {
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

export function applyPlanSummary(plan = {}) {
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
    writePathsPreview: Array.isArray(body.written)
      ? body.written.slice(0, 100).map((item) => item.path)
      : [],
    deletePathsPreview: [
      ...(Array.isArray(body.delete) ? body.delete : []),
      ...(Array.isArray(body.localChangedDelete) ? body.localChangedDelete : []),
    ].slice(0, 100).map((item) => item.path),
  };
}

export function formatApplyPlan(plan = {}) {
  const summary = plan?.counts ? plan : applyPlanSummary(plan);
  const counts = summary.counts || {};
  const lines = [
    `Policy: ${summary.policyOk ? 'allowed' : 'requires attention'}`,
    `Changes: ${Number(summary.changedFiles) || 0} file(s)`,
    `Create: ${Number(counts.create) || 0} · Update: ${Number(counts.update) || 0} · Delete: ${Number(counts.delete) || 0} · Unchanged: ${Number(counts.unchanged) || 0}`,
  ];
  if (summary.requiresConfirmation) lines.push('Confirmation: required');
  if (summary.policyReasons?.length) {
    lines.push('', 'Policy notes:', ...summary.policyReasons.map((reason) => `- ${reason}`));
  }
  if (summary.writePathsPreview?.length) {
    lines.push('', 'Files to write:', ...summary.writePathsPreview.map((file) => `- ${file}`));
  }
  if (summary.deletePathsPreview?.length) {
    lines.push('', 'Files to delete:', ...summary.deletePathsPreview.map((file) => `- ${file}`));
  }
  if (!summary.writePathsPreview?.length && !summary.deletePathsPreview?.length) {
    lines.push('', 'No file writes or deletions are listed.');
  }
  return lines.join('\n');
}
