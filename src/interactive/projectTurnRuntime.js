import { runProjectTask } from './runtime.js';

export async function runInteractiveProjectTurn(runtime, message, { requireZip = false } = {}) {
  if (!runtime.options.bridge.health().ok && !runtime.options.bridge.canAutoOpenPromptTab?.()) {
    return runtime.pushEntry({
      kind: 'error',
      title: 'Not connected',
      body: 'No ChatGPT browser extension is connected. Use /connect, or restart with --auto-open-tab.',
    });
  }

  const controller = new AbortController();
  runtime.abortController = controller;
  runtime.busy = true;
  runtime.phase = requireZip ? 'project task' : 'project chat';
  runtime.clearLive();
  runtime.streamingEntryId = '';
  runtime.resetActivity();
  runtime.chatProgressState = { records: {} };

  const queuedFiles = runtime.state.pendingAttachments
    .map((file) => file.name)
    .filter(Boolean)
    .join(', ');
  const mode = requireZip ? 'task' : 'chat';
  runtime.pushEntry({
    kind: 'user',
    title: 'You',
    subtitle: `project ${mode}: ${runtime.state.projectRoot}${queuedFiles ? ` · files: ${queuedFiles}` : ''}`,
    body: message,
  });

  try {
    await runProjectTask(
      message,
      { ...runtime.context, signal: controller.signal },
      { requireZip, autoHandoff: requireZip },
    );
    runtime.flushActivitySummary('Result activity');
    await runtime.saveState?.().catch(() => {});
  } catch (error) {
    runtime.flushActivitySummary('Result activity');
    const label = requireZip ? 'Project task' : 'Project chat';
    runtime.pushEntry(controller.signal.aborted
      ? { kind: 'system', title: `${label} cancelled`, body: String(controller.signal.reason || 'Cancelled') }
      : { kind: 'error', title: `${label} failed`, body: error.message });
    await runtime.saveState?.().catch(() => {});
  } finally {
    runtime.abortController = null;
    runtime.busy = false;
    runtime.phase = 'idle';
    runtime.invalidate();
  }
}
