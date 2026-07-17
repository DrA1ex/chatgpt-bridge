import { attentionActions } from '../attention/attentionState.js';
import { formatApplyPlan } from '../support/workflowSummaries.js';

function reviewDetails(runtime) {
  runtime.detailsOpen = true;
  return { acknowledge: false };
}

export async function dispatchWorkflowPendingAction({ runtime, manager, workflow, approval, index, showGoal }) {
  let acknowledge = true;
  let close = true;
  if (approval) {
    if (index === 0) await manager.approve(approval.id);
    else if (index === 1) {
      acknowledge = false;
      close = false;
      runtime.pushEntry({ kind: 'system', title: 'Workflow change plan', body: formatApplyPlan(approval.plan || {}) });
    } else if (index === 2) await manager.reject(approval.id, 'rejected from workflow wizard');
    else await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else if (workflow.automationInterrupted) {
    if (index === 0) await manager.resumeAutomation(workflow.id);
    else if (index === 1) await manager.discardAutomation(workflow.id, 'discarded from workflow wizard');
    else await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else if (workflow.pendingCommit || workflow.attention?.kind === 'commit-confirmation') {
    if (index === 0) await manager.approvePendingCommit(workflow.id);
    else if (index === 1) {
      acknowledge = false;
      close = false;
      runtime.pushEntry({
        kind: 'system',
        title: 'Pending workflow commit',
        body: `${workflow.pendingCommit?.message || 'Commit message unavailable'}\n\n${(workflow.pendingCommit?.paths || []).join('\n') || 'No file list available.'}`,
      });
    } else if (index === 2) await manager.skipPendingCommit(workflow.id, 'continued without a commit from workflow wizard');
    else await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else if (workflow.attention?.kind === 'checks-failed') {
    if (index === 0) await manager.startFixLoopAfterFailedChecks(workflow.id);
    else if (index === 1) await manager.keepFailedCheckChanges(workflow.id);
    else if (index === 2) await manager.revertFailedCheckChanges(workflow.id);
    else {
      acknowledge = false;
      close = false;
      const commands = workflow.pendingCheckFailure?.commands || [];
      runtime.pushEntry({
        kind: 'system',
        title: 'Project check output',
        body: commands.length
          ? commands.map((item) => `${item.command || 'check'} (exit ${item.code ?? 'unknown'})\n${item.stdout || ''}\n${item.stderr || ''}`.trim()).join('\n\n')
          : workflow.attention?.message || 'No check output is available.',
      });
    }
  } else if (workflow.attention?.kind === 'completed') {
    if (index === 0) {
      runtime.state.focusedWorkflowId = '';
      await runtime.saveState?.();
    } else if (index === 1) reviewDetails(runtime);
    else {
      close = false;
      showGoal();
    }
  } else if (workflow.attention?.kind === 'session-exhausted') {
    if (index === 0) await manager.recoverSessionAndRestart(workflow.id);
    else if (index === 1) acknowledge = reviewDetails(runtime).acknowledge;
    else await manager.stopAutomation(workflow.id, 'stopped after ChatGPT session exhaustion');
  } else if (workflow.attention?.kind === 'local-conflict') {
    if (index === 0) {
      await manager.refreshProjectContext(workflow.id);
      await manager.restartAutomation(workflow.id, { trigger: 'local-context-refreshed' });
    } else if (index === 1) acknowledge = reviewDetails(runtime).acknowledge;
    else if (index === 2) {
      runtime.pushEntry({ kind: 'system', title: 'Continuing with stale ChatGPT context', body: 'ChatGPT may be working from an older project snapshot. Bridge will still validate every returned package before applying it.' });
      await manager.restartAutomation(workflow.id, { trigger: 'continue-without-refresh' });
    } else await manager.stopAutomation(workflow.id, 'stopped after local project conflict');
  } else if (workflow.attention?.kind === 'no-progress') {
    if (index === 0) await manager.restartAutomation(workflow.id, { trigger: 'try-different-approach', approachInstruction: 'Use a materially different approach. Reconsider the previous assumptions and do not repeat the same unsuccessful fix.' });
    else if (index === 1) acknowledge = reviewDetails(runtime).acknowledge;
    else if (index === 2) await manager.restartAutomation(workflow.id, { trigger: 'continue-after-no-progress' });
    else {
      await manager.stopAutomation(workflow.id, 'stopped after no progress');
      await manager.restoreStartingState(workflow.id);
    }
  } else if (workflow.attention?.kind === 'invalid-response') {
    if (index === 0) await manager.requestResultRepair(workflow.id);
    else if (index === 1) acknowledge = reviewDetails(runtime).acknowledge;
    else if (index === 2) {
      await manager.acknowledgeAttention(workflow.id);
      acknowledge = false;
    } else await manager.stopAutomation(workflow.id, 'stopped after invalid ChatGPT response');
  } else if (workflow.attention?.kind === 'paused') {
    if (index === 0) await manager.resumeAutomation(workflow.id);
    else await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else if (workflow.attention?.kind === 'error') {
    if (index === 0) {
      await manager.acknowledgeAttention(workflow.id);
      acknowledge = false;
    } else if (index === 1) acknowledge = reviewDetails(runtime).acknowledge;
    else if (index === 2) await manager.restartAutomation(workflow.id, { trigger: 'attention-action' });
    else await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else if (index === (attentionActions(workflow).length - 1)) {
    await manager.stopAutomation(workflow.id, 'stopped from workflow wizard');
  } else acknowledge = reviewDetails(runtime).acknowledge;

  if (acknowledge) await manager.acknowledgeAttention(workflow.id).catch(() => {});
  return { close };
}
