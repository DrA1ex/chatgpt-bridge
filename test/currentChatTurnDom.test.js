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
