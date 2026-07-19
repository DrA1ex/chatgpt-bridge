// Always-on observation scheduler for one ChatGPT content-script instance.
// DOM parsing and transport are injected so this module owns only observation timing.
(() => {
  'use strict';

  function createTabObserver(options = {}) {
    const read = options.read;
    const emit = options.emit;
    const resolveRoot = options.resolveRoot;
    const diagnostic = typeof options.diagnostic === 'function' ? options.diagnostic : () => {};
    const classifyMutations = typeof options.classifyMutations === 'function' ? options.classifyMutations : null;
    const Observer = options.MutationObserver || globalThis.MutationObserver;
    const pollMs = Math.max(1_000, Number(options.pollMs) || 5_000);
    const settleMs = Math.max(0, Number(options.settleMs) || 120);
    const degradedSettleMs = Math.max(settleMs, Number(options.degradedSettleMs) || 600);
    const stabilityMilestones = Array.from(new Set((options.stabilityMilestones || [750, 2_000])
      .map((value) => Math.max(1, Number(value) || 0))
      .filter(Boolean))).sort((left, right) => left - right);
    const slowCollectMs = Math.max(10, Number(options.slowCollectMs) || 50);
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
    const stabilityTimers = new Map();
    let collecting = false;
    let collectAgain = false;
    let started = false;
    let revision = 0;
    let current = null;
    let currentSignature = '';
    let stableSince = 0;
    let stabilityBucket = 0;
    let pendingDegraded = null;
    let lastSlowDiagnosticAt = 0;
    const performanceStats = {
      collectCount: 0,
      emittedCount: 0,
      ignoredMutationBatches: 0,
      scheduledMutationBatches: 0,
      totalCollectMs: 0,
      maxCollectMs: 0,
      lastCollectMs: 0,
    };

    function clock() {
      return globalThis.performance?.now?.() ?? Date.now();
    }

    function clearStabilityTimers() {
      for (const timer of stabilityTimers.values()) clearTimeout(timer);
      stabilityTimers.clear();
    }

    function scheduleStabilityMilestones() {
      clearStabilityTimers();
      for (const milestoneMs of stabilityMilestones) {
        const timer = setTimeout(() => {
          stabilityTimers.delete(milestoneMs);
          void collect(`stability.${milestoneMs}`, false);
        }, milestoneMs);
        stabilityTimers.set(milestoneMs, timer);
      }
    }

    function handleMutations(records = []) {
      let decision = null;
      try {
        decision = classifyMutations?.(records, { root, current, active: started }) || null;
      } catch (error) {
        diagnostic('tab_observer.mutation_classifier_failed', { message: error?.message || String(error) });
      }
      if (decision?.ignore) {
        performanceStats.ignoredMutationBatches += 1;
        return;
      }
      performanceStats.scheduledMutationBatches += 1;
      schedule(String(decision?.reason || 'mutation'), decision?.delayMs ?? settleMs);
    }

    function attach() {
      const nextRoot = resolveRoot();
      if (!nextRoot) return false;
      if (nextRoot === root && observer) return true;
      try { observer?.disconnect(); } catch {}
      root = nextRoot;
      if (typeof Observer === 'function') {
        observer = new Observer(handleMutations);
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

    function recordCollectPerformance(startedAt, reason) {
      const durationMs = Math.max(0, clock() - startedAt);
      performanceStats.collectCount += 1;
      performanceStats.lastCollectMs = durationMs;
      performanceStats.totalCollectMs += durationMs;
      performanceStats.maxCollectMs = Math.max(performanceStats.maxCollectMs, durationMs);
      const now = Date.now();
      if (durationMs >= slowCollectMs && now - lastSlowDiagnosticAt >= 15_000) {
        lastSlowDiagnosticAt = now;
        diagnostic('tab_observer.slow_collect', {
          reason,
          durationMs: Math.round(durationMs * 100) / 100,
          collectCount: performanceStats.collectCount,
          ignoredMutationBatches: performanceStats.ignoredMutationBatches,
        });
      }
    }

    function emitObservation(observation) {
      performanceStats.emittedCount += 1;
      emit(observation);
    }

    async function collect(reason = 'poll', force = false) {
      if (!started) return null;
      if (collecting) {
        collectAgain = true;
        return current;
      }
      collecting = true;
      const collectStartedAt = clock();
      try {
        attach();
        const observedAt = Date.now();
        const candidate = await read(reason);
        if (!candidate || typeof candidate !== 'object') return current;
        const signature = String(options.signature?.(candidate) || JSON.stringify(candidate));
        if (!force && signature === currentSignature) {
          pendingDegraded = null;
          const stableForMs = stableSince ? Math.max(0, observedAt - stableSince) : 0;
          let nextBucket = 0;
          for (let index = 0; index < stabilityMilestones.length; index += 1) {
            if (stableForMs >= stabilityMilestones[index]) nextBucket = index + 1;
          }
          if (!current || nextBucket <= stabilityBucket) return current;
          stabilityBucket = nextBucket;
          revision += 1;
          current = { ...candidate, observerId, revision, observedAt, reason: 'stability.milestone', semanticSignature: signature, stableSince, stableForMs };
          emitObservation(current);
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
        if (signature !== currentSignature) {
          stableSince = observedAt;
          stabilityBucket = 0;
          scheduleStabilityMilestones();
        }
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
        emitObservation(current);
        return current;
      } catch (error) {
        diagnostic('tab_observer.collect_failed', { message: error?.message || String(error), reason });
        return current;
      } finally {
        recordCollectPerformance(collectStartedAt, reason);
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
      diagnostic('tab_observer.started', { pollMs, settleMs, degradedSettleMs, stabilityMilestones });
      return api;
    }

    function stop() {
      started = false;
      try { observer?.disconnect(); } catch {}
      observer = null;
      root = null;
      if (pollTimer) clearInterval(pollTimer);
      if (collectTimer) clearTimeout(collectTimer);
      clearStabilityTimers();
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
      metrics: () => Object.freeze({
        ...performanceStats,
        averageCollectMs: performanceStats.collectCount
          ? performanceStats.totalCollectMs / performanceStats.collectCount
          : 0,
      }),
    });
    return api;
  }

  Object.assign(globalThis, {
    ChatGptTabObserver: Object.freeze({ createTabObserver }),
  });
})();
