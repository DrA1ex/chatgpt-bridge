import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncMutex } from '../src/mutex.js';

test('AsyncMutex runs tasks sequentially', async () => {
  const mutex = new AsyncMutex();
  const events = [];

  await Promise.all([
    mutex.runExclusive(async () => {
      events.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('a:end');
    }),
    mutex.runExclusive(async () => {
      events.push('b:start');
      events.push('b:end');
    }),
  ]);

  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});
