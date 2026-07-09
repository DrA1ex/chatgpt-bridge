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
