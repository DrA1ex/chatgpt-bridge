import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractLastUserMessageFromPayload,
  normalizeContent,
  makeOpenAIChatCompletionChunk,
  makeOpenAIChatCompletionResponse,
} from '../src/openaiPayload.js';

test('normalizeContent handles strings', () => {
  assert.equal(normalizeContent('  hello  '), 'hello');
});

test('normalizeContent handles OpenAI multimodal text arrays', () => {
  assert.equal(
    normalizeContent([
      { type: 'text', text: ' first ' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { content: ' second ' },
      ' third ',
    ]),
    'first\nsecond\nthird',
  );
});

test('extractLastUserMessageFromPayload returns the last user message', () => {
  assert.equal(
    extractLastUserMessageFromPayload({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    }),
    'second',
  );
});

test('extractLastUserMessageFromPayload falls back to input', () => {
  assert.equal(extractLastUserMessageFromPayload({ input: ' hello ' }), 'hello');
});

test('extractLastUserMessageFromPayload falls back to prompt', () => {
  assert.equal(extractLastUserMessageFromPayload({ prompt: ' hello ' }), 'hello');
});

test('makeOpenAIChatCompletionResponse returns compatible response shape', () => {
  const response = makeOpenAIChatCompletionResponse('answer');

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.role, 'assistant');
  assert.equal(response.choices[0].message.content, 'answer');
  assert.equal(response.choices[0].finish_reason, 'stop');
});


test('makeOpenAIChatCompletionChunk can stream answer and reasoning deltas', () => {
  const answerChunk = makeOpenAIChatCompletionChunk({ content: 'hel' });
  assert.equal(answerChunk.object, 'chat.completion.chunk');
  assert.equal(answerChunk.choices[0].delta.content, 'hel');

  const reasoningChunk = makeOpenAIChatCompletionChunk({ reasoningContent: 'thinking' });
  assert.equal(reasoningChunk.choices[0].delta.reasoning_content, 'thinking');

  const doneChunk = makeOpenAIChatCompletionChunk({ finishReason: 'stop' });
  assert.equal(doneChunk.choices[0].finish_reason, 'stop');
});
