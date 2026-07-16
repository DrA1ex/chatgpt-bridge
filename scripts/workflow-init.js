#!/usr/bin/env node
import { initWorkflowConfig } from '../src/cli/workflowConfigCommands.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run workflow:init -- [path] [--force]');
  console.log('Creates a project-aware workflow configuration. Default: bridge.workflow.json');
  process.exit(0);
}
const unknownOption = args.find((arg) => arg.startsWith('-') && arg !== '--force');
if (unknownOption) {
  console.error(`Unknown option: ${unknownOption}`);
  process.exit(2);
}
try {
  const target = args.find((arg) => !arg.startsWith('-')) || '';
  const result = await initWorkflowConfig(target, { force: args.includes('--force') });
  console.log(result.path);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
