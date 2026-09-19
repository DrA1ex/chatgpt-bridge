import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { secureTokenEqual } from '../src/security/token.js';

test('secureTokenEqual accepts only the exact non-empty token', () => {
  assert.equal(secureTokenEqual('secret-token', 'secret-token'), true);
  assert.equal(secureTokenEqual('secret-token', 'secret-token-2'), false);
  assert.equal(secureTokenEqual('', ''), false);
  assert.equal(secureTokenEqual('x', ''), false);
});

test('generated env file is restricted to the current user', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-env-mode-'));
  const envFile = path.join(dir, '.env');
  const previousEnvFile = process.env.ENV_FILE;
  const previousDataDir = process.env.DATA_DIR;
  process.env.ENV_FILE = envFile;
  process.env.DATA_DIR = dir;
  try {
    await import(`../src/config.js?env-mode=${Date.now()}`);
    const stat = await fs.stat(envFile);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    if (previousEnvFile === undefined) delete process.env.ENV_FILE; else process.env.ENV_FILE = previousEnvFile;
    if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
