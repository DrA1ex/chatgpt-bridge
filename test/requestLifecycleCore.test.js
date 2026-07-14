import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadCore() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestLifecycleCore.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'requestLifecycleCore.js' });
  return context.ChatGptRequestLifecycleCore;
}

test('request lifecycle core preserves the complete terminal snapshot contract', async () => {
  const core = await loadCore();
  const request = {
    requestId: 'req-1',
    lastAnswer: 'cached answer',
    lastThinking: 'cached thinking',
    lastProgressText: 'cached progress',
    reasoningHistory: [{ id: 'reason-1', text: 'reasoning' }],
    artifacts: [{ id: 'artifact-fallback', phase: 'READY' }],
    assistantTurnKey: 'turn-fallback',
    assistantTurnIndex: 7,
  };
  const snapshot = {
    answer: 'final answer',
    thinking: 'final thinking',
    progress: 'final progress',
    progressItems: [{ id: 'progress-1', text: 'done' }],
    responseBlocks: [{ type: 'paragraph', text: 'final answer' }],
    codeBlocks: [{ language: 'js', text: 'console.log(1)' }],
    codeBlockDiagnostics: [{ index: 0, source: 'pre' }],
    parserAudit: { complete: true },
    artifacts: [{ id: 'artifact-1', phase: 'READY' }],
    turnKey: 'turn-1',
    turnIndex: 3,
    messageId: 'message-1',
    modelSlug: 'gpt-test',
    phase: 'assistant_final',
    format: 'markdown',
  };

  const payload = core.terminalSnapshotPayload(request, snapshot, {
    reason: 'done.by_dom',
    stableForMs: 900,
    generationIdleForMs: 700,
    terminalSettled: true,
    finalizationConfidence: 'high',
    networkDone: true,
  });

  assert.equal(payload.type, 'request.terminal_snapshot');
  assert.equal(payload.requestId, 'req-1');
  assert.equal(payload.answer, 'final answer');
  assert.deepEqual(payload.responseBlocks, snapshot.responseBlocks);
  assert.deepEqual(payload.codeBlocks, snapshot.codeBlocks);
  assert.deepEqual(payload.codeBlockDiagnostics, snapshot.codeBlockDiagnostics);
  assert.deepEqual(payload.parserAudit, snapshot.parserAudit);
  assert.deepEqual(payload.artifacts, snapshot.artifacts);
  assert.equal(payload.turnKey, 'turn-1');
  assert.equal(payload.completionEvidence.terminalSettled, true);
  assert.equal(payload.completionEvidence.networkDone, true);
  assert.notEqual(core.terminalSnapshotSignature(snapshot), core.terminalSnapshotSignature({ ...snapshot, answer: 'changed' }));
});

test('request lifecycle core creates typed terminal failure observations', async () => {
  const core = await loadCore();
  const payload = core.terminalFailurePayload(
    { requestId: 'req-failure', phase: 'attachments_uploading' },
    { code: 'ATTACHMENT_UPLOAD_FAILED', message: 'Upload failed', retryable: false },
    { effectId: 'effect-1', effectType: 'attachment.upload', evidence: { file: 'input.zip' } },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    type: 'request.terminal_failure',
    requestId: 'req-failure',
    code: 'ATTACHMENT_UPLOAD_FAILED',
    message: 'Upload failed',
    retryable: false,
    effectId: 'effect-1',
    effectType: 'attachment.upload',
    evidence: { file: 'input.zip' },
    phase: 'attachments_uploading',
  });
});
