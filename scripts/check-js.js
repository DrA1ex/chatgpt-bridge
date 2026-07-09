#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.bridge-data']);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.bridge') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

const files = (await walk(ROOT)).sort();
let failed = false;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`node --check failed: ${rel}`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}
if (failed) process.exit(1);
console.log(`node --check passed for ${files.length} JS files`);
