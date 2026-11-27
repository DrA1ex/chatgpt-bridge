import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactRegistry, publishArtifactSettlement } from '../src/bridge/artifacts/artifactRegistry.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const image = () => ({ id: 'image-1', kind: 'image', phase: 'READY', mime: 'image/png' });
const stored = (name) => ({ id: 'image-1', kind: 'artifact', size: 10, mime: 'image/png', name });

for (const action of ['delete', 'clear']) {
  test(`${action} invalidates an in-flight capture instead of publishing stale readiness`, async () => {
    const completions = [];
    const events = [];
    const registry = new ArtifactRegistry({
      capture: () => new Promise((resolve) => completions.push(resolve)),
      onSettled: (artifact) => events.push(artifact.name),
    });
    registry.set('image-1', image());
    await flush();
    if (action === 'delete') registry.delete('image-1');
    else registry.clear();
    registry.set('image-1', image());
    await flush();
    assert.equal(completions.length, 2);
    completions[0](stored('old.png'));
    await flush();
    assert.equal(registry.get('image-1').phase, 'MATERIALIZING');
    assert.deepEqual(events, []);
    completions[1](stored('new.png'));
    await registry.settled([image()]);
    assert.equal(registry.get('image-1').name, 'new.png');
    assert.deepEqual(events, ['new.png']);
  });
}

test('a finished request cannot receive a late image projection', () => {
  const state = { runtime: { finished: true }, artifacts: [image()], callbacks: { onArtifactUpdate() { throw new Error('late callback'); } } };
  const artifact = { ...image(), requestId: 'req-1', phase: 'FAILED' };
  publishArtifactSettlement(artifact, { pending: new Map([['req-1', state]]), lifecycle: {} });
  assert.equal(state.artifacts[0].phase, 'READY');
});
