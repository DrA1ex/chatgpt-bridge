import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function text(rel) { return await fs.readFile(path.join(root, rel), 'utf8'); }

async function extensionContentRuntime() {
  const manifest = JSON.parse(await text('tools/chrome-bridge-extension/manifest.json'));
  return (await Promise.all(manifest.content_scripts[1].js.map((file) => text(`tools/chrome-bridge-extension/${file}`)))).join('\n');
}

test('extension exposes passive turns, tab refresh, and self reload contracts', async () => {
  const content = await extensionContentRuntime();
  const background = [
    await text('tools/chrome-bridge-extension/background.js'),
    await text('tools/chrome-bridge-extension/background/portRouter.js'),
  ].join('\n');
  const manifest = JSON.parse(await text('tools/chrome-bridge-extension/manifest.json'));
  assert.doesNotMatch(content, /observed\.turn\.(?:snapshot|terminal)/);
  assert.match(content, /type: 'tab\.observation'/);
  assert.match(content, /subscribeTabObservation/);
  assert.match(content, /passive\.prompt\.submit/);
  assert.match(content, /passivePromptSubmission: true/);
  assert.match(content, /browser\.tab\.reload/);
  assert.match(content, /extension\.reload/);
  assert.match(background, /bridge\.tab\.reload/);
  assert.match(background, /bridge\.extension\.reload/);
  assert.match(background, /chrome\.runtime\.reload\(\)/);
  assert.ok(manifest.permissions.includes('tabs'));
  assert.ok(manifest.permissions.includes('downloads'));
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 100, 'manifest has a stable public extension key');
});

test('workflow API and interactive commands are exposed', async () => {
  const routes = await text('src/routes.js');
  const workflowRoutes = await text('src/http/workflowRoutes.js');
  const commandHandler = await text('src/interactive/commandHandler.js');
  const commands = await text('src/interactive/commands.js');
  const packageJson = JSON.parse(await text('package.json'));
  assert.match(workflowRoutes, /\/workflows\/:id\/commands/);
  assert.match(workflowRoutes, /commandId is required/);
  assert.match(workflowRoutes, /expectedRevision/);
  assert.match(workflowRoutes, /\/workflows\/:id\/transitions/);
  assert.match(routes, /\/browser\/passive-prompt/);
  assert.doesNotMatch(workflowRoutes, /workflow-approvals|\/verify|\/run\/stop/);
  assert.match(commandHandler, /openWorkflowWizard/);
  assert.match(commands, /cmd: '\/workflow'/);
  assert.match(commands, /context-sensitive workflow wizard/);
  assert.doesNotMatch(commands, /cmd: '\/(?:watch|watch-status|unwatch)'/);
  assert.equal(packageJson.bin.bridge, 'bin/bridge.js');
  assert.equal(packageJson.bin['chatgpt-bridge'], 'bin/bridge.js');
  assert.ok(packageJson.scripts['workflow:init']);
  assert.ok(packageJson.scripts['extension:install']);
  assert.ok(packageJson.scripts['test:e2e:passive-workflow']);
  assert.ok(packageJson.scripts['test:e2e:workflow-approval']);
  assert.ok(packageJson.scripts['test:e2e:workflow-remediation']);
  assert.ok(packageJson.scripts['test:e2e:workflows']);
});


test('workflow helper scripts expose help without performing writes', async () => {
  const before = new Set(await fs.readdir(root));
  for (const script of ['scripts/workflow-init.js', 'scripts/extension-install.js']) {
    const result = spawnSync(process.execPath, [path.join(root, script), '--help'], {
      cwd: root,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${script} --help exits successfully: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
  }
  const after = new Set(await fs.readdir(root));
  assert.deepEqual([...after].sort(), [...before].sort(), '--help does not create files in the project root');
});
