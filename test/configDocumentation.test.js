import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('every registered environment setting is documented in README', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-config-docs-'));
  process.env.ENV_FILE = path.join(dir, '.env');
  process.env.DATA_DIR = dir;
  const { CONFIG_ENV_SCHEMA } = await import(`../src/config.js?config-docs=${Date.now()}`);
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');

  const keys = Object.keys(CONFIG_ENV_SCHEMA).sort();
  assert.ok(keys.length > 30, 'config schema should register the complete runtime environment surface');
  for (const key of keys) {
    assert.equal(readme.includes(`\`${key}\``), true, `README is missing ${key}`);
  }
  assert.equal(readme.includes('`WORKFLOW_CONFIG`'), true, 'README is missing WORKFLOW_CONFIG');
});
