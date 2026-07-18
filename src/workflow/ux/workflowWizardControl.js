import * as workflowView from './workflowView.js';

const { workflowRunActive, workflowStage } = workflowView;
const { workflowWatcherActive } = workflowView;

export function buildWorkflowActionsScreen(workflow, { continueAction, stopAction, startAnother }) {
  const stage = workflowStage(workflow);
  const watcherRunning = workflowWatcherActive(workflow);
  let primaryLabel = workflowRunActive(workflow) ? 'Return to normal interactive mode' : 'Start or continue this workflow';
  if (workflow.preset === 'apply-changes') primaryLabel = watcherRunning ? 'Keep watching and return to chat' : 'Start watching this ChatGPT tab';
  else if (workflow.preset === 'guided-task') primaryLabel = 'Focus this guided task';
  else if (!workflowRunActive(workflow)) primaryLabel = 'Run project checks and start the fix loop';
  return {
    id: 'workflow-actions',
    title: workflow.label || workflow.id,
    message: `Current step: ${stage.label}\nProject: ${workflow.projectRoot}${workflow.binding?.sessionId ? `\nChat: ${workflow.binding.sessionId}` : ''}`,
    options: [
      { label: primaryLabel, action: continueAction },
      { label: 'Pause or stop this workflow', action: stopAction },
      { label: 'Start another workflow', action: startAnother },
    ],
  };
}

export async function continueWorkflowFromWizard(runtime, workflow) {
  const manager = runtime.options.workflowManager;
  let current = manager.get(workflow.id) || workflow;
  if (workflow.preset === 'apply-changes') {
    if (!workflowWatcherActive(current)) current = await manager.start(workflow.id);
    runtime.pushEntry({
      kind: 'system',
      title: 'Watching the ChatGPT tab',
      body: `Continue the conversation in the selected ChatGPT browser tab. Bridge will print new prompts, visible reasoning, and full answers here, then validate and apply valid result packages automatically.\n\nChat: ${current.binding?.sessionId || 'selected tab'}\nProject: ${current.projectRoot}`,
    });
  } else if (workflow.preset === 'guided-task') {
    if (!workflowWatcherActive(current)) current = await manager.start(workflow.id);
    runtime.state.focusedWorkflowId = workflow.id;
    await runtime.saveState?.();
    runtime.pushEntry({ kind: 'system', title: 'Guided task focused', body: 'Type your next prompt in Bridge. Open /workflow again to change, pause, or finish the task.' });
  } else if (!workflowRunActive(current)) {
    await manager.runAutomation(workflow.id, { trigger: 'interactive' });
    runtime.pushEntry({ kind: 'system', title: 'Workflow run started', body: 'Bridge is running the configured project checks and will continue through ChatGPT when fixes are needed.' });
  }
  return current;
}

export function buildWorkflowStopScreen(runtime, workflow, { close, goBack }) {
  const manager = runtime.options.workflowManager;
  const passive = workflow.preset === 'apply-changes' || workflow.preset === 'guided-task';
  return {
    id: 'stop-action',
    title: workflow.label || workflow.id,
    message: 'Stopping a workflow never stops ordinary interactive mode.',
    options: passive ? [
      {
        label: workflow.preset === 'apply-changes' ? 'Pause watching this ChatGPT tab' : 'Pause this guided task',
        action: async () => {
          await manager.stop(workflow.id);
          if (runtime.state.focusedWorkflowId === workflow.id) {
            runtime.state.focusedWorkflowId = '';
            await runtime.saveState?.();
          }
          runtime.pushEntry({ kind: 'system', title: 'Workflow paused', body: 'Open /workflow and choose the workflow to start it again.' });
          close();
        },
      },
      {
        label: 'Stop and remove this workflow',
        action: async () => {
          await manager.unload(workflow.id);
          if (runtime.state.focusedWorkflowId === workflow.id) {
            runtime.state.focusedWorkflowId = '';
            await runtime.saveState?.();
          }
          runtime.pushEntry({ kind: 'system', title: 'Workflow stopped', body: 'The saved profile remains available in the workflow configuration file.' });
          close();
        },
      },
      { label: 'Go back', action: goBack },
    ] : [
      { label: 'Pause the workflow', action: async () => { await manager.pauseAutomation(workflow.id, 'paused from workflow wizard'); close(); } },
      { label: 'Stop the active run', action: async () => { await manager.stopAutomation(workflow.id, 'stopped from workflow wizard'); close(); } },
      { label: 'Go back', action: goBack },
    ],
  };
}

export function buildWorkflowStartedScreen(workflow, configPath, { close, openControls }) {
  const sessionId = workflow.binding?.sessionId || workflow.pinnedSessionId || 'selected ChatGPT tab';
  let title = 'Workflow started';
  let message = `Current step: ${workflowStage(workflow).label}\nProject: ${workflow.projectRoot}\nConfiguration: ${configPath}`;
  if (workflow.preset === 'apply-changes') {
    title = 'Workflow is now watching ChatGPT';
    message = [
      `Chat: ${sessionId}`,
      `Project: ${workflow.projectRoot}`,
      '',
      'Continue the conversation in that ChatGPT browser tab.',
      'Bridge will print new user prompts, visible reasoning, and full answers here. Valid result packages will be validated and applied automatically.',
      '',
      'No /workflow run command is needed.',
    ].join('\n');
  } else if (workflow.preset === 'guided-task') {
    title = 'Guided task is ready';
    message = `Project: ${workflow.projectRoot}\n\nType your next prompt in Bridge. Open /workflow again to change settings, pause, or finish the task.`;
  } else if (workflow.preset === 'fix-until-pass') {
    title = 'Workflow run started';
    message = `Project: ${workflow.projectRoot}\nCurrent step: Running project checks\n\nBridge will ask ChatGPT for fixes when checks fail.`;
  }
  return {
    id: 'started',
    title,
    message,
    options: [
      { label: 'Return to normal interactive mode', action: close },
      { label: 'Open workflow controls', action: openControls },
    ],
  };
}
