import fs from 'node:fs/promises';
import path from 'node:path';
import { workflowRequestEffort } from '../support/workflowIntelligence.js';

export function workflowInstructionText(workflow = {}) {
  const manifest = workflow.resultProtocol?.manifest || 'bridge-result.json';
  return [
    '# Bridge workflow result instructions',
    '',
    `Workflow: ${workflow.id || 'workflow'}`,
    `Mode: ${workflow.preset || 'workflow'}`,
    '',
    'When returning project file changes:',
    '- Return exactly one complete project ZIP with project files at the archive root.',
    `- Include ${manifest}.`,
    '- Use safe relative paths and complete files, not patch or diff files.',
    '- Include a concise commitMessage in the result manifest.',
    '- The manifest files field is optional and advisory; Bridge derives the effective changed-file list from the actual project diff and ignores listed files that did not change.',
    '- Do not include .git, node_modules, .bridge-data, logs, caches, secrets, CHANGELOG.md, or nested project archives.',
    '- Keep package-lock.json on public registry URLs only.',
    '',
    `The ${manifest} schema is:`,
    '```json',
    JSON.stringify({ version: 1, status: 'changed', summary: 'What changed', commitMessage: 'Concise commit message', files: ['relative/file.js'] }, null, 2),
    '```',
    '',
    'A text-only response is valid only when Bridge explicitly says no file changes are required.',
  ].join('\n');
}


async function createWorkflowInstructionAttachment({ workflow, fileStore, dataDir } = {}) {
  const bootstrapDir = path.join(dataDir, 'workflows', workflow.id, 'bootstrap');
  await fs.mkdir(bootstrapDir, { recursive: true });
  const instructionPath = path.join(bootstrapDir, 'bridge-workflow-instructions.md');
  await fs.writeFile(instructionPath, `${workflowInstructionText(workflow)}\n`, 'utf8');
  return await fileStore.importLocalPath({
    filePath: instructionPath,
    name: 'bridge-workflow-instructions.md',
    mime: 'text/markdown',
  });
}

export async function attachWorkflowInstructions({ workflow, bridge, fileStore, dataDir, sessionId = '', sourceClientId = '' } = {}) {
  if (!bridge || !fileStore) throw new Error('Attaching workflow instructions requires bridge and fileStore');
  const instructions = await createWorkflowInstructionAttachment({ workflow, fileStore, dataDir });
  const response = await bridge.sendRequest({
    message: [
      'This chat is now connected to Bridge.',
      'Keep the existing conversation context.',
      'Follow the attached Bridge result instructions whenever you return file changes.',
      'Confirm when you are ready.',
    ].join('\n'),
    attachments: [instructions.id],
    sessionId,
    sourceClientId: sourceClientId || undefined,
    effort: workflowRequestEffort(workflow),
    fullResponse: true,
  });
  if (!String(response.answer || '').trim()) throw new Error('ChatGPT did not acknowledge the workflow instructions');
  return { instructionsFileId: instructions.id, response };
}

export async function bootstrapWorkflowChat({ workflow, bridge, fileStore, projectService, dataDir, sourceClientId = '' } = {}) {
  if (!bridge || !fileStore || !projectService) throw new Error('Workflow chat bootstrap requires bridge, fileStore, and projectService');
  const pack = await projectService.pack(workflow.projectRoot, {
    force: true,
    snapshotPolicy: 'always',
    useGitignore: true,
  });
  const instructions = await createWorkflowInstructionAttachment({ workflow, fileStore, dataDir });
  const created = await bridge.newSession({ sourceClientId: sourceClientId || undefined });
  const session = created?.session || created?.current || created;
  const sessionId = String(session?.id || session?.sessionId || '').trim();
  if (!sessionId) throw new Error('ChatGPT did not return a session id for workflow bootstrap');
  const response = await bridge.sendRequest({
    message: [
      'This chat is connected to Bridge.',
      'Use the attached project as the current source of truth.',
      'Follow the attached Bridge result instructions whenever you return file changes.',
      'Include a concise commit message with every result package.',
      'Confirm when you are ready.',
    ].join('\n'),
    attachments: [pack.file.id, instructions.id],
    sessionId,
    sourceClientId: sourceClientId || undefined,
    effort: workflowRequestEffort(workflow),
    fullResponse: true,
  });
  if (!String(response.answer || '').trim()) throw new Error('ChatGPT did not acknowledge workflow initialization');
  await projectService.markSnapshotUploaded({
    cwd: workflow.projectRoot,
    projectId: pack.project.id,
    threadId: sessionId,
    snapshotId: pack.snapshotId,
    fileId: pack.file.id,
    sha256: pack.sha256,
    source: 'workflow-bootstrap',
  });
  return {
    sessionId,
    sourceClientId: response.sourceClientId || sourceClientId || '',
    snapshotId: pack.snapshotId,
    fingerprint: pack.snapshotId,
    projectFileId: pack.file.id,
    instructionsFileId: instructions.id,
    response,
  };
}

export function isSessionExhaustionError(error = {}) {
  const text = `${error.code || ''} ${error.message || ''} ${error.answer || ''}`.toLowerCase();
  return [
    'context window',
    'conversation is too long',
    'maximum conversation length',
    'session is exhausted',
    'chat is unavailable',
    'conversation_not_found',
    'stale context',
    'workflow_session_turn_limit',
  ].some((needle) => text.includes(needle));
}

export function buildWorkflowHandoff({ workflow, automation, failingChecks = [], conclusions = [] } = {}) {
  return [
    'Continue this Bridge workflow in a fresh ChatGPT chat.',
    '',
    `Original goal: ${workflow.ux?.label || workflow.preset || workflow.id}`,
    `Current step: ${automation?.status || 'unknown'}`,
    `Attempt: ${automation?.cycle || 0} of ${automation?.maxCycles || '?'}`,
    failingChecks.length ? `Checks still failing:\n${failingChecks.map((item) => `- ${item}`).join('\n')}` : 'Checks still failing: see the attached diagnostics.',
    conclusions.length ? `Useful conclusions:\n${conclusions.map((item) => `- ${item}`).join('\n')}` : '',
    '',
    'The newly attached project archive is the only current source of truth. Ignore older project snapshots.',
  ].filter(Boolean).join('\n');
}
