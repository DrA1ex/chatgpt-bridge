import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { constants as fsConstants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

async function findChromium() {
  for (const candidate of [...new Set(chromiumCandidates)]) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

function chromiumArgs(url, userDataDir) {
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
    '--no-default-browser-check',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1000',
    `--user-data-dir=${userDataDir}`,
    '--dump-dom',
    url,
  ];
}

function appendBounded(chunks, chunk, state) {
  if (!chunk?.length || state.bytes >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  const value = Buffer.from(chunk).subarray(0, remaining);
  chunks.push(value);
  state.bytes += value.length;
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function runChromium(chromium, url, timeoutMs) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-chromium-fixture-'));
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let timedOut = false;
  let spawnError = null;
  try {
    const child = spawn(chromium, chromiumArgs(url, userDataDir), {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME || os.tmpdir() },
    });
    child.stdout.on('data', (chunk) => appendBounded(stdout, chunk, stdoutState));
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk, stderrState));
    child.once('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    const { code, signal } = await new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
    clearTimeout(timer);
    return {
      status: code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: spawnError,
      timedOut,
      outputTruncated: stdoutState.bytes >= MAX_OUTPUT_BYTES || stderrState.bytes >= MAX_OUTPUT_BYTES,
    };
  } finally {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function chromiumFailure(result) {
  if (result.timedOut) return 'headless launch timed out and the Chromium process group was terminated';
  if (result.error) return `headless launch failed: ${result.error.message}`;
  if (result.status !== 0) return `headless launch exited with status ${result.status}${result.signal ? ` signal ${result.signal}` : ''}: ${result.stderr || result.stdout}`;
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

function fixtureResult(stdout = '') {
  const element = String(stdout).match(/<pre\b([^>]*)\bid=["']fixture-result["']([^>]*)>([\s\S]*?)<\/pre>/i);
  if (!element) return null;
  const attributes = `${element[1]} ${element[2]}`;
  const attribute = (name) => attributes.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || '';
  return {
    status: attribute('data-result-status'),
    bytes: Number(attribute('data-result-bytes')) || 0,
    encodedLength: Number(attribute('data-result-base64-length')) || 0,
    encoded: decodeHtmlEntities(element[3]).trim(),
    error: decodeHtmlEntities(attribute('data-result-error')),
  };
}

test('browser fixture parses current nested CodeMirror code widgets losslessly', async (t) => {
  const chromium = await findChromium();
  if (!chromium) {
    t.skip('No supported Chromium binary was found');
    return;
  }

  const probe = await runChromium(chromium, 'data:text/html,<html><body>fixture-probe</body></html>', 6_000);
  const unavailableReason = chromiumFailure(probe);
  if (unavailableReason) {
    t.skip(`Chromium exists at ${chromium}, but this environment cannot run it headlessly: ${unavailableReason}`);
    return;
  }

  const fixturePath = path.resolve('test/fixtures/chat-dom/current-code-widgets.html');
  const result = await runChromium(chromium, pathToFileURL(fixturePath).href, 30_000);
  assert.equal(result.timedOut, false, 'Chromium fixture timed out; its process group was terminated');
  assert.equal(result.error, null, `Chromium fixture failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `Chromium failed: ${result.stderr || result.stdout}`);
  assert.equal(result.outputTruncated, false, 'Chromium fixture output exceeded the bounded capture size');
  const complete = fixtureResult(result.stdout);
  assert.ok(complete, `Fixture result element was not found in Chromium DOM:\n${result.stdout.slice(-3000)}`);
  assert.equal(complete.status, 'complete', `Chromium fixture did not complete${complete.error ? `: ${complete.error}` : ''}:\n${result.stdout.slice(-3000)}`);
  assert.ok(complete.encoded, 'Chromium fixture completed without a base64 result payload');
  assert.equal(complete.encoded.length, complete.encodedLength, 'Chromium fixture base64 payload was truncated');
  const decoded = Buffer.from(complete.encoded, 'base64');
  assert.equal(decoded.length, complete.bytes, 'Chromium fixture decoded payload was truncated');
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    assert.fail(`Chromium returned an invalid complete fixture result: ${error.message}; encoded bytes=${complete.encoded.length}; decoded bytes=${decoded.length}`);
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
