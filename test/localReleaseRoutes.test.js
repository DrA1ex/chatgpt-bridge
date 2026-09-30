import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-local-release-routes-'));
process.env.ENV_FILE = path.join(testDataDir, '.env');
process.env.DATA_DIR = testDataDir;
process.env.API_TOKEN = 'local-release-api-token';

const { config } = await import('../src/config.js');
const { registerLocalReleaseRoutes } = await import('../src/http/localReleaseRoutes.js');

function createRouteHarness() {
  const registrations = [];
  const calls = [];
  const bridge = {
    outcome: { status: 'confirmed', result: { private: 'never expose this' } },
    async releaseStaleRequestLease(input) {
      calls.push(input);
      return this.outcome;
    },
  };
  const router = {
    post(routePath, ...handlers) {
      registrations.push({ routePath, handlers });
    },
  };
  registerLocalReleaseRoutes(router, bridge);
  const route = registrations.find(({ routePath }) => routePath === '/__local/release-stale-request')?.handlers.at(-1);
  assert.equal(typeof route, 'function', 'registers the local stale request release route');
  return { calls, bridge, route };
}

async function invoke(route, remoteAddress, body) {
  const result = { statusCode: 200, body: undefined, error: undefined };
  const response = {
    status(statusCode) { result.statusCode = statusCode; return this; },
    json(value) { result.body = value; return this; },
  };
  await route({ socket: { remoteAddress }, body }, response, (error) => { result.error = error; });
  if (result.error) throw result.error;
  return result;
}

test('stale lease release fails closed when API_TOKEN is not configured', () => {
  const routeUrl = pathToFileURL(path.resolve('src/http/localReleaseRoutes.js')).href;
  const configUrl = pathToFileURL(path.resolve('src/config.js')).href;
  const childDataDir = path.join(testDataDir, 'missing-token');
  const script = `
    import path from 'node:path';
    process.env.ENV_FILE = path.join(${JSON.stringify(childDataDir)}, '.env');
    process.env.DATA_DIR = ${JSON.stringify(childDataDir)};
    process.env.API_TOKEN = '';
    const { config } = await import(${JSON.stringify(configUrl)});
    const { registerLocalReleaseRoutes } = await import(${JSON.stringify(routeUrl)});
    let handler;
    registerLocalReleaseRoutes({ post(_path, ...handlers) { handler = handlers.at(-1); } }, {
      async releaseStaleRequestLease() { throw new Error('must not release'); },
    });
    const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ socket: { remoteAddress: '127.0.0.1' }, body: {} }, response, (error) => { throw error; });
    process.stdout.write(JSON.stringify({ configured: Boolean(config.apiToken), statusCode: response.statusCode, body: response.body }));
  `;
  const childOutput = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(childOutput), {
    configured: false,
    statusCode: 401,
    body: { detail: 'API_TOKEN must be configured for local stale request lease recovery' },
  });
});

test('stale lease release accepts only the three explicit loopback peer addresses', async () => {
  const { calls, route } = createRouteHarness();
  const acceptedAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  for (const remoteAddress of acceptedAddresses) {
    const response = await invoke(route, remoteAddress, { requestId: remoteAddress });
    assert.equal(response.statusCode, 200, remoteAddress);
  }
  assert.equal(calls.length, acceptedAddresses.length);

  const deniedAddresses = ['127.0.0.2', '::ffff:127.0.0.2', '::ffff:7f00:1', '10.0.0.1', '192.168.1.20', '::', 'localhost', ''];
  for (const remoteAddress of deniedAddresses) {
    const response = await invoke(route, remoteAddress, { requestId: remoteAddress });
    assert.equal(response.statusCode, 403, remoteAddress || '<missing>');
    assert.deepEqual(response.body, { detail: 'Local stale request lease recovery only accepts loopback connections' });
  }
  assert.equal(calls.length, acceptedAddresses.length, 'non-loopback peers never reach the coordinator');
});

test('stale lease release passes the parsed request body unchanged to the coordinator', async () => {
  const { calls, route } = createRouteHarness();
  const body = {
    requestId: 'request-1',
    clientId: 'client-1',
    leaseId: 'lease-1',
    ownerServerInstanceId: 'server-1',
    responseEpoch: 9,
    extra: { preserve: ['the', 'entire', 'body'] },
  };
  const response = await invoke(route, '127.0.0.1', body);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], body);
});

test('stale lease release maps coordinator outcomes to bounded HTTP responses', async () => {
  const { bridge, route } = createRouteHarness();
  const cases = [
    ['confirmed', 200],
    ['ambiguous', 202],
    ['rejected', 409],
  ];
  for (const [status, expectedStatusCode] of cases) {
    bridge.outcome = {
      status,
      reason: 'safe diagnostic code',
      result: { prompt: 'private prompt', page: '<private page>', path: '/private/host/path' },
      message: 'private coordinator detail',
    };
    const response = await invoke(route, '127.0.0.1', {});
    assert.equal(response.statusCode, expectedStatusCode, status);
    assert.deepEqual(response.body, { status });
  }
});

test.after(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
});
