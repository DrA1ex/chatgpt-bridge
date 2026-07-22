import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { readZipEntry, validateZipFile } from '../src/zipUtils.js';

async function generated(prompt, options = {}) {
  const state = new MockChatGptStateMachine({ tabId: options.tabId || 31 });
  state.appendUser(prompt, options.request || null);
  const revisions = [];
  await state.generate(prompt, { onChange: async (reason) => revisions.push({ reason, snapshot: state.outputSnapshot() }) });
  return { state, revisions, output: state.outputSnapshot() };
}

async function withZip(buffer, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-chatgpt-contract-'));
  const file = path.join(directory, 'artifact.zip');
  try {
    await fs.writeFile(file, buffer);
    return await callback(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('mock ChatGPT preserves exact-answer continuity inside one session', async () => {
  const state = new MockChatGptStateMachine({ tabId: 32 });
  const first = 'CONVERSATION_CONTROL_LOCAL';
  const follow = 'CONVERSATION_CONTINUITY_LOCAL';
  state.appendUser(`Output exactly ${first}.`);
  await state.generate(`Output exactly ${first}.`);
  state.appendUser(`Inspect the immediately previous assistant message. If it is exactly ${first}, output exactly ${follow}. Otherwise output exactly CONVERSATION_MISMATCH_LOCAL.`);
  await state.generate(`Inspect the immediately previous assistant message. If it is exactly ${first}, output exactly ${follow}. Otherwise output exactly CONVERSATION_MISMATCH_LOCAL.`);
  assert.equal(state.outputSnapshot().answer, follow);
});

test('mock ChatGPT exposes normalized model and effort options for the real E2E picker contract', () => {
  const state = new MockChatGptStateMachine({ tabId: 39 });
  const intelligence = state.intelligence();
  assert.ok(intelligence.models.length >= 2);
  assert.ok(intelligence.efforts.length >= 2);
  assert.equal(intelligence.models.every((option) => option.id && option.label && option.value), true);
  assert.equal(intelligence.efforts.every((option) => option.id && option.label && option.value), true);
  assert.equal(intelligence.models.filter((option) => option.selected).length, 1);
  assert.equal(intelligence.efforts.filter((option) => option.selected).length, 1);
});

test('mock ChatGPT emits the complete reasoning checkpoint sequence before the final answer', async () => {
  const { revisions, output } = await generated('This is a reasoning test. TEST_LOCAL_REASONING_BEGIN then TEST_LOCAL_REASONING_FINISH.');
  const percentages = [...new Set(revisions.flatMap(({ snapshot }) => snapshot.progressItems.map((item) => Number.parseInt(item.text, 10))).filter(Number.isFinite))];
  assert.deepEqual(percentages, Array.from({ length: 11 }, (_, index) => index * 10));
  assert.match(output.answer, /^TEST_LOCAL_REASONING_BEGIN/);
  assert.match(output.answer, /TEST_LOCAL_REASONING_FINISH$/);
  assert.ok(output.codeBlocks.some((block) => block.language === 'javascript'));
});

test('mock ChatGPT creates separately downloadable text, JSON, and CSV artifacts', async () => {
  const marker = 'LOCAL_ARTIFACT';
  const prompt = `Create and attach three separate downloadable files, not code blocks: one.txt containing the single line ${marker}_ONE; two.json containing valid JSON {"marker":"${marker}_TWO"}; and three.csv containing the CSV rows key,value and marker,${marker}_THREE. Attach all three files in one response.`;
  const { output } = await generated(prompt);
  assert.equal(output.artifacts.length, 3);
  assert.equal(output.artifacts.find((item) => item.name === 'one.txt').buffer.toString('utf8'), `${marker}_ONE\n`);
  assert.deepEqual(JSON.parse(output.artifacts.find((item) => item.name === 'two.json').buffer.toString('utf8')), { marker: `${marker}_TWO` });
  assert.equal(output.artifacts.find((item) => item.name === 'three.csv').buffer.toString('utf8').trim(), `key,value\nmarker,${marker}_THREE`);
});

test('mock ChatGPT creates a deterministic ZIP with exact nested entries', async () => {
  const prompt = 'Create one real ZIP file named local-bundle.zip. The archive must contain exactly two files: alpha.txt with content LOCAL_ALPHA and nested/beta.txt with content LOCAL_BETA.';
  const { output } = await generated(prompt);
  const artifact = output.artifacts[0];
  assert.equal(artifact.name, 'local-bundle.zip');
  await withZip(artifact.buffer, async (file) => {
    const validation = await validateZipFile(file);
    assert.deepEqual(validation.files.map((item) => item.path).sort(), ['alpha.txt', 'nested/beta.txt']);
    assert.equal((await readZipEntry(file, 'alpha.txt')).toString('utf8'), 'LOCAL_ALPHA');
    assert.equal((await readZipEntry(file, 'nested/beta.txt')).toString('utf8'), 'LOCAL_BETA');
  });
});

test('mock ChatGPT creates workflow project identity and requested source in one complete ZIP', async () => {
  const prompt = 'Create one real downloadable ZIP artifact containing the complete project. Use projectId local-project. Set package.json name exactly local-package. Set src/index.js to exactly: export const value = "LOCAL";\nInclude workflow E2E marker LOCAL_WORKFLOW.';
  const { output } = await generated(prompt);
  const artifact = output.artifacts[0];
  await withZip(artifact.buffer, async (file) => {
    const identity = JSON.parse((await readZipEntry(file, '.bridge/PROJECT_ID.json')).toString('utf8'));
    assert.equal(identity.projectId, 'local-project');
    assert.equal(identity.packageName, 'local-package');
    assert.equal((await readZipEntry(file, 'src/index.js')).toString('utf8').trim(), 'export const value = "LOCAL";');
  });
});

test('mock ChatGPT preserves workflow identity while returning a corrected remediation ZIP', async () => {
  const state = new MockChatGptStateMachine({ tabId: 33 });
  const initial = [
    'Create one real downloadable ZIP artifact containing the complete project at the archive root.',
    'This is workflow E2E marker LOCAL_REMEDIATION.',
    'Preserve .bridge/PROJECT_ID.json unchanged with projectId local-remediation-project.',
    'Keep package.json name exactly local-remediation-package.',
    'Set src/index.js to exactly: export const value = "REMEDIATION_BROKEN_LOCAL";',
  ].join('\n');
  state.appendUser(initial);
  await state.generate(initial);

  const remediation = [
    'The project artifact was downloaded and applied transactionally, but the configured validation commands failed. The project was rolled back.',
    'Fix the project based on the validation output below and return a new downloadable ZIP containing the full updated project at the archive root.',
    'VALIDATION_OUTPUT_BEGIN',
    'WORKFLOW_E2E_VALIDATION_FAILED expected REMEDIATION_FIXED_LOCAL in src/index.js',
    'VALIDATION_OUTPUT_END',
  ].join('\n');
  state.appendUser(remediation);
  await state.generate(remediation);
  const artifact = state.outputSnapshot().artifacts[0];

  await withZip(artifact.buffer, async (file) => {
    const identity = JSON.parse((await readZipEntry(file, '.bridge/PROJECT_ID.json')).toString('utf8'));
    assert.equal(identity.projectId, 'local-remediation-project');
    assert.equal(identity.packageName, 'local-remediation-package');
    assert.equal((await readZipEntry(file, 'src/index.js')).toString('utf8').trim(), 'export const value = "REMEDIATION_FIXED_LOCAL";');
  });
});

test('mock ChatGPT returns complete project context again on the second revision', async () => {
  const state = new MockChatGptStateMachine({ tabId: 34 });
  const firstPrompt = 'Return a complete ZIP of the project. Create result.txt at the archive root with exactly four lines: seed=LOCAL_SEED, agent=AGENT_LOCAL, skill=SKILL_LOCAL, revision=1. Preserve all other input files.';
  state.appendUser(firstPrompt);
  await state.generate(firstPrompt);
  const firstResult = state.outputSnapshot().answer;
  assert.equal(firstResult, 'Created project revision 1.');

  const secondPrompt = 'Use the result of the previous turn in this conversation and return an updated complete ZIP of the project. Change only result.txt: preserve the first three lines exactly, replace revision=1 with revision=2, and add a fifth line previous=0123456789abcdef.';
  state.appendUser(secondPrompt);
  await state.generate(secondPrompt);
  const artifact = state.outputSnapshot().artifacts[0];
  await withZip(artifact.buffer, async (file) => {
    const validation = await validateZipFile(file);
    assert.deepEqual(validation.files.map((item) => item.path).sort(), [
      '.bridge/skills/deterministic.md',
      'AGENT.md',
      'result.txt',
      'seed.txt',
    ]);
    assert.equal((await readZipEntry(file, 'seed.txt')).toString('utf8'), 'LOCAL_SEED\n');
    assert.match((await readZipEntry(file, 'AGENT.md')).toString('utf8'), /AGENT_LOCAL/);
    assert.equal((await readZipEntry(file, 'result.txt')).toString('utf8').trim(), [
      'seed=LOCAL_SEED',
      'agent=AGENT_LOCAL',
      'skill=SKILL_LOCAL',
      'revision=2',
      'previous=0123456789abcdef',
    ].join('\n'));
  });
});

test('mock ChatGPT acknowledges project-context synchronization exactly', async () => {
  const marker = 'PROJECT_CONTEXT_SYNCED_local-project-id';
  const { output } = await generated([
    'Use the attached project archive as the current source of truth for this workflow.',
    'The stable project id is local-project-id.',
    'Do not treat this synchronization message as a request to modify the project.',
    `Reply exactly ${marker}.`,
  ].join('\n'));
  assert.equal(output.answer, marker);
});

test('mock ChatGPT keeps a steer window open and applies the override once', async () => {
  const state = new MockChatGptStateMachine({ tabId: 35 });
  const prompt = 'This tests steering an active request. Simulate a long multi-step task: compute the sum of squares from 1 through 240. Initial rule: output exactly STEER_RESULT RED.';
  state.appendUser(prompt, { requestId: 'steer-local', leaseId: 'lease-local', ownerServerInstanceId: 'server-local', responseEpoch: 0 });
  const generation = state.generate(prompt);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(state.generating, true);
  assert.equal(state.outputSnapshot().answer, '');
  state.appendUser('This new instruction overrides the original response rule. Output exactly STEER_RESULT BLUE.', { requestId: 'steer-local', leaseId: 'lease-local', ownerServerInstanceId: 'server-local', responseEpoch: 1 });
  await state.steer('This new instruction overrides the original response rule. Output exactly STEER_RESULT BLUE.');
  await generation;
  assert.equal(state.outputSnapshot().answer, 'STEER_RESULT BLUE');
  assert.equal(state.turns.filter((turn) => turn.role === 'assistant' && turn.text === 'STEER_RESULT BLUE').length, 1);
});

test('a stale steered generation cannot terminate a newer passive generation', async () => {
  const state = new MockChatGptStateMachine({ tabId: 40 });
  const stalePrompt = 'This tests steering an active request. Simulate a long multi-step task: compute the sum of squares from 1 through 240. Initial rule: output exactly STEER_RESULT RED.';
  state.appendUser(stalePrompt, { requestId: 'stale-steer', leaseId: 'lease-stale', ownerServerInstanceId: 'server-local', responseEpoch: 0 });
  const staleGeneration = state.generate(stalePrompt);
  await new Promise((resolve) => setTimeout(resolve, 120));
  state.appendUser('This new instruction overrides the original response rule. Output exactly STEER_RESULT BLUE.', { requestId: 'stale-steer', leaseId: 'lease-stale', ownerServerInstanceId: 'server-local', responseEpoch: 1 });
  await state.steer('This new instruction overrides the original response rule. Output exactly STEER_RESULT BLUE.');

  const marker = 'PASSIVE_GENERATION_SURVIVED_LOCAL';
  const nextPrompt = `Analyze whether 98765431 is prime. Show a short verification, then finish with exactly ${marker} on its own final line.`;
  state.appendUser(nextPrompt, null);
  const nextGeneration = state.generate(nextPrompt);

  await staleGeneration;
  assert.equal(state.generating, true, 'The stale pre-steer generator must not clear the newer generation state');
  assert.equal(state.outputSnapshot().answer, '');

  await nextGeneration;
  assert.equal(state.generating, false);
  assert.match(state.outputSnapshot().answer, new RegExp(`${marker}$`));
});

test('mock ChatGPT keeps the reload scenario active past the proved-boundary wait', async () => {
  const state = new MockChatGptStateMachine({ tabId: 36 });
  const marker = 'RELOAD_RECOVERED_LOCAL';
  const prompt = `Analyze whether 98765431 is prime. Show a short verification, then finish with exactly ${marker} on its own final line.`;
  state.appendUser(prompt, { requestId: 'reload-local', leaseId: 'lease-local', ownerServerInstanceId: 'server-local', responseEpoch: 0 });
  const generation = state.generate(prompt);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(state.generating, true);
  assert.equal(state.outputSnapshot().answer, '');
  await generation;
  assert.match(state.outputSnapshot().answer, new RegExp(`${marker}$`));
});

test('mock ChatGPT returns a complete no-context fallback project ZIP', async () => {
  const prompt = 'Return a complete ZIP of the project and add fallback.txt containing the single line NO_CONTEXT_LOCAL. The absence of AGENT.md and the requested skill must not be treated as an error.';
  const { output } = await generated(prompt);
  const artifact = output.artifacts[0];
  await withZip(artifact.buffer, async (file) => {
    const validation = await validateZipFile(file);
    assert.deepEqual(validation.files.map((item) => item.path).sort(), ['fallback.txt', 'plain.txt']);
    assert.equal((await readZipEntry(file, 'plain.txt')).toString('utf8'), 'plain\n');
    assert.equal((await readZipEntry(file, 'fallback.txt')).toString('utf8'), 'NO_CONTEXT_LOCAL\n');
  });
});

test('mock ChatGPT attachment state is cleared by the same operation used by composer recovery', () => {
  const state = new MockChatGptStateMachine({ tabId: 37 });
  state.setAttachments([
    { id: 'one', name: 'one.zip', mime: 'application/zip', size: 12 },
    { id: 'two', name: 'two.txt', mime: 'text/plain', size: 4 },
  ]);
  const beforeRevision = state.revision;
  const result = state.clearAttachments();
  assert.deepEqual(result, { removed: 2, attachments: [] });
  assert.deepEqual(state.publicState().attachments, []);
  assert.equal(state.revision, beforeRevision + 1);
});


test('mock ChatGPT never reuses a previous terminal artifact for a newly submitted passive prompt', async () => {
  const state = new MockChatGptStateMachine({ tabId: 38 });
  const firstPrompt = [
    'Create one real downloadable ZIP artifact containing the complete project at the archive root.',
    'This is workflow E2E marker BRIDGE_E2E_PREVIOUS.',
    'Preserve .bridge/PROJECT_ID.json unchanged with projectId local-shared-project.',
    'Keep package.json name exactly local-shared-package.',
    'Set src/index.js to exactly: export const value = "PREVIOUS_VALUE";',
  ].join('\n');
  state.appendUser(firstPrompt);
  await state.generate(firstPrompt);
  const previous = state.outputSnapshot();
  assert.equal(previous.artifacts.length, 1);
  const previousAssistantKey = previous.assistant.key;

  const nextPrompt = [
    'Create one real downloadable ZIP artifact containing the complete project at the archive root.',
    'This is workflow E2E marker BRIDGE_E2E_APPROVAL.',
    'Preserve .bridge/PROJECT_ID.json unchanged with projectId local-shared-project.',
    'Keep package.json name exactly local-shared-package.',
    'Set src/index.js to exactly: export const value = "APPROVAL_VALUE";',
  ].join('\n');
  state.appendUser(nextPrompt);
  const pending = state.outputSnapshot();
  assert.equal(pending.assistant, null);
  assert.deepEqual(pending.artifacts, []);

  await state.generate(nextPrompt);
  const completed = state.outputSnapshot();
  assert.notEqual(completed.assistant.key, previousAssistantKey);
  assert.equal(completed.artifacts.length, 1);
  await withZip(completed.artifacts[0].buffer, async (file) => {
    assert.equal((await readZipEntry(file, 'src/index.js')).toString('utf8').trim(), 'export const value = "APPROVAL_VALUE";');
  });
});
