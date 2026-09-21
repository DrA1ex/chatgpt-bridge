import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const assistant = (id, content) => `<section data-testid="conversation-turn-${id}" data-turn="assistant" data-turn-id="${id}"><div data-message-author-role="assistant" data-message-id="message-${id}">${content}</div></section>`;
const user = (id) => `<section data-testid="conversation-turn-${id}" data-turn="user" data-turn-id="${id}"><div data-message-author-role="user">Prompt ${id}</div></section>`;

test('the complete message owns markdown, sibling code and trailing text exactly once', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(new URL('./fixtures/chat-dom/mixed-answer-containers.html', import.meta.url), 'utf8');
  const parsed = parser.parse(html);
  assert.equal(parsed.answer, 'Before the wrapper.\n\nMain **answer**.\n\n```javascript\nconsole.log("complete");\n```\n\nAfter the wrapper.');
  assert.equal(parsed.codeBlocks.length, 1);
  assert.equal(parsed.codeBlocks[0].code, 'console.log("complete");');
  assert.equal(parsed.responseBlocks.length, 4);
  assert.equal(parsed.parserAudit.coverage.duplicateLeaves, 0);
});

test('request parsing cannot cross the next user turn to borrow its final answer', async () => {
  const parser = await createAssistantFixtureParser();
  const html = `<main>${user('user-1')}${assistant('a-1', '<div class="markdown"><p>First answer</p></div>')}${user('user-2')}${assistant('a-2', '<div class="markdown"><p>Unrelated answer</p></div>')}</main>`;
  const parsed = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'user-1' });
  assert.equal(parsed.turnKey, 'a-1');
  assert.equal(parsed.answer, 'First answer');
});

test('an unanswered request remains empty even when a later user turn has an answer', async () => {
  const parser = await createAssistantFixtureParser();
  const html = `<main>${user('user-1')}${user('user-2')}${assistant('a-2', '<div class="markdown"><p>Unrelated answer</p></div>')}</main>`;
  const parsed = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'user-1' });
  assert.equal(parsed.answer, '');
  assert.equal(parsed.reason, 'no_assistant_turn_after_submitted_user');
});
