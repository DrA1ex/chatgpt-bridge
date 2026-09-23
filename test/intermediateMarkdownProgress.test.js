import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';
import { reconcileVisibleProgressSnapshot } from '../src/interactive/progress.js';

const fixtureUrl = new URL(
  './fixtures/chat-dom/captured/intermediate-markdown-progress/01-streaming.html',
  import.meta.url,
);

test('streaming markdown updates remain separate progress items and reach interactive transcript', async () => {
  const html = await fs.readFile(path.resolve(fixtureUrl.pathname), 'utf8');
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(html);
  const markdownItems = Array.from(snapshot.progressItems || [])
    .filter((item) => item.kind === 'action_status');

  assert.equal(markdownItems.length, 2);
  assert.match(markdownItems[0].text, /^Я сначала разберу сам snapshot/);
  assert.match(markdownItems[1].text, /^Нашёл точное место/);
  assert.ok(markdownItems.every((item) => item.state === 'completed'));

  const reconciled = reconcileVisibleProgressSnapshot({ items: snapshot.progressItems });
  assert.equal(reconciled.completedLines.some((line) => line.includes('Я сначала разберу сам snapshot')), true);
  assert.equal(reconciled.completedLines.some((line) => line.includes('Нашёл точное место')), true);
});
