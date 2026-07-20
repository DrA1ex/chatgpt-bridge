import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ExtensionMessageKind,
  createExtensionEnvelope,
  extensionKindForPayload,
  validateExtensionEnvelope,
} from '../src/bridge/protocol/v4.js';
import {
  BACKGROUND_STATE_SCHEMA_VERSION,
  BACKGROUND_STATE_STORAGE_PREFIX,
  BackgroundStateStore,
  EffectStatus,
  createTabRuntimeState,
  reduceTabRuntimeState,
} from '../tools/chrome-bridge-extension/background/stateV4.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV4.js';
import {
  TabOperationPriority,
  TabOperationQueue,
} from '../tools/chrome-bridge-extension/background/tabOperationQueue.js';
import { createPromptExecutionPlan, resumePromptExecutionPlan } from '../src/bridge/requestExecutionPlan.js';

function transition(state, event) {
  return reduceTabRuntimeState(state, {
    tabId: 77,
    backgroundEpoch: 'background-hard-cut',
    contentEpoch: 'content-hard-cut',
    ...event,
  });
}

function claimedState() {
  let state = createTabRuntimeState(77, 'background-hard-cut');
  state = transition(state, { type: 'content.attached' }).state;
  state = transition(state, {
    type: 'lease.claim',
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
  }).state;
  return state;
}

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      return { [key]: structuredClone(values[key]) };
    },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

test('protocol 4 hard cut accepts only tab.observation and rejects legacy observation payloads', () => {
  assert.equal(ExtensionMessageKind.TAB_OBSERVATION, 'tab.observation');
  assert.equal(extensionKindForPayload({ type: 'tab.observation' }), ExtensionMessageKind.TAB_OBSERVATION);
  assert.throws(
    () => extensionKindForPayload({ type: 'request.observation' }),
    /Unsupported extension protocol 4 payload type/,
  );
  const legacy = {
    protocolVersion: 4,
    messageId: 'legacy-observation',
    kind: 'request.observation',
    sentAt: Date.now(),
    source: {
      clientId: 'client-hard-cut',
      tabId: 77,
      backgroundEpoch: 'background-hard-cut',
      contentEpoch: 'content-hard-cut',
      sequence: 1,
    },
    request: null,
    commandId: null,
    effectId: null,
    causationId: null,
    payload: { type: 'request.observation' },
  };
  assert.equal(validateExtensionEnvelope(legacy).valid, false);
});

test('physical BrowserEffect is self-contained and dispatched cancellation requires proof', () => {
  let state = claimedState();
  let outcome = transition(state, {
    type: 'effect.planned',
    at: 100,
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
    effectId: 'effect-hard-cut',
    commandId: 'command-hard-cut',
    causationId: 'message-hard-cut',
    kind: 'prompt.submit',
    idempotencyKey: 'request-hard-cut:prompt.submit:2',
    preconditions: { conversationId: 'conversation-hard-cut', promptHash: 'abc' },
    retryPolicy: 'never',
    attempt: 1,
  });
  assert.equal(outcome.accepted, true);
  state = outcome.state;
  const planned = state.effects['effect-hard-cut'];
  assert.equal(planned.commandId, 'command-hard-cut');
  assert.equal(planned.causationId, 'message-hard-cut');
  assert.equal(planned.requestId, 'request-hard-cut');
  assert.equal(planned.leaseId, 'lease-hard-cut');
  assert.equal(planned.ownerServerInstanceId, 'server-hard-cut');
  assert.equal(planned.responseEpoch, 2);
  assert.match(planned.preconditionsHash, /^fnv1a32:[0-9a-f]{8}$/);
  assert.equal(planned.plannedAt, 100);
  assert.equal(planned.dispatchedAt, 0);
  assert.equal(planned.settledAt, 0);

  outcome = transition(state, {
    type: 'effect.dispatched',
    at: 110,
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
    effectId: 'effect-hard-cut',
    idempotencyKey: planned.idempotencyKey,
    preconditionsHash: planned.preconditionsHash,
  });
  assert.equal(outcome.accepted, true);
  state = outcome.state;
  assert.equal(state.effects['effect-hard-cut'].dispatchedAt, 110);

  const unproved = transition(state, {
    type: 'effect.cancelled',
    at: 120,
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
    effectId: 'effect-hard-cut',
    idempotencyKey: planned.idempotencyKey,
  });
  assert.equal(unproved.accepted, false);
  assert.equal(unproved.reason, 'effect_cancellation_unproven');

  outcome = transition(state, {
    type: 'effect.cancelled',
    at: 130,
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
    effectId: 'effect-hard-cut',
    idempotencyKey: planned.idempotencyKey,
    preconditionsHash: planned.preconditionsHash,
    provenNotExecuted: true,
    cancellationEvidence: { executorAccepted: false, browserWriteObserved: false },
  });
  assert.equal(outcome.accepted, true);
  const cancelled = outcome.state.effects['effect-hard-cut'];
  assert.equal(cancelled.status, EffectStatus.CANCELLED);
  assert.equal(cancelled.settledAt, 130);
  assert.deepEqual(cancelled.cancellationEvidence, { executorAccepted: false, browserWriteObserved: false });
});

