import { WorkflowEventType } from './workflowState.js';

export function workflowGitState(runtime) {
  const git = runtime?.workflowState?.git || {};
  return {
    baseSha: String(git.baseSha || ''),
    checkpointShas: Array.isArray(git.checkpointShas) ? [...git.checkpointShas] : [],
    ownedPaths: Array.isArray(git.ownedPaths) ? [...git.ownedPaths] : [],
    pathStates: git.pathStates && typeof git.pathStates === 'object' ? structuredClone(git.pathStates) : {},
    lastCommitMessage: String(git.lastCommitMessage || ''),
  };
}

async function update(transition, runtime, mode, git, reason = '') {
  return await transition(runtime, WorkflowEventType.GIT_STATE_UPDATED, {
    runId: runtime.workflowState.run.id,
    mode,
    git,
    reason,
  }, 'workflow.git.state.updated', { mode, reason });
}

export async function mergeWorkflowGitState(transition, runtime, git, reason = '') {
  return await update(transition, runtime, 'merge', git, reason);
}

export async function replaceWorkflowGitState(transition, runtime, git, reason = '') {
  return await update(transition, runtime, 'replace', git, reason);
}

export async function clearWorkflowGitState(transition, runtime, { baseSha } = {}, reason = '') {
  return await transition(runtime, WorkflowEventType.GIT_STATE_UPDATED, {
    runId: runtime.workflowState.run.id,
    mode: 'clear',
    baseSha,
    reason,
  }, 'workflow.git.state.updated', { mode: 'clear', reason });
}
