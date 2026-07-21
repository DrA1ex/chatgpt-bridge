import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function readContentRuntime() {
  const root = path.resolve('tools/chrome-bridge-extension');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const source = (await Promise.all(files.map(async (file) => ({
    file,
    source: await fs.readFile(path.join(root, file), 'utf8'),
  }))));
  return { files, source };
}

async function loadObservationCore() {
  const file = path.resolve('tools/chrome-bridge-extension/observation/tabObservationCore.js');
  const source = await fs.readFile(file, 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source, context, { filename: path.basename(file) });
  return context.ChatGptTabObservationCore;
}

test('content runtime has no local request terminal lifecycle or terminal transport messages', async () => {
  const { files, source } = await readContentRuntime();
  assert.equal(files.some((file) => file.endsWith('requestLifecycleCore.js')), false);
  for (const entry of source) {
    assert.doesNotMatch(entry.source, /request\.terminal_snapshot|request\.terminal_failure/, `${entry.file} must not materialize request terminal outcomes`);
  }
});

test('content failures remain typed browser-effect evidence', async () => {
  const [telemetry, monitor] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestTelemetry.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8'),
  ]);
  assert.match(telemetry, /settleEffect\(\{/);
  assert.match(telemetry, /uncertain \? 'uncertain' : 'failed'/);
  assert.match(telemetry, /diagnostic\(`request\.effect\.\$\{status\}`/);
  assert.doesNotMatch(`${telemetry}\n${monitor}`, /send\(\{\s*type: ['"]request\.effect\.|request\.effect\.failed/);
  assert.doesNotMatch(`${telemetry}\n${monitor}`, /terminalFailurePayload|terminalSnapshotPayload/);
});

test('TabObservation reports immutable browser facts without a canonical terminal outcome', async () => {
  const core = await loadObservationCore();
  const observation = core.normalizeTabObservation({
    url: 'https://chatgpt.com/c/session-1',
    session: { id: 'session-1' },
    presence: { documentReadyState: 'complete', chatMainReady: true, composerReady: true },
    activeRequest: { requestId: 'req-1', responseEpoch: 2 },
    snapshot: {
      phase: 'ASSISTANT_FINAL',
      answer: 'final answer',
      thinking: 'reasoning',
      hasFinalMessage: true,
      artifacts: [{ id: 'artifact-1', name: 'result.zip', phase: 'READY' }],
      turnKey: 'assistant-1',
    },
  });

  assert.equal(observation.activeRequest.requestId, 'req-1');
  assert.equal(observation.output.answer, 'final answer');
  assert.equal(observation.output.state, 'final');
  assert.equal(observation.generation.state, 'stopped');
  assert.equal(Object.hasOwn(observation, 'terminal'), false);
  assert.equal(Object.hasOwn(observation.output, 'terminalOutcome'), false);
});
