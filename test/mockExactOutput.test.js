import test from 'node:test';
import assert from 'node:assert/strict';

import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';

async function generateAnswer(prompt) {
  const state = new MockChatGptStateMachine({ tabId: 91 });
  state.appendUser(prompt);
  const turn = await state.generate(prompt);
  return turn.text;
}

test('mock exact-output parser removes instruction suffixes from the requested answer', async () => {
  assert.equal(await generateAnswer('Output exactly MODEL_EFFORT_OK and nothing else.'), 'MODEL_EFFORT_OK');
  assert.equal(await generateAnswer('Reply exactly RESTORED on its own final line.'), 'RESTORED');
});
