import test from 'node:test';
import assert from 'node:assert/strict';
import { isZipArtifactCandidate } from '../scripts/e2e/artifact-selection.js';
import { selectMaterializableZipFallback } from '../src/results/artifacts.js';
import { requiredOutputArtifactMissing } from '../src/bridge/requestState.js';

test('ZIP selection recognizes a localized download action without a filename', () => {
  assert.equal(isZipArtifactCandidate({
    name: '6a575e05-5bb8-83eb-8abb-d59f82c30789',
    actionLabel: 'Download the updated complete project ZIP',
    mime: 'application/octet-stream',
  }), true);
});

test('ZIP selection rejects a plain conversation navigation artifact', () => {
  assert.equal(isZipArtifactCandidate({
    name: '6a575e05-5bb8-83eb-8abb-d59f82c30789',
    url: 'https://chatgpt.com/c/6a575e05-5bb8-83eb-8abb-d59f82c30789',
    mime: 'application/octet-stream',
  }), false);
});

test('ZIP selection ignores archive words that exist only in ambient reasoning text', () => {
  assert.equal(isZipArtifactCandidate({
    name: 'result.txt',
    actionLabel: 'Ответить сейчас',
    blockText: 'Add result.txt and verify the final root-level ZIP.',
    mime: 'text/plain',
  }), false);
});

test('server ZIP fallback ignores ambient reasoning text on generic controls', () => {
  const artifacts = [
    {
      id: 'reasoning-control',
      name: 'Respond now',
      actionLabel: 'Respond now',
      blockText: 'Add result.txt and verify the final root-level ZIP.',
      kind: 'action',
      phase: 'READY',
      downloadActionPresent: true,
      sourceTurnKey: 'assistant-turn',
    },
    {
      id: 'other-control',
      name: 'Open file',
      actionLabel: 'Open file',
      blockText: 'Unrelated generic control.',
      kind: 'action',
      phase: 'READY',
      downloadActionPresent: true,
      sourceTurnKey: 'assistant-turn',
    },
  ];
  const response = { turnKey: 'assistant-turn' };
  const selection = selectMaterializableZipFallback(artifacts, response);
  assert.equal(selection.artifact, null);
  assert.equal(selection.reason, 'ambiguous_materializable_artifacts');
  assert.equal(requiredOutputArtifactMissing({
    requestId: 'request-1',
    expectedOutput: { expected: 'zip', required: true },
    progress: { assistantTurnKey: 'assistant-turn' },
    artifacts,
  }), true);
});
