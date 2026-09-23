import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_ZIPFLOW_CAPABILITIES,
  ZipflowWorkflowClient,
  validateZipflowHello,
} from '../src/workflow/server/zipflowWorkflowClient.js';

function hello(overrides = {}) {
  return {
    apiVersion: '1.0',
    schemaRevision: 1,
    serverEpoch: 'epoch-1',
    capabilities: [...REQUIRED_ZIPFLOW_CAPABILITIES],
    ...overrides,
  };
}

test('Zipflow workflow client uses an injected side-effect-free SDK boundary', async () => {
  let loaderCalls = 0;
  let projectReads = 0;
  const sleeps = [];
  const sdkClient = {
    hello: async () => hello(),
    getProject: async (projectId) => {
      projectReads += 1;
      if (projectReads < 3) throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
      return { projectId };
    },
  };
  const client = new ZipflowWorkflowClient({
    sdkClient,
    sdkLoader: async () => {
      loaderCalls += 1;
      throw new Error('loader must not run');
    },
    token: 'secret',
    readRetryLimit: 2,
    retryBaseMs: 5,
    sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal((await client.hello()).serverEpoch, 'epoch-1');
  assert.deepEqual(await client.getProject('project-1'), { projectId: 'project-1' });
  assert.equal(loaderCalls, 0);
  assert.equal(projectReads, 3);
  assert.deepEqual(sleeps, [5, 10]);
});

test('Zipflow workflow client never automatically retries a mutation', async () => {
  let calls = 0;
  const client = new ZipflowWorkflowClient({
    sdkClient: {
      openProject: async () => {
        calls += 1;
        throw {
          problem: {
            status: 503,
            code: 'INTERNAL_ERROR',
            message: 'request failed with token abc',
            retryable: true,
            details: { authorization: 'Bearer secret', currentRevision: 3 },
          },
        };
      },
    },
    readRetryLimit: 9,
    sleep: async () => {},
  });

  await assert.rejects(
    client.openProject('/tmp/project', { idempotencyKey: 'one-key' }),
    (error) => {
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.equal(error.retryable, true);
      assert.equal(error.details.authorization, '[redacted]');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('hello validation rejects incompatible API and missing capabilities', () => {
  assert.throws(
    () => validateZipflowHello(hello({ apiVersion: '2.0' })),
    { code: 'API_INCOMPATIBLE' },
  );
  assert.throws(
    () => validateZipflowHello(hello({ capabilities: ['projects'] })),
    { code: 'CAPABILITY_MISSING' },
  );
});
