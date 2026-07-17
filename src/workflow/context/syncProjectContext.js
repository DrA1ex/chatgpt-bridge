import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureProjectIdentity,
  writeProjectFingerprint,
  PROJECT_IDENTITY_RELATIVE_PATH,
  PROJECT_FINGERPRINT_RELATIVE_PATH,
} from '../../projectIdentity.js';
import { writeZip } from '../../zipWriter.js';
import { matchesProjectContextAcknowledgement } from '../contextAcknowledgement.js';
import { nowIso } from '../support/workflowValues.js';

export async function syncProjectContext({
  runtime,
  reason = 'manual',
  sessionId: requestedSessionId = '',
  sourceClientId: requestedSourceClientId = '',
  dataDir,
  fileStore,
  bridge,
  projectService = null,
  persistRuntime,
  publish,
}) {
  const config = runtime.config.projectContext;
  if (!config?.enabled) return { synced: false, reason: 'disabled' };

  const sessionId = requestedSessionId || runtime.config.watch.sessionId || runtime.boundSessionId || runtime.lastSessionId || '';
  const sourceClientId = requestedSourceClientId || runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '';
  if (!sessionId || !sourceClientId) return { synced: false, reason: 'unbound' };

  const identity = await ensureProjectIdentity(runtime.config.projectRoot, {
    packageName: runtime.config.verification.packageName,
  });
  const packed = projectService
    ? await projectService.pack(runtime.config.projectRoot, {
      force: false,
      useGitignore: true,
      snapshotPolicy: 'always',
    })
    : null;
  const fingerprint = packed
    ? { fingerprintSha256: packed.snapshotId }
    : await writeProjectFingerprint(runtime.config.projectRoot, {
      identity,
      files: config.fallbackFiles,
    });
  if (runtime.contextSyncedSessionId === sessionId
    && runtime.contextSyncFingerprint === fingerprint.fingerprintSha256) {
    return { synced: false, reason: 'already-synced', sessionId, projectId: identity.projectId, fingerprintSha256: fingerprint.fingerprintSha256 };
  }

  const previousFingerprint = runtime.contextSyncedSessionId === sessionId
    ? runtime.contextSyncFingerprint
    : '';
  const refresh = Boolean(previousFingerprint);
  let attachment;
  if (packed?.file?.id) {
    attachment = packed.file;
  } else {
    const contextDir = path.join(dataDir, 'workflows', runtime.id, 'context');
    await fs.mkdir(contextDir, { recursive: true });
    const zipPath = path.join(contextDir, `project-context-${fingerprint.fingerprintSha256.slice(0, 16)}.zip`);
    const entries = [
      { name: PROJECT_IDENTITY_RELATIVE_PATH, data: JSON.stringify(identity, null, 2) },
      { name: PROJECT_FINGERPRINT_RELATIVE_PATH, data: JSON.stringify(fingerprint, null, 2) },
    ];
    let includedBytes = Buffer.byteLength(entries[0].data) + Buffer.byteLength(entries[1].data);
    for (const relativePath of config.fallbackFiles) {
      const absolutePath = path.resolve(runtime.config.projectRoot, relativePath);
      const projectRoot = path.resolve(runtime.config.projectRoot);
      if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) continue;
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isFile() || stat.size > config.maxBytes || includedBytes + stat.size > config.maxBytes) continue;
      entries.push({ name: `project/${String(relativePath).replace(/\\/g, '/')}`, path: absolutePath });
      includedBytes += stat.size;
    }
    await writeZip(zipPath, entries);
    attachment = await fileStore.importLocalPath({ filePath: zipPath, name: path.basename(zipPath), mime: 'application/zip' });
  }

  const marker = `PROJECT_CONTEXT_SYNCED_${identity.projectId}`;
  await publish(runtime.id, refresh ? 'workflow.context.refresh.started' : 'workflow.context.sync.started', {
    reason,
    sessionId,
    projectId: identity.projectId,
    previousFingerprint,
    fingerprintSha256: fingerprint.fingerprintSha256,
    attachment: attachment.name,
  });
  const response = await bridge.sendRequest({
    message: [
      refresh
        ? 'The local project has changed since the previous project archive. Forget the previous project snapshot and use the newly attached archive as the current source of truth.'
        : 'Use the attached project archive as the current source of truth for this workflow.',
      `The stable project id is ${identity.projectId}.`,
      `Preserve ${PROJECT_IDENTITY_RELATIVE_PATH} unchanged in every full-project ZIP artifact for this project.`,
      'Do not treat this synchronization message as a request to modify the project.',
      `Reply exactly ${marker}.`,
    ].join('\n'),
    attachments: [attachment.id],
    sessionId,
    sourceClientId,
    effort: 'instant',
    fullResponse: true,
  });
  if (!matchesProjectContextAcknowledgement(response.answer, marker)) {
    throw new Error(`Project context acknowledgement mismatch: ${response.answer || ''}`);
  }

  runtime.contextSyncedSessionId = sessionId;
  runtime.contextSyncFingerprint = fingerprint.fingerprintSha256;
  runtime.projectId = identity.projectId;
  runtime.projectFingerprintSha256 = fingerprint.fingerprintSha256;
  runtime.updatedAt = nowIso();
  await persistRuntime(runtime);
  if (packed && projectService) {
    await projectService.markSnapshotUploaded({
      cwd: runtime.config.projectRoot,
      projectId: packed.project?.id,
      threadId: `workflow:${runtime.id}:${sessionId}`,
      snapshotId: packed.snapshotId,
      fileId: attachment.id,
      sha256: packed.sha256 || '',
      source: refresh ? 'workflow-refresh' : 'workflow-sync',
    }).catch(() => null);
  }
  await publish(runtime.id, refresh ? 'workflow.context.refresh.completed' : 'workflow.context.sync.completed', {
    reason,
    sessionId,
    projectId: identity.projectId,
    previousFingerprint,
    fingerprintSha256: fingerprint.fingerprintSha256,
  });
  return {
    synced: true,
    refreshed: refresh,
    sessionId,
    projectId: identity.projectId,
    fingerprintSha256: fingerprint.fingerprintSha256,
  };
}
