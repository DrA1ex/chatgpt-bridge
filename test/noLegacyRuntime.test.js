import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('removed runtime implementations and endpoints do not return', () => {
  for (const relativePath of [
    'src/jobManager.js',
    'src/interactiveLegacy.js',
    'src/tampermonkeyBridge.js',
    'src/tampermonkeyHub.js',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must stay removed`);
  }

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
