import test from 'node:test';
import assert from 'node:assert/strict';
import { isZipArtifactCandidate } from '../scripts/e2e/artifact-selection.js';

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
