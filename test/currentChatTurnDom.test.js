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
  `, { submittedUserTurnKey: 'user-message-id' });

  assert.equal(result.userTurnKey, 'user-message-id');
  assert.equal(result.turnKey, 'turn-current::assistant');
  assert.equal(result.answer, 'Correct current answer');
  assert.deepEqual(
    Array.from(parser.snapshots.getTurnNodes(), parser.snapshots.turnRole),
    ['user', 'assistant'],
  );
});

test('legacy assistant role nodes inside a keyed turn do not duplicate its assistant branch', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`
    <main>
      <div data-turn-key="turn-mixed">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <p>Prompt</p>
          </div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-message-author-role="assistant" data-message-id="assistant-message-id">
            <div class="MarkdownRoot-test"><p>One answer</p></div>
          </div>
        </div>
      </div>
    </main>
  `);

  const assistants = parser.snapshots.getTurnNodes().filter((turn) => parser.snapshots.turnRole(turn) === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().answer, 'One answer');
});

test('keyed assistant boundary cannot select an answer from a later turn', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="first">
        <div class="group/user-message" data-chatgpt-search-unit-key="a:user" data-chatgpt-search-message-ids="user-a">Repeat</div>
      </div>
      <div data-turn-key="second">
        <div class="group/user-message" data-chatgpt-search-unit-key="b:user" data-chatgpt-search-message-ids="user-b">Repeat</div>
        <div><span hidden data-chatgpt-agent-turn-start></span><div class="MarkdownRoot-test">Wrong answer</div></div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'user-a' });
  assert.equal(result.answer, '');
});


test('grouped completion controls belong to the answer, not the user or embedded code', async () => {
  const parser = await createAssistantFixtureParser();
  const mount = (footer = '') => parser.mount(`
    <main>
      <div data-turn-key="shared-footer">
        <div class="group/user-message" data-chatgpt-search-unit-key="a:user" data-chatgpt-search-message-ids="user-a">
          <div data-user-message-bubble>Prompt</div>
          <div class="turn-action-controls"><button data-testid="copy-turn-action-button">User copy</button></div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-response-body="answer-a">
            <div class="MarkdownRoot-test"><p>Answer</p><pre><code>x</code><button data-testid="copy-turn-action-button">Code copy</button></pre></div>
          </div>
        </div>
        ${footer}
      </div>
    </main>`);
  const signal = () => {
    const turn = parser.snapshots.getTurnNodes().find(node => parser.snapshots.turnRole(node) === 'assistant');
    assert.ok(turn);
    return parser.snapshots.responseActionBarVisible(turn);
  };
  mount();
  assert.equal(signal(), false);
  mount('<div class="turn-action-controls" hidden><button>Hidden footer</button></div>');
  assert.equal(signal(), false);
  mount('<div class="turn-action-controls"><button>Assistant copy</button></div>');
  assert.equal(signal(), true);
});

test('grouped progress Markdown is not a final answer before the first status', async () => {
  const parser = await createAssistantFixtureParser();
  const mount = (answer = '') => parser.mount(`
    <main>
      <div data-turn-key="shared-progress">
        <div class="group/user-message" data-chatgpt-search-unit-key="a:user" data-chatgpt-search-message-ids="user-a">Prompt</div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div class="MarkdownRoot-test"><p>I will investigate</p></div>
          <div data-streaming-response-status><div class="MarkdownRoot-test"><p>Working on it</p></div></div>
          ${answer}
        </div>
      </div>
    </main>`);
  mount();
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().hasFinalMessage, false);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().answer, '');
  mount('<div data-markdown-text-style="assistant-message"><p>Actual answer</p></div><div data-streaming-response-status>More work</div>');
  const response = parser.snapshots.readLatestAssistantSnapshot();
  assert.equal(response.hasFinalMessage, true);
  assert.equal(response.answer, 'Actual answer');
});


test('grouped role headings and user bubbles work without search unit ids', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="bubble-only">
        <div class="user-branch"><div data-user-message-bubble>Prompt text</div></div>
        <div class="assistant-branch">
          <h4 class="sr-only" data-conversation-role="assistant">ChatGPT said</h4>
          <div data-markdown-text-style="assistant-message"><p>Correct answer</p></div>
        </div>
      </div>
    </main>`, { submittedUserTurnKey: 'bubble-only::user' });
  assert.equal(result.userTurnKey, 'bubble-only::user');
  assert.equal(result.turnKey, 'bubble-only::assistant');
  assert.equal(result.answer, 'Correct answer');
  const user = parser.snapshots.getTurnNodes().find(node => parser.snapshots.turnRole(node) === 'user');
  assert.equal(parser.snapshots.readUserTurnPromptText(user), 'Prompt text');
});

test('rich user bubbles preserve code fences for submission boundary matching', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseUserTurn(`
    <main>
      <div data-turn-key="rich">
        <div data-user-message-bubble>
          <div data-markdown-text-tone="user-message" class="rich-text-user-turn">
            <p>Run this:</p>
            <pre data-markdown-copy="code-block"><code data-markdown-copy-content="true" data-language="js">const x = 1;</code></pre>
            <p>Then continue.</p>
          </div>
        </div>
      </div>
    </main>`);
  assert.equal(result.prompt, 'Run this:\n```js\nconst x = 1;\n```\nThen continue.');
});


test('virtualized submitted user does not hide a previously anchored assistant answer', async () => {
  const parser = await createAssistantFixtureParser();
  const html = `<main>
    <div data-turn="assistant" data-turn-id="other-answer"><div data-message-author-role="assistant" data-message-id="other"><p>Old answer</p></div></div>
    <div data-turn="assistant" data-turn-id="current-answer"><div data-message-author-role="assistant" data-message-id="current"><p>Final answer</p></div></div>
  </main>`;
  const result = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'submitted-user', assistantTurnKey: 'current-answer' });
  assert.equal(result.answer, 'Final answer');
  assert.equal(result.userTurnKey, 'submitted-user');
  assert.equal(result.reason, 'anchored_assistant_after_virtualization');
  assert.equal(parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'submitted-user', assistantTurnKey: 'absent' }).answer, '');
});
