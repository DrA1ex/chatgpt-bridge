#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkFileFreeIdentifiers } from './source-scope-check.js';

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
  let freeIdentifiers;
  try {
    // The scope checker parses every file with Node's bundled Acorn parser, so
    // a separate `node --check` subprocess per file would duplicate syntax
    // validation and make the release gate scale with process startup time.
    freeIdentifiers = await checkFileFreeIdentifiers(file);
  } catch (error) {
    failed = true;
    console.error(`syntax parse failed: ${rel}`);
    console.error(error?.stack || error?.message || String(error));
    continue;
  }
  if (freeIdentifiers.length) {
    failed = true;
    const grouped = new Map();
    for (const item of freeIdentifiers) {
      const positions = grouped.get(item.name) || [];
      positions.push(`${item.line}:${item.column}`);
      grouped.set(item.name, positions);
    }
    console.error(`unresolved identifiers: ${rel}`);
    for (const [name, positions] of grouped) console.error(`  ${name}: ${positions.join(', ')}`);
  }
}
if (failed) process.exit(1);
console.log(`syntax and unresolved-identifier checks passed for ${files.length} JS files`);
console.log(`production line ceiling passed (${MAX_LINES}); ${aboveTarget.length} files remain above the ${TARGET_LINES}-line target`);
