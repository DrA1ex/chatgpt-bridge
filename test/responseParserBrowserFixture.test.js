import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const chromiumCandidates = [process.env.CHROMIUM_BIN].filter(Boolean);

async function findChromium() {
  for (const candidate of chromiumCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

test('browser fixture parses current nested CodeMirror code widgets losslessly', async (t) => {
  const chromium = await findChromium();
  if (!chromium) {
    t.skip('Set CHROMIUM_BIN to run the real-browser parser fixture');
    return;
  }
  const fixturePath = path.resolve('test/fixtures/chat-dom/current-code-widgets.html');
  const result = spawnSync(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1000',
    '--dump-dom',
    `file://${fixturePath}`,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, `Chromium failed: ${result.stderr || result.stdout}`);
  const match = result.stdout.match(/<pre id="fixture-result"[^>]*>([\s\S]*?)<\/pre>/i);
  assert.ok(match, `Fixture result was not found in Chromium DOM:\n${result.stdout.slice(-3000)}`);
  const parsed = JSON.parse(decodeHtmlEntities(match[1]));
  assert.equal(parsed.length, 2);

  assert.equal(parsed[0].language, 'javascript');
  assert.equal(parsed[0].confidence, 'high');
  assert.equal(parsed[0].contentSourceKind, 'codemirror-code');
  assert.equal(parsed[0].code, 'const marker = "fixture";\nconsole.log(marker);');
  assert.deepEqual(parsed[0].unknownChildren, []);
  assert.ok(parsed[0].interfaceElements.some((item) => item.ariaLabel === 'Копировать'));

  assert.equal(parsed[1].language, 'python');
  assert.equal(parsed[1].confidence, 'high');
  assert.equal(parsed[1].contentSourceKind, 'codemirror-code');
  assert.equal(parsed[1].code, 'marker = "fixture"\nprint(marker)');
  assert.deepEqual(parsed[1].unknownChildren, []);
  assert.ok(parsed[1].interfaceElements.some((item) => item.ariaLabel === 'Запустить код'));
  assert.ok(!parsed[1].warnings.includes('code_language_unresolved'));
});
