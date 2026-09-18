import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function startMock(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  })));
}

const seen = [];
const adapter = await startMock(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
  const owner = req.url.startsWith('/v1/owner/');
  res.writeHead(owner ? 200 : 201, { 'content-type': 'application/json' });
  const payload = owner && req.method === 'GET'
    ? { job_id: 'job-1', stdout: 'API_TOKEN=owner-visible-secret' }
    : owner
      ? { job_id: 'job-1', authorized: true }
      : { job_id: 'job-1', direct_bridge: true };
  res.end(JSON.stringify(payload));
});

const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-full-power-routes-'));
process.env.ENV_FILE = path.join(configDir, '.env');
process.env.DATA_DIR = configDir;
process.env.API_TOKEN = 'api-token-for-full-power-tests';
process.env.FULL_POWER_BRIDGE_URL = adapter.url;
process.env.FULL_POWER_BRIDGE_TOKEN = 'internal-bridge-token';
process.env.FULL_POWER_OWNER_TOKEN = 'internal-owner-token';
process.env.FULL_POWER_REQUEST_TIMEOUT_MS = '2000';

const { default: express } = await import('../src/runtime/express.js');
const { registerFullPowerBridgeRoutes } = await import('../src/http/fullPowerBridgeRoutes.js');

function startApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const router = express.Router();
  registerFullPowerBridgeRoutes(router);
  app.use(router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ detail: error.message }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

test('Node Bridge exposes direct Manager-to-Full-Power routes without Controller calls', async () => {
  seen.length = 0;
  const app = await startApp();
  try {
    const capability = await fetch(`${app.url}/v1/full-power/capabilities`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', payload_hash: 'a'.repeat(64) }),
    });
    assert.equal(capability.status, 201);
    assert.deepEqual(await capability.json(), { job_id: 'job-1', direct_bridge: true });

    const owner = await fetch(`${app.url}/v1/full-power/owner/jobs/job-1/confirm`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.API_TOKEN}`,
        'x-full-power-owner-token': process.env.FULL_POWER_OWNER_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmation: { job_id: 'job-1' } }),
    });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { job_id: 'job-1', authorized: true });

    assert.equal(seen.length, 2);
    assert.equal(seen[0].authorization, `Bearer ${process.env.FULL_POWER_BRIDGE_TOKEN}`);
    assert.equal(seen[1].authorization, `Bearer ${process.env.FULL_POWER_OWNER_TOKEN}`);

    const ownerResult = await fetch(`${app.url}/v1/full-power/owner/jobs/job-1/result`, {
      headers: {
        authorization: `Bearer ${process.env.API_TOKEN}`,
        'x-full-power-owner-token': process.env.FULL_POWER_OWNER_TOKEN,
      },
    });
    assert.equal(ownerResult.status, 200);
    assert.deepEqual(await ownerResult.json(), { job_id: 'job-1', stdout: 'API_TOKEN=owner-visible-secret' });
    assert.equal(seen[2].authorization, `Bearer ${process.env.FULL_POWER_OWNER_TOKEN}`);
    assert.equal(seen[2].method, 'GET');

    const ownerDenied = await fetch(`${app.url}/v1/full-power/owner/jobs/job-1/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(ownerDenied.status, 401);
    assert.equal(seen.length, 3);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('direct Full-Power routes fail closed without the Bridge API token', async () => {
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/v1/full-power/jobs`);
    assert.equal(response.status, 401);
    assert.match((await response.json()).detail, /API_TOKEN/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('direct Full-Power routes do not accept API credentials in a query string', async () => {
  seen.length = 0;
  const app = await startApp();
  try {
    const response = await fetch(`${app.url}/v1/full-power/jobs?api_token=${encodeURIComponent(process.env.API_TOKEN)}`);
    assert.equal(response.status, 401);
    assert.equal(seen.length, 0);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test.after(async () => {
  await new Promise((resolve) => adapter.server.close(resolve));
});
