#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_LINES = 500;
const HARD_LIMIT_LINES = Math.ceil(TARGET_LINES * 1.3);
const GENERAL_HARD_LIMIT_LINES = 1000;

const COMPOSITION_ROOTS = new Set([
  'src/browserExtensionHub.js',
  'src/browserBridge.js',
  'src/bridge/coordinator/requestLifecycleCoordinator.js',
  'src/bridge/coordinator/browserClientCoordinator.js',
  'src/workflow/workflowManager.js',
  'src/workflow/automation/controller.js',
  'tools/chrome-bridge-extension/background.js',
  'tools/chrome-bridge-extension/content.js',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.bridge-data']);
const PRODUCTION_ROOTS = ['src/', 'scripts/', 'tools/'];

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
const files = (await walk(ROOT)).sort();

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (!PRODUCTION_ROOTS.some((prefix) => rel.startsWith(prefix))) continue;

  const source = await fs.readFile(file, 'utf8');
  const lines = source === '' ? 0 : source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);

  if (COMPOSITION_ROOTS.has(rel)) {
    if (lines > HARD_LIMIT_LINES) {
      failed = true;
      githubError(rel, `composition root has ${lines} lines; hard limit is ${HARD_LIMIT_LINES} (+30% over the ${TARGET_LINES}-line target)`);
    } else if (lines > TARGET_LINES) {
      warnings += 1;
      githubWarning(rel, `composition root has ${lines} lines; target is ${TARGET_LINES}, hard limit is ${HARD_LIMIT_LINES}`);
    }
    continue;
  }

  if (lines > GENERAL_HARD_LIMIT_LINES) {
    failed = true;
    githubError(rel, `production source has ${lines} lines; hard limit is ${GENERAL_HARD_LIMIT_LINES}`);
  }
}

console.log(`code quality line check: target=${TARGET_LINES}, composition hard limit=${HARD_LIMIT_LINES}, warnings=${warnings}`);
if (failed) process.exit(1);
