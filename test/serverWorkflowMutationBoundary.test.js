import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverBackedGraph = [
  'src/workflow/server/zipflowBridgeRuntime.js',
  'src/workflow/server/serverRepairSeries.js',
  'src/workflow/server/artifactTransfer.js',
  'src/workflow/server/serverWorkflowPresets.js',
  'src/interactive/serverWorkflowCommands.js',
  'src/interactive/workflowSurfaceRuntime.js',
];
const forbiddenImports = [
  '/interactive/apply.js',
  '/workflow/transaction',
  '/workflow/checks/',
  '/workflow/services/apply',
  '/workflow/services/commit',
  '/workflow/services/deploy',
  '/git/',
];

test('server-backed workflow graph delegates every project mutation to Zipflow', async () => {
  for (const relativePath of serverBackedGraph) {
    const source = await fs.readFile(path.join(root, relativePath), 'utf8');
    const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    for (const forbidden of forbiddenImports) {
      assert.equal(
        imports.some((specifier) => specifier.includes(forbidden)),
        false,
        `${relativePath} imports forbidden local mutation owner ${forbidden}`,
      );
    }
  }
});

test('server-backed orchestration cannot execute raw local commands', async () => {
  const files = await Promise.all(serverBackedGraph.map(async (relativePath) => ({
    relativePath,
    source: await fs.readFile(path.join(root, relativePath), 'utf8'),
  })));
  for (const { relativePath, source } of files) {
    assert.doesNotMatch(source, /\bexecFile(?:Sync)?\s*\(/, relativePath);
    assert.doesNotMatch(source, /\bspawn(?:Sync)?\s*\(/, relativePath);
    assert.doesNotMatch(source, /\bwriteFile\s*\([^,]*project/i, relativePath);
  }
});
