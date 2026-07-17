import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactsFromTurnSnapshot } from '../scripts/e2e/artifact-selection.js';

test('turn artifact projection prefers the artifact already validated into output', () => {
  const result = artifactsFromTurnSnapshot({
    turn: { output: { artifactId: 'artifact_final', name: 'project.zip', mime: 'application/zip' } },
    items: [
      { type: 'artifact', status: 'completed', content: { artifact: { id: 'artifact_streaming', name: 'Download the complete updated project ZIP' } } },
      { type: 'artifact', status: 'completed', content: { artifact: { id: 'artifact_final', name: 'Download the complete updated project ZIP' } } },
    ],
  });
  assert.deepEqual(result.map((item) => item.id), ['artifact_final']);
});

test('turn artifact projection synthesizes validated output metadata when historical items are absent', () => {
  const result = artifactsFromTurnSnapshot({
    turn: { output: { artifactId: 'artifact_final', name: 'project.zip', mime: 'application/zip' } },
    items: [],
  });
  assert.deepEqual(result, [{ id: 'artifact_final', name: 'project.zip', fileName: 'project.zip', mime: 'application/zip' }]);
});
