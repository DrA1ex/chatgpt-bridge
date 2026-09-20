import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkflowCommand } from '../src/workflow/commandRunner.js';

function quoteExecutable(value) {
  if (process.platform === 'win32') return `"${String(value).replaceAll('"', '\\"')}"`;
  return `'${String(value).replaceAll("'", "'\\\\''")}'`;
}

test('workflow command runner executes a native cross-platform shell command', async () => {
  const code = "process.stdout.write('bridge-command-ok')";
  const result = await runWorkflowCommand(`${quoteExecutable(process.execPath)} -e ${JSON.stringify(code)}`, {
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'bridge-command-ok');
  assert.equal(result.error, '');
});

test('workflow command runner reports a bounded timeout', async () => {
  const code = 'setTimeout(() => {}, 60_000)';
  const result = await runWorkflowCommand(`${quoteExecutable(process.execPath)} -e ${JSON.stringify(code)}`, {
    cwd: process.cwd(),
    timeoutMs: 150,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('workflow timeout kills descendants that ignore SIGTERM after the shell exits', {
  skip: process.platform === 'win32', timeout: 12_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-command-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'stubborn.cjs');
  await fs.writeFile(script, "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => process.exit(0), 9000);");
  const started = Date.now();
  const result = await runWorkflowCommand(`${quoteExecutable(process.execPath)} ${quoteExecutable(script)} & wait`, {
    cwd: root, timeoutMs: 500,
  });
  assert.match(result.stdout, /ready/);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 6_000, 'timeout must kill the whole process group');
});
