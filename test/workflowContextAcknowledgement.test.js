import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesProjectContextAcknowledgement } from '../src/workflow/contextAcknowledgement.js';

test('project context acknowledgement accepts exact marker with harmless surrounding formatting', () => {
  const marker = 'PROJECT_CONTEXT_SYNCED_bridge-project-671af08a-21f5-49f9-b8b8-8a845d7f805d';
  for (const answer of [
    marker,
    `${marker}.`,
    `\`${marker}\``,
    `Acknowledged: ${marker}.`,
    `\n${marker}\n`,
  ]) assert.equal(matchesProjectContextAcknowledgement(answer, marker), true, answer);
});

test('project context acknowledgement rejects a different or extended project id', () => {
  const marker = 'PROJECT_CONTEXT_SYNCED_bridge-project-671af08a-21f5-49f9-b8b8-8a845d7f805d';
  for (const answer of [
    `${marker}-other`,
    `x${marker}`,
    'PROJECT_CONTEXT_SYNCED_bridge-project-different',
    '',
  ]) assert.equal(matchesProjectContextAcknowledgement(answer, marker), false, answer);
});
