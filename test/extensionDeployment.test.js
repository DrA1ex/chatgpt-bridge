import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployBundledExtension } from '../src/extensionDeployment.js';

async function fixtureRoot(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('extension deployment atomically replaces the stable target and removes stale files', async () => {
  const root = await fixtureRoot('bridge-extension-deploy-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'installed', 'extension');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ version: '9.9.1' }));
  await fs.writeFile(path.join(source, 'content.js'), "const CONTENT_SCRIPT_VERSION = '8.8.1';\n");
  await fs.writeFile(path.join(source, 'nested', 'current.js'), 'current');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'stale.js'), 'stale');

  const result = await deployBundledExtension(source, target);

  assert.equal(result.deployed, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')).version, '9.9.1');
  assert.equal(await fs.readFile(path.join(target, 'nested', 'current.js'), 'utf8'), 'current');
  await assert.rejects(fs.stat(path.join(target, 'stale.js')), (error) => error?.code === 'ENOENT');
  const parentNames = await fs.readdir(path.dirname(target));
  assert.equal(parentNames.some((name) => name.includes('.stage-') || name.includes('.previous-')), false);
});

test('extension deployment refuses symbolic links instead of publishing an incomplete bundle', async (t) => {
  if (process.platform === 'win32') return t.skip('symbolic-link fixture is not portable on Windows');
  const root = await fixtureRoot('bridge-extension-deploy-link-');
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.symlink(path.join(source, 'manifest.json'), path.join(source, 'manifest-link.json'));

  await assert.rejects(
    deployBundledExtension(source, target),
    /symbolic link/,
  );
  await assert.rejects(fs.stat(target), (error) => error?.code === 'ENOENT');
});
