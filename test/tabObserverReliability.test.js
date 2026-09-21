import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function harness(options = {}) {
  let now = 0;
  let wallOffset = 0;
  let nextId = 0;
  let reads = 0;
  let candidate = { answer: 'ready', focused: true };
  let read = () => candidate;
  const timers = new Map();
  const emitted = [];
  let attributes;
  class Observer {
    observe(_root, config) { attributes = config.attributeFilter; }
    disconnect() {}
  }
  const context = vm.createContext({
    Date: { now: () => now + wallOffset },
    performance: { now: () => now },
    MutationObserver: Observer,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval: () => ++nextId,
    clearInterval() {},
  });
  vm.runInContext(await fs.readFile(new URL('../tools/chrome-bridge-extension/observation/tabObserver.js', import.meta.url), 'utf8'), context);
  const root = {};
  const observer = context.ChatGptTabObserver.createTabObserver({
    resolveRoot: () => root,
    read: () => { reads += 1; return read(); },
    emit: (value) => emitted.push(value),
    signature: JSON.stringify,
    stabilitySignature: (value) => JSON.stringify([value.answer, Boolean(value.degraded)]),
    stabilityMilestones: [750, 2_000],
    ...options,
  });
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (let limit = 0; limit < 1000; limit += 1) {
      const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = end; await flush(); return; }
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    throw new Error('Timer loop did not settle');
  }
  observer.start();
  return {
    observer, emitted, advance, flush,
    reads: () => reads,
    attributes: () => attributes,
    set: (value) => { candidate = value; },
    read: (fn) => { read = fn; },
    wallJump: (ms) => { wallOffset += ms; },
  };
}

test('continuous mutations cannot postpone the first pending observation or an urgent read', async () => {
  const h = await harness();
  await h.advance(0);
  h.set({ answer: 'streaming' });
  h.observer.schedule('mutation', 60);
  await h.advance(30);
  h.observer.schedule('mutation', 60);
  await h.advance(30);
  assert.equal(h.emitted.at(-1).answer, 'streaming');
  assert.equal(h.reads(), 2);
  h.observer.schedule('urgent', 0);
  h.observer.schedule('peripheral', 180);
  await h.advance(0);
  assert.equal(h.reads(), 3);
  h.observer.stop();
});

test('focus changes publish fresh facts without restarting response stability', async () => {
  const h = await harness();
  await h.advance(0);
  await h.advance(500);
  h.set({ answer: 'ready', focused: false });
  h.observer.schedule('focus', 0);
  await h.advance(0);
  assert.equal(h.emitted.at(-1).focused, false);
  assert.equal(h.emitted.at(-1).stableForMs, 500);
  await h.advance(1500);
  assert.equal(h.emitted.at(-1).stableForMs, 2000);
  assert.equal(h.emitted.at(-1).reason, 'stability.milestone');
  h.observer.stop();
});

test('a changed response resets stability and wall-clock jumps do not advance it', async () => {
  const h = await harness();
  await h.advance(0);
  await h.advance(1000);
  h.wallJump(3_600_000);
  h.set({ answer: 'rewritten' });
  await h.observer.force();
  assert.equal(h.emitted.at(-1).stableForMs, 0);
  await h.advance(750);
  assert.equal(h.emitted.at(-1).stableForMs, 750);
  h.observer.stop();
});

for (const interruptedBy of ['missing snapshot', 'parser error', 'degraded DOM']) {
  test(`stability cannot span ${interruptedBy}`, async () => {
    const h = await harness();
    await h.advance(0);
    await h.advance(1000);
    h.read(() => {
      if (interruptedBy === 'parser error') throw new Error('DOM replaced');
      return interruptedBy === 'missing snapshot' ? null : { answer: '', degraded: true };
    });
    h.observer.schedule('changed', 0);
    await h.advance(0);
    await h.advance(200);
    h.read(() => ({ answer: 'ready', focused: true }));
    await h.observer.force('recovered');
    assert.equal(h.emitted.at(-1).stableForMs, 0);
    await h.advance(750);
    assert.equal(h.emitted.at(-1).stableForMs, 750);
    h.observer.stop();
  });
}

test('a stopped read cannot publish into a restarted observer or release its read lock', async () => {
  const h = await harness();
  let finishOld;
  h.read(() => new Promise((resolve) => { finishOld = resolve; }));
  await h.advance(0);
  h.observer.stop();
  assert.equal(h.observer.current(), null);
  let finishNew;
  h.read(() => new Promise((resolve) => { finishNew = resolve; }));
  h.observer.start();
  await h.advance(0);
  finishOld({ answer: 'stale' });
  await h.flush();
  await h.observer.force();
  assert.equal(h.reads(), 2, 'the new read remains serialized');
  assert.equal(h.emitted.length, 0);
  h.read(() => ({ answer: 'new' }));
  finishNew({ answer: 'new' });
  await h.flush();
  await h.advance(0);
  assert.ok(h.emitted.every((item) => item.answer === 'new'));
  h.observer.stop();
});

test('force requested during a read is preserved for the queued read', async () => {
  const h = await harness();
  await h.advance(0);
  let finish;
  h.read(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.observer.force();
  await h.observer.force();
  h.read(() => ({ answer: 'ready', focused: true }));
  finish({ answer: 'ready', focused: true });
  await pending;
  await h.advance(0);
  assert.equal(h.emitted.length, 3);
  h.observer.stop();
});

test('generation and visibility class changes are observed without waiting for polling', async () => {
  const h = await harness();
  for (const attribute of ['class', 'style', 'hidden', 'aria-hidden']) assert.ok(h.attributes().includes(attribute));
  h.observer.stop();
});

test('a read invalidated by a new DOM change cannot publish its obsolete snapshot', async () => {
  const h = await harness();
  await h.advance(0);
  let finish;
  h.read(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.observer.force();
  h.observer.schedule('mutation', 60);
  h.read(() => ({ answer: 'newer' }));
  finish({ answer: 'obsolete' });
  await pending;
  await h.advance(0);
  assert.equal(h.emitted.at(-1).answer, 'newer');
  assert.ok(h.emitted.every((item) => item.answer !== 'obsolete'));
  h.observer.stop();
});

test('continuously changing degraded DOM still publishes its missing-root evidence', async () => {
  const h = await harness();
  await h.advance(0);
  for (let index = 0; index < 7; index += 1) {
    h.set({ answer: `changing-${index}`, degraded: true });
    h.observer.schedule('mutation', 0);
    await h.advance(100);
  }
  assert.equal(h.emitted.at(-1).degraded, true);
  h.observer.stop();
});
