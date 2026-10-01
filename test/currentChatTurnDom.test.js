import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

test('keyed ChatGPT turns correlate the exact user prompt and assistant branch', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="turn-current">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <div data-content-search-unit-key="user-unit"><p>A real submitted prompt</p></div>
          </div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-content-search-unit-key="assistant-unit" data-chatgpt-search-unit-key="assistant-unit" data-chatgpt-search-message-ids="assistant-search-record">
            <div class="MarkdownRoot-test"><p>Correct current answer</p></div>
          </div>
        </div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'turn-current::user' });

  assert.equal(result.userTurnKey, 'turn-current::user');
  assert.equal(result.turnKey, 'turn-current::assistant');
  assert.equal(result.answer, 'Correct current answer');
  assert.deepEqual(
    Array.from(parser.snapshots.getTurnNodes(), parser.snapshots.turnRole),
    ['user', 'assistant'],
  );
});
