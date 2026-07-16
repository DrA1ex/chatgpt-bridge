import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  resolveWorkflowApproval,
  workflowHasBlockingAction,
  workflowRunActive,
  workflowStage,
} from '../workflow/ux/workflowView.js';

function optionValue(tokens, name) {
  const index = tokens.indexOf(name);
  return index >= 0 ? String(tokens[index + 1] || '') : '';
}

function positionals(tokens = []) {
  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || '');
    if (token.startsWith('--')) {
      if (['--max-cycles', '--session', '--approve'].includes(token)) index += 1;
      continue;
    }
    values.push(token);
  }
  return values;
}

export function parseWorkflowCli(args = []) {
  if (args[0] !== 'workflow') return null;
  const action = String(args[1] || 'help').toLowerCase();
  const tokens = args.slice(2);
  const positional = positionals(tokens);
  const sessionValue = optionValue(tokens, '--session') || 'current';
  const sessionPolicy = sessionValue === 'new'
    ? 'new'
    : sessionValue === 'pinned'
      ? 'pinned'
      : sessionValue === 'current'
        ? 'current'
        : 'pinned';
  return {
    action: action === 'watch' ? 'serve' : action,
    configPath: positional[0] || '',
    force: tokens.includes('--force'),
    verbose: tokens.includes('--verbose'),
    maxCycles: Number(optionValue(tokens, '--max-cycles')) || undefined,
    approve: String(optionValue(tokens, '--approve') || 'ask').toLowerCase(),
    sessionPolicy,
    sessionId: sessionPolicy === 'pinned' && !['pinned', 'current', 'new'].includes(sessionValue) ? sessionValue : '',
  };
}

export function workflowCliHelp() {
  return `Workflow commands:\n  bridge workflow init [path] [--force]\n  bridge workflow validate [path]\n  bridge workflow run [path] [--session current|new|pinned|<id>] [--max-cycles n] [--approve ask|always|never] [--verbose]\n  bridge workflow resume [path] [--approve ask|always|never]\n  bridge workflow discard [path]\n  bridge workflow serve [path]\n\nrun executes a fresh validation/repair cycle and exits.\nresume continues an interrupted run without changing its bound session.\nserve keeps the bridge and automatic workflow observer running until Ctrl+C.`;
}

async function askYesNo(question) {
  if (!input.isTTY || !output.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function waitForWorkflowRun({ manager, workflowId, approve = 'ask', pollIntervalMs = 500, signal } = {}) {
  let promptedApprovalId = '';
  while (true) {
    if (signal?.aborted) {
      const error = new Error('Workflow run interrupted');
      error.code = 'WORKFLOW_RUN_INTERRUPTED';
      throw error;
    }
    const workflow = manager.get(workflowId);
    if (!workflow) throw new Error(`Workflow disappeared: ${workflowId}`);
    const status = String(workflow.automation?.status || 'idle');
    if (status === 'completed') return { ok: true, workflow };
    if (status === 'failed' || status === 'stopped') return { ok: false, workflow };
    if (workflow.automationInterrupted) return { ok: false, interrupted: true, workflow };

    if (status === 'awaiting_approval' || workflow.pipeline?.status === 'awaiting_approval') {
      const approval = resolveWorkflowApproval(await manager.approvals(), workflowId, '');
      if (approval.id !== promptedApprovalId) {
        promptedApprovalId = approval.id;
        if (approve === 'always') {
          console.log('Approval required; applying automatically because --approve always was selected.');
          await manager.approve(approval.id);
        } else if (approve === 'never') {
          await manager.reject(approval.id, 'approval disabled by --approve never');
          return { ok: false, workflow: manager.get(workflowId), approvalRejected: true };
        } else {
          const plan = approval.plan || {};
          const counts = plan.counts || {};
          console.log(`Approval required: create ${counts.create || 0}, update ${counts.update || 0}, delete ${counts.delete || 0}`);
          const accepted = await askYesNo('Apply these changes?');
          if (accepted) await manager.approve(approval.id);
          else {
            await manager.reject(approval.id, input.isTTY ? 'rejected by user' : 'interactive approval is unavailable');
            return { ok: false, workflow: manager.get(workflowId), approvalRejected: true };
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(pollIntervalMs) || 500)));
  }
}


export function workflowSignalState(manager, workflowId = '') {
  const workflows = workflowId
    ? [manager.get(workflowId)].filter(Boolean)
    : manager.list();
  const workflow = workflows.find(workflowRunActive) || null;
  return {
    workflow,
    blocking: Boolean(workflow && workflowHasBlockingAction(workflow)),
    exitCode: workflow ? 130 : 0,
  };
}

export function installWorkflowSignalHandler({ manager, workflowId = '', shutdown } = {}) {
  let confirming = false;
  let forced = false;
  const handler = async () => {
    if (forced) return;
    if (confirming) {
      forced = true;
      console.error('\nForce exiting.');
      await shutdown('SIGINT-force', 130, { stopRun: false });
      return;
    }
    const state = workflowSignalState(manager, workflowId);
    const workflow = state.workflow;
    if (!state.blocking) {
      await shutdown('SIGINT', state.exitCode, { stopRun: false, preserveActiveWork: Boolean(workflow) });
      return;
    }
    confirming = true;
    const stage = workflowStage(workflow);
    const accepted = await askYesNo(`\n${workflow.id} is ${stage.label.toLowerCase()}. Stop the run and exit?`);
    confirming = false;
    if (!accepted) {
      console.log('Continuing. Press Ctrl+C again when you are ready to stop.');
      return;
    }
    await manager.stopAutomation(workflow.id, 'stopped during graceful shutdown').catch(() => null);
    await shutdown('SIGINT', 130, { stopRun: true });
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}
