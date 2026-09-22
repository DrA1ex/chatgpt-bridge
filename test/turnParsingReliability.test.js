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

test('one ownership model includes unwrapped messages beside canonical turns', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>${user('u-1')}${assistant('a-1', '<p>History</p>')}
    <div data-message-author-role="user" data-message-id="u-2">Next</div>
    <div data-message-author-role="assistant" data-message-id="a-2"><p>Current</p></div>
  </main>`);
  const turns = parser.snapshots.getTurnNodes();
  assert.deepEqual(Array.from(turns, parser.snapshots.turnKey), ['u-1', 'a-1', 'u-2', 'a-2']);
  assert.equal(parser.snapshots.readAssistantSnapshot({ submittedUserTurnKey: 'u-2' }).answer, 'Current');
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().turnKey, 'a-2');
  assert.deepEqual(Array.from(parser.snapshots.readRecentAssistantSnapshots(), (s) => s.turnKey), ['a-2', 'a-1']);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot(3).answer, '');
});

test('canonical identity survives CSS changes, reindexing and React replacement', async () => {
  const parser = await createAssistantFixtureParser();
  const response = `<article data-turn="assistant" data-turn-id="durable-answer" data-testid="conversation-turn-9">
    <h4 class="sr-only">ChatGPT</h4>
    <div data-message-author-role="assistant" data-message-id="message-answer"><div class="MarkdownRoot-abc"><p>Current</p></div></div>
  </article>`;
  parser.mount(`<main>${user('history')}${response}</main>`);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().turnKey, 'durable-answer');
  parser.mount(`<main>${response.replace('conversation-turn-9', 'conversation-turn-0').replace('MarkdownRoot-abc', 'renamed')}</main>`);
  assert.equal(parser.snapshots.readAssistantSnapshotByTurnKey('durable-answer').answer, 'Current');
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().turnKey, 'durable-answer');
});

test('anonymous turns cannot borrow an ordinal or text-derived request identity', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main><div class="bg-user-message">Prompt</div>
    <div><h4 class="sr-only">ChatGPT</h4><div class="MarkdownRoot-abc"><p>Answer</p></div></div>
    <section data-turn="assistant" data-testid="conversation-turn-7"><div data-message-author-role="assistant"><p class="markdown">Anonymous</p></div></section>
  </main>`);
  assert.deepEqual(Array.from(parser.snapshots.getTurnNodes(), parser.snapshots.turnKey), ['', '', '']);
  assert.equal(parser.snapshots.readAssistantSnapshotByTurnKey('modern-assistant-0'), null);
  assert.equal(parser.snapshots.readAssistantSnapshotByTurnKey('turn-index-2'), null);
});

test('recovery excludes sidebar, composer, extension panel and unowned artifact markdown', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>
    <nav>${assistant('sidebar', '<p>Sidebar</p>')}</nav>
    <form>${assistant('composer', '<p>Composer</p>')}</form>
    <aside>${assistant('aside', '<p>Aside</p>')}</aside>
    <div id="cgb-panel">${assistant('panel', '<p>Panel</p>')}</div>
    <div id="chatgpt-bridge-panel-root">${assistant('actual-panel', '<p>Panel</p>')}</div>
    <div id="history">${assistant('history-sidebar', '<p>History</p>')}</div>
    ${assistant('owned', '<p>Actual answer</p>')}
    <div class="markdown"><a href="sandbox:/mnt/data/unowned.zip" download="unowned.zip">Download unowned.zip</a></div>
  </main>`);
  assert.deepEqual(Array.from(parser.snapshots.getTurnNodes(), parser.snapshots.turnKey), ['owned']);
  assert.deepEqual(Array.from(parser.snapshots.readRecentAssistantSnapshots(), (s) => s.turnKey), ['owned']);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().answer, 'Actual answer');
});

test('historical turn errors and confirmations do not contaminate the current response', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>${assistant('old', '<div role="alert">Something went wrong</div><div data-testid="approval"><button>Confirm</button></div>')}
    ${user('current-user')}${assistant('current', '<p>Success</p>')}
  </main>`);
  const current = parser.snapshots.readAssistantSnapshot({ submittedUserTurnKey: 'current-user' });
  assert.equal(current.hasError, false);
  assert.equal(current.needsConfirmation, false);
  const old = parser.snapshots.readAssistantSnapshotByTurnKey('old');
  assert.equal(old.hasError, true);
  assert.equal(old.needsConfirmation, true);
});

test('anonymous snapshots do not share a reasoning registry', async () => {
  const parser = await createAssistantFixtureParser();
  const first = parser.parse('<section data-turn="assistant"><button data-testid="cot-v5-summary">Inspecting the first document</button></section>');
  assert.ok(first.progressItems.some((item) => item.text.includes('first document')));
  const second = parser.parse('<section data-turn="assistant"><button data-testid="cot-v5-summary">Reviewing the second document</button></section>');
  assert.ok(second.progressItems.some((item) => item.text.includes('second document')));
  assert.ok(!second.progressItems.some((item) => item.text.includes('first document')));
});

test('page-level errors remain visible outside individual turn ownership', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>${assistant('current', '<p>Answer</p>')}<div role="alert">Rate limit reached</div></main>`);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().hasError, true);
});

test('hidden historical message copies cannot become the latest visible response', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>${user('current-user')}${assistant('current', '<p>Current answer</p>')}
    <div hidden><div data-message-author-role="assistant" data-message-id="old-copy"><p>Old answer</p></div></div>
  </main>`);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().turnKey, 'current');
  assert.equal(parser.snapshots.readAssistantSnapshot({ submittedUserTurnKey: 'current-user' }).turnKey, 'current');
  assert.deepEqual(Array.from(parser.snapshots.readRecentAssistantSnapshots(), (s) => s.turnKey), ['current']);
});

test('recovery snapshots retain the preceding user key from the same ordered DOM sample', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main>${user('old-user')}${assistant('old', '<p>Old answer</p>')}${user('current-user')}${assistant('current', '<p>Current answer</p>')}</main>`);
  assert.deepEqual(Array.from(parser.snapshots.readRecentAssistantSnapshots(), (s) => [s.turnKey, s.userTurnKey]), [
    ['current', 'current-user'], ['old', 'old-user'],
  ]);
});


test('equal text in distinct anonymous turns remains two ordered recovery candidates', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount('<main><article data-turn="assistant"><div class="MarkdownRoot-test"><p>Same response</p></div></article><article data-turn="assistant"><div class="MarkdownRoot-test"><p>Same response</p></div></article></main>');
  const snapshots = parser.snapshots.readRecentAssistantSnapshots();
  assert.equal(snapshots.length, 2);
  assert.deepEqual(Array.from(snapshots, (snapshot) => snapshot.candidateIndex), [1, 2]);
});
