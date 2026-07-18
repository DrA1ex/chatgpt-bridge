import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
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
      if (['--max-cycles', '--session', '--action'].includes(token)) index += 1;
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
    actionPolicy: String(optionValue(tokens, '--action') || 'ask').toLowerCase(),
    sessionPolicy,
    sessionId: sessionPolicy === 'pinned' && !['pinned', 'current', 'new'].includes(sessionValue) ? sessionValue : '',
  };
}

export function workflowCliHelp() {
  return `Workflow commands:\n  bridge workflow init [path] [--force]\n  bridge workflow validate [path]\n  bridge workflow run [path] [--session current|new|pinned|<id>] [--max-cycles n] [--action ask|first|stop] [--verbose]\n  bridge workflow resume [path] [--action ask|first|stop]\n  bridge workflow discard [path]\n  bridge workflow serve [path]\n\nrun executes a fresh validation/repair cycle and exits.\nresume continues an interrupted run without changing its bound session.\nserve keeps the bridge and automatic workflow observer running until Ctrl+C.`;
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

export async function waitForWorkflowRun({ manager, workflowId, actionPolicy = 'ask', pollIntervalMs = 500, signal } = {}) {
  let promptedApprovalId = '';
  while (true) {
    if (signal?.aborted) {
      const error = new Error('Workflow run interrupted');
      error.code = 'WORKFLOW_RUN_INTERRUPTED';
      throw error;
    }
    const workflow = manager.get(workflowId);
    if (!workflow) throw new Error(`Workflow disappeared: ${workflowId}`);
    if (workflow.lastOutcome?.status === 'completed' && workflow.lifecycle !== 'running') return { ok: true, workflow };
    if (workflow.lastOutcome?.status === 'failed' || workflow.lifecycle === 'stopped') return { ok: false, workflow };

    if (workflow.nextAction) {
      const action = workflow.nextAction;
      const choiceIds = action.choices.map((choice) => typeof choice === 'string' ? choice : String(choice.id || ''));
      const firstChoice = choiceIds[0] || 'stop';
      if (action.id !== promptedApprovalId) {
        promptedApprovalId = action.id;
        if (actionPolicy === 'first') {
          console.log(`Workflow action required; choosing ${firstChoice} because --action first was selected.`);
          await manager.command(workflowId, { type: 'act', actionId: action.id, choice: firstChoice });
        } else if (actionPolicy === 'stop') {
          await manager.command(workflowId, { type: 'act', actionId: action.id, choice: choiceIds.includes('stop') ? 'stop' : firstChoice, reason: 'stopped by --action stop' });
          return { ok: false, workflow: manager.get(workflowId), actionStopped: true };
        } else {
          console.log(`Workflow action required: ${action.reason || action.kind}`);
          const accepted = await askYesNo('Continue?');
          if (accepted) await manager.command(workflowId, { type: 'act', actionId: action.id, choice: firstChoice });
          else {
            await manager.command(workflowId, { type: 'act', actionId: action.id, choice: choiceIds.includes('stop') ? 'stop' : firstChoice, reason: input.isTTY ? 'stopped by user' : 'interactive action is unavailable' });
            return { ok: false, workflow: manager.get(workflowId), actionStopped: true };
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
