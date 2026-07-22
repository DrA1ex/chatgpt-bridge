import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const fixtureUrl = new URL('./fixtures/chat-dom/current-code-widgets.html', import.meta.url);

function position(source, marker) {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `Fixture is missing ${marker}`);
  return index;
}

test('browser parser fixture loads the complete production parser stack in dependency order', async () => {
  const source = await fs.readFile(fixtureUrl, 'utf8');
  const artifact = position(source, '../../../tools/chrome-bridge-extension/artifactParserCore.js');
  const dom = position(source, '../../../tools/chrome-bridge-extension/domParserCore.js');
  const response = position(source, '../../../tools/chrome-bridge-extension/responseParserCore.js');
  assert.ok(artifact < dom, 'artifactParserCore must load before domParserCore');
  assert.ok(dom < response, 'domParserCore must load before responseParserCore');
});

test('browser parser fixture publishes explicit complete or error status instead of hanging silently', async () => {
  const source = await fs.readFile(fixtureUrl, 'utf8');
  assert.match(source, /try\s*\{/);
  assert.match(source, /catch\s*\(error\)/);
  assert.match(source, /dataset\.resultStatus\s*=\s*['"]complete['"]/);
  assert.match(source, /dataset\.resultStatus\s*=\s*['"]error['"]/);
  assert.match(source, /dataset\.resultError\s*=/);
});
