import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const chromiumCandidates = [
  process.env.CHROMIUM_BIN,
  process.platform === 'linux' ? '/usr/bin/chromium' : '',
  process.platform === 'linux' ? '/usr/bin/chromium-browser' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
  process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : '',
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
  process.platform === 'darwin' ? '/Applications/Chromium.app/Contents/MacOS/Chromium' : '',
  process.platform === 'win32' ? path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' ? path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
].filter(Boolean);

async function findChromium() {
  for (const candidate of [...new Set(chromiumCandidates)]) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

function chromiumArgs(url) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1000',
    '--dump-dom',
    url,
  ];
}

function runChromium(chromium, url, timeout) {
  return spawnSync(chromium, chromiumArgs(url), {
    encoding: 'utf8',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function chromiumFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return `headless launch timed out: ${result.error.message}`;
  if (result.error) return `headless launch failed: ${result.error.message}`;
  if (result.status !== 0) return `headless launch exited with status ${result.status}: ${result.stderr || result.stdout}`;
  if (!String(result.stdout || '').includes('fixture-probe')) return 'headless launch returned no probe DOM';
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
    t.skip('No supported Chromium binary was found');
    return;
  }

  const probe = runChromium(chromium, 'data:text/html,<html><body>fixture-probe</body></html>', 6_000);
  const unavailableReason = chromiumFailure(probe);
  if (unavailableReason) {
    t.skip(`Chromium exists at ${chromium}, but this environment cannot run it headlessly: ${unavailableReason}`);
    return;
  }

  const fixturePath = path.resolve('test/fixtures/chat-dom/current-code-widgets.html');
  const result = runChromium(chromium, `file://${fixturePath}`, 30_000);
  assert.equal(result.error, undefined, `Chromium fixture failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `Chromium failed: ${result.stderr || result.stdout}`);
  const resultElement = result.stdout.match(/<pre id="fixture-result"[^>]*data-result-status="complete"[^>]*data-result-bytes="(\d+)"[^>]*data-result-base64-length="(\d+)"[^>]*>([A-Za-z0-9+/=]+)<\/pre>/i);
  assert.ok(resultElement, `Complete fixture result was not found in Chromium DOM:\n${result.stdout.slice(-3000)}`);
  const expectedBytes = Number(resultElement[1]);
  const expectedEncodedLength = Number(resultElement[2]);
  const encoded = decodeHtmlEntities(resultElement[3]).trim();
  assert.equal(encoded.length, expectedEncodedLength, 'Chromium fixture base64 payload was truncated');
  const decoded = Buffer.from(encoded, 'base64');
  assert.equal(decoded.length, expectedBytes, 'Chromium fixture decoded payload was truncated');
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    assert.fail(`Chromium returned an invalid complete fixture result: ${error.message}; encoded bytes=${encoded.length}; decoded bytes=${decoded.length}`);
  }
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
