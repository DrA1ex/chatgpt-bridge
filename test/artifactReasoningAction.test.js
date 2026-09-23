import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

test('reasoning controls are not artifacts when surrounding prose mentions files', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parse(`
    <section data-testid="conversation-turn-11" data-turn-id="turn-11">
      <div data-message-author-role="assistant" data-message-id="assistant-11">
        <div data-testid="cot-v5-pinned-row">
          <div>Add result.txt and verify the final root-level ZIP.</div>
          <button>Ответить сейчас</button>
        </div>
      </div>
    </section>
  `);
  assert.deepEqual(Array.from(result.artifacts), []);
});

test('reasoning subtree still exposes a control with intrinsic file identity', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parse(`
    <section data-testid="conversation-turn-12" data-turn-id="turn-12">
      <div data-message-author-role="assistant" data-message-id="assistant-12">
        <div data-testid="cot-v5-file-output">
          <button aria-label="Download report.csv">Download report.csv</button>
        </div>
      </div>
    </section>
  `);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'report.csv');
  assert.equal(result.artifacts[0].downloadable, true);
});

test('streaming empty-href download anchor is not published before the real artifact button', async () => {
  const parser = await createAssistantFixtureParser();
  const streaming = parser.parse(`
    <section data-testid="conversation-turn-13" data-turn-id="turn-13">
      <div data-message-author-role="assistant" data-message-id="assistant-13">
        <div class="markdown prose"><p data-start="0" data-end="45"><a href="">Download the complete updated project ZIP</a></p></div>
      </div>
    </section>
  `);
  assert.deepEqual(Array.from(streaming.artifacts), []);

  const final = parser.parse(`
    <section data-testid="conversation-turn-13" data-turn-id="turn-13">
      <div data-message-author-role="assistant" data-message-id="assistant-13">
        <div class="markdown prose"><p data-start="0" data-end="108"><span><button class="behavior-btn entity-underline">Download the complete updated project ZIP</button></span></p></div>
      </div>
    </section>
  `);
  assert.equal(final.artifacts.length, 1);
  assert.equal(final.artifacts[0].actionTag, 'button');
  assert.equal(final.artifacts[0].name, 'Download the complete updated project ZIP');
});

test('nested live shimmer stays separate from its accumulated tertiary history wrapper', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parse(`
    <section data-turn="assistant" data-turn-id="reasoning-wrapper-turn">
      <div class="text-token-text-tertiary">
        <p>0%</p>
        <button><span data-testid="cot-v5-native-tool-icon"></span>Checked inputs</button>
        <p>10%</p>
        <div class="loading-shimmer-tertiary text-token-text-tertiary">Computing totals</div>
      </div>
    </section>
  `);
  const visible = Array.from(result.progressItems).filter((item) => item.visible && item.active);
  assert.equal(visible.some((item) => item.text.includes('0%') && item.text.includes('Computing totals')), false);
  assert.equal(visible.some((item) => item.text === 'Computing totals'), true);
});