test('tab queue reserves capacity for release and prioritizes unrelated critical controls', async () => {
  const queue = new TabOperationQueue({ maxPending: 2, reservedCritical: 1 });
  const order = [];
  let unblock;
  const running = queue.run(77, async () => {
    order.push('running');
    await new Promise((resolve) => { unblock = resolve; });
  }, { label: 'running', priority: TabOperationPriority.REQUEST, serialGroup: 'content' });
  const maintenance = queue.run(77, async () => { order.push('maintenance'); }, {
    label: 'maintenance', priority: TabOperationPriority.MAINTENANCE, serialGroup: 'maintenance',
  });
  const release = queue.run(77, async () => { order.push('release'); }, {
    label: 'release', priority: TabOperationPriority.RELEASE, critical: true, serialGroup: 'control',
  });
  await assert.rejects(
    queue.run(77, async () => {}, { label: 'overflow', priority: TabOperationPriority.REQUEST }),
    (error) => error?.code === 'TAB_OPERATION_QUEUE_FULL',
  );
  assert.equal(queue.metrics(77).pending, 3);
  assert.equal(queue.metrics(77).reservedCritical, 1);
  unblock();
  await Promise.all([running, maintenance, release]);
  assert.deepEqual(order, ['running', 'release', 'maintenance']);
});

test('tab queue preserves transport sequence inside one serial group despite priority', async () => {
  const queue = new TabOperationQueue({ maxPending: 4, reservedCritical: 1 });
  const order = [];
  let unblock;
  const running = queue.run(77, () => new Promise((resolve) => { unblock = resolve; }), {
    label: 'running', serialGroup: 'content', priority: TabOperationPriority.REQUEST,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const request = queue.run(77, async () => { order.push('request-1'); }, {
    label: 'request-1', serialGroup: 'server', order: 1, priority: TabOperationPriority.REQUEST,
  });
  const release = queue.run(77, async () => { order.push('release-2'); }, {
    label: 'release-2', serialGroup: 'server', order: 2, priority: TabOperationPriority.RELEASE, critical: true,
  });
  unblock();
  await Promise.all([running, request, release]);
  assert.deepEqual(order, ['request-1', 'release-2']);
});

test('normal observations are not persisted while forced reconciliation snapshots may be critical', async () => {
  const storage = memoryStorage();
  const backgroundState = new BackgroundStateStore(storage, 'background-hard-cut');
  await backgroundState.transition(77, { type: 'content.attached', contentEpoch: 'content-hard-cut' });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const state = {
      tabId: 77,
      clientId: 'client-hard-cut',
      contentEpoch: 'content-hard-cut',
      port: null,
      ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } },
    };
    const outbox = createProtocolOutbox({
      backgroundEpoch: 'background-hard-cut',
      backgroundState,
      post() {},
      summarize: (value) => value,
    });
    await outbox.sendProtocolPayload(state, { type: 'tab.observation', observation: { revision: 1 } });
    assert.equal((await backgroundState.read(77)).outbox.length, 0);
    await outbox.sendProtocolPayload(state, { type: 'tab.observation', observation: { revision: 2 } }, { critical: true });
    assert.equal((await backgroundState.read(77)).outbox.length, 1);
    assert.equal(sent.length, 2);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});

test('background schema hard cut preserves busy v4 state instead of deleting it during migration', async () => {
  assert.equal(BACKGROUND_STATE_SCHEMA_VERSION, 5);
  assert.equal(BACKGROUND_STATE_STORAGE_PREFIX, 'chatgptBridgeV5:tab:');
  const legacyBusy = {
    ...createTabRuntimeState(77, 'legacy-background'),
    schemaVersion: 4,
    lease: {
      requestId: 'legacy-request',
      leaseId: 'legacy-lease',
      ownerServerInstanceId: 'legacy-server',
      status: 'claimed',
    },
  };
  const storage = memoryStorage({
    'chatgptBridgeV4:tab:77': legacyBusy,
    'chatgptBridgeV3:runtime': { legacy: true },
  });
  const store = new BackgroundStateStore(storage, 'background-hard-cut');
  const blocked = await store.cleanupLegacyStateIfIdle();
  assert.equal(blocked.reason, 'active_background_state');
  assert.ok(storage.values['chatgptBridgeV4:tab:77']);
  assert.ok(storage.values['chatgptBridgeV3:runtime']);
});

