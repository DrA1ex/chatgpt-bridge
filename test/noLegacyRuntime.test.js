import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('removed runtime implementations and endpoints do not return', () => {
  for (const relativePath of [
    'src/jobManager.js',
    'src/interactiveLegacy.js',
    'src/tampermonkeyBridge.js',
    'src/tampermonkeyHub.js',
    'src/interactive/startupWorkflow.js',
    'src/interactive/guidedWorkflowRuntime.js',
    'src/interactive/applyWorkflowLiveMonitor.js',
    'src/workflow/ux/workflowWizard.js',
    'src/workflow/ux/workflowWizardControl.js',
    'src/workflow/workflowBackendRouter.js',
    'src/workflow/migration/zipflowMigrationRuntime.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must stay removed`);
  }


  const interactiveSources = [
    read('src/interactive/commands.js'),
    read('src/interactive/commandHandler.js'),
    read('src/interactive/terlioRuntime.js'),
    read('src/interactive/terlioView.js'),
    read('src/interactive/intelligenceSync.js'),
    read('src/interactive/interruptControl.js'),
  ].join('\n');
  assert.doesNotMatch(interactiveSources, /focusedWorkflowId|workflowWizard|workflowManager|zipflowMigrationRuntime|workflowBackendRouter/);
  assert.doesNotMatch(interactiveSources, /\/(?:tabs|sessions|themes|files|artifacts|download|open|scan|pack|skills|agent|watch|watch-status|unwatch)\b/);

  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts?.['interact:legacy'], undefined);

  const serverSources = [
    read('src/routes.js'),
    read('src/server.js'),
    read('src/browserExtensionHub.js'),
    read('src/browserBridge.js'),
  ].join('\n');
  assert.doesNotMatch(serverSources, /\/tm\/ws|\/project-jobs|(?:app|router)\.(?:get|post|delete|patch)\(['"]\/jobs/);

  const extensionSources = [
    read('tools/chrome-bridge-extension/background.js'),
    read('tools/chrome-bridge-extension/content.js'),
  ].join('\n');
  assert.doesNotMatch(extensionSources, /protocolVersion\s*:\s*2|userscript|GM_xmlhttpRequest/);
});
