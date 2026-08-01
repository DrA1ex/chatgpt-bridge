import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { applyLastTurnResult } from './apply.js';
import { bytes, truncate } from './format.js';
import { startServerArchiveWorkflow } from './serverWorkflowCommands.js';
import {
  answerTextFromTurnItems,
  clearSelectedResult,
  rememberResponse,
  selectResultForApply,
} from './state.js';
import { workflowRunActive } from '../workflow/ux/workflowView.js';

function activeLegacyForProject(context) {
  return context.workflowManager?.list?.().find((workflow) => (
    workflowRunActive(workflow)
    && (!context.state.projectRoot
      || (workflow.projectRoot
        && path.resolve(workflow.projectRoot) === path.resolve(context.state.projectRoot)))
  )) || null;
}

export async function recoverLatestResponse(context, {
  force = false,
  apply = false,
  index = 1,
  list = false,
  sourceClientId = '',
  turnKey = '',
} = {}) {
  const { bridge, turnManager, fileStore, state, projectService, confirm } = context;

  if (list) {
    console.log('[recover] requesting recent assistant responses from the active ChatGPT tab...');
    const responses = await bridge.recoverResponses({ limit: 5, timeoutMs: 30_000 });
    if (!responses.length) {
      console.log('[recover] no visible assistant responses found');
      return null;
    }
    console.log('[recover] recent assistant responses:');
    for (const item of responses) {
      const preview = truncate(item.answer || item.thinking || '(empty)', 160);
      console.log(`  [${item.candidateIndex || '?'}] turn ${item.turnIndex ?? '?'} · ${item.answer.length} chars · ${item.artifacts.length} artifact(s) · ${preview}`);
    }
    console.log('Use /recover <n> or /recover <n> --apply to pick one.');
    return responses;
  }

  const selectedIndex = Math.max(1, Number(index) || 1);
  if (turnManager) {
    console.log(`[recover] requesting assistant response #${selectedIndex} from the active ChatGPT tab...`);
    const expectedOutput = state.projectRoot ? { expected: 'zip', required: true } : { expected: 'text', required: false };
    const turn = await turnManager.recoverTurnFromLatestResponse(state.lastTurnId || '', {
      force,
      index: selectedIndex,
      timeoutMs: 30_000,
      allowAdoptedTurn: true,
      threadId: state.projectThreadId || '',
      cwd: state.projectRoot || '',
      sessionId: state.sessionId || '',
      expectedOutput,
      sourceClientId,
      turnKey,
    });
    state.lastTurnId = turn.id;
    state.lastTurn = turn;
    if (turn.threadId) state.projectThreadId = turn.threadId;
    console.log(`[recover] recovered ${turn.id} from assistant response #${selectedIndex} · ${turn.status}`);
    if (turn.output) {
      console.log(`[recover] result: ${turn.output.type || 'unknown'} · ${turn.output.name || ''} · ${bytes(turn.output.size)}`);
      if (turn.output.fileId) console.log(`[recover] file: ${turn.output.fileId}`);
      if (turn.output.reconstructedFrom) console.log(`[recover] reconstructed from: ${turn.output.reconstructedFrom}`);
      if (turn.output.type === 'zip' && turn.output.fileId) selectResultForApply(state, turn, { source: 'recover' });
      else if (apply) clearSelectedResult(state, 'recover_without_zip');
    }
    const recoveredText = await answerTextFromTurnItems(turnManager, turn);
    rememberResponse(state, {
      id: turn.id,
      turnId: turn.id,
      source: 'recover',
      title: `Recovered response ${turn.id}`,
      text: recoveredText,
      artifactCount: Array.isArray(turn.output?.artifacts) ? turn.output.artifacts.length : 0,
      createdAt: turn.completedAt || turn.updatedAt || turn.createdAt,
    });
    if (apply && turn.output?.type === 'zip') {
      console.log('[recover] applying recovered ZIP result...');
      if (context.zipflowWorkflowRuntime && !activeLegacyForProject(context)) {
        await startServerArchiveWorkflow(context);
      } else {
        await applyLastTurnResult(fileStore, state, {
          force,
          confirm,
          projectService,
          turnManager,
        });
      }
    } else if (apply) {
      console.log('[recover] recovered response is not a ZIP result; nothing to apply');
    }
    return turn;
  }

  console.log(`[recover] requesting assistant response #${selectedIndex} from the active ChatGPT tab...`);
  const response = await bridge.recoverLatestResponse({ index: selectedIndex, timeoutMs: 30_000 });
  state.lastArtifacts = response.artifacts || [];
  console.log(`[recover] assistant response #${selectedIndex} · ${response.answer.length} chars · ${state.lastArtifacts.length} artifact(s)`);
  rememberResponse(state, {
    id: `recovered-${selectedIndex}-${Date.now()}`,
    source: 'recover',
    title: `Recovered assistant response #${selectedIndex}`,
    text: response.answer || response.response || '',
    artifactCount: state.lastArtifacts.length,
    createdAt: response.recoveredAt,
  });
  if (response.answer) console.log(response.answer.slice(0, 2000));
  if (state.lastArtifacts.length) {
    for (const [artifactIndex, artifact] of state.lastArtifacts.entries()) console.log(`  [${artifactIndex + 1}] ${artifact.name || artifact.id || 'artifact'} · ${artifact.id || ''}`);
  }
  return response;
}

export async function downloadLastTurnResult(fileStore, state, targetArg = '') {
  const turn = state.lastTurn;
  const fileId = turn?.output?.fileId;
  if (!fileId) {
    console.log('No downloadable ZIP result in the last turn.');
    return;
  }
  const readable = await fileStore.getReadable(fileId);
  if (!readable?.absolutePath) throw new Error(`Result file is not readable: ${fileId}`);
  let target = targetArg ? path.resolve(targetArg) : path.join(config.dataDir, 'downloads', readable.name || `result-${turn.id}.zip`);
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) target = path.join(target, readable.name || `result-${turn.id}.zip`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(readable.absolutePath, target);
  console.log(`[result] downloaded → ${target}`);
}
