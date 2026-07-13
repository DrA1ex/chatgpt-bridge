import test from 'node:test';
import assert from 'node:assert/strict';
import { createE2eConsole, stripAnsi } from '../scripts/e2e-console.js';

test('E2E console renders colored statuses while persisting a plain readable log', () => {
  const terminal = [];
  const persisted = [];
  const originalLog = console.log;
  console.log = (line) => terminal.push(String(line));
  try {
    const logger = createE2eConsole({
      startedAt: Date.now(),
      colorMode: 'always',
      appendPlainLine: (line) => persisted.push(line),
    });
    logger.retry('model-picker', 'Trying the fallback once', { attempt: '2/2', timeoutMs: 1300 });
    logger.ok('model-picker', 'Picker state verified', { model: 'GPT-5.5', effort: 'high' });
  } finally {
    console.log = originalLog;
  }

  assert.equal(terminal.length, 2);
  assert.match(terminal[0], /\u001b\[/);
  assert.match(stripAnsi(terminal[0]), /RETRY/);
  assert.match(stripAnsi(terminal[1]), /Picker state verified/);
  assert.equal(persisted.length, 2);
  assert.doesNotMatch(persisted[0], /\u001b\[/);
  assert.match(persisted[0], /attempt=2\/2/);
});
