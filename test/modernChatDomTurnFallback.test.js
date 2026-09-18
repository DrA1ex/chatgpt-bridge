import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

test('modern ChatGPT message classes are discovered as user and assistant turns', async () => {
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(`
    <main>
      <div class="w-full">
        <div class="bg-user-message">
          <div class="rich-text-user-turn">Ping modern</div>
        </div>
        <div class="assistant-block">
          <h4 class="sr-only">ChatGPT</h4>
          <div class="MarkdownRoot-abc123"><p>Reply modern</p></div>
        </div>
      </div>
    </main>
  `);

  assert.equal(snapshot.answer, 'Reply modern');
  assert.equal(snapshot.format, 'markdown');
  assert.equal(snapshot.turnCount, 2);
});

test('modern user bubble text is eligible for submitted-user matching', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseUserTurn(`
    <main>
      <div class="bg-user-message">
        <div class="rich-text-user-turn">A real submitted prompt</div>
      </div>
    </main>
  `);

  assert.equal(result.prompt, 'A real submitted prompt');
  assert.equal(result.error.hasError, false);
});
