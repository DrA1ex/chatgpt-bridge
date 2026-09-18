import test from 'node:test';
import assert from 'node:assert/strict';
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
