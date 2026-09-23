import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskMessage } from '../src/project/service/context.js';


test('project task prompt no longer asks for fenced fallback changed files', () => {
  const message = buildTaskMessage({
    message: 'Fix tests',
    pack: { shouldAttach: false, snapshotId: 'abc123', file: { name: 'project.zip' } },
  });
  assert.match(message, /Return a downloadable ZIP artifact/);
  assert.doesNotMatch(message, /fenced blocks/);
  assert.doesNotMatch(message, /file:path\/to\/file/);
});


test('project-aware chat allows a text answer while still describing ZIP output for file changes', () => {
  const message = buildTaskMessage({
    message: 'Explain why this test fails',
    pack: { shouldAttach: true, snapshotId: 'abc123', file: { name: 'project.zip' } },
    output: { expected: 'zip', required: false },
  });
  assert.match(message, /A project ZIP snapshot is attached/);
  assert.match(message, /Answer normally when no project files need to change/);
  assert.match(message, /If you change project files, return one downloadable ZIP/);
  assert.doesNotMatch(message, /Return a downloadable ZIP artifact with the full updated project\./);
});
