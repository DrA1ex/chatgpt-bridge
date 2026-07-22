import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const requiredLiveScenarios = [
  'conversation',
  'response-markdown',
  'reasoning-lifecycle',
  'model-effort',
  'reasoning-steer',
  'reload-mid-request',
  'quarantine-isolation',
  'zip-artifact',
  'passive-workflow',
  'workflow-multi-bridge',
  'workflow-approval',
  'workflow-remediation',
];

test('release verification exposes local, live, clean-install, extension, and audit gates', async () => {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(packageJson.dependencies.sqlite3, '^6.0.1');
  const packageLock = await fs.readFile('package-lock.json', 'utf8');
  assert.doesNotMatch(packageLock, /internal\.api\.openai\.org|artifactory\/api\/npm/i);
  assert.match(packageLock, /https:\/\/registry\.npmjs\.org\/sqlite3\/-\/sqlite3-6\.0\.1\.tgz/);
  assert.equal(packageJson.scripts['verify:extension'], 'node scripts/verify-extension-deployment.js');
  assert.equal(packageJson.scripts['verify:release:local'], 'node scripts/release-verify.js --local');
  assert.equal(packageJson.scripts['verify:release:live'], 'node scripts/release-verify.js --live');
  assert.equal(packageJson.scripts['verify:release'], 'node scripts/release-verify.js --local --live --clean-install');

  const source = await fs.readFile('scripts/release-verify.js', 'utf8');
  for (const scenario of requiredLiveScenarios) assert.match(source, new RegExp(`['"]${scenario}['"]`));
  for (const gate of ['test:faults', 'test:workflow:coverage', 'test:e2e:local:fixtures', 'test:e2e:mock', 'test:workflow:multi-bridge', 'test:parser-fixture', 'audit']) {
    assert.match(source, new RegExp(gate.replaceAll(':', '\\:')));
  }

  const help = execFileSync(process.execPath, ['scripts/release-verify.js', '--help'], { encoding: 'utf8' });
  assert.match(help, /authenticated browser release matrix/i);
  assert.match(help, /--clean-install/);
  assert.match(help, /--report-dir/);
  assert.match(source, /authenticated-e2e/);
  assert.match(source, /stdio: \['ignore', logFd, logFd\]/);
  assert.match(source, /await runGate/);
  assert.match(source, /BRIDGE_RELEASE_GATE_TIMEOUT_MS/);
  assert.match(source, /process\.kill\(-child\.pid/);
  assert.doesNotMatch(source, /spawnSync/);
  assert.match(source, /log: path\.basename\(logPath\)/);
  assert.doesNotMatch(source, /stdio: 'inherit'/);
});

test('release extension deployment verifier checks install, repair, and unchanged update', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-extension-deployment.js'], { encoding: 'utf8' });
  assert.match(output, /deployment verified/i);
  assert.match(output, /stale-file cleanup/i);
});
