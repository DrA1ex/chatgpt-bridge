import path from 'node:path';
import { workflowActive } from '../workflow/ux/workflowView.js';

function text(value) {
  return String(value || '').trim();
}

export function selectStartupWorkflow(workflows = [], state = {}) {
  const items = Array.isArray(workflows) ? workflows.filter(Boolean) : [];
  const focusedId = text(state.focusedWorkflowId);
  return items.find((item) => item.id === focusedId)
    || items.find((item) => item.attention?.required)
    || items.find(workflowActive)
    || items[0]
    || null;
}

export function resolveInteractiveStartup({ projectPath = '', workflows = [], state = {}, cwd = process.cwd() } = {}) {
  const workflow = selectStartupWorkflow(workflows, state);
  const root = text(projectPath)
    || text(workflow?.projectRoot)
    || text(cwd)
    || text(state.projectRoot)
    || '.';
  return {
    workflow,
    projectRoot: path.resolve(root),
  };
}

export async function offerWorkflowContinuation(runtime) {
  const workflows = runtime?.options?.workflowManager?.list?.() || [];
  const workflow = selectStartupWorkflow(workflows, runtime?.state || {});
  if (!workflow || runtime?.workflowWizard?.opened) return null;
  runtime.state.focusedWorkflowId = workflow.id;
  if (workflow.projectRoot) runtime.state.projectRoot = path.resolve(workflow.projectRoot);
  await runtime.saveState?.().catch?.(() => {});
  if (workflow.attention?.required) await runtime.workflowWizard.openForWorkflow(workflow.id);
  else await runtime.workflowWizard.open({ view: 'active' });
  return workflow;
}
