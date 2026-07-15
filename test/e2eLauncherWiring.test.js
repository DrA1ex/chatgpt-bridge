import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const launcherUrl = new URL('../scripts/e2e-real.js', import.meta.url);

test('real E2E launcher validates core scenario dependencies before starting the bridge', async () => {
  const source = await fs.readFile(launcherUrl, 'utf8');
  const factoryIndex = source.indexOf('const buildCoreScenarioContext = createCoreScenarioContextFactory({');
  const bridgeStartIndex = source.indexOf('ownedServer = await startBridgeIfNeeded(options);');
  assert(factoryIndex >= 0, 'Core scenario context factory is not assembled by the launcher');
  assert(bridgeStartIndex >= 0, 'Bridge startup call is missing from the launcher');
  assert(factoryIndex < bridgeStartIndex, 'Core scenario dependencies must be validated before bridge startup');

  const factoryBlock = source.slice(factoryIndex, bridgeStartIndex);
  assert.match(factoryBlock, /\beffortFor\b/, 'Launcher must bind effortFor into the validated core scenario context');
  assert.match(
    source,
    /runCoreScenarios\(buildCoreScenarioContext\(\{\s*sessionId,\s*sessionUrl,\s*testClient\s*\}\)\)/,
    'Core scenarios must use the validated runtime context builder',
  );
});
