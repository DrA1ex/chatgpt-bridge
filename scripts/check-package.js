#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const lockText = fs.readFileSync(path.resolve('package-lock.json'), 'utf8');
assert.doesNotMatch(lockText, /(?:internal\.api\.openai\.org|artifactory\/api\/npm|localhost[^"']*npm)/i, 'package-lock.json contains a private package registry URL');
for (const match of lockText.matchAll(/"resolved"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
  const hostname = new URL(match[1]).hostname.toLowerCase();
  assert.equal(
    ['registry.npmjs.org', 'github.com', 'codeload.github.com', 'raw.githubusercontent.com'].includes(hostname),
    true,
    `package-lock.json contains a non-public package source: ${hostname}`,
  );
}

const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'pack',
  '--dry-run',
  '--json',
  '--ignore-scripts',
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const report = JSON.parse(output);
assert.equal(Array.isArray(report), true, 'npm pack must return a JSON array');
assert.equal(report.length, 1, 'npm pack must describe exactly one package');
const files = report[0].files.map((entry) => String(entry.path || '').replaceAll('\\', '/'));
const fileSet = new Set(files);

for (const required of [
  'bin/bridge.js',
  'src/index.js',
  'tools/chrome-bridge-extension/manifest.json',
  'scripts/extension-install.js',
  'scripts/workflow-init.js',
  'scripts/workflow-worker.js',
  'bridge.workflow.example.json',
]) {
  assert.equal(fileSet.has(required), true, `npm package is missing required runtime file: ${required}`);
}

const forbiddenPrefixes = [
  'test/',
  'docs/',
  'examples/',
  '__MACOSX/',
  '.bridge/',
  '.git/',
  'coverage/',
];
for (const file of files) {
  assert.equal(file.includes('/._') || path.basename(file).startsWith('._'), false, `npm package contains AppleDouble metadata: ${file}`);
  assert.equal(file === '.DS_Store' || file.endsWith('/.DS_Store'), false, `npm package contains Finder metadata: ${file}`);
  assert.equal(forbiddenPrefixes.some((prefix) => file.startsWith(prefix)), false, `npm package contains development-only path: ${file}`);
}

console.log(`Package contents OK: ${files.length} files, ${report[0].unpackedSize} bytes unpacked`);
