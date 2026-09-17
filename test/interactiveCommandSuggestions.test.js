import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, buildHelpText, commandSuggestions, normalizeCommand } from '../src/interactive/commands.js';

test('server-backed workflow suggestions match the commands the runtime actually executes', () => {
  const context = { zipflowWorkflowRuntime: {}, state: {} };
  const values = commandSuggestions('/workflow ', context).map((item) => item.value);
  assert.deepEqual(values, [
    'history', 'plan', 'diff', 'report', 'checks', 'fix', 'preset',
  ]);
  assert.deepEqual(
    commandSuggestions('/workflow preset ', context).map((item) => item.value),
    ['apply-changes', 'fix-until-pass', 'guided-task'],
  );
});

test('server-backed apply suggestions expose review modes but not unsupported --force', () => {
  const serverValues = commandSuggestions('/apply ', { zipflowWorkflowRuntime: {}, state: {} })
    .map((item) => item.value);
  assert.deepEqual(serverValues, ['--plan', '--interactive']);

  const legacyValues = commandSuggestions('/apply ', { state: {} }).map((item) => item.value);
  assert.ok(legacyValues.includes('--force'));
});

test('interactive commands expose one compact canonical surface', () => {
  assert.deepEqual(COMMANDS.map((item) => item.cmd), [
    '/help', '/chat', '/status', '/connect', '/tab', '/session', '/model', '/effort', '/events', '/theme',
    '/workflow', '/project', '/task', '/resume', '/recover', '/apply', '/file', '/artifact', '/debug', '/stop',
    '/reset', '/clear', '/quit',
  ]);

  assert.equal(normalizeCommand('/tabs'), '/tab list');
  assert.equal(normalizeCommand('/sessions'), '/session list');
  assert.equal(normalizeCommand('/themes'), '/theme list');
  assert.equal(normalizeCommand('/scan'), '/project scan');
  assert.equal(normalizeCommand('/pack'), '/project pack');
  assert.equal(normalizeCommand('/skills enable tests'), '/project skills enable tests');
  assert.equal(normalizeCommand('/files'), '/file stored');
  assert.equal(normalizeCommand('/files remove file-1'), '/file delete file-1');
  assert.equal(normalizeCommand('/artifacts'), '/artifact list');
  assert.equal(normalizeCommand('/download 1 out.zip'), '/artifact download 1 out.zip');
  assert.equal(normalizeCommand('/open 1'), '/artifact open 1');
  assert.equal(normalizeCommand('/tab'), '/tab current');
  assert.equal(normalizeCommand('/file'), '/file list');
  assert.equal(normalizeCommand('/file ./notes.txt'), '/file add ./notes.txt');
  assert.equal(normalizeCommand('/state'), '/state');
  assert.equal(normalizeCommand('/info'), '/info');

  for (const removed of [
    '/tabs', '/sessions', '/themes', '/state', '/info', '/files', '/artifacts', '/download', '/open',
    '/result', '/responses', '/skills', '/agent', '/watch', '/watch-status', '/unwatch',
  ]) {
    assert.equal(commandSuggestions(removed).length, 0, `${removed} must not be advertised`);
  }
});



test('theme suggestions keep the persisted theme selected first for preview navigation', () => {
  const suggestions = commandSuggestions('/theme ', { state: { themeName: 'slate' } });
  assert.equal(suggestions[0]?.value, 'slate');
  assert.equal(suggestions[0]?.previewTheme, 'slate');
  assert.notEqual(suggestions[1]?.value, 'slate');
  assert.ok(suggestions.some((item) => item.value === 'list'));
});

test('interactive help renders each category heading once', () => {
  const help = buildHelpText();
  for (const category of new Set(COMMANDS.map((item) => item.category))) {
    const heading = `${category}:`;
    assert.equal(help.split('\n').filter((line) => line === heading).length, 1, heading);
  }
});
