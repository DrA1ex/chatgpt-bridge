#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { DEFAULT_EXTENSION_INSTALL_DIRECTORY, deployBundledExtension } from '../src/extensionDeployment.js';


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

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const configPath = argValue('--config');
let source = path.resolve(argValue('--source') || 'tools/chrome-bridge-extension');
let target = path.resolve(argValue('--target') || DEFAULT_EXTENSION_INSTALL_DIRECTORY);
if (configPath) {
  const workflow = await loadWorkflowConfig(configPath);
  source = workflow.extensionUpdate.sourceDir;
  target = workflow.extensionUpdate.targetDir || source;
}
const deployment = await deployBundledExtension(source, target);
const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
console.log(`Extension ${manifest.version} ${deployment.deployed ? 'deployed atomically' : 'already available'} at ${target}`);
console.log('Load this directory once with chrome://extensions → Load unpacked. Future workflow updates can reload it automatically.');
