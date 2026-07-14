#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkflowConfig } from '../src/workflow/config.js';


if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run extension:install -- [--config file] [--source dir] [--target dir]');
  console.log('Copies the unpacked extension into a stable directory.');
  process.exit(0);
}

const knownOptions = new Set(['--config', '--source', '--target']);
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith('-')) continue;
  if (!knownOptions.has(arg)) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('-')) {
    console.error(`Missing value for ${arg}`);
    process.exit(2);
  }
  index += 1;
}

async function copyTree(source, target) {
  const stat = await fs.stat(source);
  if (!stat.isDirectory()) throw new Error(`Extension source is not a directory: ${source}`);
  await fs.mkdir(target, { recursive: true });
  const names = new Set();
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    names.add(entry.name);
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
  for (const entry of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (!names.has(entry.name)) await fs.rm(path.join(target, entry.name), { recursive: true, force: true });
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const configPath = argValue('--config');
let source = path.resolve(argValue('--source') || 'tools/chrome-bridge-extension');
let target = path.resolve(argValue('--target') || path.join(os.homedir(), '.local/share/chatgpt-bridge/extension'));
if (configPath) {
  const workflow = await loadWorkflowConfig(configPath);
  source = workflow.extensionUpdate.sourceDir;
  target = workflow.extensionUpdate.targetDir || source;
}
if (path.resolve(source) !== path.resolve(target)) await copyTree(source, target);
const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
console.log(`Extension ${manifest.version} deployed to ${target}`);
console.log('Load this directory once with chrome://extensions → Load unpacked. Future workflow updates can reload it automatically.');
