export const SERVER_WORKFLOW_PRESETS = Object.freeze([
  {
    id: 'apply-changes',
    label: 'Apply changes from ChatGPT',
    description: 'Review and apply returned project archives through the workflow service.',
  },
  {
    id: 'fix-until-pass',
    label: 'Fix the project until checks pass',
    description: 'Bridge drives repair prompts while the workflow service owns checks and project changes.',
  },
  {
    id: 'guided-task',
    label: 'Work through a task',
    description: 'Use normal prompts and review returned files through the workflow service.',
  },
]);

const PRESET_IDS = new Set(SERVER_WORKFLOW_PRESETS.map(({ id }) => id));

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function buildServerWorkflowPreset(preset, baseWorkflow, {
  checks = undefined,
  intelligence = {},
  binding = {},
  attempts = {},
  session = {},
  notifications = {},
} = {}) {
  if (!PRESET_IDS.has(preset)) throw new Error(`Unknown workflow preset: ${preset}`);
  if (!baseWorkflow || typeof baseWorkflow !== 'object') {
    throw new Error('A server-suggested workflow is required to build a preset');
  }
  const workflow = clone(baseWorkflow);
  workflow.name = String(workflow.name || 'Project');
  workflow.archive = {
    ...(workflow.archive || {}),
    mode: preset === 'apply-changes' ? 'snapshot' : 'overlay',
  };
  if (Array.isArray(checks)) workflow.checks = clone(checks);
  workflow.policy = {
    ...(workflow.policy || {}),
    confirmPlan: true,
    conflictPolicy: 'ask',
    failedChecks: 'ask',
  };
  workflow.git = {
    ...(workflow.git || {}),
    checkpoint: preset === 'fix-until-pass' ? 'auto' : 'ask',
    resultCommit: 'ask',
  };
  return {
    workflow,
    orchestration: {
      preset,
      binding: clone(binding),
      intelligence: clone(intelligence),
      remediation: {
        enabled: preset === 'fix-until-pass',
      },
      attempts: {
        checkCycles: Math.max(1, Number(attempts.checkCycles) || 8),
        invalidResponse: Math.max(0, Number(attempts.invalidResponse) || 2),
        resultRepair: Math.max(0, Number(attempts.resultRepair) || 2),
      },
      sessionExhaustion: 'start-new-chat',
      session: clone(session),
      notifications: clone(notifications),
      noProgressLimit: Math.max(1, Number(attempts.noProgressLimit) || 3),
    },
  };
}
