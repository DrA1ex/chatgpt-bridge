import { workflowHasBlockingAction, workflowRunActive } from '../workflow/ux/workflowView.js';

export function handleConfirmationKey(runtime, key, text = '') {
  if (key.name === 'escape' || key.name === 'enter' || /^n$/i.test(text)) {
    const resolver = runtime.confirmResolver;
    runtime.confirmResolver = null;
    runtime.confirmPrompt = '';
    resolver?.(false);
    return runtime.invalidate();
  }
  if (/^y$/i.test(text)) {
    const resolver = runtime.confirmResolver;
    runtime.confirmResolver = null;
    runtime.confirmPrompt = '';
    resolver?.(true);
    return runtime.invalidate();
  }
}

export function handleWorkflowExitKey(runtime, key, text = '') {
  if (key.name === 'ctrl-c') {
    if (Date.now() - runtime.forceExitArmedAt < 1_500) return runtime.exit(130, { preserveActiveWork: true });
    runtime.forceExitArmedAt = Date.now();
    return runtime.invalidate();
  }
  if (key.name === 'escape' || /^n$/i.test(text)) {
    runtime.workflowExitPrompt = null;
    return runtime.invalidate();
  }
  if (/^y$/i.test(text)) {
    const workflowId = runtime.workflowExitPrompt.id;
    runtime.workflowExitPrompt = null;
    runtime.invalidate();
    void runtime.options.workflowManager.stopAutomation(workflowId, 'stopped during graceful shutdown')
      .catch((error) => runtime.pushEntry({ kind: 'error', title: 'Workflow stop failed', body: error.message }))
      .finally(() => runtime.exit());
  }
}

export function handleRequestInterruptKey(runtime, key, text = '') {
  if (key.name === 'escape') {
    runtime.interruptPrompt = false;
    return runtime.invalidate();
  }
  if (/^c$/i.test(text)) {
    runtime.interruptPrompt = false;
    if (runtime.abortController && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('Cancelled by Ctrl+C');
      runtime.pushEntry({ kind: 'system', title: 'Cancelling', body: 'Active request cancellation requested.' });
    }
    return;
  }
  if (/^d$/i.test(text)) {
    runtime.detachOnExit = true;
    return runtime.exit();
  }
}

export function handleInteractiveInterrupt(runtime) {
  if (runtime.abortController && !runtime.abortController.signal.aborted) {
    runtime.interruptPrompt = true;
    return runtime.invalidate();
  }
  const workflows = runtime.options.workflowManager?.list?.() || [];
  const blockingWorkflow = workflows.find(workflowHasBlockingAction) || null;
  if (blockingWorkflow) {
    runtime.workflowExitPrompt = blockingWorkflow;
    runtime.forceExitArmedAt = Date.now();
    return runtime.invalidate();
  }
  if (workflows.some(workflowRunActive)) runtime.detachOnExit = true;
  runtime.exit();
}
