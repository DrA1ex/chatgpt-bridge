#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deployBundledExtension, treeFingerprint } from '../src/extensionDeployment.js';

const source = path.resolve('tools/chrome-bridge-extension');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-bridge-extension-release-'));
const target = path.join(root, 'extension');

try {
  const sourceManifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const installed = await deployBundledExtension(source, target);
  assert.equal(installed.deployed, true);
  assert.equal(installed.reason, 'installed');
  assert.equal(await treeFingerprint(target), await treeFingerprint(source));

  const deployedManifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(deployedManifest.version, sourceManifest.version);
  assert.equal(deployedManifest.manifest_version, sourceManifest.manifest_version);

  await fs.writeFile(path.join(target, 'stale-release-file.txt'), 'remove me');
  const repaired = await deployBundledExtension(source, target);
  assert.equal(repaired.deployed, true);
  assert.equal(repaired.reason, 'changed');
  await assert.rejects(fs.access(path.join(target, 'stale-release-file.txt')));
  assert.equal(await treeFingerprint(target), await treeFingerprint(source));

  const unchanged = await deployBundledExtension(source, target);
  assert.equal(unchanged.deployed, false);
  assert.equal(unchanged.reason, 'unchanged');

  console.log(`Extension ${sourceManifest.version} deployment verified: install, stale-file cleanup, fingerprint, and unchanged update.`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
