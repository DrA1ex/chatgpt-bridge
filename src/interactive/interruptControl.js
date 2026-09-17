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
  runtime.exit();
}
