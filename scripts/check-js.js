#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.bridge-data']);
const PRODUCTION_ROOTS = ['src/', 'scripts/', 'tools/'];
const TARGET_LINES = 500;
const MAX_LINES = 1000;

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
const aboveTarget = [];
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const source = await fs.readFile(file, 'utf8');
  const lineCount = source === '' ? 0 : source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
  const production = PRODUCTION_ROOTS.some((prefix) => rel.split(path.sep).join('/').startsWith(prefix));
  if (production && lineCount > MAX_LINES) {
    failed = true;
    console.error(`production source exceeds ${MAX_LINES} lines: ${rel} (${lineCount})`);
  } else if (production && lineCount > TARGET_LINES) {
    aboveTarget.push({ rel, lineCount });
  }
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
console.log(`production line ceiling passed (${MAX_LINES}); ${aboveTarget.length} files remain above the ${TARGET_LINES}-line target`);
