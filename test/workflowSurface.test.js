import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);

async function text(rel) { return await fs.readFile(path.join(root, rel), 'utf8'); }

test('extension exposes passive turns, tab refresh, and self reload contracts', async () => {
  const content = await text('tools/chrome-bridge-extension/content.js');
  const background = await text('tools/chrome-bridge-extension/background.js');
  const manifest = JSON.parse(await text('tools/chrome-bridge-extension/manifest.json'));
  assert.match(content, /observed\.turn\.terminal/);
  assert.match(content, /passive\.prompt\.submit/);
  assert.match(content, /passivePromptSubmission: true/);
  assert.match(content, /startPassiveTurnObserver\(\)/);
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
  const legacy = await text('src/interactiveLegacy.js');
  const commands = await text('src/interactive/commands.js');
  const packageJson = JSON.parse(await text('package.json'));
  assert.match(routes, /\/workflows\/:id\/verify/);
  assert.match(routes, /\/browser\/passive-prompt/);
  assert.match(routes, /\/workflow-approvals\/:id\/approve/);
  assert.match(legacy, /\/workflow init/);
  assert.match(legacy, /\/workflow approve/);
  assert.match(legacy, /\/workflow extension/);
  assert.match(commands, /cmd: '\/workflow'/);
  assert.ok(packageJson.scripts['workflow:init']);
  assert.ok(packageJson.scripts['extension:install']);
  assert.ok(packageJson.scripts['test:e2e:passive-workflow']);
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
