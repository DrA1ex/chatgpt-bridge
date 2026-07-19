import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const COMPOSITION_ROOTS = [
  'src/browserExtensionHub.js',
  'src/browserBridge.js',
  'src/bridge/coordinator/requestLifecycleCoordinator.js',
  'src/bridge/coordinator/browserClientCoordinator.js',
  'src/workflow/workflowManager.js',
  'src/workflow/automation/controller.js',
  'tools/chrome-bridge-extension/background.js',
  'tools/chrome-bridge-extension/content.js',
];

test('primary composition roots remain at or below the 500-line architecture target', async () => {
  for (const file of COMPOSITION_ROOTS) {
    const source = await fs.readFile(path.resolve(file), 'utf8');
    const lines = source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
    assert.ok(lines <= 500, `${file} has ${lines} lines; split responsibilities before adding more behavior`);
  }
});
