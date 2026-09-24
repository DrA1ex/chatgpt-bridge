#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_LINES = 800;
const HARD_LIMIT_LINES = 1200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.bridge-data']);
const PRODUCTION_ROOTS = ['src/', 'scripts/', 'tools/'];
const GENERATED_MARKER = /(?:@generated\b|auto[- ]generated\b|generated file\b|do not edit\b)/i;

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

function isGenerated(rel, source) {
  const parts = rel.split('/');
  const name = parts.at(-1) || '';
  if (parts.includes('generated')) return true;
  if (name.endsWith('.generated.js') || name.endsWith('.gen.js')) return true;
  return GENERATED_MARKER.test(source.split(/\r?\n/, 8).join('\n'));
}

function githubWarning(file, message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning file=${file}::${message}`);
  else console.warn(`warning: ${message}: ${file}`);
}

function githubError(file, message) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error file=${file}::${message}`);
  else console.error(`error: ${message}: ${file}`);
}

let failed = false;
let warnings = 0;
let checked = 0;
let generatedSkipped = 0;
const files = (await walk(ROOT)).sort();

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (!PRODUCTION_ROOTS.some((prefix) => rel.startsWith(prefix))) continue;

  const source = await fs.readFile(file, 'utf8');
  if (isGenerated(rel, source)) {
    generatedSkipped += 1;
    continue;
  }

  checked += 1;
  const lines = source === '' ? 0 : source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);

  if (lines > HARD_LIMIT_LINES) {
    failed = true;
    githubError(rel, `handwritten production source has ${lines} lines; hard limit is ${HARD_LIMIT_LINES}`);
  } else if (lines > TARGET_LINES) {
    warnings += 1;
    githubWarning(rel, `handwritten production source has ${lines} lines; target is ${TARGET_LINES}, hard limit is ${HARD_LIMIT_LINES}`);
  }
}

console.log(
  `code quality line check: checked=${checked}, generated skipped=${generatedSkipped}, `
  + `target=${TARGET_LINES}, hard limit=${HARD_LIMIT_LINES}, warnings=${warnings}`,
);
if (failed) process.exit(1);
