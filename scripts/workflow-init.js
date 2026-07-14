#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { exampleWorkflowConfig } from '../src/workflow/config.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run workflow:init -- [path] [--force]');
  console.log('Creates a safe workflow configuration. Default: bridge.workflow.json');
  process.exit(0);
}
const unknownOption = args.find((arg) => arg.startsWith('-') && arg !== '--force');
if (unknownOption) {
  console.error(`Unknown option: ${unknownOption}`);
  process.exit(2);
}
const force = args.includes('--force');
const targetArg = args.find((arg) => !arg.startsWith('-')) || 'bridge.workflow.json';
const target = path.resolve(targetArg);
const exists = await fs.stat(target).catch(() => null);
if (exists && !force) {
  console.error(`Workflow config already exists: ${target}`);
  console.error('Use --force to overwrite it.');
  process.exit(1);
}
const value = exampleWorkflowConfig();
value.id = `${path.basename(path.dirname(target)) || 'project'}-workflow`;
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
console.log(target);
