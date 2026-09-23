import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { forwardFullPowerRequest, fullPowerBridgeEnabled } from '../src/fullPowerBridgeClient.js';

function startMock(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  })));
}

test('direct Full-Power adapter forwarding keeps execution independent of Controller', async () => {
  let received;
  const fixture = await startMock(async (req, res) => {
    received = { method: req.method, url: req.url, authorization: req.headers.authorization, body: '' };
    for await (const chunk of req) received.body += chunk;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ job_id: 'job-direct-1', final_state: 'QUEUED', direct_bridge: true }));
  });
  try {
    const result = await forwardFullPowerRequest('/v1/manager/jobs', {
      method: 'POST',
      body: { job_id: 'job-direct-1', capability: 'one-use-capability', payload: 'script' },
      config: { fullPowerBridgeUrl: fixture.url, fullPowerBridgeToken: 'bridge-secret', fullPowerRequestTimeoutMs: 2000 },
    });
    assert.deepEqual(result, { job_id: 'job-direct-1', final_state: 'QUEUED', direct_bridge: true });
    assert.deepEqual(received, {
      method: 'POST',
      url: '/v1/manager/jobs',
      authorization: 'Bearer bridge-secret',
      body: JSON.stringify({ job_id: 'job-direct-1', capability: 'one-use-capability', payload: 'script' }),
    });
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('Full-Power forwarding preserves upstream failure without converting it to success', async () => {
  const fixture = await startMock(async (_req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'capability replay', category: 'CAPABILITY_REPLAY' }));
  });
  try {
    await assert.rejects(
      forwardFullPowerRequest('/v1/manager/jobs', {
        method: 'POST',
        body: {},
        config: { fullPowerBridgeUrl: fixture.url, fullPowerBridgeToken: 'bridge-secret', fullPowerRequestTimeoutMs: 2000 },
      }),
      (error) => error.statusCode === 409 && /capability replay/i.test(error.message),
    );
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('Full-Power forwarding times out as an explicit failure', async () => {
  const fixture = await startMock(() => {});
  try {
    await assert.rejects(
      forwardFullPowerRequest('/health', {
        config: { fullPowerBridgeUrl: fixture.url, fullPowerBridgeToken: 'bridge-secret', fullPowerRequestTimeoutMs: 1000 },
      }),
      (error) => error.statusCode === 504 && /timed out/i.test(error.message),
    );
  } finally {
    fixture.server.close();
  }
});

test('direct adapter is disabled until its separate internal token is configured', () => {
  assert.equal(fullPowerBridgeEnabled({ fullPowerBridgeUrl: 'http://127.0.0.1:8788', fullPowerBridgeToken: '' }), false);
  assert.equal(fullPowerBridgeEnabled({ fullPowerBridgeUrl: 'http://127.0.0.1:8788', fullPowerBridgeToken: 'configured' }), true);
});
