// Always-on observation scheduler for one ChatGPT content-script instance.
// DOM parsing and transport are injected so this module owns only observation timing.
(() => {
  'use strict';

  function createTabObserver(options = {}) {
    const read = options.read;
    const emit = options.emit;
    const resolveRoot = options.resolveRoot;
    const diagnostic = typeof options.diagnostic === 'function' ? options.diagnostic : () => {};
    const Observer = options.MutationObserver || globalThis.MutationObserver;
    const pollMs = Math.max(250, Number(options.pollMs) || 2_000);
    const settleMs = Math.max(0, Number(options.settleMs) || 80);
    const degradedSettleMs = Math.max(settleMs, Number(options.degradedSettleMs) || 500);
    const attributes = options.attributeFilter || [
      'data-testid', 'data-turn', 'data-turn-id', 'data-turn-id-container',
      'data-message-id', 'data-message-author-role', 'data-message-model-slug',
      'data-state', 'aria-expanded', 'aria-checked', 'aria-busy', 'aria-label',
      'aria-disabled', 'disabled', 'href', 'download', 'src',
    ];

    if (typeof read !== 'function') throw new TypeError('Tab observer requires read()');
    if (typeof emit !== 'function') throw new TypeError('Tab observer requires emit()');
    if (typeof resolveRoot !== 'function') throw new TypeError('Tab observer requires resolveRoot()');

    const observerId = String(options.observerId || `tab-observer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    let observer = null;
    let root = null;
    let pollTimer = null;
    let collectTimer = null;
    let collecting = false;
    let collectAgain = false;
    let started = false;
    let revision = 0;
    let current = null;
    let currentSignature = '';
    let stableSince = 0;
    let stabilityBucket = 0;
    let pendingDegraded = null;

    function attach() {
      const nextRoot = resolveRoot();
      if (!nextRoot) return false;
      if (nextRoot === root && observer) return true;
      try { observer?.disconnect(); } catch {}
      root = nextRoot;
      if (typeof Observer === 'function') {
        observer = new Observer(() => schedule('mutation', settleMs));
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: attributes,
        });
      }
      diagnostic('tab_observer.root_attached', {
        tagName: root?.tagName || '',
        testId: root?.getAttribute?.('data-testid') || '',
      });
      return true;
    }

    function schedule(reason = 'scheduled', delayMs = settleMs) {
      if (!started) return;
      if (collectTimer) clearTimeout(collectTimer);
      collectTimer = setTimeout(() => {
        collectTimer = null;
        void collect(reason);
      }, Math.max(0, Number(delayMs) || 0));
    }

    async function collect(reason = 'poll', force = false) {
      if (!started) return null;
      if (collecting) {
        collectAgain = true;
        return current;
      }
      collecting = true;
      try {
        attach();
        const observedAt = Date.now();
        const candidate = await read(reason);
        if (!candidate || typeof candidate !== 'object') return current;
        const signature = String(options.signature?.(candidate) || JSON.stringify(candidate));
        if (!force && signature === currentSignature) {
          pendingDegraded = null;
          const stableForMs = stableSince ? Math.max(0, observedAt - stableSince) : 0;
          const nextBucket = stableForMs >= 2_000 ? 2 : stableForMs >= 750 ? 1 : 0;
          if (!current || nextBucket <= stabilityBucket) return current;
          stabilityBucket = nextBucket;
          revision += 1;
          current = { ...candidate, observerId, revision, observedAt, reason: 'stability.milestone', semanticSignature: signature, stableSince, stableForMs };
          emit(current);
          return current;
        }

        if (!force && candidate.degraded && current && !current.degraded) {
          if (!pendingDegraded || pendingDegraded.signature !== signature) {
            pendingDegraded = { signature, since: observedAt };
            schedule('degraded.settle', degradedSettleMs);
            return current;
          }
          if (observedAt - pendingDegraded.since < degradedSettleMs) {
            schedule('degraded.settle', degradedSettleMs - (observedAt - pendingDegraded.since));
            return current;
          }
        } else {
          pendingDegraded = null;
        }

        revision += 1;
        if (signature !== currentSignature) { stableSince = observedAt; stabilityBucket = 0; }
        currentSignature = signature;
        current = {
          ...candidate,
          observerId,
          revision,
          observedAt,
          reason: String(reason || 'observation'),
          semanticSignature: signature,
          stableSince,
          stableForMs: Math.max(0, observedAt - stableSince),
        };
        emit(current);
        return current;
      } catch (error) {
        diagnostic('tab_observer.collect_failed', { message: error?.message || String(error), reason });
        return current;
      } finally {
        collecting = false;
        if (collectAgain) {
          collectAgain = false;
          schedule('collect.queued', 0);
        }
      }
    }

    function start() {
      if (started) return api;
      started = true;
      attach();
      pollTimer = setInterval(() => {
        attach();
        schedule('poll', 0);
      }, pollMs);
      schedule('start', 0);
      diagnostic('tab_observer.started', { pollMs, settleMs, degradedSettleMs });
      return api;
    }

    function stop() {
      started = false;
      try { observer?.disconnect(); } catch {}
      observer = null;
      root = null;
      if (pollTimer) clearInterval(pollTimer);
      if (collectTimer) clearTimeout(collectTimer);
      pollTimer = null;
      collectTimer = null;
      pendingDegraded = null;
      stableSince = 0;
      stabilityBucket = 0;
    }

    const api = Object.freeze({
      start,
      stop,
      schedule,
      force: (reason = 'forced') => collect(reason, true),
      current: () => current,
      revision: () => revision,
      observerId: () => observerId,
      attached: () => Boolean(root),
    });
    return api;
  }

  Object.assign(globalThis, {
    ChatGptTabObserver: Object.freeze({ createTabObserver }),
  });
})();
