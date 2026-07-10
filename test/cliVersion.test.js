import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import packageInfo from '../package.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

test('CLI --version stays synchronized with package.json', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['src/index.js', '--version'], { cwd: process.cwd() });
  assert.equal(stdout.trim(), packageInfo.version);
});
