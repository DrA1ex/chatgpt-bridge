import fs from 'node:fs/promises';
import path from 'node:path';
import { starterWorkflowConfig } from '../../cli/workflowConfigCommands.js';

export const WORKFLOW_PRESETS = Object.freeze([
  { id: 'apply-changes', label: 'Apply changes from ChatGPT', description: 'Watch a ChatGPT chat and apply valid returned project packages.' },
  { id: 'fix-until-pass', label: 'Fix the project until checks pass', description: 'Run checks, send failures to ChatGPT, apply fixes, and repeat.' },
  { id: 'guided-task', label: 'Work through a task', description: 'Use normal prompts while Bridge manages project context and returned files.' },
]);

function safeId(value) {
  return String(value || 'workflow').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function applyCommitPolicy(config, defaults) {
  const commits = defaults.commits || {};
  if (commits.mode === 'disabled') config.commit.mode = 'none';
  else if (commits.mode === 'ask') config.commit.mode = 'block';
  else config.commit.mode = 'block';
  config.commit.required = false;
  config.commit.policy = {
    mode: commits.mode || 'automatic',
    iterationStrategy: commits.iterationStrategy || 'checkpoint',
    completionStrategy: commits.completionStrategy || 'squash',
    includeOnlyWorkflowChanges: commits.includeOnlyWorkflowChanges !== false,
  };
}

export async function buildPresetWorkflowConfig({ preset, projectRoot, checks = [], chat = {}, defaults = {}, id = '' } = {}) {
  if (!WORKFLOW_PRESETS.some((item) => item.id === preset)) throw new Error(`Unknown workflow preset: ${preset}`);
  const root = path.resolve(projectRoot || process.cwd());
  const config = await starterWorkflowConfig(root, id || `${safeId(path.basename(root))}-${preset}`);
  // Persist the project selected in the wizard instead of relying on the
  // starter template's cwd-relative placeholder. Saved profiles may be
  // launched from another directory, so this must be an absolute path.
  config.projectRoot = root;
  config.preset = preset;
  config.ux = {
    label: WORKFLOW_PRESETS.find((item) => item.id === preset).label,
    sessionExhaustion: defaults.sessionExhaustion || 'start-new-chat',
    session: {
      maxTurns: Math.max(1, Number(defaults.session?.maxTurns) || 40),
    },
    invalidResponseAction: defaults.invalidResponseAction || 'repair',
    invalidResponseAttempts: Number(defaults.invalidResponseAttempts) || 0,
    notifications: defaults.notifications || {},
    checks: defaults.checks || {},
    guidedFocused: preset === 'guided-task',
  };
  config.watch.sessionId = chat.sessionId || '';
  config.watch.clientId = chat.clientId || '';
  config.watch.mode = preset === 'guided-task' ? 'ask' : 'auto';
  config.watch.includeLatest = false;
  config.projectContext.syncOnStart = chat.mode === 'new';
  config.projectContext.syncAfterBind = true;
  config.resultProtocol = {
    required: preset !== 'guided-task',
    manifest: 'bridge-result.json',
    allowTextOnly: preset === 'guided-task',
    requireCommitMessage: defaults.commits?.mode !== 'disabled',
    repairAction: defaults.invalidResponseAction || 'repair',
    repairAttempts: Number(defaults.invalidResponseAttempts) || 0,
  };
  config.apply.commands = preset === 'apply-changes' ? checks : [];
  if (preset === 'apply-changes' && checks.length) config.apply.rollbackOnFailure = false;
  config.automation.enabled = preset === 'fix-until-pass';
  config.automation.steps = checks.map((command, index) => ({
    id: `check-${index + 1}`,
    name: command,
    command,
    cwd: root,
    timeoutMs: 7_200_000,
    env: {},
    continueOnFailure: true,
  }));
  config.automation.maxCycles = Math.max(1, Number(defaults.checks?.maxAttempts) || 8);
  config.automation.noProgressLimit = Math.max(1, Number(defaults.checks?.noProgressLimit) || 3);
  config.automation.session = {
    policy: chat.mode === 'new' ? 'new' : chat.sessionId ? 'pinned' : 'current',
    id: chat.sessionId || '',
  };
  config.automation.onFailure.output = { expected: 'zip', required: true };
  config.remediation.maxAttempts = Number(defaults.invalidResponseAttempts) || 2;
  config.remediation.enabled = preset !== 'apply-changes' && defaults.invalidResponseAction === 'repair';
  applyCommitPolicy(config, defaults);
  return config;
}

export async function writePresetWorkflowConfig(config, { dataDir, filePath = '' } = {}) {
  const target = path.resolve(filePath || path.join(dataDir, 'workflows', 'profiles', `${safeId(config.id)}.json`));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}
