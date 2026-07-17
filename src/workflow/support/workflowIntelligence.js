function text(value) {
  return String(value ?? '').trim();
}

const INHERITED_EFFORTS = new Set(['', 'auto', 'default', 'inherit', 'unchanged']);

export function workflowRequestEffort(workflow = {}) {
  const configured = workflow.ux?.intelligence?.effort
    ?? workflow.intelligence?.effort
    ?? workflow.automation?.turn?.effort
    ?? '';
  const value = text(configured);
  return INHERITED_EFFORTS.has(value.toLowerCase()) ? '' : value;
}