test('production protocol and coordinator sources contain no transitional observation alias', async () => {
  const roots = ['src', 'tools/chrome-bridge-extension'];
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(resolved);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(resolved);
    }
  }
  for (const root of roots) await collect(root);
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /['"]request\.observation['"]|REQUEST_OBSERVATION/, path.relative(process.cwd(), file));
  }
});


test('server-owned execution plan supplies stable logical identity and hashed preconditions', () => {
  const request = {
    requestId: 'request-plan',
    leaseId: 'lease-plan',
    ownerServerInstanceId: 'server-plan',
    responseEpoch: 3,
  };
  const plan = createPromptExecutionPlan({
    request,
    message: 'hello',
    options: { sessionId: 'session-plan', model: 'gpt-5', effort: 'high' },
    attachments: [{ id: 'file-1', name: 'project.zip', size: 42, mime: 'application/zip' }],
  });
  for (const step of plan.steps) {
    assert.match(step.preconditionsHash, /^[0-9a-f]{64}$/);
    assert.ok(step.idempotencyKey.startsWith('request-plan:'));
  }
  const session = plan.steps.find((step) => step.kind === 'session.apply');
  const retried = resumePromptExecutionPlan(plan, { effectId: session.effectId, mode: 'retry_same' });
  const retry = retried.steps.find((step) => step.kind === 'session.apply');
  assert.equal(retry.idempotencyKey, session.idempotencyKey);
  assert.equal(retry.preconditionsHash, session.preconditionsHash);
  assert.equal(retry.attempt, session.attempt + 1);
  assert.notEqual(retry.effectId, session.effectId);
});

test('background persists the canonical server preconditions hash without substituting a local algorithm', () => {
  const request = {
    requestId: 'request-hard-cut',
    leaseId: 'lease-hard-cut',
    ownerServerInstanceId: 'server-hard-cut',
    responseEpoch: 2,
  };
  const plan = createPromptExecutionPlan({
    request,
    message: 'hash contract',
    options: { sessionId: 'session-hard-cut' },
    attachments: [],
  });
  const step = plan.steps[0];
  const outcome = transition(claimedState(), {
    type: 'effect.planned',
    requestId: request.requestId,
    leaseId: request.leaseId,
    ownerServerInstanceId: request.ownerServerInstanceId,
    responseEpoch: request.responseEpoch,
    effectId: step.effectId,
    idempotencyKey: step.idempotencyKey,
    kind: step.kind,
    commandId: 'command-hash-contract',
    causationId: 'command-hash-contract',
    attempt: step.attempt,
    retryPolicy: step.retryPolicy,
    preconditions: step.preconditions,
    preconditionsHash: step.preconditionsHash,
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.effects[step.effectId].preconditionsHash, step.preconditionsHash);
});

test('workflow architecture has one action lifecycle and no direct verification bypasses', async () => {
  const workflowRoot = new URL('../src/workflow/', import.meta.url);
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const resolved = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
      if (entry.isDirectory()) await collect(resolved);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(resolved);
    }
  }
  await collect(workflowRoot);
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:getDecision|setDecision)\b|\bdecisions\s*:/, file.pathname);
  }
  const manual = await fs.readFile(new URL('../src/workflow/manualOperations.js', import.meta.url), 'utf8');
  const response = await fs.readFile(new URL('../src/workflow/services/responseProcessor.js', import.meta.url), 'utf8');
  assert.match(manual, /executeLocalEffect\s*\(/);
  assert.match(response, /verify:approval:[^`]*`[\s\S]*?executeLocalEffect\s*\(/);
});

test('content request executor consumes server effect descriptors and owns no effect identity generator', async () => {
  const telemetry = await fs.readFile(new URL('../tools/chrome-bridge-extension/content/requestTelemetry.js', import.meta.url), 'utf8');
  const commands = await fs.readFile(new URL('../tools/chrome-bridge-extension/content/requestCommands.js', import.meta.url), 'utf8');
  assert.match(telemetry, /Server execution plan is missing a valid descriptor/);
  assert.doesNotMatch(telemetry, /effectSequence|resumeAfterEffectType|randomUUID|stableHash\s*\(/);
  assert.match(commands, /const currentStep = planSteps\[startAtIndex\]/);
  assert.match(commands, /runObservedRequestEffect\(request, currentStepKind/);
  assert.doesNotMatch(commands, /for\s*\([^)]*planSteps|planSteps\.slice\(startAtIndex\)/);
  assert.doesNotMatch(telemetry, /type:\s*'request\.effect\.succeeded'|type:\s*`request\.effect\.\$\{status\}`/);
});
